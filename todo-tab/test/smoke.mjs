// dsh-plugin-todo-tab 宿主端 smoke 测试。
//
// 运行：npm test（= node test/smoke.mjs && node test/client-smoke.mjs）
//
// 覆盖：
//  1) 定位域纯函数（workspaceNameOf / todoPathOf / readTodo）；
//  2) 端点行为（http 状态与 code：bad-session / no-session / no-workspace / 读到 / 缺失）；
//  3) 只读约定与路径不可注入（只注册一条路由；调用方只能给会话 id，给不了路径）；
//  4) 待办约定的常驻注入与技能注册（agent scope 挂载 / 释放 / 幂等）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dshHomePath 每次调用都读 process.env，测试用临时 DSH_HOME 隔离真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'todo-tab-home-'));
process.env.DSH_HOME = home;

const { workspaceNameOf, todoPathOf, readTodo } = await import('../lib/memory.js');
const { createHandler, apply, applyConvention } = await import('../lib/index.js');
const { CONTEXT_NAME, CONTEXT_ORDER, conventionText, loadSkill, parseSkillFile, templateFilePath } = await import('../lib/convention.js');

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

function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = JSON.parse(text);
    }
  };
}
async function call(handler, url) {
  const res = fakeRes();
  await handler({ url }, res);
  return res;
}

// ── 1. 定位域 ───────────────────────────────────────────────────────────────
assertEq(workspaceNameOf('/Users/x/Documents/dsh-plugins'), 'dsh-plugins', 'cwd → 最后一段');
assertEq(workspaceNameOf('/Users/x/Documents/dsh-plugins/'), 'dsh-plugins', '尾斜杠同样取到最后一段');
assertEq(workspaceNameOf('/Users/x/Documents/My Project'), 'My Project', '工作区名里的空格原样保留');
assertEq(workspaceNameOf('/'), null, '根目录取不出工作区名');
assertEq(workspaceNameOf(''), null, '空串 → null');
assertEq(workspaceNameOf('   '), null, '全空白 → null');
assertEq(workspaceNameOf(undefined), null, '无 cwd → null');
assertEq(todoPathOf('dsh-plugins'), join(home, 'memory', 'dsh-plugins', 'TODO.md'), 'TODO.md 路径 = <DSH_HOME>/memory/<工作区>/TODO.md');

// ── 2. 读盘 ─────────────────────────────────────────────────────────────────
const workspace = 'demo-ws';
const dir = join(home, 'memory', workspace);

const missing = await readTodo(workspace);
assertEq(missing.exists, false, '文件不存在 → exists:false');
assertEq(missing.path, join(dir, 'TODO.md'), '不存在时也回路径');

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'TODO.md'), '# TODO（demo-ws）\n\n- [ ] 一件小事\n', 'utf8');
const found = await readTodo(workspace);
assertEq(found.exists, true, '文件存在 → exists:true');
assert(found.content.includes('一件小事'), '内容读到了中文正文');
assert(found.bytes > 0 && typeof found.mtimeMs === 'number', '带 bytes 与 mtimeMs', JSON.stringify({ bytes: found.bytes, mtimeMs: found.mtimeMs }));

// ── 3. 端点 ─────────────────────────────────────────────────────────────────
const sessions = new Map([
  ['sess-good', { header: { cwd: join(home, 'Documents', workspace) } }],
  ['sess-nocwd', { header: {} }]
]);
const ctx = {
  effect: (fn) => fn(),
  logger: { info() {}, warn() {} },
  sessions: { get: (id) => sessions.get(id) },
  webServer: { register: (route) => { ctx.routes.push(route); } },
  // apply 里还会接约定注入；这里给一个不做事的 inject，只为让 apply 跑通。
  inject: () => () => {},
  routes: []
};
apply(ctx);

assertEq(ctx.routes.length, 1, '只注册一条路由');
assertEq(ctx.routes[0].kind, 'exact', '路由是 exact');
assertEq(ctx.routes[0].path, '/todo-tab/data', '路由路径固定');
assert(ctx.routes.every((route) => !/set|write|save|update/i.test(route.path)), '没有任何写端点');

const handler = createHandler(ctx);
assertEq((await call(handler, '/todo-tab/data')).status, 400, '缺 session → 400');
assertEq((await call(handler, '/todo-tab/data?session=')).body.code, 'bad-session', '空 session → bad-session');
assertEq((await call(handler, '/todo-tab/data?session=../../etc/passwd')).body.code, 'bad-session', '畸形 session → bad-session');
assertEq((await call(handler, '/todo-tab/data?session=sess-unknown')).status, 404, '未知会话 → 404');
assertEq((await call(handler, '/todo-tab/data?session=sess-unknown')).body.code, 'no-session', '未知会话 → no-session');
assertEq((await call(handler, '/todo-tab/data?session=sess-nocwd')).status, 409, '无 cwd 的会话 → 409');
assertEq((await call(handler, '/todo-tab/data?session=sess-nocwd')).body.code, 'no-workspace', '无 cwd → no-workspace');

const ok = await call(handler, '/todo-tab/data?session=sess-good');
assertEq(ok.status, 200, '正常会话 → 200');
assertEq(ok.body.workspace, workspace, '按 cwd 末段定位工作区');
assert(ok.body.exists === true && ok.body.content.includes('一件小事'), '返回 TODO.md 内容');

// 调用方给路径参数无效：只认会话 cwd 推出的路径（无任意文件读取面）。
const injected = await call(handler, '/todo-tab/data?session=sess-good&path=' + encodeURIComponent('/etc/passwd'));
assertEq(injected.body.path, join(dir, 'TODO.md'), 'path 参数被忽略，仍读工作区 TODO.md');

