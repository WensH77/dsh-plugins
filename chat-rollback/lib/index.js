// dsh-plugin-chat-rollback — 入口（装配编排）。
//
// 按域拆分（重构后布局）：
//   lib/excludes.js         tar --exclude 匹配引擎（纯函数，三侧共用 + fuzz）
//   lib/workspace.js        工作区快照 / 哈希清单生成侧（tar/find/zstd/sha256）
//   lib/conflict.js         回滚冲突读侧（manifest 读 + 差异判定 + 冲突状态）
//   lib/session.js          会话事件日志读取与回滚点解析
//   lib/snapshot-store.js   快照目录生命周期（硬链接继承 + 清理回收）
//   lib/routes.js           端点路由（rollback / preflight / prune-archived）
//   lib/index.js            入口：注入声明 + Config + 事件装配（本文件）
//
// 回滚语义（不变）：把会话日志在目标消息处截断（inclusive after seq），新建
// 一个无父谱系的顶层会话（seed = 截断历史），继承源会话 cwd / agent preset，
// 加入源 workspace，并把该消息文本预填进新会话输入框。源会话从不被修改——
// dsh 会话是 append-only，回滚 = 在新会话里从这一点继续。
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import z from '@deepseek-ai/schemastery';
import { snapshotWorkspace, writeManifest } from './workspace.js';
import { sessionEvents, turnOf } from './session.js';
import { inheritSnapshots, pruneSnapshots } from './snapshot-store.js';
import { registerRoutes } from './routes.js';

const name = 'chat-rollback';
// NOTE: agentPresets is deliberately NOT injected — in the web profile the
// AgentPresets service lives outside the host realm (sessions mount presets),
// and a hard inject would stall plugin activation forever (see
// dsh-host-apiproxy, which reads it via ctx.get() and degrades gracefully).
const inject = ['webServer', 'sessions', 'agents', 'workspaceRegistry', 'agentDefaultModel'];

// All fields are optional by default in schemastery (fields are optional
// unless marked .required()).
const Config = z.object({
  // Where per-turn workspace snapshots live (default ~/.dsh/chat-rollback-snapshots).
  snapshotDir: z.string(),
  // Paths excluded from snapshots (matched against tar --exclude semantics).
  excludes: z.array(z.string()),
  // Set false to disable turn-level snapshotting entirely.
  snapshotEnabled: z.boolean(),
  // Periodic cleanup interval in ms (default 1h; 0 disables the timer). Reclaims
  // snapshots of archived sessions, non-standard sessions (arena/legacy ids that
  // no longer write snapshots), and orphaned dirs. The manual endpoint
  // POST /chat-rollback/prune-archived always works regardless.
  pruneIntervalMs: z.number()
});

const DEFAULT_EXCLUDES = ['.git', 'node_modules'];

