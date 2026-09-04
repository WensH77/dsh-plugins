# Changelog

本文件记录 `dsh-plugin-market` 的历次改动（由 git 提交历史整理）。安装、使用、端点、配置见 [README.md](./README.md)。

## 0.14.1

- **refactor：重构后候选批（行为不变的继续瘦身）**——
  - routes handler 样板收编：9 个 `try{…}catch{sendError(500,errMsg)}` 同构 handler 改由 `asHandler` 统一包装（去 9 份重复的 500 兜底；`handleUpdate` 因 catch 需先写 failed-update 标记、6 个本无样板的 handler 保持原样）；
  - profile `package.json` 60s TTL 读缓存：`patch.js` 新增 `readProfileManifest`/`invalidateProfileManifest`，`/state`、`/uninstall` 的 manifest 读取走缓存；写路径（bundle 增删、pnpm 安装/移除成功后）即时失效；
  - repository 三级回退链合一：`/state` 逐条内联回退与 `resolveModuleRepository` 抽共享纯函数 `repositoryFallback`（`/state` 零额外读）；
  - 清理阈值/审查过期时间常量化（`CLEANUP_AGE_MS`、`REVIEW_EXPIRE_MS`）；删除零引用的 `localDependencyPath` 薄壳 export；`installPlugin` 的 `review !== true` 保守写法补注释（语义与调用方一致，无取反）。
- **fix：ESM 下 `require('node:fs')` 恒抛 ReferenceError 被 catch 吞**（回溯至 0.14.0 重构前即存在）——`localDependencyInfo` 的 node_modules 符号链接检测与 `resolvePnpm` 的 npx 缓存 pnpm 查找**从未生效**，现改直用 import 的 `lstatSync/realpathSync/readdirSync`，两分支恢复设计意图（本地符号链接安装正确识别为不可卸载/更新；存在 npx 缓存 pnpm 时优先于裸 pnpm）。
- **test：smoke 契约扩展**——新增 `makeQueue` 串行性、`readJsonFile/writeJsonFile` round-trip（缺失/损坏 fallback）、`localDependencyInfo`（link: 依赖与 symlink 双分支）断言（共 51 断言全绿）。

## 0.14.2

- **fix：client 硬编码中文本地化**——`finishInstall`/`doUpdate` 的「git 通道安装完成/更新完成」提示与 `doCheckUpdate` 弹窗标题改为走字典（新增 `installDone`/`updateDone` 双语键，复用既有 `removedRestart`/`updateReviewTitle`），en 界面不再混入中文；
- **注释说明**：`doInstall` 的「已中断」错误字面特判（服务端固定文案，中断提示由 interrupted 消息给出）补注释；`busy` 键 `install:`+repo 与 `install:`+packageName 的漂移经核实为**孤儿键**（doInstall 与 doConfirmInstall 忙窗永不同时重叠、`install:*` 前缀无其它消费者、同插件防重已有任务列表禁用/服务端 gitSpec 相等检查/单弹窗槽位三层兜底）——保留现状，不在 0.14.2 内改动。

## 0.14.0

