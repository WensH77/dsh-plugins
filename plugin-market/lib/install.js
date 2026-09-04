import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { errMsg, githubRepoInfo, gitSpec, makeQueue, readJsonFile, rmrf, writeJsonFile } from './util.js'
import { addBundleToManifest, appendInsert, deriveEntryId, detectBundleOnly, entryPkgMeta, findPatchPath, isPluginInstalled, isProtectedModule, listEntries, pkgMetaCache, readPatchState, removeDisableBlock } from './patch.js'
import { pnpmInstall, progressFromPnpm, runPnpm, STAGING_PNPM_WORKSPACE } from './pnpm.js'
import { buildHarnessContext, buildL0FallbackReport, buildSignalBlocks, installedReviewKeys, PROMPT_CAP, readReviewFile, reviewKey, reviewPackage, REVIEWS_DIR, REVIEW_TTL_DAYS, runReviewChannel, scanRiskSurface, shouldRetainReview, waitForInsertApplied, writeReviewCache } from './review.js'

const SOURCES_FILE = join(homedir(), '.dsh', 'plugin-market-sources.json')

/** 插件来源仓库记录：{ packageName: repoString }，安装时自动写入用户填写的仓库（拉取来源），供展示与 git 通道检查/更新。 */
const REPOS_FILE = join(homedir(), '.dsh', 'plugin-market-repos.json')

/** 隔离审查目录：先拉取到此处审查，通过后再迁移到 profile。 */
const STAGING_DIR = join(homedir(), '.dsh', 'plugin-market-staging')

/** 更新后待重启 / 更新失败标记文件：{ [moduleName]: { kind: 'update'|'failed-update', error?, at } }。
 * 更新成功落盘 → kind:'update'（运行树仍是旧代码，需重启加载新版本）；
 * 更新失败 → kind:'failed-update' + error（可能处于半更新状态，卡片持续提示直到重试成功/卸载/重启）。 */
const PENDING_FILE = join(homedir(), '.dsh', 'plugin-market-pending.json')

// ── GitHub 源列表持久化 ─────────────────────────────────────────────────────

async function readSources() {
  const parsed = await readJsonFile(SOURCES_FILE, [])
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
}

async function writeSources(list) {
  const clean = Array.from(new Set(list.filter((item) => typeof item === 'string' && item.trim() !== '')))
  await writeJsonFile(SOURCES_FILE, clean)
  return clean
}

/** 读取插件来源仓库记录（packageName → repo 字符串；安装时自动保存，卸载时清除）。 */
async function readRepoOverrides() {
  const parsed = await readJsonFile(REPOS_FILE, {})
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
}

/** 写入单个插件的来源仓库；repository 为空串表示清除记录（卸载时调用）。安装时自动保存。 */
async function writeRepoOverride(packageName, repository) {
  const overrides = await readRepoOverrides()
  const clean = typeof repository === 'string' ? repository.trim() : ''
  if (clean === '') delete overrides[packageName]
  else overrides[packageName] = clean
  await writeJsonFile(REPOS_FILE, overrides)
  return overrides[packageName] ?? null
}

// ── 更新后待重启 / 更新失败标记（持久化；dsh web 重启时清空） ───────────────────

/** 状态文件（pending 标记 / dsh 判定）读写队列：read-modify-write 串行化，
 *  避免并发更新完成/卸载/重启清理交错导致标记静默丢失或半截 JSON。 */
const queuedStateFile = makeQueue()

/** 读取全部标记：{ [moduleName]: { kind, error?, at } }。 */
async function readPendingMarkers() {
  const parsed = await readJsonFile(PENDING_FILE, {})
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const out = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && typeof value === 'object') {
        out[key] = {
          kind: value.kind === 'failed-update' ? 'failed-update' : 'update',
          error: typeof value.error === 'string' ? value.error : null,
          at: Number(value.at) || 0,
          helpSessionId: typeof value.helpSessionId === 'string' ? value.helpSessionId : null,
        }
      }
    }
    return out
  }
  return {}
}

