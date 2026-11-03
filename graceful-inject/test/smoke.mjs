// graceful-inject 宿主端 smoke：用假 ctx 驱动两个功能模块，不起宿主进程。
//
// 覆盖：
//   1) 功能一 resume：最后一条 turn/end 的读取、恢复时的判定、运行中跳过、去重、超时放弃；
//      运行标记（turn/start、turn/end）与启动扫描（读磁盘日志确认未收尾 → 后台接管）；
//   2) 功能二 supervise：开关关闭、方法不对、会话 id 畸形、没有活跃 Agent、不可信页面、
//      正常注入与落盘；
//   3) 两个消息构造器的正文与来源标记；
//   4) 配置 schema 的默认值，以及 apply 的装配面（哪些端点/监听被注册）；
//   5) 信任判定：优先用宿主 connection.isTrusted，没有该服务时回落 loopback。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../lib/index.js';
import {
  BODY,
  BOOT_SCAN_DELAY_MS,
  continueMessage,
  createMarkerStore,
  createResumeController,
  dshHomePath,
  hasOpenTurn,
  isProcessAlive,
  lastTurnEndReason,
  MARKER_DIR,
  markerDirectory,
  scanLeftoverMarkers,
  TEXT as RESUME_TEXT
} from '../lib/resume.js';
import { createStateHandler, createSuperviseHandler, isLoopbackRequest, NOTICE_PREFIX, superviseMessage, SUPERVISE_TEXT, trustedRequest } from '../lib/supervise.js';
import { SOURCE_KIND } from '../lib/source.js';

// 运行标记会写到 <DSH_HOME>/graceful-inject/running：整个 smoke 用临时目录隔离真实 ~/.dsh。
const markerHome = mkdtempSync(join(tmpdir(), 'graceful-inject-smoke-'));
process.env.DSH_HOME = markerHome;

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('ok   ' + name);
  } else {
    failed += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
  }
}

/** 假 ctx：可控的 agents 表、记录、以及手动推进的 timer 队列。 */
function makeCtx(services = {}) {
  const seen = { followups: [], steers: [], cancels: [], flushes: 0, warns: [], infos: [] };
  const timers = [];
  const agents = new Map();
  const ctx = {
    logger: {
      warn: (text) => seen.warns.push(text),
      info: (text) => seen.infos.push(text)
    },
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    sessions: {
      flush: async () => {
        seen.flushes += 1;
        return true;
      }
    },
    timeout: (fn, _ms) => {
      timers.push(fn);
      return () => {};
    },
    get: (name) => services[name]
  };
  return { ctx, seen, timers, agents };
}

/** 假 req/res：handler 只用到 method / url / socket.remoteAddress 与 writeHead / end。 */
function makeExchange(method, url, remoteAddress = '127.0.0.1') {
  const out = { status: 0, headers: null, body: null };
  const res = {
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(text) {
      out.body = JSON.parse(text);
    }
  };
  return { req: { method, url, socket: { remoteAddress } }, res, out };
}

/** 推进 timer 队列（模拟时间流逝），逐个执行到队列空或达到上限。 */
function drain(timers, rounds = 50) {
  for (let i = 0; i < rounds; i += 1) {
    const next = timers.shift();
    if (next === undefined) return i;
    next();
  }
  return rounds;
}

/** 事件构造简写。 */
const start = (turn) => ({ type: 'turn/start', data: { turn } });
const end = (turn, kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } });

/** 假 session：带上要断言的事件序列。 */
function makeSession(events, header = {}) {
  return { id: 'fake-session', header, ownEvents: () => events };
}

/** 假 agent：followup / steer / cancel 分开记录，断言「用错了入口」时不会被掩盖。 */
function makeAgent({ events = [], header = {}, status = 'idle', seen } = {}) {
  return {
    id: 's1',
    status,
    session: makeSession(events, header),
    followup: (message) => seen?.followups.push(message),
    steer: (message) => seen?.steers.push(message),
    cancel: (cause, options) => seen?.cancels.push({ cause, options })
  };
}

// ── 0. 配置 schema 默认值 ───────────────────────────────────────────────────
{
  const value = Config({});
  check('config 默认两个功能都开', value.resume === true && value.supervise === true, JSON.stringify(value));
  check('config 默认监工文本是那句', value.superviseText === SUPERVISE_TEXT, JSON.stringify(value.superviseText));
  const off = Config({ resume: false, supervise: false });
  check('config 可以各自关掉', off.resume === false && off.supervise === false, JSON.stringify(off));
  const custom = Config({ superviseText: '自定义监工' });
  check('config 接受运行时自定义监工文本', custom.superviseText === '自定义监工', JSON.stringify(custom.superviseText));
}

// ── 1. resume · lastTurnEndReason ───────────────────────────────────────────
{
  check('正常结束 → completed', lastTurnEndReason(makeSession([start(1), end(1, 'completed')])) === 'completed');
  check('崩溃恢复 → interrupted', lastTurnEndReason(makeSession([start(1), end(1, 'completed'), start(2), end(2, 'interrupted')])) === 'interrupted');
  check('人为停止 → aborted', lastTurnEndReason(makeSession([start(1), end(1, 'aborted')])) === 'aborted');
  check('最后一轮未结束 → undefined', lastTurnEndReason(makeSession([start(1), end(1, 'completed'), start(2)])) === undefined);
  check('空日志 → undefined', lastTurnEndReason(makeSession([])) === undefined);
  check('没有 ownEvents → undefined', lastTurnEndReason({}) === undefined);
  check('空会话不炸', lastTurnEndReason(undefined) === undefined);
}

