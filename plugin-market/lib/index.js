/**
 * dsh-plugin-market — 插件市场（基础版）宿主端。
 *
 * 提供环回 HTTP 路由（前缀 /plugin-market）：
 *   GET  /plugin-market/state        插件清单 + 补丁层状态 + GitHub 源列表
 *   POST /plugin-market/sources      保存 GitHub 源列表（可编辑、可持久化）
 *   POST /plugin-market/toggle       启用/停用插件（写 cordis.patch.yml，HMR 生效）
 *   POST /plugin-market/check-update 检查更新（git 通道：对比远端 HEAD 与本地 lockfile commit；开启审查时附本次改动差异审查）
 *   POST /plugin-market/update       更新插件（git 通道，以安装来源仓库为准，跟随仓库默认分支最新提交）
 *   POST /plugin-market/uninstall    卸载插件（移除 insert 行 + pnpm remove）
 *
 * 机制：与 dsh plugin CLI 一致——用户补丁层 cordis.patch.yml 是逐键覆盖，
 * 追加 - id + disabled:true 停用任意行、移除即恢复；insert 行启用新插件；
 * pnpm 在 profile 目录增删依赖；bundle 包追加到 package.json 的 dsh.profile.bundles。
 */
import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)

export const name = 'dsh-plugin-market'
export const inject = ['webServer', 'loader', 'agents']

const ROUTE_PREFIX = '/plugin-market'
const SOURCES_FILE = join(homedir(), '.dsh', 'plugin-market-sources.json')
/** 插件来源仓库记录：{ packageName: repoString }，安装时自动写入用户填写的仓库（拉取来源），供展示与 git 通道检查/更新。 */
const REPOS_FILE = join(homedir(), '.dsh', 'plugin-market-repos.json')
/** 隔离审查目录：先拉取到此处审查，通过后再迁移到 profile。 */
const STAGING_DIR = join(homedir(), '.dsh', 'plugin-market-staging')
/** 审查报告缓存目录（按 包名+版本 缓存，避免重复分析；7 天清理）。 */
const REVIEWS_DIR = join(homedir(), '.dsh', 'plugin-market-reviews')
/** 审查缓存有效期（天）。 */
const REVIEW_TTL_DAYS = 7

/** dsh 本体的 GitHub 仓库（侧边栏版本状态灯的检测对象，非插件市场自身）。 */
const DSH_REPO = { owner: 'deepseek-ai', name: 'deepseek-harness' }
/** dsh 自更新检测/判定结果持久化文件。 */
const DSH_STATE_FILE = join(homedir(), '.dsh', 'plugin-market-dsh.json')
/** dsh 版本检测间隔：启动时一次 + 每 1 小时同步。 */
const DSH_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** 宿主基础设施行：停用会连带破坏 HMR/传输/存储/设置链，禁止开关。 */
const PROTECTED_MODULE_PATTERNS = [
  /^cordis:/u,
  /^@deepseek-ai\/cordis-plugin-/u,
  /^@deepseek-ai\/dsh-host-/u,
  /^@deepseek-ai\/dsh-client-modules$/u,
  /^@deepseek-ai\/dsh-client-connection$/u,
  /^@deepseek-ai\/dsh-client-hmr$/u,
  /^@deepseek-ai\/dsh-client-runtime$/u,
  /^@deepseek-ai\/dsh-client-locale$/u,
  /^@deepseek-ai\/dsh-client-web/u,
  /^@deepseek-ai\/dsh-web-frontend$/u,
  /^@deepseek-ai\/dsh-web-app$/u,
  /^@deepseek-ai\/dsh-settings/u,
  /^@deepseek-ai\/dsh-session/u,
  /^@deepseek-ai\/dsh-storage/u,
  /^@deepseek-ai\/dsh-typert/u,
  /^@deepseek-ai\/dsh-api-remotes$/u,
  /^@deepseek-ai\/dsh-tools$/u,
  /^@deepseek-ai\/dsh-system-prompt$/u,
  /^@deepseek-ai\/dsh-agent/u,
  /^@deepseek-ai\/dsh-llm/u,
  /^@deepseek-ai\/dsh-persona$/u,
  /^@deepseek-ai\/dsh-scope$/u,
  /^@deepseek-ai\/dsh-shell$/u,
  /^@deepseek-ai\/dsh-subprocess/u,
  /^@deepseek-ai\/dsh-fs/u,
  /^@deepseek-ai\/dsh-sandbox/u,
  /^@deepseek-ai\/dsh-jobs/u,
  /^@deepseek-ai\/dsh-skill/u,
  /^@deepseek-ai\/dsh-goal/u,
  /^@deepseek-ai\/dsh-workflow/u,
  /^@deepseek-ai\/dsh-subagent/u,
  /^@deepseek-ai\/dsh-web$/u,
  /^@deepseek-ai\/dsh-workspace/u,
  /^@deepseek-ai\/dsh-user-approval$/u,
  /^@deepseek-ai\/dsh-user-questions$/u,
  /^@deepseek-ai\/dsh-commands$/u,
  /^@deepseek-ai\/dsh-hook/u,
  /^@deepseek-ai\/dsh-spill/u,
  /^@deepseek-ai\/dsh-guard/u,
]

function isProtectedModule(moduleName) {
  return typeof moduleName === 'string' && PROTECTED_MODULE_PATTERNS.some((pattern) => pattern.test(moduleName))
}

/** 官方 profile 模板自带的 bundle（跟随 dsh 更新，不属于用户安装的插件）。 */
const DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * 判断是否为用户安装的插件（需要展示在插件市场里）：
 *  - 用户 patch 层 insert 的额外条目（extra）
 *  - 非默认的 bundle 包（用户通过 dsh plugin add 安装的 bundle，如 dsh-plugin-market）
 *  dsh 自带的官方 bundle 与基础设施（@deepseek-ai/dsh-*）不算。
 */
function isUserInstalled(moduleName, rowId, extra, bundles) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return false
  // 官方基础设施（@deepseek-ai/dsh-*、cordis-plugin-*）即使被 insert 配置了实例
  //（如 dsh-mcp-client 的 mcp-jira），也不算用户安装的第三方插件，不展示
  if (moduleName.startsWith('@deepseek-ai/dsh-') || moduleName.startsWith('@deepseek-ai/cordis-plugin-')) return false
  if (extra) return true
  return Array.isArray(bundles) && bundles.includes(moduleName) && !DEFAULT_BUNDLES.includes(moduleName)
}

/** 判断插件是否已安装（运行树同名条目 / 补丁层 insert 行 / 非默认 bundle 已写入 manifest）。
 * 用于拦截重复安装：同一包名只允许安装一次，升级走「检查更新」。 */
async function isPluginInstalled(ctx, patch, moduleName, profileDir) {
  if (listEntries(ctx).some((entry) => entry.moduleName === moduleName)) return true
  if (patch.inserts.includes(moduleName)) return true
  if (patch.inserts.includes(deriveEntryId(moduleName, new Set()))) return true
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (bundles.includes(moduleName) && !DEFAULT_BUNDLES.includes(moduleName)) return true
  } catch {}
  return false
}

/** 判断插件是否为本地安装（package.json 中 link:/file: 依赖，或 node_modules 中指向 profile 外的符号链接）。本地安装的插件不可通过插件市场卸载。 */
function isLocalDependency(profileDir, moduleName) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const spec = manifest.dependencies?.[moduleName] ?? manifest.devDependencies?.[moduleName] ?? null
    if (typeof spec === 'string' && /^(?:link|file):/u.test(spec)) return true
  } catch {}
  try {
    const fsMod = require('node:fs')
    const target = join(profileDir, 'node_modules', ...(moduleName.startsWith('@') ? moduleName.split('/') : [moduleName]))
    const st = fsMod.lstatSync(target)
    if (st.isSymbolicLink()) {
      const real = fsMod.realpathSync(target)
      if (!real.startsWith(profileDir)) return true
    }
  } catch {}
  return false
}

/** 本地安装（link:/file: 依赖或指向 profile 外的符号链接）的路径/spec 字符串；非本地安装返回 null。 */
function localDependencyPath(profileDir, moduleName) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const spec = manifest.dependencies?.[moduleName] ?? manifest.devDependencies?.[moduleName] ?? null
    if (typeof spec === 'string' && /^(?:link|file):/u.test(spec)) return spec
  } catch {}
  try {
    const fsMod = require('node:fs')
    const target = join(profileDir, 'node_modules', ...(moduleName.startsWith('@') ? moduleName.split('/') : [moduleName]))
    const st = fsMod.lstatSync(target)
    if (st.isSymbolicLink()) {
      const real = fsMod.realpathSync(target)
      if (!real.startsWith(profileDir)) return real
    }
  } catch {}
  return null
}

/** Cordis Fiber 状态映射（与 dsh-host-plugin-inventory 一致）。 */
const FIBER_STATE = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 }
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
}

// ── 通用小工具 ──────────────────────────────────────────────────────────────

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

async function collectBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$(){}|[\]\\]/gu, '\\$&')
}

function githubRepoInfo(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') throw new Error('仓库地址不能为空')
  // 提取 #path: 子目录（monorepo 整合仓库），如 github.com/owner/repo.git#path:subdir
  let path = null
  let base = value
  const hashIdx = value.indexOf('#')
  if (hashIdx !== -1) {
    const after = value.slice(hashIdx + 1)
    const pm = after.match(/^path:([^\s#]+)$/u)
    if (pm) path = pm[1]
    else throw new Error('GitHub 地址的 # 后仅支持 path: 子目录语法（如 #path:chat-rollback）')
    base = value.slice(0, hashIdx)
  }
  const urlMatch = base.match(/github\.com\/([^/?#]+)\/([^/?#]+)/u)
  if (urlMatch) {
    return { owner: urlMatch[1], name: urlMatch[2].replace(/\.git$/u, ''), path }
  }
  const pair = base.split('/')
  if (pair.length === 2 && pair.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))) {
    return { owner: pair[0], name: pair[1], path }
  }
  throw new Error('GitHub 地址格式无效（应为 owner/name 或完整 URL，可带 #path:子目录）')
}

/** 生成 pnpm git 安装 spec；带子目录时追加 #path: */
function gitSpec(repoInfo) {
  const base = 'github:' + repoInfo.owner + '/' + repoInfo.name
  if (repoInfo.path !== null && repoInfo.path !== undefined && repoInfo.path !== '') {
    return base + '#path:' + repoInfo.path
  }
  return base
}

// ── pnpm 发现与调用 ────────────────────────────────────────────────────────

/** 找到可用的 pnpm 启动方式：corepack → PATH pnpm → npx 缓存 pnpm。 */
function resolvePnpm() {
  const candidates = []
  candidates.push({ bin: 'corepack', args: ['pnpm'] })
  candidates.push({ bin: 'pnpm', args: [] })
  try {
    const npxRoot = join(homedir(), '.npm', '_npx')
    if (existsSync(npxRoot)) {
      const entries = require('node:fs').readdirSync(npxRoot)
      for (const entry of entries.slice().reverse()) {
        const bin = join(npxRoot, entry, 'node_modules', '.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
        if (existsSync(bin)) {
          candidates.push({ bin, args: [] })
          break
        }
      }
    }
  } catch {}
  return candidates
}

/** pnpm 调用队列：串行化所有 pnpm 操作（同一 profile / store 并发会锁冲突）。 */
let pnpmQueue = Promise.resolve()
function queuedPnpm(task) {
  const run = pnpmQueue.then(task, task)
  pnpmQueue = run.then(() => {}, () => {})
  return run
}

/** 瞬时失败判定：网络/超时/完整性/锁类错误值得重试；ENOENT（无 pnpm）与中断不重试。 */
function isTransientPnpmError(error) {
  if (error?.code === 'ENOENT') return false
  if (error?.killed || error?.signal) return false
  const text = String(error?.message ?? '') + ' ' + String(error?.stderr ?? '')
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|ETARGET|integrity|timeout|timed out|ENOTEMPTY|EBUSY|ELOCKED|ENOENT/i.test(text)
}

/** 解析 pnpm 的 Progress 行（stdout 实时输出，非 TTY 也会打印）：
 * "Progress: resolved 340, reused 319, downloaded 21, added 340, done"。
 * 返回 null 表示不是进度行。 */
function parsePnpmProgress(line) {
  const text = String(line).trim()
  const match = /^Progress:\s*resolved\s+(\d+)(?:,\s*reused\s+(\d+))?(?:,\s*downloaded\s+(\d+))?(?:,\s*added\s+(\d+))?/.exec(text)
  if (match === null) return null
  return {
    resolved: Number(match[1]),
    reused: match[2] !== undefined ? Number(match[2]) : 0,
    downloaded: match[3] !== undefined ? Number(match[3]) : 0,
    added: match[4] !== undefined ? Number(match[4]) : 0,
    done: /,\s*done\s*$/.test(text),
  }
}

/** 由 pnpm 进度行生成任务进度快照（percent 为 added/resolved；done 时固定 100，
 * 避免全缓存安装 added 保持 0 却已完成时进度条停在 0%）。 */
function progressFromPnpm(progress) {
  const total = progress.resolved
  let percent = null
  if (progress.done) percent = 100
  else if (total > 0) percent = Math.max(0, Math.min(100, Math.round((progress.added / total) * 100)))
  return { percent, resolved: progress.resolved, downloaded: progress.downloaded, added: progress.added, done: progress.done }
}

/** 带进度回调的 pnpm 执行：流式读取 stdout 逐行解析 Progress，错误对象
 * 与 execFileAsync 兼容（message 含命令、stdout/stderr/code/killed 属性齐全）。 */
function execPnpmStream(bin, argv, opts, onProgress) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let buffer = ''
    let timedOut = false
    let settled = false
    const timer = opts.timeout > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, opts.timeout) : null
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    })
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      if (typeof onProgress !== 'function') return
      buffer += text
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const parsed = parsePnpmProgress(line)
        if (parsed !== null) onProgress(parsed)
      }
    })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (code !== 0) {
        const error = new Error('Command failed: ' + [bin, ...argv].join(' '))
        error.code = code
        error.stdout = stdout
        error.stderr = stderr
        error.killed = timedOut
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

/**
 * 运行 pnpm（串行化 + 瞬时失败重试 + 结果带 stderr）：
 *  - 追加 pnpm 自身 fetch 重试与 prefer-offline 参数，命中 store 缓存时快且稳；
 *  - 瞬时错误（网络/超时/锁）自动重试一次（间隔 1.5s）；
 *  - 最终错误带上 pnpm 的 stderr 尾部，便于定位真实原因。
 */
/** 修复 pnpm 布局/锁文件配置不匹配：执行 pnpm install --no-frozen-lockfile（CI=true 跳过 TTY 确认）重建 modules 目录。 */
async function repairPnpmLayout(profileDir) {
  const attempts = resolvePnpm()
  await queuedPnpm(async () => {
    // 两轮：首轮失败若为构建脚本授权错误（prepare 被禁 / 传递依赖构建被忽略），
    // 写 allowBuilds 后重试一轮（install 同样可能触发这两类错误）
    for (let round = 0; round < 2; round += 1) {
      for (const { bin, args: prefix } of attempts) {
        try {
          await execFileAsync(bin, [...prefix, 'install', '--no-frozen-lockfile'], {
            cwd: profileDir,
            timeout: 300000,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: '0',
              GCM_INTERACTIVE: 'never',
              CI: 'true',
            },
          })
          return
        } catch (error) {
          if (error.code === 'ENOENT') continue
          if (round === 0) {
            try {
              if (await applyBuildPolicyRecovery(profileDir, error)) break
            } catch {}
          }
          throw error
        }
      }
    }
    throw new Error('未找到可用的 pnpm 以修复安装布局')
  })
}