// ── 4. 常驻注入 + 技能 ──────────────────────────────────────────────────────
const text = conventionText();
for (const needle of ['<DSH_HOME>/memory/<工作区>/TODO.md', '只记**未完成**待办', '永不复用', '插入式 `edit` 追加', 'todo-memory` 技能']) {
  assert(text.includes(needle), '常驻文本含「' + needle + '」');
}
assert(!text.includes('## 骨架'), '常驻文本不塞长规范（骨架留给技能）');

const parsed = parseSkillFile('---\nname: demo\ndescription: "带引号的描述"\nwhenToUse: x\n---\n\n# 正文\n');
assertEq(parsed.frontmatter.name, 'demo', 'frontmatter 解析 name');
assertEq(parsed.frontmatter.description, '带引号的描述', 'frontmatter 去引号');
assertEq(parsed.body.trim(), '# 正文', 'frontmatter 与正文分离');
assertEq(parseSkillFile('# 没有 frontmatter').frontmatter, {}, '无 frontmatter 时返回空对象');

const skill = await loadSkill();
assertEq(skill.name, 'todo-memory', '技能名来自 SKILL.md');
assert(skill.description.length > 20, '技能带路由描述');
assert(typeof skill.whenToUse === 'string' && skill.whenToUse !== '', '技能带 whenToUse');
assert(skill.content.includes('## 骨架'), '技能正文含骨架');
assert(skill.content.includes(templateFilePath()), '技能正文附上骨架文件路径');
assert(skill.path.endsWith('skill/todo-memory/SKILL.md'), '技能来自插件目录');

// agent scope 挂载：context + 技能各注册一次，disposed 时释放，重复 created 幂等。
const captured = { deps: null, contexts: [], skills: [], injects: [], released: [] };
const listeners = {};
const existing = { id: 'agent-existing', ctx: fakeAgentCtx('agent-existing') };
function fakeAgentCtx(id) {
  const ctx = {
    systemPrompt: { context: (def) => { captured.contexts.push({ id, def }); return () => captured.released.push('context:' + id); } },
    inject: (deps, callback) => {
      captured.injects.push({ id, deps });
      callback({ skills: { register: (entry) => { captured.skills.push({ id, entry }); return () => captured.released.push('skill:' + id); } } });
      return () => captured.released.push('inject:' + id);
    }
  };
  // 真实宿主的 agent ctx 上**没有** skills 服务，cordis 直接拒「cannot get property "skills"
  // without inject」——0.2.0 的技能就是死在这句上，所以这里按同样的形状挡回去。
  Object.defineProperty(ctx, 'skills', {
    get() { throw new Error('cannot get property "skills" without inject'); }
  });
  return ctx;
}
const promptCtx = {
  logger: { info() {}, warn() {} },
  agents: { list: () => [existing] },
  on: (event, listener) => {
    listeners[event] = listener;
    return () => { delete listeners[event]; };
  }
};
// 挂载链是异步的（loadSkill 读盘 → then → inject 回调），按条件轮询，别赌一个 tick。
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  console.error('等待超时：' + label);
}

const disposeAll = applyConvention({ inject: (deps, callback) => { captured.deps = deps; return callback(promptCtx); } });
await waitFor(() => captured.contexts.length === 1 && captured.skills.length === 1, 'agent-existing 的 context / 技能挂载');

assertEq(captured.deps, ['agents', 'systemPrompt', 'skills'], '注入 agents / systemPrompt / skills');
assertEq(captured.contexts.length, 1, '已有活 agent 补挂一次');
assertEq(captured.contexts[0].def.name, CONTEXT_NAME, '常驻 context 名字固定');
assertEq(captured.contexts[0].def.order, CONTEXT_ORDER, '常驻 context order 固定');
assertEq(captured.contexts[0].def.text, text, '常驻 context 正文 = conventionText()');
assertEq(captured.skills.length, 1, '已有活 agent 也注册技能');
assertEq(captured.skills[0].entry.name, 'todo-memory', '注册的技能名');
assertEq(captured.skills[0].entry.provider, 'todo-tab', '技能 provider 标注来源');
assert(
  typeof captured.skills[0].entry.source === 'string' && captured.skills[0].entry.source !== '',
  '技能带 source（缺了它 skills.get() 会拒收整份定义）'
);
assertEq(captured.injects.length, 1, '技能经 agent ctx 的 inject 拿 skills（不走会被拒的直接访问）');
assertEq(captured.injects[0].deps, ['skills'], 'inject 只声明 skills');

const fresh = { id: 'agent-new', ctx: fakeAgentCtx('agent-new') };
listeners['agent/created']({ agent: fresh });
listeners['agent/created']({ agent: fresh });
await waitFor(() => captured.injects.filter((entry) => entry.id === 'agent-new').length === 1, 'agent-new 的技能挂载');
assertEq(captured.contexts.filter((entry) => entry.id === 'agent-new').length, 1, '同一 agent 重复 created 只挂一次');
assertEq(captured.injects.filter((entry) => entry.id === 'agent-new').length, 1, '同一 agent 的 inject 也只挂一次');

listeners['agent/disposed']({ agent: fresh });
assert(
  ['context:agent-new', 'skill:agent-new', 'inject:agent-new'].every((key) => captured.released.includes(key)),
  'agent 释放时注销 context / 技能 / inject'
);

disposeAll();
assert(
  ['context:agent-existing', 'skill:agent-existing', 'inject:agent-existing'].every((key) => captured.released.includes(key)),
  '插件卸载时释放全部挂载'
);

console.log(failures === 0 ? '\nsmoke: all passed' : '\nsmoke: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
