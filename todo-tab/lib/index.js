// dsh-plugin-todo-tab — 宿主端（只读）。
//
// 单个端点：GET /todo-tab/data?session=<id>
//   → 按该会话 cwd 的工作区名读 <DSH_HOME>/memory/<工作区>/TODO.md 并返回内容。
// 没有写端点：本插件不修改任何 TODO.md，页签是纯查看视图。
//
// 会话 id 只用于查宿主自己的会话表（ctx.sessions.get），不接受调用方给路径，
// 因此不存在任意文件读取面。
import { readTodo, workspaceNameOf } from './memory.js';

const name = 'todo-tab';
const inject = ['webServer', 'sessions'];
/** 会话 id 形状（与宿主其它端点一致），用于挡掉空值与畸形输入。 */
const SESSION_ID = /^[A-Za-z0-9-]+$/;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/**
 * 构建端点处理器。导出以便测试直接注入假 ctx 调用，不必起 HTTP 服务。
 * @param ctx - 携带 `sessions` 服务的宿主上下文。
 * @returns webServer 的 handler。
 */
function createHandler(ctx) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const sessionId = url.searchParams.get('session') ?? '';
      if (!SESSION_ID.test(sessionId)) {
        sendJson(res, 400, { ok: false, code: 'bad-session', message: 'missing or malformed session id' });
        return;
      }
      const session = ctx.sessions.get(sessionId);
      if (session === undefined) {
        sendJson(res, 404, { ok: false, code: 'no-session', message: 'no live session with id ' + sessionId });
        return;
      }
      const workspace = workspaceNameOf(session.header?.cwd);
      if (workspace === null) {
        sendJson(res, 409, { ok: false, code: 'no-workspace', message: 'session has no cwd to derive a workspace from' });
        return;
      }
      const todo = await readTodo(workspace);
      sendJson(res, 200, { ok: true, workspace, ...todo });
    } catch (error) {
      ctx.logger.warn('todo-tab: read failed: ' + String(error?.message ?? error));
      sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
    }
  };
}

/**
 * 注册只读端点。路由绑在插件 ctx 生命周期上，停用即注销。
 * @param ctx - 宿主上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/todo-tab/data',
    handler: createHandler(ctx)
  }));
  ctx.logger.info('todo-tab: serving GET /todo-tab/data (read-only)');
}

export { apply, createHandler, inject, name };
export default { apply, inject, name };
