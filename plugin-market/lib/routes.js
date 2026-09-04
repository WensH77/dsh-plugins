import { rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { collectBody, errMsg, gitSpec, isLoopback, repoToGithub, rmrf, sendError, sendJson } from './util.js'
import { gitLocalCommit, gitRemoteHead, pnpmRemove } from './pnpm.js'
import { DEFAULT_BUNDLES, disableEntry, enableEntry, entryPkgMeta, findPatchPath, isLocalDependency, isProtectedModule, isUserInstalled, listEntries, localDependencyInfo, readPatchState, readProfileManifest, removeBundleFromManifest, removeInsertRow, rowIdOf } from './patch.js'
import { analyzeDshUpdate, attachSessionToWorkspace, checkDshUpdate, createVisibleAnalysisSession, dshStateCache } from './dsh.js'
import { markReviewProtected, readReviewFile, reviewKey, reviewPackage, REVIEW_RETRY_MS, REVIEWS_DIR, waitForToggleApplied, writeReviewCache } from './review.js'
import { buildHelpPrompt, cachedRealReview, cleanupCaches, clearCheckProgress, clearPendingMarker, confirmInstall, createUpdateJob, DSH_BEST_FIT_VERSION, helpRepoUrl, installedPackageDir, installJobs, installPlugin, interruptInstall, listInstallJobs, readPendingMarkers, readRepoOverrides, readSources, repositoryFallback, resolveModuleRepository, reviewInflight, reviewUpdateDiff, setCheckProgress, snapshotCheckProgress, stagePackage, updatePlugin, writePendingMarker, writeRepoOverride, writeSources } from './install.js'

const ROUTE_PREFIX = '/plugin-market'

// ── 主路由处理 ──────────────────────────────────────────────────────────────

/** 把 handler 主体包成环回路由处理器：主体抛错统一回 500（错误消息用户可读）。 */
const asHandler = (run) => async (ctx, body, res) => {
  try {
    await run(ctx, body, res)
  } catch (error) {
    sendError(res, 500, errMsg(error))
  }
}

/** 从请求体解析审查路由覆盖（客户端选的模型/推理程度）；未选择时返回 null（走设置默认）。 */
function routeOverrideOf(body) {
  const out = {}
  const model = typeof body?.model === 'string' ? body.model.trim() : ''
  const effort = typeof body?.effort === 'string' ? body.effort.trim() : ''
  if (model !== '') out.model = model
  if (effort !== '') out.reasoningEffort = effort
  return Object.keys(out).length > 0 ? out : null
}

  // 状态：插件清单 + 补丁层 + GitHub 源
async function handleState(ctx, body, res) {
    const patchPath = findPatchPath(ctx)
    const patch = await readPatchState(patchPath)
    const sources = await readSources()
    // 用户安装的 bundle 包：profile manifest 的 dsh.profile.bundles 中非默认的
    const profileDir = dirname(patchPath)
    // manifest 经 60s TTL 缓存读取（patch.js readProfileManifest）；缺失/损坏 → null，视为空
    const manifest = await readProfileManifest(profileDir)
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    const deps = manifest?.dependencies ?? {}
    const overrides = await readRepoOverrides()
    const entries = listEntries(ctx).map((entry) => {
      const meta = entryPkgMeta(entry.moduleName, ctx.baseUrl ?? 'file:///')
      const extra = patch.inserts.includes(entry.rowId)
      // 用户安装的 bundle（非默认）：进 dsh.profile.bundles 的第三方 bundle
      const userBundle = bundles.includes(entry.moduleName) && !DEFAULT_BUNDLES.includes(entry.moduleName)
      // 仓库展示与 git 更新通道的回退链：marketplace 记录 > 包内 repository 字段 > github: 依赖 spec
      // （CLI 安装的插件没有 marketplace 记录，也照样能显示来源、检查更新）
      const override = Object.prototype.hasOwnProperty.call(overrides, entry.moduleName) ? overrides[entry.moduleName] : null
      const depSpec = typeof deps[entry.moduleName] === 'string' ? deps[entry.moduleName] : ''
      const localInfo = localDependencyInfo(profileDir, entry.moduleName)
      const repository = repositoryFallback(override, meta?.repository ?? null, depSpec)
      return {
        ...entry,
        userDisabled: patch.disables.includes(entry.rowId),
        userForced: patch.forced.includes(entry.rowId),
        extra,
        userBundle,
        userInstalled: isUserInstalled(entry.moduleName, entry.rowId, extra, bundles),
        localInstalled: localInfo.local,
        localPath: localInfo.path,
        version: meta?.version ?? null,
        repository,
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
      .map((b) => ({ moduleName: b, kind: 'bundle', channel: channelOf(deps[b] ?? null) ?? 'bundle', spec: deps[b] ?? null }))
    // insert 层插件：patch 里已 insert、但未加载进运行树（热重载关闭/失败或需重启）
    // → 同样列入待重启，避免「已安装」「待重启」都看不到它
    const pendingInserts = patch.inserts
      .filter((id) => !entries.some((e) => e.rowId === id))
      .map((id) => {
        const moduleName = patch.insertNames[id]
        if (typeof moduleName !== 'string' || moduleName === '') return null
        return { moduleName, kind: 'insert', channel: channelOf(deps[moduleName] ?? null) ?? 'insert', spec: deps[moduleName] ?? null }
      })
      .filter(Boolean)
    // 更新成功落盘但仍在运行树里（内存仍是旧代码）：标记文件里的 kind:'update' 条目
    // 一并列入待重启——更新后必须重启才能加载新版本（dsh web 重启时 apply() 清空标记）
    const entriesByName = new Map(entries.map((e) => [e.moduleName, e]))
    const pendingMarkers = await readPendingMarkers()
    const pendingUpdated = Object.entries(pendingMarkers)
      .filter(([name, marker]) => marker.kind === 'update' && entriesByName.has(name))
      .map(([name, marker]) => {
        const entry = entriesByName.get(name)
        return {
          moduleName: name,
          kind: 'update',
          channel: channelOf(deps[name] ?? null) ?? 'git',
          spec: deps[name] ?? null,
          version: entry?.version ?? null,
          at: marker.at ?? 0,
        }
      })
    // 更新失败标记：只在已安装卡片上显示（可能处于半更新状态），不放待重启区
    const updateFailures = {}
    for (const [name, marker] of Object.entries(pendingMarkers)) {
      if (marker.kind === 'failed-update' && entriesByName.has(name)) {
        updateFailures[name] = { error: marker.error ?? '', at: marker.at ?? 0, helpSessionId: typeof marker.helpSessionId === 'string' ? marker.helpSessionId : null }
      }
    }
    const pendingRestart = [...pendingBundles, ...pendingInserts, ...pendingUpdated]
    sendJson(res, 200, { ok: true, entries, sources, patchPath, jobs: listInstallJobs(), pendingRestart, updateFailures, checks: snapshotCheckProgress(), dshBestFit: DSH_BEST_FIT_VERSION, dshVersion: dshStateCache ?? null })
    return
}

  // 保存 GitHub 源列表（可编辑、持久化）
async function handleSources(ctx, body, res) {
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
async function handleToggle(ctx, body, res) {
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
async function handleCheckUpdate(ctx, body, res) {
    const packageName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
    const repository = typeof body.repository === 'string' ? body.repository.trim() : ''
    if (!packageName) {
      sendError(res, 400, 'packageName 不能为空')
      return
    }
    // git 通道检测：有 repository 时对比远端 HEAD 与本地锁定 commit
    let git = null
    const repo = repoToGithub(repository)
    const progKey = 'check:' + packageName
    if (repo !== null) {
      setCheckProgress(progKey, { stage: 'git' })
      const patchPath = findPatchPath(ctx)
      const profileDir = dirname(patchPath)
      const [remote, localCommit] = await Promise.all([
        gitRemoteHead(repo.owner, repo.name),
        gitLocalCommit(profileDir, repo.owner, repo.name),
      ])
      const remoteHead = remote.head
      // 本地 link/file 安装（开发工作流）不可经 git 通道转换，保持 unknown 不可更新
      const localDep = isLocalDependency(profileDir, packageName)
      const comparable = localCommit !== null
      git = {
        owner: repo.owner,
        name: repo.name,
        remoteHead,
        localCommit,
        // 已从 git 安装：对比远端 HEAD 与本地锁定 commit；
        // 未从 git 安装（手动拷贝/registry，无锁定 commit）但仓库可达且非本地安装：
        // 视为可更新——点「更新」将转为 git 通道安装远端最新版（一次到位）
        hasUpdate: remoteHead !== null && (comparable ? remoteHead !== localCommit : !localDep),
        // localCommit 为 null 时无法对比，标注 unknown（可更新时由客户端展示转换提示）
        unknown: !comparable,
        // 拉取远端失败（网络/超时）：客户端在卡片上显示网络错误，不再静默当作「已是最新」
        fetchError: remote.error ?? null,
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
        setCheckProgress(progKey, { stage: 'pulling' })
        staged = await stagePackage(gitSpec(repo), null, (snap) => setCheckProgress(progKey, { stage: 'pulling', percent: snap.percent ?? null }))
        // 新版本 commit 的审查报告已缓存（此前检查/更新/安装生成过）→ 直接复用，不再 LLM 审查
        const reused = await cachedRealReview(packageName, staged.pkgDir)
        if (reused !== null) {
          review = reused
        } else {
          setCheckProgress(progKey, { stage: 'scanning' })
          review = await reviewUpdateDiff(ctx, installedPackageDir(dirname(findPatchPath(ctx)), packageName), staged.pkgDir, packageName, routeOverrideOf(body), (stage, data) => {
            if (stage === 'scanning') setCheckProgress(progKey, { stage: 'scanning' })
            else if (stage === 'reviewing') setCheckProgress(progKey, { stage: 'reviewing', files: data?.files ?? null, signals: data?.signals ?? null })
          })
        }
      } catch (error) {
        review = { summary: '审查未能完成', risks: [], severity: 'low', verdict: 'caution', details: errMsg(error) }
      }
      if (staged !== null && review !== null) {
        updateJobId = createUpdateJob(packageName, repo, staged.jobDir, staged.pkgDir, review)
      } else if (staged !== null) {
        await rmrf(staged.jobDir)
      }
    }
    clearCheckProgress(progKey)
    sendJson(res, 200, { ok: true, packageName, git, review, updateJobId })
    return
}

  // 安装插件（git 通道）
const handleInstall = asHandler(async (ctx, body, res) => {
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  const packageName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
  const review = body.review === true
  if (repo === '') {
    sendError(res, 400, 'git 通道安装需要 GitHub 仓库地址（owner/name）')
    return
  }
  const result = await installPlugin(ctx, { repo, packageName, review, routeOverride: routeOverrideOf(body) })
  sendJson(res, 200, result)
})

  // 确认安装：审查报告确认后迁移到 profile
const handleInstallConfirm = asHandler(async (ctx, body, res) => {
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
  if (jobId === '') {
    sendError(res, 400, 'jobId 不能为空')
    return
  }
  const result = await confirmInstall(jobId)
  sendJson(res, 200, result)
})

  // 帮我安装：安装失败（拉取/审查/安装任一阶段）时开启可见 harness 会话，把插件的 GitHub 地址交给它完成安装
const handleInstallHelp = asHandler(async (ctx, body, res) => {
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
  const currentSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (jobId === '') {
    sendError(res, 400, 'jobId 不能为空')
    return
  }
  const job = installJobs.get(jobId)
  if (!job) {
    sendError(res, 404, '安装任务不存在或已过期（请重新发起安装）')
    return
  }
  // 幂等：已交予会话的任务直接返回原会话
  if (job.status === 'helping' && typeof job.helpSessionId === 'string' && job.helpSessionId !== '') {
    sendJson(res, 200, { ok: true, sessionId: job.helpSessionId })
    return
  }
  const promptText = buildHelpPrompt(helpRepoUrl(job.repo ?? (job.repoInfo ? gitSpec(job.repoInfo) : '')))
  const created = await createVisibleAnalysisSession(ctx, promptText, null, 'dsh-install-')
  if (created === null || created.sessionId === undefined) {
    sendError(res, 500, '未能开启会话（默认模型通道不可用）')
    return
  }
  await attachSessionToWorkspace(ctx, created.sessionId, currentSessionId)
  job.status = 'helping'
  job.helpSessionId = created.sessionId
  sendJson(res, 200, { ok: true, sessionId: created.sessionId })
})

  // 中断安装任务（拉取中/审查中/待安装均可；检查残留并清理，任务即刻消失）
const handleInstallInterrupt = asHandler(async (ctx, body, res) => {
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
  if (jobId === '') {
    sendError(res, 400, 'jobId 不能为空')
    return
  }
  const result = await interruptInstall(jobId)
  sendJson(res, 200, result)
})

  // 更新已安装插件（git 通道；优先用检查更新保留的隔离目录直接安装，不重新拉取/审查；
  // 无隔离任务时走重新拉取流程；body.review === false（审查关闭）时跳过差异审查直接安装）
async function handleUpdate(ctx, body, res) {
    const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : ''
    if (entryId === '') {
      sendError(res, 400, 'entryId 不能为空')
      return
    }
    const updateEntry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
    try {
      const result = await updatePlugin(ctx, entryId,
        typeof body.repository === 'string' ? body.repository.trim() : '',
        typeof body.updateJobId === 'string' ? body.updateJobId.trim() : '',
        body.review !== false,
        routeOverrideOf(body))
      sendJson(res, 200, result)
    } catch (error) {
      // 更新失败：写持久标记，卡片持续提示「可能状态不一致」直到重试成功 / 卸载 / 重启
      if (updateEntry !== undefined && typeof updateEntry.options?.name === 'string') {
        await writePendingMarker(updateEntry.options.name, {
          kind: 'failed-update',
          error: errMsg(error),
          at: Date.now(),
        }).catch(() => {})
      }
      sendError(res, 500, errMsg(error))
    }
    return
}

  // 帮我更新：更新失败时开启可见 harness 会话，把插件的 GitHub 地址交给它完成更新（与「帮我安装」同一份 prompt）
  // （幂等：同一插件的失败标记已带 helpSessionId 时直接返回原会话）
const handleUpdateHelp = asHandler(async (ctx, body, res) => {
  const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : ''
  const currentSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (entryId === '') {
    sendError(res, 400, 'entryId 不能为空')
    return
  }
  const helpEntry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
  if (!helpEntry) {
    sendError(res, 404, '没有名为 ' + entryId + ' 的插件条目')
    return
  }
  const moduleName = helpEntry.options.name
  const markers = await readPendingMarkers()
  const marker = markers[moduleName]
  if (marker === undefined || marker.kind !== 'failed-update') {
    sendError(res, 400, '该插件当前没有更新失败记录（可能已重试成功 / 已重启清除）')
    return
  }
  if (typeof marker.helpSessionId === 'string' && marker.helpSessionId !== '') {
    sendJson(res, 200, { ok: true, sessionId: marker.helpSessionId })
    return
  }
  const profileDir = dirname(findPatchPath(ctx))
  // 仓库地址：优先客户端传入（已走过展示用的回退链），否则服务端按同一条链自行解析
  const bodyRepo = typeof body.repository === 'string' ? body.repository.trim() : ''
  const repository = bodyRepo !== '' ? bodyRepo : await resolveModuleRepository(ctx, moduleName, profileDir)
  const promptText = buildHelpPrompt(helpRepoUrl(repository))
  const created = await createVisibleAnalysisSession(ctx, promptText, null, 'dsh-update-help-')
  if (created === null || created.sessionId === undefined) {
    sendError(res, 500, '未能开启会话（默认模型通道不可用）')
    return
  }
  await attachSessionToWorkspace(ctx, created.sessionId, currentSessionId)
  await writePendingMarker(moduleName, { ...marker, helpSessionId: created.sessionId })
  sendJson(res, 200, { ok: true, sessionId: created.sessionId })
})

  // 卸载插件（移除 insert 行 + pnpm remove）
async function handleUninstall(ctx, body, res) {
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
    // manifest 经 60s TTL 缓存读取；缺失/损坏 → null，视为无用户 bundle（与 /state 同一缓存，卸载后由写路径失效）
    const manifest = await readProfileManifest(profileDir)
    const bundles = manifest?.dsh?.profile?.bundles ?? []
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
        sendError(res, 500, '移除依赖失败：' + (errMsg(err)))
        return
      }
      await removeInsertRow(patchPath, rowId)
      await writeRepoOverride(moduleName, '')
      await clearPendingMarker(moduleName)
      sendJson(res, 200, { ok: true, removed: 'entry', packageName: moduleName, restart: false })
      return
    }
    if (isUserBundle) {
      // bundle 型插件：先 pnpm remove 移除依赖（失败则保留 manifest，UI 可重试），成功后再移除 bundle 配置；
      // bundle 层启动时应用，运行时条目需重启 dsh web 才卸载
      try {
        await pnpmRemove(profileDir, moduleName)
      } catch (err) {
        sendError(res, 500, '移除依赖失败：' + (errMsg(err)))
        return
      }
      await removeBundleFromManifest(profileDir, moduleName)
      // 写临时禁用行让运行树立即卸载（HMR）——避免"文件已删、旧服务仍引用"导致页面启动报错；
      // 重启后 bundle 不再加载，该禁用行对不存在的条目无害；重装时会自动清理
      await disableEntry(patchPath, rowId)
      await writeRepoOverride(moduleName, '')
      await clearPendingMarker(moduleName)
      sendJson(res, 200, { ok: true, removed: 'bundle', packageName: moduleName, restart: true })
      return
    }
    sendError(res, 400, '该插件不是用户安装的额外插件（不可删除）')
    return
}

  // 查看已安装插件当前版本的审查报告：缓存命中直接返回（永久保留，不受 7 天 TTL/清理影响）；
  // 没有缓存则在已安装包目录现场生成（首次点击触发），生成后标记保留。
async function handleReview(ctx, body, res) {
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
      const isFallback = cached.report?.method === 'none' || cached.report?.method === 'l0-only'
      // 「审查未能完成」/「L0 静态兜底」报告只缓存 1 小时：窗口内重复点击直接复用，不重复拉取审查；
      // 过期后删除缓存、重新走生成流程（审查通道恢复后可再次生成真实报告）
      if (isFallback && typeof cached.reviewedAt === 'number' && Date.now() - cached.reviewedAt > REVIEW_RETRY_MS) {
        await rm(join(REVIEWS_DIR, key + '.json'), { force: true }).catch(() => {})
      } else {
        if (cached.protected !== true && !isFallback) await markReviewProtected(key)
        sendJson(res, 200, { ok: true, entryId, moduleName, version, cached: true, report: cached.report })
        return
      }
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
    const progKey = 'review:' + entryId
    let pending = reviewInflight.get(key)
    if (pending === undefined) {
      setCheckProgress(progKey, { stage: 'scanning' })
      pending = reviewPackage(ctx, pkgDir, moduleName, version, null, (stage, data) => {
        if (stage === 'scan') setCheckProgress(progKey, { stage: 'scanning' })
        else if (stage === 'l1') setCheckProgress(progKey, { stage: 'reviewing', files: data?.files ?? null, signals: data?.signals ?? null })
        else if (stage === 'aggregate') setCheckProgress(progKey, { stage: 'aggregating' })
      }, routeOverrideOf(body))
      reviewInflight.set(key, pending)
      // 清理链吞掉拒绝（避免 unhandled rejection），原 promise 仍由 await 处处理
      pending.then(() => {}, () => {}).finally(() => {
        if (reviewInflight.get(key) === pending) reviewInflight.delete(key)
      })
    }
    let report = null
    let fallbackDetails = '可稍后重试。'
    try {
      report = await pending
    } catch (error) {
      // 生成异常：同样落盘兜底报告（1 小时窗口内重复点击不再重跑生成）
      fallbackDetails = errMsg(error)
    }
    clearCheckProgress(progKey)
    if (report === null || report === undefined) {
      // 包无可审查内容 / 审查通道不可用且无 L0 扫描内容：给可见的 caution 报告而不是静默失败；
      // 缓存兜底报告（method: 'none'），重复点击直接复用，避免每次点击都重跑一遍审查通道
      const fallback = { summary: '审查未能完成（审查通道不可用或包内容为空）', risks: [], severity: 'low', verdict: 'caution', details: fallbackDetails, method: 'none' }
      await writeReviewCache(key, fallback)
      sendJson(res, 200, { ok: true, entryId, moduleName, version, cached: false, report: fallback })
      return
    }
    if (report.method === 'l0-only') {
      // L0 静态兜底：同样落盘，1 小时窗口内重复点击直接复用，超时自动重新生成
      await writeReviewCache(key, report)
      sendJson(res, 200, { ok: true, entryId, moduleName, version, cached: false, report })
      return
    }
    await markReviewProtected(key)
    sendJson(res, 200, { ok: true, entryId, moduleName, version, cached: false, report })
    return
}

  // 一键清理缓存：删除超过该时限的 staging 残留与审查报告（与 install.js cleanupCaches 的阈值语义一致）
const CLEANUP_AGE_MS = 60 * 60 * 1000

const handleCleanup = asHandler(async (ctx, body, res) => {
  const result = await cleanupCaches(ctx, CLEANUP_AGE_MS)
  sendJson(res, 200, result)
})

  // dsh 自更新状态（侧边栏状态灯）：返回已装/远端版本 + 判定
const handleDshVersion = asHandler(async (ctx, body, res) => {
  const state = dshStateCache ?? await checkDshUpdate(ctx)
  sendJson(res, 200, { ok: true, ...state })
})

  // 强制重新检测 dsh 更新（点击绿灯/灰灯时手动重检）
const handleDshVersionCheck = asHandler(async (ctx, body, res) => {
  const state = await checkDshUpdate(ctx)
  sendJson(res, 200, { ok: true, ...state })
})

  // 点击状态灯：后台直连 LLM（默认模型）分析升级内容与破坏性更新，不建会话
const handleDshVersionAnalyze = asHandler(async (ctx, body, res) => {
  const result = await analyzeDshUpdate(ctx)
  sendJson(res, 200, result)
})

// 路由分发表：method 为 null 表示不限制方法（与原实现 pathname-only 分支一致）。
const ROUTES = [
  { method: 'GET', path: '/state', handler: handleState },
  { method: null, path: '/sources', handler: handleSources },
  { method: null, path: '/toggle', handler: handleToggle },
  { method: null, path: '/check-update', handler: handleCheckUpdate },
  { method: null, path: '/install', handler: handleInstall },
  { method: null, path: '/install/confirm', handler: handleInstallConfirm },
  { method: null, path: '/install/help', handler: handleInstallHelp },
  { method: null, path: '/install/interrupt', handler: handleInstallInterrupt },
  { method: null, path: '/update', handler: handleUpdate },
  { method: null, path: '/update/help', handler: handleUpdateHelp },
  { method: null, path: '/uninstall', handler: handleUninstall },
  { method: null, path: '/review', handler: handleReview },
  { method: null, path: '/cleanup', handler: handleCleanup },
  { method: 'GET', path: '/dsh-version', handler: handleDshVersion },
  { method: null, path: '/dsh-version/check', handler: handleDshVersionCheck },
  { method: null, path: '/dsh-version/analyze', handler: handleDshVersionAnalyze }
]

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const method = req.method ?? 'GET'
  const body = await collectBody(req)

  for (const route of ROUTES) {
    if ((route.method === null || route.method === method) && pathname === ROUTE_PREFIX + route.path) {
      await route.handler(ctx, body, res)
      return
    }
  }
  sendError(res, 404, '未知接口 ' + pathname)
}

export function registerRoutes(ctx) {
  return ctx.effect(() => {
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
          sendError(res, 500, errMsg(error))
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'plugin-market: routes')
}

export { ROUTE_PREFIX, ROUTES, handle, routeOverrideOf }