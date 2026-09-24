import { collectBody, errMsg, isLoopback, sendError, sendJson } from './util.js'
import { analyzeDshUpdate, checkDshUpdate, dshStateCache } from './dsh.js'

const ROUTE_PREFIX = '/plugin-market'

// ── dsh 版本检测路由 ────────────────────────────────────────────────────────

/** 把 handler 主体包成环回路由处理器：主体抛错统一回 500（错误消息用户可读）。 */
const asHandler = (run) => async (ctx, body, res) => {
  try {
    await run(ctx, body, res)
  } catch (error) {
    sendError(res, 500, errMsg(error))
  }
}

// dsh 自更新状态（侧边栏状态灯）：返回已装/远端版本 + 判定
const handleDshVersion = asHandler(async (ctx, body, res) => {
  const state = dshStateCache ?? await checkDshUpdate(ctx)
  sendJson(res, 200, { ok: true, ...state })
})

// 强制重新检测 dsh 更新（点击绿灯/灰灯时手动重检）
const handleDshVersionCheck = asHandler(async (ctx, body, res) => {
  const state = await checkDshUpdate(ctx)
  sendJson(res, 200, { ok: true, ...state })
})

// 点击状态灯：后台直连 LLM（默认模型）分析升级内容与破坏性更新，不建会话
const handleDshVersionAnalyze = asHandler(async (ctx, body, res) => {
  const result = await analyzeDshUpdate(ctx)
  sendJson(res, 200, result)
})

// 路由分发表：method 为 null 表示不限制方法（与原实现 pathname-only 分支一致）。
const ROUTES = [
  { method: 'GET', path: '/dsh-version', handler: handleDshVersion },
  { method: null, path: '/dsh-version/check', handler: handleDshVersionCheck },
  { method: null, path: '/dsh-version/analyze', handler: handleDshVersionAnalyze }
]

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const method = req.method ?? 'GET'
  const body = await collectBody(req)

  for (const route of ROUTES) {
    if ((route.method === null || route.method === method) && pathname === ROUTE_PREFIX + route.path) {
      await route.handler(ctx, body, res)
      return
    }
  }
  sendError(res, 404, '未知接口 ' + pathname)
}

export function registerRoutes(ctx) {
  return ctx.effect(() => {
    const route = {
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
          sendError(res, 403, '仅允许本机访问')
          return
        }
        try {
          await handle(ctx, req, res)
        } catch (error) {
          sendError(res, 500, errMsg(error))
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'plugin-market: routes')
}

export { ROUTE_PREFIX, ROUTES, handle }
