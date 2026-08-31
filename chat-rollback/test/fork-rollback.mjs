// dsh-plugin-chat-rollback — fork + rollback test (real dirs, mock ctx).
// Scenarios:
//   A. turn/start snapshots the cwd (excluding .git/node_modules)
//   B. session/created fork children inherit snapshots (hardlinks)
//   C. POST rollback: seed cut, code restore from turn-(K+1), recovery
//      backup, source archive + snapshot prune, nextInput prefill,
//      response carries sourceSessionId/sourceTurn
//   D. legacy snapshot that CONTAINS .git must not rewind the repo
//      (restore re-applies excludes on unpack — regression from live e2e)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir, link, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import plugin from '../lib/index.js';

function run(cmd) {
  return new Promise((done) => {
    execFile('sh', ['-c', cmd], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: error === null, error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 60));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock ctx ----
function makeCtx(workspace, snapRoot, eventsBySession) {
  const sessions = new Map(Object.entries(eventsBySession).map(([id, events]) => [id, {
    id, events,
    header: { cwd: workspace, agentPreset: 'code', seedLength: events.length }
  }]));
  const handlers = new Map();
  const routes = new Map();
  const archived = [];
  const created = [];
  const attachCalls = [];
  const logger = { info() {}, warn() {} };
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    // cordis ctx.effect: runs the callback now, returns its disposer (lib binds
    // webServer routes to the plugin lifecycle through it)
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get() { return undefined; }, // agentPresets unavailable -> graceful degradation
    logger,
    sessions: {
      get(id) { return sessions.get(id); }
    },
    agents: {
      create: async (opts) => {
        created.push(opts);
        sessions.set(opts.sessionId, { id: opts.sessionId, events: opts.seed, header: { cwd: opts.meta.cwd, seedLength: opts.meta.seedLength, agentPreset: opts.meta.agentPreset } });
      },
      get(id) { return sessions.has(id) ? { status: 'idle' } : undefined; }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    workspaceRegistry: {
      list: () => [{
        id: 'ws-test',
        sessionIds: [...sessions.keys()],
        attachSession: async (id) => { attachCalls.push(id); }
      }],
      attachSession: async (id) => { attachCalls.push(id); },
      archiveSession: async (id) => { archived.push(id); },
      archivedSessionIds: archived
    },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => {}; }
    }
  };
  return { ctx, handlers, routes, archived, created, attachCalls };
}

function fakeRes() {
  return {
    status: null, headers: null, body: null, chunks: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { (this.chunks ??= []).push(String(chunk)); },
    end(body) { this.body = body; }
  };
}

// ---- scenario helpers ----
function makeEvents(turns) {
  // turns: array of { turn, user, assistant } — returns minimal event log
  const events = [];
  let seq = 0;
  events.push({ seq: seq++, type: 'request/header', data: {} });
  for (const t of turns) {
    events.push({ seq: seq++, type: 'turn/start', data: { turn: t.turn } });
    events.push({ seq: seq++, type: 'user/message', data: { content: [{ type: 'text', text: t.user }] } });
    events.push({ seq: seq++, type: 'assistant/message', data: { content: [{ type: 'text', text: t.assistant }] } });
    events.push({ seq: seq++, type: 'turn/end', data: { turn: t.turn } });
  }
  return events;
}

test('A+B+C: snapshot, fork inheritance, rollback (code restore + archive + prefill)', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-ws-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-snap-'));
  try {
    // workspace fixtures: .git and node_modules must be excluded from snapshots
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workspace, 'node_modules', 'pkg', 'x.js'), 'dep\n');
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    await writeFile(join(workspace, 'gone.txt'), 'gone\n');

    const srcEvents = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: '继续做X，再检查Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-src';
    const { ctx, handlers, routes, archived, created, attachCalls } = makeCtx(workspace, snapRoot, { [SRC]: srcEvents });
    const dispose = plugin.apply(ctx, { snapshotDir: snapRoot });

    // A: turn/start snapshots
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot exists');
    // snapshot must NOT contain .git / node_modules
    const listing1 = (await run('tar -tf ' + join(snapRoot, SRC, 'turn-1.tar.zst'))).stdout;
    assert.ok(!listing1.includes('.git'), 'snapshot excludes .git: ' + listing1.split('\n').slice(0, 3).join(','));
    assert.ok(!listing1.includes('node_modules'), 'snapshot excludes node_modules');
    // turn/start also writes a per-file hash manifest (state after the previous turn)
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.files.json')).catch(() => null)) !== null), 'turn-1 manifest exists');
    const manifest1 = JSON.parse(await readFile(join(snapRoot, SRC, 'turn-1.files.json'), 'utf8'));
    assert.ok(typeof manifest1['f.txt'] === 'string', 'manifest hashes f.txt');
    assert.ok(manifest1['.git'] === undefined && manifest1['node_modules'] === undefined, 'manifest excludes .git/node_modules');

    // turn/start 2 snapshots the state AFTER turn 1 (before turn 2's work)
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot exists');
    // simulate agent work in turn 2
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    await writeFile(join(workspace, 'new.txt'), 'new\n');
    await rm(join(workspace, 'gone.txt'));

    // B: fork child inherits snapshots via hardlink
    const FORK = 'session-fork';
    const forkSeed = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: '继续做X，再检查Y', assistant: 'done Y' }
    ]);
    const forkSession = { id: FORK, header: { parentSession: SRC, cwd: workspace, seedLength: forkSeed.length }, events: forkSeed };
    for (const h of handlers.get('session/created')) await h(forkSession);
    await sleep(300);
    const srcIno1 = (await stat(join(snapRoot, SRC, 'turn-1.tar.zst'))).ino;
    const forkIno1 = (await stat(join(snapRoot, FORK, 'turn-1.tar.zst'))).ino;
    assert.strictEqual(forkIno1, srcIno1, 'fork snapshot is a hardlink (same inode)');
    const forkEntries = await readdir(join(snapRoot, FORK));
    assert.deepStrictEqual(forkEntries.filter((e) => e.endsWith('.tar.zst')).sort(), ['turn-1.tar.zst', 'turn-2.tar.zst'], 'fork inherits turn-1..2 snapshots');
    assert.deepStrictEqual(forkEntries.filter((e) => e.endsWith('.files.json')).sort(), ['turn-1.files.json', 'turn-2.files.json'], 'fork inherits turn-1..2 hash manifests');

    // C: rollback to turn-1 assistant message (seq 3) -> restore turn-2 snapshot
    const req = { url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' };
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')(req, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(res.status, 200, 'rollback HTTP 200');
    assert.strictEqual(body.ok, true, 'rollback ok');
    assert.strictEqual(body.sourceSessionId, SRC, 'sourceSessionId echoed');
    assert.strictEqual(body.sourceTurn, 1, 'sourceTurn = owning turn');
    assert.strictEqual(body.codeRollback.restored, true, 'code restored from turn-2');
    assert.strictEqual(body.archivedSource, true, 'source archived');
    assert.strictEqual(body.nextInput, '继续做X，再检查Y', 'nextInput joins text blocks after the cut');
    assert.ok(created.length >= 1, 'new session created via agents.create');
    const child = created[created.length - 1];
    assert.strictEqual(child.meta.cwd, workspace, 'child inherits cwd');
    assert.strictEqual(child.meta.seedLength, 5, 'seed cut after turn/end of turn 1');
    assert.deepStrictEqual(child.seed.map((e) => e.seq), [0, 1, 2, 3, 4], 'seed = events 0..4');
    // code state restored: f.txt old content, new.txt pruned, gone.txt back
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt reverted');
    assert.ok((await stat(join(workspace, 'new.txt')).catch(() => null)) === null, 'new.txt pruned');
    assert.strictEqual(await readFile(join(workspace, 'gone.txt'), 'utf8'), 'gone\n', 'gone.txt restored');
    // recovery backup in CHILD snapshot dir
    const childSnapDir = join(snapRoot, body.sessionId);
    const childEntries = await readdir(childSnapDir);
    assert.ok(childEntries.some((e) => e.startsWith('recovery-')), 'recovery backup written: ' + childEntries.join(','));
    // source archived + snapshots pruned
    assert.ok(archived.includes(SRC), 'archiveSession called for source');
    assert.ok((await stat(join(snapRoot, SRC)).catch(() => null)) === null, 'source snapshot dir pruned');
    // workspace attach called for child
    assert.ok(attachCalls.includes(body.sessionId), 'child attached to workspace');
    dispose();
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});


