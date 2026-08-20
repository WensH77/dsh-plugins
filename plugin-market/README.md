# dsh-plugin-market（插件市场 · 基础版）

仿照 [dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub) 编写的基础版插件管理面板：
在 **设置 → 插件** 页面新增「插件市场」tab，展示已安装插件、管理可编辑保存的 GitHub 插件源，
支持检查更新与更新插件，安装/更新均走 **git** 通道（跟随 GitHub 仓库默认分支最新提交）。

> 仅实现核心链路：插件清单 / 开关 / 源管理 / 两阶段安装（含安全审查）/ 检查更新 / 更新 / 卸载 / 清理缓存。
> 未实现：市场搜索、技能市场、多源合并、Gitee、OAuth、本地 AI 兜底等高级功能。

**展示范围**：插件市场仅列出**用户安装的第三方插件**（patch 层 insert 的插件 + 非默认的 bundle 包，如
plugin-market 自身）。dsh 自带的官方 bundle（@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app）
与 @deepseek-ai/dsh-* 基础设施跟随 dsh 更新，不在此展示、不可开关/卸载。

## 机制

与 `dsh plugin` CLI 完全一致，走 dsh 自己的加载/卸载链路：

- **开关**：写 `cordis.patch.yml`（用户补丁层，逐键覆盖）——追加 `- id: X` + `disabled: true` 停用、移除即恢复；HMR 热生效，无需重启（host 代码除外）。
- **开关校验**：开关后轮询 loader 树校验是否真的生效；若热更新未应用（树与补丁文件脱节），界面会提示「需重启 dsh web 后生效」。
- **安装（两阶段 + 任务可视化）**：阶段 1 创建安装任务（拉取中 → 审查中 → 待安装），在隔离目录拉取并做安全审查；「待安装插件」区实时展示任务卡片（状态/阶段/耗时/扫描信息/**拉取进度**，1s 轮询）——拉取与安装阶段流式解析 pnpm 的 Progress 行，卡片上展示进度条与依赖解析数；可随时**中断**（无需二次确认，清理残留后任务即刻消失）；点击任务卡片可重开审查报告。审查通过后**需点击「确认安装」**才迁移到 profile（`pnpm add`；bundle 包追加 `dsh.profile.bundles`，普通插件追加 insert 行）；取消则清理隔离目录、不安装。任务 30 分钟过期。关闭安全审查时保持直接安装。
- **安全审查（harness 会话 + 分层）**：先在隔离目录拉取，L0 确定性正则对**全量文件**（不限大小）扫描风险信号（shell 执行 / eval / 动态 import / 外链 URL / base64 / fs 写入 / DOM 注入 / 混淆等），再对命中信号**自动起一轮 dsh 会话**（`agents.create` + `followup` + 轮询会话日志精确提取 JSON 报告）做**定向深挖**，信号多时做一层**聚合终审**；会话在发提示词前即归档隐藏（防用户干扰、防误操作）。会话通道不可用时回退云 LLM 直连。报告按 `包名@版本` 缓存 7 天，含扫描范围（文件数/KB/信号数）、分层方法（L0 clean / L0+L1 / L0+L1+aggregate）与通道（session/llm）。source map 带 `sourcesContent` 时会还原可读源码供交叉参考。
- **审查开关交互**：开启仅需 1 次点击；**关闭需连点 5 次**（点击整个文案计数，实时提示剩余次数）；每次状态切换后有 1 秒保护期，防止误触又开启。状态持久化在 localStorage。
- **pnpm 构建脚本授权（自动 allowBuilds）**：pnpm v10.26+/v11 安全策略（GHSA-5wx6-mg75-v57r）默认禁止 git 托管依赖执行 prepare 构建脚本（报 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）、并把被忽略的传递依赖构建（如 node-pty）以退出码 1 结束（ERR_PNPM_IGNORED_BUILDS）。插件市场作为显式安装器，在安装/更新/布局修复遇到这两类错误时，会**自动把授权写入 pnpm-workspace.yaml 的 allowBuilds 并重试**：git 插件写仓库级键 `包名@git+https://github.com/owner/repo.git`（跨 commit 稳定，插件更新后无需再次授权），被忽略的构建脚本按包名放行；行级合并，保留 profile 原有的 packages/nodeLinker 等配置。
- **更新（git + 本地差异）**：git 通道 `pnpm add github:<owner>/<repo>`（跟随默认分支最新提交）；更新前先拉取新版本并与**本地已装代码**做逐文件差异（新增/删除/修改），把差异与变更内容一并交给审查，报告标注 `method: update-diff`，更新报告里直接展示改动内容。
- **卸载**：先 `pnpm remove` 移除依赖（失败即报错、配置保留、可重试），成功后再移除 insert 行 / bundle 配置；bundle 卸载会额外写一条**临时禁用行**让运行树立即 HMR 卸载（避免"文件已删、旧服务仍引用"导致页面启动报错，重装时自动清理）；卸载同时清除该插件的仓库地址覆盖。
- **检查更新**：git 通道，用 `git ls-remote` 对比远端 HEAD 与本地 lockfile 锁定的 commit。
- **整合仓库（monorepo）**：地址支持 `#path:子目录` 语法（如 `https://github.com/WensH77/dsh-plugins.git#path:chat-rollback`）——git 通道安装该仓库内的子目录插件包，检查更新/更新同样生效（lockfile 的 codeload commit 对比天然兼容子目录格式）。
- **仓库地址**：安装时自动保存**用户填写的仓库地址**（归一化为 `owner/name[#path:子目录]`）为该插件的仓库覆盖，显示与 git 更新通道都不依赖包内 `repository` 字段（很多包未声明）；已安装卡片、编辑仓库地址弹窗均展示该地址。
- **待重启提示**：bundle 层启动时加载——安装后若未重启，已写入 manifest 的 bundle 会显示在「**待重启**」卡片区（标注来源与依赖 spec），重启 dsh web 后加载生效。
- **清理缓存**：一键删除 1 小时前的隔离残留与过期审查报告（`/cleanup`）。**已安装插件当前版本的审查报告永久保留**——点击已安装插件卡片即可查看（复用安装/更新时生成的报告；没有则首次点击时对已安装包现场生成），生成后标记为保留，自动清理与清理缓存都不会删除。

## 安装

```bash
dsh plugin --profile web add ./plugin-market
```

（或克隆后以本地路径安装；重启 `dsh web` 后进入 设置 → 插件 → 插件市场。）

> host 端代码改动（`lib/index.js`）需重启 `dsh web` 生效；client 端（`lib/client.js`）每次请求实时加载，刷新页面即可。

## 端点

| 端点 | 方法 | 用途 |
|---|---|---|
| `/plugin-market/state` | GET | 插件清单 + 补丁层状态 + GitHub 源列表 + 待重启 bundle + 进行中任务 |
| `/plugin-market/sources` | POST | 保存 GitHub 源列表 |
| `/plugin-market/toggle` | POST | 启用/停用插件 |
| `/plugin-market/check-update` | POST | 检查更新（git：对比远端 HEAD 与本地锁定 commit；开启审查时对新版本做安全审查） |
| `/plugin-market/install` | POST | 安装阶段 1：建任务 + 隔离拉取 + 安全审查，返回 `{ pending, jobId, review }` 待确认 |
| `/plugin-market/install/confirm` | POST | 确认安装：把阶段 1 的任务迁移进 profile |
| `/plugin-market/install/cancel` | POST | 取消安装：清理隔离目录，不迁移 |
| `/plugin-market/install/interrupt` | POST | 中断安装任务（拉取中/审查中/待安装均可；清理残留后任务即刻消失） |
| `/plugin-market/update` | POST | 更新已安装插件（git 通道；附带相对本地已装代码的差异审查） |
| `/plugin-market/uninstall` | POST | 卸载插件（先删依赖后删配置，失败可重试；bundle 即时卸载） |
| `/plugin-market/set-repo` | POST | 手动设置/清除某个插件的 GitHub 仓库地址（空串 = 清除覆盖） |
| `/plugin-market/cleanup` | POST | 一键清理缓存（1 小时前的隔离残留与过期审查报告） |

## 配置

无强制配置。GitHub 源列表持久化在 `~/.dsh/plugin-market-sources.json`；
插件仓库地址覆盖持久化在 `~/.dsh/plugin-market-repos.json`（安装时自动写入用户填写的仓库；优先于包内 `repository` 字段，用于 git 通道检查/更新）；
审查报告缓存与隔离目录在 `~/.dsh/plugin-market-reviews`、`~/.dsh/plugin-market-staging`（7 天/清理按钮管理）。

## 开发

```bash
node --check lib/index.js lib/client.js   # 语法检查
```

host 端零第三方依赖（只用 node 内置模块）；client 端为 ModuleLoader 手写格式，无需构建。

## License

MIT
