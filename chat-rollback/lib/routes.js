// dsh-plugin-chat-rollback — webServer 路由域。
// 从原单文件 index.js 拆出：三个端点（POST /rollback、POST /preflight、
// POST /prune-archived）+ 幂等路由注册（registerWebRoute）+ 请求解析
// （parseRequest / resolveTarget：preflight 与 rollback 共用同一目标定位，
// 保证两侧对「回滚到哪、参数是否合法」的判定与错误文案一致）。
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rollbackConflictState } from './conflict.js';
import { sessionEvents, resolvePresetId, resolveSeqByMessageKey, resolveRollbackTarget } from './session.js';
import { inheritSnapshots, pruneSnapshots } from './snapshot-store.js';
import { backupWorkspace, restoreWorkspace, fsTargetExists, snapshotHasEntries, workspaceHasEntries } from './workspace.js';

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/** 统一错误响应：{ status, code, message } -> HTTP status + { ok:false, ... }。 */
function sendError(res, error) {
  sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
}

/** 校验并读取回滚请求参数（session / seq / key）。失败返回
 * { error: { status, code, message } }。 */
function parseRequest(url) {
  const sessionId = url.searchParams.get('session') ?? '';
  const seqParam = url.searchParams.get('seq') ?? '';
  const keyParam = url.searchParams.get('key') ?? '';
  if (sessionId === '' || (!/^\d+$/.test(seqParam) && keyParam === '')) {
    return { error: { status: 400, code: 'bad-request', message: 'session id and a numeric seq (or a message key) are required' } };
  }
  return { sessionId, seqParam, keyParam };
}

/** 定位 live 会话并解析回滚目标。任一环节失败返回 { error: { status, code,
 * message } }（已含 HTTP 状态码），成功返回 { source, target }。 */
async function resolveTarget(env, parsed) {
  const source = env.ctx.sessions.get(parsed.sessionId);
  if (source === undefined) {
    return { error: { status: 404, code: 'session-not-found', message: 'no live session ' + parsed.sessionId } };
  }
  const events = sessionEvents(source);
  let seq;
  if (parsed.keyParam !== '') {
    seq = resolveSeqByMessageKey(events, parsed.keyParam);
    if (seq === -1) {
      return { error: { status: 400, code: 'bad-key', message: 'no event carries message key ' + parsed.keyParam } };
    }
  } else {
    seq = Number(parsed.seqParam);
  }
  if (seq >= events.length) {
    return { error: { status: 400, code: 'bad-seq', message: 'seq ' + seq + ' is beyond the session log (' + events.length + ' events)' } };
  }
  return { source, target: resolveRollbackTarget(events, seq) };
}

/** Read-only conflict preflight for a rollback target. Runs BEFORE any restore
 * so the client can gate the confirm (✓) behind a "?" when another session has
 * also changed files this rollback would overwrite. */
