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
- **帮我安装 / 帮我更新（失败交给 harness 会话）**：安装失败时任务卡片**保留在列表**并展示报错信息，卡片上出现「**帮我安装**」按钮——**拉取 / 审查 / 安装任一阶段失败都提供**（只有「审查通过、等待确认安装」这种未失败的挂起态不显示）。更新失败时，已安装卡片上出现「**帮我更新**」按钮。两者点击后都开启一个**可见的 harness 会话**（挂到当前工作区、侧边栏可直接打开），并共用同一份极简首条消息：

  ```
  帮我安装、更新插件：https://github.com/<owner>/<name>[#path:<子目录>]，不要自行重启
  ```

  仓库地址按 *市场安装记录 > 包内 `repository` 字段 > profile 依赖里的 `github:` spec* 三级回退解析，并统一规整成完整 GitHub 地址。诊断（网络 / pnpm 锁文件 / 构建脚本授权 / 仓库地址等）与具体安装、更新做法由会话自行决定；**「不要自行重启」是硬要求**——重启 dsh web 会把会话所在的进程一并杀掉，用户就看不到结果了。安装任务随即标记「已交予会话安装」，更新则把会话 id 记入失败标记，重复点击均幂等返回同一会话。
- **安全审查（纯 LLM 直连 + 分层）**：先在隔离目录拉取，L0 确定性正则对**全量文件**（不限大小）扫描风险信号（shell 执行 / eval / 动态 import / 外链 URL / base64 / fs 写入 / DOM 注入 / 混淆等），再对命中信号**直连 LLM**（`ctx.llm.stream`，120s 超时）做**定向深挖**，信号多时做一层**聚合终审**。**模型与推理程度可调**：安全审查开启时可选 Flash/Pro × 无思考/低/高/Max（默认 Pro Max，localStorage 持久化；请求级覆盖 agent-default-model，未选择时仍跟随设置默认）。报告按 `包名@版本` 缓存 7 天，含扫描范围（文件数/KB/信号数）、分层方法（L0 clean / L0+L1 / L0+L1+aggregate）与通道（llm）。source map 带 `sourcesContent` 时会还原可读源码供交叉参考。**LLM 通道不可用时降级为 L0 静态兜底报告**（`method:'l0-only'`）：直接呈现扫描命中的风险特征清单（类型 · 文件:行号）与按信号权重粗判的结论（命中 shell 执行/eval → danger，其余 caution），标注未经模型语义判断；1 小时复用窗口内不重复尝试，通道恢复后自动重新生成完整报告。**审查报告文本一律为简体中文**（summary/risks/details 强制中文输出，仅字段名与枚举值 severity/verdict 为英文）。
- **审查开关交互**：开启仅需 1 次点击；**关闭需连点 5 次**（点击整个文案计数，实时提示剩余次数）；每次状态切换后有 1 秒保护期，防止误触又开启。状态持久化在 localStorage。
- **pnpm 构建脚本授权（自动 allowBuilds）**：pnpm v10.26+/v11 安全策略（GHSA-5wx6-mg75-v57r）默认禁止 git 托管依赖执行 prepare 构建脚本（报 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）、并把被忽略的传递依赖构建（如 node-pty）以退出码 1 结束（ERR_PNPM_IGNORED_BUILDS）。插件市场作为显式安装器，在安装/更新/布局修复遇到这两类错误时，会**自动把授权写入 pnpm-workspace.yaml 的 allowBuilds 并重试**：git 插件写仓库级键 `包名@git+https://github.com/owner/repo.git`（跨 commit 稳定，插件更新后无需再次授权），被忽略的构建脚本按包名放行；行级合并，保留 profile 原有的 packages/nodeLinker 等配置。
- **更新（git + 本地差异，直接安装）**：git 通道 `pnpm add github:<owner>/<repo>`（跟随默认分支最新提交）。**检查更新**开启安全审查并检测到更新时，拉取新版本到隔离目录、与**本地已装代码**做逐文件差异（新增/删除/修改）并审查变更，报告标注 `method: update-diff`、直接展示改动内容；审查通过后**保留隔离目录**（登记更新任务，30 分钟有效）——点「确认更新」时**直接从该隔离环境安装**，不再重新拉取/审查（只弹进行中提示，安装完成后展示结果或更新审查报告，不静默执行）；审查报告同时**保存为该插件的新版本**，之后点击已安装插件卡片即可直接查看（无需再次生成）。**关闭安全审查时**，检查更新检测到新版本后已安装卡片直接出现「更新」按钮，点击即 git 通道直接更新（不重新审查），不再出现「检查到更新却无处更新」。
- **卸载**：先 `pnpm remove` 移除依赖（失败即报错、配置保留、可重试），成功后再移除 insert 行 / bundle 配置；bundle 卸载会额外写一条**临时禁用行**让运行树立即 HMR 卸载（避免"文件已删、旧服务仍引用"导致页面启动报错，重装时自动清理）；卸载同时清除该插件的仓库地址覆盖。
- **检查更新**：git 通道，用 `git ls-remote` 对比远端 HEAD 与本地 lockfile 锁定的 commit；开启安全审查时，与「更新」一致对新版本与已装代码做文件级差异审查，报告标注 `method: update-diff` 并直接展示本次改动（新增/删除/修改）；**新版本 commit 的审查报告已缓存时直接复用、不重复 LLM 审查**；审查后保留隔离目录，确认更新直接安装（见上条）。本地 link/file 安装的插件（无锁定 commit）「检查更新」按钮禁用——此类插件在源码目录 `git pull` 后重启 dsh web 生效。**手动拷贝安装**（无 git 依赖、非本地安装，如按旧文档 `cp -R` 安装的插件）但包内 `repository` 可解析且仓库可达时，检查更新提示「未从 git 安装」并直接提供「更新」按钮——点击经 git 通道 `pnpm add` 一次转为 git 依赖并安装远端最新版，后续即可正常检查/更新。
- **整合仓库（monorepo）**：地址支持 `#path:子目录` 语法（如 `https://github.com/WensH77/dsh-plugins.git#path:chat-rollback`）——git 通道安装该仓库内的子目录插件包，检查更新/更新同样生效（lockfile 的 codeload commit 对比天然兼容子目录格式）。
- **仓库展示（安装来源）**：安装时自动保存**用户填写的仓库地址**（归一化为 `owner/name[#path:子目录]`）为该插件的**来源仓库**；已安装卡片展示来源仓库或本地安装路径（link:/file: 依赖）。没有 marketplace 记录时（如 CLI 安装的插件）自动**回落**到包内 `repository` 字段、再到 `github:` 依赖 spec，保证 CLI 安装的 git 插件也能看到来源并检查更新。
- **待重启提示**：bundle 层启动时加载——安装后若未重启，已写入 manifest 的 bundle 会显示在「**待重启**」卡片区（标注来源与依赖 spec），重启 dsh web 后加载生效。insert 层插件在热重载关闭/未生效时（已写入补丁但未进运行树）同样列入「待重启」，避免「已安装」「待重启」都看不到它。**更新后**同样需要重启——`pnpm add` 只替换磁盘代码，运行树内存仍是旧版本：更新成功后写入「更新后待重启」标记（持久化在 `~/.dsh/plugin-market-pending.json`），插件进入「待重启」区并提示「更新已下载：重启 dsh web 后加载新版本」，dsh web 重启时自动清空标记。**更新失败**（如 pnpm lockfile / 布局 / 网络等错误）会写入失败标记，已安装卡片持续显示「更新失败（可能处于不一致状态，重启前不会生效）」与修复指引（旁边有「**帮我更新**」按钮，点击开启可见 harness 会话，首条消息与「帮我安装」相同，会话 id 记入失败标记、重复点击幂等），直到重试成功 / 卸载 / 重启。**审查生成中 / 更新安装中的弹窗可关闭**（「取消」按钮 + 点击遮罩）：更新弹窗关闭后请求在后台继续完成、结果只走消息提示，不再弹回报告。
- **清理缓存**：一键删除 1 小时前的隔离残留与过期审查报告（`/cleanup`）。**已安装插件当前版本的审查报告永久保留**——点击已安装插件卡片即可查看（复用安装/更新时生成的报告；没有则首次点击时对已安装包现场生成），生成后标记为保留，自动清理与清理缓存都不会删除。
- **dsh 版本状态灯（侧边栏）**：在侧边栏品牌名（DeepSeek Harness）下方注入一个**状态灯 + 已装 dsh 版本号**，检测对象是 **`deepseek-ai/deepseek-harness`**（dsh 本体）——**按 GitHub Releases 取最新发布版本**（release 语义，非 git commit hash；限流时回退 `git ls-remote --tags`），**web 启动时检测一次 + 每 1 小时同步**。绿=已是最新；黄=有新版本（尚未分析或无破坏性）；红=有新版本且存在破坏性更新；灰=无法检查。状态灯文字**简约拼接**：`v0.1.1-rc.2 · 有新版本` / `v0.1.1-rc.2 · 破坏性更新` / `v0.1.1-rc.2 · 正在分析新版本…`（无 hover 文案）。**点击行为**：已有判定（红/黄）→ **弹出判定弹窗**（结论/摘要/**版本变更明细**/变更要点/可能受影响的插件/**本地插件契约扫描（机器判定）**/详情，报告文本一律简体中文）；尚未分析（黄灯待分析）→ **先跑 L1 本地插件契约扫描（机器判定，不依赖 LLM）再静默直连 LLM**（`ctx.llm.stream`，跟随默认模型 `agent-default-model`，120s 超时，不建会话、不弹窗）**逐版本分析**“当前版本 → 最新版本之间的每一个版本更新了什么、是否对当前已安装插件有破坏性更新”，解析 `breakingChanges` 与 `versions` 并持久化——无破坏保持黄、有破坏变红。**L1 契约扫描（机器证据，先于模型分析）**：枚举已安装用户插件，读本地包内 `dsh.client.inject` 注入名、`lib/*.js` 代码中的 `@deepseek-ai/…` 引用字面量与声明的宿主依赖范围（使用指纹）；从 npm registry 按**精确版本号**（dist-tag 不可信）拉取目标版本 `dsh-web-app`/`dsh-base` 的依赖闭包，与本地运行树闭包对比，产出两类高置信机器结论——`removed-module`（引用的宿主模块在目标版本闭包消失）与 `range-break`（声明的 `@deepseek-ai/dsh-*` 范围不覆盖目标版本）；短 inject id / cordis / schemastery 等 infra 依赖仅作指纹上下文供模型参考、不做机器结论；registry 不可达时降级 `local-only`（仅指纹）不阻塞分析。扫描结果随判定持久化并展示在弹窗「本地插件契约扫描」证据区（受影响插件逐条高亮、clean 插件计数、闭包消失模块、扫描告警），prompt 前段嵌入扫描结论并指示模型：受影响插件优先依据机器判定、clean 插件需有明确 diff 证据才可补入、不得仅凭插件名猜测。**不跳版本**：分析时分页拉取 deepseek-harness 全部 `dsh-v*` release，取当前与最新之间的**每一个版本**（升序、含最新），逐版本材料优先用各版本发布说明（缺失时用相邻 tag 的提交标题补充），弹窗按版本号升序列出全部版本并标注破坏性版本（模型漏掉的版本补占位，不会跳过）。**点击幂等**：分析进行中重复点击不并发起第二次分析；已分析且远端版本未变时点击直接复用已有判定（含 L1 扫描结果）。判定持久化在 `~/.dsh/plugin-market-dsh.json`，重启后仍生效，远端版本变化后重置为待分析。

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
| `/plugin-market/check-update` | POST | 检查更新（git：对比远端 HEAD 与本地锁定 commit；开启审查时对新版本与已装代码做差异审查，报告附本次改动描述；审查后保留隔离目录并返回 `updateJobId`） |
| `/plugin-market/install` | POST | 安装阶段 1：建任务 + 隔离拉取 + 安全审查，返回 `{ pending, jobId, review }` 待确认 |
| `/plugin-market/install/confirm` | POST | 确认安装：把阶段 1 的任务迁移进 profile |
| `/plugin-market/install/cancel` | POST | 取消安装：清理隔离目录，不迁移 |
| `/plugin-market/install/interrupt` | POST | 中断安装任务（拉取中/审查中/待安装均可；清理残留后任务即刻消失） |
| `/plugin-market/install/help` | POST | 帮我安装：任一阶段安装失败时开启可见 harness 会话（首条消息＝插件 GitHub 地址 + 不要自行重启），由会话完成安装；返回 `{ sessionId }`（幂等：已交予会话的任务重复点击返回原会话） |
| `/plugin-market/update` | POST | 更新已安装插件（优先用 `updateJobId` 指向的隔离目录直接安装，不重新拉取/审查；审查报告保存为新版本，点击已安装卡片即可查看；进行中有进度提示；无隔离任务时重新拉取安装，`review: false` 跳过差异审查） |
| `/plugin-market/update/help` | POST | 帮我更新：更新失败时开启可见 harness 会话（与「帮我安装」同一份首条消息＝插件 GitHub 地址 + 不要自行重启；地址走三级回退解析，也接受 body 传入的 `repository`），由会话完成更新；返回 `{ sessionId }`（幂等：同一失败标记重复点击返回原会话） |
| `/plugin-market/uninstall` | POST | 卸载插件（先删依赖后删配置，失败可重试；bundle 即时卸载） |
| `/plugin-market/cleanup` | POST | 一键清理缓存（1 小时前的隔离残留与过期审查报告） |
| `/plugin-market/dsh-version` | GET | dsh 自更新状态（已装/远端版本 + 破坏性判定），供侧边栏状态灯 |
| `/plugin-market/dsh-version/check` | POST | 强制重新检测 dsh 更新（git ls-remote 对比 deepseek-harness 最新 `dsh-v*` tag） |
| `/plugin-market/dsh-version/analyze` | POST | 点击状态灯：先跑 L1 本地插件契约扫描（机器判定），再静默直连 LLM（默认模型）逐版本分析新 dsh 版本的更新内容与对已装插件的破坏性更新；`scan` 结果随判定持久化 |

## 配置

无强制配置。GitHub 源列表持久化在 `~/.dsh/plugin-market-sources.json`；
插件仓库来源持久化在 `~/.dsh/plugin-market-repos.json`（安装时自动写入用户填写的仓库，作为插件来源仓库，用于展示与 git 通道检查/更新）；
审查报告缓存与隔离目录在 `~/.dsh/plugin-market-reviews`、`~/.dsh/plugin-market-staging`（7 天/清理按钮管理）。
dsh 自更新检测/判定状态在 `~/.dsh/plugin-market-dsh.json`（已装/远端版本 + 破坏性判定，重启后仍生效）。

## 开发

```bash
node --check lib/index.js lib/client.js   # 语法检查
```

host 端零第三方依赖（只用 node 内置模块）；client 端为 ModuleLoader 手写格式，无需构建。

## License

MIT

## 变更日志

历次改动见 [CHANGELOG.md](./CHANGELOG.md)。