// ── 2. 两个功能的文本与来源标记 ─────────────────────────────────────────────
{
  const resume = continueMessage();
  check('续跑正文与监工共用同一句来源前缀', resume?.content?.[0]?.text === BODY && BODY === NOTICE_PREFIX + RESUME_TEXT, JSON.stringify(resume?.content));
  check('续跑正文以来源说明开头', resume?.content?.[0]?.text?.startsWith('这条通知来自插件「优雅注入」'), JSON.stringify(resume?.content?.[0]?.text));
  check('续跑正文仍是「继续」', RESUME_TEXT === '继续' && BODY === NOTICE_PREFIX + '继续', JSON.stringify(BODY));
  check('续跑来源是 graceful-inject 而不是 user', resume?.source?.kind === SOURCE_KIND && SOURCE_KIND === 'graceful-inject', JSON.stringify(resume?.source));
  check('续跑带 notice 摘要', resume?.source?.form === 'notice' && resume?.source?.summary === BODY);

  const supervise = superviseMessage();
  check('监工正文逐字匹配', supervise?.content?.[0]?.text === NOTICE_PREFIX + '不要停止你现在手头的事情，汇报当前任务进度', JSON.stringify(supervise?.content));
  check('监工正文开头声明来源', supervise?.content?.[0]?.text?.startsWith('这条通知来自插件「优雅注入」'), JSON.stringify(supervise?.content?.[0]?.text));
  check('监工正文常量一致', SUPERVISE_TEXT === '不要停止你现在手头的事情，汇报当前任务进度');
  check('监工来源是 graceful-inject', supervise?.source?.kind === SOURCE_KIND, JSON.stringify(supervise?.source));
  check('监工带 notice 摘要', supervise?.source?.form === 'notice' && typeof supervise?.source?.summary === 'string');
}

// ── 3. resume · 恢复时判定：interrupted 才续跑 ─────────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createResumeController(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'interrupted')], seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  await Promise.resolve();
  check('interrupted 会话续跑', seen.followups.length === 1, String(seen.followups.length));
  check('续跑走 followup，不走 steer', seen.followups.length === 1 && seen.steers.length === 0, JSON.stringify({ followups: seen.followups.length, steers: seen.steers.length }));
  check('消息来源是 graceful-inject', seen.followups[0]?.source?.kind === SOURCE_KIND);
  check('投递后 flush', seen.flushes === 1, String(seen.flushes));
}
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createResumeController(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'completed')], seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  check('正常结束的会话不续跑', seen.followups.length === 0, String(seen.followups.length));
}
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createResumeController(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'aborted')], seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  check('人为停止的会话不续跑', seen.followups.length === 0, String(seen.followups.length));
}
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createResumeController(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'interrupted')], header: { origin: 'subagent' }, seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  check('子代理会话不续跑', seen.followups.length === 0, String(seen.followups.length));
}
{
  const { ctx } = makeCtx();
  const controller = createResumeController(ctx);
  let threw;
  try {
    controller.onCreated(undefined);
  } catch (error) {
    threw = error;
  }
  check('空 agent 不炸', threw === undefined);
}

// ── 4. resume · Agent 稍后才就绪 → 轮询后投递 ─────────────────────────────
{
  const { ctx, seen, timers, agents } = makeCtx();
  const controller = createResumeController(ctx);
  controller.arm('s2');
  check('未就绪时先排一个 timer', timers.length === 1, String(timers.length));
  agents.set('s2', makeAgent({ seen }));
  drain(timers);
  await Promise.resolve();
  await Promise.resolve();
  check('就绪后补上投递', seen.followups.length === 1, String(seen.followups.length));
}

// ── 5. resume · Agent 已在运行 → 不打扰 ───────────────────────────────────
{
  const { ctx, seen, timers, agents } = makeCtx();
  const controller = createResumeController(ctx);
  agents.set('s3', makeAgent({ status: 'running', seen }));
  controller.arm('s3');
  drain(timers);
  await Promise.resolve();
  check('运行中不投递', seen.followups.length === 0, String(seen.followups.length));
  check('标记为已处理', controller.fired.has('s3'));
}

// ── 6. resume · 同一会话重复登记 → 只投一条 ────────────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createResumeController(ctx);
  agents.set('s4', makeAgent({ seen }));
  controller.arm('s4');
  controller.arm('s4');
  await Promise.resolve();
  await Promise.resolve();
  check('重复登记只投一条', seen.followups.length === 1, String(seen.followups.length));
}

// ── 7. resume · Agent 一直不就绪 → 放弃并记一条 warn ───────────────────────
{
  const { ctx, seen, timers } = makeCtx();
  const controller = createResumeController(ctx);
  controller.arm('s5');
  drain(timers, 200);
  check('超时后不再排 timer', timers.length === 0, String(timers.length));
  check('超时没有投递', seen.followups.length === 0);
  check('超时记了 warn', seen.warns.some((line) => line.includes('s5')), JSON.stringify(seen.warns));
}

