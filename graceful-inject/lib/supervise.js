/**
 * 优雅注入 · 功能二：监工（supervise）。
 *
 * 会话标题栏的秒表按钮点一下，宿主就往当前会话注入一条：
 *
 *   「不要停止你现在手头的事情，汇报当前任务进度」
 *
 * 走 `agent.steer(...)` 而不是 `followup(...)`：监工的对象通常**正在跑**，`followup`
 * 要等这一轮结束才轮到，用户点了半天看不到汇报；`steer` 在最近一个步骤边界被取走，
 * 当前轮不中断。Agent 空闲时 `steer` 也会直接开一轮（宿主文档：an idle driver starts
 * a turn）。
 *
 * 消息带自定义来源（`source.kind = graceful-inject` + `form: 'notice'`），聊天里是
 * 触发条目而不是用户气泡——用户没说过这句话，是插件说的。
 *
 * 开关：`supervise: false` 时端点不注册（404），`GET /graceful-inject/state` 会告诉
 * 浏览器端别画按钮。
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SOURCE_KIND } from './source.js';

/** 注入文本，逐字对应这个功能要表达的意思。 */
const SUPERVISE_TEXT = '不要停止你现在手头的事情，汇报当前任务进度';
/**
 * 注入正文开头的来源说明。
 *
 * 模型看到的消息只有正文，`source` 是给 Chat 渲染用的；不写这一句，模型会把插件注入
 * 当成用户手打的要求，也就没法区分「用户现在在催」还是「插件按配置发的通知」。
 */
const NOTICE_PREFIX = '这条通知来自插件「优雅注入」（dsh-plugin-graceful-inject），';
/** 同一会话两次注入的最小间隔：连点、多标签页、脚本直调共用这一个窗口。 */
const THROTTLE_MS = 10_000;
/** 会话 id 形状（与宿主其它端点一致），用于挡掉空值与畸形输入。 */
const SESSION_ID = /^[A-Za-z0-9-]+$/;

/** 组装那条监工消息。导出一份便于测试直接断言。 */
function superviseMessage(text = SUPERVISE_TEXT) {
  const body = NOTICE_PREFIX + text;
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: boundContextSummary(body) }
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/**
 * 兜底的本机来源判断。
 *
 * 自定义 `webServer.register` 路由不经过 api-gateway 的远程访问鉴权，所以这个
 * 端点自己决定谁能调。单独用 `remoteAddress` 不够：用户浏览器里任意页面发到
 * 127.0.0.1 的请求同样来自 loopback，挡不住 DNS rebinding 和跨站请求。正常
 * 装配下用 {@link trustedRequest} 走宿主的 connection 服务；这个函数只在没有
 * 该服务的宿主（测试、精简组合）里兜底。
 *
 * @param req - Node 请求对象。
 * @returns 来源是否为本机回环地址。
 */
function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  return address === '::1' || /^127\./u.test(address) || /^::ffff:127\./iu.test(address);
}

/**
 * 请求是否来自本部署信任的页面。
 *
 * 优先用宿主 `connection` 服务的 `isTrusted(req)`——它和 `/api` 走的是同一套判定：
 * Host 必须属于本部署，`Sec-Fetch-Site: cross-site` 直接拒，带 `Origin` 时必须与
 * Host 同源。这样挡住两类「本机来源但不可信」的请求：DNS rebinding（Host 是攻击者
 * 域）和别的网页发起的跨站请求。
 *
 * 没有该服务时回落到 {@link isLoopbackRequest}。
 *
 * @param ctx - 宿主上下文（`ctx.get('connection')` 可能不存在）。
 * @param req - Node 请求对象。
 * @returns 是否放行。
 */
function trustedRequest(ctx, req) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  if (connection !== undefined && typeof connection.isTrusted === 'function') return connection.isTrusted(req) === true;
  return isLoopbackRequest(req);
}

/**
 * `GET /graceful-inject/state`：浏览器端据此决定画不画按钮。
 *
 * 开关在插件装配时定；profile 改 patch 会经 hmr 重载插件，浏览器端每次挂载都重新
 * 探测，所以运行期关掉之后下一次挂载就不会再画按钮。
 *
 * @param options - `{ resume, supervise, superviseText }`：两个开关与要注入的文本。
 * @returns webServer handler。
 */
function createStateHandler(options) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'method', message: 'only GET is allowed' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      resume: options.resume,
      supervise: options.supervise,
      // 按钮提示用宿主实际会注入的文本；改配置后重新挂载即同步。
      superviseText: options.superviseText === undefined ? SUPERVISE_TEXT : options.superviseText
    });
  };
}

