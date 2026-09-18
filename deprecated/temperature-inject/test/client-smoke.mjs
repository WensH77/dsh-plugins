#!/usr/bin/env node
// temperature-inject — 浏览器端 smoke 测试（`node test/client-smoke.mjs`）。
//
// 在 vm 沙箱里加载 lib/client.js（浏览器工厂包装），校验：
//   1) 导出面：apply / inject / 两个组件 / RANGE 常量；
//   2) 注册面：两个 slot（开关在 conversation.input.left、滑杆在 conversation.input.dock），
//      且都带 locale 与 inject(sessionId) 工厂；
//   3) 规格常量：范围 0~1（**不是**文档的 0~2）、step 0.2；
//   4) i18n：zh/en 两套齐全且键集一致；
//   5) store 行为：未开启时滑杆不渲染、写入走 POST 端点。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let loaded = null;

const fetchCalls = [];
const sandbox = {
  window: {},
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} }
  },
  console,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  fetch: async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ session: 'S1', enabled: false, temperature: 1, effective: false })
    };
  },
  react: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value })
  }
};
sandbox.window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    loaded = { id, exports: factory((name) => {
      if (name in sandbox) return sandbox[name];
      throw new Error('unexpected require: ' + name);
    }) };
  }
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let failures = 0;
function assert(cond, label, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.error('  FAIL ' + label + (detail === undefined ? '' : '\n       ' + detail));
  }
}

console.log('导出面与规格常量');
const mod = loaded === null ? null : loaded.exports;
assert(mod !== null, 'client.js 通过 __ModuleLoader__.load 注册');
assert(loaded !== null && loaded.id === 'dsh-plugin-temperature-inject', '模块 id = dsh-plugin-temperature-inject', loaded && loaded.id);
assert(typeof mod?.apply === 'function', '导出 apply');
assert(Array.isArray(mod?.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'), 'inject 含 slots 与 locale', JSON.stringify(mod?.inject));
assert(typeof mod?.TemperatureToggle === 'function', '导出 TemperatureToggle');
assert(typeof mod?.TemperatureSlider === 'function', '导出 TemperatureSlider');
assert(mod?.RANGE?.min === 0 && mod?.RANGE?.max === 1 && mod?.RANGE?.step === 0.2, 'RANGE = {0, 1, 0.2}（实测可用区间，不是 0~2）', JSON.stringify(mod?.RANGE));
assert(mod?.ENDPOINT === '/temperature-inject/session', '端点常量正确', mod?.ENDPOINT);

console.log('注册面（假 ctx 跑 apply）');
const registered = [];
let dicts = null;
const fakeCtx = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register: (_ns, value) => {
      dicts = value;
      return () => {};
    },
    bind: () => (key) => key
  },
  slots: {
    inject: (key, cb) => {
      cb();
    },
    register: (def, Component) => {
      registered.push({ def, Component });
      return () => {};
    }
  }
};
try {
  mod.apply(fakeCtx);
} catch (error) {
  failures += 1;
  console.error('  FAIL apply 抛错: ' + String(error?.message ?? error));
}
const byId = new Map(registered.map((r) => [r.def.id, r]));
assert(registered.length === 2, '注册两个 slot 组件', '实际 ' + registered.length);
assert(byId.get('temperature-toggle')?.def.name === 'conversation.input.left', '开关挂 conversation.input.left');
assert(byId.get('temperature-slider')?.def.name === 'conversation.input.dock', '滑杆挂 conversation.input.dock');
assert(byId.get('temperature-toggle')?.Component === mod.TemperatureToggle, '开关组件类型正确');
assert(byId.get('temperature-slider')?.Component === mod.TemperatureSlider, '滑杆组件类型正确');
for (const id of ['temperature-toggle', 'temperature-slider']) {
  const def = byId.get(id)?.def;
  assert(def?.locale === 'temperature-inject', id + ' 带 locale 命名空间');
  assert(typeof def?.inject === 'function' && def.inject('S1').sessionId === 'S1', id + ' 的 inject 工厂透出 sessionId');
}

console.log('i18n');
assert(dicts !== null && typeof dicts.zh === 'object' && typeof dicts.en === 'object', '注册了 zh/en 两套词条');
if (dicts !== null) {
  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'zh/en 键集一致', JSON.stringify({ zhKeys, enKeys }));
  assert(zhKeys.every((k) => typeof dicts.zh[k] === 'string' && typeof dicts.en[k] === 'string'), '词条都是字符串');
}

console.log('组件行为');
const noneSetting = { session: 'S1', enabled: false, temperature: 1 };
assert(mod.TemperatureSlider({ t: (k) => k, sessionId: 'S1', __setting: noneSetting }) === null, '未开启时滑杆渲染 null');
const toggleTree = mod.TemperatureToggle({ t: (k) => k, sessionId: 'S1' });
assert(toggleTree !== null && toggleTree.type === 'button', '开关渲染 button');
assert(toggleTree?.props?.['data-active'] === 'false', '默认关闭时 data-active=false');
assert(toggleTree?.props?.['aria-pressed'] === 'false', '默认关闭时 aria-pressed=false');

console.log('store 端点契约');
const store = mod.__store;
assert(store !== undefined && typeof store.write === 'function', '导出 store 供测试');
try {
  await store.write('S1', { enabled: true, temperature: 0.6 });
  const post = fetchCalls.find((c) => c.options?.method === 'POST');
  assert(post?.url === '/temperature-inject/session', '写入走 POST /temperature-inject/session', post?.url);
  const payload = JSON.parse(post?.options?.body ?? '{}');
  assert(payload.session === 'S1' && payload.enabled === true && payload.temperature === 0.6, '请求体含 session/enabled/temperature', post?.options?.body);
  await store.load('S1');
  const get = fetchCalls.find((c) => c.options !== undefined && c.options.method === undefined);
  assert(get?.url === '/temperature-inject/session?session=S1', '读取走 GET + query', get?.url);
} catch (error) {
  failures += 1;
  console.error('  FAIL store 端点契约: ' + String(error?.message ?? error));
}

console.log('');
if (failures === 0) {
  console.log('全部通过');
} else {
  console.log(failures + ' 项失败');
  process.exitCode = 1;
}