// Real dsh ordering: user/message is logged AFTER its turn's turn/start +
// step/start scaffolding (turn/end -> session/end-seed -> agent/inbox/spliced
// -> turn/start -> step/start -> user/message).
function realOrderEvents() {
  let seq = 0;
  const events = [];
  const push = (type, data) => events.push({ seq: seq++, type, data });
  push('request/header', {});
  push('turn/start', { turn: 1 });
  push('step/start', { turn: 1, step: 1 });
  push('user/message', { content: [{ type: 'text', text: 'do X' }] });
  push('assistant/message', { content: [{ type: 'text', text: 'done X' }] });
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1, reason: { kind: 'completed' } });
  push('session/end-seed', {});
  push('agent/inbox/spliced', { target: 'next-turn', inserted: [] });
  push('turn/start', { turn: 2 });
  push('step/start', { turn: 2, step: 1 });
  push('user/message', { content: [{ type: 'text', text: 'do Y，再检查Z' }] });
  push('assistant/message', { content: [{ type: 'text', text: 'done Y' }] });
  push('step/end', { turn: 2, step: 1 });
  push('turn/end', { turn: 2, reason: { kind: 'completed' } });
  return events; // user message 'do Y，再检查Z' sits at seq 11
}

test('E: user-message rollback — cut BEFORE the message, prefill its own text', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-um-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-um-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = realOrderEvents();
    const SRC = 'session-um';
    const { ctx, handlers, routes, archived, created } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    // snapshots: turn/start 1 and 2 (turn-2 = state after turn 1)
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    // turn-2 work happens after its snapshot
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    // rollback at the user/message seq (11): before-message semantics
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=11' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(res.status, 200, 'HTTP 200');
    assert.strictEqual(body.ok, true, 'ok');
    assert.strictEqual(body.sourceSessionId, SRC, 'source echoed');
    assert.strictEqual(body.sourceTurn, 1, 'sourceTurn = last completed turn (1)');
    assert.strictEqual(body.codeRollback.restored, true, 'code restored from turn-2 (state before the message)');
    assert.strictEqual(body.nextInput, 'do Y，再检查Z', 'prefill = the message own text');
    assert.strictEqual(body.archivedSource, true, 'source archived');
    const child = created[created.length - 1];
    assert.strictEqual(child.meta.seedLength, 7, 'seed ends at turn/end(1)');
    assert.deepStrictEqual(child.seed.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6], 'seed = events 0..6, target message excluded');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt restored to before-message state');
    assert.ok(archived.includes(SRC), 'archive recorded');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

test('F: user-message rollback mid-turn (steer) — open turn trimmed, queued message kept', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-st-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-st-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    // turn 1 complete, then an OPEN turn 2 (do Y queued + partial output),
    // then the steering message — no turn/end(2) anywhere
    const events = [
      { seq: 0, type: 'request/header', data: {} },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'do X' }] } },
      { seq: 4, type: 'assistant/message', data: { content: [{ type: 'text', text: 'done X' }] } },
      { seq: 5, type: 'step/end', data: { turn: 1, step: 1 } },
      { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 7, type: 'session/end-seed', data: {} },
      { seq: 8, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [] } },
      { seq: 9, type: 'turn/start', data: { turn: 2 } },
      { seq: 10, type: 'step/start', data: { turn: 2, step: 1 } },
      { seq: 11, type: 'user/message', data: { content: [{ type: 'text', text: 'do Y，再检查Z' }] } },
      { seq: 12, type: 'assistant/message', data: { content: [{ type: 'text', text: 'partial Y' }] } },
      { seq: 13, type: 'assistant/chunk', data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'more' } } },
      { seq: 14, type: 'user/message', data: { content: [{ type: 'text', text: 'steer now' }] } }
    ];
    const SRC = 'session-st';
    const { ctx, handlers, routes, created } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    // rollback at the steer message (seq 14): open turn trimmed, 'do Y' kept
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=14' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true, 'ok');
    assert.strictEqual(body.sourceTurn, 1, 'sourceTurn = last completed turn (1)');
    assert.strictEqual(body.codeRollback.restored, true, 'code restored from turn-2 (state before the open turn)');
    assert.strictEqual(body.nextInput, 'steer now', 'prefill = steer message text');
    const child = created[created.length - 1];
    assert.strictEqual(child.meta.seedLength, 12, 'seed ends at the queued do Y message');
    const last = child.seed[child.seed.length - 1];
    assert.strictEqual(last.type, 'user/message', 'seed tail = queued message (kept, unanswered)');
    assert.strictEqual(last.data.content[0].text, 'do Y，再检查Z', 'queued message preserved in seed');
    assert.ok(!child.seed.some((e) => e.type === 'assistant/chunk'), 'partial turn output trimmed from seed');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt restored');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

