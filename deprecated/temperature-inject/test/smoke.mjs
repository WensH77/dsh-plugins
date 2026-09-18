#!/usr/bin/env node
// temperature-inject — 宿主端 smoke 测试（`node test/smoke.mjs`）。
//
// 覆盖：配置归一化与温度夹取、客户端写入的校验、会话级设置解析的优先级、
// 注入判定的全部分支、以及用假 ctx 走通「子代理被改写 / 主代理不被改写 /
// 会话未开启 / waterfall 异常放行 / 状态与会话端点」这些路径。
import assert from 'node:assert/strict';
import {
  Config,
  TESTED_MAX,
  TEMPERATURE_STEP,
  apply,
  clampTemperature,
  decideInjection,
  normalizeConfig,
  publicConfig,
  publicSessionSetting,
  resolveSessionSetting,
  sanitizeSessionPatch
} from '../lib/index.js';

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + label);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.error('  FAIL ' + label + '\n       ' + String(error?.message ?? error));
  }
}

// schemastery 的 schema 既可调用也可 new；两种都兜住。
function instantiate(schema, value) {
  try {
    return schema(value);
  } catch {
    return new schema(value);
  }
}

console.log('normalizeConfig');
await check('缺省值齐全（temperature 默认 1）', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.model, 'deepseek-flash');
  assert.equal(cfg.effort, 'off');
  assert.equal(cfg.temperature, 1);
  assert.equal(cfg.clampedFrom, null);
  assert.equal(cfg.autoEnable, false);
});
await check('温度 >2 夹到 2 并记录原值', () => {
  const cfg = normalizeConfig({ temperature: 5 });
  assert.equal(cfg.temperature, 2);
  assert.equal(cfg.clampedFrom, 5);
});
await check('温度 <0 夹到 0 并记录原值', () => {
  const cfg = normalizeConfig({ temperature: -1 });
  assert.equal(cfg.temperature, 0);
  assert.equal(cfg.clampedFrom, -1);
});
await check('非数字温度回落默认值', () => {
  const cfg = normalizeConfig({ temperature: 'abc' });
  assert.equal(cfg.temperature, 1);
  assert.equal(cfg.clampedFrom, null);
});
await check('enabled:false 保留；provider 空白串视为不改', () => {
  const cfg = normalizeConfig({ enabled: false, provider: '   ' });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.provider, '');
});
await check('autoEnable 只认严格 true', () => {
  assert.equal(normalizeConfig({ autoEnable: 'yes' }).autoEnable, false);
  assert.equal(normalizeConfig({ autoEnable: true }).autoEnable, true);
});
await check('publicConfig 暴露可用区间与步长', () => {
  const view = publicConfig(normalizeConfig({}));
  assert.deepEqual(view.testedRange, [0, TESTED_MAX]);
  assert.equal(view.step, TEMPERATURE_STEP);
  assert.deepEqual(Object.keys(view).sort(), [
    'autoEnable', 'clampedFrom', 'effort', 'enabled', 'includeMain', 'model',
    'provider', 'sessions', 'step', 'temperature', 'testedRange'
  ]);
});

console.log('clampTemperature / sanitizeSessionPatch');
await check('clampTemperature 夹到给定区间', () => {
  assert.equal(clampTemperature(-3, 0.5, 0, 1), 0);
  assert.equal(clampTemperature(9, 0.5, 0, 1), 1);
  assert.equal(clampTemperature(0.6, 0.5, 0, 1), 0.6);
  assert.equal(clampTemperature('abc', 0.5, 0, 1), 0.5);
});
await check('sanitizeSessionPatch：客户端只能写 0~1、且必须是布尔/数字', () => {
  assert.deepEqual(sanitizeSessionPatch({ enabled: true, temperature: 0.6 }), { enabled: true, temperature: 0.6 });
  assert.deepEqual(sanitizeSessionPatch({ enabled: 'yes' }), {}, '非布尔 enabled 被丢弃');
  assert.deepEqual(sanitizeSessionPatch({ temperature: 5 }), { temperature: 1 }, '温度被夹到实测上界 1');
  assert.deepEqual(sanitizeSessionPatch({ temperature: -2 }), { temperature: 0 });
  assert.deepEqual(sanitizeSessionPatch({ temperature: 'x' }), {});
  assert.deepEqual(sanitizeSessionPatch(null), {});
});
await check('publicSessionSetting 默认关闭、回落到配置温度', () => {
  const view = publicSessionSetting('S1', undefined, 0.8);
  assert.equal(view.session, 'S1');
  assert.equal(view.enabled, false);
  assert.equal(view.effective, false);
  assert.equal(view.temperature, 0.8);
  assert.deepEqual(view.testedRange, [0, TESTED_MAX]);
  assert.equal(view.step, TEMPERATURE_STEP);
});

