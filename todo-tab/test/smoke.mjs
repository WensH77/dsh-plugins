// dsh-plugin-todo-tab 宿主端 smoke 测试。
//
// 运行：npm test（= node test/smoke.mjs && node test/client-smoke.mjs）
//
// 覆盖：
//  1) 定位域纯函数（workspaceNameOf / todoPathOf / readTodo）；
//  2) 端点行为（http 状态与 code：bad-session / no-session / no-workspace / 读到 / 缺失；
//     活跃会话与冷会话（只在持久化落盘记录里）两条取 cwd 的路径）；
//  3) 只读约定与路径不可注入（只注册一条路由；调用方只能给会话 id，给不了路径）；
//  4) 待办约定的常驻注入与技能注册（agent scope 挂载 / 释放 / 幂等；提问约定与跨文本一致性）。
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// 内存里只有活跃会话；另有两个只存在于「落盘记录」里（冷会话：宿主进程重启后界面还留着的
// 旧会话、或侧栏翻出来的历史会话），模拟持久化服务的 stat()。
const sessions = new Map([
  ['sess-good', { header: { cwd: join(home, 'Documents', workspace) } }],
  ['sess-nocwd', { header: {} }],
  // 活跃会话与落盘记录冲突时，以内存为准（内存里的 cwd 指向别的工作区）。
  ['sess-both', { header: { cwd: join(home, 'Documents', 'live-ws') } }]
]);
const stored = new Map([
  ['sess-cold', { header: { cwd: join(home, 'Documents', workspace) } }],
  ['sess-cold-nocwd', { header: {} }],
  ['sess-both', { header: { cwd: join(home, 'Documents', 'stored-ws') } }]
]);
const services = new Map([['sessionPersistence', { stat: async (id) => stored.get(id) }]]);
const ctx = {
  effect: (fn) => fn(),
  logger: { info() {}, warn() {} },
  get: (name) => services.get(name),
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

// 冷会话（不在内存、只在落盘记录里）也要能读出工作区，而不是报 no-session。
const cold = await call(handler, '/todo-tab/data?session=sess-cold');
assertEq(cold.status, 200, '冷会话 → 200（不再误报 no-session）');
assertEq(cold.body.workspace, workspace, '冷会话按落盘 header 的 cwd 定位工作区');
assert(cold.body.exists === true && cold.body.content.includes('一件小事'), '冷会话同样读到 TODO.md 内容');

assertEq((await call(handler, '/todo-tab/data?session=sess-cold-nocwd')).status, 409, '落盘 header 没 cwd 的冷会话 → 409');
assertEq((await call(handler, '/todo-tab/data?session=sess-cold-nocwd')).body.code, 'no-workspace', '落盘 header 没 cwd → no-workspace');
assertEq((await call(handler, '/todo-tab/data?session=sess-both')).body.workspace, 'live-ws', '活跃会话优先于落盘记录');

// 持久化服务没挂载时退回旧行为：只看内存会话。
const noPersistence = { ...ctx, get: () => undefined };
const bare = createHandler(noPersistence);
assertEq((await call(bare, '/todo-tab/data?session=sess-good')).status, 200, '没有持久化服务时活跃会话照常');
assertEq((await call(bare, '/todo-tab/data?session=sess-cold')).body.code, 'no-session', '没有持久化服务时冷会话仍是 no-session');

// 落盘读取本身出错（日志损坏等）不许吞掉：活跃会话照常，冷会话回 internal。
const broken = createHandler({
  ...ctx,
  get: (name) => (name === 'sessionPersistence' ? { stat: async () => { throw new Error('corrupt log'); } } : undefined)
});
assertEq((await call(broken, '/todo-tab/data?session=sess-good')).status, 200, 'stat 抛错不影响活跃会话');
assertEq((await call(broken, '/todo-tab/data?session=sess-cold')).body.code, 'internal', 'stat 抛错 → internal');

// 调用方给路径参数无效：只认会话 cwd 推出的路径（无任意文件读取面）。
const injected = await call(handler, '/todo-tab/data?session=sess-good&path=' + encodeURIComponent('/etc/passwd'));
assertEq(injected.body.path, join(dir, 'TODO.md'), 'path 参数被忽略，仍读工作区 TODO.md');

// ── 4. 常驻注入 + 技能 ──────────────────────────────────────────────────────
const text = conventionText();
for (const needle of [
  '<DSH_HOME>/memory/<工作区>/TODO.md',
  '只记**未完成**待办',
  '永不复用',
  '插入式 `edit` 改单条',
  'todo-memory` 技能',
  // 常驻文本必须带「先问用户」这个触发器：技能只在模型主动加载时才生效，
  // 而「发现值得记的事就提问」要在每一轮都成立。
  '先用 `ask_user_question` 问用户',
  '用户跳过某一问或没答都按「不记、不删」处理'
]) {
  assert(text.includes(needle), '常驻文本含「' + needle + '」');
}
// 删除要把关。这句话常驻文本与技能各写一份，必须逐字相同：只改一处会静默不一致。
const deleteRule = '办结的条目经用户确认后删除整条';
assert(text.includes(deleteRule), '常驻文本里删除也要用户点头');
// 常驻文本里必须自己闭环：免问授权要就地等于已点头，否则与上面那条删除铁律打架。
assert(text.includes('这种授权即视为已经点头'), '常驻文本的免问授权就地等于已点头（不留给技能解释）');
assert(text.includes('一轮最多问一次'), '常驻文本带防唠叨的次数上限');
assert(text.includes('答过「不记」「先留着」或跳过不答的同一件事不再问'), '常驻文本带防唠叨的不重复提议');
assert(text.includes('下一次向用户开口时讲清'), '常驻文本要求回报被跳过/未答的条目');
// 跳过与答过一样要防重复提议，否则被跳过的事会被每轮重问；明确拒过的条目不许被后来的概括授权翻案。
assert(text.includes('或跳过不答的同一件事不再问'), '常驻文本把「跳过的」也纳入防重复提议');
assert(text.includes('已经被明确拒过的条目不在此列'), '常驻文本写明概括授权不能翻案已拒过的条目');
assert(text.includes('已获授权自办的照授权办'), '常驻文本写明授权与无工具同时成立时以授权为准');
assert(text.includes('把候选与待删条目交给上层代理'), '常驻文本给出子代理的替代动作（提问走不通就不增删）');
assert(text.includes('自己就是根代理时写进回复正文'), '常驻文本给出无上层代理时的出口');
assert(text.includes('说过「别问了」「你自己看着办」之后本会话不再提问'), '常驻文本带免问出口（用户授权后不再逐条问）');
// 分组标题要照抄进 TODO.md，三份文本（常驻 / 技能 / 骨架）必须一样，否则照抄出来的小节名各不相同。
const sections = ['### A. 待裁决（需用户点头）', '### B. 需真实会话/重启验证', '### C. 小债与清理'];
assert(sections.every((section) => text.includes(section.replace('### ', ''))), '常驻文本里的三类分组名与骨架一致');
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
assert(skill.content.includes('## 先问再动'), '技能含「先问再动」一节');
assert(skill.content.includes('ask_user_question'), '技能写明用 ask_user_question 提问');
assert(skill.content.includes('`先留着`'), '技能给出「先留着」选项：删除要用户点头');
assert(skill.content.includes('没有得到肯定答复，不写也不删'), '技能写明跳过/未答都不落盘');
assert(skill.content.includes(deleteRule), '技能里的删除铁律与常驻文本逐字相同');
assert(skill.content.includes('todo_record_<工作区>-1'), '技能给出一条 ask 里记多条的问题 id 槽位');
const template = readFileSync(templateFilePath(), 'utf8');
assert(
  sections.every((section) => skill.content.includes(section) && template.includes(section)),
  '技能与骨架文件的三类小节名逐字一致'
);
assert(skill.whenToUse.includes('已办结'), '技能路由描述覆盖「已办结 → 问是否删除」');
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
