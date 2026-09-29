/**
 * dsh-version-check — dsh（DeepSeek Harness）版本检测宿主端。
 *
 * 提供环回 HTTP 路由（前缀 /dsh-version-check），只做 dsh 本体版本检测与升级分析：
 *   GET  /dsh-version-check/dsh-version         已装/远端版本 + 判定（侧边栏状态灯）
 *   POST /dsh-version-check/dsh-version/check   强制重新检测
 *   POST /dsh-version-check/dsh-version/analyze 后台直连 LLM 分析升级内容与破坏性更新
 *
 * 机制：启动时检测一次，之后每 1 小时同步一次；判定持久化在 ~/.dsh/dsh-version-check.json。
 */
import { checkDshUpdate, DSH_CHECK_INTERVAL_MS } from './dsh.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-version-check'
export const inject = ['webServer', 'loader', 'agents']

/** 应用插件：注册 /dsh-version-check 路由。 */
export function apply(ctx) {
  // dsh 自更新检测：web 启动时一次 + 每 1 小时同步（随插件 dispose 清理定时器）
  ctx.effect(() => {
    void checkDshUpdate(ctx)
    const timer = setInterval(() => { void checkDshUpdate(ctx) }, DSH_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'dsh-version-check: dsh update check')
  return registerRoutes(ctx)
}
