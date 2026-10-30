// dsh-plugin-graceful-inject 浏览器端 smoke 测试。
//
// 运行：node test/client-smoke.mjs
//
// 在 vm 沙箱里加载 lib/client.js（浏览器工厂包装），校验：
//  1) 注册面：标题栏槽位名 / id / locale / 注入的 sessionId；
//  2) 端点地址与本地化、失败映射；
//  3) 宿主开关探测：true 才画按钮、失败按关闭处理、每次挂载都重新探测；
//  4) 真渲染：用一个最小 hooks 运行时驱动组件——开关放行后画按钮，点击发 POST，
//     成功变绿（data-state=ok）、失败变红并把原因写进 aria-label；
//  5) 源码契约：监工请求必须是 POST，且不引用被标题栏裁掉的浮层。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * 最小 hooks 运行时：够驱动一个函数组件、在 setState 后重绘、执行一次 effect。
 * 只用于测试；真实浏览器里用 React。
 */
function createMiniReact() {
	let component = null;
	let props = null;
	let cells = [];
	let cursor = 0;
	let effects = [];
	let cleanups = [];
	let scheduled = false;
	let tree = null;

	const hooks = {
		createElement: (type, elementProps, ...children) => ({
			type,
			props: elementProps === undefined || elementProps === null ? {} : elementProps,
			children
		}),
		useState(initial) {
			const index = cursor;
			cursor += 1;
			if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
			return [cells[index], (value) => {
				cells[index] = typeof value === 'function' ? value(cells[index]) : value;
				scheduled = true;
			}];
		},
		useEffect(fn) {
			effects.push({ index: cursor, fn });
			cursor += 1;
		},
		useRef(initial) {
			const index = cursor;
			cursor += 1;
			if (!(index in cells)) cells[index] = { current: initial };
			return cells[index];
		},
		useCallback(fn) {
			cursor += 1;
			return fn;
		}
	};

	function draw() {
		cursor = 0;
		effects = [];
		tree = component(props);
		for (const { index, fn } of effects) {
			if (typeof cleanups[index] === 'function') cleanups[index]();
			const cleanup = fn();
			cleanups[index] = typeof cleanup === 'function' ? cleanup : undefined;
		}
		scheduled = false;
	}

	return {
		hooks,
		mount(nextComponent, nextProps) {
			component = nextComponent;
			props = nextProps;
			cells = [];
			cleanups = [];
			cursor = 0;
			effects = [];
			scheduled = false;
			draw();
		},
		async settle(rounds = 25) {
			for (let i = 0; i < rounds; i += 1) {
				await Promise.resolve();
				if (scheduled) draw();
			}
		},
		tree: () => tree
	};
}

/** 深度优先找第一个指定 tag 的元素。 */
function find(node, type) {
	if (node === null || typeof node !== 'object') return null;
	if (node.type === type) return node;
	for (const child of node.children ?? []) {
		const hit = find(child, type);
		if (hit !== null) return hit;
	}
	return null;
}

const mini = createMiniReact();
let fetchImpl = async () => ({ json: async () => ({ ok: true, supervise: true }) });
const sandbox = {
	window: {},
	document: {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: '', appendChild() {} }),
		head: { appendChild() {} }
	},
	console,
	encodeURIComponent,
	fetch: (url, init) => fetchImpl(url, init),
	setTimeout: () => 0,
	clearTimeout: () => {},
	react: mini.hooks
};
let loaded = null;
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
assertEq(loaded.inject, ['slots', 'locale'], 'inject 声明了 slots 与 locale');
assertEq(loaded.superviseUrl('sess-1'), '/graceful-inject/supervise?session=sess-1', '监工端点地址构造');
assert(/<svg/i.test(loaded.ICON_STOPWATCH), '秒表图标是 SVG');
assert(/stroke-linecap="round"/.test(loaded.ICON_STOPWATCH), '图标与标题栏其它图标同一套描边');

// ── 注册面 ──────────────────────────────────────────────────────────────────
const captured = { dicts: null, slots: [] };
const ctx = {
	effect: (fn) => fn(),
	locale: {
		register: (ns, dicts) => {
			captured.ns = ns;
			captured.dicts = dicts;
		},
		bind: () => (key) => '[' + key + ']'
	},
	slots: {
		inject: (name, fn) => fn(),
		register: (spec, component) => { captured.slots.push({ spec, component }); }
	}
};
loaded.apply(ctx);

assertEq(captured.slots.length, 1, '只挂一个标题栏槽位');
const slot = captured.slots[0];
assertEq(slot.spec.name, 'conversation.session.header.actions', '槽位是会话标题栏 actions');
assertEq(slot.spec.id, 'dsh-plugin-graceful-inject', '槽位 id = 包名');
assertEq(slot.spec.locale, captured.ns, '槽位 locale 与注册命名空间对齐');
assertEq(typeof slot.spec.inject, 'function', '通过 inject 拿 sessionId');
assertEq(slot.spec.inject('sess-1'), { sessionId: 'sess-1' }, 'inject 透传 sessionId');
assert(typeof slot.component === 'function', '槽位组件是函数');

const zh = Object.keys(captured.dicts.zh).sort();
const en = Object.keys(captured.dicts.en).sort();
assertEq(zh, en, '中英文字典键集一致');
assert(captured.dicts.zh.supervise.includes('汇报当前任务进度'), '按钮文案提到汇报进度');