- **代码重构与瘦身（纯重构，外部行为与契约不变：HTTP 16 路端点、响应字段、`~/.dsh` 状态文件格式、localStorage 键、注入契约）**：
  - **宿主端拆 8 文件**：单文件 `lib/index.js`（约 3682 行）按域拆为 `util`（纯工具/仓库解析/版本比较）、`pnpm`（pnpm 通道与 allowBuilds 恢复、git 子进程）、`patch`（补丁层/manifest/条目与包元）、`install`（来源/pending 持久化与安装/更新任务域）、`review`（L0 扫描/L1-L2 审查通道/审查缓存）、`dsh`（版本检测/L1 契约扫描/升级分析）、`routes`（16 个具名 handler + 分发表）；`lib/index.js` 瘦身为 35 行入口（name/inject/apply）。依赖单向无环，跨域共享状态（任务队列/审查去重/版本缓存/状态文件队列）保持模块级单例不复制；
  - **机械化去重**：统一错误转字符串 `errMsg`、递归清理 `rmrf`、JSON 状态文件读写 `readJsonFile/writeJsonFile`（归并 5 簇同构读写，保留字段清洗与旧格式兼容）、三队列并 `makeQueue` 工厂、exec 环境 `execEnv`、`isLocalDependency/localDependencyPath` 合体为 `localDependencyInfo`（/state 单次 IO）、注释归位；
  - **handle 拆分**：575 行单路由函数拆为 16 个具名 handler + `ROUTES` 分发表（GET 门控语义精确复刻：仅 /state 与 /dsh-version 限 GET，其余不限方法）；
  - **client 保守瘦身**：删 6 个未用字典键与恒等映射 `phaseLabel`；`/state` 轮询从「无条件每秒请求」改为双速（活动期 1s / 空闲 60s，enterBusy/审查生成打点保证操作后立即回 1s——与侧边栏状态灯同策略）；状态灯 5 处裸 fetch 统一走 `call()` 封装；flash 消息定时器卸载清理；`update/help` 双胞胎处理器合并为公共体 + 薄壳；busy 样板收编 `runBusy`（7 处 handler）；severity/verdict 颜色查表；
  - **测试护栏**：新增 `test/smoke.mjs`（纯函数行为契约 + 16 路路由表双端一致性 + client.js 语法检查），`npm test` 全绿；重构全程 4 个提交（P0 护栏 → P1 机械化 → P2+P3 拆域与分发表 → P4 client）。
  - **后续候选（本次明确未做，属行为/本地化修复而非纯重构）**：硬编码中文提示（「git 通道安装完成/更新完成」等）未走字典；`doInstall` 的「已中断」错误特判保留；`busy` 键语义漂移（install 用 repo vs packageName）；client 资源（CSS/字典/状态灯 DOM 区）外置多文件需宿主加载器支持验证后另行评估。

## 0.13.0

- **dsh 升级分析新增 L1 本地插件契约扫描（机器判定，先于 LLM 分析）**：点击状态灯分析前，先做确定性代码级核对，替换原先「把插件名 `name@version` 丢给模型猜」的弱做法——
  - **使用指纹采集**：枚举已安装用户插件，读取本地包内 `dsh.client.inject` 注入名、`lib/*.js` 代码里的 `@deepseek-ai/…` 引用字面量、`dependencies`/`peerDependencies` 声明的宿主依赖范围；
  - **宿主闭包对比**：从 npm registry 按**精确版本号**（dist-tag 不可信，`latest` 停在旧 rc）拉取目标版本 `dsh-web-app` + `dsh-base` 的依赖闭包，与本地运行树闭包对比，找出「已装闭包存在、目标版本消失」的宿主模块；
  - **机器判定 findings**：`removed-module`（引用的宿主模块在目标闭包消失，高置信破坏点）与 `range-break`（声明的 `@deepseek-ai/dsh-*` 范围不再覆盖目标版本，宿主同版本发布直接越界）两类高置信结论；短 inject id / cordis / schemastery 等 infra 依赖只作为使用指纹上下文给模型参考、不做机器结论；registry 不可达时降级 `local-only`（仅指纹）不阻塞分析；
  - **结果入库展示**：扫描结果随判定持久化到 `~/.dsh/plugin-market-dsh.json`（目标版本未变时复用），判定弹窗新增「本地插件契约扫描（机器判定）」证据区（受影响插件逐条高亮、clean 插件计数、闭包消失模块、扫描告警）；
  - **prompt 引导**：升级分析 prompt 前段嵌入扫描结论，并指示 affectedPlugins 优先依据机器判定、clean 插件需有明确 diff 证据才可补入、不得仅凭插件名猜测。

## 0.12.5

- **「清理缓存」与「审查模型/推理程度」合并到同一行**：审查开启时，模型/推理程度两个下拉与清理缓存按钮并排显示（清理按钮右对齐，窄屏自动换行）；审查关闭时清理按钮仍单独一行，行为不变

## 0.12.4