test('D: legacy snapshot containing .git does not rewind the repository', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-git-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-snap-git-'));
  try {
    await mkdir(join(workspace, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(workspace, '.git', 'refs', 'heads', 'main'), 'newhash\n');
    await writeFile(join(workspace, 'f.txt'), 'one\n');

    const events = makeEvents([{ turn: 1, user: 'u', assistant: 'a' }]);
    const LEGACY = 'session-legacy';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [LEGACY]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(LEGACY), { type: 'turn/start', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, LEGACY, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');

    // craft a LEGACY turn-2 snapshot that contains .git (old plugin builds did
    // this) while the workspace still holds the OLD git state and f.txt='one'
    await writeFile(join(workspace, '.git', 'refs', 'heads', 'main'), 'oldhash\n');
    const legacyTar = join(snapRoot, LEGACY, 'turn-2.tar.zst');
    assert.ok((await run('tar -C "' + workspace + '" -cf - . | zstd -q -o "' + legacyTar + '"')).ok, 'legacy tar created');
    // simulate commits after the legacy snapshot
    await writeFile(join(workspace, '.git', 'refs', 'heads', 'main'), 'newhash\n');
    await writeFile(join(workspace, 'f.txt'), 'two\n');

    // rollback to the turn-1 message: restore uses turn-2 (the legacy snapshot)
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + LEGACY + '&seq=2' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.codeRollback.restored, true, 'code restored from legacy snapshot');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt restored');
    assert.strictEqual(await readFile(join(workspace, '.git', 'refs', 'heads', 'main'), 'utf8'), 'newhash\n', '.git NOT rewinded by legacy snapshot');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

test('G: preflight — per-file hash conflict detection', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-pf-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-pf-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-pf';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });

    // turn 1: start (snapshot + manifest) then end (post-turn manifest)
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.files.json')).catch(() => null)) !== null), 'turn-1 start manifest');
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/end', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.end.files.json')).catch(() => null)) !== null), 'turn-1 end manifest');

    // turn 2: start snapshot = state after turn 1 (f.txt still 'one'), then work
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.files.json')).catch(() => null)) !== null), 'turn-2 start manifest');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/end', data: { turn: 2 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.end.files.json')).catch(() => null)) !== null), 'turn-2 end manifest');

    const preflight = async () => {
      const res = fakeRes();
      await routes.get('/chat-rollback/preflight')({ url: '/chat-rollback/preflight?session=' + SRC + '&seq=6' }, res);
      return { body: JSON.parse(res.body), status: res.status };
    };

    // only this session changed f.txt -> current == our last write -> clean
    let r = await preflight();
    assert.strictEqual(r.status, 200, 'preflight HTTP 200');
    assert.strictEqual(r.body.ok, true, 'preflight ok');
    assert.strictEqual(r.body.conflict, false, 'no conflict when only this session edited');
    assert.deepStrictEqual(r.body.files, [], 'no conflict files');
    assert.strictEqual(r.body.sourceTurn, 1, 'sourceTurn = last completed turn (1)');

    // simulate another session editing after turn 2: change f.txt + add new.txt
    await writeFile(join(workspace, 'f.txt'), 'three\n');
    await writeFile(join(workspace, 'new.txt'), 'x\n');
    r = await preflight();
    assert.strictEqual(r.body.ok, true, 'preflight ok (2)');
    assert.strictEqual(r.body.conflict, true, 'conflict flagged after external edits');
    assert.deepStrictEqual(r.body.files, ['f.txt', 'new.txt'], 'conflict lists f.txt and new.txt');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});
test('H: two sessions on one file — rollback B then A, conflict only while B\'s write is live', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-2s-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-2s-snap-'));
  try {
    await writeFile(join(workspace, 'a'), '');

    const A = 'session-a';
    const B = 'session-b';
    const eventsA = makeEvents([{ turn: 1, user: 'A write', assistant: 'A done' }]);
    const eventsB = makeEvents([{ turn: 1, user: 'B write', assistant: 'B done' }]);
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [A]: eventsA, [B]: eventsB });
    plugin.apply(ctx, { snapshotDir: snapRoot });

    // A turn 1: snapshot a="" , then write "123", then end (last-write "123")
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(A), { type: 'turn/start', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, A, 'turn-1.files.json')).catch(() => null)) !== null), 'A turn-1 start manifest');
    await writeFile(join(workspace, 'a'), '123');
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(A), { type: 'turn/end', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, A, 'turn-1.end.files.json')).catch(() => null)) !== null), 'A turn-1 end manifest');

    // B turn 1: snapshot a="123" , then write "456", then end (last-write "456")
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(B), { type: 'turn/start', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, B, 'turn-1.files.json')).catch(() => null)) !== null), 'B turn-1 start manifest');
    await writeFile(join(workspace, 'a'), '456');
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(B), { type: 'turn/end', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, B, 'turn-1.end.files.json')).catch(() => null)) !== null), 'B turn-1 end manifest');

    const preflight = async (sessionId) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/preflight')({ url: '/chat-rollback/preflight?session=' + sessionId + '&seq=2' }, res);
      return JSON.parse(res.body);
    };

    // current a = "456"
    assert.strictEqual(await readFile(join(workspace, 'a'), 'utf8'), '456', 'current a=456');

    // Preflight A: current "456" != A last-write "123" -> conflict
    let pa = await preflight(A);
    assert.strictEqual(pa.ok, true, 'preflight A ok');
    assert.strictEqual(pa.conflict, true, 'A rollback flags conflict while B write is live');
    assert.deepStrictEqual(pa.files, ['a'], 'A conflict lists a');

    // Preflight B: current "456" == B last-write "456" -> clean
    const pb = await preflight(B);
    assert.strictEqual(pb.ok, true, 'preflight B ok');
    assert.strictEqual(pb.conflict, false, 'B rollback has no conflict');
    assert.deepStrictEqual(pb.files, [], 'B conflict list empty');

    // Rollback B: restores B's turn-1 (a="123"), archives B
    const resB = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + B + '&seq=2' }, resB);
    const bodyB = JSON.parse(resB.body);
    assert.strictEqual(bodyB.ok, true, 'B rollback ok');
    assert.strictEqual(await readFile(join(workspace, 'a'), 'utf8'), '123', 'B rollback restored a=123');

    // Preflight A again: current "123" == A last-write "123" -> clean
    pa = await preflight(A);
    assert.strictEqual(pa.ok, true, 'preflight A (2) ok');
    assert.strictEqual(pa.conflict, false, 'A rollback no longer flags conflict after B rolled back');
    assert.deepStrictEqual(pa.files, [], 'A conflict list empty after B rollback');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

