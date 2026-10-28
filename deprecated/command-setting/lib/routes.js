// dsh-plugin-command-setting — webServer 路由域。
// HTTP 样板（sendJson / registerWebRoute）与唯一端点
// GET /command-setting/ask-state（会话 ask 开关状态，供 Ask 按钮回显激活态）。
// 端点经 env 访问共享状态（ctx / ask 控制器），由 index 装配。
//
// 历史：0.9.0 起不再有 /command-setting/catalog 与 /command-setting/set——
// 「命令隐藏」功能整体移除（见 CHANGELOG）。
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
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
