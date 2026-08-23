// dsh-plugin-chat-rollback — node half
// A Cordis plugin for the dsh web profile. Injects the session store, the agent
// factory, the workspace registry, agent presets, and the default model service,
// then serves one endpoint for the browser half:
//
//   POST /chat-rollback/rollback?session=<id>&seq=<n>
//
// Rollback to message n: the session log is cut after seq n (inclusive), and a
// NEW top-level session (no parent lineage) is created with that history as its
// seed, inheriting the source session's cwd and agent preset, joining the source
// workspace, and returning the new session id. The original session is never
// mutated — dsh sessions are append-only, so rollback means continuing from
// this point in a fresh session.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import z from '@deepseek-ai/schemastery';

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
  snapshotEnabled: z.boolean()
});

const DEFAULT_EXCLUDES = ['.git', 'node_modules'];

function defaultSnapshotRoot() {
  return join(os.homedir(), '.dsh', 'chat-rollback-snapshots');
}

function runSh(cmd) {
  return new Promise((done) => {
    execFile('sh', ['-c', cmd], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: error === null, error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** shell 单引号转义（runSh 的命令体是 sh -c 字符串，排除模式必须引起来防通配符被 shell 展开）。 */
function shq(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'";
}

/** 判断相对路径是否命中任一排除项：不含 / 的排除项作为**任意路径段**出现即命中
 * （.git / node_modules 在 cwd 下任意层级都排除，含嵌套仓库；.gitignore 这类
 * 名字不同的工作文件不受影响）；含 / 的排除项按相对路径前缀匹配。
 * hash、tar 快照、恢复剪枝共用同一判定，保证三者对"哪些文件属于工作目录"一致。 */
function isExcluded(rel, excludes) {
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (name === '') continue;
    if (name.includes('/')) {
      if (rel === name || rel.startsWith(name + '/')) return true;
      continue;
    }
    if (rel === name) return true;
    for (const segment of rel.split('/')) {
      if (segment === name) return true;
    }
  }
  return false;
}

/** 由排除项生成 tar --exclude 参数：裸名（bsdtar/libarchive 按 basename 匹配任意
 * 层级）+ 通配形态（GNU tar 需显式匹配嵌套路径）。全部单引号包裹防 shell 展开。 */
function tarExcludeArgs(excludes) {
  const args = [];
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (name === '') continue;
    if (name.includes('/')) {
      args.push('--exclude=' + shq(name));
      continue;
    }
    args.push('--exclude=' + shq(name));
    args.push('--exclude=' + shq('*/' + name));
    args.push('--exclude=' + shq(name + '/*'));
    args.push('--exclude=' + shq('*/' + name + '/*'));
  }
  return args.join(' ');
}

/** Full-tree snapshot of cwd into a tar.zst file (best-effort, excludes applied). */
async function snapshotWorkspace(cwd, targetFile, excludes) {
  await fs.mkdir(dirname(targetFile), { recursive: true });
  const excl = tarExcludeArgs(excludes);
  // 路径一律 shq 单引号包裹：双引号内的 $/反引号会被 shell 展开，路径含
  // 这些字符的工作区会被快照到错误的目标甚至执行命令。
  return runSh('tar -C ' + shq(cwd) + ' ' + excl + ' -cf - . | zstd -q -o ' + shq(targetFile));
}

/** Restore cwd from a tar.zst snapshot: overwrite existing files, then prune
 * files created after the snapshot (so the restore fully undoes later work).
 * Excludes stay untouched (they are not part of the snapshot): the unpack
 * side re-applies them, because a snapshot from an older plugin build (or a
 * foreign archive) may still contain excluded paths — restoring .git would
 * silently rewind the repository, and node_modules must never be clobbered.
 * The prune side applies the same rule twice: file removal skips excluded
 * paths, and the empty-dir cleanup skips both excluded directories and
 * directories present in the snapshot (the latter are restored by the unpack
 * and must survive — a bare `find -type d -empty -delete` deletes both).
 * Destructive. */
async function restoreWorkspace(cwd, snapshotFile, excludes) {
  const excl = tarExcludeArgs(excludes);
  const unpack = await runSh('zstd -dc ' + shq(snapshotFile) + ' | tar ' + excl + ' -C ' + shq(cwd) + ' -xf -');
  if (!unpack.ok) return unpack;
  const listing = await runSh('tar -tf ' + shq(snapshotFile));
  if (!listing.ok) return listing;
  const keptFiles = new Set();
  const keptDirs = new Set();
  for (const line of listing.stdout.split('\n')) {
    const rel = line.replace(/^\.\//, '');
    if (rel === '') continue;
    if (rel.endsWith('/')) keptDirs.add(rel.slice(0, -1));
    else keptFiles.add(rel);
  }
  const files = await runSh('find ' + shq(cwd) + ' -type f');
  if (!files.ok) return files;
  let removed = 0;
  for (const line of files.stdout.split('\n')) {
    const abs = line.trim();
    if (abs === '') continue;
    const rel = abs.slice(cwd.length).replace(/^\//, '');
    if (keptFiles.has(rel)) continue;
    // 排除项（.git/node_modules 任意层级）不在快照里、也绝不剪枝删除
    if (isExcluded(rel, excludes)) continue;
    try {
      await fs.rm(abs, { force: true });
      removed += 1;
    } catch {}
  }
  // 剪枝后留下的空目录：只清「快照里没有、也不命中排除项」的空目录。
  // 快照内本就有（解包已重建）的空目录必须保留——旧实现用
  // `find -type d -empty -delete`，会把它们连同排除项的空目录（如尚未
  // 安装任何包的空 node_modules/）一起删掉，违背"恢复绝不动排除项"。
  // -depth 保证子目录先于父目录被删。
  let removedDirs = 0;
  const dirs = await runSh('find ' + shq(cwd) + ' -depth -type d -empty -print');
  if (dirs.ok) {
    for (const line of dirs.stdout.split('\n')) {
      const abs = line.trim();
      if (abs === '') continue;
      const rel = abs.slice(cwd.length).replace(/^\//, '');
      if (rel === '') continue;
      if (keptDirs.has(rel)) continue;
      if (isExcluded(rel, excludes)) continue;
      try {
        await fs.rmdir(abs);
        removedDirs += 1;
      } catch {}
    }
  }
  return { ok: true, removed, removedDirs };
}

/** Backup the current cwd state before a destructive restore, for manual undo.
 * Excludes mirror the restore's own protection: unpack + file prune + dir
 * cleanup all re-apply excludes, so excluded paths (.git/node_modules at any
 * depth) are never touched by a restore — backing them up would only add
 * gigabytes to the snapshot dir and slow every rollback down. */
async function backupWorkspace(cwd, targetFile, excludes = []) {
  const result = await snapshotWorkspace(cwd, targetFile, excludes);
  return result.ok;
}

/** Stream one file through SHA-256 without buffering it whole — a multi-GB
 * single file (model weights, datasets) must not be loaded into memory on
 * every manifest write / preflight. */
async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

/** Per-file SHA-256 manifest of the tracked (non-excluded) files under cwd:
 * { <relpath>: <hex> }, or null when the walk fails. Exclude semantics mirror
 * restoreWorkspace's prune side (isExcluded), so hashing and pruning agree on
 * which files are "in" the workspace. The find walk prunes excluded directories
 * (.git / node_modules at any depth) so huge metadata trees are neither walked
 * nor hashed. */
async function hashWorkspace(cwd, excludes) {
  // 无括号写法（find 的 -prune 按项短路，等价于括号分组；也避开 JS 字符串里
  // 反斜杠转义被吞的坑）：-name X -prune -o -name Y -prune -o -type f -print
  const pruneArgs = excludes
    .filter((p) => !p.includes('/'))
    .map((p) => '-name ' + shq(p.endsWith('/') ? p.slice(0, -1) : p) + ' -prune');
  const pruneExpr = pruneArgs.length > 0 ? pruneArgs.join(' -o ') + ' -o ' : '';
  const files = await runSh('find ' + shq(cwd) + ' ' + pruneExpr + '-type f -print');
  if (!files.ok) return null;
  const map = {};
  for (const line of files.stdout.split('\n')) {
    const abs = line.trim();
    if (abs === '') continue;
    const rel = abs.slice(cwd.length).replace(/^\//, '');
    if (rel === '' || rel.endsWith('/')) continue;
    if (isExcluded(rel, excludes)) continue;
    try {
      map[rel] = await sha256File(abs);
    } catch {}
  }
  return map;
}

/** Write a per-file hash manifest atomically (tmp + rename); best-effort. */
async function writeManifest(cwd, manifestFile, excludes) {
  const map = await hashWorkspace(cwd, excludes);
  if (map === null) return { ok: false };
  await fs.mkdir(dirname(manifestFile), { recursive: true });
  const tmp = manifestFile + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(map), 'utf8');
  await fs.rename(tmp, manifestFile);
  return { ok: true };
}

/** Read a manifest into { relpath: hash }, or null when missing/corrupt.
 * 传入 excludes 时剔除被排除的条目：升级前旧快照/清单可能记录了 .git 等路径，
 * 与修复后的新清单对比会产生假冲突，统一在载入时过滤掉。 */
async function loadManifest(file, excludes = []) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (excludes.length > 0) {
      for (const key of Object.keys(parsed)) {
        if (isExcluded(key, excludes)) delete parsed[key];
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function fsTargetExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Link the source session's turn snapshots up to maxTurn into the child
 * session's snapshot dir, so a further rollback inside the child to a seeded
 * message (turn T <= maxTurn-1) still finds turn-(T+1). Hardlinks share blocks
 * (zero-copy); falls back to copyFile across filesystems. Idempotent: a
 * missing source dir or an already-present target is a no-op. */
async function inheritSnapshots(env, sourceId, childId, maxTurn) {
  const sourceDir = join(env.snapRoot, sourceId);
  const childDir = join(env.snapRoot, childId);
  let entries;
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return { inherited: 0 };
  }
  let inherited = 0;
  try {
    await fs.mkdir(childDir, { recursive: true });
    for (const entry of entries) {
      // Inherit the full-tree snapshot and its start manifest (state AFTER the
      // previous turn). End manifests (turn-N.end.files.json) are session-local
      // "last write" records regenerated by each session's own turn/end, so they
      // are deliberately excluded here.
      const m = /^turn-(\d+)\.(?:tar\.zst|files\.json)$/.exec(entry);
      if (m === null) continue;
      const num = Number(m[1]);
      if (!Number.isInteger(num) || num < 1 || num > maxTurn) continue;
      const dst = join(childDir, entry);
      if (await fsTargetExists(dst)) continue;
      const src = join(sourceDir, entry);
      try {
        await fs.link(src, dst);
      } catch {
        await fs.copyFile(src, dst);
      }
      inherited += 1;
    }
    return { inherited };
  } catch (error) {
    return { inherited, error: String(error?.message ?? error) };
  }
}

/** Delete snapshots (and recovery backups) of sessions that have been archived.
 * Runs lazily from handleRollback and via POST /chat-rollback/prune-archived. */
async function pruneArchivedSnapshots(env, sessionIdHint) {
  try {
    const archived = new Set(env.ctx.workspaceRegistry?.archivedSessionIds ?? []);
    if (sessionIdHint !== undefined && !archived.has(sessionIdHint)) return { ok: true, pruned: [] };
    let entries;
    try {
      entries = await fs.readdir(env.snapRoot);
    } catch {
      return { ok: true, pruned: [] };
    }
    const pruned = [];
    for (const entry of entries) {
      if (!entry.startsWith('session-')) continue;
      if (sessionIdHint !== undefined && entry !== sessionIdHint) continue;
      if (sessionIdHint === undefined && !archived.has(entry)) continue;
      try {
        await fs.rm(join(env.snapRoot, entry), { recursive: true, force: true });
        pruned.push(entry);
      } catch (error) {
        env.ctx.logger?.warn?.('chat-rollback: prune failed for ' + entry + ': ' + String(error));
      }
    }
    return { ok: true, pruned };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/** Turn number owning seq: the nearest preceding turn/start event's data.turn. */
function turnOf(events, seq) {
  let turn = 0;
  for (const event of events) {
    if (event.seq > seq) break;
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn;
  }
  return turn;
}

/** Resolve a rollback request to its target: the cut point, the turn whose
 * completion state the rollback continues from (the restore snapshot is
 * turn-(turn+1)), and the next-input prefill. Shared by the preflight conflict
 * check and the real rollback so the two can never disagree on the point.
 *
 * Two semantics, picked by the target event type:
 *  - user/message target: "roll back to BEFORE this message". The seed ends at
 *    the last completed turn (or queued message) before it, and the message's
 *    own text becomes the new session's draft prefill. A still-open turn (the
 *    user steered mid-run) is trimmed away so the seed never carries a partial
 *    turn.
 *  - assistant-message target (legacy): cut right after the target, then fold
 *    in the target turn's closing events (step/end, turn/end) when they
 *    immediately follow — a rollback onto the turn's LAST assistant message
 *    must not leave that turn unclosed in the new session.
 */
function resolveRollbackTarget(events, seq) {
  const targetEvent = events[seq];
  const beforeMessage = targetEvent?.type === 'user/message';
  let cut;
  if (beforeMessage) {
    cut = seq;
    while (cut > 0 && events[cut - 1].type !== 'turn/end' && events[cut - 1].type !== 'user/message') cut -= 1;
  } else {
    cut = seq + 1;
    const targetTurn = turnOf(events, seq);
    while (
      cut < events.length &&
      (events[cut].type === 'step/end' || events[cut].type === 'turn/end') &&
      events[cut].data?.turn === targetTurn
    ) {
      cut += 1;
    }
  }
  // Keep the session header event when the cut lands before every event
  // (rollback before the very first user message = a fresh start).
  const seed = cut === 0 && events.length > 0 ? events.slice(0, 1) : events.slice(0, cut);
  let turn;
  if (beforeMessage) {
    turn = 0;
    for (const ev of seed) {
      if (ev.type === 'turn/end' && typeof ev.data?.turn === 'number' && ev.data.turn > turn) turn = ev.data.turn;
    }
  } else {
    turn = turnOf(events, seq);
  }
  let nextInput = '';
  if (beforeMessage) {
    const blocks = targetEvent?.data?.content;
    if (Array.isArray(blocks)) {
      nextInput = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
    }
  } else {
    for (const event of events.slice(cut)) {
      if (event.type !== 'user/message') continue;
      const blocks = event.data?.content;
      if (Array.isArray(blocks)) {
        nextInput = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');
      }
      break;
    }
  }
  return { beforeMessage, cut, seed, turn, nextInput };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

const ABSENT = Symbol('absent');

/** State of a path in a manifest: its hash, ABSENT (missing), or null (manifest
 * unknown). */
function manifestState(map, rel) {
  if (map === null || map === undefined) return null;
  if (Object.prototype.hasOwnProperty.call(map, rel)) return map[rel];
  return ABSENT;
}

/** Highest-numbered manifest matching the given matcher. The matcher returns the
 * turn number for a matching entry, or null. */
async function latestManifestFile(snapDir, matcher) {
  let entries;
  try {
    entries = await fs.readdir(snapDir);
  } catch {
    return null;
  }
  let best = null;
  let bestNum = 0;
  for (const entry of entries) {
    const num = matcher(entry);
    if (num === null || num <= bestNum) continue;
    bestNum = num;
    best = join(snapDir, entry);
  }
  return best;
}

const END_MANIFEST = (entry) => {
  const m = /^turn-(\d+)\.end\.files\.json$/.exec(entry);
  return m === null ? null : Number(m[1]);
};

/** Compare the live tree against the restore target. A file is a conflict when
 * (a) this rollback would revert it (current != target) and (b) it is no longer
 * at the value this session last wrote (current != last-write) — i.e. another
 * session changed it after our last completed turn. */
function computeConflicts(targetMap, lastWriteMap, currentMap) {
  if (targetMap === null || currentMap === null) return { conflict: false, files: [] };
  const paths = new Set([...Object.keys(targetMap), ...Object.keys(currentMap)]);
  if (lastWriteMap !== null && lastWriteMap !== undefined) {
    for (const p of Object.keys(lastWriteMap)) paths.add(p);
  }
  const files = [];
  for (const rel of paths) {
    const t = manifestState(targetMap, rel);
    const c = manifestState(currentMap, rel);
    if (t === c) continue; // unchanged since the restore point -> not reverted
    const l = manifestState(lastWriteMap, rel);
    if (l !== null && l === c) continue; // still at our last write -> ours, safe
    files.push(rel);
  }
  files.sort();
  return { conflict: files.length > 0, files };
}

/** Read-only conflict preflight for a rollback target. Runs BEFORE any restore
 * so the client can gate the confirm (✓) behind a "?" when another session has
 * also changed files this rollback would overwrite. */
async function handlePreflight(req, res, env) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const sessionId = url.searchParams.get('session') ?? '';
    const seqParam = url.searchParams.get('seq') ?? '';
    if (sessionId === '' || !/^\d+$/.test(seqParam)) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'session id and a numeric seq are required' });
      return;
    }
    const source = env.ctx.sessions.get(sessionId);
    if (source === undefined) {
      sendJson(res, 404, { ok: false, code: 'session-not-found', message: 'no live session ' + sessionId });
      return;
    }
    const seq = Number(seqParam);
    if (seq >= source.events.length) {
      sendJson(res, 400, { ok: false, code: 'bad-seq', message: 'seq ' + seq + ' is beyond the session log (' + source.events.length + ' events)' });
      return;
    }
    const target = resolveRollbackTarget(source.events, seq);
    const cwd = source.header?.cwd;
    // No snapshot machinery (disabled / fresh / non-cwd) -> nothing to compare,
    // so no conflict; rollback degrades to conversation-only as before.
    if (!env.snapshotsEnabled || typeof cwd !== 'string' || cwd === '') {
      sendJson(res, 200, { ok: true, conflict: false, files: [], reason: 'no-snapshot', sourceTurn: target.turn });
      return;
    }
    // A still-running source is mid-turn: its own in-progress changes are not
    // checkpointed, so they are indistinguishable from another session's. The
    // rollback cancels that agent anyway — skip the gate rather than mislabel
    // its own edits as foreign.
    let running = false;
    try {
      const agent = env.ctx.agents.get(source.id);
      running = agent !== undefined && agent.status === 'running';
    } catch {}
    if (running) {
      sendJson(res, 200, { ok: true, conflict: false, files: [], reason: 'source-running', sourceTurn: target.turn });
      return;
    }
    const snapDir = join(env.snapRoot, sessionId);
    const targetMap = await loadManifest(join(snapDir, 'turn-' + (target.turn + 1) + '.files.json'), env.excludes);
    if (targetMap === null) {
      // Legacy/foreign dirs without manifests: cannot compare, so no gate.
      sendJson(res, 200, { ok: true, conflict: false, files: [], reason: 'no-manifest', sourceTurn: target.turn });
      return;
    }
    // "Our last write" reference: the state this session left the workspace in
    // after its most recent completed turn. An end manifest (turn-N.end)
    // records exactly that. When it is missing (write failure, interrupted
    // session), a start manifest of a LATER turn is an equally valid record —
    // turn/start N captures the state after turn N-1. Only a manifest STRICTLY
    // newer than the restore point counts: the restore-point manifest itself is
    // the target, not our last write, and using it would mislabel every file
    // the session created during the turns being rolled back as a foreign
    // change (the rollback-B-then-A case).
    let lastWriteMap = null;
    let lastWriteProvenance = 'end';
    const endFile = await latestManifestFile(snapDir, END_MANIFEST);
    if (endFile !== null) {
      lastWriteMap = await loadManifest(endFile, env.excludes);
    } else {
      const startFile = await latestManifestFile(snapDir, (entry) => {
        const m = /^turn-(\d+)\.files\.json$/.exec(entry);
        return m === null ? null : (Number(m[1]) > target.turn + 1 ? Number(m[1]) : null);
      });
      if (startFile !== null) {
        lastWriteMap = await loadManifest(startFile, env.excludes);
        lastWriteProvenance = 'start';
      } else {
        lastWriteProvenance = 'unknown';
      }
    }
    const currentMap = await hashWorkspace(cwd, env.excludes);
    let conflict;
    if (lastWriteMap === null) {
      // No record of any state after the restore point (typically a single-turn
      // session whose end manifest never got written — e.g. the very turn that
      // created the file). Current states then cannot be attributed to this
      // session vs. others; flagging every difference would turn each file the
      // session itself created into a false "?" (rollback of session 2, then
      // rollback of session 1, reports no conflict). The restore still writes a
      // recovery backup first, so report clean and let the two-click confirm
      // proceed.
      conflict = { conflict: false, files: [] };
    } else {
      conflict = computeConflicts(targetMap, lastWriteMap, currentMap);
    }
    sendJson(res, 200, {
      ok: true,
      conflict: conflict.conflict,
      files: conflict.files,
      reason: conflict.conflict ? 'conflict' : (lastWriteProvenance === 'unknown' ? 'no-end-manifest' : 'clean'),
      sourceSessionId: sessionId,
      sourceTurn: target.turn
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
  }
}

async function handleRollback(req, res, env) {
  try {
    // Lazy cleanup: snapshots of archived sessions are deleted on rollback.
    pruneArchivedSnapshots(env).catch(() => {});
    const url = new URL(req.url ?? '/', 'http://x');
    const sessionId = url.searchParams.get('session') ?? '';
    const seqParam = url.searchParams.get('seq') ?? '';
    if (sessionId === '' || !/^\d+$/.test(seqParam)) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'session id and a numeric seq are required' });
      return;
    }
    const source = env.ctx.sessions.get(sessionId);
    if (source === undefined) {
      sendJson(res, 404, { ok: false, code: 'session-not-found', message: 'no live session ' + sessionId });
      return;
    }
    const events = source.events;
    const seq = Number(seqParam);
    if (seq >= events.length) {
      sendJson(res, 400, {
        ok: false,
        code: 'bad-seq',
        message: 'seq ' + seq + ' is beyond the session log (' + events.length + ' events)'
      });
      return;
    }
    const { cut, seed, turn, nextInput } = resolveRollbackTarget(events, seq);
    let agentPreset;
    let setup;
    try {
      const presetId = resolveSessionPreset(source);
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
        seedLength: cut,
        ...(agentPreset === undefined ? {} : { agentPreset })
      },
      agentOptions: selection === undefined ? {} : { provider: selection.provider, model: selection.model },
      setup
    });
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
        try {
          await backupWorkspace(cwd, backupFile, env.excludes);
          const restore = await restoreWorkspace(cwd, snapshotFile, env.excludes);
          if (restore.ok) {
            codeRollback = { restored: true, snapshot: 'turn-' + (turn + 1) + '.tar.zst', backup: 'recovery-' + stamp + '.tar.zst' };
          } else {
            codeRollback = { restored: false, reason: 'restore-failed', message: restore.stderr.slice(0, 500) };
          }
        } catch (error) {
          codeRollback = { restored: false, reason: 'restore-failed', message: String(error?.message ?? error).slice(0, 500) };
        }
      }
    }
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
        await pruneArchivedSnapshots(env, source.id);
      } else if (!canArchive) {
        archiveNote = 'archive deferred: workspace restore failed, source kept for retry';
      }
    } catch (error) {
      archiveNote = 'archive failed: ' + String(error);
    }
    sendJson(res, 200, {
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
    });
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