// ── 8. resume · 非法 sessionId 不登记 ──────────────────────────────────────
{
  const { ctx } = makeCtx();
  const controller = createResumeController(ctx);
  controller.arm(undefined);
  controller.arm('');
  check('空 id 不登记', controller.armed.size === 0, String(controller.armed.size));
}

// ── 8b. resume · 未收尾轮次判定与进程存活判定 ───────────────────────────────
{
  check('未收尾的轮次 → true', hasOpenTurn([start(1)]) === true);
  check('已收尾的轮次 → false', hasOpenTurn([start(1), end(1, 'completed')]) === false);
  check('收尾后又开一轮 → true', hasOpenTurn([start(1), end(1, 'interrupted'), start(2)]) === true);
  check('空日志 → false', hasOpenTurn([]) === false);
  check('非数组 → false', hasOpenTurn(undefined) === false);
  check('当前 pid 活着', isProcessAlive(process.pid) === true);
  check('父进程 pid 活着', isProcessAlive(process.ppid) === true);
  check('pid 0 当死进程', isProcessAlive(0) === false);
  check('dshHomePath 用 DSH_HOME', dshHomePath({ DSH_HOME: '/tmp/xx' }, '/home/u') === '/tmp/xx');
  check('dshHomePath 空白回落 ~/.dsh', dshHomePath({ DSH_HOME: '  ' }, '/home/u') === join('/home/u', '.dsh'));
  check('dshHomePath 展开 ~ 并转绝对路径', dshHomePath({ DSH_HOME: '~/xx' }, '/home/u') === join('/home/u', 'xx'));
  check('启动扫描延迟 2.5 秒', BOOT_SCAN_DELAY_MS === 2500, String(BOOT_SCAN_DELAY_MS));
  check('markerDirectory 拼在 DSH_HOME 下', markerDirectory({ DSH_HOME: '/tmp/xx' }, '/home/u') === join('/tmp/xx', MARKER_DIR) && MARKER_DIR === 'graceful-inject/running');
}

// ── 8c. resume · 运行标记读写 ──────────────────────────────────────────────
{
  const { ctx, seen } = makeCtx();
  const directory = join(markerHome, 'markers', MARKER_DIR);
  const store = createMarkerStore(ctx, directory);
  check('标记：写入成功', store.mark('sess-mark') === true);
  const file = join(directory, 'sess-mark');
  check('标记：文件存在且记录 pid', existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid);
  check('标记：list 能读回', store.list().some((entry) => entry.sessionId === 'sess-mark' && entry.pid === process.pid));
  check('标记：目录里没有残留临时文件', store.list().length === 1);
  check('标记：删除成功', store.unmark('sess-mark') === true && existsSync(file) === false);
  check('标记：重复删除不炸', store.unmark('sess-mark') === false);
  check('标记：非法 id 不写', store.mark('../evil') === false && store.mark('') === false);
  check('标记：目录不存在时 list 返回空', createMarkerStore(ctx, join(markerHome, 'not-there', MARKER_DIR)).list().length === 0);
  check('标记：坏文件不炸（pid 归 0）', (() => {
    const bad = createMarkerStore(ctx, join(markerHome, 'bad', MARKER_DIR));
    mkdirSync(bad.directory, { recursive: true });
    writeFileSync(join(bad.directory, 'sess-bad'), '{oops');
    const entries = bad.list();
    return entries.length === 1 && entries[0].pid === 0;
  })());
  check('标记：内容一致时比对删除', (() => {
    const cmp = createMarkerStore(ctx, join(markerHome, 'cmp', MARKER_DIR));
    cmp.mark('sess-cmp');
    const entry = cmp.list().find((item) => item.sessionId === 'sess-cmp');
    const deleted = cmp.unmarkIfUnchanged(entry);
    const after = existsSync(join(cmp.directory, 'sess-cmp'));
    return deleted === true && after === false;
  })());
  check('标记：内容变了（新轮改写）不删', (() => {
    const cmp = createMarkerStore(ctx, join(markerHome, 'cmp2', MARKER_DIR));
    cmp.mark('sess-cmp2');
    const entry = cmp.list().find((item) => item.sessionId === 'sess-cmp2');
    const deleted = cmp.unmarkIfUnchanged({ ...entry, at: entry.at + 1 });
    const after = existsSync(join(cmp.directory, 'sess-cmp2'));
    cmp.unmark('sess-cmp2');
    return deleted === false && after === true;
  })());
  check('标记：不写时没有 warn', seen.warns.length === 0, JSON.stringify(seen.warns));
}

// ── 8d. resume · 启动扫描：读磁盘日志，只接管停在轮次中间的会话 ─────────────
/** 在指定目录写一个「上次进程留下的」运行标记。 */
function writeMarkerFile(directory, sessionId, pid, at = 1) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, sessionId), JSON.stringify({ pid, at }));
}