/** 写入单个插件的标记（更新成功 → kind:'update'；更新失败 → kind:'failed-update' + error）。
 *  read-modify-write 经状态文件队列串行化，避免并发更新交错丢标记。 */
async function writePendingMarker(moduleName, marker) {
  return queuedStateFile(async () => {
    const markers = await readPendingMarkers()
    markers[moduleName] = { ...marker, at: Number(marker.at) || Date.now() }
    await writeJsonFile(PENDING_FILE, markers)
  })
}

/** 清除单个插件的标记（卸载时调用）。 */
async function clearPendingMarker(moduleName) {
  return queuedStateFile(async () => {
    const markers = await readPendingMarkers()
    if (!Object.prototype.hasOwnProperty.call(markers, moduleName)) return
    delete markers[moduleName]
    await writeJsonFile(PENDING_FILE, markers)
  })
}

/** 清空全部标记（dsh web 启动时调用：重启后运行树已加载最新代码，待重启/失败提示不再适用）。 */
async function clearAllPendingMarkers() {
  return queuedStateFile(async () => {
    try { await writeJsonFile(PENDING_FILE, {}) } catch {}
  })
}

// ── 安装 / 更新通道 ─────────────────────────────────────────────────────────

/** 适配的 dsh 最佳版本：基于该版本开发，其它版本可能不兼容。 */
const DSH_BEST_FIT_VERSION = '0.1.2-alpha.4'

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

// ── 检查更新 / 审查实时进度（/state 返回，客户端 1s 轮询展示） ──────────────────

/** 进度记录：key = check:<包名>（检查更新）/ review:<entryId>（点击卡片审查）。
 *  value = { stage: 'git'|'pulling'|'scanning'|'reviewing'|'aggregating', percent?, files?, signals?, updatedAt } */
const checkProgress = new Map()

function setCheckProgress(key, value) {
  const now = Date.now()
  // 懒清理：5 分钟前的过期进度（请求崩溃/中断残留）
  for (const [k, v] of checkProgress) {
    if (now - v.updatedAt > 300000) checkProgress.delete(k)
  }
  checkProgress.set(key, { ...value, updatedAt: now })
}

function clearCheckProgress(key) {
  checkProgress.delete(key)
}

function snapshotCheckProgress() {
  const out = {}
  for (const [key, value] of checkProgress) {
    out[key] = { stage: value.stage, percent: value.percent ?? null, files: value.files ?? null, signals: value.signals ?? null }
  }
  return out
}

