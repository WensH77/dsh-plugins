// Client-side regression test for the rollback PREFILL dispatch.
//
// Guards the fix for "回滚后的内容填充到大量 composer": the prefill used
// `binding.ctx.emit('slash/input-insert-text', ...)` WITHOUT a dispatch
// subject, so cordis' dispatch ran every listener on the hooks table — which,
// with the shared session-ctx architecture, prefilled EVERY mounted composer.
// The dispatch must carry the session ctx as `thisArg` (like the dsh
// input-trigger's `actx.bail(actx, ...)`), so `Context.filter` only lets the
// TARGET session's composer shell through.
//
// This test vm-loads the browser bundle with a minimal DOM/sessions/fetch
// stub, drives the two-click rollback flow, and asserts:
//   1. the prefill emit fires exactly once, for the NEW session's ctx;
//   2. the FIRST dispatch argument is the session ctx (the thisArg — the fix);
//   3. the payload carries the rolled-back message text.
// Run: node test/client-emit.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const code = await readFile(join(ROOT, '..', 'lib', 'client.js'), 'utf8');

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failed += 1;
    console.log(' FAIL ' + label + (detail !== undefined ? '  -> ' + detail : ''));
  }
}

// ── minimal DOM stub (the plugin uses plain DOM APIs) ───────────────────────
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this._attrs = {};
    this._handlers = {};
    this._text = '';
    this.style = {};
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.innerHTML = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (this._text === '') this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { for (const c of children) this.appendChild(c); return this; }
  remove() {
    if (this.parentElement === null) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  insertBefore(node, ref) {
    node.parentElement = this;
    const i = ref === null || ref === void 0 ? -1 : this.children.indexOf(ref);
    if (i >= 0) this.children.splice(i, 0, node);
    else this.children.push(node);
    return node;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  hasAttribute(k) { return this._attrs[k] !== undefined; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { (this._handlers[type] ??= []).push(fn); }
  removeEventListener() {}
  contains() { return false; }
}
const findButton = (node) => {
  if (node.className === 'crb-action') return node;
  for (const c of node.children ?? []) {
    const hit = findButton(c);
    if (hit !== null) return hit;
  }
  return null;
};

// ── stubs ───────────────────────────────────────────────────────────────────
const emitCalls = [];
const ctxS1 = { emit: (...args) => { emitCalls.push(['s1', ...args]); } };
const ctxNew = { emit: (...args) => { emitCalls.push(['new', ...args]); } };
const userRow = new FakeElement('div');
userRow.setAttribute('data-chat-flow-kind', 'user');
userRow.setAttribute('data-chat-anchor-key', 'k1');
const bodyRoot = new FakeElement('body');
bodyRoot.appendChild(userRow);

const sessions = {
  list: {
    getSnapshot: () => ({ current: 's1' }),
    subscribe: () => () => {}
  },
  binding: (id) => {
    if (id === 's1') return { session: { getSnapshot: () => ({ chat: { nodes: new Map([['k1', { anchorSeq: 1 }]]) } }) }, ctx: ctxS1 };
    if (id === 'new') return { session: { getSnapshot: () => ({ chat: { nodes: new Map() } }) }, ctx: ctxNew };
    throw new Error('unexpected binding ' + id);
  },
  refresh: async () => {},
  open: async () => {}
};

// ndjson 流响应：模拟服务端 stream=1 的阶段进度流（backup/restore/…/done）
const ndjsonResponse = (lines) => {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.length) return { done: true, value: undefined };
          const chunk = bytes.slice(offset, bytes.length);
          offset = bytes.length;
          return { done: false, value: chunk };
        }
      })
    }
  };
};

