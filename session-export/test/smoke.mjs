// Node-half smoke test for dsh-plugin-session-export.
// Covers the transcript builder (append-origin user/assistant extraction,
// reasoning/tool-call stripping, injected-context filtering), the title
// derivation, the /session-export/data handler contract, and apply() route
// registration.
// Run: node test/smoke.mjs
import { apply, buildDataHandler, buildTranscript, deriveTitle, inject, name } from '../lib/index.js';

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failed += 1;
    console.log(' FAIL ' + label + (detail !== undefined ? '  -> ' + detail : ''));
  }
}

// ── exports ─────────────────────────────────────────────────────────────────
console.log('exports:');
check('exports apply/inject/name', typeof apply === 'function' && Array.isArray(inject) && typeof name === 'string', 'missing export');
check('name is session-export', name === 'session-export', name);
check('inject lists webServer + sessions', inject.includes('webServer') && inject.includes('sessions'), String(inject));
check('builder/handler exported', typeof buildTranscript === 'function' && typeof buildDataHandler === 'function' && typeof deriveTitle === 'function');

// ── event fixtures ──────────────────────────────────────────────────────────
const T0 = 1700000000000;
function ev(type, data, extra = {}) {
  return { type, seq: 0, time: T0, surfaceOp: 'append', data, ...extra };
}
const userMsg = (text, source = { kind: 'user' }, blocks) => ev('user/message', {
  source,
  content: blocks !== undefined ? blocks : [{ type: 'text', text }]
});
const assistantMsg = (blocks, extra = {}) => ev('assistant/message', {
  turn: 1,
  step: 1,
  message: { id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: blocks },
  ...extra
});

// ── buildTranscript ─────────────────────────────────────────────────────────
console.log('buildTranscript:');
{
  const events = [
    userMsg('你好'),
    assistantMsg([{ type: 'reasoning', text: '思考过程……' }, { type: 'text', text: '你好！' }]),
    userMsg('再来一个', undefined, [{ type: 'text', text: '再来一个' }, { type: 'image', attachment: { id: 'a1' } }]),
    assistantMsg([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }, { type: 'text', text: '完成了。' }])
  ];
  const { messages, skipped, truncated } = buildTranscript(events);
  check('4 events -> 4 messages (user/assistant/user/assistant)', messages.length === 4, JSON.stringify(messages.map((m) => m.role)));
  check('order preserved', messages.map((m) => m.role).join(',') === 'user,assistant,user,assistant');
  check('reasoning dropped from assistant text', messages[1].text === '你好！', messages[1].text);
  check('tool-call step keeps only text', messages[3].text === '完成了。', messages[3].text);
  check('user imageCount reported', messages[2].imageCount === 1 && messages[0].imageCount === 0);
  check('skipped counts (1 reasoning + 1 tool-call)', skipped.reasoning === 1 && skipped.toolCalls === 1, JSON.stringify(skipped));
  check('times preserved', messages.every((m) => m.time === T0));
  check('not truncated', truncated === false);
}
{
  // injected context (plugin source) and replacement copies never export
  const events = [
    userMsg('真实提问'),
    userMsg('系统注入', { kind: 'plugin', plugin: 'x' }),
    ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '旧内容' }] }, { surfaceOp: { op: 'replace', start: 0, end: 1 } }),
    assistantMsg([{ type: 'text', text: '回答' }]),
    userMsg('压缩摘要', { kind: 'user' }, [{ type: 'text', text: '摘要' }])
  ];
  const { messages, skipped } = buildTranscript(events);
  check('plugin user + replacement user skipped', messages.map((m) => m.text).join('|') === '真实提问|回答|摘要', JSON.stringify(messages));
  check('no injected/replaced text leaks', messages.every((m) => m.text !== '系统注入' && m.text !== '旧内容'));
  check('replaced counter bumped', skipped.replaced === 1, JSON.stringify(skipped));
}
{
  // assistant edge cases: usage-only message, pure tool-call step
  const events = [
    assistantMsg([]),
    assistantMsg([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]),
    assistantMsg([{ type: 'reasoning', text: '思考' }])
  ];
  const { messages, skipped } = buildTranscript(events);
  check('usage-only / tool-only / reasoning-only assistant messages export nothing', messages.length === 0, JSON.stringify(messages));
  check('reasoning + tool-call counted', skipped.reasoning === 1 && skipped.toolCalls === 1, JSON.stringify(skipped));
}
{
  // maxMessages cap
  const events = [];
  for (let i = 0; i < 6; i += 1) {
    events.push(userMsg('q' + i));
    events.push(assistantMsg([{ type: 'text', text: 'a' + i }]));
  }
  const { messages, truncated } = buildTranscript(events, { maxMessages: 3 });
  check('cap stops at limit', messages.length === 3 && truncated === true, JSON.stringify({ n: messages.length, truncated }));
}
{
  // non-array input degrades safely
  const { messages, truncated } = buildTranscript(undefined);
  check('undefined events -> empty transcript', messages.length === 0 && truncated === false);
}