function apply(ctx, config = {}) {
  const snapRoot = config.snapshotDir ?? defaultSnapshotRoot();
  const excludes = config.excludes ?? DEFAULT_EXCLUDES;
  const snapshotsEnabled = config.snapshotEnabled ?? true;
  const env = { ctx, snapRoot, excludes, snapshotsEnabled };
  const disposers = [];

  if (snapshotsEnabled) {
    // Turn-level workspace snapshots: at every turn/start we capture the cwd
    // state (which is exactly the state after the previous turn finished), so
    // rollback can restore "after turn K" from snapshot turn K+1.
    const onSessionEvent = (session, event) => {
      const turn = event.data?.turn;
      const cwd = session?.header?.cwd;
      if (typeof turn !== 'number' || typeof cwd !== 'string' || cwd === '') return;
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
        // ever skipped; size>0 guards against partial files.
        fs.stat(target).then((st) => st.size > 0).catch(() => false).then(async (complete) => {
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
        fs.stat(endManifest).then((st) => st.size > 0).catch(() => false).then((complete) => {
          if (complete) return { ok: true, skipped: true };
          return writeManifest(cwd, endManifest, excludes);
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
      if (typeof header.seedLength !== 'number') return;
      const maxTurn = turnOf(session.events, header.seedLength - 1) + 1;
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

  disposers.push(registerWebRoute(ctx, {
    kind: 'exact',
    path: '/chat-rollback/rollback',
    handler: (req, res) => handleRollback(req, res, env)
  }));
  disposers.push(registerWebRoute(ctx, {
    kind: 'exact',
    path: '/chat-rollback/preflight',
    handler: (req, res) => handlePreflight(req, res, env)
  }));
  disposers.push(registerWebRoute(ctx, {
    kind: 'exact',
    path: '/chat-rollback/prune-archived',
    handler: async (req, res) => {
      const result = await pruneArchivedSnapshots(env);
      sendJson(res, result.ok ? 200 : 500, result);
    }
  }));

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
