// dsh-plugin-todo-tab 宿主端 smoke 测试。
//
// 运行：npm test（= node test/smoke.mjs && node test/client-smoke.mjs）
//
// 覆盖：
//  1) 定位域纯函数（workspaceNameOf / todoPathOf / readTodo）；
//  2) 端点行为（http 状态与 code：bad-session / no-session / no-workspace / 读到 / 缺失）；
//  3) 只读约定与路径不可注入（只注册一条路由；调用方只能给会话 id，给不了路径）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dshHomePath 每次调用都读 process.env，测试用临时 DSH_HOME 隔离真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'todo-tab-home-'));
process.env.DSH_HOME = home;

const { workspaceNameOf, todoPathOf, readTodo } = await import('../lib/memory.js');
const { createHandler, apply } = await import('../lib/index.js');

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

console.log(failures === 0 ? '\nsmoke: all passed' : '\nsmoke: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