/** 中断安装任务：abort 进行中的拉取/审查，检查残留并清理，任务即刻从队列消失。 */
async function interruptInstall(jobId) {
  const job = installJobs.get(jobId)
  if (!job) return { ok: true, cancelled: true }
  installJobs.delete(jobId)
  job.status = 'cancelled'
  job.abort.abort()
  await rmrf(job.staged?.jobDir)
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
      error: job.error ?? null,
      helpSessionId: job.helpSessionId ?? null,
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
  const { repo, packageName, review, routeOverride } = options
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
      await rmrf(job.staged?.jobDir)
      throw new Error('安装已中断')
    }
    // 拉取失败：任务挂起为 pending，报告标注原因，用户可中断清理
    job.status = 'pending'
    job.error = errMsg(error)
    job.review = { summary: '拉取失败，未能安装', risks: [], severity: 'low', verdict: 'caution', details: job.error }
    return { ok: true, pending: true, jobId: job.id, packageName: job.name, review: job.review }
  }

  // 重复安装防护（拉取成功、包名确定后）：已安装 / 其它任务同包名进行中 → 拒绝并清理
  if (await isPluginInstalled(ctx, patch, job.name, profileDir)) {
    installJobs.delete(job.id)
    await rmrf(job.staged?.jobDir)
    throw new Error('插件 ' + job.name + ' 已安装，请勿重复安装（如需升级请使用「检查更新」）')
  }
  for (const other of installJobs.values()) {
    if (other.id === job.id || other.status === 'cancelled' || other.status === 'done') continue
    if (other.name === undefined || other.name === null || other.name === '') continue
    if (other.name === job.name) {
      installJobs.delete(job.id)
      await rmrf(job.staged?.jobDir)
      throw new Error('插件 ' + job.name + ' 正在安装中，请勿重复安装')
    }
  }

  // 安全审查关闭：直接安装（staged 已拉取，安装时顺带清理隔离目录）。
  // 注意：review 由 routes /install 归一为布尔（body.review === true），
  // 此处用 !== true 保守写法（防 undefined/其它真值），语义与调用方一致，无取反。
  if (review !== true) {
    job.status = 'installing'
    try {
      const result = await performInstall({ repoInfo: job.repoInfo, name: job.name, profileDir: job.profileDir, patchPath: job.patchPath, taken: job.taken, staged: job.staged, job, ctx })
      job.status = 'done'
      installJobs.delete(job.id)
      return { ...result, review: null }
    } catch (error) {
      // 保留失败任务在列表（供「帮我安装」/中断操作），只清理隔离目录
      job.status = 'failed'
      job.error = errMsg(error)
      await rmrf(job.staged?.jobDir)
      job.staged = null
      throw error
    }
  }

  // 安全审查开启：审查 → 挂起等待确认
  job.status = 'reviewing'
  try {
    job.review = await reviewPackage(ctx, job.staged.pkgDir, job.staged.pkgName, null, job.abort.signal, (stage, data) => { job.stage = stage; if (data) job.scan = data }, routeOverride)
    if (job.abort.signal.aborted) throw new Error('安装已中断')
    // 审查未产出报告（子代理与 LLM 通道均不可用等）：给出可见的 caution 报告，而不是静默 null
    if (job.review === null || job.review === undefined) {
      job.review = { summary: '审查未能完成（审查通道不可用）', risks: [], severity: 'low', verdict: 'caution', details: '子代理与 LLM 审查通道均未产出报告，可确认安装或中断。' }
    }
    job.status = 'pending'
  } catch (error) {
    if (job.abort.signal.aborted) {
      installJobs.delete(job.id)
      await rmrf(job.staged?.jobDir)
      throw new Error('安装已中断')
    }
    job.status = 'pending'
    job.error = errMsg(error)
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
    await rmrf(staged.jobDir)
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

/** 阶段 2 确认：把挂起的任务真正安装进 profile（成功即从队列消失；失败保留卡片供「帮我安装」/中断）。 */
async function confirmInstall(jobId) {
  const job = installJobs.get(jobId)
  if (!job) throw new Error('安装任务不存在或已过期（请重新发起安装）')
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    installJobs.delete(jobId)
    await rmrf(job.staged?.jobDir)
    throw new Error('安装任务已过期（请重新发起安装）')
  }
  if (job.status === 'installing' || job.status === 'done') {
    throw new Error('安装正在进行或已完成')
  }
  job.status = 'installing'
  try {
    const result = await performInstall({ repoInfo: job.repoInfo, name: job.name, profileDir: job.profileDir, patchPath: job.patchPath, taken: job.taken, staged: job.staged, job, ctx: job.ctx ?? null })
    job.status = 'done'
    installJobs.delete(jobId)
    return result
  } catch (error) {
    // 保留失败任务在列表（供「帮我安装」/中断操作），只清理隔离目录
    job.status = 'failed'
    job.error = errMsg(error)
    await rmrf(job.staged?.jobDir)
    job.staged = null
    throw error
  }
}

