import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { errMsg, escapeRegExp, githubRepoInfo, makeQueue, writeJsonFile } from './util.js'

/** 宿主基础设施行：停用会连带破坏 HMR/传输/存储/设置链，禁止开关。 */
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

/** 行首缩进宽度（tab 记 1；只用于比较层级，不追求视觉列宽）。 */
function lineIndent(line) {
  const match = line.match(/^[ \t]*/u)
  return match === null ? 0 : match[0].length
}

const KEY_HEAD_RE = /^(?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^:\s][^:]*):(?:\s|$)/u

/**
 * 兜底结构校验：文本是否「看起来是顶层 YAML 数组」。
 *
 * 只在拿不到真解析器时使用（见 parseWithYaml），所以它必须**几乎不误报**，
 * 同时仍要拦住真实出过的那类破坏——`- insert:` 块头被删、块内续行留在顶层：
 *       `      disabled: true`   ← 顶层出现缩进内容 → dsh 报
 *                                    "end of the stream or a document separator is expected"
 *
 * 模型：逐行产出「状态 token」，再要求缩进路径合法。
 *   · `- `（或有内容）→ `item:<缩进>`；裸 `-` → `item:<缩进>+`（允许带子内容）
 *   · `key:`           → `key:<缩进>`；`- key:`（块条目 + 行首键）额外产出 `key:<缩进>+2`
 * 合法缩进只允许两种来源：出现在 token 列表里，或出现在「所有祖先缩进的 +2 集合」里；
 * 后者要求上一行是 key（键的值子树）；若上一行 key 恰好是「行内键」（`- id: x`），
 * 则新缩进必须是 key 缩进（`- id:` 下的 `  disabled:`，YAML 里与 id 同属一个映射）。
 */
function isTopLevelArrayText(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line !== '' && !line.trimStart().startsWith('#'))
  // 空 patch 层：只有 `[]`（dsh 初始化 profile 的写法）
  if (lines.length > 0 && lines.every((line) => /^\[\s*\]\s*(?:#.*)?$/u.test(line.trim()))) return lines.length === 1
  /** 出现过的缩进（序列条目或映射键所在层级）。 */
  const indents = new Set([0])
  /** 出现过的「映射键的值」缩进：行内键（`- id: x`）的值必须落在其中。 */
  const valueIndents = new Set()
  /** 上一行状态：type = item | key | itemKey。 */
  let prev = { type: null, indent: -1 }
  for (const line of lines) {
    const indent = lineIndent(line)
    const body = line.slice(indent)
    if (body.startsWith('[') || body.startsWith('{')) return false // flow 写法不在本文件范围内
    const item = /^-(?:\s|$)/u.test(body)
    if (indent === 0 && !item) return false // 顶层必须是序列条目
    const afterDash = item ? body.replace(/^-[ \t]*/u, '') : ''
    const keyHead = KEY_HEAD_RE.test(item ? afterDash : body)
    // 新缩进只能来自「上一行是键 → 进其值」，或「上一行是裸 - → 进其内容」；
    // 行内键（`- id: x`）的值必须回到该键自身缩进（同层兄弟键），否则就是无主缩进。
    if (!indents.has(indent)) {
      const opensValue = prev.type === 'key' || prev.type === 'itemKey'
      if (!opensValue && prev.type !== 'item') return false
      if (prev.type === 'itemKey' && valueIndents.has(indent) && !(keyHead && indent === prev.indent)) return false
      indents.add(indent)
    }
    if (item && afterDash === '') prev = { type: 'item', indent }
    else if (item && keyHead) {
      indents.add(indent + 2) // `- key:` 的值通常缩进 +2
      valueIndents.add(indent + 2)
      prev = { type: 'itemKey', indent }
    } else if (keyHead) {
      valueIndents.add(indent + 2)
      prev = { type: 'key', indent }
    } else prev = { type: 'item', indent }
  }
  return true
}

/** PATH 上的 dsh 入口（拿它作解析基准，才能找到宿主安装目录里的 `yaml`）。找不到返回空数组。 */
function dshEntryCandidates() {
  const found = []
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of output.split(/\r?\n/u)) {
      const entry = line.trim()
      if (entry === '' || !existsSync(entry)) continue
      try {
        found.push(realpathSync(entry))
      } catch {}
    }
  } catch {}
  return found
}

/**
 * 定位并使用 YAML 解析器（用于校验即将写出的 patch 层）。
 *
 * 插件本身零依赖，但宿主一定装了 YAML：dsh-app-boot 就是用 `yaml` 解析所有
 * cordis.patch.yml（bundle 层与用户 profile 同一套解析器）。运行时从进程入口
 * （`process.argv[1]`，即 dsh CLI）等位置解析，拿到就用**真解析器**校验；拿不到
 * 则退化为结构检查——宁可退化，也不能因此拒绝服务。
 */