/** 假 sessionPersistence：open 返回只读句柄。 */
function fakePersistence(logs) {
  return {
    open: async (id) => {
      const entry = logs[id];
      if (entry === undefined) throw new Error('no such session: ' + id);
      return {
        header: entry.header ?? { id, cwd: '/tmp' },
        read: async () => ({ events: entry.events }),
        close: async () => {}
      };
    }
  };
}

/** 假 sessionController：记录接管了哪些会话。 */
function fakeController(resolved, error) {
  return {
    resolveAgent: async (id) => {
      resolved.push(id);
      return error === undefined ? { agent: { id } } : { error };
    }
  };
}

/** 死进程的 pid：用一个超出 pid 上限的数，process.kill 会 ESRCH。 */
const DEAD_PID = 2147483647;

{
  const directory = join(markerHome, 'scan-open', MARKER_DIR);
  writeMarkerFile(directory, 's-open', DEAD_PID);
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-open': { events: [start(1)] } })
  });
  const result = await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：接管停在轮次中间的会话', result.resumed.includes('s-open') && resolved.includes('s-open') && resolved.length === 1, JSON.stringify({ result, resolved }));
  check('启动扫描：成功接管的标记留到新轮次结束', existsSync(join(directory, 's-open')));
}

{
  const directory = join(markerHome, 'scan-done', MARKER_DIR);
  writeMarkerFile(directory, 's-done', DEAD_PID);
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-done': { events: [start(1), end(1, 'completed')] } })
  });
  const result = await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：已收尾的会话不接管并删标记', result.resumed.length === 0 && resolved.length === 0 && existsSync(join(directory, 's-done')) === false, JSON.stringify({ result, resolved }));
}

{
  const directory = join(markerHome, 'scan-live', MARKER_DIR);
  writeMarkerFile(directory, 's-live', DEAD_PID);
  const resolved = [];
  const { ctx, agents } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-live': { events: [start(1)] } })
  });
  agents.set('s-live', makeAgent({ events: [start(1)] }));
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：本进程已有 Agent 的会话不重复接管', resolved.length === 0);
  check('启动扫描：本进程已接管的标记保留', existsSync(join(directory, 's-live')));
}

{
  const directory = join(markerHome, 'scan-alive', MARKER_DIR);
  writeMarkerFile(directory, 's-alive', process.ppid);
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-alive': { events: [start(1)] } })
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：标记 pid 还活着（另一个 dsh 进程在跑）→ 不动', resolved.length === 0);
  check('启动扫描：另一个进程的标记保留', existsSync(join(directory, 's-alive')));
}

{
  const directory = join(markerHome, 'scan-self', MARKER_DIR);
  writeMarkerFile(directory, 's-self', process.pid, Date.now());
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-self': { events: [start(1)] } })
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：本进程本轮写的标记（热重载）不动', resolved.length === 0);
}

{
  // pid 被复用：标记的 pid 等于当前进程，但时间早于本进程启动 → 按上次进程处理。
  const directory = join(markerHome, 'scan-pidreuse', MARKER_DIR);
  writeMarkerFile(directory, 's-reuse', process.pid, 1);
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-reuse': { events: [start(1)] } })
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：pid 复用的旧标记仍会被接管', resolved.includes('s-reuse') && resolved.length === 1, JSON.stringify(resolved));
}

{
  const directory = join(markerHome, 'scan-archived', MARKER_DIR);
  writeMarkerFile(directory, 's-arch', DEAD_PID);
  const resolved = [];
  const { ctx } = makeCtx({ sessionController: fakeController(resolved), sessionPersistence: fakePersistence({}), workspaceRegistry: { archivedSessionIds: ['s-arch'] } });
  const result = await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：归档会话不叫醒并删标记', result.resumed.length === 0 && resolved.length === 0 && existsSync(join(directory, 's-arch')) === false, JSON.stringify(result));
}

{
  const directory = join(markerHome, 'scan-noctrl', MARKER_DIR);
  writeMarkerFile(directory, 's-noctrl', DEAD_PID);
  const { ctx, seen } = makeCtx();
  const result = await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：没有 sessionController 时跳过但不丢标记', result.scanned === 1 && result.resumed.length === 0 && existsSync(join(directory, 's-noctrl')) === true);
  check('启动扫描：跳过时记了 info', seen.infos.some((line) => line.includes('启动扫描跳过')), JSON.stringify(seen.infos));
}

{
  const directory = join(markerHome, 'scan-readerr', MARKER_DIR);
  writeMarkerFile(directory, 's-readerr', DEAD_PID);
  const resolved = [];
  const { ctx, seen } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: { open: async () => { throw new Error('disk gone'); } }
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：读日志失败不接管、保留标记', resolved.length === 0 && existsSync(join(directory, 's-readerr')) === true);
  check('启动扫描：读日志失败记 warn', seen.warns.some((line) => line.includes('读不到会话 s-readerr')), JSON.stringify(seen.warns));
}

{
  const directory = join(markerHome, 'scan-gone', MARKER_DIR);
  writeMarkerFile(directory, 's-gone', DEAD_PID);
  const resolved = [];
  const missing = new Error('session s-gone not found');
  missing.name = 'SessionPersistenceNotFoundError';
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: { open: async () => { throw missing; } }
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：会话已删除（确定性失败）→ 删标记', resolved.length === 0 && existsSync(join(directory, 's-gone')) === false);
}