async function handlePreflight(req, res, env) {
  try {
    const parsed = parseRequest(new URL(req.url ?? '/', 'http://x'));
    if (parsed.error !== undefined) return sendError(res, parsed.error);
    const resolved = await resolveTarget(env, parsed);
    if (resolved.error !== undefined) return sendError(res, resolved.error);
    const state = await rollbackConflictState(env, resolved.source, resolved.target.turn);
    sendJson(res, 200, {
      ok: true,
      conflict: state.conflict,
      files: state.files,
      reason: state.reason,
      sourceSessionId: parsed.sessionId,
      sourceTurn: resolved.target.turn
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
  }
}
async function handleRollback(req, res, env) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const parsed = parseRequest(url);
    if (parsed.error !== undefined) return sendError(res, parsed.error);
    const sessionId = parsed.sessionId;
    // Lazy cleanup: snapshots of archived sessions (and orphaned/non-standard
    // dirs) are reclaimed on rollback. skipId = 本次源会话：该目录马上要被
    // inheritSnapshots 硬链接继承，惰性清理若与其并发（尤其跨文件系统
    // copyFile 降级路径）可能先删源快照。
    pruneSnapshots(env, undefined, sessionId).catch(() => {});
    const resolved = await resolveTarget(env, parsed);
    if (resolved.error !== undefined) return sendError(res, resolved.error);
    const source = resolved.source;
    const { seed, turn, nextInput } = resolved.target;
    const force = url.searchParams.get('force') === '1';
    const stream = url.searchParams.get('stream') === '1';
    // TOCTOU 收窄：preflight 与真正执行之间其他会话的写入，在这里再验一次；
    // 有冲突且未 force → 409，客户端回到「?" 确认态，确认后带 force=1 重发。
    const state = await rollbackConflictState(env, source, turn);
    if (state.conflict && !force) {
      sendJson(res, 409, { ok: false, code: 'conflict', files: state.files, sourceSessionId: sessionId, sourceTurn: turn, message: 'files changed by other sessions; confirm to overwrite' });
      return;
    }
    // 空快照安全网：恢复点快照为空（如 excludes 配成 '*'、或快照损坏/回归）
    // 且工作区非空时，恢复会清空整个工作区——需用户确认（force）才执行。
    let emptySnapshotGuard = false;
    if (env.snapshotsEnabled && !force) {
      const cwd = source.header?.cwd;
      const snapshotFile = join(env.snapRoot, sessionId, 'turn-' + (turn + 1) + '.tar.zst');
      if (typeof cwd === 'string' && cwd !== '' && await fsTargetExists(snapshotFile)) {
        // 只统计非排除内容：工作区仅有被排除文件（如只有 .git）时恢复不会
        // 触碰它们，不应误报 409。snapshotHasEntries === false（快照为空）
        // 且 workspaceHasEntries === true（工作区有非排除内容）才触发守卫；
        // 任一 shell 读取失败返回 null，与原实现 listing/ws 失败即跳过一致。
        if ((await snapshotHasEntries(snapshotFile)) === false && (await workspaceHasEntries(cwd, env.excludes)) === true) {
          emptySnapshotGuard = true;
        }
      }
    }
    if (emptySnapshotGuard) {
      sendJson(res, 409, { ok: false, code: 'empty-snapshot', files: [], sourceSessionId: sessionId, sourceTurn: turn, message: 'snapshot is empty; rollback would wipe the workspace — confirm to proceed' });
      return;
    }
    // stream=1 的 ndjson 进度流：先写响应头（409 校验已全部通过），此后每个
    // 阶段即时写一行，客户端可实时展示进度；非流式保持单次 JSON。
    if (stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    }
    const emitPhase = (p) => {
      if (stream) res.write(JSON.stringify(p) + '\n');
    };
    let agentPreset;
    let setup;
    try {
      const presetId = resolvePresetId(source);
      const presets = env.ctx.get('agentPresets');
      if (presets !== undefined) {
        const resolvedId = (await presets.resolve(presetId)).id;
        agentPreset = resolvedId;
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, resolvedId);
        };
      }
    } catch (error) {
      env.ctx.logger.warn('chat-rollback: preset composition failed: ' + String(error));
    }
    let selection;
    try {
      selection = env.ctx.agentDefaultModel.currentSelection();
    } catch {
      selection = undefined;
    }
    const childId = 'session-' + randomUUID();
    await env.ctx.agents.create({
      sessionId: childId,
      seed,
      meta: {
        ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
        ...(agentPreset === undefined ? {} : { agentPreset })
      },
      agentOptions: selection === undefined ? {} : { provider: selection.provider, model: selection.model },
      setup
    });
    emitPhase({ phase: 'session', sessionId: childId });
    let workspaceNote;
    try {
      const workspace = env.ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(source.id));
      if (workspace !== undefined) {
        await workspace.attachSession(childId);
        workspaceNote = workspace.id;
      }
    } catch (error) {
      workspaceNote = 'workspace attach failed: ' + String(error);
    }
    // The source session is superseded: cancel its agent when it is still
    // running (rollback onto a mid-turn message), so it cannot keep mutating
    // the workspace we are about to restore. Mirrors host session.cancel
    // semantics (keepInbox preserves queued input; idle agents are untouched).
    let sourceCancelled = false;
    try {
      const agent = env.ctx.agents.get(source.id);
      if (agent !== undefined && agent.status === 'running') {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        sourceCancelled = true;
      }
    } catch (error) {
      env.ctx.logger.warn('chat-rollback: source agent cancel failed: ' + String(error));
    }
    emitPhase({ phase: 'cancel', sourceCancelled });
    // Code rollback: restore the workspace to the state right AFTER the turn
    // that contains the rollback target message, undoing every file change the
    // target turn and later turns made. Snapshot "turn-N" is taken at turn-N
    // start, so the state after turn-K is snapshot turn-(K+1), when it exists.
    // Without a snapshot (fresh sessions, disabled snapshotting, non-cwd
    // workspaces) the conversation still rolls back — the workspace is simply
    // left as-is, which is the pre-snapshot "branch" behaviour. The pre-restore
    // backup lives in the CHILD's snapshot dir: the source dir is pruned on
    // archive below, so a backup stored there would die with it.
    let codeRollback = { restored: false, reason: 'no-snapshot' };
    if (env.snapshotsEnabled) {
      const snapDir = join(env.snapRoot, sessionId);
      const snapshotFile = join(snapDir, 'turn-' + (turn + 1) + '.tar.zst');
      const cwd = source.header?.cwd;
      if (typeof cwd !== 'string' || cwd === '') {
        codeRollback = { restored: false, reason: 'no-cwd' };
      } else if (await fsTargetExists(snapshotFile)) {
        const stamp = Date.now();
        const backupFile = join(env.snapRoot, childId, 'recovery-' + stamp + '.tar.zst');
        emitPhase({ phase: 'backup' });
        try {
          const backupOk = await backupWorkspace(cwd, backupFile, env.excludes);
          if (!backupOk) env.ctx.logger.warn('chat-rollback: pre-restore backup failed for ' + childId + ' (auto-rollback on restore failure unavailable)');
          const restore = await restoreWorkspace(cwd, snapshotFile, env.excludes);
          if (restore.ok) {
            codeRollback = { restored: true, snapshot: 'turn-' + (turn + 1) + '.tar.zst', backup: 'recovery-' + stamp + '.tar.zst' };
          } else {
            // 恢复失败：自动用 recovery 备份把工作区还原到恢复前状态（尽力而
            // 为），避免停在半恢复状态；rolledBack 供客户端提示。
            let rolledBack = false;
            try {
              const undo = await restoreWorkspace(cwd, backupFile, env.excludes);
              rolledBack = undo.ok;
            } catch {}
            codeRollback = { restored: false, reason: 'restore-failed', message: restore.stderr.slice(0, 500), ...(rolledBack ? { rolledBack: true } : {}) };
          }
        } catch (error) {
          codeRollback = { restored: false, reason: 'restore-failed', message: String(error?.message ?? error).slice(0, 500) };
        }
      }
    }
    emitPhase({ phase: 'restore', codeRollback });
    // Snapshot inheritance: the new session's seed carries turns 1..turn, so a
    // further rollback inside it to a seeded message needs the source's
    // snapshots turn-1..turn-(turn+1) — and the source dir is pruned right
    // below, so those snapshots must be linked into the child dir first.
    let inheritedSnapshots = 0;
    let inheritNote;
    try {
      const outcome = await inheritSnapshots(env, sessionId, childId, turn + 1);
      inheritedSnapshots = outcome.inherited;
      if (outcome.error !== undefined) inheritNote = 'snapshot inherit failed: ' + outcome.error;
    } catch (error) {
      inheritNote = 'snapshot inherit failed: ' + String(error);
    }
    emitPhase({ phase: 'inherit', inheritedSnapshots });
    // The source session is superseded: archive it so it leaves the sidebar
    // and cannot be resumed alongside the new branch (its later turns' file
    // changes were already undone by the code rollback). Archiving is durable
    // and keeps workspace accounting. NOTE: the current dsh exposes no
    // unarchive API and every surface hides archived sessions, so an archived
    // session stays out of the UI until a future restore path exists — the
    // rollback itself is the only archiver today.
    // Its turn snapshots are no longer reachable — prune them right away.
    // Exception: a FAILED workspace restore keeps the source live with its
    // snapshots intact, so the user can retry the rollback.
    let archivedSource = false;
    let archiveNote;
    const canArchive = codeRollback.reason !== 'restore-failed';
    try {
      if (env.ctx.workspaceRegistry !== undefined && canArchive) {
        await env.ctx.workspaceRegistry.archiveSession(source.id);
        archivedSource = true;
        await pruneSnapshots(env, source.id);
      } else if (!canArchive) {
        archiveNote = 'archive deferred: workspace restore failed, source kept for retry';
      }
    } catch (error) {
      archiveNote = 'archive failed: ' + String(error);
    }
    emitPhase({ phase: 'archive', archivedSource });
    const body = {
      ok: true,
      sessionId: childId,
      // The source session this branch was cut from and the turn whose
      // completion state the rollback continues from (1-based, maps 1:1 onto
      // the snapshot naming; 0 = before the first turn).
      sourceSessionId: sessionId,
      sourceTurn: turn,
      codeRollback,
      inheritedSnapshots,
      ...(inheritNote === undefined ? {} : { inheritNote }),
      archivedSource,
      sourceCancelled,
      ...(archiveNote === undefined ? {} : { archiveNote }),
      ...(workspaceNote === undefined ? {} : { workspaceNote }),
      ...(nextInput === '' ? {} : { nextInput })
    };
    if (stream) {
      // 阶段行已在执行过程中即时写出（见 emitPhase），这里只发终态。
      res.write(JSON.stringify({ phase: 'done', ...body }) + '\n');
      res.end();
    } else {
      sendJson(res, 200, body);
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
  }
}