// 二次校验回归：不带 force 的首次执行 → 409 conflict；force=1 重发 → done。
// 用于断言「正常确认点击不带 force、409 之后的确认才带」的 forcePending 机制
// （回归背景：0.1.5 初版所有确认点击都带 force=1，服务端二次校验形同虚设）。
const rollbackCalls = [];
globalThis.fetch = async (url) => {
  if (url.includes('/chat-rollback/preflight')) return { ok: true, json: async () => ({ ok: true }) };
  if (url.includes('/chat-rollback/rollback')) {
    rollbackCalls.push(url);
    if (url.includes('force=1')) {
      return ndjsonResponse([
        { phase: 'session', sessionId: 'new' },
        { phase: 'restore', codeRollback: { restored: true } },
        { phase: 'done', ok: true, sessionId: 'new', nextInput: 'ROLLED BACK TEXT', archivedSource: true }
      ]);
    }
    return { status: 409, json: async () => ({ code: 'conflict', files: ['f.txt'], message: 'conflict' }) };
  }
  throw new Error('unexpected fetch ' + url);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sandbox = {
  window: {},
  document: {
    querySelectorAll: (sel) => (sel === '[data-chat-anchor-key]' ? [userRow] : []),
    querySelector: () => null,
    createElement: (tag) => new FakeElement(tag),
    head: { appendChild: () => {} },
    body: bodyRoot,
    addEventListener: () => {},
    removeEventListener: () => {}
  },
  HTMLElement: FakeElement,
  MutationObserver: class { observe() {} disconnect() {} },
  TextDecoder,
  TextEncoder,
  console,
  setTimeout,
  clearTimeout,
  fetch: globalThis.fetch
};
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      if (id === 'react') throw new Error('no react needed');
      throw new Error('unexpected require: ' + id);
    });
  }
};
let loaded = null;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

check('bundle exports apply', typeof loaded?.apply === 'function');

// ── drive the flow ──────────────────────────────────────────────────────────
const mockCtx = {
  effect: (fn) => fn(),
  locale: {
    register: () => () => {},
    bind: () => (key) => 'L:' + key,
    subscribe: () => () => {}
  },
  sessions
};
loaded.apply(mockCtx);
await sleep(150); // the initial scan (120ms debounce) mounts the button

const button = findButton(userRow);
check('rollback button mounted under the user bubble', button !== null);
if (button !== null) {
  // click 1 → preflight (async) → confirm armed
  button._handlers.click[0]();
  await sleep(30);
  check('confirm state armed after preflight', button.className.includes('confirm') || button.className.includes('conflict'));
  // click 2 → rollback WITHOUT force → 409 conflict → back to ? conflict state
  button._handlers.click[0]();
  await sleep(50);
  check('409 conflict returns to conflict state', button.className.includes('conflict'), 'class=' + button.className);
  check('first rollback attempt carries NO force', rollbackCalls.length === 1 && !rollbackCalls[0].includes('force=1'), JSON.stringify(rollbackCalls));
  check('no prefill after 409', emitCalls.filter((c) => c[0] === 'new').length === 0, JSON.stringify(emitCalls));
  // click 3 → conflict → confirm armed
  button._handlers.click[0]();
  await sleep(10);
  check('confirm re-armed after conflict review', button.className.includes('confirm'), 'class=' + button.className);
  // click 4 → rollback WITH force=1 → done → prefill emit on the NEW session ctx
  button._handlers.click[0]();
  await sleep(50);
  check('second rollback attempt carries force=1', rollbackCalls.length === 2 && rollbackCalls[1].includes('force=1'), JSON.stringify(rollbackCalls));
  const newCalls = emitCalls.filter((c) => c[0] === 'new');
  check('prefill emitted exactly once for the new session', newCalls.length === 1, 'calls=' + JSON.stringify(emitCalls));
  check('prefill dispatch carries the session ctx as thisArg (the fix)', newCalls.length === 1 && newCalls[0][1] === ctxNew, 'first arg=' + String(newCalls[0]?.[1] === ctxNew ? 'ctx' : newCalls[0]?.[1]));
  check('prefill event name + payload', newCalls.length === 1 && newCalls[0][2] === 'slash/input-insert-text' && newCalls[0][3]?.text === 'ROLLED BACK TEXT', JSON.stringify(newCalls[0]));
  check('no prefill emit for other sessions', emitCalls.filter((c) => c[0] !== 'new').length === 0, JSON.stringify(emitCalls));
}

console.log(failed === 0 ? '\nCLIENT EMIT PASS' : '\n' + failed + ' CLIENT EMIT FAILURES');
process.exit(failed === 0 ? 0 : 1);
