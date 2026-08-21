# dsh-plugin-model-arena（模型竞技场）

dsh web 模型竞技场插件（挑战模式）：**按场景分流——「知识沉淀」场景走 review 循环（主模型产出结构化方案，挑战者作为审查者给出 `Overall Verdict` READY / NEEDS_REVISION；不认可则修正后终审，循环直到认可或累计 3 次不认可，随后审查循环结束）；「业务探索」「测试用例」场景保持原有挑战流程（模型1 回答 → 模型2 质疑 → 模型1 修正 → 模型2 终评）**。模型2 的输出以用户消息注入主会话原生对话流（竞技场 tab 保持现状，仅作模型2 后台输出）。

- **仅空会话（hero）配置**：空会话时，在「文件夹 + agent 模式」选择旁出现「竞技场」toggle（默认关闭）；开启后出现与输入框同源的两级菜单，选择竞技场模型 + 推理等级（输入框当前模型被排除）；**目录仅两个模型时自动选择另一个**（无需手动选择），并在 composer 切换模型时联动切换（竞技场会话创建后模型冻结）
- **未配置时发送被阻止**：竞技场开启但未选模型时，composer 被平台「会话阻塞」机制禁用（占位符提示先选模型），避免静默退出竞技场变成普通会话；两模型自动模式下目录一解析即就绪、不会被阻塞
- **真实竞技场（v3，tab 形态）**：配置好后发送首条消息 → 创建第二会话（竞技场模型，**与当前会话同一 workspace**，权限跟随当前会话的权限预设）；会话 header 出现原生 **【对话 | 竞技场】** tab（注册 `conversation.view` 槽位，跟随联动状态动态注册/注销），「竞技场」tab 内渲染竞技场模型对话（提示词 + 推理 + 回复 + 工具调用/工具结果/图片，随流式更新）；两个 agent 并行回复；后续每条消息自动镜像到竞技场会话
- 竞技场会话**不出现在侧边栏**（竞争者隐身：`.YDXeBa_title` 精确匹配「竞技场」/「Arena」的列表行 `display:none`，且切换守卫会把任何切入竞技场会话的选择弹回其联动主会话，防止与模型2私聊扰乱上下文）；「竞技场」tab 是竞技场会话的唯一界面；切换会话/关闭竞技场时 tab 与联动一并还原；**归档主会话时联动归档竞技场会话**（订阅 workspaces 列表快照的 archivedSessionIds，检测到主会话新归档即调用 archiveSession 归档其联动会话）

## 决策记录