- **`cordis` peer 从 `^4.0.1-rc.1` 改为 `^4.0.2`**：跟随 dsh 0.1.2-alpha 通道（alpha 全家桶统一声明 `cordis ^4.0.2`），与仓库其它插件对齐。
- **`DSH_BEST_FIT_VERSION` 从 `0.1.0-rc.7` 更新为 `0.1.2-alpha.4`**：插件市场状态灯/安装卡片展示的「基于 dsh {bestFit} 版本开发」提示同步到当前 alpha 基线。

## 0.12.3

- **「帮我安装」与「帮我更新」统一走同一份极简 prompt**：两条通道原先各有一段长提示词（角色设定、包名、失败信息、profile 目录、pnpm 修复清单、安全约束）。现在合并为 `buildHelpPrompt()`，正文只有一句 —— `帮我安装、更新插件：<GitHub 地址>，不要自行重启`。诊断与安装/更新的具体做法交给会话自行决定；`不要自行重启` 是硬要求，重启 dsh web 会把会话所在的进程一并杀掉。
- **地址规整**：新增 `helpRepoUrl()`，把 `owner/name`、`github:owner/name#path:sub`、完整 URL（含 `.git` 后缀）统一规整成 `https://github.com/owner/name[#path:子目录]`。
- **「帮我更新」补上仓库地址的三级回退**：此前 `/update/help` 只读包内 `repository` 字段，CLI 安装的插件（含插件市场自身）拿不到地址。新增 `resolveModuleRepository()`，与已安装列表用同一条链：*市场安装记录 > 包内 repository > profile 依赖里的 `github:` spec*；客户端也一并把已解析的 `repository` 传过来。
- **拉取 / 审查阶段失败现在也能点「帮我安装」**：此前按钮只认 `status === 'failed'`（即「审查通过、点了确认安装之后」的失败），而拉取失败走的是 `status = 'pending'` + `error`，于是最常见的一类失败反而没有出口。现在任何失败态都提供按钮（待安装但未失败的任务不受影响，仍不显示）。
- **自身补上 `repository` 字段**（`WensH77/dsh-plugins#path:plugin-market`），不再只靠「profile 依赖 spec」这一级兜底。

## 0.12.2

- **修复「声明了 `@deepseek-ai/dsh-*` peer 的插件一律装不上」**：隔离暂存目录（`~/.dsh/plugin-market-staging/job-*`）此前只写 `package.json`，没有 `pnpm-workspace.yaml`，pnpm 于是退回默认 `auto-install-peers=true`，去 registry 解析插件 peer 的整条传递闭包；而 `@deepseek-ai/dsh-*` 全系只发预发布版（`dsh-invariants` 的 `latest` 还停在 `0.0.1-rc.1`，实际在用的是 `next: 0.1.1-rc.2` / `alpha: 0.1.2-alpha.3`），归并出的 `^0.1.1` 之类范围匹配不到任何版本，**拉取阶段直接 `ERR_PNPM_NO_MATCHING_VERSION` 失败**（安装/检查更新/更新三条通道全中，因为都走 `stagePackage`）。现在暂存目录会写入与 dsh `initProfile` 完全一致的 `pnpm-workspace.yaml`（`nodeLinker: hoisted` + `autoInstallPeers: false`），拉取只留一条 peer 警告，插件能否运行仍由宿主的 `profiles/node_modules` 回退链决定，与此处解析无关

## 0.12.1

- **旧判定不再复用，点击即重新分析**：升级到 0.12.0 前持久化的 dsh 判定（旧格式、无 `versions` 逐版本明细、可能是英文聚合报告）不再被点击复用——点击状态灯会**强制重新分析**，直接产出中文逐版本报告；新格式（versions 非空）仍按幂等复用，版本明细为空时 10 分钟窗口内复用防限流重试
- **可能受影响的插件显式列出**：判定弹窗「可能受影响的插件」区在分析无命中时也明确显示「未发现可能受影响的插件」，不再整段隐藏

## 0.12.0