function defaultSnapshotRoot() {
  return join(os.homedir(), '.dsh', 'chat-rollback-snapshots');
}
function apply(ctx, config = {}) {
  const snapRoot = config.snapshotDir ?? defaultSnapshotRoot();
  const excludes = config.excludes ?? DEFAULT_EXCLUDES;
  const snapshotsEnabled = config.snapshotEnabled ?? true;
  const env = { ctx, snapRoot, excludes, snapshotsEnabled };
  const disposers = [];
  // 快照任务按 session 串行：同一会话的 turn-N 快照 + manifest 原子成组完成
  // 后才开始 turn-N+1 的，避免快速连续 turn（steer）下 tar 与 hash 交错读取
  // 正在被 agent 修改的工作区，造成快照/清单不一致。
  const snapshotQueues = new Map();
  const enqueueSnapshot = (sessionId, task) => {
    const prev = snapshotQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(task);
    snapshotQueues.set(sessionId, run.catch(() => {}));
    return run;
  };

  if (snapshotsEnabled) {
    // Turn-level workspace snapshots: at every turn/start we capture the cwd
    // state (which is exactly the state after the previous turn finished), so
    // rollback can restore "after turn K" from snapshot turn K+1.
    const onSessionEvent = (session, event) => {
      const turn = event.data?.turn;
      const cwd = session?.header?.cwd;
      if (typeof turn !== 'number' || typeof cwd !== 'string' || cwd === '') return;
      // 只给标准 dsh 会话（session-<uuid>）写快照：arena 对局会话、旧格式 id
      // 不是回滚目标，快照只会白占磁盘，且清理侧也只认 session- 前缀——写侧
      // 与清理侧保持同一前缀，杜绝"写了清不掉"的不对称（arena 曾累积 400MB+）。
      if (!session.id.startsWith('session-')) return;
      // Archived sessions are hidden and their snapshot dirs are pruned on
      // archive — skip, so a still-running archived session does not keep
      // re-creating snapshot files.
      const archived = env.ctx.workspaceRegistry?.archivedSessionIds;
      if (archived !== undefined && archived.includes(session.id)) return;
      const dir = join(snapRoot, session.id);
      if (event.type === 'turn/start') {
        // Full-tree snapshot + per-file hash manifest = state AFTER the previous
        // turn (rollback restores this via the turn-(turn+1) naming).
        const target = join(dir, 'turn-' + turn + '.tar.zst');
        const manifest = join(dir, 'turn-' + turn + '.files.json');
        // The target can pre-exist only through inheritance (rollback/fork
        // children). Keep the inherited file: it holds the accurate ancestor
        // state, while the shared cwd may have moved on by the child's first
        // turn. Turns never repeat within a session, so nothing legitimate is
        // ever skipped; size>0 guards against partial files（原子写后目标文件
        // 只会在 rename 完成后出现）。
        enqueueSnapshot(session.id, async () => {
          const complete = await fs.stat(target).then((st) => st.size > 0).catch(() => false);
          if (complete) return { ok: true, skipped: true };
          const snap = await snapshotWorkspace(cwd, target, excludes);
          if (!snap.ok) return snap;
          await writeManifest(cwd, manifest, excludes); // best-effort, ignored on failure
          return snap;
        }).then((result) => {
          if (result?.ok) ctx.logger.info('chat-rollback: snapshot turn ' + turn + ' of ' + session.id + (result.skipped ? ' (inherited, kept)' : ''));
          else ctx.logger.warn('chat-rollback: snapshot failed for turn ' + turn + ': ' + String(result?.stderr ?? '').slice(0, 200));
        }).catch((error) => {
          ctx.logger.warn('chat-rollback: snapshot error: ' + String(error));
        });
      } else if (event.type === 'turn/end') {
        // Post-turn hash manifest = state AFTER this turn = this session's last
        // write, the reference the conflict preflight compares against. Never
        // inherited (a child's own turns regenerate it), so the skip guard only
        // prevents a duplicate turn/end from overwriting a fresh manifest.
        const endManifest = join(dir, 'turn-' + turn + '.end.files.json');
        enqueueSnapshot(session.id, async () => {
          const complete = await fs.stat(endManifest).then((st) => st.size > 0).catch(() => false);
          if (complete) return { ok: true, skipped: true };
          const result = await writeManifest(cwd, endManifest, excludes);
          return result.ok ? { ok: true } : result;
        }).then((result) => {
          if (result?.ok) ctx.logger.info('chat-rollback: end-manifest turn ' + turn + ' of ' + session.id + (result.skipped ? ' (kept)' : ''));
          else ctx.logger.warn('chat-rollback: end-manifest failed for turn ' + turn + ': ' + String(result?.message ?? '').slice(0, 200));
        }).catch((error) => {
          ctx.logger.warn('chat-rollback: end-manifest error: ' + String(error));
        });
      }
    };
    disposers.push(ctx.on('session/event', onSessionEvent));
  }

  // Fork snapshot inheritance: a forked session (host session.fork) carries
  // parentSession WITHOUT origin/delegationDepth — subagent children carry
  // origin:"subagent" and are excluded, and rollback children (no
  // parentSession) inherit inside handleRollback. The fork's seed covers the
  // parent's turns 1..K, so link the parent's turn-1..turn-(K+1) snapshots
  // into the fork's dir; a rollback inside the fork to a seeded message then
  // still finds its code snapshot. NOTE: this callback must never throw
  // synchronously — a throwing session/created listener rolls the session
  // attach back (dsh-session announce) — the body is async and
  // rejection-contained.
  const onSessionCreated = async (session) => {
    try {
      const header = session?.header;
      if (header?.parentSession === undefined || header.origin !== undefined || header.delegationDepth !== undefined) return;
      if (typeof header.cwd !== 'string' || header.cwd === '') return;
      // fork 前缀长度：alpha.4 以 session.inheritedEventCount（精确、持久）为准，
      // rc 宿主仍记录 header.seedLength。
      const seedCount = typeof session.inheritedEventCount === 'number'
        ? session.inheritedEventCount
        : header.seedLength;
      if (typeof seedCount !== 'number') return;
      const maxTurn = turnOf(sessionEvents(session), seedCount - 1) + 1;
      const outcome = await inheritSnapshots(env, header.parentSession, session.id, maxTurn);
      if (outcome.error !== undefined) {
        ctx.logger.warn('chat-rollback: fork snapshot inherit failed for ' + session.id + ': ' + outcome.error);
      } else if (outcome.inherited > 0) {
        ctx.logger.info('chat-rollback: fork ' + session.id + ' inherited ' + outcome.inherited + ' snapshots from ' + header.parentSession);
      }
    } catch (error) {
      ctx.logger.warn('chat-rollback: fork snapshot inherit error: ' + String(error));
    }
  };
  disposers.push(ctx.on('session/created', onSessionCreated));

  for (const dispose of registerRoutes(env)) disposers.push(dispose);

  // 定时兜底清理：workspaceRegistry 无归档事件可监听（只有 setState），手动
  // 归档的会话快照此前只能等下次 rollback 才被惰性清理——加周期扫描，让
  // 磁盘占用只涨不落的情况自动收敛。pruneIntervalMs 为 0 时禁用（仍可手动
  // 调端点）。清理失败仅告警，不阻断对话。
  if (config.pruneIntervalMs !== 0) {
    const interval = config.pruneIntervalMs ?? 60 * 60 * 1000;
    const timer = setInterval(() => {
      pruneSnapshots(env)
        .then((result) => {
          const reclaimed = (result?.pruned?.length ?? 0) + (result?.orphaned?.length ?? 0);
          if (reclaimed > 0) {
            ctx.logger.info('chat-rollback: periodic prune reclaimed ' + reclaimed + ' snapshot dir(s)');
          }
        })
        .catch((error) => ctx.logger.warn('chat-rollback: periodic prune failed: ' + String(error)));
    }, interval);
    timer.unref?.();
    disposers.push(() => clearInterval(timer));
  }

  return () => {
    snapshotQueues.clear();
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