/**
 * 「帮我安装 / 帮我更新」统一提示词：只把插件的 GitHub 地址交给 harness 会话，
 * 诊断与安装/更新的具体做法由会话自行决定（它本来就有 bash 与文件工具，
 * 也能读到 profile 目录）。「不要自行重启」是硬要求——重启 dsh web 会把这个
 * 会话所在的进程一并杀掉，用户就看不到结果了。
 */
function buildHelpPrompt(repoUrl) {
  return '帮我安装、更新插件：' + repoUrl + '，不要自行重启'
}

/** 把任意来源写法（owner/name、完整 URL、github: spec）规整成 GitHub 地址；monorepo 子目录保留 #path:。 */
function helpRepoUrl(raw) {
  const value = String(raw ?? '').trim().replace(/^github:/u, '')
  if (value === '') return '（未知仓库地址）'
  try {
    const info = githubRepoInfo(value)
    return 'https://github.com/' + info.owner + '/' + info.name
      + (typeof info.path === 'string' && info.path !== '' ? '#path:' + info.path : '')
  } catch {
    return value
  }
}

/**
 * 仓库回退链（纯函数，/state 展示与 resolveModuleRepository 共用同一条链）：
 * marketplace 记录（override）> 包内 repository 字段 > profile 依赖里的 `github:` spec。
 * 全部要求命中值为非空字符串（对象原型链上的同名键自动跳过），三者皆未命中返回 null。
 */
function repositoryFallback(override, metaRepository, depSpec) {
  if (typeof override === 'string' && override !== '') return override
  if (typeof metaRepository === 'string' && metaRepository !== '') return metaRepository
  if (typeof depSpec === 'string' && depSpec.startsWith('github:')) return depSpec.replace(/^github:/u, '')
  return null
}

/**
 * 解析插件的来源仓库，与已安装列表用同一条回退链：
 * 市场安装记录 > 包内 repository 字段 > profile 依赖里的 `github:` spec。
 * 第三条是 CLI 装的插件（含插件市场自身）唯一的来源，缺了它「帮我更新」拿不到地址。
 */
async function resolveModuleRepository(ctx, moduleName, profileDir) {
  const overrides = await readRepoOverrides()
  const override = overrides[moduleName] ?? null
  const meta = entryPkgMeta(moduleName, ctx.baseUrl ?? 'file:///')
  const metaRepository = typeof meta?.repository === 'string' ? meta.repository : null
  let depSpec = null
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    depSpec = manifest.dependencies?.[moduleName] ?? null
  } catch {}
  return repositoryFallback(override, metaRepository, depSpec)
}

/**
 * 更新差异审查：对新版本与已装代码做文件级 diff，把变更（新增/删除/修改）与新内容一并交给审查通道，
 * 返回附 diff 的报告（method: update-diff），保证审查报告包含本次改动的描述。
 * 供「更新」与「检查更新（开启审查）」共用；无变更或扫描为空时返回 null。
 */
async function reviewUpdateDiff(ctx, installedDir, stagedPkgDir, moduleName, routeOverride, onStage) {
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
  onStage?.('scanning', { files: scan.files.length, signals: scan.signals.length })
  const prompt = buildUpdatePrompt(scan, moduleName, scan.pkgMeta?.version ?? null, diff, changedContent)
  onStage?.('reviewing', { files: scan.files.length, signals: scan.signals.length })
  let report = null
  try {
    report = await runReviewChannel(ctx, prompt, undefined, routeOverride)
  } catch (error) {
    report = null
  }
  if (report === null || typeof report !== 'object') {
    // LLM 通道不可用：降级为 L0 静态兜底报告（附 diff），1 小时窗口内不会重复尝试
    const fallback = buildL0FallbackReport(scan, moduleName, null)
    fallback.diff = diff
    return fallback
  }
  report.diff = diff
  report.scanned = { files: scan.files.length, sizeKB: scan.sizeKB, signals: scan.signals.length }
  report.method = 'update-diff'
  return report
}