- **入口从命令菜单改为 hero**：按用户指示，竞技场不是高频入口；改为空会话时与文件夹/agent 模式并列的 toggle
- **真实竞技场实现（v3）**：客户端 sessions.create 创建竞技场会话 + connection.api.sessions.selectModel 设模型 + binding(id).session.prompt 镜像提示词；会话快照 chat.order/nodes（节点字段 anchorSeq / data.content / data.blocks）驱动 tab 渲染；**必须先 binding(id).session.open()**——cold 会话的 live 事件会被丢弃，chat 无法组装
- **分屏为 DOM 手术**：把 [data-slot="conversation.session"] 移入 .ma-split > .ma-splitLeft，右栏挂竞技场面板；暂停外层 [data-conversation-scroll] 滚动（聊天视图恢复自身滚动）；切换会话/关闭竞技场时还原
- **竞技场模型 ≠ 输入框模型**：hero 选择时排除输入框当前模型；创建竞技场会话前还会用实时目录复核（hero 选择若发生在目录加载前可能误选）
- **渲染签名守卫**：repaint 仅在可见状态变化时触碰 DOM，避免注入的 MutationObserver 触发重绘死循环（闪烁）
- **同 workspace（撤销隔离）**：用户反馈竞技场会话出现在「未分组」而非当前工作区——定位为 workspace 查找 bug（workspaces.list.getSnapshot().items），修复后竞技场会话与当前会话同一 workspace（共享项目 cwd，竞技场 agent 可对项目执行工具；如需只读后续可加平台级工具限制）
- **权限跟随当前会话（command 通道）**：创建竞技场会话后通过 `session.command("/permission <预设>")` 应用当前会话预设（workspace-write / danger-full-access / custom），与原生 composer 权限选择器同一通道——命令处理器直接切换 sandbox/approval 旋钮并记录 `command` 节点，**不调度模型回合**：权限授予不进竞技场上下文，竞技场模型也不会回复它；预设从会话投影 permission/preset 读取。tab 渲染同时过滤权限授予节点及其整轮回复（兼容早期 prompt 通道的历史授予）
- **分屏改原生 tab（v5 MVP）**：按用户重头设计诉求，把 DOM 手术分屏替换为平台原生 `conversation.view` 视图环 tab（与 ui-trajectory 同机制）：hero 开启竞技场即注册「竞技场」tab，关闭/切走即注销（视图环 ledger 全局，dispose 即隐藏）；tab 内容由 ArenaView 组件承载，挂载时把现有渲染器绑定到 tab 容器并订阅竞技场会话快照；移除 ma-split DOM 手术与用户气泡层。**原生渲染不可绑定第二个会话**（视图环 scope 硬绑当前会话、`conversation.chat.node` 子槽位声明独占），tab 内容保持自定义渲染器（逐字节复刻原生）
- **角色注入走 system prompt（v6）**：按用户要求「首问前注入、界面干净」，两个角色的身份经 **system-prompt/assemble waterfall** 注入到会话的 system prompt（node 半段监听组装事件，按 sessionId 匹配 persona 映射改写 deployment:persona 段）——对话流**零额外消息**、hero 保持、模型1 从第一回合就带角色。客户端把映射同步到 settings（persona 字段），node 半段 watch 实时刷新；仅竞技场启用的会话被注入（主会话 = Knowledge Expert/QA Expert，竞技场会话 = Challenger/用户），其他会话不受影响。**node 半段 settings schema 变化需重启 dsh web 生效**
- **挑战模式（v5）**：按用户需求，竞技场从「自由镜像对决」改为「一次提问 + 固定 4 步流程」——用户首问后输入框锁定，编排器按 1→2→1→2 推进：模型1 回答（原生）→ 模型2 质疑（提取后以 user 消息注入主会话，显示为用户气泡）→ 模型1 修正（原生）→ 模型2 终评（同样注入主会话）→ 结束解锁。**角色/场景系统**：knowledge（Knowledge Expert vs Challenger）、qa（QA Expert vs 用户），角色走 system prompt 注入（v6），后续回合只带「模型回复 + 提到文件引用 + 工具操作记录」上下文（工具记录仅取 assistant 节点内的 tool-call 块：名称 + 参数摘要，不做 tool-result 关联，无工具调用时整段省略）；禁止辩论规则在双方角色文案（system prompt persona）与每轮回合 prompt 的阶段指令中落实：质疑轮明确「只输出你的质疑（不要自我称呼角色名）」，终评轮明确「仅给出最终评审结论，不要提出新的质疑」——防止挑战者首轮就一次性输出质疑+终评（否则主模型修正后的回答将得不到终评，流程会在终评轮空转中止）。**竞技场 tab 零改动**，挑战过程全部在主会话原生对话页渲染；回合完成用锚点法检测（order 最后 key 变化 + running=false），promptSession 为统一注入通道
- **联动持久化（v4）**：链接写入 node 半段 settings 命名空间（ns model-arena，schema 兼容旧 enabled 字段），重载后 restore 自动重建联动；依赖 dsh web 重启加载新 node 半段
- **错误重试（tab 内）**：竞技场会话创建失败时「竞技场」tab 内出现错误条（含原因 + 重试按钮），不再静默失败
- **右栏渲染对齐**：工具调用与左侧同款（名称 + 参数）、工具结果折叠行、图片消息经 readAttachment 转 Blob URL 完整展示；助手文本经平台原生 MarkdownText 渲染（与对话 tab 逐字节一致）；tab 内 paneBody 自滚动（overflow-y:auto）
- **review 循环（仅知识沉淀场景）**：挑战者仅在审查环节接入、替代主模型执行审查——主模型先产出结构化方案，挑战者输出 `**Overall Verdict**: READY / NEEDS_REVISION`；不认可则主模型修正后终审，循环直到认可或累计 3 次不认可（`MAX_REJECTS = 3`），随后审查循环结束、解锁输入框（后续环节由宿主流程接管，本插件不改动）。
- **场景分流（新增业务探索）**：新增「业务探索」场景，与「测试用例」一起保持**原有挑战流程**（模型1 回答 → 模型2 质疑 → 模型1 修正 → 模型2 终评），只有「知识沉淀」场景启用 review 循环——通过 `SCENES.<scene>.review` 标志 + `isReviewScene()` 在编排器/角色种子/round prompt 各层分流，原有逻辑保持不变。
- **会话切换韧性（v7）**：修复「挑战者回合中切走会话 → 结论丢失/流程卡死」——三个改动：(1) **轮询兜底**：sync 每 tick 对当前运行时调用一次 `detectChallengeTurn()`，直接读快照推进，不再只依赖会话订阅事件（归档的竞技场会话可能丢 live 事件）；(2) **注入节点锚点**：注入后重锚（pendingAnchor）改为定位 `lastInjectedText` 对应的 user 节点（`injectedNodeKey`）而非「最新节点」，且重锚后**不提前返回**——切走期间主模型已完成修正时，在同一次 catch-up 里直接推进到终评轮，避免永久卡在 revise；(3) 竞技场会话为空时开始挑战（与生产一致），测试复位渲染夹具。效果：切走期间挑战者完成 → 回到该会话即自动补发结论并继续推进；15 分钟长回合可放心切走，每次返回都会 catch-up 一步。
- **主模型提问不中断流程（v8）**：主模型在回答/修正途中向用户提问（ask_user_question 多选等），回答后**不得**因「回合从 running 变 idle 且无新节点」的中止启发式而误判为停止——中止守卫新增 `hasPendingInteraction(snap)`（快照存在 question/approval 待办时不算「停止无输出」），否则选择完答案即退出竞技场、挑战者永不质疑。同时把质疑/审查 prompt 升级为**逐条质疑**（逐点审查每个观点/结论/依据），满足按 review 语义逐条质疑的要求。
- **两模型自动联动（v10）**：目录仅两个模型时，竞技场开启即自动选择输入框当前模型的**补集**（`autoArenaModel`：总模型数恰为 2 时派生 complement，带该模型默认推理等级），无需手动选择；composer 切换模型时竞技场模型联动切换（repaintPanel 按目录 `current` 派生，渲染签名含 current 自动触发）；同一模型的推理等级手动调整跨 repaint 保留，切到另一补集模型时回落其默认。**会话创建后冻结**：`arenaLocked`（arenaSessionId 已存在）时不再派生、冲突清理也不触发，中途切模型不会重接已运行的挑战者会话；`startChallenge` 创建前兜底补派生一次。纯函数独立导出（autoArenaModel / totalModelsOf），hero 流程有集成断言（自动选中、composer 不被阻塞、切换跟随）。
- **契约适配层（v9，重构）**：把所有 dsh 耦合点收敛到单一位置，升级时只改一处——(1) **快照契约**：新增 `orderOf / nodeOf / runningOf / pendingOf / isUserNode / isAssistantNode / contentOf / blocksOf / anchorSeqOf / commandNameOf / isWait / sessionSummaryOf` 等纯函数，编排与渲染对 `chat.order/nodes/kind/anchorSeq/data.content/data.blocks/running/pending` 的读取全部改走契约层；(2) **DOM 锚点常量表 `ANCHORS`**：hero 行、侧栏行、header 类、折叠分隔符等原生选择器/类名集中在文件顶部一处（含 CSS 字符串插值与 JSX 引用），dsh web 升级后 grep `ANCHORS` / `contract` 即定位全部触点；deep-render 字段（context 来源、turn-tail 统计、签名哈希）保持原样不强行收敛。测试新增「挑战 prompt 携带主模型回答文本」断言，防止提取类逻辑静默退化。
- **设置页竞技场分区（v11）**：注册 `settings.section` 顶级导航分区（id = `model-arena`，order 20，label「模型竞技场」），在 设置 左侧导航新增「模型竞技场」入口——比 `settings.plugin.item` 插件卡片更可靠（由设置页核心 settings-general 声明，不依赖「插件」分区是否存在），展示三类场景的描述（角色对、流程类型、说明）与插件**实际注入的全部提示词**（角色种子 + 各轮质疑/审查/终评 prompt）——提示词由真实 builders（`buildRoleSeed / buildMainRoleSeed / buildRoundPrompt`）以样例值实时生成，文档永不与注入文本漂移；页脚附注入边界说明（不含主模型思维链；工具操作记录仅含工具名与参数摘要，不含工具结果）。
- **挑战者技能（v12）**：hero 面板场景选择后新增「挑战者技能」选择器（可为空）——系统文件夹选择器（`workspaces.pickDirectory`）选文件夹，或手动输入文件/文件夹路径；选中后 `buildRoleSeed` 追加「挑战者技能：{path}。审查/质疑前先读取该技能（目录读取其中的 SKILL.md，文件直接读取）…」，经 persona 映射注入挑战者 system prompt，每轮生效。**按工作区持久化**：settings 命名空间新增 `workspaceSkills`（workspace path → skill path，node 半段 schema 变更需重启 dsh web 生效）；同一工作区新会话默认沿用该工作区上次的 skill，新工作区取该工作区历史 skill 或空，当前会话可显式改选/清除并更新工作区默认。
- **结束会话不再显示 header（v13）**：修复「进入已结束的竞技场会话，挑战进度 header 默认展示」——三处改动：(1) **运行时同步脱离 hero 分支**：`syncArena/syncViewEntry/syncPersona/轮询兜底` 原先只在 hero 行存在时执行，真实应用中有消息的会话没有 hero 行，导致切走不 teardown、进入不 restore（含重载后的联动恢复）、轮询兜底不跑——归档的竞技场会话丢 live 事件时回合会滞留在非终止阶段（active=true），header 与输入框锁随之常驻；现改为每次 sync 对当前会话一律执行，生命周期与「当前会话」绑定（与 v7 的「切走 teardown + 返回 catch-up」设计一致，重载联动恢复对 message 会话也生效）；(2) **header 阶段白名单**：新增纯函数 `shouldShowChallengeHeader`（导出供测试），仅 `answer/challenge/revise/final/propose/review` 且 active=true 视为进行中——idle/done/aborted 等终止态永不渲染 header 与输入框锁（`updateBlock` 同步收口到同一谓词）；(3) **停滞看门狗**：等待中的会话（主模型或挑战者）若长时间（`STALL_MS` = 120s）持续 idle 且零进展（无 running、无新输出、无待办交互——如提示词静默失败）即中止挑战，避免「流程早已结束但 header 卡死」，重新进入时首次轮询即收尾。**（v13 补充）点进竞争者会话不显示 header**：`ChallengeStatus` 对竞争者（竞技场）会话一律返回 null（`isArenaSessionId` 判定，与 sessionId 匹配检查双保险）；并修复「点击竞争者会话无法弹回主会话」——选择守卫原先用 `ctx.get("sessions")` 解析会话服务，但 `ctx.get` 只解析运行时服务，sessions 是注入面 `ctx.sessions`（其 `open(id)` 即「Select a session as current」），现增加 `ctx.sessions.open` 兜底，点进竞争者会话可靠弹回主会话、已结束/中断的挑战不展示 header。