// ── deriveTitle ─────────────────────────────────────────────────────────────
console.log('deriveTitle:');
{
  const events = [
    userMsg('这是一个很长很长的第一句话，目的是为了测试标题截断逻辑是否正常工作：它应该被截断到六十个字符以内并带上省略号标记'),
    ev('session/title', { title: '显式标题', messageSeqs: [0], source: { kind: 'user' } })
  ];
  check('explicit title wins', deriveTitle(events, [{ role: 'user', text: 'x' }]) === '显式标题');
}
{
  const events = [userMsg('第一句提问\n第二行')];
  check('fallback = first user message first line', deriveTitle(events, [{ role: 'user', text: '第一句提问\n第二行' }]) === '第一句提问');
}
{
  const events = [userMsg('这是一段超过六十个字符的、非常非常长的问题描述，它必须被正确截断到六十个字符并追加省略号标记以保证导出文件名长度可控，所以这里再补几个字')];
  const title = deriveTitle(events, [{ role: 'user', text: events[0].data.content[0].text }]);
  check('long fallback truncated at 60 chars', title.length === 61 && title.endsWith('…'), title);
}
{
  check('no user text -> empty title', deriveTitle([], []) === '');
}

// ── handler contract ────────────────────────────────────────────────────────
console.log('handler:');
function fakeRes() {
  const state = { status: null, body: '' };
  return {
    state,
    writeHead(status) {
      state.status = status;
    },
    end(body) {
      state.body = typeof body === 'string' ? body : String(body);
    }
  };
}
{
  const session = { events: [userMsg('你好'), assistantMsg([{ type: 'reasoning', text: '想' }, { type: 'text', text: '你好！' }])] };
  const env = { ctx: { sessions: { get: (id) => (id === 's1' ? session : undefined) }, logger: { warn() {} } }, config: { maxMessages: 4000, width: 860, scale: 2, partHeight: 10000, segmentHeight: 8000 } };
  const handler = buildDataHandler(env);
  const res = fakeRes();
  await handler({ url: '/session-export/data?session=s1' }, res);
  const parsed = JSON.parse(res.state.body);
  check('200 with ok:true', res.state.status === 200 && parsed.ok === true, res.state.body);
  check('payload carries title/messages/skipped/config', typeof parsed.title === 'string' && parsed.messages.length === 2 && parsed.skipped.reasoning === 1 && typeof parsed.config.width === 'number', res.state.body);
  check('reasoning stripped in payload', parsed.messages[1].text === '你好！', parsed.messages[1].text);

  const res400 = fakeRes();
  await handler({ url: '/session-export/data' }, res400);
  check('missing session -> 400', res400.state.status === 400);
  const res404 = fakeRes();
  await handler({ url: '/session-export/data?session=nope' }, res404);
  check('unknown session -> 404', res404.state.status === 404);
}

// ── apply registration ──────────────────────────────────────────────────────
console.log('apply:');
{
  const routes = [];
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    sessions: { get: () => undefined },
    logger: { warn() {} }
  };
  const dispose = apply(ctx, {});
  check('route registered', routes.length === 1 && routes[0].path === '/session-export/data' && routes[0].kind === 'exact', JSON.stringify(routes));
  check('apply returns a disposer', typeof dispose === 'function');
  // a second apply on a FRESH ctx registers its own route (per-plugin ctx lifecycle)
  const routes2 = [];
  const ctx2 = {
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes2.push(route); return () => {}; } },
    sessions: { get: () => undefined },
    logger: { warn() {} }
  };
  const custom = apply(ctx2, { width: 1024, scale: 3 });
  check('custom config accepted without throwing', typeof custom === 'function');
  check('fresh ctx registers exactly one route', routes2.length === 1 && routes2[0].path === '/session-export/data', String(routes2.length));
}

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