{
  const directory = join(markerHome, 'scan-resolveerr', MARKER_DIR);
  writeMarkerFile(directory, 's-resolveerr', DEAD_PID);
  const resolved = [];
  const transient = Object.assign(new Error('gateway blew up'), { code: 'gateway/internal' });
  const { ctx, seen } = makeCtx({
    sessionController: fakeController(resolved, transient),
    sessionPersistence: fakePersistence({ 's-resolveerr': { events: [start(1)] } })
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：瞬态接管失败保留标记、记 warn', resolved.length === 1 && existsSync(join(directory, 's-resolveerr')) === true && seen.warns.some((line) => line.includes('接管会话 s-resolveerr 失败') && line.includes('保留标记')), JSON.stringify(seen.warns));
}

{
  const directory = join(markerHome, 'scan-gonesession', MARKER_DIR);
  writeMarkerFile(directory, 's-gonesession', DEAD_PID);
  const resolved = [];
  const missing = Object.assign(new Error('session not found'), { code: 'session/not-found' });
  const { ctx, seen } = makeCtx({
    sessionController: fakeController(resolved, missing),
    sessionPersistence: fakePersistence({ 's-gonesession': { events: [start(1)] } })
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：会话已不存在（确定性失败）删标记', resolved.length === 1 && existsSync(join(directory, 's-gonesession')) === false && seen.warns.some((line) => line.includes('session/not-found') && line.includes('删掉标记')), JSON.stringify(seen.warns));
}

{
  const directory = join(markerHome, 'scan-nocwd', MARKER_DIR);
  writeMarkerFile(directory, 's-nocwd', DEAD_PID);
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-nocwd': { header: { id: 's-nocwd' }, events: [start(1)] } })
  });
  await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：没有 cwd 的会话不接管并删标记', resolved.length === 0 && existsSync(join(directory, 's-nocwd')) === false);
}

{
  const directory = join(markerHome, 'scan-subagent', MARKER_DIR);
  writeMarkerFile(directory, 's-sub', DEAD_PID);
  const resolved = [];
  const { ctx } = makeCtx({
    sessionController: fakeController(resolved),
    sessionPersistence: fakePersistence({ 's-sub': { header: { id: 's-sub', cwd: '/tmp', origin: 'subagent' }, events: [start(1)] } })
  });
  const result = await scanLeftoverMarkers(ctx, createResumeController(ctx), createMarkerStore(ctx, directory));
  check('启动扫描：子代理会话不接管并删标记', result.resumed.length === 0 && resolved.length === 0 && existsSync(join(directory, 's-sub')) === false);
}

// ── 9. supervise · 运行中注入：打断当前步骤 + steer + flush + 200 ──────────
{
  const { ctx, seen, agents } = makeCtx();
  agents.set('sess-1', makeAgent({ status: 'running', seen }));
  const handler = createSuperviseHandler(ctx, { supervise: true, superviseText: '运行时改过的监工文本' });
  const { req, res, out } = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(req, res);
  check('监工返回 200', out.status === 200, String(out.status));
  check('运行中回 mode=interrupt', out.body?.ok === true && out.body?.mode === 'interrupt', JSON.stringify(out.body));
  check('运行中先打断当前步骤（可能卡在长等待工具）', seen.cancels.length === 1, String(seen.cancels.length));
  check('打断原因是用户点击', seen.cancels[0]?.cause?.kind === 'user', JSON.stringify(seen.cancels[0]?.cause));
  check('打断时保留已排队输入', seen.cancels[0]?.options?.keepInbox === true, JSON.stringify(seen.cancels[0]?.options));
  check('监工走 steer 不排队到下一轮', seen.steers.length === 1 && seen.followups.length === 0, JSON.stringify({ steers: seen.steers.length, followups: seen.followups.length }));
  check('注入正文用配置文本', seen.steers[0]?.content?.[0]?.text === NOTICE_PREFIX + '运行时改过的监工文本', JSON.stringify(seen.steers[0]?.content));
  check('200 的 summary 反映实际注入正文', out.body?.summary === NOTICE_PREFIX + '运行时改过的监工文本', JSON.stringify(out.body));
  check('注入后落盘', seen.flushes === 1, String(seen.flushes));
}
{
  // 空闲时不打断，直接 steer 开一轮。
  const { ctx, seen, agents } = makeCtx();
  agents.set('sess-1', makeAgent({ seen }));
  const handler = createSuperviseHandler(ctx, { supervise: true });
  const { req, res, out } = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(req, res);
  check('空闲时回 mode=steer', out.body?.mode === 'steer', JSON.stringify(out.body));
  check('空闲时不打断', seen.cancels.length === 0, String(seen.cancels.length));
  check('没配文本时注入默认那句', seen.steers[0]?.content?.[0]?.text === NOTICE_PREFIX + SUPERVISE_TEXT, JSON.stringify(seen.steers[0]?.content));
}

// ── 10. supervise · 开关关闭 → 409，不注入 ─────────────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  agents.set('sess-1', makeAgent({ seen }));
  const handler = createSuperviseHandler(ctx, { supervise: false });
  const { req, res, out } = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(req, res);
  check('关闭时回 409（防御分支）', out.status === 409 && out.body?.code === 'disabled', JSON.stringify(out.body));
  check('关闭时不注入', seen.steers.length === 0, String(seen.steers.length));
}

// ── 11. supervise · 方法 / 会话 id / Agent 的拒绝面 ────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  agents.set('sess-1', makeAgent({ seen }));
  const handler = createSuperviseHandler(ctx, { supervise: true });

  const get = makeExchange('GET', '/graceful-inject/supervise?session=sess-1');
  await handler(get.req, get.res);
  check('GET 被拒（有副作用，只认 POST）', get.out.status === 405 && get.out.body?.code === 'method', JSON.stringify(get.out.body));

  const missing = makeExchange('POST', '/graceful-inject/supervise');
  await handler(missing.req, missing.res);
  check('缺 session 回 400', missing.out.status === 400 && missing.out.body?.code === 'bad-session', JSON.stringify(missing.out.body));

  const bad = makeExchange('POST', '/graceful-inject/supervise?session=../etc');
  await handler(bad.req, bad.res);
  check('畸形 session 回 400', bad.out.status === 400 && bad.out.body?.code === 'bad-session', JSON.stringify(bad.out.body));

  const cold = makeExchange('POST', '/graceful-inject/supervise?session=gone-1');
  await handler(cold.req, cold.res);
  check('没有活跃 Agent 回 404', cold.out.status === 404 && cold.out.body?.code === 'no-agent', JSON.stringify(cold.out.body));

  const remote = makeExchange('POST', '/graceful-inject/supervise?session=sess-1', '10.0.0.9');
  await handler(remote.req, remote.res);
  check('非本机来源回 403（回落判定）', remote.out.status === 403 && remote.out.body?.code === 'remote', JSON.stringify(remote.out.body));

  check('五种拒绝都没有注入', seen.steers.length === 0, String(seen.steers.length));
}