## 架构

| 文件 | 角色 |
|---|---|
| lib/index.js | Node 端：settings 注册（links 持久化 + persona 映射），`system-prompt/assemble` 注入挑战角色（仅 persona 映射中的会话） |
| lib/client.js | 浏览器端：hero toggle + 两级菜单选择 + 两模型自动联动（autoArenaModel）+ 竞技场运行时（镜像、`conversation.view`「竞技场」tab 注册、tab 内渲染）+ review 循环编排；纯函数（buildModelOptions、buildEffortChoices、conflictsWithInput、findArenaModel、autoArenaModel、totalModelsOf、textOfContent、assistantRows、buildRoundPrompt、parseReviewVerdict、formatToolTrail、toolArgsSummary、buildRoleSeed、stripMarkdown）独立导出供测试 |

数据流：

    hero 配置（toggle + 选场景/模型）
      --> 用户首问 --> 创建竞技场会话（同 workspace，不镜像首问）--> 输入框锁定
      --> 场景分流：知识沉淀走 review 循环；业务探索/测试用例走原有挑战流程
      --> [review] 主模型产出结构化方案 --> 挑战者审查（Overall Verdict READY/NEEDS_REVISION）
             不认可 → 审查意见注入主会话 → 主模型修正 → 终审，循环直到 READY 或 3 次不认可
      --> [challenge] 模型1 回答 --> 模型2 质疑（注入）--> 模型1 修正 --> 模型2 终评（注入）
      --> 结束解锁（后续环节由宿主流程接管，本插件不改动）