test('H2: A CREATES the file — rollback B then A end-to-end (end manifests present)', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-2c-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-2cs-'));
  try {
    // workspace starts EMPTY: A is the creator of test.md (the user scenario:
    // "新增一个test.md" -> another session adds content -> rollback session 2
    // -> rollback session 1)
    const A = 'session-a';
    const B = 'session-b';
    const eventsA = makeEvents([{ turn: 1, user: 'A creates test.md', assistant: 'A done' }]);
    const eventsB = makeEvents([{ turn: 1, user: 'B adds content', assistant: 'B done' }]);
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [A]: eventsA, [B]: eventsB });
    plugin.apply(ctx, { snapshotDir: snapRoot });

    // A turn 1: snapshot (no test.md) -> create test.md="A\n" -> end (last-write "A")
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(A), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, A, 'turn-1.files.json')).catch(() => null)) !== null), 'A turn-1 start manifest');
    await writeFile(join(workspace, 'test.md'), 'A\n');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(A), { type: 'turn/end', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, A, 'turn-1.end.files.json')).catch(() => null)) !== null), 'A turn-1 end manifest');

    // B turn 1: snapshot (test.md="A") -> write "B\n" -> end (last-write "B")
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(B), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, B, 'turn-1.files.json')).catch(() => null)) !== null), 'B turn-1 start manifest');
    await writeFile(join(workspace, 'test.md'), 'B\n');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(B), { type: 'turn/end', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, B, 'turn-1.end.files.json')).catch(() => null)) !== null), 'B turn-1 end manifest');

    const preflight = async (sessionId) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/preflight')({ url: '/chat-rollback/preflight?session=' + sessionId + '&seq=2' }, res);
      return JSON.parse(res.body);
    };
    const rollback = async (sessionId, force) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + sessionId + '&seq=2' + (force ? '&force=1' : '') }, res);
      return JSON.parse(res.body);
    };

    assert.strictEqual(await readFile(join(workspace, 'test.md'), 'utf8'), 'B\n', 'current test.md = B');

    // A preflight while B's write is live -> conflict (current != A last-write)
    let pa = await preflight(A);
    assert.strictEqual(pa.conflict, true, 'A rollback flags conflict while B write is live');
    assert.deepStrictEqual(pa.files, ['test.md'], 'A conflict lists test.md');

    // B preflight -> clean
    const pb = await preflight(B);
    assert.strictEqual(pb.conflict, false, 'B rollback has no conflict');

    // Rollback B: restore to state before B's turn -> test.md back to A's content
    const bodyB = await rollback(B);
    assert.strictEqual(bodyB.ok, true, 'B rollback ok');
    assert.strictEqual(await readFile(join(workspace, 'test.md'), 'utf8'), 'A\n', 'B rollback restored test.md=A');

    // A preflight after B rolled back -> clean: current == A's last write
    pa = await preflight(A);
    assert.strictEqual(pa.conflict, false, 'A no longer conflicts after B rolled back');
    assert.deepStrictEqual(pa.files, [], 'A conflict list empty');

    // Rollback A: 工作区初始为空 → A 的 turn-1 快照为空 → 空快照守卫 409
    // （回滚将清空工作区），确认（force）后执行——test.md（A 创建）被移除
    const guardA = await rollback(A);
    assert.strictEqual(guardA.ok, false, 'A rollback gated by empty-snapshot guard');
    assert.strictEqual(guardA.code, 'empty-snapshot', 'guard code empty-snapshot');
    const bodyA = await rollback(A, true);
    assert.strictEqual(bodyA.ok, true, 'A rollback ok (force)');
    assert.ok((await stat(join(workspace, 'test.md')).catch(() => null)) === null, 'test.md removed by A rollback');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