// ── 12. supervise · 信任判定优先用宿主 connection.isTrusted ────────────────
{
  const untrusted = makeCtx({ connection: { isTrusted: () => false } });
  untrusted.agents.set('sess-1', makeAgent({ seen: untrusted.seen }));
  const handler = createSuperviseHandler(untrusted.ctx, { supervise: true });
  const box = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(box.req, box.res);
  check('connection 判不可信时回 403（即便来源是 loopback）', box.out.status === 403 && box.out.body?.code === 'remote', JSON.stringify(box.out.body));
  check('不可信来源不注入', untrusted.seen.steers.length === 0, String(untrusted.seen.steers.length));

  const trusted = makeCtx({ connection: { isTrusted: () => true } });
  trusted.agents.set('sess-1', makeAgent({ seen: trusted.seen }));
  const okHandler = createSuperviseHandler(trusted.ctx, { supervise: true });
  const ok = makeExchange('POST', '/graceful-inject/supervise?session=sess-1', '192.168.1.5');
  await okHandler(ok.req, ok.res);
  check('connection 判可信时放行（不只看 remoteAddress）', ok.out.status === 200, String(ok.out.status));
}
{
  check('connection 服务缺失时回落 loopback：::1 放行', trustedRequest({ get: () => undefined }, { socket: { remoteAddress: '::1' } }) === true);
  check('connection 服务缺失时回落 loopback：127.0.0.1 放行', trustedRequest({ get: () => undefined }, { socket: { remoteAddress: '127.0.0.1' } }) === true);
  check('connection 服务缺失时回落 loopback：::ffff:127.0.0.1 放行', trustedRequest({ get: () => undefined }, { socket: { remoteAddress: '::ffff:127.0.0.1' } }) === true);
  check('connection 服务缺失时回落 loopback：局域网地址拒绝', trustedRequest({ get: () => undefined }, { socket: { remoteAddress: '192.168.1.5' } }) === false);
  check('loopback 判定：没有 socket 拒绝', isLoopbackRequest({}) === false);
  check('loopback 判定：空地址拒绝', isLoopbackRequest({ socket: {} }) === false);
  check('loopback 判定：IPv6 回环放行', isLoopbackRequest({ socket: { remoteAddress: '::1' } }) === true);
  check('loopback 判定：IPv4 映射回环放行', isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }) === true);
}