async function runPnpm(profileDir, args, timeout = 180000, signal, repairTried = false, policyRounds = 0, onProgress = null) {
  const attempts = resolvePnpm()
  const buildError = (error) => {
    // pnpm v11 的部分错误（如 ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF）写 stdout 而非 stderr，
    // 两者都带上，避免再次出现"只有 Command failed、看不到原因"的静默失败。
    const stderr = String(error?.stderr ?? '').trim()
    const stdout = String(error?.stdout ?? '').trim()
    const detail = stderr || stdout
    const text = String(error?.message ?? '') + ' ' + detail
    let guide = ''
    if (/ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/.test(text)) {
      guide = '（已尝试自动重建 modules 目录；若仍失败，请在 profile 目录手动执行 pnpm install --no-frozen-lockfile 后重启 dsh web 重试）'
    } else if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|EAI_AGAIN|ENOTFOUND/.test(text)) {
      guide = '（网络/超时问题：请检查网络后重试，或稍后再试）'
    } else if (/ENOENT|not found|未找到|command not found/.test(text)) {
      guide = '（缺少 pnpm/git 等工具：请安装 pnpm（npm i -g pnpm）与 git 后重试）'
    } else if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS/.test(text)) {
      guide = '（pnpm 构建脚本授权：已自动把 allowBuilds 写入 pnpm-workspace.yaml 并重试；若仍失败，请检查网络/磁盘后重试）'
    }
    return new Error((error?.message ?? '安装失败') + (detail ? '：' + detail.slice(-800) : '') + guide)
  }
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await queuedPnpm(async () => {
        for (const { bin, args: prefix } of attempts) {
          try {
            // fetch 参数仅 add/install/update 支持；remove 等命令遇到未知参数会直接失败
            const fetchFlags = args[0] === 'add' || args[0] === 'install' || args[0] === 'update'
              ? ['--fetch-retries=5', '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=60000', '--prefer-offline']
              : []
            const argv = [...prefix, ...args, ...fetchFlags]
            const pnpmEnv = {
              ...process.env,
              GIT_TERMINAL_PROMPT: '0',
              GCM_INTERACTIVE: 'never',
            }
            if (typeof onProgress === 'function') {
              // 流式执行：实时解析 pnpm 的 Progress 行回传进度
              await execPnpmStream(bin, argv, { cwd: profileDir, timeout, signal, env: pnpmEnv }, onProgress)
            } else {
              await execFileAsync(bin, argv, {
                cwd: profileDir,
                timeout,
                signal,
                windowsHide: true,
                maxBuffer: 4 * 1024 * 1024,
                env: pnpmEnv,
              })
            }
            return
          } catch (error) {
            lastError = error
            if (error.code === 'ENOENT') continue
            if (signal?.aborted) throw error
            throw error
          }
        }
        throw new Error('安装需要 pnpm 但本机未找到（corepack / PATH / npx 缓存均无 pnpm）。请安装 pnpm 后重试：npm install -g pnpm（本机 Node 26 未内置 corepack，装完可用 pnpm --version 验证）。原始错误：' + (lastError?.message ?? '未知错误'))
      })
    } catch (error) {
      if (signal?.aborted) throw buildError(error)
      // pnpm v11+ 布局/锁文件严格检查错误：确定性错误不重试，走自动修复
      const errText = String(error?.message ?? '') + ' ' + String(error?.stdout ?? '') + ' ' + String(error?.stderr ?? '')
      if (/ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/.test(errText)) {
        lastError = error
        break
      }
      // pnpm 构建脚本授权错误（git 插件 prepare 被禁 / 传递依赖构建被忽略）：
      // 确定性错误，须先于瞬时判定处理——自动把 allowBuilds 写入 pnpm-workspace.yaml 后重试
      // （最多 3 轮，覆盖多层 git/原生依赖）。不能用 isTransientPnpmError 判定：
      //   其正则会把我们追加的命令参数（--fetch-retry-maxtimeout）误判为瞬时超时，
      //   且 pnpm v11 的 IGNORED_BUILDS 提示写在 stdout 而非 stderr。
      if (policyRounds < 3 && (args[0] === 'add' || args[0] === 'install' || args[0] === 'update')
          && /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS/.test(errText)) {
        try {
          if (await applyBuildPolicyRecovery(profileDir, error)) {
            return runPnpm(profileDir, args, timeout, signal, repairTried, policyRounds + 1, onProgress)
          }
        } catch {}
      }
      if (!isTransientPnpmError(error)) throw buildError(error)
      lastError = error
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  // 布局不匹配（常见于设备上 pnpm 版本或历史布局变更）：自动重建 modules 目录后重试一次
  if (lastError !== null && !repairTried) {
    const errText = String(lastError?.message ?? '') + ' ' + String(lastError?.stdout ?? '') + ' ' + String(lastError?.stderr ?? '')
    if (/ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/.test(errText)) {
      try {
        await repairPnpmLayout(profileDir)
        return runPnpm(profileDir, args, timeout, signal, true, policyRounds, onProgress)
      } catch {}
    }
  }
  throw buildError(lastError ?? new Error('安装失败'))
}

/** pnpm add：profile 是 workspace 根，必须加 -w 才能在根 package.json 安装。 */
async function pnpmInstall(profileDir, spec, onProgress = null) {
  await runPnpm(profileDir, ['add', '-w', spec], 180000, undefined, false, 0, onProgress)
}

async function pnpmRemove(profileDir, packageName) {
  await runPnpm(profileDir, ['remove', packageName])
}

// ── pnpm 构建脚本授权（allowBuilds） ─────────────────────────────────────────

/**
 * pnpm v10.26+/v11 安全策略（GHSA-5wx6-mg75-v57r 修复）：git 托管依赖的
 * prepare 构建脚本必须显式列入 pnpm-workspace.yaml 的 allowBuilds 才允许执行，
 * 否则报 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED；被忽略的传递依赖构建脚本
 * （如原生模块 node-pty）则报 ERR_PNPM_IGNORED_BUILDS 并以退出码 1 结束。
 * 插件市场是显式安装器，安装即代表允许该插件的构建脚本，这里自动补齐授权。
 * allowBuilds 键支持三种形式：精确 depPath（name@tarballUrl，含 commit）、
 * git 仓库级键（name@git+https://github.com/owner/repo.git，跨 commit 稳定）、
 * 纯包名（仅 registry 依赖）。git 插件优先写仓库级键，插件更新（commit 变化）后无需再次授权。
 */

/** 从 PREPARE_NOT_ALLOWED 错误文本提取 git 依赖的 allowBuilds 键（仓库级优先）。 */
function deriveGitAllowBuildKey(errorText) {
  const urlMatch = /fetched from "([^"]+)"/u.exec(errorText)
  const nameMatch = /The git-hosted package "(.+?)@[^"]+"/u.exec(errorText)
  if (urlMatch === null || nameMatch === null) return null
  const tarballUrl = urlMatch[1]
  const pkgName = nameMatch[1]
  const repoMatch = /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\//u.exec(tarballUrl)
  if (repoMatch !== null) {
    return pkgName + '@git+https://github.com/' + repoMatch[1] + '/' + repoMatch[2] + '.git'
  }
  // 非 codeload 源：退化为精确 depPath（name@tarballUrl）
  return pkgName + '@' + tarballUrl
}

/** 从 IGNORED_BUILDS 提示提取被忽略构建脚本的包名列表（a@1.0.0 → a）。 */
function parseIgnoredBuildNames(errorText) {
  const match = /Ignored build scripts:\s*([^\n]+)/u.exec(errorText)
  if (match === null) return []
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/@[\d^~<>=v][^\s,]*$/u, ''))
    .filter((name) => name !== '')
}

/** 行级合并 allowBuilds 条目到 pnpm-workspace.yaml（保留其它键/注释，幂等）。 */
async function mergeAllowBuilds(projectDir, entries) {
  if (entries.size === 0) return false
  const file = join(projectDir, 'pnpm-workspace.yaml')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const lines = text.split(/\r?\n/u)
  const topKeyRe = /^([A-Za-z0-9_-]+):(?:\s*(?:#.*)?)$/u
  let blockStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    const match = topKeyRe.exec(lines[i])
    if (match !== null && match[1] === 'allowBuilds') {
      blockStart = i
      break
    }
  }
  const render = (map) => [...map.entries()].map(([key, value]) => '  ' + key + ': ' + value).join('\n')
  if (blockStart === -1) {
    const prefix = lines.length > 0 && lines[lines.length - 1].trim() !== '' ? '\n' : ''
    await writeFile(file, text + prefix + 'allowBuilds:\n' + render(entries) + '\n', 'utf8')
    return true
  }
  // 已有 allowBuilds 块：收集现有条目（2 空格缩进，直到空行或顶层键），合并后重写
  const existing = new Map()
  let blockEnd = blockStart + 1
  while (blockEnd < lines.length && lines[blockEnd].trim() !== '' && /^[ \t]/.test(lines[blockEnd])) {
    const entry = /^  (.+?):\s+(.*)$/u.exec(lines[blockEnd])
    if (entry !== null) existing.set(entry[1], entry[2].trim())
    blockEnd += 1
  }
  for (const [key, value] of entries) existing.set(key, String(value))
  const merged = ['allowBuilds:', ...render(existing).split('\n')]
  await writeFile(file, [...lines.slice(0, blockStart), ...merged, ...lines.slice(blockEnd)].join('\n'), 'utf8')
  return true
}

/** 针对可恢复的构建策略错误写 allowBuilds 授权；成功写出返回 true。 */
async function applyBuildPolicyRecovery(projectDir, error) {
  const errorText = String(error?.message ?? '') + ' ' + String(error?.stderr ?? '') + ' ' + String(error?.stdout ?? '')
  const entries = new Map()
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/.test(errorText)) {
    const key = deriveGitAllowBuildKey(errorText)
    if (key !== null) entries.set(key, true)
  }
  if (/ERR_PNPM_IGNORED_BUILDS/.test(errorText)) {
    for (const name of parseIgnoredBuildNames(errorText)) entries.set(name, true)
  }
  if (entries.size === 0) return false
  return mergeAllowBuilds(projectDir, entries)
}

// ── 补丁层读写（与 dsh plugin CLI 语义一致） ────────────────────────────────

/** 写队列：串行化补丁文件写入，避免并发读写冲突。 */
let patchQueue = Promise.resolve()
function queuedWrite(task) {
  const next = patchQueue.then(task, task)
  patchQueue = next.catch(() => {})
  return next
}

function findPatchPath(ctx) {
  for (const entry of ctx.loader.entries()) {
    const cfg = entry.options?.config
    if (entry.options?.name !== 'cordis:include' || cfg == null || typeof cfg.path !== 'string') continue
    if (!cfg.path.includes('cordis.yml')) continue
    const configPath = new URL(cfg.path)
    return fileURLToPath(configPath).replace(/cordis\.yml$/u, 'cordis.patch.yml')
  }
  return join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
}

async function readPatchState(patchPath) {
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const disables = []
  const forced = []
  const inserts = []
  const insertNames = {}
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^- insert:\s*$/u.test(line)) {
      inInsert = true
      continue
    }
    if (/^- /u.test(line)) inInsert = false
    if (inInsert) {
      const insertRow = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)/u)
      if (insertRow) {
        const id = insertRow[1]
        inserts.push(id)
        // name 紧跟 id 行之后（6 空格缩进），支持单/双引号与裸值
        const nameLine = lines[index + 1] ?? ''
        const nameRow = nameLine.match(/^ {6}name:\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))\s*$/u)
        if (nameRow) insertNames[id] = nameRow[1] ?? nameRow[2] ?? nameRow[3]
      }
      continue
    }
    const disableRow = line.match(/^- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (!disableRow) continue
    const next = lines[index + 1] ?? ''
    if (/^ {2}disabled: true\s*$/u.test(next)) disables.push(disableRow[1])
    else if (/^ {2}disabled: false\s*$/u.test(next)) forced.push(disableRow[1])
  }
  return { disables, forced, inserts, insertNames, text }
}

/**
 * 归一化「空 patch 层」：dsh 初始化 profile 时把空层写成注释 + `[]`（`[]` 是
 * YAML 空数组，语义为「该层无任何 patch 条目」）。追加 insert/disable 块时若直接
 * 拼在 `[]` 之后会得到 `[]\n- insert:...` 的非法 YAML（`[]` 已是完整根节点，
 * 后面不能再跟第二个根节点）。此函数在文件「除注释/空白外仅剩一个 `[]`」时
 * 原位剔除该 `[]` 行（保留注释），使追加内容成为合法的顶层数组项；
 * 文件已有真实条目、或本就是空文本/纯注释时，原样返回（不改变既有行为）。
 */
function stripEmptyArrayMarker(text) {
  const lines = text.split(/\r?\n/u)
  let marker = -1
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    // 首个非注释/非空白内容必须是 `[]`（可带行尾注释），且只能出现一次
    if (marker === -1 && /^\[\s*\]\s*(?:#.*)?$/u.test(trimmed)) {
      marker = i
      continue
    }
    // 出现其它真实内容 → 不是空态，原样返回
    return text
  }
  if (marker === -1) return text
  const kept = [...lines.slice(0, marker), ...lines.slice(marker + 1)]
  const result = kept.join('\n')
  return result.trim() === '' ? '' : result
}

function disableBlock(id) {
  return '- id: ' + id + '\n  disabled: true\n'
}

async function disableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, text } = await readPatchState(patchPath)
    if (disables.includes(id)) return { changed: false }
    const base = stripEmptyArrayMarker(text)
    const next = base.length === 0 || base.endsWith('\n') ? base : base + '\n'
    await writeFile(patchPath, next + disableBlock(id), 'utf8')
    return { changed: true }
  })
}

async function enableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, forced, text } = await readPatchState(patchPath)
    const blockRe = new RegExp('^- id: ' + escapeRegExp(id) + '\\r?\\n  disabled: true\\r?\\n', 'mu')
    if (blockRe.test(text)) {
      await writeFile(patchPath, text.replace(blockRe, ''), 'utf8')
      return { changed: true }
    }
    if (forced.includes(id)) return { changed: false }
    const base = stripEmptyArrayMarker(text)
    const next = base.length === 0 || base.endsWith('\n') ? base : base + '\n'
    await writeFile(patchPath, next + '- id: ' + id + '\n  disabled: false\n', 'utf8')
    return { changed: true }
  })
}

/** 追加一条 insert 启用行（插件包需已安装到 profile）。 */
async function appendInsert(patchPath, entryId, packageName) {
  return queuedWrite(async () => {
    const { inserts, text } = await readPatchState(patchPath)
    if (inserts.includes(entryId)) return { changed: false }
    const base = stripEmptyArrayMarker(text)
    const next = base.length === 0 || base.endsWith('\n') ? base : base + '\n'
    const block = '- insert:\n    - id: ' + entryId + '\n      name: \'' + packageName + '\'\n'
    await writeFile(patchPath, next + block, 'utf8')
    return { changed: true }
  })
}