let yamlParse = null
let yamlProbed = false

function parseWithYaml(text) {
  if (!yamlProbed) {
    yamlProbed = true
    // 解析基准：进程入口（就是 dsh CLI）→ PATH 上的 dsh（真实安装位置）→ 本模块 / profile 目录
    const bases = [process.argv[1]]
    for (const candidate of dshEntryCandidates()) bases.push(candidate)
    bases.push(fileURLToPath(import.meta.url), join(homedir(), '.dsh', 'profiles'))
    for (const base of bases) {
      if (typeof base !== 'string' || base === '') continue
      for (const from of ['yaml', 'js-yaml']) {
        try {
          const module = createRequire(base)(from)
          const parse = typeof module.parse === 'function' ? module.parse : module.load
          if (typeof parse === 'function') {
            yamlParse = (value) => parse(value)
            break
          }
        } catch {}
      }
      if (yamlParse !== null) break
    }
  }
  if (yamlParse === null) return null // 没有解析器 → 交给结构检查
  try {
    return yamlParse(text)
  } catch {
    return false // 解析失败：文件非法
  }
}

/**
 * 写出前判定：文本是否是 dsh 能接受的 patch 层（顶层 YAML 数组）。
 * 首选真解析器（与 dsh 启动时同一套语义），拿不到解析器时退化为结构检查。
 */
function isValidPatchText(text) {
  const parsed = parseWithYaml(text)
  return parsed === null ? isTopLevelArrayText(text) : Array.isArray(parsed)
}

/**
 * 写补丁层文件：写前对内容做「顶层数组」自检，自检失败一律不写入。
 *
 * 回滚语义（为什么不是「写完发现坏了再回滚」）：自检是纯函数，写前就能判定，
 * 所以坏内容根本不会落盘——原本已经损坏的文件也不会被写得更坏。坏内容下返回
 * `{ ok: false }`，由调用方决定是告警还是报错。这样最坏结果是「这次操作没生效」，
 * 不会升级成「整个 harness 起不来」。
 */
async function writePatchFile(patchPath, text) {
  if (!isValidPatchText(text)) return { ok: false, reason: '写出内容不是合法的顶层 YAML 数组（已跳过写入，原文件未改动）' }
  try {
    await writeFile(patchPath, text, 'utf8')
  } catch (error) {
    return { ok: false, reason: '写入失败：' + errMsg(error) }
  }
  return { ok: true }
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

/** 追加式写入的公共前缀：剔除空层 `[]` 标记并补齐结尾换行（追加内容直接拼在后面）。 */
function appendBase(text) {
  const base = stripEmptyArrayMarker(text)
  return base.length === 0 || base.endsWith('\n') ? base : base + '\n'
}

async function disableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, text } = await readPatchState(patchPath)
    if (disables.includes(id)) return { changed: false }
    const result = await writePatchFile(patchPath, appendBase(text) + disableBlock(id))
    if (!result.ok) console.warn('dsh-plugin-market: 停用 ' + id + ' 未写入补丁层——' + result.reason)
    return { changed: result.ok }
  })
}

async function enableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, forced, text } = await readPatchState(patchPath)
    const blockRe = new RegExp('^- id: ' + escapeRegExp(id) + '\\r?\\n  disabled: true\\r?\\n', 'mu')
    if (blockRe.test(text)) {
      const result = await writePatchFile(patchPath, text.replace(blockRe, ''))
      if (!result.ok) console.warn('dsh-plugin-market: 启用 ' + id + ' 未写入补丁层——' + result.reason)
      return { changed: result.ok }
    }
    if (forced.includes(id)) return { changed: false }
    const result = await writePatchFile(patchPath, appendBase(text) + '- id: ' + id + '\n  disabled: false\n')
    if (!result.ok) console.warn('dsh-plugin-market: 启用 ' + id + ' 未写入补丁层——' + result.reason)
    return { changed: result.ok }
  })
}

/** 追加一条 insert 启用行（插件包需已安装到 profile）。 */
async function appendInsert(patchPath, entryId, packageName) {
  return queuedWrite(async () => {
    const { inserts, text } = await readPatchState(patchPath)
    if (inserts.includes(entryId)) return { changed: false }
    const block = '- insert:\n    - id: ' + entryId + '\n      name: \'' + packageName + '\'\n'
    const result = await writePatchFile(patchPath, appendBase(text) + block)
    if (!result.ok) console.warn('dsh-plugin-market: 安装 ' + entryId + ' 未写入补丁层——' + result.reason)
    return { changed: result.ok }
  })
}


