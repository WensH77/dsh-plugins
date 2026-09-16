// dsh-plugin-todo-tab 浏览器端 smoke 测试。
//
// 运行：node test/client-smoke.mjs
//
// 在 vm 沙箱里加载 lib/client.js（浏览器工厂包装），校验：
//  1) 注册面：页签类型（id/kind/引导胶囊）、槽位挂载（key 与类型 id 对齐）、双语文案键集一致；
//  2) 端点地址构造；
//  3) 只读：源码里没有写请求与可编辑控件；
//  4) 本体在 loading 态能渲染不抛错。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let loaded = null;
const sandbox = {
  window: {},
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', appendChild() {} }),
    head: { appendChild() {} }
  },
  console,
  encodeURIComponent,
  fetch: async () => ({ json: async () => ({ ok: true, exists: false }) }),
  react: {
    createElement: () => ({}),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn()
  }
};
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      if (id in sandbox) return sandbox[id];
      throw new Error('unexpected require: ' + id);
    });
  }
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let failures = 0;
function assert(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures += 1;
    console.error('FAIL  ' + label + (detail === undefined ? '' : '  -> ' + detail));
  }
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, label, a + ' !== ' + e);
}

assert(typeof loaded.apply === 'function', 'apply 已导出');
assertEq(loaded.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], 'inject 声明了四个服务（sidebarRight 少写会抛 without inject）');
assertEq(loaded.todoDataUrl('sess-1'), '/todo-tab/data?session=sess-1', '端点地址构造');

// ── 注册面 ──────────────────────────────────────────────────────────────────
const captured = { dicts: null, definition: null, slots: [], opened: [], resources: [] };
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => {
      captured.ns = ns;
      captured.dicts = dicts;
    },
    bind: () => (key) => '[' + key + ']'
  },
  sidebarRight: {
    openTab: (kind) => { captured.opened.push(kind); },
    openResource: (address) => { captured.resources.push(address); }
  },
  sidebarRightTabs: { register: (definition) => { captured.definition = definition; } },
  slots: {
    inject: (name, fn) => fn(),
    register: (spec, component) => { captured.slots.push({ spec, component }); }
  }
};
loaded.apply(ctx);

assert(captured.definition !== null, '注册了页签类型');
assertEq(captured.definition.kind, 'todo', 'kind = todo');
assertEq(captured.definition.id, 'dsh-plugin-todo-tab', '类型 id = 包名');
assertEq(typeof captured.definition.title, 'function', 'title 是 thunk');
assert(captured.definition.guide && captured.definition.guide.length === 1, '引导页有一个胶囊');
assertEq(captured.definition.guide[0].order, 30, '胶囊 order 固定');
assert(typeof captured.definition.guide[0].icon === 'function', '胶囊带图标组件');

assertEq(captured.slots.length, 2, '挂两个槽位（页签本体 + 标题栏入口）');
const bodySlot = captured.slots.find((entry) => entry.spec.name === 'sidebar.right.pane.tab');
const headSlot = captured.slots.find((entry) => entry.spec.name === 'conversation.session.header.actions');
assert(bodySlot !== undefined, '挂了右侧栏页签槽位');
assertEq(bodySlot.spec.key, captured.definition.id, '槽位 key 与类型 id 对齐');
assertEq(bodySlot.spec.locale, captured.ns, '槽位 locale 与注册命名空间对齐');
assert(typeof bodySlot.component === 'function', '页签本体是组件');
assert(headSlot !== undefined, '挂了会话标题栏入口');
assertEq(headSlot.spec.id, captured.definition.id, '标题栏入口 id 与类型 id 对齐');
assert(typeof headSlot.component === 'function', '标题栏入口是组件');

const zh = Object.keys(captured.dicts.zh).sort();
const en = Object.keys(captured.dicts.en).sort();
assertEq(zh, en, '中英文字典键集一致');

// ── 只读约定 ────────────────────────────────────────────────────────────────
assert(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(code), '客户端没有写请求');
assert(!/contentEditable|<textarea|<input/i.test(code), '客户端没有可编辑控件');
assert(!/-tab\/(set|write|save)/.test(code), '客户端不引用写端点');