## 安装（dsh web profile）

    mkdir -p ~/.dsh/profiles/web/node_modules/dsh-plugin-model-arena
    cp -R model-arena/. ~/.dsh/profiles/web/node_modules/dsh-plugin-model-arena/

    # ~/.dsh/profiles/web/cordis.patch.yml（顶层数组）：
    - insert:
        - id: model-arena
          name: dsh-plugin-model-arena

    # 重启 dsh web

## 使用

1. 新建/打开一个空会话（hero 视图）
2. 在文件夹、agent 模式选择旁点击「竞技场」toggle（默认关闭）
3. 开启后面板出现场景选择（默认「业务探索」，另有「知识沉淀 / 测试用例」）+**「挑战者技能」**（可选，点开后可用系统文件夹选择器选文件夹，或手动输入文件/文件夹路径；可为空）+「竞技场模型」两级菜单（输入框当前模型不在列表中）；**目录仅两个模型时自动选中另一个**，且在 composer 切换模型时联动切换（竞技场会话创建后冻结）
4. 发送首条消息（你的问题）→ 输入框锁定，按场景分流：
   - **知识沉淀**：主模型产出结构化方案 → 挑战者作为审查者输出 `**Overall Verdict**: READY`（认可）或 `NEEDS_REVISION`（不认可）+ Action Items；不认可 → 审查意见以**用户消息**注入主对话 → 主模型修正 → 挑战者终审，循环直到认可或累计 3 次不认可，随后审查循环结束、解锁输入框（后续环节由宿主流程接管，本插件不改动）
   - **业务探索 / 测试用例**（原有逻辑）：模型1 回答 → 模型2 质疑（用户消息注入）→ 模型1 修正 → 模型2 终评（用户消息收尾）