// ── 12b. supervise · 10 秒节流 ─────────────────────────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  agents.set('sess-1', makeAgent({ seen }));
  const handler = createSuperviseHandler(ctx, { supervise: true });

  const first = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(first.req, first.res);
  check('节流：第一次放行', first.out.status === 200, String(first.out.status));

  const second = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(second.req, second.res);
  check('节流：10 秒内第二次回 429', second.out.status === 429 && second.out.body?.code === 'throttled', JSON.stringify(second.out.body));
  check('节流：只注入了一条', seen.steers.length === 1, String(seen.steers.length));
  const retryAfter = second.out.body?.retryAfter;
  check('节流：retryAfter 是 1..10 秒', Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 10, String(retryAfter));

  // 时间前进 11 秒：同一会话重新放行。
  const realNow = Date.now;
  Date.now = () => realNow() + 11000;
  try {
    const third = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
    await handler(third.req, third.res);
    check('节流：窗口过去后放行', third.out.status === 200, String(third.out.status));
    check('节流：注入第二条', seen.steers.length === 2, String(seen.steers.length));
  } finally {
    Date.now = realNow;
  }
}
{
  // 不同会话各有自己的窗口。
  const { ctx, seen, agents } = makeCtx();
  agents.set('sess-a', makeAgent({ seen }));
  agents.set('sess-b', makeAgent({ seen }));
  const handler = createSuperviseHandler(ctx, { supervise: true });
  const a = makeExchange('POST', '/graceful-inject/supervise?session=sess-a');
  await handler(a.req, a.res);
  const b = makeExchange('POST', '/graceful-inject/supervise?session=sess-b');
  await handler(b.req, b.res);
  check('节流按会话隔离：另一个会话不受影响', a.out.status === 200 && b.out.status === 200, JSON.stringify({ a: a.out.status, b: b.out.status }));
  check('节流按会话隔离：两条都注入', seen.steers.length === 2, String(seen.steers.length));
}
{
  // 没有 Agent / 不可信的请求不该占用窗口：修好后立刻能注入。
  const { ctx, seen, agents } = makeCtx();
  const handler = createSuperviseHandler(ctx, { supervise: true });
  const cold = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(cold.req, cold.res);
  check('节流：404 不占窗口', cold.out.status === 404 && seen.steers.length === 0, JSON.stringify(cold.out.body));
  agents.set('sess-1', makeAgent({ seen }));
  const now = makeExchange('POST', '/graceful-inject/supervise?session=sess-1');
  await handler(now.req, now.res);
  check('节流：404 之后立刻可注入', now.out.status === 200 && seen.steers.length === 1, JSON.stringify({ status: now.out.status, steers: seen.steers.length }));
}

// ── 13. state · 开关快照 ───────────────────────────────────────────────────
{
  const on = makeExchange('GET', '/graceful-inject/state');
  createStateHandler({ resume: true, supervise: true })(on.req, on.res);
  check('state 报告两个功能都开', on.out.body?.ok === true && on.out.body?.resume === true && on.out.body?.supervise === true, JSON.stringify(on.out.body));
  check('state 带回默认监工文本', on.out.body?.superviseText === SUPERVISE_TEXT, JSON.stringify(on.out.body?.superviseText));

  const custom = makeExchange('GET', '/graceful-inject/state');
  createStateHandler({ resume: true, supervise: true, superviseText: '自定义监工' })(custom.req, custom.res);
  check('state 带回运行时配置的监工文本', custom.out.body?.superviseText === '自定义监工', JSON.stringify(custom.out.body?.superviseText));

  const off = makeExchange('GET', '/graceful-inject/state');
  createStateHandler({ resume: false, supervise: false })(off.req, off.res);
  check('state 报告两个功能都关', off.out.body?.resume === false && off.out.body?.supervise === false, JSON.stringify(off.out.body));

  const wrong = makeExchange('POST', '/graceful-inject/state');
  createStateHandler({ resume: true, supervise: true })(wrong.req, wrong.res);
  check('state 拒绝非 GET', wrong.out.status === 405, String(wrong.out.status));

  const head = makeExchange('HEAD', '/graceful-inject/state');
  createStateHandler({ resume: true, supervise: true })(head.req, head.res);
  check('state 接受 HEAD', head.out.status === 200 && head.out.body?.ok === true, JSON.stringify(head.body));
}