// ── 失败映射 ────────────────────────────────────────────────────────────────
const t = (key, params) => params === undefined ? '[' + key + ']' : '[' + key + ':' + JSON.stringify(params) + ']';
assertEq(loaded.failureText(t, { code: 'disabled', message: 'x' }, 409), '[disabled]', '开关关闭走本地化文案');
assertEq(loaded.failureText(t, { code: 'remote', message: 'x' }, 403), '[remote]', '不可信页面走本地化文案');
assertEq(loaded.failureText(t, { code: 'no-agent', message: 'x' }, 404), '[noAgent]', '无活跃 Agent 走本地化文案');
assertEq(loaded.failureText(t, { code: 'throttled', retryAfter: 7, message: 'x' }, 429), '[throttled:{"seconds":7}]', '节流文案带剩余秒数');
assertEq(loaded.failureText(t, { code: 'throttled', message: 'x' }, 429), '[throttled:{"seconds":10}]', '缺 retryAfter 时按 10 秒');
assert(loaded.failureText(t, { code: 'internal', message: 'boom' }, 500).startsWith('[error:'), '其它错误带宿主 message');
assert(loaded.failureText(t, null, 502).startsWith('[error:'), '没有 JSON 时回落 HTTP 状态');

// ── 开关探测：每次挂载都问一次，失败按关闭 ─────────────────────────────────
{
	const calls = [];
	fetchImpl = async (url) => {
		calls.push(url);
		return { json: async () => ({ ok: true, resume: true, supervise: true, superviseText: '自定义监工文本' }) };
	};
	assertEq(await loaded.readSuperviseState(), { enabled: true, text: '自定义监工文本' }, 'state 带回开关与注入文本');
	assertEq(await loaded.readSuperviseState(), { enabled: true, text: '自定义监工文本' }, '第二次探测仍然请求（不缓存）');
	assertEq(calls, ['/graceful-inject/state', '/graceful-inject/state'], '每次调用都请求 state');
}
{
	const failing = {
		window: {},
		document: sandbox.document,
		console,
		encodeURIComponent,
		fetch: async () => { throw new Error('offline'); },
		setTimeout: () => 0,
		clearTimeout: () => {},
		react: mini.hooks
	};
	let second = null;
	failing.window.__ModuleLoader__ = {
		load: ({ factory }) => { second = factory((id) => failing[id]); }
	};
	vm.createContext(failing);
	vm.runInContext(code, failing);
	assert(second !== null, '第二份实例加载成功');
	assertEq(await second.readSuperviseState(), { enabled: false, text: null }, 'state 请求失败按关闭处理');
}

// ── 真渲染：开关放行 → 画按钮 → 点击 POST → 状态反馈 ──────────────────────
{
	const requests = [];
	fetchImpl = async (url, init) => {
		requests.push({ url, method: init?.method ?? 'GET' });
		if (url === '/graceful-inject/state') return { json: async () => ({ ok: true, resume: true, supervise: true, superviseText: '自定义监工文本' }) };
		return { json: async () => ({ ok: true, mode: 'steer', summary: '…' }) };
	};
	mini.mount(loaded.SuperviseAction, { sessionId: 'sess-1', t });
	await mini.settle();
	const button = find(mini.tree(), 'button');
	assert(button !== null, '开关放行后渲染出按钮');
	assertEq(button?.props.className, 'gi-action', '按钮类名');
	assertEq(button?.props['aria-label'], '自定义监工文本', '按钮 aria-label 用宿主配置的注入文本');
	assertEq(button?.props['data-state'], undefined, '初始没有状态色');

	await button.props.onClick();
	await mini.settle();
	const after = find(mini.tree(), 'button');
	assertEq(after?.props['data-state'], 'ok', '成功后按钮变绿（data-state=ok）');
	const posts = requests.filter((entry) => entry.method === 'POST');
	assertEq(posts.length, 1, '点击发一次 POST');
	assertEq(posts[0]?.url, '/graceful-inject/supervise?session=sess-1', 'POST 打到监工端点');
}
{
	fetchImpl = async (url) => {
		if (url === '/graceful-inject/state') return { json: async () => ({ ok: true, supervise: true }) };
		return { json: async () => ({ ok: false, code: 'no-agent', message: 'no live agent' }) };
	};
	mini.mount(loaded.SuperviseAction, { sessionId: 'sess-1', t });
	await mini.settle();
	const button = find(mini.tree(), 'button');
	await button.props.onClick();
	await mini.settle();
	const after = find(mini.tree(), 'button');
	assertEq(after?.props['data-state'], 'err', '失败后按钮变红（data-state=err）');
	assertEq(after?.props['aria-label'], '[noAgent]', '失败原因写进 aria-label（标题栏裁不掉）');
}
{
	fetchImpl = async () => ({ json: async () => ({ ok: true, supervise: false }) });
	mini.mount(loaded.SuperviseAction, { sessionId: 'sess-1', t });
	await mini.settle();
	assertEq(mini.tree(), null, '开关关闭时渲染空');
}
{
	fetchImpl = async () => ({ json: async () => ({ ok: true, supervise: true }) });
	mini.mount(loaded.SuperviseAction, { sessionId: '', t });
	await mini.settle();
	assertEq(mini.tree(), null, '没有会话 id 时不画按钮');
}

// ── 源码契约 ────────────────────────────────────────────────────────────────
assert(/method:\s*["']POST["']/.test(code), '监工请求用 POST');
assert(!/(method:\s*["'](?:PUT|PATCH|DELETE)["'])/.test(code), '没有其它写方法');
assert(code.includes('data-state'), '按钮带不依赖布局的状态反馈（标题栏会裁掉浮层）');
assert(!code.includes('::after'), '不画会被标题栏裁掉的 tooltip');
assert(!/\.gi-note/.test(code), '不画会被标题栏裁掉的浮层提示');
assert(code.includes('console.warn'), '失败原因也写控制台');

console.log(failures === 0 ? '\nclient-smoke: all passed' : '\nclient-smoke: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