console.log('resolveSessionSetting（优先级）');
const cfgDefault = normalizeConfig({});
await check('默认（会话未开启、无白名单、无 autoEnable）→ null', () => {
  assert.equal(resolveSessionSetting(cfgDefault, 'S1', undefined), null);
});
await check('会话页打开 → 用会话级温度', () => {
  const s = resolveSessionSetting(cfgDefault, 'S1', { enabled: true, temperature: 0.4 });
  assert.deepEqual(s, { temperature: 0.4, source: 'session' });
});
await check('会话页关闭 → 即使有白名单也不生效', () => {
  const cfg = normalizeConfig({ sessions: ['S1'] });
  assert.equal(resolveSessionSetting(cfg, 'S1', { enabled: false, temperature: 0.4 }), null);
});
await check('config.sessions 白名单命中 → 用配置温度', () => {
  const cfg = normalizeConfig({ sessions: ['S1'], temperature: 0.6 });
  assert.deepEqual(resolveSessionSetting(cfg, 'S1', undefined), { temperature: 0.6, source: 'config' });
});
await check('autoEnable → 所有会话用配置温度', () => {
  const cfg = normalizeConfig({ autoEnable: true, temperature: 0.2 });
  assert.deepEqual(resolveSessionSetting(cfg, 'S9', undefined), { temperature: 0.2, source: 'auto' });
});
await check('总开关关闭 → 一律 null', () => {
  const cfg = normalizeConfig({ enabled: false, autoEnable: true });
  assert.equal(resolveSessionSetting(cfg, 'S1', { enabled: true, temperature: 1 }), null);
});
await check('会话级温度越界被夹到 0~1', () => {
  const s = resolveSessionSetting(cfgDefault, 'S1', { enabled: true, temperature: 1.8 });
  assert.equal(s.temperature, 1);
});

const cfgOf = (patch = {}) => normalizeConfig(patch);
const subHeader = { origin: 'subagent', parentSession: 'S1' };
const mainHeader = { cwd: '/tmp' };
const ON = { temperature: 1, source: 'session' };

console.log('decideInjection');
await check('总开关关闭 → disabled', () => {
  const d = decideInjection({ provider: 'p', model: 'm' }, subHeader, cfgOf({ enabled: false }), ON);
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'disabled');
});
await check('主代理默认不改写', () => {
  const d = decideInjection({ provider: 'p', model: 'm' }, mainHeader, cfgOf(), ON);
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'not-subagent');
});
await check('会话未开启 → session-off（默认状态）', () => {
  const d = decideInjection({ provider: 'p', model: 'm' }, subHeader, cfgOf(), null);
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'session-off');
});
await check('includeMain 时主代理也被改写', () => {
  const d = decideInjection({ provider: 'p', model: 'm' }, mainHeader, cfgOf({ includeMain: true }), ON);
  assert.equal(d.apply, true);
  assert.deepEqual(d.patch, { model: 'deepseek-flash', reasoningEffort: 'off', temperature: 1 });
});
await check('子代理被改写：model + effort + temperature，provider 保持原值', () => {
  const d = decideInjection(
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    subHeader,
    cfgOf(),
    { temperature: 0.6, source: 'session' }
  );
  assert.equal(d.apply, true);
  assert.deepEqual(d.patch, { model: 'deepseek-flash', reasoningEffort: 'off', temperature: 0.6 });
  assert.equal(d.next.provider, 'deepseek-official');
  assert.equal(d.next.temperature, 0.6);
});
await check('配置了 provider 才改 provider', () => {
  const d = decideInjection({ provider: 'old', model: 'm' }, subHeader, cfgOf({ provider: 'deepseek-official' }), ON);
  assert.equal(d.next.provider, 'deepseek-official');
});
await check('值已一致 → already-applied（同一 agent 的后续 step）', () => {
  const resolved = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', temperature: 1 };
  const d = decideInjection(resolved, subHeader, cfgOf(), ON);
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'already-applied');
});
await check('空 provider/model/effort 表示不改对应字段', () => {
  const d = decideInjection(
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
    subHeader,
    cfgOf({ provider: '', model: '', effort: '' }),
    { temperature: 0.8, source: 'session' }
  );
  assert.deepEqual(d.patch, { temperature: 0.8 });
});