- **审查报告 / dsh 更新报告一律中文**：所有 LLM 审查 prompt（安装 L1 信号审查、无信号确认、L2 聚合终审、更新差异审查）与 dsh 升级分析 prompt 的输出约束新增「所有文本一律使用简体中文」（字段名与枚举值 severity/verdict 保持英文），审查报告与 dsh 更新报告弹窗内容不再混入英文
- **dsh 更新报告逐版本覆盖、不跳版本**：点击状态灯分析时，分页拉取 deepseek-harness 全部 `dsh-v*` release，取「当前版本 → 最新版本」之间的**每一个版本**（升序、含最新）；逐版本材料优先使用各 release 的发布说明，发布说明缺失时用相邻 tag 的 GitHub compare 提交标题补充（compare 调用设上限防限流）；prompt 要求模型**逐版本**输出 `versions`（每个元素含该版本变更要点与是否破坏性变更），解析后按已知版本清单归一化——模型漏掉的版本补占位，保证弹窗列出全部版本、不跳版本
- **弹窗展示版本变更明细**：dsh 判定弹窗新增「版本变更明细」区（当前 → 最新，共 N 个版本），逐版本列出变更要点并标注破坏性版本；`versions` 随判定持久化到 `~/.dsh/plugin-market-dsh.json`，远端版本未变时复用

## 0.11.0

（0.5.0 ~ 0.10.4 全部功能与修复的一次性发布汇总）

- **帮我安装 / 帮我更新**：安装/更新失败的任务卡片保留并提供按钮，开启可见 harness 会话诊断并完成；会话 id 持久化、按钮幂等
- **实时进度**：检查更新 / 审查按服务端阶段记录（git 对比 → 拉取百分比 → L0 扫描 → LLM 审查 → 聚合终审），客户端 1s 轮询在卡片与弹窗内展示阶段文案（5 分钟过期兜底）；忙状态按操作键记录，不同插件操作互不阻塞、支持并发
- **dsh 版本状态灯**：按 GitHub Releases 取最新发布版本（release 语义，限流/失败回退 `git ls-remote --tags`），完整 semver 预发布比较（alpha.N / rc.N）；点击静默直连 LLM 分析（不建会话），完成后再点击弹出判定弹窗（结论/摘要/变更要点/可能受影响的插件/详情）；分析幂等、判定持久化
- **审查报告**：点击已安装卡片展示报告（复用 pm-modal）；生成中进度显示在卡片 meta 区；新版本审查报告缓存复用（跳过 l0-only/none 兜底缓存）；审查失败兜底输出 L0 静态扫描结果并标注「未经模型语义判断」；审查通道简化为纯 LLM 直连（120s 超时）
- **审查模型/推理程度选择**：Flash/Pro × High/Low/Off（默认 Pro Max，localStorage 持久化），安装/检查更新/更新/点击卡片四条链路一致生效；`reviewLlmRoute` 支持请求级 override
- **待重启与失败标记**：更新成功落盘「待重启」持久化标记，已安装卡片直接显示「待重启」标签（待重启区只留无卡片的 bundle/insert）；更新失败持久化错误标记与修复指引（含 pnpm lockfile 手动修复命令）
- **来源与可更新性**：手动拷贝安装（无 git 依赖但仓库可解析）的插件可经 git 通道转依赖并更新；`repository` 字段支持 `owner/name#path:子目录`；来源展示回退链完善
- **安全与稳定性修复**：审查缓存键路径穿越（包名/版本校验 + sha1 兜底键）；状态文件读改写队列串行化（并发更新/卸载/重启不交错）；审查/分析 prompt 防注入约束；检查更新 fetch 失败显示网络错误而非静默「已是最新」；点击报告不重复拉取、dsh 版本通知不重复审查；`compareVersions` 完整 semver 比较修复 alpha 预发布误判；空 `[]` patch 层修复；allowBuilds 恢复与 pnpm 进度流

## 0.4.6

- 修复「更新后不显示待重启」：更新成功落盘后写持久化标记（`~/.dsh/plugin-market-pending.json`），`/state` 把「已更新但仍在运行树（内存仍是旧代码）」的插件并入「待重启」区，提示「更新已下载：重启 dsh web 后加载新版本」，并显示新版本号；dsh web 重启时自动清空标记，卸载时清除对应标记
- 更新成功提示消费服务端 `restart` 标记：客户端更新完成提示改为「更新完成（需重启 dsh web）」（此前安装流程消费、更新流程漏掉该标记，导致更新后无任何重启提示）
- 更新失败写入持久化错误标记：已安装卡片持续显示「更新失败（可能处于不一致状态，重启前不会生效）」与修复指引（含 pnpm lockfile / 布局手动修复命令），直到重试成功 / 卸载 / 重启——不再只靠 20 秒瞬态红条提示

