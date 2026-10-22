// rerun-button 宿主端 smoke：用假 ctx 驱动自动续跑控制器，不起宿主进程。
// 覆盖：最后一条 turn/end 的读取、恢复时的判定、运行中跳过、去重、超时放弃。
import { continueMessage, createAutoResume, lastTurnEndReason } from '../lib/index.js';

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
function makeCtx() {
  const seen = { messages: [], flushes: 0, warns: [], infos: [] };
  const timers = [];
  const agents = new Map();
  const ctx = {
    logger: {
      warn: (text) => seen.warns.push(text),
      info: (text) => seen.infos.push(text)
    },
    agents: { get: (id) => agents.get(id) },
    sessions: {
      flush: async () => {
        seen.flushes += 1;
        return true;
      }
    },
    timeout: (fn, _ms) => {
      timers.push(fn);
      return () => {};
    }
  };
  return { ctx, seen, timers, agents };
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

/** 假 agent：记录 followup 收到的消息。 */
function makeAgent({ events = [], header = {}, status = 'idle', seen } = {}) {
  return {
    id: 's1',
    status,
    session: makeSession(events, header),
    followup: (message) => seen?.messages.push(message)
  };
}

// ── 1. lastTurnEndReason ────────────────────────────────────────────────────
{
  check('正常结束 → completed', lastTurnEndReason(makeSession([start(1), end(1, 'completed')])) === 'completed');
  check('崩溃恢复 → interrupted', lastTurnEndReason(makeSession([start(1), end(1, 'completed'), start(2), end(2, 'interrupted')])) === 'interrupted');
  check('人为停止 → aborted', lastTurnEndReason(makeSession([start(1), end(1, 'aborted')])) === 'aborted');
  check('最后一轮未结束 → undefined', lastTurnEndReason(makeSession([start(1), end(1, 'completed'), start(2)])) === undefined);
  check('空日志 → undefined', lastTurnEndReason(makeSession([])) === undefined);
  check('没有 ownEvents → undefined', lastTurnEndReason({}) === undefined);
  check('空会话不炸', lastTurnEndReason(undefined) === undefined);
}

// ── 2. 消息形状 ─────────────────────────────────────────────────────────────
{
  const message = continueMessage();
  check('消息正文是「继续」', message?.content?.[0]?.text === '继续', JSON.stringify(message?.content));
  check('来源是 rerun-button 而不是 user', message?.source?.kind === 'rerun-button', JSON.stringify(message?.source));
  check('带 notice 摘要', message?.source?.form === 'notice' && typeof message?.source?.summary === 'string');
}

// ── 3. 恢复时判定：interrupted 才续跑 ───────────────────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'interrupted')], seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  await Promise.resolve();
  check('interrupted 会话续跑', seen.messages.length === 1, String(seen.messages.length));
  check('消息来源是 rerun-button', seen.messages[0]?.source?.kind === 'rerun-button');
  check('投递后 flush', seen.flushes === 1, String(seen.flushes));
}
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'completed')], seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  check('正常结束的会话不续跑', seen.messages.length === 0, String(seen.messages.length));
}
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'aborted')], seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  check('人为停止的会话不续跑', seen.messages.length === 0, String(seen.messages.length));
}
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  const agent = makeAgent({ events: [start(1), end(1, 'interrupted')], header: { origin: 'subagent' }, seen });
  agents.set('s1', agent);
  controller.onCreated(agent);
  await Promise.resolve();
  check('子代理会话不续跑', seen.messages.length === 0, String(seen.messages.length));
}
{
  const { ctx } = makeCtx();
  const controller = createAutoResume(ctx);
  let threw;
  try {
    controller.onCreated(undefined);
  } catch (error) {
    threw = error;
  }
  check('空 agent 不炸', threw === undefined);
}

// ── 4. Agent 稍后才就绪 → 轮询后投递 ────────────────────────────────────────
{
  const { ctx, seen, timers, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  controller.arm('s2');
  check('未就绪时先排一个 timer', timers.length === 1, String(timers.length));
  agents.set('s2', makeAgent({ seen }));
  drain(timers);
  await Promise.resolve();
  await Promise.resolve();
  check('就绪后补上投递', seen.messages.length === 1, String(seen.messages.length));
}

// ── 5. Agent 已在运行 → 不打扰 ──────────────────────────────────────────────
{
  const { ctx, seen, timers, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  agents.set('s3', makeAgent({ status: 'running', seen }));
  controller.arm('s3');
  drain(timers);
  await Promise.resolve();
  check('运行中不投递', seen.messages.length === 0, String(seen.messages.length));
  check('标记为已处理', controller.fired.has('s3'));
}

// ── 6. 同一会话重复登记 → 只投一条 ─────────────────────────────────────────
{
  const { ctx, seen, agents } = makeCtx();
  const controller = createAutoResume(ctx);
  agents.set('s4', makeAgent({ seen }));
  controller.arm('s4');
  controller.arm('s4');
  await Promise.resolve();
  await Promise.resolve();
  check('重复登记只投一条', seen.messages.length === 1, String(seen.messages.length));
}

// ── 7. Agent 一直不就绪 → 放弃并记一条 warn ─────────────────────────────────
{
  const { ctx, seen, timers } = makeCtx();
  const controller = createAutoResume(ctx);
  controller.arm('s5');
  drain(timers, 200);
  check('超时后不再排 timer', timers.length === 0, String(timers.length));
  check('超时没有投递', seen.messages.length === 0);
  check('超时记了 warn', seen.warns.some((line) => line.includes('s5')), JSON.stringify(seen.warns));
}

// ── 8. 非法 sessionId 不登记 ────────────────────────────────────────────────
{
  const { ctx } = makeCtx();
  const controller = createAutoResume(ctx);
  controller.arm(undefined);
  controller.arm('');
  check('空 id 不登记', controller.armed.size === 0, String(controller.armed.size));
}

console.log(failed === 0 ? '\nall checks passed' : '\n' + failed + ' check(s) failed');
process.exit(failed === 0 ? 0 : 1);
