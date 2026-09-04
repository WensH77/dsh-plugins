// dsh-plugin-command-setting — webServer 路由域。
// 从原单文件 index.js 拆出：HTTP 样板（sendJson / readBody / registerWebRoute）
// 与三个端点（GET /command-setting/catalog、POST /command-setting/set、
// GET /command-setting/ask-state）。端点经 env 访问共享状态（ctx / original 未
// 过滤命令面 / hiddenSet / scope / ask 控制器），由 index 装配。
import { cleanHidden, PROTECTED, COMMAND_NAME, sweepArchived } from './commands.js';
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done) => {
    // 框架已预解析 body 时直接取用（防止 webServer 升级后 data 事件不再来、
    // 端点挂起）；否则手动聚合，超 64KB 截断为 '{}'（后续 JSON 校验兜底 400）。
    if (typeof req.body === 'string') {
      done(req.body);
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) truncated = true;
      else chunks.push(chunk);
    });
    req.on('end', () => done(truncated ? '{}' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done('{}'));
  });
}

/**
 * 注册 webServer 路由并容忍 re-init 时残留的同路径旧路由（停用/重载后旧 handler
 * 已随旧 ctx 失效，probe 会报 inactive context）：命中 duplicate 先清掉旧路由
 * 再重新注册，保证「停用后重新启用」幂等。
 */
function registerWebRoute(ctx, route) {
  // 把路由绑定到插件 ctx 生命周期：停用（ctx dispose）时 cordis 自动执行清理
  // 注销路由，重新启用再注册不会撞 duplicate route（实测停用后旧路由会残留，
  // 旧 handler 已随旧 ctx 失效）。兜底：命中 duplicate 时清掉残留路由后重注册。
  return ctx.effect(() => {
    try {
      return ctx.webServer.register(route);
    } catch (error) {
      if (!/duplicate/.test(String(error?.message ?? error))) throw error;
      const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes;
      if (table && typeof table.delete === 'function') table.delete(route.path);
      return ctx.webServer.register(route);
    }
  });
}

/** 注册全部端点路由（幂等，见 registerWebRoute）。apply 装配阶段调用；返回的
 * disposer 随插件停用注销。 */
function registerRoutes(env) {
  return [
    registerWebRoute(env.ctx, {
      kind: 'exact',
      path: '/command-setting/catalog',
      handler: async (req, res) => {
        try {
          // 归档清理：仅在客户端上报了贡献命令面（contributions 参数存在）时
          // 执行——参数缺失意味着调用方不了解浏览器贡献命令（外部/旧客户端），
          // 清理会把 /model 这类贡献命令的 hidden 误删。参数存在即使为空串，
          // 也代表"贡献面已知为空"，命令面可信。
          const url = new URL(req.url ?? '/', 'http://x');
          const contributionsParam = url.searchParams.get('contributions');
          if (contributionsParam !== null) {
            const contributionSet = new Set(
              contributionsParam.split(',').filter((entry) => COMMAND_NAME.test(entry))
            );
            await sweepArchived(env, contributionSet);
          }
          // Unfiltered views: the settings page must still list hidden commands
          // so they can be shown again — global registrations always, plus the
          // UNFILTERED agent-scoped registrations of the requesting session
          // (?session=<id>). Hidden agent-scoped commands are filtered from the
          // live directory, so without this union the settings page could not
          // show (or un-hide) them and pruning would drop them from the list.
          // Client-side contribution commands are merged in by the browser half.
          const byName = new Map();
          for (const descriptor of env.original(undefined)) byName.set(descriptor.name, descriptor);
          const sessionId = url.searchParams.get('session') ?? '';
          if (sessionId !== '' && /^[A-Za-z0-9-]+$/.test(sessionId)) {
            try {
              // commands.list() scopes by the AGENT object (the scoped-layer key),
              // not by the wire sessionId — the Typert gateway resolves the id to
              // the agent before calling. Mirror that here so agent-scoped commands
              // (e.g. /compact, registered inside the code preset composition) show
              // up in the settings page and can be un-hidden.
              const agent = env.ctx.agents.get(sessionId);
              if (agent !== void 0) {
                for (const descriptor of env.original(agent)) byName.set(descriptor.name, descriptor);
              }
            } catch (error) {
              env.ctx.logger.warn('command-setting: per-session catalog failed: ' + String(error?.message ?? error));
            }
          }
          const commands = [...byName.values()].map((descriptor) => ({
            name: descriptor.name,
            description: descriptor.description,
            ...(descriptor.input === void 0 ? {} : { hint: descriptor.input.hint })
          }));
          sendJson(res, 200, { ok: true, commands, hidden: cleanHidden([...env.hiddenSet]), protected: PROTECTED });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    registerWebRoute(env.ctx, {
      kind: 'exact',
      path: '/command-setting/set',
      handler: async (req, res) => {
        try {
          const payload = JSON.parse((await readBody(req)) || '{}');
          const raw = payload.hidden;
          if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
            sendJson(res, 400, { ok: false, code: 'bad-hidden', message: 'hidden must be an array of command names' });
            return;
          }
          for (const entry of raw) {
            if (!COMMAND_NAME.test(entry)) {
              sendJson(res, 400, { ok: false, code: 'bad-name', message: 'invalid command name "' + entry + '"' });
              return;
            }
          }
          if (env.scope === null) {
            sendJson(res, 503, { ok: false, code: 'settings-unavailable', message: 'settings service is not mounted' });
            return;
          }
          // Protected system commands are dropped before persisting; duplicates
          // collapse (the list is a set semantically).
          await env.scope.update({ hidden: [...new Set(cleanHidden(raw))] });
          // scope.update refreshes hiddenSet and notifies the browser (the real
          // registration does it via scope.watch; the leaked-reuse substitute
          // does it inside its own update).
          sendJson(res, 200, { ok: true, hidden: cleanHidden([...env.hiddenSet]) });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    // ask 模式状态端点：GET /command-setting/ask-state?session=<id> -> { ok, active }
    registerWebRoute(env.ctx, {
      kind: 'exact',
      path: '/command-setting/ask-state',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x');
          const sessionId = url.searchParams.get('session') ?? '';
          const active = sessionId !== '' && /^[A-Za-z0-9-]+$/.test(sessionId) && env.ask.active(sessionId);
          sendJson(res, 200, { ok: true, active });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    })
  ];
}

export { registerRoutes };