/** 命中该版本已缓存的「真实」审查报告（跳过 l0-only / none 兜底）则返回，否则 null。
 *  用于检查更新/更新：新版本 commit 的审查报告已存在（此前检查/更新/安装生成过）时直接复用，不再 LLM 审查。 */
async function cachedRealReview(moduleName, pkgDir) {
  const version = readStagedVersion(pkgDir)
  if (version === null) return null
  const cached = await readReviewFile(reviewKey(moduleName, version))
  if (cached === null || cached.report === null || cached.report === undefined) return null
  const method = cached.report.method
  if (method === 'l0-only' || method === 'none') return null
  return cached.report
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
    '输出约束：你的输出将直接渲染进插件市场的审查报告弹窗，**所有文本（summary/risks/details）一律使用简体中文**（字段名与枚举值 severity/verdict 仍为英文）。只输出一个 JSON 对象，前后不要有任何其他文字（不要 markdown 代码块围栏）。字段要求：summary=一句话（说明更新内容与安全结论）；risks=字符串数组，每项一句话；severity 仅取 low/medium/high；verdict 仅取 safe/caution/danger；details=1-3 句（说明变更是否安全）。',
  ].join('\n').slice(0, PROMPT_CAP)
}

async function updatePlugin(ctx, entryId, repository = '', updateJobId = '', reviewEnabled = true, routeOverride = null) {
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
      // 更新成功落盘：写「更新后待重启」标记——运行树仍是旧代码，重启后加载新版本（重启时清空）
      await writePendingMarker(moduleName, { kind: 'update', at: Date.now() })
      const newVersion = readStagedVersion(job.pkgDir)
      if (job.review !== null && job.review !== undefined && newVersion !== null) {
        await writeReviewCache(reviewKey(moduleName, newVersion), job.review)
      }
      // 版本元信息已变化：清掉缓存，避免 /review 用旧版本键查不到刚保存的报告
      pkgMetaCache.delete(moduleName)
      return { ok: true, entryId, moduleName, usedChannel: 'git', restart: true, review: job.review }
    } finally {
      updateJobs.delete(updateJobId)
      await rmrf(job.jobDir)
    }
  }

  // 无隔离任务（审查关闭直接更新 / 旧流程兼容）：重新拉取 + （可选）差异审查 + 安装
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

  // 更新审查：暂存新版本 → 与已装代码做文件级 diff → 审查变更 → 报告附 diff。
  // 审查关闭（reviewEnabled === false）时跳过审查，直接安装；审查开启时把报告
  // 保存为新版本（与隔离任务路径一致，点击已安装卡片即可查看）
  let review = null
  let stagedVersion = null
  const staged = await stagePackage(gitSpec(repoInfo))
  try {
    if (reviewEnabled) {
      // 新版本审查报告已缓存 → 直接复用，不再 LLM 审查（与检查更新一致）
      const reused = await cachedRealReview(moduleName, staged.pkgDir)
      if (reused !== null) {
        review = reused
      } else {
        review = await reviewUpdateDiff(ctx, installedPackageDir(profileDir, moduleName), staged.pkgDir, moduleName, routeOverride)
      }
      stagedVersion = readStagedVersion(staged.pkgDir)
    }
  } finally {
    await rmrf(staged.jobDir)
  }

  await pnpmInstall(profileDir, gitSpec(repoInfo))
  // 更新成功落盘：写「更新后待重启」标记（同上；重启时清空）
  await writePendingMarker(moduleName, { kind: 'update', at: Date.now() })
  if (reviewEnabled && review !== null && review !== undefined && stagedVersion !== null) {
    await writeReviewCache(reviewKey(moduleName, stagedVersion), review)
    // 版本元信息已变化：清掉缓存，避免 /review 用旧版本键查不到刚保存的报告
    pkgMetaCache.delete(moduleName)
  }
  return { ok: true, entryId, moduleName, usedChannel: 'git', restart: true, review }
}