/** 移除一条 insert 行（卸载时用），连同其 disabled 覆盖块。 */
async function removeInsertRow(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const blockRe = new RegExp('^- insert:\\s*\\r?\\n {4}- id: ' + escapeRegExp(rowId) + '\\s*\\r?\\n( {6}name: [^\\r\\n]*\\r?\\n)?', 'mu')
    let next = text.replace(blockRe, '')
    const overrideRe = new RegExp('^- id: ' + escapeRegExp(rowId) + '\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n', 'mu')
    next = next.replace(overrideRe, '')
    if (next !== text) await writeFile(patchPath, next, 'utf8')
  })
}

/** 从 profile manifest 追加/移除一个 bundle。 */
async function addBundleToManifest(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(packageName)) {
      bundles.push(packageName)
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
  })
}

async function removeBundleFromManifest(profileDir, bundlePkg) {
  return queuedWrite(async () => {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const next = bundles.filter((entry) => entry !== bundlePkg)
    if (next.length !== bundles.length) {
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
  })
}

/** bundle 包判定：声明 dsh.bundle 的包按官方 dsh plugin add 行为追加为 profile bundle 层。 */
async function detectBundleOnly(profileDir, packageName) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const pkgPath = require.resolve(packageName + '/package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    return typeof pkg.dsh?.bundle?.patch === 'string'
  } catch {
    return false
  }
}

/** 包名 → 稳定的 entryId（去 scope、非字母数字转 -、查重加后缀）。 */
function deriveEntryId(packageName, taken) {
  const base = packageName
    .replace(/^@/u, '')
    .replace(/\//gu, '-')
    .replace(/[^A-Za-z0-9_-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 40) || 'plugin'
  if (!taken.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = base + '-' + index
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('无法为插件生成唯一的条目 id')
}

// ── 插件清单 ────────────────────────────────────────────────────────────────

/** include 前缀（加载器条目 id 形如 include:schedule，补丁行 id 为 schedule）。 */
function includePrefix(ctx) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.name === 'cordis:include') return entry.id + ':'
  }
  return ''
}

function rowIdOf(ctx, entryId) {
  const prefix = includePrefix(ctx)
  if (prefix.length > 0 && entryId.startsWith(prefix)) return entryId.slice(prefix.length)
  return entryId
}

function listEntries(ctx) {
  const entries = []
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const moduleName = entry.options.name
    const rowId = rowIdOf(ctx, entry.id)
    const protectedRow = isProtectedModule(moduleName)
    entries.push({
      entryId: entry.id,
      rowId,
      moduleName,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      protected: protectedRow,
      toggleable: rowId !== 'plugin-market'
        && !protectedRow
        && typeof moduleName === 'string'
        && !moduleName.startsWith('cordis:'),
    })
  }
  return entries
}

/** 包元信息缓存（version/repository），60 秒 TTL。 */
const pkgMetaCache = new Map()
const PKG_META_TTL = 60 * 1000

function entryPkgMeta(moduleName, baseUrl) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return null
  const hit = pkgMetaCache.get(moduleName)
  if (hit !== undefined && Date.now() - hit.at < PKG_META_TTL) return hit
  const meta = { at: Date.now(), version: null, repository: null }
  try {
    const require = createRequire(baseUrl)
    const pkgPath = require.resolve(moduleName + '/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    meta.version = typeof pkg.version === 'string' ? pkg.version : null
    const rawRepo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null)
    if (typeof rawRepo === 'string') {
      let repo = rawRepo.replace(/^git\+/u, '').replace(/\.git$/u, '').toLowerCase()
      // 展示统一为 owner/name[#path:子目录]，而不是完整下载 URL
      try {
        const info = githubRepoInfo(repo)
        repo = info.path !== null && info.path !== undefined && info.path !== '' ? info.owner + '/' + info.name + '#path:' + info.path : info.owner + '/' + info.name
      } catch {}
      meta.repository = repo
    }
  } catch {}
  pkgMetaCache.set(moduleName, meta)
  return meta
}

// ── GitHub 源列表持久化 ─────────────────────────────────────────────────────