test('H3: A has NO end manifest (its turn never ended) — rollback B then A reports no false conflict', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-2n-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-2ns-'));
  try {
    const A = 'session-a';
    const B = 'session-b';
    const eventsA = makeEvents([{ turn: 1, user: 'A creates test.md', assistant: 'A done' }]);
    const eventsB = makeEvents([{ turn: 1, user: 'B adds content', assistant: 'B done' }]);
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [A]: eventsA, [B]: eventsB });
    plugin.apply(ctx, { snapshotDir: snapRoot });

    // A turn 1: snapshot + create test.md="A\n", but NO turn/end -> no end manifest
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(A), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, A, 'turn-1.files.json')).catch(() => null)) !== null), 'A turn-1 start manifest');
    await writeFile(join(workspace, 'test.md'), 'A\n');

    // B turn 1: snapshot + write "B\n" + end (B has an end manifest)
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(B), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, B, 'turn-1.files.json')).catch(() => null)) !== null), 'B turn-1 start manifest');
    await writeFile(join(workspace, 'test.md'), 'B\n');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(B), { type: 'turn/end', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, B, 'turn-1.end.files.json')).catch(() => null)) !== null), 'B turn-1 end manifest');

    const preflight = async (sessionId) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/preflight')({ url: '/chat-rollback/preflight?session=' + sessionId + '&seq=2' }, res);
      return JSON.parse(res.body);
    };
    const rollback = async (sessionId, force) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + sessionId + '&seq=2' + (force ? '&force=1' : '') }, res);
      return JSON.parse(res.body);
    };

    // With no end manifest there is no record of A's last write, so the gate
    // cannot attribute test.md to A vs. B. It reports clean (reason
    // no-end-manifest) instead of flagging every file A created as a false "?".
    let pa = await preflight(A);
    assert.strictEqual(pa.ok, true, 'preflight A ok');
    assert.strictEqual(pa.conflict, false, 'no false conflict without end manifest');
    assert.strictEqual(pa.reason, 'no-end-manifest', 'reason explains the missing reference');

    const pb = await preflight(B);
    assert.strictEqual(pb.conflict, false, 'B rollback has no conflict');

    const bodyB = await rollback(B);
    assert.strictEqual(bodyB.ok, true, 'B rollback ok');
    assert.strictEqual(await readFile(join(workspace, 'test.md'), 'utf8'), 'A\n', 'B rollback restored test.md=A');

    // The user-visible case: after B rolled back, A's rollback must NOT report
    // a conflict — the file is back to A's own content (regression: previously
    // flagged test.md as a conflict via the start-manifest fallback).
    pa = await preflight(A);
    assert.strictEqual(pa.conflict, false, 'A reports no conflict after B rolled back');
    assert.deepStrictEqual(pa.files, [], 'A conflict list empty');
    assert.strictEqual(pa.reason, 'no-end-manifest', 'reason stays no-end-manifest');

    // A rollback: 空快照守卫（A 的 turn-1 快照为空，工作区有文件）→ 409，force 后执行
    const guardA = await rollback(A);
    assert.strictEqual(guardA.ok, false, 'A rollback gated by empty-snapshot guard');
    assert.strictEqual(guardA.code, 'empty-snapshot', 'guard code empty-snapshot');
    const bodyA = await rollback(A, true);
    assert.strictEqual(bodyA.ok, true, 'A rollback ok (force)');
    assert.ok((await stat(join(workspace, 'test.md')).catch(() => null)) === null, 'test.md removed by A rollback');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// I: restore's empty-dir cleanup must not delete excluded empty dirs (empty
// node_modules/) nor empty dirs that exist in the snapshot (keep/) — the old
// `find -type d -empty -delete` deleted both. NOTE: node_modules is excluded
// from snapshots, so it can only be PRESERVED (never recreated) by the
// restore; keep/ is tracked and must be recreated from the snapshot.
test('I: restore keeps excluded empty dirs and snapshot empty dirs', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-dir-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-dir-snap-'));
  try {
    await mkdir(join(workspace, 'node_modules'), { recursive: true }); // excluded, EMPTY
    await mkdir(join(workspace, 'keep'), { recursive: true }); // tracked, EMPTY, inside the snapshot
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-dir';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    // turn-2 work: delete the tracked empty dir, LEAVE the excluded empty dir
    // in place, change f.txt — after the restore both dirs must still exist
    await rm(join(workspace, 'keep'), { recursive: true, force: true });
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    // rollback to the turn-1 assistant message (seq 3) -> restore turn-2 snapshot
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.codeRollback.restored, true, 'code restored from turn-2');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt reverted');
    assert.ok((await stat(join(workspace, 'keep')).catch(() => null)) !== null, 'snapshot empty dir keep/ preserved');
    assert.ok((await stat(join(workspace, 'node_modules')).catch(() => null)) !== null, 'excluded empty dir node_modules/ preserved');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// J: the recovery backup must NOT contain excluded paths (.git/node_modules) —
// restore never touches them (unpack + file prune + dir cleanup all re-apply
// excludes), so backing them up only wastes disk and time.
test('J: recovery backup excludes .git/node_modules', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-bak-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-bak-snap-'));
  try {
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workspace, 'node_modules', 'pkg', 'x.js'), 'dep\n');
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-bak';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.codeRollback.restored, true, 'restored');
    const childDir = join(snapRoot, body.sessionId);
    const entries = await readdir(childDir);
    const backup = entries.find((e) => e.startsWith('recovery-'));
    assert.ok(backup !== undefined, 'recovery backup exists: ' + entries.join(','));
    const listing = (await run('tar -tf ' + join(childDir, backup))).stdout;
    assert.ok(!listing.includes('node_modules'), 'backup excludes node_modules');
    assert.ok(!listing.includes('.git'), 'backup excludes .git');
    assert.ok(listing.includes('f.txt'), 'backup still covers tracked files');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// K: a workspace path containing a literal $ segment must survive snapshot and
// restore — shell double quotes would expand "$HOME" and tar the wrong tree.
test('K: workspace path containing $ survives snapshot + restore', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'crb-dollar-'));
  const workspace = join(parent, '$HOME'); // literal $HOME segment (legal on macOS/Linux)
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-dollar-snap-'));
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-dollar';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    // the snapshot must contain the workspace file, not the real $HOME tree
    const listing1 = (await run('tar -tf ' + join(snapRoot, SRC, 'turn-1.tar.zst'))).stdout;
    assert.ok(listing1.includes('f.txt'), 'snapshot captured the workspace: ' + JSON.stringify(listing1.split('\n').slice(0, 3)));
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.codeRollback.restored, true, 'code restored from turn-2');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt reverted');
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// L: snapshotEnabled:false degrades to conversation-only rollback — no snapshot
// dir is created, no workspace change, the session still rolls back.
test('L: snapshotEnabled:false — conversation-only rollback', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-off-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-off-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([{ turn: 1, user: 'do X', assistant: 'done X' }]);
    const SRC = 'session-off';
    const { ctx, handlers, routes, created } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, snapshotEnabled: false });
    for (const h of handlers.get('session/event') ?? []) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    await sleep(150);
    assert.ok((await stat(join(snapRoot, SRC)).catch(() => null)) === null, 'no snapshot dir when disabled');
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=2' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true, 'rollback ok');
    assert.strictEqual(body.codeRollback.restored, false, 'no code restore');
    assert.strictEqual(body.codeRollback.reason, 'no-snapshot', 'reason no-snapshot');
    assert.ok(created.length >= 1, 'session still created');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'workspace untouched');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// M: a failed workspace restore keeps the source session live with its
