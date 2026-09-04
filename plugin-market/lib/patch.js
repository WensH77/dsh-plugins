import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { escapeRegExp, githubRepoInfo, makeQueue, writeJsonFile } from './util.js'

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

/** 本地安装判定与路径解析（合一实现，避免重复读 manifest + lstat）：
 * link:/file: 依赖 spec 命中，或 node_modules 符号链接指向 profile 外 → 本地安装。
 * 本地安装的插件不可通过插件市场卸载/更新。返回 { local, spec, path }（非本地为 null）。 */
function localDependencyInfo(profileDir, moduleName) {
  let spec = null
  let linkPath = null
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const dep = manifest.dependencies?.[moduleName] ?? manifest.devDependencies?.[moduleName] ?? null
    if (typeof dep === 'string' && /^(?:link|file):/u.test(dep)) spec = dep
  } catch {}
  try {
    const target = join(profileDir, 'node_modules', ...(moduleName.startsWith('@') ? moduleName.split('/') : [moduleName]))
    const st = lstatSync(target)
    if (st.isSymbolicLink()) {
      const real = realpathSync(target)
      if (!real.startsWith(profileDir)) linkPath = real
    }
  } catch {}
  const local = spec !== null || linkPath !== null
  return { local, spec, path: spec ?? linkPath }
}

/** 判断插件是否为本地安装。 */
function isLocalDependency(profileDir, moduleName) {
  return localDependencyInfo(profileDir, moduleName).local
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

// ── 补丁层读写（与 dsh plugin CLI 语义一致） ────────────────────────────────

/** 写队列：串行化补丁文件写入，避免并发读写冲突。 */
const queuedWrite = makeQueue()

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
      await writeJsonFile(manifestPath, manifest)
      invalidateProfileManifest(profileDir)
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
      await writeJsonFile(manifestPath, manifest)
      invalidateProfileManifest(profileDir)
    }
  })
}

// ── profile manifest 读取缓存（/state 与 /uninstall 读 package.json 的统一入口） ─────

/** profile 根 package.json 读取缓存（bundles/dependencies 展示用）：60 秒 TTL。
 *  写路径（addBundleToManifest/removeBundleFromManifest/pnpm 安装卸载）会主动失效对应键，
 *  保证安装/卸载后立即刷新；pnpm/CLI 的外部写入只靠 TTL 兜底（60 秒内可能显示旧值）。 */
const profileManifestCache = new Map()

const PROFILE_MANIFEST_TTL = 60 * 1000

/** 读取 profileDir/package.json；缺失/损坏返回 null（读失败不缓存，下次重试磁盘）。 */
async function readProfileManifest(profileDir) {
  const hit = profileManifestCache.get(profileDir)
  if (hit !== undefined && Date.now() - hit.at < PROFILE_MANIFEST_TTL) return hit.manifest
  let manifest = null
  try {
    manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  } catch {}
  if (manifest !== null) profileManifestCache.set(profileDir, { at: Date.now(), manifest })
  return manifest
}

/** 失效 profile manifest 缓存：package.json 被写路径改动后调用，让后续读取立即看到新值。 */
function invalidateProfileManifest(profileDir) {
  profileManifestCache.delete(profileDir)
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

/** 移除一条「- id: X」+「disabled: true」禁用块（重装 bundle 时清理卸载留下的临时禁用行）。 */
async function removeDisableBlock(patchPath, id) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const blockRe = new RegExp('^- id: ' + escapeRegExp(id) + '\r?\n  disabled: true\r?\n', 'mu')
    if (blockRe.test(text)) await writeFile(patchPath, text.replace(blockRe, ''), 'utf8')
  })
}

export { findPatchPath, readPatchState, stripEmptyArrayMarker, disableBlock, disableEntry, enableEntry, appendInsert, removeInsertRow, addBundleToManifest, removeBundleFromManifest, detectBundleOnly, deriveEntryId, rowIdOf, listEntries, entryPkgMeta, pkgMetaCache, isProtectedModule, isUserInstalled, isPluginInstalled, localDependencyInfo, isLocalDependency, readProfileManifest, invalidateProfileManifest, removeDisableBlock, DEFAULT_BUNDLES }