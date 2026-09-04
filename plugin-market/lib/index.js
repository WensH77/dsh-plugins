/**
 * dsh-plugin-market — 插件市场（基础版）宿主端。
 *
 * 提供环回 HTTP 路由（前缀 /plugin-market）：
 *   GET  /plugin-market/state        插件清单 + 补丁层状态 + GitHub 源列表
 *   POST /plugin-market/sources      保存 GitHub 源列表（可编辑、可持久化）
 *   POST /plugin-market/toggle       启用/停用插件（写 cordis.patch.yml，HMR 生效）
 *   POST /plugin-market/check-update 检查更新（git 通道：对比远端 HEAD 与本地 lockfile commit；开启审查时附本次改动差异审查）
 *   POST /plugin-market/update       更新插件（git 通道，以安装来源仓库为准，跟随仓库默认分支最新提交）
 *   POST /plugin-market/uninstall    卸载插件（移除 insert 行 + pnpm remove）
 *
 * 机制：与 dsh plugin CLI 一致——用户补丁层 cordis.patch.yml 是逐键覆盖，
 * 追加 - id + disabled:true 停用任意行、移除即恢复；insert 行启用新插件；
 * pnpm 在 profile 目录增删依赖；bundle 包追加到 package.json 的 dsh.profile.bundles。
 */
import { cleanupStagingAndReviews, clearAllPendingMarkers } from './install.js'
import { checkDshUpdate, DSH_CHECK_INTERVAL_MS } from './dsh.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-plugin-market'
export const inject = ['webServer', 'loader', 'agents']

/** 应用插件：注册 /plugin-market 路由。 */
export function apply(ctx) {
  void cleanupStagingAndReviews(ctx)
  // dsh web 重启：清空「更新后待重启 / 更新失败」标记——重启后运行树已加载最新代码，提示不再适用
  void clearAllPendingMarkers()
  // dsh 自更新检测：web 启动时一次 + 每 1 小时同步（随插件 dispose 清理定时器）
  ctx.effect(() => {
    void checkDshUpdate(ctx)
    const timer = setInterval(() => { void checkDshUpdate(ctx) }, DSH_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'plugin-market: dsh update check')
  return registerRoutes(ctx)
}