## 0.4.5

- 修复「手动拷贝安装的插件（无 git 依赖）无法更新」：检查更新对**未从 git 安装但仓库可解析且可达**的插件（如按旧文档 `cp -R` 安装的 model-arena）视为可更新——卡片显示转换提示 +「更新」按钮，点击后经 git 通道 `pnpm add` 一次转为 git 依赖并安装远端最新版（后续即可正常检查/更新）；本地 link/file 安装仍不可转换
- 来源回退链新增兜底：插件包 `package.json` 的 `repository` 字段支持 `owner/name#path:子目录` 形式（model-arena 已补该字段），手动拷贝安装也能定位来源仓库

## 0.4.4

- 修复「检查更新后无法更新」：安全审查关闭时，检查更新仅提示「有更新」却没有更新入口——已安装卡片检测到更新时直接显示「更新」按钮（审查开启且有隔离任务时仍走审查报告弹窗确认；审查关闭时直接 git 通道更新，不重新审查）
- `/update` 支持 `review: false`：无隔离任务路径跳过差异审查直接安装（与安装链路审查开关一致）；审查开启时该路径生成的报告同样保存为该插件新版本
- 更新成功后清除该插件的「有更新」残留提示；本地 link/file 安装插件的禁用「检查更新」按钮增加说明（源码目录 git pull + 重启）

## 0.4.3

- 新增「帮我安装」：安装失败（migrate 阶段）时保留失败任务卡片并加「帮我安装」按钮，点击后打开可见 harness 会话（attach 当前 workspace），首条消息预填安装请求 + 失败原因 + profile 目录，让会话诊断并完成安装；任务标记「已交给会话」、按钮幂等
- 失败任务保留在任务列表（此前直接删除），向客户端暴露 `error` 与 `helpSessionId`

## 0.4.2

- 来源展示回退：无已存 repo 覆盖时，先回退到包自身 `repository` 字段、再回退到 `github:` 依赖说明，CLI 安装的 git 插件也能显示仓库并检查更新

## 0.4.1

- 修复空 `[]` patch 层：剥离 `[]` 空 patch 标记后再追加 insert/disable 块，避免挂到 dsh 默认 `cordis.patch.yml`（注释 + `[]`）时产生非法 YAML
- insert 层已写入 patch 但未进运行树的插件显示在「待重启」区；安装后探测 HMR，未热更则上报 `restart:true`

## 0.4.0

- 更新改为隔离环境直接安装 + 差异审查（`updateJobId` 直接安装）
- 侧边栏 dsh 版本状态灯：检测 deepseek-harness 最新 `dsh-v*` tag，点击开新会话分析破坏性更新，判定持久化到 `plugin-market-dsh.json`
- 新增 `/dsh-version`、`/dsh-version/check`、`/dsh-version/analyze` 端点

## 0.2.1

- allowBuilds 恢复：自动写 pnpm `allowBuilds`（git prepare / 被忽略的构建）并重试
- stream pnpm Progress 到安装/拉取进度条
- 保留已装插件的审查报告（protected）+ `/review` 端点；repo override 去重

## 0.2.0

- 两阶段安装：隔离拉取 + 分层安全审查 + 确认安装，任务可视化（状态/阶段/耗时，1s 轮询，可中断）
- 安全审查走 harness 会话（`agents.create` + followup + 日志轮询提取 JSON），LLM 直连兜底；审查开关关闭需连点 5 次、1 秒保护
- 更新附带与本地已装代码的逐文件差异审查（method: `update-diff`）
- 卸载先删依赖后删配置（失败可重试）；bundle 卸载写临时禁用行立即卸载
- 安装时保存用户填写的仓库地址（manual 标记区分手动修改）；待重启卡片与仓库地址展示优化

## 0.1.0

- 插件市场 tab：来源管理（npm/git/auto）、安装/更新/卸载/开关、分层 L0+L1 安全审查、待重启分区
