# dsh-plugin-market（插件市场 · 基础版）

仿照 [dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub) 编写的基础版插件管理面板：
在 **设置 → 插件** 页面新增「插件市场」tab，展示已安装插件、管理可编辑保存的 GitHub 插件源，
支持检查更新与更新插件，安装/更新均走 **git** 通道（跟随 GitHub 仓库默认分支最新提交）。

> 仅实现核心链路：插件清单 / 开关 / 源管理 / 检查更新 / 安装 / 更新 / 卸载。
> 未实现：市场搜索、技能市场、多源合并、Gitee、OAuth、本地 AI 兜底等高级功能。

**展示范围**：插件市场仅列出**用户安装的第三方插件**（patch 层 insert 的插件 + 非默认的 bundle 包，如
plugin-market 自身）。dsh 自带的官方 bundle（@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app）
与 @deepseek-ai/dsh-* 基础设施跟随 dsh 更新，不在此展示、不可开关/卸载。

## 机制

与 `dsh plugin` CLI 完全一致，走 dsh 自己的加载/卸载链路：

- **开关**：写 `cordis.patch.yml`（用户补丁层，逐键覆盖）——追加 `- id: X` + `disabled: true` 停用、移除即恢复；HMR 热生效，无需重启（host 代码除外）。
- **开关校验**：开关后轮询 loader 树校验是否真的生效；若热更新未应用（树与补丁文件脱节），界面会提示「需重启 dsh web 后生效」。
- **安装（两阶段）**：阶段 1 在隔离目录拉取并做安全审查，弹出报告后**需点击「确认安装」才迁移**到 profile（`pnpm add`；bundle 包追加 `dsh.profile.bundles`，普通插件追加 insert 行）；点击「取消」清理隔离目录、不安装。关闭安全审查时保持直接安装。
- **安全审查（分层）**：先在隔离目录拉取，L0 确定性正则对**全量文件**（不限大小）扫描风险信号（shell 执行 / eval / 动态 import / 外链 URL / base64 / fs 写入 / DOM 注入 / 混淆等），再对命中信号分批交给 subagent **定向深挖**（带上下文），信号多时做一层**聚合终审**；报告按 `包名@版本` 缓存 7 天。source map 带 `sourcesContent` 时会还原可读源码供交叉参考。
- **更新**：git 通道 `pnpm add github:<owner>/<repo>`（跟随默认分支最新提交）。
- **卸载**：移除 insert 行 + `pnpm remove`。
- **检查更新**：git 通道，用 `git ls-remote` 对比远端 HEAD 与本地 lockfile 锁定的 commit。
- **整合仓库（monorepo）**：地址支持 `#path:子目录` 语法（如 `https://github.com/WensH77/dsh-plugins.git#path:chat-rollback`）——git 通道安装该仓库内的子目录插件包，检查更新/更新同样生效（lockfile 的 codeload commit 对比天然兼容子目录格式）。

## 安装

```bash
dsh plugin --profile web add ./plugin-market
```

（或克隆后以本地路径安装；重启 `dsh web` 后进入 设置 → 插件 → 插件市场。）

## 端点

| 端点 | 方法 | 用途 |
|---|---|---|
| `/plugin-market/state` | GET | 插件清单 + 补丁层状态 + GitHub 源列表 |
| `/plugin-market/sources` | POST | 保存 GitHub 源列表 |
| `/plugin-market/toggle` | POST | 启用/停用插件 |
| `/plugin-market/check-update` | POST | 检查更新（git：对比远端 HEAD 与本地锁定 commit） |
| `/plugin-market/install` | POST | 安装阶段 1：隔离拉取 + 安全审查，返回 `{ pending, jobId, review }` 待确认 |
| `/plugin-market/install/confirm` | POST | 确认安装：把阶段 1 的任务迁移进 profile |
| `/plugin-market/install/cancel` | POST | 取消安装：清理隔离目录，不迁移 |
| `/plugin-market/update` | POST | 更新已安装插件（git 通道） |
| `/plugin-market/uninstall` | POST | 卸载插件 |
| `/plugin-market/set-repo` | POST | 手动设置/清除某个插件的 GitHub 仓库地址（空串 = 清除覆盖） |

## 配置

无强制配置。GitHub 源列表持久化在 `~/.dsh/plugin-market-sources.json`；
用户手动指定的插件仓库地址覆盖持久化在 `~/.dsh/plugin-market-repos.json`（优先于包内 `repository` 字段，用于 git 通道检查/更新）。

## 开发

```bash
node --check lib/index.js lib/client.js   # 语法检查
```

host 端零第三方依赖（只用 node 内置模块）；client 端为 ModuleLoader 手写格式，无需构建。

## License

MIT