/**
 * 定位 `- insert:` 块里某个条目的「行区间」：目标行 `    - id: X` 本身，加上其后所有
 * 缩进更深的续行（`name:` / `config:` / `disabled:` …）。
 *
 * 匹配条件二选一：`rowId` 对上条目 id，或 `matchName` 对上条目里的 `name:`——后者是
 * bundle 卸载/重装场景的关键：bundle 的条目 id 由**它自己的** cordis.patch.yml 声明
 *（如 `better-sidebar`），与包名（`dsh-better-sidebar`）不同，重装时只拿得到包名，
 * 只能按 `name:` 找回当初写下的禁用行。
 *
 * 按行处理而不是拿正则整段匹配：patch 层是行结构的文件，缩进就是层级。历史上正是因为
 * 「只吃固定 3 行」而把块内第 4 行起留在顶层，写出非法 YAML、让 dsh 整树起不来。
 * 返回 `{ lines, start, end, insertIndex }`，`end` 为区间后一行的下标（开区间）；
 * 找不到返回 null。
 */
function insertRowRange(text, rowId, matchName = null) {
  const lines = text.split(/\r?\n/u)
  const target = rowId === null ? null : new RegExp('^ {4}- id: ' + escapeRegExp(rowId) + '(?:[ \\t]|$)', 'u')
  const targetName = matchName === null || matchName === '' ? null : matchName
  /** 一个条目的区间：起始行 + 其后所有更深的续行。 */
  const endOf = (start) => {
    let end = start + 1
    while (end < lines.length && /^[ \t]/u.test(lines[end])) end += 1
    return end
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '- insert:') continue
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.startsWith('    - id: ')) {
        if (target !== null && target.test(line)) return { lines, start: cursor, end: endOf(cursor), insertIndex: index }
        // 按 id 没对上时，继续看本条目的续行里有没有 `name: <包名>`
        if (targetName !== null) {
          const end = endOf(cursor)
          for (let probe = cursor + 1; probe < end; probe += 1) {
            if (new RegExp('^ {6}name:[ \\t]*[\'"]?' + escapeRegExp(targetName) + '[\'"]?[ \\t]*$', 'u').test(lines[probe])) {
              return { lines, start: cursor, end, insertIndex: index }
            }
          }
          cursor = end - 1
          continue
        }
        continue // 该块是别的条目，继续在本块里找（一个块可以有多个条目）
      }
      if (!/^[ \t]/u.test(line)) break // 本块结束 → 换下一个 `- insert:` 块
    }
  }
  return null
}

/**
 * 移除一条 insert 行（卸载时用），连同块内全部续行与其顶层 disabled 覆盖块。
 *
 * 关键：`- insert:` 块内除了 `id` / `name` 之外还可能有任意多行（`config:`、`disabled:`
 * 等）。只吃前三行会把块内剩余缩进行留在顶层，写出非法 YAML 并让 dsh 整树启动失败。
 */
async function removeInsertRow(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    let next = text
    const range = insertRowRange(text, rowId)
    if (range !== null) {
      const kept = [...range.lines.slice(0, range.start), ...range.lines.slice(range.end)]
      // 块里只剩块头（`- insert:` 后面没有条目）时把块头一并删掉，别留空块
      const head = kept[range.insertIndex]
      if (head === '- insert:' && !(kept[range.insertIndex + 1] ?? '').startsWith('    - id: ')) {
        kept.splice(range.insertIndex, 1)
      }
      next = kept.join('\n')
    }
    const overrideRe = new RegExp('^- id: ' + escapeRegExp(rowId) + '\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n', 'mu')
    next = next.replace(overrideRe, '')
    if (next === text) return { changed: false }
    const result = await writePatchFile(patchPath, next)
    if (!result.ok) console.warn('dsh-plugin-market: 卸载 ' + rowId + ' 未写入补丁层——' + result.reason)
    return { changed: result.ok }
  })
}

/** 目标行内已有的 `disabled:` 键（块风格键值对，或行内映射 `{...}` 里的成员）。 */
const DISABLED_INLINE_RE = /(^|\s)disabled:(?:\s+(?:true|false))?(?=[\s}]|$)/u
const DISABLED_LINE_RE = /^disabled:/u // 配合 trimStart() 判断整行是否只有 disabled 键

/**
 * 在既有 `- insert:` 块的目标条目上写入 `disabled: true`（bundle 卸载时用）。
 *
 * 为什么不像以前那样另写一条顶层 `- id: X / disabled: true`：那条禁用行的 id 是
 * **运行树行 id**（bundle 自己在 cordis.patch.yml 里声明的，如 `better-sidebar`），
 * 而重装时的清理（install.js 的 removeDisableBlock）只有包名和按包名推导的
 * entryId 两个口径（如 `dsh-better-sidebar`）——两边永远对不上，禁用行清不掉，
 * 重装后插件被静默禁用。写进 insert 条目内则天然跟随该条目：重装 appendInsert、
 * 卸载 removeInsertRow 都会连带处理它。
 *
 * 目标条目不在 insert 块里时返回 `{ changed: false, reason: 'no-insert-row' }`，
 * 由调用方决定回退（写顶层禁用行）。
 */