console.log('apply 装配（假 ctx 走通 waterfall 与两个端点）');
function makeCtx() {
  const handlers = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]) },
    on: (event, handler) => {
      handlers.push({ event, handler });
      return () => {};
    },
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    webServer: {
      exact: new Map(),
      register(route) {
        if (ctx.webServer.exact.has(route.path)) throw new Error('duplicate route: ' + route.path);
        ctx.webServer.exact.set(route.path, route.handler);
        return () => ctx.webServer.exact.delete(route.path);
      }
    }
  };
  return { ctx, handlers, logs };
}
const handlerOf = (handlers) => handlers.find((h) => h.event === 'agent/request')?.handler;
const runWaterfall = (handler, resolved, payload) => handler(payload, async () => resolved);
const callRoute = async (handler, { method = 'GET', url = '/', body } = {}) => {
  const res = { status: null, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  const req = {
    method,
    url,
    body,
    on(event, fn) {
      if (event === 'end') setImmediate(fn);
      return this;
    }
  };
  await handler(req, res);
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
};

function makeCtxWithSetting(patch) {
  const { ctx, handlers, logs } = makeCtx();
  const dispose = apply(ctx, patch);
  return { ctx, handlers, logs, dispose };
}

await check('默认（会话未开）子代理请求原样放行', async () => {
  const { handlers } = makeCtxWithSetting({});
  const original = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  const next = await runWaterfall(handlerOf(handlers), original, {
    agent: { id: 'C1', session: { header: subHeader } }
  });
  assert.equal(next, original);
});

await check('会话页打开后子代理被改写并记日志', async () => {
  const { ctx, handlers, logs } = makeCtxWithSetting({});
  const session = await callRoute(ctx.webServer.exact.get('/temperature-inject/session'), {
    method: 'POST',
    body: JSON.stringify({ session: 'S1', enabled: true, temperature: 0.6 })
  });
  assert.equal(session.status, 200);
  assert.equal(session.json.enabled, true);
  assert.equal(session.json.temperature, 0.6);
  const next = await runWaterfall(
    handlerOf(handlers),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    { agent: { id: 'C1', session: { header: subHeader } } }
  );
  assert.equal(next.model, 'deepseek-flash');
  assert.equal(next.reasoningEffort, 'off');
  assert.equal(next.temperature, 0.6);
  assert.ok(logs.some(([level, m]) => level === 'info' && m.includes('child=C1') && m.includes('source=session')));
});

await check('再关闭开关后不再改写', async () => {
  const { ctx, handlers } = makeCtxWithSetting({});
  const route = ctx.webServer.exact.get('/temperature-inject/session');
  await callRoute(route, { method: 'POST', body: JSON.stringify({ session: 'S1', enabled: true }) });
  await callRoute(route, { method: 'POST', body: JSON.stringify({ session: 'S1', enabled: false }) });
  const original = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  const next = await runWaterfall(handlerOf(handlers), original, {
    agent: { id: 'C2', session: { header: subHeader } }
  });
  assert.equal(next, original);
});

await check('会话端点的错误分支', async () => {
  const { ctx } = makeCtxWithSetting({});
  const route = ctx.webServer.exact.get('/temperature-inject/session');
  assert.equal((await callRoute(route, { method: 'POST', body: '{bad json' })).status, 400);
  assert.equal((await callRoute(route, { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await callRoute(route, { method: 'PUT' })).status, 405);
});

await check('会话端点 GET 返回默认关闭', async () => {
  const { ctx } = makeCtxWithSetting({ temperature: 0.8 });
  const got = await callRoute(ctx.webServer.exact.get('/temperature-inject/session'), {
    url: '/temperature-inject/session?session=S9'
  });
  assert.equal(got.status, 200);
  assert.equal(got.json.session, 'S9');
  assert.equal(got.json.enabled, false);
  assert.equal(got.json.temperature, 0.8);
});

await check('主代理请求原样放行（引用不变）', async () => {
  const { ctx, handlers } = makeCtxWithSetting({});
  await callRoute(ctx.webServer.exact.get('/temperature-inject/session'), {
    method: 'POST',
    body: JSON.stringify({ session: 'M1', enabled: true })
  });
  const original = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' };
  const next = await runWaterfall(handlerOf(handlers), original, {
    agent: { id: 'M1', session: { header: mainHeader } }
  });
  assert.equal(next, original);
});

await check('waterfall 内部异常 → 原样放行并记 warn', async () => {
  const { ctx, handlers, logs } = makeCtxWithSetting({ autoEnable: true });
  const original = { provider: 'p', model: 'm' };
  const payload = {
    agent: {
      id: 'C3',
      session: {
        get header() {
          throw new Error('boom');
        }
      }
    }
  };
  const next = await runWaterfall(handlerOf(handlers), original, payload);
  assert.equal(next, original);
  assert.ok(logs.some(([level, m]) => level === 'warn' && m.includes('passed through')));
});

await check('next() 抛错时不吞（原样向上抛）', async () => {
  const { handlers } = makeCtxWithSetting({ autoEnable: true });
  await assert.rejects(
    handlerOf(handlers)({ agent: { id: 'C4', session: { header: subHeader } } }, async () => {
      throw new Error('upstream');
    }),
    /upstream/
  );
});

await check('状态端点返回 config/state/sessions', async () => {
  const { ctx } = makeCtxWithSetting({ temperature: 0.8 });
  await callRoute(ctx.webServer.exact.get('/temperature-inject/session'), {
    method: 'POST',
    body: JSON.stringify({ session: 'S1', enabled: true, temperature: 0.4 })
  });
  const got = await callRoute(ctx.webServer.exact.get('/temperature-inject/state'));
  assert.equal(got.status, 200);
  assert.equal(got.json.config.temperature, 0.8);
  assert.equal(got.json.config.step, TEMPERATURE_STEP);
  assert.equal(got.json.state.sessionWrites, 1);
  assert.deepEqual(got.json.sessions, [{ session: 'S1', enabled: true, temperature: 0.4 }]);
});

await check('重复 apply 命中 duplicate 时清掉旧路由再注册', () => {
  const { ctx } = makeCtx();
  apply(ctx, {});
  const disposeAgain = apply(ctx, { temperature: 0.5 });
  assert.ok(ctx.webServer.exact.has('/temperature-inject/state'));
  assert.ok(ctx.webServer.exact.has('/temperature-inject/session'));
  disposeAgain();
});

await check('Config schema 默认值齐全', () => {
  const resolved = instantiate(Config, {});
  assert.equal(resolved.model, 'deepseek-flash');
  assert.equal(resolved.effort, 'off');
  assert.equal(resolved.temperature, 1);
  assert.deepEqual(resolved.sessions, []);
  assert.equal(resolved.autoEnable, false);
  assert.equal(resolved.includeMain, false);
});

console.log('\n' + passed + ' 项通过' + (failed ? '，' + failed + ' 项失败' : ''));