// snapshots intact so the rollback can be retried (archive deferred).
test('M: restore failure — source kept unarchived for retry', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-rf-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-rf-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-rf';
    const { ctx, handlers, routes, archived } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    // corrupt the turn-2 snapshot -> the restore must fail deterministically
    await writeFile(join(snapRoot, SRC, 'turn-2.tar.zst'), 'not a zstd archive');
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true, 'rollback ok (conversation still rolls back)');
    assert.strictEqual(body.codeRollback.restored, false, 'restore failed');
    assert.strictEqual(body.codeRollback.reason, 'restore-failed', 'reason restore-failed');
    assert.strictEqual(body.codeRollback.rolledBack, true, 'workspace auto-rolled-back from recovery backup');
    assert.strictEqual(body.archivedSource, false, 'source NOT archived');
    assert.ok(!archived.includes(SRC), 'archiveSession not called');
    assert.ok((await stat(join(snapRoot, SRC)).catch(() => null)) !== null, 'source snapshots kept for retry');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// N: snapshot writes are scoped to standard dsh session ids (session-*). arena
// sessions (model-arena) and legacy id formats are not rollback targets — they
// must not get snapshot dirs at all (write side and prune side share one rule).
test('N: write-side prefix filter — non session- sessions get no snapshots', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-filt-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-filt-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([{ turn: 1, user: 'do X', assistant: 'done X' }]);
    const ARENA = 'arena-write-test';
    const SRC = 'session-write-test';
    const { ctx, handlers } = makeCtx(workspace, snapRoot, { [ARENA]: events, [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, pruneIntervalMs: 0 });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(ARENA), { type: 'turn/start', data: { turn: 1 } });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(ARENA), { type: 'turn/end', data: { turn: 1 } });
    await sleep(250);
    assert.ok((await stat(join(snapRoot, ARENA)).catch(() => null)) === null, 'arena session gets no snapshot dir');

    // standard session on the same plugin instance still snapshots
    handlers.get('session/event').forEach((h) => h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } }));
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'standard session still snapshots');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// O: the prune-archived endpoint reclaims (1) archived residue that was never
// lazily cleaned, (2) non-standard snapshot dirs (arena/legacy ids), (3) old
// orphans with no registry record — while keeping live sessions, fresh orphans
// inside the grace window, and non-snapshot dirs (content guard).
test('O: prune-archived endpoint — archived + non-standard + orphan reclamation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-prune-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-prune-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([{ turn: 1, user: 'do X', assistant: 'done X' }]);
    const LIVE = 'session-live';
    const { ctx, handlers, routes, archived } = makeCtx(workspace, snapRoot, { [LIVE]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, pruneIntervalMs: 0 });

    // live session snapshot (must survive the prune)
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(LIVE), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, LIVE, 'turn-1.tar.zst')).catch(() => null)) !== null), 'live snapshot exists');

    // 1) archived residue: marked archived, snapshot dir never pruned
    const ARCHIVED = 'session-archived-residue';
    await mkdir(join(snapRoot, ARCHIVED), { recursive: true });
    await writeFile(join(snapRoot, ARCHIVED, 'turn-1.tar.zst'), 'x');
    archived.push(ARCHIVED);

    // 2) non-standard dir with snapshot content (legacy arena/old-format)
    const ARENA = 'arena-legacy-dir';
    await mkdir(join(snapRoot, ARENA), { recursive: true });
    await writeFile(join(snapRoot, ARENA, 'turn-1.tar.zst'), 'y');

    // 3) old orphan: session- prefix, no registry record, mtime beyond grace
    const ORPHAN = 'session-orphan-old';
    await mkdir(join(snapRoot, ORPHAN), { recursive: true });
    await writeFile(join(snapRoot, ORPHAN, 'turn-1.tar.zst'), 'z');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(join(snapRoot, ORPHAN), old, old);

    // 4) fresh orphan inside the grace window — must be kept
    const FRESH = 'session-orphan-fresh';
    await mkdir(join(snapRoot, FRESH), { recursive: true });
    await writeFile(join(snapRoot, FRESH, 'turn-1.tar.zst'), 'w');

    // 5) non-standard dir WITHOUT snapshot content — content guard must keep it
    const PLAIN = 'plain-dir';
    await mkdir(join(snapRoot, PLAIN), { recursive: true });
    await writeFile(join(snapRoot, PLAIN, 'readme.txt'), 'not a snapshot');

    const res = fakeRes();
    await routes.get('/chat-rollback/prune-archived')({}, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(res.status, 200, 'prune HTTP 200');
    assert.strictEqual(body.ok, true, 'prune ok');

    assert.ok((await stat(join(snapRoot, ARCHIVED)).catch(() => null)) === null, 'archived residue pruned');
    assert.ok((await stat(join(snapRoot, ARENA)).catch(() => null)) === null, 'non-standard snapshot dir reclaimed');
    assert.ok((await stat(join(snapRoot, ORPHAN)).catch(() => null)) === null, 'old orphan reclaimed');
    assert.ok((await stat(join(snapRoot, FRESH)).catch(() => null)) !== null, 'fresh orphan kept (grace)');
    assert.ok((await stat(join(snapRoot, PLAIN)).catch(() => null)) !== null, 'non-snapshot dir kept (content guard)');
    assert.ok((await stat(join(snapRoot, LIVE)).catch(() => null)) !== null, 'live session kept');

    assert.ok(body.pruned.includes(ARCHIVED), 'pruned lists archived residue');
    assert.ok(body.pruned.includes(ARENA), 'pruned lists non-standard dir');
    assert.ok(body.orphaned.includes(ORPHAN), 'orphaned lists the old orphan');
    assert.ok(!body.pruned.includes(FRESH) && !body.orphaned.includes(FRESH), 'fresh orphan not listed');
    assert.ok(!body.pruned.includes(LIVE) && !body.orphaned.includes(LIVE), 'live session not listed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// P: the periodic prune timer reclaims archived residue without any rollback —
// closing the gap where a manually archived session's snapshots waited forever
// for the next rollback to lazily clean them.
test('P: periodic prune — timer reclaims archived residue automatically', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-timer-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-timer-snap-'));
  let dispose;
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([{ turn: 1, user: 'do X', assistant: 'done X' }]);
    const LIVE = 'session-tlive';
    const { ctx, handlers, archived } = makeCtx(workspace, snapRoot, { [LIVE]: events });
    dispose = plugin.apply(ctx, { snapshotDir: snapRoot, pruneIntervalMs: 60 });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(LIVE), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, LIVE, 'turn-1.tar.zst')).catch(() => null)) !== null), 'live snapshot exists');
    // archive the live session: its snapshot dir becomes reclaimable residue
    archived.push(LIVE);
    assert.ok(
      await waitFor(async () => (await stat(join(snapRoot, LIVE)).catch(() => null)) === null, 5000),
      'archived residue auto-pruned by periodic timer'
    );
  } finally {
    dispose?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// Q: '.*' 通配排除——点文件在快照、哈希清单、恢复剪枝三侧一致：任意深度的
// 点文件/点目录不进快照；回滚剪枝绝不删除点文件。回归背景：旧实现只做字面
// 段匹配（isExcluded 不认 '.*'），且旧快照命令把起始点 '.' 归档，tar 侧
// 裸 '.*' 会匹配起始点把整包排除——空快照恢复会把工作区清空。
test('Q: .* wildcard — dotfiles excluded at any depth and protected from prune', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-dot-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-dot-snap-'));
  try {
    await mkdir(join(workspace, '.cache'), { recursive: true });
    await mkdir(join(workspace, 'sub'), { recursive: true });
    await writeFile(join(workspace, '.env'), 'SECRET=1\n');
    await writeFile(join(workspace, '.cache', 'k.txt'), 'k\n');
    await writeFile(join(workspace, 'sub', '.hidden'), 'h\n');
    await writeFile(join(workspace, 'top.txt'), 'one\n');
    await writeFile(join(workspace, 'sub', 'x.txt'), 'x\n');

    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-dot';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, excludes: ['.*'], pruneIntervalMs: 0 });

    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    const listing1 = (await run('tar -tf ' + join(snapRoot, SRC, 'turn-1.tar.zst'))).stdout;
    const members = listing1.split('\n').filter(Boolean);
    assert.ok(!members.includes('./'), 'start point not archived: ' + members.join(','));
    assert.ok(members.includes('./top.txt') && members.includes('./sub/x.txt'), 'non-dot files archived: ' + members.join(','));
    assert.ok(!listing1.includes('.env') && !listing1.includes('.cache') && !listing1.includes('.hidden'), 'dotfiles excluded at any depth');
    const manifest1 = JSON.parse(await readFile(join(snapRoot, SRC, 'turn-1.files.json'), 'utf8'));
    assert.strictEqual(manifest1['.env'], undefined, 'manifest excludes .env');
    assert.strictEqual(manifest1['sub/.hidden'], undefined, 'manifest excludes nested dotfile');
    assert.ok(typeof manifest1['top.txt'] === 'string', 'manifest keeps top.txt');

    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');

    // turn-2 work: change a tracked file, add a new dotfile and a new regular file
    await writeFile(join(workspace, 'top.txt'), 'two\n');
    await writeFile(join(workspace, '.env.new'), 'SECRET=2\n');
    await writeFile(join(workspace, 'new.txt'), 'new\n');

    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true, 'rollback ok');
    assert.strictEqual(body.codeRollback.restored, true, 'code restored');
    assert.strictEqual(await readFile(join(workspace, 'top.txt'), 'utf8'), 'one\n', 'tracked file reverted');
    assert.ok((await stat(join(workspace, 'new.txt')).catch(() => null)) === null, 'new regular file pruned');
    assert.ok((await stat(join(workspace, '.env.new')).catch(() => null)) !== null, 'new dotfile protected from prune');
    assert.strictEqual(await readFile(join(workspace, '.env'), 'utf8'), 'SECRET=1\n', '.env untouched by restore');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// R: 含 / 与通配的排除项在 tar 侧是未锚定语义（嵌套路径同样命中），而旧
// isExcluded 只认顶层前缀/字面段——三侧不一致会让恢复剪枝删掉「tar 已排除、
// JS 却判定未排除」的嵌套文件。本用例锁定修复后的三侧一致性。
test('R: with-slash and wildcard excludes — nested matches on all three sides', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-path-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-path-snap-'));
  try {
    await mkdir(join(workspace, 'sub', 'build', 'output'), { recursive: true });
    await writeFile(join(workspace, 'sub', 'build', 'output', 'n.txt'), 'n\n');
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    await writeFile(join(workspace, 'debug.log'), 'old\n');

    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-path';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, excludes: ['build/output', '*.log'], pruneIntervalMs: 0 });

    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    const listing1 = (await run('tar -tf ' + join(snapRoot, SRC, 'turn-1.tar.zst'))).stdout;
    assert.ok(!listing1.includes('build/output'), 'with-slash exclude matches nested dir on the tar side: ' + listing1.split('\n').filter(Boolean).join(','));
    assert.ok(!listing1.includes('.log'), 'wildcard exclude matches on the tar side');

    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');

    // turn-2 work: add files under excluded paths — prune must NOT delete them
    await writeFile(join(workspace, 'sub', 'build', 'output', 'new.txt'), 'new\n');
    await writeFile(join(workspace, 'app.log'), 'new\n');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    await writeFile(join(workspace, 'plain.txt'), 'new\n');

    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' }, res);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true, 'rollback ok');
    assert.strictEqual(body.codeRollback.restored, true, 'code restored');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'tracked file reverted');
    assert.ok((await stat(join(workspace, 'plain.txt')).catch(() => null)) === null, 'non-excluded new file pruned');
    assert.ok((await stat(join(workspace, 'sub', 'build', 'output', 'new.txt')).catch(() => null)) !== null, 'nested excluded-path file protected from prune');
    assert.ok((await stat(join(workspace, 'app.log')).catch(() => null)) !== null, 'wildcard-excluded file protected from prune');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// S: rollback 二次冲突校验（TOCTOU 收窄）——preflight 与执行之间其他会话的
// 写入在 rollback 时再次检测：无 force → 409 conflict（回到确认态）；force → 执行。
test('S: rollback re-checks conflicts — 409 then force proceeds', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-toc-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-toc-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-toc';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, pruneIntervalMs: 0 });
    // turn1: start+end；turn2: start（恢复点快照 turn-2）+end（last-write）
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.files.json')).catch(() => null)) !== null), 'turn-1 start manifest');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/end', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.end.files.json')).catch(() => null)) !== null), 'turn-1 end manifest');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.files.json')).catch(() => null)) !== null), 'turn-2 start manifest');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/end', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.end.files.json')).catch(() => null)) !== null), 'turn-2 end manifest');
    // preflight 之后、执行之前，另一会话的写入
    await writeFile(join(workspace, 'f.txt'), 'three\n');
    await writeFile(join(workspace, 'new.txt'), 'x\n');

    const rollback = async (force) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' + (force ? '&force=1' : '') }, res);
      return { status: res.status, body: JSON.parse(res.body) };
    };
    const first = await rollback(false);
    assert.strictEqual(first.status, 409, 'rollback HTTP 409');
    assert.strictEqual(first.body.code, 'conflict', '409 code conflict');
    assert.deepStrictEqual(first.body.files, ['f.txt', 'new.txt'], 'conflict lists externally changed files');
    const second = await rollback(true);
    assert.strictEqual(second.status, 200, 'forced rollback HTTP 200');
    assert.strictEqual(second.body.ok, true, 'forced rollback ok');
    assert.strictEqual(second.body.codeRollback.restored, true, 'code restored');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'f.txt restored to the restore point (turn-1 end)');
    assert.ok((await stat(join(workspace, 'new.txt')).catch(() => null)) === null, 'new.txt pruned');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// T: 空快照安全网——恢复点快照为空但工作区非空时，回滚会清空工作区：无 force