async function disableInsertRow(patchPath, rowId) {
  return queuedWrite(async () => {
    const { inserts, text } = await readPatchState(patchPath)
    if (!inserts.includes(rowId)) return { changed: false, reason: 'no-insert-row' }
    const range = insertRowRange(text, rowId)
    if (range === null) return { changed: false, reason: 'no-insert-row' }
    // 去掉已有的 disabled（行内键或独立行），再统一补一条 6 空格缩进的独立行 → 幂等
    const body = range.lines.slice(range.start, range.end).filter((line) => !DISABLED_LINE_RE.test(line.trimStart()))
    const rowLine = body[0].replace(DISABLED_INLINE_RE, '$1').replace(/[ \t]+$/u, '')
    const next = [...range.lines.slice(0, range.start), rowLine, ...body.slice(1), '      disabled: true', ...range.lines.slice(range.end)].join('\n')
    if (next === text) return { changed: false }
    const result = await writePatchFile(patchPath, next)
    if (!result.ok) console.warn('dsh-plugin-market: 停用 ' + rowId + ' 未写入补丁层——' + result.reason)
    return { changed: result.ok }
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

/**
 * 读取一个已安装 bundle 在自己 `cordis.patch.yml` 里声明的行 id 列表。
 *
 * 卸载 bundle 时写的临时禁用行用的是**运行树行 id**（就是这个声明值，如 `better-sidebar`），
 * 与包名（`dsh-better-sidebar`）不是一回事；重装时只拿得到包名，得从这里把声明的 id 读回来，
 * 才清得掉当初写下的禁用行。读不到（包已不在、无 patch 文件）返回空数组。
 */
async function bundleRowIds(profileDir, packageName) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const pkgPath = require.resolve(packageName + '/package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return []
    const patchFile = join(dirname(pkgPath), patchRel)
    const text = await readFile(patchFile, 'utf8')
    const ids = []
    for (const line of text.split(/\r?\n/u)) {
      const matched = line.match(/^\s*(?:-\s*)?id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/u)
      if (matched !== null && !ids.includes(matched[1])) ids.push(matched[1])
    }
    return ids
  } catch {
    return []
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

/**
 * 移除一条「- id: X」+「disabled: true」禁用块（重装 bundle 时清理卸载留下的临时禁用行）。
 *
 * 同时清理写进 `- insert:` 条目内的 `disabled: true`（disableInsertRow 的产物）。这里必须
 * 兼顾两套 id 口径：写禁用行时用的是**运行树行 id**（bundle 自己声明的，如
 * `better-sidebar`），而重装时 install.js 只拿得到**包名**与按包名推导的 entryId
 *（如 `dsh-better-sidebar`）——两边对不上就会留下 stale 禁用行、插件重装后被静默禁用。
 * 因此 `packageName` 允许再按 insert 条目里的 `name:` 匹配一次。
 */
async function removeDisableBlock(patchPath, id, packageName = null) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    let next = text
    // 标准形态：顶层 `- id: X` + `  disabled: true`
    const blockRe = new RegExp('^- id: ' + escapeRegExp(id) + '\r?\n  disabled: true\r?\n', 'mu')
    next = next.replace(blockRe, '')
    // disableInsertRow 的产物：disabled 写在 insert 条目内，按行把该条目的 disabled 行摘掉，
    // 其余续行保持原样。先按 id 找，再按 name（包名）找。
    const range = insertRowRange(next, id, packageName)
    if (range !== null) {
      const kept = range.lines.slice(range.start, range.end).filter((line) => !DISABLED_LINE_RE.test(line.trimStart()))
      next = [...range.lines.slice(0, range.start), ...kept, ...range.lines.slice(range.end)].join('\n')
    }
    if (next === text) return { changed: false }
    const result = await writePatchFile(patchPath, next)
    if (!result.ok) console.warn('dsh-plugin-market: 清理 ' + id + ' 的禁用行未写入补丁层——' + result.reason)
    return { changed: result.ok }
  })
}

/** 补丁层写入/自检结果与「顶层数组」自检本身导出给测试用。 */
export { findPatchPath, readPatchState, stripEmptyArrayMarker, disableBlock, disableEntry, enableEntry, appendInsert, removeInsertRow, disableInsertRow, isTopLevelArrayText, isValidPatchText, addBundleToManifest, removeBundleFromManifest, detectBundleOnly, bundleRowIds, deriveEntryId, rowIdOf, listEntries, entryPkgMeta, pkgMetaCache, isProtectedModule, isUserInstalled, isPluginInstalled, localDependencyInfo, isLocalDependency, readProfileManifest, invalidateProfileManifest, removeDisableBlock, DEFAULT_BUNDLES }