/**
 * 注册 webServer 路由并容忍 re-init 时残留的同路径旧路由（停用/重载后旧 handler
 * 已随旧 ctx 失效，probe 会报 inactive context）：命中 duplicate 先清掉旧路由
 * 再重新注册，保证「停用后重新启用」幂等。
 */
function registerWebRoute(ctx, route) {
  // 把路由绑定到插件 ctx 生命周期：停用（ctx dispose）时 cordis 自动执行清理
  // 注销路由，重新启用再注册不会撞 duplicate route（实测停用后旧路由会残留，
  // 旧 handler 已随旧 ctx 失效）。兜底：命中 duplicate 时清掉残留路由后重注册。
  return ctx.effect(() => {
    try {
      return ctx.webServer.register(route);
    } catch (error) {
      if (!/duplicate/.test(String(error?.message ?? error))) throw error;
      const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes;
      if (table && typeof table.delete === 'function') table.delete(route.path);
      return ctx.webServer.register(route);
    }
  });
}

/** 注册全部端点路由（幂等）。apply 装配阶段调用；返回的 disposer 随插件停用
 * 注销（prune-archived 端点为手动存量清理入口）。 */
function registerRoutes(env) {
  const { ctx } = env;
  return [
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/chat-rollback/rollback',
      handler: (req, res) => handleRollback(req, res, env)
    }),
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/chat-rollback/preflight',
      handler: (req, res) => handlePreflight(req, res, env)
    }),
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/chat-rollback/prune-archived',
      handler: async (req, res) => {
        // 手动存量清理入口：回收已归档 + 非标准前缀 + 孤儿快照目录。
        // 响应含 pruned（已归档/非标准）与 orphaned（registry 无记录的孤儿）。
        const result = await pruneSnapshots(env);
        sendJson(res, result.ok ? 200 : 500, result);
      }
    })
  ];
}

export { registerRoutes };