// → 409 empty-snapshot（不执行）；force 确认后执行清空。
test('T: empty-snapshot guard — 409 then force wipes workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-emp-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-emp-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-emp';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, pruneIntervalMs: 0 });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    // 把恢复点快照 turn-2 替换成「空 tar 的 zstd」（模拟损坏/回归）：恢复它将清空工作区
    assert.ok((await run('dd if=/dev/zero bs=1024 count=1 2>/dev/null | zstd -qf -o ' + join(snapRoot, SRC, 'turn-2.tar.zst'))).ok, 'empty snapshot written');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    const rollback = async (force) => {
      const res = fakeRes();
      await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3' + (force ? '&force=1' : '') }, res);
      return { status: res.status, body: JSON.parse(res.body) };
    };
    const first = await rollback(false);
    assert.strictEqual(first.status, 409, 'empty-snapshot HTTP 409');
    assert.strictEqual(first.body.code, 'empty-snapshot', '409 code empty-snapshot');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'two\n', 'workspace untouched by the 409');
    const second = await rollback(true);
    assert.strictEqual(second.status, 200, 'forced rollback HTTP 200');
    assert.strictEqual(second.body.ok, true, 'forced rollback ok');
    assert.strictEqual(second.body.codeRollback.restored, true, 'empty snapshot restores ok');
    assert.ok((await stat(join(workspace, 'f.txt')).catch(() => null)) === null, 'workspace wiped by forced empty-snapshot restore');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});