/**
 * `POST /graceful-inject/supervise?session=<id>`：注入监工消息。
 *
 * 只认 POST：这个端点有副作用，GET 预取或缓存不应该变成一次注入。
 *
 * 同一会话 **10 秒只放一条**：连点、多个标签页、脚本直调都走同一个节流窗口，
 * 超出的请求回 `429 throttled` 与剩余秒数（`retryAfter`）。
 *
 * 正常情况下 `supervise: false` 时这个 handler 不会被注册（见 lib/index.js）；这里的
 * 409 是防御分支，避免将来某条装配路径在关闭状态下把它注册出来。
 *
 * @param ctx - 携带 `agents` / `sessions` 的宿主上下文。
 * @param options - `{ supervise, superviseText }`：开关与要注入的文本（缺省用 {@link SUPERVISE_TEXT}）。
 * @returns webServer handler。
 */
function createSuperviseHandler(ctx, options) {
  /** 每个会话上一次成功注入的时间戳；窗口外的键顺手清理，Map 不会无界增长。 */
  const lastInjectedAt = new Map();
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method', message: 'only POST is allowed' });
        return;
      }
      if (options.supervise !== true) {
        sendJson(res, 409, { ok: false, code: 'disabled', message: 'supervise is disabled in this profile' });
        return;
      }
      if (!trustedRequest(ctx, req)) {
        sendJson(res, 403, { ok: false, code: 'remote', message: 'supervise only accepts requests from a trusted page of this deployment' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const sessionId = url.searchParams.get('session') ?? '';
      if (!SESSION_ID.test(sessionId)) {
        sendJson(res, 400, { ok: false, code: 'bad-session', message: 'missing or malformed session id' });
        return;
      }
      const now = Date.now();
      const last = lastInjectedAt.get(sessionId);
      if (last !== undefined && now - last < THROTTLE_MS) {
        const retryAfter = Math.ceil((THROTTLE_MS - (now - last)) / 1000);
        sendJson(res, 429, {
          ok: false,
          code: 'throttled',
          retryAfter,
          message: 'supervise allows one injection per ' + THROTTLE_MS / 1000 + ' seconds per session'
        });
        return;
      }
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) {
        sendJson(res, 404, {
          ok: false,
          code: 'no-agent',
          message: 'session ' + sessionId + ' has no live agent (it may have ended, or come from an earlier dsh process)'
        });
        return;
      }
      const text = options.superviseText === undefined || options.superviseText === ''
        ? SUPERVISE_TEXT
        : options.superviseText;
      // 运行中的 Agent 可能正卡在一个长等待里（例如 300 秒的 wait 类工具）。`steer` 只在
      // 步骤边界被取走，等下去就失去「点一下马上汇报」的意义，所以先打断当前步骤：
      // `keepInbox` 保住已排队的输入，随后的 `steer` 作为唤醒输入在取消收敛后开新一轮。
      // 代价是当前工具被中止（AbortSignal），它可能需要重新发起——这正是「不等待」的交换。
      const interrupted = agent.status === 'running' && typeof agent.cancel === 'function';
      if (interrupted) agent.cancel({ kind: 'user' }, { keepInbox: true });
      agent.steer(superviseMessage(text));
      // 先记时间再 flush：flush 失败时消息其实已经投出去了，不能放行第二次。
      lastInjectedAt.set(sessionId, now);
      for (const [id, at] of lastInjectedAt) {
        if (now - at >= THROTTLE_MS) lastInjectedAt.delete(id);
      }
      await ctx.sessions.flush(agent.session);
      ctx.logger.info('graceful-inject: 已向会话 ' + sessionId + ' 注入监工（agent=' + String(agent.status) + (interrupted ? '，已打断当前步骤' : '') + '）');
      sendJson(res, 200, { ok: true, mode: interrupted ? 'interrupt' : 'steer', summary: NOTICE_PREFIX + text });
    } catch (error) {
      ctx.logger.warn('graceful-inject: 监工注入失败: ' + String(error?.message ?? error));
      // 响应可能已经在发送途中（例如 flush 之后），再写一次只会多一条
      // "headers already sent"，把真正的失败盖掉。
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
    }
  };
}

export { createStateHandler, createSuperviseHandler, isLoopbackRequest, NOTICE_PREFIX, sendJson, SESSION_ID, superviseMessage, SUPERVISE_TEXT, THROTTLE_MS, trustedRequest };