// ── Markdown 子集解析 ───────────────────────────────────────────────────────
const sample = [
  '# TODO（demo）',
  '',
  '> 只列未完成待办。',
  '',
  '### A. 待裁决（需用户点头）',
  '',
  '- [ ] **demo-1 `browser_debug` 是否要做**',
  '  - 问题点：`Debugger.paused` 会让页面停住。',
  '- [x] 已办结的一条',
  '',
  '普通段落 **粗** 与 `code` 与 [链接](https://example.com/x)。',
  '',
  '```',
  'raw code',
  '```'
].join('\n');
const blocks = loaded.parseMarkdown(sample);
assertEq(blocks.map((block) => block.type), ['heading', 'quote', 'heading', 'list', 'paragraph', 'code'], '块类型与顺序');
assertEq(blocks[0].level, 1, '一级标题');
assertEq(blocks[1].text, '只列未完成待办。', '引用文本');
assertEq(blocks[2].level, 3, '三级标题');
assertEq(blocks[3].items.length, 2, '列表两项');
assertEq(blocks[3].items[0].checked, false, '未勾选的任务项');
assertEq(blocks[3].items[1].checked, true, '已勾选的任务项');
assertEq(blocks[3].items[0].children.length, 1, '子项挂在父项下');
assertEq(blocks[3].items[0].children[0].checked, null, '子项不是任务项');
assertEq(blocks[5].text, 'raw code', '围栏代码正文');

const inline = loaded.parseInline('**demo-1 `browser_debug` 是否要做**');
assertEq(inline.length, 1, '粗体整段成为一个节点');
assertEq(inline[0].kind, 'strong', '识别粗体');
assertEq(inline[0].nodes.map((node) => node.kind), ['text', 'code', 'text'], '粗体内部的 code 仍被识别');

// ── 资源地址（交给原生文件预览打开） ────────────────────────────────────────
assertEq(loaded.todoResourceAddress('session-1', '/Users/me/.dsh/memory/demo/TODO.md'),
  'dsh-resource://file/session/session-1//Users/me/.dsh/memory/demo/TODO.md', '绝对路径编成 session 作用域地址');
assertEq(loaded.todoResourceAddress('session-1', '/Users/me/My Project/TODO.md'),
  'dsh-resource://file/session/session-1//Users/me/My%20Project/TODO.md', '路径段做 URL 编码');

// ── 渲染 ────────────────────────────────────────────────────────────────────
const body = loaded.TodoBody({ sessionId: 'sess-1', t: (key) => '[' + key + ']' });
assert(body !== null && typeof body === 'object', '页签本体 loading 态渲染不抛错');

const headProps = headSlot.spec.inject('sess-1');
const headAction = headSlot.component({ ...headProps, t: (key) => '[' + key + ']' });
assert(headAction !== null && typeof headAction === 'object', '标题栏入口渲染不抛错');

// 有文件：交给原生预览（openResource），不再开自带页签。
captured.opened.length = 0;
captured.resources.length = 0;
sandbox.fetch = async () => ({ json: async () => ({ ok: true, exists: true, path: '/Users/me/.dsh/memory/demo/TODO.md' }) });
assertEq(await headProps.openTodo(), '', '有文件时返回空串（按钮不显示错误）');
assertEq(captured.resources, ['dsh-resource://file/session/sess-1//Users/me/.dsh/memory/demo/TODO.md'], '有文件时开原生文件预览');
assertEq(captured.opened, [], '有文件时不退回自带页签');

// 没有文件：退回自带页签（它会把应放路径说清楚）。
sandbox.fetch = async () => ({ json: async () => ({ ok: true, exists: false, path: '/Users/me/.dsh/memory/demo/TODO.md' }) });
assertEq(await headProps.openTodo(), '', '没有文件时也返回空串');
assertEq(captured.resources, ['dsh-resource://file/session/sess-1//Users/me/.dsh/memory/demo/TODO.md'], '没有文件时不开预览');
assertEq(captured.opened, ['todo'], '没有文件时退回自带页签');

// 端点坏了：退回自带页签，并把原因带回来。
sandbox.fetch = async () => ({ json: async () => ({ ok: false, code: 'internal', message: 'boom' }) });
assert(/boom/.test(await headProps.openTodo()), '端点报错时把原因带回来');

// openTab 抛错（例如没有挂载座位）时也必须带回原因，否则「点了没反应」没法排查。
const failing = {
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => (key) => key },
  sidebarRight: {
    openResource: () => {},
    openTab: () => { throw new Error('no session surface is mounted'); }
  },
  sidebarRightTabs: { register: () => {} },
  slots: { inject: (name, fn) => fn(), register: () => {} }
};
const failingSlots = [];
failing.slots.register = (spec, component) => { failingSlots.push({ spec, component }); };
loaded.apply(failing);
const failingOpen = failingSlots.find((entry) => entry.spec.name === 'conversation.session.header.actions').spec.inject().openTodo;
assert(/no session surface is mounted/.test(await failingOpen()), '打开失败时返回可读原因');

console.log(failures === 0 ? '\nclient-smoke: all passed' : '\nclient-smoke: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
