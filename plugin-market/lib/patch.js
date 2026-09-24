/**
 * 补丁层 / profile 的**只读视图**。
 *
 * 本文件原来服务于「插件市场」的补丁层写操作（启用/停用/insert/bundle/uninstall），
 * 那些功能已整体删除。现在只剩 harness 版本检测需要的读取能力：
 *   · findPatchPath    —— 定位当前 profile 的 cordis.patch.yml
 *   · readPatchState   —— 解析补丁层里的 disables / forced / inserts
 *   · listEntries      —— 运行树条目清单（含 fiber 状态与是否可开关）
 *   · entryPkgMeta     —— 包元信息（version/repository，60 秒 TTL 缓存）
 *   · isUserInstalled  —— 判断条目是否为用户安装的插件
 * 这里不做任何写入：不再 import 写文件相关 API，也没有写队列。
 */
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { githubRepoInfo } from './util.js'

/** 宿主基础设施行：这些模块不算用户安装的第三方插件。 */
const PROTECTED_MODULE_PATTERNS = [
  /^cordis:/u,
  /^@deepseek-ai\/cordis-plugin-/u,
  /^@deepseek-ai\/dsh-host-/u,
  /^@deepseek-ai\/dsh-client-modules$/u,
  /^@deepseek-ai\/dsh-client-connection$/u,
  /^@deepseek-ai\/dsh-client-hmr$/u,
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
 * 判断是否为用户安装的插件：
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

export { findPatchPath, readPatchState, listEntries, entryPkgMeta, isUserInstalled }