5. 流程结束解锁输入框，可提新一轮问题

## 测试

    npm test   # = node test/smoke.mjs && node test/client-smoke.mjs

覆盖：hero 开关/菜单/阻塞；两模型自动联动（纯函数 + hero 集成：自动选补集、不阻塞、切换跟随）；竞技场运行时（会话创建、模型选择、open 窗口、提示词镜像、view-ring tab 注册、tab 渲染、问题/审批交互、重入不重发历史、关闭还原）；权限预设应用；链接持久化（保存/恢复/卸载）；场景分流（business/knowledge/qa 的 review 标志）；review 循环编排（propose→review→revise 推进、Overall Verdict 解析、不认可计数与 3 次上限、锚点检测、停止/中止）；原有挑战流程（业务探索场景 answer→challenge→revise→final）；纯函数（排除规则、模型挂钩等级、文本/块提取、工具/图片行、工具操作记录格式化、审查 prompt 与 challenge/final prompt 判定解析）。

## 已知限制

- **联动持久化需服务重启**：node 半段 settings 注册加载后，链接才会写入/恢复；重启前链接仅存内存
- **tab 渲染与原生同款（无气泡）**：完整复刻左侧聊天渲染，**按原生语义分组**（user 气泡+时间戳一组、context 独立块、assistant 的 think+工具+正文一组、turn-tail 独立行；块间 gap 16px、块内对齐原生 userStack 8px / asstBlock 16px）——**context 节点**（原生「上下文注入」折叠行：IconBrowseOutline16 图标 + 标题 + **来源 label**（contextSourceLabel：plugin id / skill 名，与原生 contextProvenance 一致）+ 折叠摘要，点击整行/文字展开显示注入内容）、**Think 折叠行**（原生 IconThinkOutline16 图标 + "Think" 标题 + **原生 QWLzlG_separator 分隔符 + 折叠摘要露出**，点击整行展开 thinkBody）、**工具调用折叠行**（原生 IconCodeOutline16 图标 + **原生工具显示名**（TOOL_VARIANTS 映射：run_code→Code 等）+ **分隔符 + 摘要**，点击整行展开**code 值代码块**（原生 deriveBody：code variant 显示 argsRaw.code 实际代码，其他 variant 显示格式化 JSON））、**turn-tail 统计行**（HH:MM · 用时 · 首 token · tok/s）、markdown 正文经平台原生 MarkdownText 渲染；所有折叠行均 `expandOnRowClick`（点击文字即可展开），展开状态跨流式 repaint 保持；**复制按钮与原生一致**：仅 user 消息 + 回合末尾（turn-tail 对应位置）各一个（不在工具步骤/assistant 块内），原生 IconCopyOutline16→IconCheckOutline16 切换 + Tooltip hover 文案；**turn 复制仅含正文 text（不含 thinking/reasoning）**；对话 tab 保持原生时间戳行为（hover 显示）；权限 command 节点隐藏；镜像经 prompt 携带文本（图片附件仅左侧展示）
- **锚点依赖 bundle 结构**：hero 行类锚点为当前 bundle 结构，平台升级可能需调整
- **竞技场模型 ≠ 输入框模型**：hero 选择排除输入框当前模型；若选择发生在目录加载前，创建时会复核并跳过（提示冲突）；**仅两个模型时自动选补集并随输入框切换联动**（`autoArenaModel`），竞技场会话创建后模型冻结（`arenaLocked`），此后 composer 切换不再改竞技场模型
- **镜像略有滞后**：竞技场在消息落地后启动（数百 ms）；两 agent 并行但非严格同时
- **错误重试**：竞技场会话创建/镜像失败时，tab 内显示错误条 + 重试按钮；重试成功自动恢复联动与渲染