// ── 14. apply · 装配面：开关决定注册哪些端点与监听 ────────────────────────
/** 假插件 ctx：记录 webServer 路由与事件监听；effect 立即执行。 */
function makePluginCtx() {
  const routes = [];
  const listeners = [];
  const disposers = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => {
      const dispose = fn();
      const off = typeof dispose === 'function' ? dispose : () => {};
      disposers.push(off);
      return off;
    },
    on: (event, handler) => {
      listeners.push({ event, handler });
      return () => {};
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      }
    },
    agents: { get: () => undefined, list: () => [] },
    sessions: { flush: async () => {} },
    timeout: () => () => {},
    get: () => undefined,
    // 真实 ctx.inject 返回的是 Fiber（thenable 对象），不是 disposer——别在这里用函数抹平差异。
    inject: () => ({ dispose: () => {} })
  };
  return { ctx, routes, listeners, disposers };
}
{
  const { ctx, routes, listeners } = makePluginCtx();
  apply(ctx, { resume: true, supervise: true });
  check('全开：注册 state 与 supervise 两个端点', routes.map((route) => route.path).sort().join(',') === '/graceful-inject/state,/graceful-inject/supervise', JSON.stringify(routes.map((route) => route.path)));
  check('全开：挂 agent/created 监听', listeners.some((entry) => entry.event === 'agent/created'), JSON.stringify(listeners.map((entry) => entry.event)));
  check('全开：挂 session/event 监听（维护运行标记）', listeners.some((entry) => entry.event === 'session/event'), JSON.stringify(listeners.map((entry) => entry.event)));
}
{
  const { ctx, routes, listeners } = makePluginCtx();
  apply(ctx, { resume: false, supervise: false });
  check('全关：只注册 state 端点', routes.length === 1 && routes[0].path === '/graceful-inject/state', JSON.stringify(routes.map((route) => route.path)));
  check('全关：不挂 agent/created 监听', listeners.length === 0, JSON.stringify(listeners.map((entry) => entry.event)));
}
{
  const { ctx, routes, listeners } = makePluginCtx();
  apply(ctx, { resume: true, supervise: false });
  check('只关 supervise：不注册注入端点', routes.every((route) => route.path !== '/graceful-inject/supervise'), JSON.stringify(routes.map((route) => route.path)));
  check('只关 supervise：续跑监听还在', listeners.some((entry) => entry.event === 'agent/created') && listeners.some((entry) => entry.event === 'session/event'));
}
{
  const { ctx, routes, listeners } = makePluginCtx();
  apply(ctx, { resume: false, supervise: true });
  check('只关 resume：注册两个端点', routes.length === 2, JSON.stringify(routes.map((route) => route.path)));
  check('只关 resume：不挂续跑监听', listeners.length === 0, JSON.stringify(listeners.map((entry) => entry.event)));
}
// apply 注册的 agent/created 监听必须吞掉判定异常（否则会话创建失败）。
{
  const { ctx, routes, listeners } = makePluginCtx();
  const warns = [];
  ctx.logger.warn = (text) => warns.push(text);
  const agents = new Map();
  ctx.agents.get = (id) => agents.get(id);
  apply(ctx, { resume: true, supervise: false });
  const listener = listeners.find((entry) => entry.event === 'agent/created');
  const agent = { id: 's9', session: { header: {}, ownEvents: () => { throw new Error('boom'); } } };
  let threw;
  try {
    await listener.handler({ agent });
  } catch (error) {
    threw = error;
  }
  check('装配后的 agent/created 监听吞异常（不阻断会话创建）', threw === undefined, String(threw));
  check('吞异常时记了 warn', warns.some((line) => line.includes('续跑判定失败')), JSON.stringify(warns));
  check('只注册 state 端点时不耽误其它装配', routes.length === 1 && routes[0].path === '/graceful-inject/state');
}

// 插件卸载：effect disposer 必须能安全调用。真实 ctx.inject 返回 Fiber（thenable 对象），
// 不是 disposer——cleanup 里若把它当函数调用，卸载时会抛 TypeError。
{
  const { ctx, disposers } = makePluginCtx();
  apply(ctx, { resume: true, supervise: true });
  let threw;
  try {
    for (const dispose of disposers) dispose();
  } catch (error) {
    threw = error;
  }
  check('卸载插件时 disposer 不抛错', threw === undefined, String(threw));
}

// 插件在会话运行中被加载/热重载：没有新的 turn/start，也要把正在跑的会话补记进标记。
{
  const hmrHome = join(markerHome, 'hmr');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = hmrHome;
  try {
    const { ctx } = makePluginCtx();
    ctx.agents.list = () => [
      { id: 'sess-live', session: { header: {}, ownEvents: () => [start(1)] } },
      { id: 'sess-idle', session: { header: {}, ownEvents: () => [start(1), end(1, 'completed')] } },
      { id: 'sess-sub', session: { header: { origin: 'subagent' }, ownEvents: () => [start(1)] } }
    ];
    apply(ctx, { resume: true, supervise: false });
    check('热重载补记：正在跑（未收尾）的会话写标记', existsSync(join(hmrHome, MARKER_DIR, 'sess-live')));
    check('热重载补记：已收尾的会话不写标记', existsSync(join(hmrHome, MARKER_DIR, 'sess-idle')) === false);
    check('热重载补记：子代理会话不写标记', existsSync(join(hmrHome, MARKER_DIR, 'sess-sub')) === false);
  } finally {
    process.env.DSH_HOME = previous;
  }
}

// 装配后的 session/event 监听：turn/start 写标记、turn/end 删标记，子代理不碰。
{
  const eventsHome = join(markerHome, 'events');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = eventsHome;
  try {
    const { ctx, listeners } = makePluginCtx();
    apply(ctx, { resume: true, supervise: false });
    const listener = listeners.find((entry) => entry.event === 'session/event');
    listener.handler({ id: 'sess-ev', header: {} }, { type: 'turn/start' });
    check('session/event：turn/start 写运行标记', existsSync(join(eventsHome, MARKER_DIR, 'sess-ev')));
    listener.handler({ id: 'sess-ev', header: {} }, { type: 'turn/end' });
    check('session/event：turn/end 删运行标记', existsSync(join(eventsHome, MARKER_DIR, 'sess-ev')) === false);
    listener.handler({ id: 'sess-sub-ev', header: { origin: 'subagent' } }, { type: 'turn/start' });
    check('session/event：子代理会话不写标记', existsSync(join(eventsHome, MARKER_DIR, 'sess-sub-ev')) === false);
    listener.handler({ id: 'sess-other-ev', header: {} }, { type: 'step/start' });
    check('session/event：非轮次边界事件不碰标记', existsSync(join(eventsHome, MARKER_DIR, 'sess-other-ev')) === false);
  } finally {
    process.env.DSH_HOME = previous;
  }
}

rmSync(markerHome, { recursive: true, force: true });

console.log(failed === 0 ? '\nall checks passed' : '\n' + failed + ' check(s) failed');
process.exit(failed === 0 ? 0 : 1);