async function readSources() {
  try {
    const text = await readFile(SOURCES_FILE, 'utf8')
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

async function writeSources(list) {
  const clean = Array.from(new Set(list.filter((item) => typeof item === 'string' && item.trim() !== '')))
  await writeFile(SOURCES_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}


/** 读取插件来源仓库记录（packageName → repo 字符串；安装时自动保存，卸载时清除）。 */
async function readRepoOverrides() {
  try {
    const parsed = JSON.parse(await readFile(REPOS_FILE, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {}
      for (const [key, value] of Object.entries(parsed)) {
        // 兼容旧格式 { repo, manual }：只取 repo 字符串
        const repo = typeof value === 'string' ? value : value?.repo
        if (typeof repo === 'string' && repo.trim() !== '') out[key] = repo.trim()
      }
      return out
    }
    return {}
  } catch {
    return {}
  }
}

/** 写入单个插件的来源仓库；repository 为空串表示清除记录（卸载时调用）。安装时自动保存。 */
async function writeRepoOverride(packageName, repository) {
  const overrides = await readRepoOverrides()
  const clean = typeof repository === 'string' ? repository.trim() : ''
  if (clean === '') delete overrides[packageName]
  else overrides[packageName] = clean
  await writeFile(REPOS_FILE, JSON.stringify(overrides, null, 2) + '\n', 'utf8')
  return overrides[packageName] ?? null
}

/** 移除一条「- id: X」+「disabled: true」禁用块（重装 bundle 时清理卸载留下的临时禁用行）。 */
async function removeDisableBlock(patchPath, id) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const blockRe = new RegExp('^- id: ' + escapeRegExp(id) + '\r?\n  disabled: true\r?\n', 'mu')
    if (blockRe.test(text)) await writeFile(patchPath, text.replace(blockRe, ''), 'utf8')
  })
}

// ── 安装 / 更新通道 ─────────────────────────────────────────────────────────

/**
 * 安装插件（git 通道）：`pnpm add github:owner/name`（可带 #path 子目录），
 * 跟随仓库默认分支最新提交。安装成功后：bundle 包追加到 package.json 的
 * dsh.profile.bundles，普通插件追加 insert 行到 cordis.patch.yml（HMR 生效）。
 * @returns {{ ok, packageName, usedChannel, entryId, bundle, error, restart }}
 */
/** 适配的 dsh 最佳版本：基于该版本开发，其它版本可能不兼容。 */
const DSH_BEST_FIT_VERSION = '0.1.0-rc.7'
/** 安装任务队列：jobId → job。状态流：pulling（拉取中）→ reviewing（审查中）→ pending（待安装）→ installing（安装中）→ 完成/取消。 */
const installJobs = new Map()
/** 正在生成的审查（按 包名@版本 键）→ Promise：同一键的生成只跑一次，连点/双端触发时等待并复用结果。 */
const reviewInflight = new Map()
/** 任务过期时间：30 分钟内未确认/中断则视为废弃（清理隔离目录）。 */
const JOB_TTL_MS = 30 * 60 * 1000

/** 新建并登记一个安装任务（卡片可见性即来自此队列）。 */
function createInstallJob(repo, name) {
  const id = 'install-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6)
  const job = {
    id,
    repo,
    name,
    status: 'pulling',
    createdAt: Date.now(),
    abort: new AbortController(),
    staged: null,
    review: null,
    error: null,
    progress: null,
  }
  installJobs.set(id, job)
  return job
}

/**
 * 更新任务：检查更新审查完成后保留隔离目录（登记到本队列），点「确认更新」时直接从该
 * 隔离环境安装——不再重新拉取/审查；同时保存审查报告为该插件新版本，点击已安装卡片即可查看。
 */
const updateJobs = new Map()
/** 更新任务过期时间（与安装任务一致：30 分钟内未确认视为废弃）。 */
const UPDATE_JOB_TTL_MS = 30 * 60 * 1000

/** 新建更新任务并清理过期任务；同一插件已有任务时先释放旧的。 */
function createUpdateJob(moduleName, repoInfo, jobDir, pkgDir, review) {
  sweepUpdateJobs()
  for (const [id, job] of updateJobs) {
    if (job.moduleName === moduleName) {
      updateJobs.delete(id)
      rm(job.jobDir, { recursive: true, force: true }).catch(() => {})
    }
  }
  const id = 'update-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6)
  updateJobs.set(id, { id, moduleName, repoInfo, jobDir, pkgDir, review, createdAt: Date.now() })
  return id
}

/** 清理过期的更新任务（连同隔离目录）。 */
function sweepUpdateJobs() {
  const now = Date.now()
  for (const job of updateJobs.values()) {
    if (now - job.createdAt > UPDATE_JOB_TTL_MS) {
      updateJobs.delete(job.id)
      rm(job.jobDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 读取隔离暂存包目录的 package.json version（用于把审查报告按 新版本 保存）。 */
function readStagedVersion(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return null
  }
}

/** 中断安装任务：abort 进行中的拉取/审查，检查残留并清理，任务即刻从队列消失。 */
async function interruptInstall(jobId) {
  const job = installJobs.get(jobId)
  if (!job) return { ok: true, cancelled: true }
  installJobs.delete(jobId)
  job.status = 'cancelled'
  job.abort.abort()
  await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
  return { ok: true, cancelled: true }
}

/** 当前可见任务列表（供 /state 与「待安装插件」卡片渲染）。 */
function listInstallJobs() {
  const now = Date.now()
  const out = []
  for (const job of installJobs.values()) {
    if (job.status === 'cancelled' || job.status === 'done') continue
    if (now - job.createdAt > JOB_TTL_MS) {
      installJobs.delete(job.id)
      rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
      continue
    }
    out.push({
      jobId: job.id,
      repo: job.repo,
      packageName: job.name,
      status: job.status,
      stage: job.stage ?? null,
      scan: job.scan ?? null,
      progress: job.progress ?? null,
      createdAt: job.createdAt,
      review: job.review,
    })
  }
  return out
}

/**
 * 安装插件（git 通道）——两阶段 + 任务可视化：
 *   创建任务（pulling）→ 隔离拉取（reviewing）→ 分层审查（pending）→
 *   返回 { pending: true, jobId, review } 等用户确认；确认走 /install/confirm，
 *   中断走 /install/interrupt（取消同理）。安全审查关闭时直接安装、不产生任务。
 */
async function installPlugin(ctx, options) {
  const { repo, packageName, review } = options
  const patchPath = findPatchPath(ctx)
  const profileDir = dirname(patchPath)
  const patch = await readPatchState(patchPath)
  const taken = new Set(listEntries(ctx).map((entry) => entry.rowId))
  for (const id of [...patch.inserts, ...patch.disables, ...patch.forced]) taken.add(id)

  // 确定仓库：git 通道必须有仓库地址。包名不依赖 GitHub API——
  // 拉取后从包自身的 package.json 读取（避免限流/网络/默认分支等外部因素）。
  if (repo === undefined || repo === null || String(repo).trim() === '') {
    throw new Error('git 通道安装需要 GitHub 仓库地址（owner/name）')
  }
  let repoInfo = null
  try { repoInfo = githubRepoInfo(repo) } catch (err) { throw err instanceof Error ? err : new Error('GitHub 仓库地址格式无效') }

  // 同一仓库已有进行中的安装任务（拉取中/审查中/待安装/安装中）→ 拒绝重复发起
  const spec = gitSpec(repoInfo)
  for (const live of installJobs.values()) {
    if (live.status === 'cancelled' || live.status === 'done') continue
    if (live.repoInfo !== null && live.repoInfo !== undefined && gitSpec(live.repoInfo) === spec) {
      throw new Error('该插件已在安装中（' + live.repo + '），请勿重复安装')
    }
  }

  // 创建任务（包名初始可为空，拉取后由包自身决定）→ 隔离拉取
  const job = createInstallJob(repo, packageName ?? '')
  job.repoInfo = repoInfo
  job.profileDir = profileDir
  job.patchPath = patchPath
  job.taken = taken
  job.ctx = ctx
  try {
    job.staged = await stagePackage(gitSpec(repoInfo), job)
    if (job.abort.signal.aborted) throw new Error('安装已中断')
    // 权威包名：实际下载包的 package.json 的 name
    job.name = job.staged.pkgName
    if (job.name === null || job.name === '') throw new Error('无法确定包名：仓库 package.json 缺少 name 字段（或请提供 packageName）')
  } catch (error) {
    if (job.abort.signal.aborted) {
      installJobs.delete(job.id)
      await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
      throw new Error('安装已中断')
    }
    // 拉取失败：任务挂起为 pending，报告标注原因，用户可中断清理
    job.status = 'pending'
    job.error = error instanceof Error ? error.message : String(error)
    job.review = { summary: '拉取失败，未能安装', risks: [], severity: 'low', verdict: 'caution', details: job.error }
    return { ok: true, pending: true, jobId: job.id, packageName: job.name, review: job.review }
  }

  // 重复安装防护（拉取成功、包名确定后）：已安装 / 其它任务同包名进行中 → 拒绝并清理
  if (await isPluginInstalled(ctx, patch, job.name, profileDir)) {
    installJobs.delete(job.id)
    await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
    throw new Error('插件 ' + job.name + ' 已安装，请勿重复安装（如需升级请使用「检查更新」）')
  }
  for (const other of installJobs.values()) {
    if (other.id === job.id || other.status === 'cancelled' || other.status === 'done') continue
    if (other.name === undefined || other.name === null || other.name === '') continue
    if (other.name === job.name) {
      installJobs.delete(job.id)
      await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
      throw new Error('插件 ' + job.name + ' 正在安装中，请勿重复安装')
    }
  }

  // 安全审查关闭：直接安装（staged 已拉取，安装时顺带清理隔离目录）
  if (review !== true) {
    job.status = 'installing'
    try {
      const result = await performInstall({ repoInfo: job.repoInfo, name: job.name, profileDir: job.profileDir, patchPath: job.patchPath, taken: job.taken, staged: job.staged, job, ctx })
      job.status = 'done'
      installJobs.delete(job.id)
      return { ...result, review: null }
    } catch (error) {
      job.status = 'failed'
      installJobs.delete(job.id)
      await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  // 安全审查开启：审查 → 挂起等待确认
  job.status = 'reviewing'
  try {
    job.review = await reviewPackage(ctx, job.staged.pkgDir, job.staged.pkgName, null, job.abort.signal, (stage, data) => { job.stage = stage; if (data) job.scan = data })
    if (job.abort.signal.aborted) throw new Error('安装已中断')
    // 审查未产出报告（子代理与 LLM 通道均不可用等）：给出可见的 caution 报告，而不是静默 null
    if (job.review === null || job.review === undefined) {
      job.review = { summary: '审查未能完成（审查通道不可用）', risks: [], severity: 'low', verdict: 'caution', details: '子代理与 LLM 审查通道均未产出报告，可确认安装或中断。' }
    }
    job.status = 'pending'
  } catch (error) {
    if (job.abort.signal.aborted) {
      installJobs.delete(job.id)
      await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
      throw new Error('安装已中断')
    }
    job.status = 'pending'
    job.error = error instanceof Error ? error.message : String(error)
    job.review = job.review ?? { summary: '审查未能完成', risks: [], severity: 'low', verdict: 'caution', details: job.error }
  }
  return { ok: true, pending: true, jobId: job.id, packageName: job.name, review: job.review }
}

/** 执行真正安装（迁移到 profile）：pnpm add + 清理隔离目录 + bundle/insert 激活。 */
async function performInstall({ repoInfo, name, profileDir, patchPath, taken, staged, job = null, ctx = null }) {
  // 安装进度（迁移到 profile 的 pnpm add，同样流式回传）
  if (job !== null && job !== undefined) job.progress = null
  const onProgress = job !== null && job !== undefined
    ? (parsed) => { job.progress = progressFromPnpm(parsed) }
    : null
  await pnpmInstall(profileDir, gitSpec(repoInfo), onProgress)
  if (job !== null && job !== undefined) job.progress = null
  if (staged !== null) {
    await rm(staged.jobDir, { recursive: true, force: true }).catch(() => {})
  }
  // 保存用户填写的仓库地址（owner/name[#path:子目录]）：显示与 git 更新通道都依赖它，
  // 不依赖包内 repository 字段（很多包没有声明）
  const savedRepo = repoInfo.path !== null && repoInfo.path !== undefined && repoInfo.path !== ''
    ? repoInfo.owner + '/' + repoInfo.name + '#path:' + repoInfo.path
    : repoInfo.owner + '/' + repoInfo.name
  await writeRepoOverride(name, savedRepo)
  let entryId = null
  let bundle = false
  let restart = false
  if (await detectBundleOnly(profileDir, name)) {
    await addBundleToManifest(profileDir, name)
    // 清理上次卸载写入的临时禁用行（避免重装后被旧禁用行关掉）
    await removeDisableBlock(patchPath, name)
    await removeDisableBlock(patchPath, deriveEntryId(name, taken))
    bundle = true
    restart = true
  } else {
    entryId = deriveEntryId(name, taken)
    await appendInsert(patchPath, entryId, name)
    // insert 层本应 HMR 即时生效；热重载关闭/失败导致未进运行树 → 需重启 dsh web
    restart = ctx == null || !(await waitForInsertApplied(ctx, entryId))
  }
  return { ok: true, packageName: name, usedChannel: 'git', entryId, bundle, restart }
}

/** 阶段 2 确认：把挂起的任务真正安装进 profile（成功/失败任务都从队列消失）。 */
async function confirmInstall(jobId) {
  const job = installJobs.get(jobId)
  if (!job) throw new Error('安装任务不存在或已过期（请重新发起安装）')
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    installJobs.delete(jobId)
    await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
    throw new Error('安装任务已过期（请重新发起安装）')
  }
  installJobs.delete(jobId)
  job.status = 'installing'
  try {
    const result = await performInstall({ repoInfo: job.repoInfo, name: job.name, profileDir: job.profileDir, patchPath: job.patchPath, taken: job.taken, staged: job.staged, job, ctx: job.ctx ?? null })
    job.status = 'done'
    return result
  } catch (error) {
    job.status = 'failed'
    await rm(job.staged?.jobDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * 更新差异审查：对新版本与已装代码做文件级 diff，把变更（新增/删除/修改）与新内容一并交给审查通道，
 * 返回附 diff 的报告（method: update-diff），保证审查报告包含本次改动的描述。
 * 供「更新」与「检查更新（开启审查）」共用；无变更或扫描为空时返回 null。
 */
async function reviewUpdateDiff(ctx, installedDir, stagedPkgDir, moduleName) {
  const diff = await computePackageDiff(installedDir, stagedPkgDir)
  // 变更文件的新内容（每文件 ≤ 20KB、总计 ≤ 60KB），供模型完整判断
  let changedContent = ''
  let total = 0
  for (const rel of diff.changed) {
    const text = await readFile(join(stagedPkgDir, rel), 'utf8').catch(() => null)
    if (text === null) continue
    const capped = text.slice(0, 20000)
    total += capped.length
    if (total > 60000) break
    changedContent += '=== ' + rel + ' ===\n' + capped + '\n'
  }
  const scan = await scanRiskSurface(stagedPkgDir)
  if (scan.files.length === 0 || (diff.changed.length + diff.added.length) === 0) return null
  const label = 'security-update-' + moduleName.split('/').pop()
  const prompt = buildUpdatePrompt(scan, moduleName, scan.pkgMeta?.version ?? null, diff, changedContent)
  const report = await runReviewChannel(ctx, label, prompt, undefined)
  if (report === null || typeof report !== 'object') return null
  report.diff = diff
  report.scanned = { files: scan.files.length, sizeKB: scan.sizeKB, signals: scan.signals.length }
  report.method = 'update-diff'
  return report
}

/**
 * 更新已安装插件（git 通道）：优先使用安装来源仓库（客户端传入，与展示/检查更新同一来源），
 * `pnpm add github:owner/name` 跟随仓库默认分支最新提交。
 */
/** 已装包的本地目录（支持 scoped 包名）。 */
function installedPackageDir(profileDir, moduleName) {
  return moduleName.startsWith('@') ? join(profileDir, 'node_modules', ...moduleName.split('/')) : join(profileDir, 'node_modules', moduleName)
}

/** 计算已装包与新包的文件级差异（按 rel 路径 + 内容哈希）。 */
async function computePackageDiff(installedDir, newDir) {
  const added = []
  const removed = []
  const changed = []
  const mapTree = async (root) => {
    const map = new Map()
    const walk = async (dir, prefix) => {
      let entries = []
      try { entries = await readdir(dir) } catch { return }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.git' || entry === '.pnpm' || entry === 'dist' || entry === 'coverage' || entry.startsWith('.')) continue
        const target = join(dir, entry)
        const st = await stat(target).catch(() => null)
        if (st === null) continue
        const rel = prefix + entry
        if (st.isDirectory()) await walk(target, rel + '/')
        else map.set(rel, st.size)
      }
    }
    await walk(root, '')
    return map
  }
  const [oldMap, newMap] = await Promise.all([mapTree(installedDir), mapTree(newDir)])
  const fileHash = async (base, rel) => {
    try {
      const text = await readFile(join(base, rel), 'utf8')
      return createHash('sha1').update(text).digest('hex')
    } catch {
      return null
    }
  }
  for (const rel of newMap.keys()) {
    if (!oldMap.has(rel)) { added.push(rel); continue }
    const [h1, h2] = await Promise.all([fileHash(installedDir, rel), fileHash(newDir, rel)])
    if (h1 !== h2) changed.push(rel)
  }
  for (const rel of oldMap.keys()) if (!newMap.has(rel)) removed.push(rel)
  return { added, removed, changed }
}

/** 更新审查 prompt：在常规审查之上附加"相对已装版本的差异"（变更文件的完整新内容）。 */
function buildUpdatePrompt(scan, pkgName, version, diff, changedContent) {
  return [
    '你是 DeepSeek Harness 的插件安全审查员。用户要**更新**一个已安装的第三方插件。下面是本次更新相对已装版本的差异（新增/删除/修改的文件）与新代码内容，请**重点审查变更部分**是否引入恶意行为，并结合 L0 信号给出整体结论。',
    buildHarnessContext(scan, pkgName, version),
    '--- 本次更新差异 ---',
    '新增 ' + diff.added.length + ' 个文件：' + (diff.added.length > 0 ? diff.added.join(', ') : '（无）'),
    '删除 ' + diff.removed.length + ' 个文件：' + (diff.removed.length > 0 ? diff.removed.join(', ') : '（无）'),
    '修改 ' + diff.changed.length + ' 个文件：' + (diff.changed.length > 0 ? diff.changed.join(', ') : '（无）'),
    changedContent !== '' ? '--- 变更文件的新内容（完整判断） ---\n' + changedContent : '',
    '--- 新代码 L0 命中信号 ---',
    buildSignalBlocks(scan.signals),
    '输出约束：你的输出将直接渲染进插件市场的审查报告弹窗。只输出一个 JSON 对象，前后不要有任何其他文字（不要 markdown 代码块围栏）。字段要求：summary=一句话（说明更新内容与安全结论）；risks=字符串数组，每项一句话；severity 仅取 low/medium/high；verdict 仅取 safe/caution/danger；details=1-3 句（说明变更是否安全）。',
  ].join('\n').slice(0, PROMPT_CAP)
}

async function updatePlugin(ctx, entryId, repository = '', updateJobId = '') {
  const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
  if (!entry) throw new Error('没有名为 ' + entryId + ' 的插件条目')
  const moduleName = entry.options.name
  if (isProtectedModule(moduleName)) throw new Error(moduleName + ' 属于宿主基础设施，禁止更新')
  const patchPath = findPatchPath(ctx)
  const profileDir = dirname(patchPath)

  // 检查更新审查已保留隔离目录（更新任务）：直接从该隔离环境安装——不再重新拉取/审查；
  // 并把审查报告保存为该插件新版本，点击已安装插件卡片即可直接查看
  if (typeof updateJobId === 'string' && updateJobId !== '') {
    sweepUpdateJobs()
    const job = updateJobs.get(updateJobId)
    if (!job || job.moduleName !== moduleName) throw new Error('更新任务不存在或已过期（请重新检查更新）')
    try {
      await pnpmInstall(profileDir, gitSpec(job.repoInfo))
      const newVersion = readStagedVersion(job.pkgDir)
      if (job.review !== null && job.review !== undefined && newVersion !== null) {
        await writeReviewCache(reviewKey(moduleName, newVersion), job.review)
      }
      // 版本元信息已变化：清掉缓存，避免 /review 用旧版本键查不到刚保存的报告
      pkgMetaCache.delete(moduleName)
      return { ok: true, entryId, moduleName, usedChannel: 'git', restart: true, review: job.review }
    } finally {
      updateJobs.delete(updateJobId)
      await rm(job.jobDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // 无隔离任务（审查关闭/旧流程兼容）：重新拉取 + 差异审查 + 安装
  // 仓库解析：优先客户端传入的安装来源仓库（与展示/检查更新同一来源），否则回落包内 repository 字段
  let repoInfo = null
  if (typeof repository === 'string' && repository.trim() !== '') {
    try { repoInfo = githubRepoInfo(repository.trim()) } catch {}
  }
  if (repoInfo === null) {
    const rawRepo = entryPkgMeta(moduleName, ctx.baseUrl ?? 'file:///')?.repository ?? null
    if (typeof rawRepo === 'string') {
      try { repoInfo = githubRepoInfo(rawRepo) } catch {}
    }
  }
  if (repoInfo === null) throw new Error('git 通道需要 GitHub 仓库地址（repository 字段缺失）')

  // 更新审查：暂存新版本 → 与已装代码做文件级 diff → 审查变更 → 报告附 diff
  let review = null
  const staged = await stagePackage(gitSpec(repoInfo))
  try {
    review = await reviewUpdateDiff(ctx, installedPackageDir(profileDir, moduleName), staged.pkgDir, moduleName)
  } finally {
    await rm(staged.jobDir, { recursive: true, force: true }).catch(() => {})
  }

  await pnpmInstall(profileDir, gitSpec(repoInfo))
  return { ok: true, entryId, moduleName, usedChannel: 'git', restart: true, review }
}

// ── 安全审查（隔离拉取 → 子代理审查整个包 → 缓存报告，7 天清理） ───────────────

/** 清理隔离目录与旧审查缓存（超过 7 天的删除）。 */
async function cleanupStagingAndReviews(ctx) {
  // 隔离目录：job-* 目录超过 1 小时视为孤儿（dsh web 崩溃/重启遗留——任务队列是内存的，
  // 重启后任何 job-* 都无主，正常安装拉取几分钟、审查最多 10 分钟，1 小时阈值安全）；
  // 其它条目（如顶层残留）按 7 天兜底清理。
  const JOB_ORPHAN_MS = 60 * 60 * 1000
  try {
    const entries = await readdir(STAGING_DIR)
    for (const entry of entries) {
      const target = join(STAGING_DIR, entry)
      const st = await stat(target).catch(() => null)
      if (st === null) continue
      const age = Date.now() - st.mtimeMs
      const isJobDir = entry.startsWith('job-')
      if (isJobDir ? age > JOB_ORPHAN_MS : age > REVIEW_TTL_DAYS * 86400000) {
        await rm(target, { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {}
  const keepKeys = ctx !== undefined && ctx !== null ? installedReviewKeys(ctx) : new Set()
  try {
    const entries = await readdir(REVIEWS_DIR)
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const key = entry.slice(0, -5)
      try {
        const data = JSON.parse(await readFile(join(REVIEWS_DIR, entry), 'utf8'))
        if (shouldRetainReview(key, data, keepKeys)) continue
        if (typeof data.reviewedAt === 'number' && Date.now() - data.reviewedAt > REVIEW_TTL_DAYS * 86400000) {
          await rm(join(REVIEWS_DIR, entry), { force: true }).catch(() => {})
        }
      } catch {}
    }
  } catch {}
}

/** 一键清理缓存：删除超过 thresholdMs 的 staging 残留与审查报告。清理按钮用 1 小时阈值。 */
async function cleanupCaches(ctx, thresholdMs) {
  const now = Date.now()
  let removedStaging = 0
  let removedReviews = 0
  try {
    const entries = await readdir(STAGING_DIR)
    for (const entry of entries) {
      const target = join(STAGING_DIR, entry)
      const st = await stat(target).catch(() => null)
      if (st !== null && now - st.mtimeMs > thresholdMs) {
        await rm(target, { recursive: true, force: true }).catch(() => {})
        removedStaging += 1
      }
    }
  } catch {}
  const keepKeys = ctx !== undefined && ctx !== null ? installedReviewKeys(ctx) : new Set()
  try {
    const entries = await readdir(REVIEWS_DIR)
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const key = entry.slice(0, -5)
      const target = join(REVIEWS_DIR, entry)
      try {
        const data = JSON.parse(await readFile(target, 'utf8'))
        if (shouldRetainReview(key, data, keepKeys)) continue
        if (typeof data.reviewedAt === 'number' && now - data.reviewedAt > thresholdMs) {
          await rm(target, { force: true }).catch(() => {})
          removedReviews += 1
        }
      } catch {}
    }
  } catch {}
  return { ok: true, removedStaging, removedReviews }
}

/** 在隔离目录拉取包（spec 为 github:owner/name，可带 #path 子目录）。 */
async function stagePackage(spec, job) {
  const fsMod = await import('node:fs')
  fsMod.mkdirSync(STAGING_DIR, { recursive: true })
  fsMod.mkdirSync(REVIEWS_DIR, { recursive: true })
  const jobDir = join(STAGING_DIR, 'job-' + Date.now())
  fsMod.mkdirSync(jobDir, { recursive: true })
  // 提前登记 jobDir，中断时即便拉取未完成也能清理残留
  if (job !== undefined && job !== null) job.staged = { jobDir }
  fsMod.writeFileSync(join(jobDir, 'package.json'), JSON.stringify({ name: 'staging', private: true, dependencies: {} }, null, 2) + '\n')
  // 拉取进度：流式解析 pnpm 的 Progress 行 → job.progress（客户端 1s 轮询展示进度条）
  const onProgress = job !== undefined && job !== null
    ? (parsed) => { job.progress = progressFromPnpm(parsed) }
    : null
  await runPnpm(jobDir, ['add', spec], 180000, job?.abort?.signal, false, 0, onProgress)
  if (job !== undefined && job !== null) job.progress = null
  const manifest = JSON.parse(fsMod.readFileSync(join(jobDir, 'package.json'), 'utf8'))
  const depNames = Object.keys(manifest.dependencies ?? {})
  if (depNames.length === 0) throw new Error('隔离拉取未产生依赖')
  const pkgName = depNames[0]
  const pkgDir = join(jobDir, 'node_modules', ...(pkgName.startsWith('@') ? pkgName.split('/') : [pkgName]))
  if (job !== undefined && job !== null) job.staged = { jobDir, pkgName, pkgDir }
  return { jobDir, pkgName, pkgDir }
}

// ── L0 风险表面扫描（确定性正则，零 LLM，全量文件不限大小） ────────────────────

/** 每个命中片段带入 L1 的上下文宽度（命中点前后字符数）。 */
const SNIPPET_CTX = 400
/** L0 收集的信号总数上限（按权重取前 N 个，防上下文爆炸）。 */
const MAX_SIGNALS = 40
/** 同类型信号在单个文件里的上限（防止 minified 噪声淹没真实信号）。 */
const MAX_PER_TYPE = 5
/** 单个 L1 审查 prompt 里最多放几个信号。 */
const MAX_SIGNALS_PER_PROMPT = 6
/** 信号多时分批 L1 的最大运行数（超出部分取权重更高的前 N*M 个）。 */
const MAX_L1_RUNS = 4
/** 单个 L1/L2 prompt 的内容上限（与旧版 80KB 截断对齐）。 */
const PROMPT_CAP = 85000
/** 无信号时喂给 L1 的代码样本上限。 */
const DIGEST_CAP = 40000

/** 信号权重：分批/截断时按此排序，越高越优先深挖。 */
const SIGNAL_WEIGHT = {
	shellExec: 100,
	evalDynamic: 95,
	fsWrite: 85,
	obfuscation: 80,
	dynImport: 65,
	network: 60,
	tplUrl: 58,
	domInjection: 50,
	fileRead: 45,
	processEnv: 40,
	base64: 35,
	urls: 30,
}

/** L0 风险模式表：type（机器名）+ label（展示）+ 正则。 */
const RISK_PATTERNS = [
	{ type: 'shellExec', label: 'shell/子进程执行', re: /\b(?:child_process\b|execFile(?:Sync)?\s*\(|execSync\s*\(|spawnSync\s*\()/gu },
	{ type: 'evalDynamic', label: '动态代码执行 eval/new Function', re: /\beval\s*\(|new\s+Function\s*\(/gu },
	{ type: 'fsWrite', label: '文件系统写入', re: /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|unlink(?:Sync)?|rm(?:Sync)?|chmod(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?)\s*\(/gu },
	{ type: 'obfuscation', label: '混淆特征', re: /String\.fromCharCode\s*\(|decodeURIComponent\s*\(\s*(?:eval|atob)|atob\s*\(\s*[^)]{200,}?\)|(?:\\x[0-9a-fA-F]{2}){8,}/gu },
	{ type: 'dynImport', label: '动态 require/import', re: /\bimport\s*\(\s*(?!["'])|[^\w.]require\s*\(\s*(?!["'])/gu },
	{ type: 'network', label: '网络请求 fetch/WebSocket/XHR', re: /\bfetch\s*\(|\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b|navigator\.sendBeacon\s*\(/gu },
	{ type: 'domInjection', label: 'DOM 注入 innerHTML/document.write', re: /innerHTML\s*=|document\.write\s*\(|insertAdjacentHTML\s*\(/gu },
	{ type: 'fileRead', label: '文件系统读取', re: /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|stat(?:Sync)?)\s*\(/gu },
	{ type: 'processEnv', label: '读取进程环境变量', re: /\bprocess\.env\b/gu },
	{ type: 'base64', label: '大段 base64/hex 字面量', re: /(?:[A-Za-z0-9+/]{200,})(?:={0,2})|(?:[0-9a-f]{200,})/gu },
	{ type: 'urls', label: '外部 URL', re: /https?:\/\/[^\s"')\]]+/gu },
	{ type: 'tplUrl', label: 'URL 内嵌模板变量', re: /https?:\/\/[^\s"')\]]*\$\{/gu },
]

/**
 * L0 风险表面扫描：确定性正则在全量文件上找高风险信号（不跳过超限文件），
 * 同时收集文件清单与 source map 还原源码。返回：
 *   { files, signals, maps, mapsWithSource, restored, pkgMeta, sizeKB }
 */
async function scanRiskSurface(pkgDir) {
	const files = []
	const signals = []
	const maps = []
	const hitTexts = new Map()
	let totalBytes = 0
	const walk = async (dir) => {
		let entries = []
		try { entries = await readdir(dir) } catch { return }
		for (const entry of entries) {
			if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'coverage' || entry.startsWith('.')) continue
			const target = join(dir, entry)
			const st = await stat(target).catch(() => null)
			if (st === null) continue
			if (st.isDirectory()) {
				await walk(target)
				continue
			}
			const rel = target.slice(pkgDir.length + 1)
			totalBytes += st.size
			if (rel.endsWith('.map')) {
				if (st.size <= 2 * 1024 * 1024) maps.push(rel)
				continue
			}
			if (!/\.(js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|html|css)$/u.test(rel)) continue
			files.push({ rel, size: st.size })
			if (st.size > 64 * 1024 * 1024) continue
			let text = ''
			try { text = await readFile(target, 'utf8') } catch { continue }
			for (const pattern of RISK_PATTERNS) {
				const matches = text.matchAll(pattern.re)
				for (const m of matches) {
					if (signals.length >= MAX_SIGNALS * 4) break
					if (!hitTexts.has(rel)) hitTexts.set(rel, text)
					const line = text.slice(0, m.index).split('\n').length
					const start = Math.max(0, m.index - SNIPPET_CTX)
					const snippet = text.slice(start, Math.min(text.length, m.index + SNIPPET_CTX))
					signals.push({ type: pattern.type, label: pattern.label, file: rel, line, snippet })
				}
			}
		}
	}
	await walk(pkgDir)
	// 去重（同文件同行同类型），同类型限 MAX_PER_TYPE 防噪声淹没，再按权重取前 MAX_SIGNALS
	const seen = new Set()
	const byType = new Map()
	const unique = []
	for (const s of signals) {
		const k = s.type + '|' + s.file + '|' + s.line
		if (seen.has(k)) continue
		seen.add(k)
		const count = byType.get(s.type) ?? 0
		if (count >= MAX_PER_TYPE) continue
		byType.set(s.type, count + 1)
		unique.push(s)
	}
	unique.sort((a, b) => (SIGNAL_WEIGHT[b.type] ?? 0) - (SIGNAL_WEIGHT[a.type] ?? 0))
	const capped = unique.slice(0, MAX_SIGNALS)
	// source map 还原：存在 sourcesContent 时抽取（最多 3 个 map、每个 30KB）
	let restored = ''
	let mapsWithSource = 0
	for (const rel of maps.slice(0, 3)) {
		try {
			const map = JSON.parse(await readFile(join(pkgDir, rel), 'utf8'))
			if (Array.isArray(map.sourcesContent)) {
				const joined = map.sourcesContent.filter((c) => typeof c === 'string').join('\n')
				if (joined.length > 0) {
					mapsWithSource += 1
					restored += '=== ' + rel + ' (sourcesContent) ===\n' + joined.slice(0, 30000) + '\n'
				}
			}
		} catch {}
	}
	let pkgMeta = null
	try {
		const p = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
		pkgMeta = {
			name: p.name ?? null,
			version: p.version ?? null,
			repository: typeof p.repository === 'string' ? p.repository : (p.repository?.url ?? null),
			scripts: p.scripts ?? null,
			dsh: p.dsh ?? null,
		}
	} catch {}
	files.sort((a, b) => a.rel.localeCompare(b.rel))
	// 命中文件的完整源码：供 L1 完整判断（每文件 ≤ 40KB、总计 ≤ 80KB），而非只看片段
	const HIT_FILE_CAP = 40 * 1024
	const HIT_TOTAL_CAP = 80 * 1024
	const hitFiles = []
	let hitTotal = 0
	for (const s of capped) {
		const text = hitTexts.get(s.file)
		if (text === undefined || hitFiles.some((f) => f.rel === s.file)) continue
		const content = text.slice(0, HIT_FILE_CAP)
		hitTotal += content.length
		if (hitTotal > HIT_TOTAL_CAP) break
		hitFiles.push({ rel: s.file, content })
	}
	return { files, signals: capped, maps, mapsWithSource, restored, hitFiles, pkgMeta, sizeKB: Math.round(totalBytes / 1024) }
}

/** 无信号时拼一份代码样本（若干小文件前 8KB，累计 ≤ DIGEST_CAP）。 */
async function buildDigest(pkgDir, files) {
	const small = [...files].sort((a, b) => a.size - b.size).slice(0, 8)
	let out = ''
	for (const f of small) {
		try {
			const text = await readFile(join(pkgDir, f.rel), 'utf8')
			out += '=== ' + f.rel + ' ===\n' + text.slice(0, 8192) + '\n'
			if (out.length >= DIGEST_CAP) break
		} catch {}
	}
	return out.slice(0, DIGEST_CAP)
}

/** 组装 L0 摘要文本（文件清单 + 信号统计 + 还原源码说明）。 */
function buildL0Summary(scan, pkgName, version) {
	const fileList = scan.files.slice(0, 150).map((f) => '  ' + f.rel + ' (' + f.size + 'B)').join('\n')
	const byType = {}
	for (const s of scan.signals) byType[s.type] = (byType[s.type] ?? 0) + 1
	const signalStats = Object.keys(byType).length === 0
		? '（无）'
		: Object.entries(byType).map(([t, n]) => t + '×' + n).join('、')
	return [
		'包名：' + pkgName + ' 版本：' + (version ?? 'unknown'),
		'L0 确定性扫描结果：文件 ' + scan.files.length + ' 个，合计 ' + scan.sizeKB + ' KB，命中信号：' + signalStats,
		'source map 还原源码：' + (scan.mapsWithSource > 0 ? '有（' + scan.mapsWithSource + ' 个）' : '无'),
		'文件清单（前 150）：\n' + fileList,
	].join('\n')
}

/** 组装 DeepSeek Harness 插件上下文块（注入所有审查 prompt）：明确被审对象是 dsh 插件、包元信息与输出渲染约束。 */
function buildHarnessContext(scan, pkgName, version) {
	const meta = scan.pkgMeta ?? {}
	const dshDecl = meta.dsh !== null && meta.dsh !== undefined ? JSON.stringify(meta.dsh) : '（未声明）'
	const scripts = meta.scripts && Object.keys(meta.scripts).length > 0 ? JSON.stringify(meta.scripts) : '（无）'
	return [
		'审查对象：这是一个用于 DeepSeek Harness（dsh）的插件——Cordis 组合式 AI 编码助手。它将被安装进 dsh web profile（~/.dsh/profiles/web），作为 bundle 层或 insert 行加载进组合树运行。',
		'包信息：' + pkgName + '@' + (version ?? 'unknown') + (typeof meta.repository === 'string' && meta.repository !== '' ? '（' + meta.repository + '）' : ''),
		'dsh 声明：' + dshDecl,
		'package.json scripts：' + scripts,
		'注意：dsh 插件中 ctx.webServer.register / ctx.effect / inject 列表 / settings.register / dsh.client 声明 / window.__ModuleLoader__ 等是平台标准 API 与结构，仅出现这些不算风险，请结合代码逻辑判断是否被用于恶意目的。',
		'输出约束：你的输出将直接渲染进插件市场的审查报告弹窗。只输出一个 JSON 对象，前后不要有任何其他文字（不要 markdown 代码块围栏，不要解释性句子）。字段要求：summary=一句话；risks=字符串数组，每项一句话；severity 仅取 low/medium/high；verdict 仅取 safe/caution/danger；details=1-3 句。',
	].join('\n')
}

/** 组装信号块（每个信号带上下文片段）。 */
function buildSignalBlocks(signals) {
	return signals.map((s, i) => {
		return '[' + (i + 1) + '] ' + s.label + ' @ ' + s.file + ':' + s.line + '\n~~~\n' + s.snippet + '\n~~~'
	}).join('\n\n')
}

/** L1 定向深挖 prompt：只带命中信号及其上下文。 */
function buildSignalPrompt(scan, pkgName, version, signals) {
	return [
		'你是 DeepSeek Harness 的插件安全审查员。用户要安装一个第三方插件，下面是 L0 确定性扫描命中的高风险信号片段（带上下文）。请逐条判断每个信号是真实恶意/可疑行为，还是正常功能的合理用法，并给出整体结论。',
		buildHarnessContext(scan, pkgName, version),
		buildL0Summary(scan, pkgName, version),
		'审查目标：恶意代码（外泄数据、执行任意命令、混淆、后门、读取敏感文件、写入系统目录等）与高风险行为（网络请求、shell 执行、动态代码执行、异常权限要求等）。',
		'只输出一个 JSON 对象，不要输出其他内容，格式如下：',
		JSON.stringify({ summary: '一句话总结插件功能与本次审查结论', risks: ['风险点1'], severity: 'low | medium | high', verdict: 'safe | caution | danger', details: '详细分析（1-3 句）' }, null, 2),
		'--- 命中信号 ---',
		buildSignalBlocks(signals),
		(scan.hitFiles ?? []).length > 0 ? '--- 命中文件完整源码（供完整判断，节选） ---\n' + scan.hitFiles.map((f) => '=== ' + f.rel + ' ===\n' + f.content).join('\n\n') : '',
		scan.restored ? '--- source map 还原源码（供交叉参考，节选） ---\n' + scan.restored.slice(0, 30000) : '',
	].join('\n').slice(0, PROMPT_CAP)
}

/** L1 无信号确认 prompt：文件清单 + 代码样本。 */
function buildCleanPrompt(scan, pkgName, version, digest) {
	return [
		'你是 DeepSeek Harness 的插件安全审查员。用户要安装一个第三方插件。L0 确定性扫描（eval/new Function、child_process、动态 import、外链 URL、大段 base64、fs 写入、DOM 注入、混淆特征等）未命中任何高风险信号，下面是文件清单与代码样本，请确认结论并输出结构化 JSON。',
		buildHarnessContext(scan, pkgName, version),
		buildL0Summary(scan, pkgName, version),
		'只输出一个 JSON 对象，不要输出其他内容，格式如下：',
		JSON.stringify({ summary: '一句话总结插件功能与本次审查结论', risks: ['风险点1'], severity: 'low | medium | high', verdict: 'safe | caution | danger', details: '详细分析（1-3 句）' }, null, 2),
		'--- 代码样本 ---',
		digest,
	].join('\n').slice(0, PROMPT_CAP)
}

/** L2 聚合终审 prompt：多份子审查报告 + L0 摘要。 */
function buildAggregatePrompt(scan, pkgName, version, reports) {
	return [
		'你是 DeepSeek Harness 的插件安全审查终审。该插件因信号较多被分批审查，以下是各子审查报告（每个对应一组风险信号）。请综合全部信息给出最终结构化 JSON 结论。',
		buildHarnessContext(scan, pkgName, version),
		buildL0Summary(scan, pkgName, version),
		'--- 子审查报告 ---',
		reports.map((r, i) => '【子报告 ' + (i + 1) + '】\n' + JSON.stringify(r, null, 2)).join('\n\n'),
		'只输出一个 JSON 对象，不要输出其他内容，格式如下：',
		JSON.stringify({ summary: '一句话总结插件功能与本次审查结论', risks: ['风险点1'], severity: 'low | medium | high', verdict: 'safe | caution | danger', details: '详细分析（1-3 句）' }, null, 2),
	].join('\n').slice(0, PROMPT_CAP)
}

/** 读取审查缓存（按 包名@版本 键，7 天内有效）。 */
async function readReviewCache(key) {
  try {
    const data = JSON.parse(await readFile(join(REVIEWS_DIR, key + '.json'), 'utf8'))
    if (typeof data.reviewedAt === 'number' && Date.now() - data.reviewedAt <= REVIEW_TTL_DAYS * 86400000) {
      return data.report ?? null
    }
    return null
  } catch {
    return null
  }
}

/** 写入审查报告缓存。 */
async function writeReviewCache(key, report) {
  try {
    const fsMod = await import('node:fs')
    fsMod.mkdirSync(REVIEWS_DIR, { recursive: true })
    await writeFile(join(REVIEWS_DIR, key + '.json'), JSON.stringify({ reviewedAt: Date.now(), report }, null, 2) + '\n', 'utf8')
  } catch {}
}

/** 审查缓存键：包名@版本（无版本时 'latest'，与 reviewPackage 一致）。 */
function reviewKey(pkgName, version) {
  return pkgName + '@' + (version ?? 'latest')
}

/** 直接读取审查缓存文件（不按 7 天 TTL 过期，供已安装版本报告的保留读取）。
 * 返回 { report, reviewedAt, protected } 或 null。 */
async function readReviewFile(key) {
  try {
    const data = JSON.parse(await readFile(join(REVIEWS_DIR, key + '.json'), 'utf8'))
    return { report: data.report ?? null, reviewedAt: data.reviewedAt ?? null, protected: data.protected === true }
  } catch {
    return null
  }
}

/** 标记某审查缓存为「保留」（清理缓存/自动清理都跳过）。 */
async function markReviewProtected(key) {
  try {
    const file = join(REVIEWS_DIR, key + '.json')
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (data.protected !== true) {
      data.protected = true
      await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
    }
  } catch {}
}

/** 当前已安装插件（用户列表）的审查键集合：moduleName@当前版本。
 * 清理时跳过这些键——已安装版本的审查报告永久保留。 */
function installedReviewKeys(ctx) {
  const keys = new Set()
  try {
    for (const entry of listEntries(ctx)) {
      const meta = entryPkgMeta(entry.moduleName, ctx.baseUrl ?? 'file:///')
      if (meta?.version !== null && meta?.version !== undefined && meta.version !== '') {
        keys.add(reviewKey(entry.moduleName, meta.version))
      }
    }
  } catch {}
  return keys
}

/** 判断某个审查缓存条目是否应保留（纯函数，无磁盘）：键命中当前已安装版本，
 * 或文件数据标记了 protected（手动查看/生成后标记）。 */
function shouldRetainReview(key, data, keepKeys) {
  if (keepKeys.has(key)) return true
  return data !== null && data !== undefined && data.protected === true
}

/** 读取审查用的默认 LLM 路由（跟随用户 agent-default-model 设置；失败回退 deepseek-official）。 */
function reviewLlmRoute(ctx) {
  try {
    const settings = ctx.get('settings')
    const model = settings?.get?.('agent-default-model')
    const route = { provider: 'deepseek-official' }
    if (model !== null && typeof model === 'object') {
      if (typeof model.provider === 'string' && model.provider !== '') route.provider = model.provider
      if (typeof model.model === 'string' && model.model !== '') route.model = model.model
      if (typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '') route.reasoningEffort = model.reasoningEffort
    }
    return route
  } catch {
    return { provider: 'deepseek-official' }
  }
}

/**
 * LLM 直连审查通道：用 ctx.llm.stream 直接调用大模型（云端 provider，跟随默认模型）。
 * 手工组装消息与流式输出（保持插件零第三方依赖，不 import dsh-llm）。
 * 与子代理通道共用同一 prompt 与报告 schema。
 */
async function runReviewLlm(ctx, promptText, signal) {
  let llm = null
  try { llm = ctx.get('llm') } catch {}
  if (!llm || typeof llm.stream !== 'function') return null
  const route = reviewLlmRoute(ctx)
  const message = Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: Object.freeze([Object.freeze({ type: 'text', text: promptText })]),
    source: Object.freeze({ kind: 'plugin', plugin: 'dsh-plugin-market' }),
  })
  const options = {
    provider: route.provider,
    messages: Object.freeze([message]),
    signal,
  }
  if (route.model !== undefined) options.model = route.model
  if (route.reasoningEffort !== undefined) options.reasoningEffort = route.reasoningEffort
  let text = ''
  let finishFailure = null
  try {
    for await (const chunk of llm.stream(options)) {
      if (signal?.aborted) return null
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error') finishFailure = chunk.reason.failure
        else if (chunk.reason?.kind === 'aborted') return null
      }
    }
  } catch (error) {
    if (signal?.aborted) return null
    throw error
  }
  if (finishFailure !== null) throw new Error('LLM 审查失败：' + String(finishFailure?.message ?? '未知错误'))
  if (text === '') return null
  const jsonMatch = text.match(/\{[\s\S]*\}/u)
  if (!jsonMatch) return null
  let report = null
  try { report = JSON.parse(jsonMatch[0]) } catch { return null }
  if (!report || typeof report !== 'object') return null
  return {
    summary: String(report.summary ?? ''),
    risks: Array.isArray(report.risks) ? report.risks.map((r) => String(r)) : [],
    severity: ['low', 'medium', 'high'].includes(report.severity) ? report.severity : 'medium',
    verdict: ['safe', 'caution', 'danger'].includes(report.verdict) ? report.verdict : 'caution',
    details: String(report.details ?? ''),
    channel: 'llm',
  }
}

/** 尽力清理审查会话 agent。 */
async function disposeReviewAgent(handle) {
  try { if (handle !== null && handle !== undefined && typeof handle.dispose === 'function') await handle.dispose() } catch {}
}

/** 尽力归档审查会话（隐藏于客户端列表；workspaceRegistry 归档集合）。 */
async function archiveReviewSession(ctx, sessionId) {
  try {
    const ws = ctx.get('workspaceRegistry')
    if (ws !== null && ws !== undefined) {
      if (typeof ws.archive === 'function') await ws.archive(sessionId)
      else if (typeof ws.archiveSession === 'function') await ws.archiveSession(sessionId)
      else if (typeof ws.setArchived === 'function') await ws.setArchived(sessionId, true)
    }
  } catch {}
}

/**
 * 自动起一轮 harness 会话做审查：创建会话 agent（loop 自动启动）→ followup 发 prompt
 * → 轮询会话日志等 assistant/message 回复 → 提取 JSON 报告 → 归档隐藏会话。
 * 任何环节失败/不可用返回 null（回退 LLM 直连）。报告 channel 标记 'session'（harness）。
 */
async function runReviewSession(ctx, promptText, signal) {
  let agents = null
  try { agents = ctx.get('agents') } catch {}
  if (!agents || typeof agents.create !== 'function') return null
  const route = reviewLlmRoute(ctx)
  const sessionId = 'review-' + randomUUID().slice(0, 8)
  let handle = null
  try {
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: {
        ...(route.provider !== undefined ? { provider: route.provider } : {}),
        ...(route.model !== undefined ? { model: route.model } : {}),
      },
      signal,
    })
  } catch {
    return null
  }
  if (handle === null || handle === undefined) return null
  let agent = handle
  try { agent = agents.get ? (agents.get(sessionId) ?? handle) : handle } catch { agent = handle }
  if (!agent || typeof agent.followup !== 'function') {
    await disposeReviewAgent(handle)
    return null
  }
  const session = agent.session ?? null
  try {
    const message = Object.freeze({
      role: 'user',
      id: randomUUID(),
      content: Object.freeze([Object.freeze({ type: 'text', text: promptText })]),
      source: Object.freeze({ kind: 'plugin', plugin: 'dsh-plugin-market' }),
    })
    // 防干扰：发 prompt 前立即归档隐藏会话（可见窗口缩到毫秒级），
    // 用户即使退出市场也基本找不到/点不开这个会话
    await archiveReviewSession(ctx, sessionId)
    const startIdx = Array.isArray(session?.log) ? session.log.length : 0
    agent.followup(message)
    // 轮询等待 assistant/message 回复（180s 超时，支持中断）。
    // 精确提取：只取 startIdx 之后的第一条 assistant/message——用户后续干扰消息
    // 会排在审查 turn 的 inbox 之后，不会污染提取（旧逻辑取"最后一条"会被污染）。
    const deadline = Date.now() + 180000
    let text = ''
    while (Date.now() < deadline) {
      if (signal?.aborted) return null
      try {
        if (session !== null && Array.isArray(session.log)) {
          for (let i = startIdx; i < session.log.length; i += 1) {
            const event = session.log[i]
            if (event.type !== 'assistant/message') continue
            const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
            const t = content.filter((b) => b !== null && b !== undefined && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
            if (t !== '') { text = t; break }
          }
          if (text !== '') break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (text === '') return null
    const jsonMatch = text.match(/\{[\s\S]*\}/u)
    if (!jsonMatch) return null
    let report = null
    try { report = JSON.parse(jsonMatch[0]) } catch { return null }
    if (!report || typeof report !== 'object') return null
    return {
      summary: String(report.summary ?? ''),
      risks: Array.isArray(report.risks) ? report.risks.map((r) => String(r)) : [],
      severity: ['low', 'medium', 'high'].includes(report.severity) ? report.severity : 'medium',
      verdict: ['safe', 'caution', 'danger'].includes(report.verdict) ? report.verdict : 'caution',
      details: String(report.details ?? ''),
      channel: 'session',
    }
  } catch {
    return null
  } finally {
    await disposeReviewAgent(handle)
    await archiveReviewSession(ctx, sessionId)
  }
}

/** 审查通道：harness 会话优先（自动起一轮会话分析），失败/不可用回退 LLM 直连。 */
async function runReviewChannel(ctx, label, promptText, signal) {
  const sessionReport = await runReviewSession(ctx, promptText, signal)
  if (sessionReport !== null) return sessionReport
  return runReviewLlm(ctx, promptText, signal)
}

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 }
const VERDICT_RANK = { safe: 0, caution: 1, danger: 2 }

/** 合并多份子审查报告（取最差严重度/结论，risks 去重拼接）。 */
function mergeReports(reports, scan) {
	const base = reports[0] ?? { summary: '', risks: [], severity: 'medium', verdict: 'caution', details: '' }
	return {
		summary: base.summary,
		risks: [...new Set(reports.flatMap((r) => r.risks ?? []))],
		severity: reports.reduce((worst, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst), 'low'),
		verdict: reports.reduce((worst, r) => (VERDICT_RANK[r.verdict] > VERDICT_RANK[worst] ? r.verdict : worst), 'safe'),
		details: reports.length === 1 ? base.details : '综合 ' + reports.length + ' 份子审查：' + reports.map((r) => r.summary).join('；'),
	}
}

/**
 * 分层安全审查：L0 确定性扫描全量文件（不限大小）→ 命中信号分批交给
 * dsh 审查会话 / LLM 定向深挖（带上下文）→ 信号多时再做一层聚合终审。
 * 相比旧实现：>256KB 的大文件不再被整体跳过（改全量特征扫描 + 片段深挖）；
 * source map 带 sourcesContent 时还原可读源码供交叉参考。
 */
async function reviewPackage(ctx, pkgDir, pkgName, version, signal, onStage) {
	const key = pkgName + '@' + (version ?? 'latest')
	const cached = await readReviewCache(key)
	if (cached !== null) return { ...cached, cached: true }
	onStage?.('scan')
	const scan = await scanRiskSurface(pkgDir)
	if (scan.files.length === 0) return null
	onStage?.('l1', { files: scan.files.length, sizeKB: scan.sizeKB, signals: scan.signals.length })
	const label = 'security-review-' + pkgName.split('/').pop()
	let report = null
	if (scan.signals.length === 0) {
		const digest = await buildDigest(pkgDir, scan.files)
		if (digest.length === 0) return null
		report = await runReviewChannel(ctx, label, buildCleanPrompt(scan, pkgName, version, digest), signal)
	} else if (scan.signals.length <= MAX_SIGNALS_PER_PROMPT) {
		report = await runReviewChannel(ctx, label, buildSignalPrompt(scan, pkgName, version, scan.signals), signal)
	} else {
		const batches = []
		for (let i = 0; i < scan.signals.length && batches.length < MAX_L1_RUNS; i += MAX_SIGNALS_PER_PROMPT) {
			batches.push(scan.signals.slice(i, i + MAX_SIGNALS_PER_PROMPT))
		}
		onStage?.('aggregate')
		const subReports = (await Promise.all(batches.map((b) => runReviewChannel(ctx, label, buildSignalPrompt(scan, pkgName, version, b), signal)))).filter(Boolean)
		if (subReports.length > 1) {
			report = await runReviewChannel(ctx, label + '-aggregate', buildAggregatePrompt(scan, pkgName, version, subReports), signal)
			if (report === null) report = mergeReports(subReports, scan)
		} else if (subReports.length === 1) {
			report = subReports[0]
		}
	}
	if (report === null) return null
	const final = {
		...report,
		scanned: { files: scan.files.length, sizeKB: scan.sizeKB, signals: scan.signals.length, mapsWithSource: scan.mapsWithSource },
		method: scan.signals.length === 0 ? 'L0 clean' : (scan.signals.length <= MAX_SIGNALS_PER_PROMPT ? 'L0+L1' : 'L0+L1+aggregate'),
	}
	await writeReviewCache(key, final)
	return final
}

/** 轮询 loader 树，验证补丁变更是否被热更新应用（最长 3 秒，250ms 间隔）。 */
async function waitForToggleApplied(ctx, entryId, enabled) {
	const deadline = Date.now() + 3000
	while (Date.now() < deadline) {
		try {
			const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
			if (entry !== undefined && (!entry.disabled) === enabled) return true
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	return false
}

/** 轮询 loader 树，验证新 insert 行是否被热更新加载进运行树（按 rowId 匹配，最长 3 秒）。
 * 用于判断 insert 层插件是否需要重启：热重载关闭/失败时新条目不会出现，返回 false。 */
async function waitForInsertApplied(ctx, entryId) {
	const deadline = Date.now() + 3000
	while (Date.now() < deadline) {
		try {
			const found = [...ctx.loader.entries()].some((candidate) => rowIdOf(ctx, candidate.id) === entryId && !candidate.disabled)
			if (found) return true
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	return false
}

// ── dsh 自更新检测（侧边栏状态灯） ───────────────────────────────────────────

/** 读取已安装 dsh 版本：web profile 必装的默认 bundle `@deepseek-ai/dsh-web-app`
 * 版本与 dsh 本体一致（monorepo 全包同版本），回退 `@deepseek-ai/dsh-base`。 */
async function readInstalledDshVersion(ctx) {
  const baseUrl = ctx?.baseUrl ?? 'file:///'
  for (const candidate of ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base']) {
    const meta = entryPkgMeta(candidate, baseUrl)
    if (meta?.version !== null && meta?.version !== undefined && meta.version !== '') return meta.version
  }
  return null
}

/** 轻量 semver 比较：major.minor.patch 数值逐段 + `-rc.N` 预发布号；返回 1/-1/0。 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v))
    if (m === null) return null
    return { maj: Number(m[1]), min: Number(m[2]), pat: Number(m[3]), pre: m[4] ?? null }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return 0
  for (const key of ['maj', 'min', 'pat']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const rc = (s) => { const m = /(?:-|^)rc\.(\d+)$/.exec(s); return m !== null ? Number(m[1]) : 0 }
  return rc(pa.pre) === rc(pb.pre) ? 0 : (rc(pa.pre) > rc(pb.pre) ? 1 : -1)
}

/** 用 `git ls-remote --tags` 取 deepseek-harness 的最新 `dsh-v*` tag 版本（git 协议无 API 限流）。 */
async function gitRemoteTags(owner, name) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--tags', 'https://github.com/' + owner + '/' + name + '.git'], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    })
    const tags = []
    for (const line of String(stdout).split('\n')) {
      const m = /refs\/tags\/(dsh-v[0-9]+\.[0-9]+\.[0-9]+(?:-[^{}\s]+)?)$/.exec(line.trim())
      if (m !== null) tags.push(m[1].replace(/^dsh-v/u, ''))
    }
    tags.sort((x, y) => compareVersions(y, x))
    return tags[0] ?? null
  } catch {
    return null
  }
}

/** 读取持久化的 dsh 状态（失败返回 null）。 */
async function readDshState() {
  try {
    const data = JSON.parse(await readFile(DSH_STATE_FILE, 'utf8'))
    if (data !== null && typeof data === 'object') return data
  } catch {}
  return null
}

/** 写入 dsh 状态（尽力，失败静默）。 */
async function writeDshState(state) {
  try {
    await writeFile(DSH_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch {}
}

/** 内存缓存（仅加速读取；磁盘 `DSH_STATE_FILE` 是唯一持久化真相）。 */
let dshStateCache = null
let dshCheckInflight = null

/** 检测 dsh 是否有新版本（git tag 对比已装版本），并发合并、结果写缓存 + 磁盘。 */
function checkDshUpdate(ctx) {
  if (dshCheckInflight !== null) return dshCheckInflight
  const run = (async () => {
    const installed = await readInstalledDshVersion(ctx)
    const latest = await gitRemoteTags(DSH_REPO.owner, DSH_REPO.name)
    const prev = await readDshState()
    const hasUpdate = installed !== null && latest !== null && compareVersions(latest, installed) > 0
    // 远端版本变化时重置判定（回到黄灯待分析）
    const sameTarget = prev !== null && prev.latest === latest
    const state = {
      installed,
      latest,
      hasUpdate,
      checked: latest !== null,
      verdict: sameTarget ? (prev.verdict ?? null) : null,
      summary: sameTarget ? (prev.summary ?? null) : null,
      changes: sameTarget ? (prev.changes ?? []) : [],
      affectedPlugins: sameTarget ? (prev.affectedPlugins ?? []) : [],
      details: sameTarget ? (prev.details ?? null) : null,
      sessionId: sameTarget ? (prev.sessionId ?? null) : null,
      analyzedAt: sameTarget ? (prev.analyzedAt ?? null) : null,
      checkedAt: Date.now(),
      status: 'idle',
    }
    dshStateCache = state
    await writeDshState(state)
    return state
  })()
  dshCheckInflight = run
  run.then(() => {}, () => {}).finally(() => { if (dshCheckInflight === run) dshCheckInflight = null })
  return run
}

/** 用 GitHub compare API 拉取 dsh-v<installed>...dsh-v<latest> 的 commit + 文件补丁。 */
async function fetchDshCompare(installed, latest) {
  const url = 'https://api.github.com/repos/' + DSH_REPO.owner + '/' + DSH_REPO.name + '/compare/dsh-v' + installed + '...dsh-v' + latest
  const headers = { 'user-agent': 'dsh-plugin-market' }
  if (typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN !== '') headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('compare API HTTP ' + res.status)
  return res.json()
}

/** 把 compare 结果摘要化：commit 标题 + 核心源码文件（packages/apps/config，过滤纯文档）+ 节选补丁。 */
function summarizeCompare(data) {
  const commits = (data?.commits ?? [])
    .map((c) => String(c?.commit?.message ?? '').split('\n')[0].trim())
    .filter((s) => s !== '')
    .slice(0, 80)
  const files = []
  let patchTotal = 0
  for (const f of data?.files ?? []) {
    const rel = String(f?.filename ?? '')
    if (!/^(packages|apps|config)\//u.test(rel)) continue
    const patch = typeof f?.patch === 'string' ? f.patch : ''
    const capped = patch.slice(0, 20000)
    patchTotal += capped.length
    files.push({ status: f.status, filename: rel, additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch: capped })
    if (patchTotal > 60000) break
  }
  return { commits, files }
}

/** 当前已安装用户插件的 `name@version` 清单（供模型判断破坏性影响面）。 */
async function listInstalledPluginsForPrompt(ctx) {
  const out = []
  try {
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const patch = await readPatchState(patchPath)
    let bundles = []
    try {
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      bundles = manifest.dsh?.profile?.bundles ?? []
    } catch {}
    for (const entry of listEntries(ctx)) {
      const extra = patch.inserts.includes(entry.rowId)
      if (!isUserInstalled(entry.moduleName, entry.rowId, extra, bundles)) continue
      const meta = entryPkgMeta(entry.moduleName, ctx.baseUrl ?? 'file:///')
      out.push(entry.moduleName + (meta?.version ? '@' + meta.version : ''))
    }
  } catch {}
  return out.slice(0, 40)
}

/** 组装升级分析 prompt：要求模型结构化输出 changes/breakingChanges/affectedPlugins。 */
function buildDshUpdatePrompt(installed, latest, compare, installedPlugins) {
  const lines = [
    '你是 DeepSeek Harness 的升级分析员。检测到 dsh（deepseek-ai/deepseek-harness）有新版本：当前 ' + installed + ' → 最新 ' + latest + '。请分析这次升级更新了什么内容，并判断是否存在对「当前已安装插件」的破坏性更新。',
  ]
  if (compare !== null && compare !== undefined) {
    lines.push('--- 本次升级提交标题 ---')
    lines.push(compare.commits.length > 0 ? compare.commits.join('\n') : '（无法获取提交）')
    if (compare.files.length > 0) {
      lines.push('--- 本次升级核心源码文件变更 ---')
      lines.push(compare.files.map((f) => f.status + ' ' + f.filename + ' (+' + (f.additions ?? 0) + '/-' + (f.deletions ?? 0) + ')').join('\n'))
      lines.push('--- 变更补丁（节选） ---')
      lines.push(compare.files.map((f) => '=== ' + f.filename + ' ===\n' + f.patch).join('\n\n'))
    }
  } else {
    lines.push('--- 注意：未能拉取到精确 commit/diff（GitHub API 限流或网络问题），请基于版本变化与通用知识判断 ---')
  }
  lines.push('--- 当前已安装插件 ---')
  lines.push(installedPlugins.length > 0 ? installedPlugins.join(', ') : '（无用户安装的第三方插件）')
  lines.push('输出约束：你的输出将直接用于插件市场的升级提示。只输出一个 JSON 对象，前后不要有任何其他文字（不要 markdown 代码块围栏）。字段要求：changes=字符串数组（本次升级要点）；breakingChanges=布尔（是否存在对当前已安装插件的破坏性更新，如服务/接口移除、inject 名、slot 契约、配置 schema、dsh.client 声明、CLI/包结构、依赖版本要求等变化）；affectedPlugins=字符串数组（可能受影响的插件名，无则空数组）；summary=一句话；details=1-3 句兼容性说明。')
  return lines.join('\n').slice(0, PROMPT_CAP)
}

/** 解析模型的结构化回复（容忍前后杂质，只取第一个 JSON 对象）。 */
function parseBreakingReport(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/u)
  if (jsonMatch === null) return null
  let report = null
  try { report = JSON.parse(jsonMatch[0]) } catch { return null }
  if (report === null || typeof report !== 'object') return null
  return {
    breakingChanges: report.breakingChanges === true,
    changes: Array.isArray(report.changes) ? report.changes.map((c) => String(c)) : [],
    affectedPlugins: Array.isArray(report.affectedPlugins) ? report.affectedPlugins.map((c) => String(c)) : [],
    summary: String(report.summary ?? ''),
    details: String(report.details ?? ''),
  }
}

/** 尽力把分析会话挂到当前工作区（客户端传当前 sessionId 定位；失败挂最近工作区/跳过）。 */
async function attachSessionToWorkspace(ctx, sessionId, currentSessionId) {
  try {
    const ws = ctx.get('workspaceRegistry')
    if (ws === null || ws === undefined || typeof ws.list !== 'function') return false
    const workspaces = ws.list()
    if (!Array.isArray(workspaces)) return false
    let target = null
    if (typeof currentSessionId === 'string' && currentSessionId !== '') {
      target = workspaces.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(currentSessionId)) ?? null
    }
    if (target === null) target = workspaces[workspaces.length - 1] ?? null
    if (target !== null && typeof target.attachSession === 'function') {
      await target.attachSession(sessionId)
      return true
    }
  } catch {}
  return false
}

/**
 * 创建可见的分析会话并自动发题（默认模型）。与 `runReviewSession` 不同：不归档、不 dispose，
 * 会话保留在侧边栏供用户查看。返回 { sessionId, session, startIdx } 供后台轮询提取回复。
 */
async function createVisibleAnalysisSession(ctx, promptText, signal) {
  let agents = null
  try { agents = ctx.get('agents') } catch {}
  if (!agents || typeof agents.create !== 'function') return null
  const route = reviewLlmRoute(ctx)
  const sessionId = 'dsh-update-' + randomUUID().slice(0, 8)
  let handle = null
  try {
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: {
        ...(route.provider !== undefined ? { provider: route.provider } : {}),
        ...(route.model !== undefined ? { model: route.model } : {}),
      },
      signal,
    })
  } catch { return null }
  if (handle === null || handle === undefined) return null
  let agent = handle
  try { agent = agents.get ? (agents.get(sessionId) ?? handle) : handle } catch { agent = handle }
  if (!agent || typeof agent.followup !== 'function') return null
  const session = agent.session ?? null
  const message = Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: Object.freeze([Object.freeze({ type: 'text', text: promptText })]),
    source: Object.freeze({ kind: 'plugin', plugin: 'dsh-plugin-market' }),
  })
  const startIdx = Array.isArray(session?.log) ? session.log.length : 0
  agent.followup(message)
  return { sessionId, session, startIdx }
}

/** 轮询会话日志，提取 startIdx 之后第一条 assistant/message 的文本（防用户后续干扰）。 */
async function collectSessionReply(session, startIdx, signal) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    try {
      if (session !== null && Array.isArray(session.log)) {
        for (let i = startIdx; i < session.log.length; i += 1) {
          const event = session.log[i]
          if (event.type !== 'assistant/message') continue
          const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
          const t = content.filter((b) => b !== null && b !== undefined && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
          if (t !== '') return t
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

/** 后台收尾：轮询回复 → 解析 breakingChanges → 持久化 verdict。 */
async function finishDshAnalysis(ctx, created, state) {
  const text = await collectSessionReply(created.session, created.startIdx, null)
  let verdict = null
  let summary = null
  let changes = []
  let affectedPlugins = []
  let details = null
  if (text !== null && text !== '') {
    const parsed = parseBreakingReport(text)
    if (parsed !== null) {
      verdict = parsed.breakingChanges ? 'breaking' : 'safe'
      summary = parsed.summary
      changes = parsed.changes
      affectedPlugins = parsed.affectedPlugins
      details = parsed.details
    }
  }
  const next = {
    ...state,
    verdict,
    summary,
    changes,
    affectedPlugins,
    details,
    sessionId: created.sessionId,
    analyzedAt: Date.now(),
    status: 'idle',
  }
  dshStateCache = next
  await writeDshState(next)
}

/** 点击状态灯：确保有更新 → 拉 compare diff → 建可见会话 → 异步解析判定。 */
async function analyzeDshUpdate(ctx, currentSessionId) {
  const state = dshStateCache ?? await checkDshUpdate(ctx)
  if (state === null || state.hasUpdate !== true || !state.installed || !state.latest) {
    return { ok: false, skipped: true, error: '当前已是最新版本或未能检测到更新', ...state }
  }
  // 已分析且远端版本未变：直接重开已有分析会话，不重复分析
  if ((state.verdict === 'safe' || state.verdict === 'breaking') && state.sessionId) {
    return { ok: true, sessionId: state.sessionId, reopened: true, ...state }
  }
  let compare = null
  try {
    compare = summarizeCompare(await fetchDshCompare(state.installed, state.latest))
  } catch {}
  const installedPlugins = await listInstalledPluginsForPrompt(ctx)
  const promptText = buildDshUpdatePrompt(state.installed, state.latest, compare, installedPlugins)
  const created = await createVisibleAnalysisSession(ctx, promptText, null)
  if (created === null || created.sessionId === undefined) {
    return { ok: false, error: '未能开启分析会话（默认模型通道不可用）', ...state }
  }
  await attachSessionToWorkspace(ctx, created.sessionId, currentSessionId)
  const analyzing = { ...state, status: 'analyzing', sessionId: created.sessionId }
  dshStateCache = analyzing
  await writeDshState(analyzing)
  void finishDshAnalysis(ctx, created, state).catch(() => {})
  return { ok: true, sessionId: created.sessionId, ...analyzing }
}

// ── 主路由处理 ──────────────────────────────────────────────────────────────

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const method = req.method ?? 'GET'
  const body = await collectBody(req)

  // 状态：插件清单 + 补丁层 + GitHub 源
  if (method === 'GET' && pathname === ROUTE_PREFIX + '/state') {
    const patchPath = findPatchPath(ctx)
    const patch = await readPatchState(patchPath)
    const sources = await readSources()
    // 用户安装的 bundle 包：profile manifest 的 dsh.profile.bundles 中非默认的
    const profileDir = dirname(patchPath)
    let bundles = []
    let deps = {}
    try {
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      bundles = manifest.dsh?.profile?.bundles ?? []
      deps = manifest.dependencies ?? {}
    } catch {}
    const overrides = await readRepoOverrides()
    const entries = listEntries(ctx).map((entry) => {
      const meta = entryPkgMeta(entry.moduleName, ctx.baseUrl ?? 'file:///')
      const extra = patch.inserts.includes(entry.rowId)
      // 用户安装的 bundle（非默认）：进 dsh.profile.bundles 的第三方 bundle
      const userBundle = bundles.includes(entry.moduleName) && !DEFAULT_BUNDLES.includes(entry.moduleName)
      // 仓库覆盖（安装时自动保存的来源仓库）：展示与 git 通道只取它，不回落到包内 repository 字段
      const override = Object.prototype.hasOwnProperty.call(overrides, entry.moduleName) ? overrides[entry.moduleName] : null
      return {
        ...entry,
        userDisabled: patch.disables.includes(entry.rowId),
        userForced: patch.forced.includes(entry.rowId),
        extra,
        userBundle,
        userInstalled: isUserInstalled(entry.moduleName, entry.rowId, extra, bundles),
        localInstalled: isLocalDependency(profileDir, entry.moduleName),
        localPath: localDependencyPath(profileDir, entry.moduleName),
        version: meta?.version ?? null,
        repository: override,
      }
    })
    // 依赖 spec → 展示通道（git/link/file/npm）
    const channelOf = (spec) => typeof spec === 'string'
      ? (spec.startsWith('github:') ? 'git' : spec.startsWith('link:') ? 'link' : spec.startsWith('file:') ? 'file' : 'npm')
      : null
    // 已写入 manifest 但尚未加载进运行树（bundle 层只在 dsh web 启动时加载）：
    // 说明安装已成功落盘，重启后生效
    const pendingBundles = bundles
      .filter((b) => !DEFAULT_BUNDLES.includes(b) && !entries.some((e) => e.moduleName === b))
      .map((b) => ({ moduleName: b, channel: channelOf(deps[b] ?? null) ?? 'bundle', spec: deps[b] ?? null }))
    // insert 层插件：patch 里已 insert、但未加载进运行树（热重载关闭/失败或需重启）
    // → 同样列入待重启，避免「已安装」「待重启」都看不到它
    const pendingInserts = patch.inserts
      .filter((id) => !entries.some((e) => e.rowId === id))
      .map((id) => {
        const moduleName = patch.insertNames[id]
        if (typeof moduleName !== 'string' || moduleName === '') return null
        return { moduleName, channel: channelOf(deps[moduleName] ?? null) ?? 'insert', spec: deps[moduleName] ?? null }
      })
      .filter(Boolean)
    const pendingRestart = [...pendingBundles, ...pendingInserts]
    sendJson(res, 200, { ok: true, entries, sources, patchPath, jobs: listInstallJobs(), pendingRestart, dshBestFit: DSH_BEST_FIT_VERSION, dshVersion: dshStateCache ?? null })
    return
  }

  // 保存 GitHub 源列表（可编辑、持久化）
  if (pathname === ROUTE_PREFIX + '/sources') {
    const { sources } = body
    if (!Array.isArray(sources)) {
      sendError(res, 400, 'sources 必须是字符串数组')
      return
    }
    const clean = await writeSources(sources)
    sendJson(res, 200, { ok: true, sources: clean })
    return
  }

  // 开关插件（写 cordis.patch.yml，HMR 生效）
  if (pathname === ROUTE_PREFIX + '/toggle') {
    const { entryId, enabled } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    if (typeof enabled !== 'boolean') {
      sendError(res, 400, 'enabled 必须是布尔值')
      return
    }
    const target = ctx.loader.entries().find((entry) => entry.id === entryId)
    if (!target) {
      sendError(res, 404, '没有名为 ' + entryId + ' 的插件条目')
      return
    }
    if (isProtectedModule(target?.options?.name)) {
      sendError(res, 403, target.options.name + ' 属于宿主基础设施，禁止开关')
      return
    }
    const rowId = rowIdOf(ctx, entryId)
    if (rowId === 'plugin-market') {
      sendError(res, 400, '不能停用插件市场自身')
      return
    }
    const patchPath = findPatchPath(ctx)
    const result = enabled
      ? await enableEntry(patchPath, rowId)
      : await disableEntry(patchPath, rowId)
    // 校验热更新是否真的应用：轮询 loader 树，未生效则提示需重启 dsh web
    const applied = await waitForToggleApplied(ctx, entryId, enabled)
    sendJson(res, 200, { ok: true, entryId, rowId, enabled, changed: result.changed, needsRestart: !applied, patchPath })
    return
  }

  // 检查更新（git 通道）：用 git ls-remote 对比远端 HEAD 与本地 lockfile 锁定的 commit
  if (pathname === ROUTE_PREFIX + '/check-update') {
    const packageName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
    const repository = typeof body.repository === 'string' ? body.repository.trim() : ''
    if (!packageName) {
      sendError(res, 400, 'packageName 不能为空')
      return
    }
    // git 通道检测：有 repository 时对比远端 HEAD 与本地锁定 commit
    let git = null
    const repo = repoToGithub(repository)
    if (repo !== null) {
      const patchPath = findPatchPath(ctx)
      const profileDir = dirname(patchPath)
      const [remoteHead, localCommit] = await Promise.all([
        gitRemoteHead(repo.owner, repo.name),
        gitLocalCommit(profileDir, repo.owner, repo.name),
      ])
      git = {
        owner: repo.owner,
        name: repo.name,
        remoteHead,
        localCommit,
        hasUpdate: remoteHead !== null && localCommit !== null && remoteHead !== localCommit,
        // localCommit 为 null（link 依赖/本地安装）时无法对比，标注 unknown
        unknown: localCommit === null,
      }
    }
    // 安全审查：开启且检测到更新时，拉取新版本到隔离目录，与已装代码做文件级 diff，
    // 审查本次改动并附 diff（method: update-diff），报告包含本次改动的描述；
    // 审查后保留隔离目录（登记更新任务）——点「确认更新」直接从该环境安装，不再重新拉取/审查
    let review = null
    let updateJobId = null
    const hasUpdate = git !== null && git.hasUpdate === true
    if (body.review === true && hasUpdate) {
      let staged = null
      try {
        staged = await stagePackage(gitSpec(repo))
        review = await reviewUpdateDiff(ctx, installedPackageDir(dirname(findPatchPath(ctx)), packageName), staged.pkgDir, packageName)
      } catch (error) {
        review = { summary: '审查未能完成', risks: [], severity: 'low', verdict: 'caution', details: error instanceof Error ? error.message : String(error) }
      }
      if (staged !== null && review !== null) {
        updateJobId = createUpdateJob(packageName, repo, staged.jobDir, staged.pkgDir, review)
      } else if (staged !== null) {
        await rm(staged.jobDir, { recursive: true, force: true }).catch(() => {})
      }
    }
    sendJson(res, 200, { ok: true, packageName, git, review, updateJobId })
    return
  }

  // 安装插件（git 通道）
  if (pathname === ROUTE_PREFIX + '/install') {
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    const packageName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
    const review = body.review === true
    if (repo === '') {
      sendError(res, 400, 'git 通道安装需要 GitHub 仓库地址（owner/name）')
      return
    }
    try {
      const result = await installPlugin(ctx, { repo, packageName, review })
      sendJson(res, 200, result)
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // 确认安装：审查报告确认后迁移到 profile
  if (pathname === ROUTE_PREFIX + '/install/confirm') {
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (jobId === '') {
      sendError(res, 400, 'jobId 不能为空')
      return
    }
    try {
      const result = await confirmInstall(jobId)
      sendJson(res, 200, result)
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // 中断安装任务（拉取中/审查中/待安装均可；检查残留并清理，任务即刻消失）
  if (pathname === ROUTE_PREFIX + '/install/interrupt') {
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (jobId === '') {
      sendError(res, 400, 'jobId 不能为空')
      return
    }
    try {
      const result = await interruptInstall(jobId)
      sendJson(res, 200, result)
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // 更新已安装插件（git 通道；优先用检查更新保留的隔离目录直接安装，不重新拉取/审查）
  if (pathname === ROUTE_PREFIX + '/update') {
    const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : ''
    if (entryId === '') {
      sendError(res, 400, 'entryId 不能为空')
      return
    }
    try {
      const result = await updatePlugin(ctx, entryId,
        typeof body.repository === 'string' ? body.repository.trim() : '',
        typeof body.updateJobId === 'string' ? body.updateJobId.trim() : '')
      sendJson(res, 200, result)
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // 卸载插件（移除 insert 行 + pnpm remove）
  if (pathname === ROUTE_PREFIX + '/uninstall') {
    const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : ''
    if (entryId === '' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
    if (!entry) {
      sendError(res, 404, '没有名为 ' + entryId + ' 的插件条目')
      return
    }
    const moduleName = entry.options.name
    const rowId = rowIdOf(ctx, entryId)
    if (rowId === 'plugin-market') {
      sendError(res, 400, '不能卸载插件市场自身')
      return
    }
    if (isProtectedModule(moduleName)) {
      sendError(res, 403, moduleName + ' 属于宿主基础设施，禁止删除')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const patch = await readPatchState(patchPath)
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const isUserBundle = bundles.includes(moduleName) && !DEFAULT_BUNDLES.includes(moduleName)
    if (isLocalDependency(profileDir, moduleName)) {
      sendError(res, 400, moduleName + ' 为本地 link/file 安装的插件，不可通过插件市场卸载')
      return
    }
    if (patch.inserts.includes(rowId)) {
      // insert 行型插件：先 pnpm remove 移除依赖（失败则保留 insert 行，UI 可重试），成功后再移除 insert 行
      try {
        await pnpmRemove(profileDir, moduleName)
      } catch (err) {
        sendError(res, 500, '移除依赖失败：' + (err instanceof Error ? err.message : String(err)))
        return
      }
      await removeInsertRow(patchPath, rowId)
      await writeRepoOverride(moduleName, '')
      sendJson(res, 200, { ok: true, removed: 'entry', packageName: moduleName, restart: false })
      return
    }
    if (isUserBundle) {
      // bundle 型插件：先 pnpm remove 移除依赖（失败则保留 manifest，UI 可重试），成功后再移除 bundle 配置；
      // bundle 层启动时应用，运行时条目需重启 dsh web 才卸载
      try {
        await pnpmRemove(profileDir, moduleName)
      } catch (err) {
        sendError(res, 500, '移除依赖失败：' + (err instanceof Error ? err.message : String(err)))
        return
      }
      await removeBundleFromManifest(profileDir, moduleName)
      // 写临时禁用行让运行树立即卸载（HMR）——避免"文件已删、旧服务仍引用"导致页面启动报错；
      // 重启后 bundle 不再加载，该禁用行对不存在的条目无害；重装时会自动清理
      await disableEntry(patchPath, rowId)
      await writeRepoOverride(moduleName, '')
      sendJson(res, 200, { ok: true, removed: 'bundle', packageName: moduleName, restart: true })
      return
    }
    sendError(res, 400, '该插件不是用户安装的额外插件（不可删除）')
    return
  }

  // 查看已安装插件当前版本的审查报告：缓存命中直接返回（永久保留，不受 7 天 TTL/清理影响）；
  // 没有缓存则在已安装包目录现场生成（首次点击触发），生成后标记保留。
  if (pathname === ROUTE_PREFIX + '/review') {
    const { entryId } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    const target = ctx.loader.entries().find((entry) => entry.id === entryId)
    if (!target || typeof target.options.name !== 'string') {
      sendError(res, 404, '没有名为 ' + entryId + ' 的插件条目')
      return
    }
    const moduleName = target.options.name
    const meta = entryPkgMeta(moduleName, ctx.baseUrl ?? 'file:///')
    const version = meta?.version ?? null
    const key = reviewKey(moduleName, version)
    const cached = await readReviewFile(key)
    if (cached !== null && cached.report !== null && cached.report !== undefined) {
      if (cached.protected !== true) await markReviewProtected(key)
      sendJson(res, 200, { ok: true, entryId, moduleName, version, cached: true, report: cached.report })
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const pkgDir = installedPackageDir(profileDir, moduleName)
    try {
      await stat(pkgDir)
    } catch {
      sendError(res, 404, '插件包目录不存在：' + moduleName)
      return
    }
    // 并发去重：同一键的审查生成只跑一次（连点 / 双端同时触发时等待并复用同一结果）
    let pending = reviewInflight.get(key)
    if (pending === undefined) {
      pending = reviewPackage(ctx, pkgDir, moduleName, version, null, null)
      reviewInflight.set(key, pending)
      // 清理链吞掉拒绝（避免 unhandled rejection），原 promise 仍由 await 处处理
      pending.then(() => {}, () => {}).finally(() => {
        if (reviewInflight.get(key) === pending) reviewInflight.delete(key)
      })
    }
    let report = null
    try {
      report = await pending
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
      return
    }
    if (report === null || report === undefined) {
      // 审查通道不可用 / 包无可审查内容：给可见的 caution 报告而不是静默失败
      sendJson(res, 200, {
        ok: true, entryId, moduleName, version, cached: false,
        report: { summary: '审查未能完成（审查通道不可用或包内容为空）', risks: [], severity: 'low', verdict: 'caution', details: '可稍后重试。', method: 'none' },
      })
      return
    }
    await markReviewProtected(key)
    sendJson(res, 200, { ok: true, entryId, moduleName, version, cached: false, report })
    return
  }

  // 一键清理缓存：删除 1 小时之前的 staging 残留与审查报告
  if (pathname === ROUTE_PREFIX + '/cleanup') {
    try {
      const result = await cleanupCaches(ctx, 60 * 60 * 1000)
      sendJson(res, 200, result)
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // dsh 自更新状态（侧边栏状态灯）：返回已装/远端版本 + 判定
  if (method === 'GET' && pathname === ROUTE_PREFIX + '/dsh-version') {
    try {
      const state = dshStateCache ?? await checkDshUpdate(ctx)
      sendJson(res, 200, { ok: true, ...state })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // 强制重新检测 dsh 更新（点击绿灯/灰灯时手动重检）
  if (pathname === ROUTE_PREFIX + '/dsh-version/check') {
    try {
      const state = await checkDshUpdate(ctx)
      sendJson(res, 200, { ok: true, ...state })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // 点击状态灯：开启可见新会话，用默认模型分析升级内容与破坏性更新
  if (pathname === ROUTE_PREFIX + '/dsh-version/analyze') {
    const currentSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    try {
      const result = await analyzeDshUpdate(ctx, currentSessionId)
      sendJson(res, 200, result)
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  sendError(res, 404, '未知接口 ' + pathname)
}

/** 应用插件：注册 /plugin-market 路由。 */
export function apply(ctx) {
  void cleanupStagingAndReviews(ctx)
  // dsh 自更新检测：web 启动时一次 + 每 1 小时同步（随插件 dispose 清理定时器）
  ctx.effect(() => {
    void checkDshUpdate(ctx)
    const timer = setInterval(() => { void checkDshUpdate(ctx) }, DSH_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'plugin-market: dsh update check')
  ctx.effect(() => {
    const route = {
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
          sendError(res, 403, '仅允许本机访问')
          return
        }
        try {
          await handle(ctx, req, res)
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'plugin-market: routes')
}

/** 从 package.json 的 repository 字段解析 GitHub 仓库（owner/name/path），非 GitHub 返回 null。 */
function repoToGithub(rawRepo) {
  if (typeof rawRepo !== 'string' || rawRepo === '') return null
  try {
    return githubRepoInfo(rawRepo)
  } catch {
    return null
  }
}

/** git ls-remote 远端默认分支 HEAD commit（失败返回 null）。 */
async function gitRemoteHead(owner, name) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', 'https://github.com/' + owner + '/' + name + '.git', 'HEAD'], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    })
    const match = String(stdout).match(/^([0-9a-f]{40})\s+HEAD/mu)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * 读取本地 pnpm-lock.yaml 中该插件锁定的 git commit。
 * pnpm v9 对 git 依赖的记录格式：
 *   1) codeload tarball: @scope/pkg@https://codeload.github.com/owner/name/tar.gz/<commit>
 *   2) github#commit:   pkg@github:owner/name#<commit>
 * link: 依赖（本地路径安装）无 commit，返回 null。
 */
async function gitLocalCommit(profileDir, owner, name) {
  try {
    const lockText = await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const codeloadRe = new RegExp('codeload\\.github\\.com\\/' + escapeRegExp(owner) + '\\/' + escapeRegExp(name) + '\\/tar\\.gz\\/([0-9a-f]{40})', 'iu')
    const codeload = lockText.match(codeloadRe)
    if (codeload) return codeload[1]
    const githubRe = new RegExp('github:' + escapeRegExp(owner) + '\\/' + escapeRegExp(name) + '#([0-9a-f]{40})', 'iu')
    const github = lockText.match(githubRe)
    if (github) return github[1]
    return null
  } catch {
    return null
  }
}