// ── 安全审查（隔离拉取 → 子代理审查整个包 → 缓存报告，7 天清理） ───────────────

/** 清理隔离目录与旧审查缓存（超过 7 天的删除）。 */
async function cleanupStagingAndReviews(ctx) {
  // 隔离目录：job-* 目录超过 1 小时视为孤儿（dsh web 崩溃/重启遗留——任务队列是内存的，
  // 重启后任何 job-* 都无主，正常安装拉取几分钟、审查最多 10 分钟，1 小时阈值安全）；
  // 其它条目（如顶层残留）按 7 天兜底清理。
  const JOB_ORPHAN_MS = 60 * 60 * 1000
  // 审查报告缓存 7 天过期（review.js REVIEW_TTL_DAYS 的毫秒形式；清理与自动清理共用同一阈值）
  const REVIEW_EXPIRE_MS = REVIEW_TTL_DAYS * 86400000
  try {
    const entries = await readdir(STAGING_DIR)
    for (const entry of entries) {
      const target = join(STAGING_DIR, entry)
      const st = await stat(target).catch(() => null)
      if (st === null) continue
      const age = Date.now() - st.mtimeMs
      const isJobDir = entry.startsWith('job-')
      if (isJobDir ? age > JOB_ORPHAN_MS : age > REVIEW_EXPIRE_MS) {
        await rmrf(target)
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
        if (typeof data.reviewedAt === 'number' && Date.now() - data.reviewedAt > REVIEW_EXPIRE_MS) {
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
        await rmrf(target)
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

/** 在隔离目录拉取包（spec 为 github:owner/name，可带 #path 子目录）。
 *  extraOnProgress 可选：每次 pnpm Progress 行回调（供检查更新的实时进度展示）。 */
async function stagePackage(spec, job, extraOnProgress) {
  const fsMod = await import('node:fs')
  fsMod.mkdirSync(STAGING_DIR, { recursive: true })
  fsMod.mkdirSync(REVIEWS_DIR, { recursive: true })
  const jobDir = join(STAGING_DIR, 'job-' + Date.now())
  fsMod.mkdirSync(jobDir, { recursive: true })
  // 提前登记 jobDir，中断时即便拉取未完成也能清理残留
  if (job !== undefined && job !== null) job.staged = { jobDir }
  fsMod.writeFileSync(join(jobDir, 'package.json'), JSON.stringify({ name: 'staging', private: true, dependencies: {} }, null, 2) + '\n')
  // 与真实 profile 同款 pnpm 设置（见 STAGING_PNPM_WORKSPACE）：不写这份配置，
  // 声明了非 optional 的 @deepseek-ai/dsh-* peer 的插件在这一步就会拉取失败。
  fsMod.writeFileSync(join(jobDir, 'pnpm-workspace.yaml'), STAGING_PNPM_WORKSPACE)
  // 拉取进度：流式解析 pnpm 的 Progress 行 → job.progress（安装任务 1s 轮询展示进度条）
  // 与 extraOnProgress（检查更新的实时进度）
  const onProgress = (parsed) => {
    const snap = progressFromPnpm(parsed)
    if (job !== undefined && job !== null) job.progress = snap
    if (typeof extraOnProgress === 'function') extraOnProgress(snap)
  }
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

export { queuedStateFile, DSH_BEST_FIT_VERSION, installJobs, reviewInflight, readSources, writeSources, readRepoOverrides, writeRepoOverride, readPendingMarkers, writePendingMarker, clearPendingMarker, clearAllPendingMarkers, setCheckProgress, clearCheckProgress, snapshotCheckProgress, createUpdateJob, interruptInstall, listInstallJobs, installPlugin, confirmInstall, buildHelpPrompt, helpRepoUrl, repositoryFallback, resolveModuleRepository, reviewUpdateDiff, cachedRealReview, installedPackageDir, updatePlugin, cleanupStagingAndReviews, cleanupCaches, stagePackage }