// U: stream=1 的 ndjson 阶段流——阶段行随执行即时出现且顺序固定。防「伪流」
// 回归（0.1.5 初版把所有阶段收集完、在响应末尾一次性写出，客户端收不到实时
// 进度，进度提示退化为完成瞬间的闪烁）。
test('U: stream=1 — phase lines are written live in execution order', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crb-str-'));
  const snapRoot = await mkdtemp(join(tmpdir(), 'crb-str-snap-'));
  try {
    await writeFile(join(workspace, 'f.txt'), 'one\n');
    const events = makeEvents([
      { turn: 1, user: 'do X', assistant: 'done X' },
      { turn: 2, user: 'do Y', assistant: 'done Y' }
    ]);
    const SRC = 'session-str';
    const { ctx, handlers, routes } = makeCtx(workspace, snapRoot, { [SRC]: events });
    plugin.apply(ctx, { snapshotDir: snapRoot, pruneIntervalMs: 0 });
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 1 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-1.tar.zst')).catch(() => null)) !== null), 'turn-1 snapshot');
    for (const h of handlers.get('session/event')) h(ctx.sessions.get(SRC), { type: 'turn/start', data: { turn: 2 } });
    assert.ok(await waitFor(async () => (await stat(join(snapRoot, SRC, 'turn-2.tar.zst')).catch(() => null)) !== null), 'turn-2 snapshot');
    await writeFile(join(workspace, 'f.txt'), 'two\n');
    const res = fakeRes();
    await routes.get('/chat-rollback/rollback')({ url: '/chat-rollback/rollback?session=' + SRC + '&seq=3&stream=1' }, res);
    assert.strictEqual(res.status, 200, 'stream HTTP 200');
    assert.ok(String(res.headers?.['content-type'] ?? '').includes('ndjson'), 'ndjson content-type');
    const lines = (res.chunks ?? []).join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const expected = ['session', 'cancel', 'backup', 'restore', 'inherit', 'archive', 'done'];
    assert.deepStrictEqual(lines.map((l) => l.phase), expected, 'phase lines arrive in execution order');
    const done = lines[lines.length - 1];
    assert.strictEqual(done.ok, true, 'done carries ok');
    assert.strictEqual(done.codeRollback.restored, true, 'done carries codeRollback');
    assert.strictEqual(await readFile(join(workspace, 'f.txt'), 'utf8'), 'one\n', 'restore executed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapRoot, { recursive: true, force: true });
  }
});
