import { readFile, writeFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

// ── 通用小工具 ──────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

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

/** 错误对象 → 用户可读消息（全文件统一的错误转字符串样板）。 */
function errMsg(error) {
  return error instanceof Error ? error.message : String(error)
}

/** git/pnpm 子进程公共环境：禁止 git 交互式凭据提示（超时与网络错误由调用方兜底）。 */
function execEnv(extra = {}) {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...extra }
}

/** 递归强制删除并吞错（清理临时/隔离目录的统一样板；仅删单个文件请直接 rm + force 不递归）。 */
async function rmrf(target) {
  await rm(target, { recursive: true, force: true }).catch(() => {})
}

/** 读 JSON 文件；文件缺失/损坏/解析失败返回 fallback（~/.dsh 状态文件的统一读取骨架）。 */
async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 写 JSON 文件：2 空格缩进 + 结尾换行（与全库所有状态文件一致）。 */
async function writeJsonFile(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
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

/** 互斥队列工厂：串行化同类异步操作（同一 profile / store 并发会锁冲突，状态文件读改写会交错）。 */
function makeQueue() {
  let chain = Promise.resolve()
  return function queued(task) {
    const run = chain.then(task, task)
    chain = run.then(() => {}, () => {})
    return run
  }
}

/** 完整 semver 比较：major.minor.patch 数值逐段 + 预发布标识符逐段比较
 * （数值段按数值、字母段按字典序、数字段 < 字母段、有预发布 < 无预发布）；
 * 支持 alpha.N / rc.N 等任意预发布标识。返回 1/-1/0。 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v))
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
  const as = pa.pre.split('.')
  const bs = pb.pre.split('.')
  const n = Math.max(as.length, bs.length)
  for (let i = 0; i < n; i += 1) {
    if (i >= as.length) return -1
    if (i >= bs.length) return 1
    const x = as[i]
    const y = bs[i]
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx > dy ? 1 : -1
      continue
    }
    if (xn) return -1 // 数字标识符 < 字母标识符
    if (yn) return 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
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

export { execFileAsync, isLoopback, sendJson, sendError, errMsg, execEnv, rmrf, readJsonFile, writeJsonFile, collectBody, escapeRegExp, githubRepoInfo, gitSpec, makeQueue, compareVersions, repoToGithub }