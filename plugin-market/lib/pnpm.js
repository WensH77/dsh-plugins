import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execEnv, escapeRegExp, execFileAsync, makeQueue } from './util.js'
import { invalidateProfileManifest } from './patch.js'

// ── pnpm 发现与调用 ────────────────────────────────────────────────────────

/**
 * 隔离目录的 pnpm 设置：必须与 dsh initProfile 为真实 profile 写的
 * pnpm-workspace.yaml 一致。缺了它，pnpm 会退回默认 auto-install-peers=true，
 * 于是去 registry 解析插件声明的 peer 及其传递闭包——而 @deepseek-ai/dsh-* 全系
 * 只发预发布版（latest 停在旧的 0.0.1-rc.1，实际在用的是 next/alpha 标签），
 * 归并出的 ^0.1.x 之类范围匹配不到任何版本，拉取阶段直接 ERR_PNPM_NO_MATCHING_VERSION。
 * 插件本身能否运行由宿主的 profiles/node_modules 回退链决定，与此处解析无关。
 */
const STAGING_PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** 找到可用的 pnpm 启动方式：corepack → PATH pnpm → npx 缓存 pnpm。 */
function resolvePnpm() {
  const candidates = []
  candidates.push({ bin: 'corepack', args: ['pnpm'] })
  candidates.push({ bin: 'pnpm', args: [] })
  try {
    const npxRoot = join(homedir(), '.npm', '_npx')
    if (existsSync(npxRoot)) {
      const entries = readdirSync(npxRoot)
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
const queuedPnpm = makeQueue()

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
              env: execEnv({ CI: 'true' }),
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

/**
 * 运行 pnpm（串行化 + 瞬时失败重试 + 结果带 stderr）：
 *  - 追加 pnpm 自身 fetch 重试与 prefer-offline 参数，命中 store 缓存时快且稳；
 *  - 瞬时错误（网络/超时/锁）自动重试一次（间隔 1.5s）；
 *  - 最终错误带上 pnpm 的 stderr 尾部，便于定位真实原因。
 */
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
            const pnpmEnv = execEnv()
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

/** pnpm add：profile 是 workspace 根，必须加 -w 才能在根 package.json 安装。
 *  成功后失效 profile manifest 缓存（/state 等读取方立即看到新依赖，而不是等 60s TTL）。 */
async function pnpmInstall(profileDir, spec, onProgress = null) {
  await runPnpm(profileDir, ['add', '-w', spec], 180000, undefined, false, 0, onProgress)
  invalidateProfileManifest(profileDir)
}

/** pnpm remove：成功后失效 profile manifest 缓存（卸载后 /state 不再显示旧依赖）。 */
async function pnpmRemove(profileDir, packageName) {
  await runPnpm(profileDir, ['remove', packageName])
  invalidateProfileManifest(profileDir)
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

/** git ls-remote 远端默认分支 HEAD commit。返回 { head, error }：
 *  失败时 head=null 且 error 携带面向用户的网络错误说明（客户端在卡片上持续显示）。 */
async function gitRemoteHead(owner, name) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', 'https://github.com/' + owner + '/' + name + '.git', 'HEAD'], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: execEnv(),
    })
    const match = String(stdout).match(/^([0-9a-f]{40})\s+HEAD/mu)
    return { head: match ? match[1] : null, error: null }
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    const reason = (stderr || String(error?.message ?? error) || 'git ls-remote 失败').slice(0, 160)
    return { head: null, error: '网络错误：无法从 GitHub 拉取最新提交（' + reason + '），请检查网络后重试' }
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

export { STAGING_PNPM_WORKSPACE, progressFromPnpm, runPnpm, pnpmInstall, pnpmRemove, gitRemoteHead, gitLocalCommit }