# 变更日志（arena-v2）

> 0.21.0 之前的历史改动未整理成 changelog（本目录当时尚未随版本记录）；此前版本可参考 git 提交与 README。

## 0.33.0（feat：历史会话检索指引独立成段（只给主代理）+ fix：knowledge 检索指引对齐工作区 theseus 技能）

- **新增 `sessionHistoryGuide`（历史会话检索指引）**：从 `DEFAULT_SEARCH_GUIDE`（business 第 5 项）拆出为独立常量 `DEFAULT_SESSION_HISTORY_GUIDE`，**全场景共用**（business / knowledge / qa 都注入），随竞技指令段落渲染在「场景检索指引」之后、「阶段指示」之前。
  - **只注入主代理**：该段落对子代理会话本就返回空（origin/depth 门控），挑战者/探索者是独立会话（父代理历史不进入），回捞历史会话既无意义又会污染对抗——子代理只该基于收到的回合材料与工作区文件判断。
  - **能力式条件**：正文以「若你具备检索本地 dsh 历史会话的能力（例如技能列表中有 session-search，或其它等价的会话检索技能/工具）」开头——没有该能力的部署整段自然失效，宿主不探测技能目录。
  - 内容含触发场景（用户提到**当前会话之外**的过往内容 / 复用本会话没有出处的结论 / 质疑里出现「这个之前定过」类争议）、用法（短查询定位候选 → 拉完整上下文 → 再作答；引用注明 session id 与日期）、边界（字面子串匹配、**搜不到不等于没发生过**、当前会话内的内容直接回看上文）。`''` = 不注入。
- **修复 knowledge 检索指引与工作区 theseus 技能的四处冲突**（对照 intranet-aio 的 `AGENTS.md`、`theseus-retrieve-specs` / `theseus-explore` / `theseus-apply-change` 的 SKILL.md）：
  - **状态词汇不存在** → 原文「needs-review / stale 规格须先对代码验证」，但 `openspec/specs` 的 frontmatter 只有 `status: active`(36) / `status: draft`(6)，skill 的 Trust Handling 也只定义这两个；改为 **active 可直接采信 / draft 须先对当前代码·工件验证**。
  - **spec-meta 调用路径** → `node scripts/spec-meta.ts`（相对路径，cwd 不在 repo root 即失败）改为 skill 同款 `node "$(git rev-parse --show-toplevel)/scripts/spec-meta.ts" search --term "<term>"`，并补上 helper 不可用时「回退直接文件搜索并在 trace/摘要声明回退」。
  - **worktree 边界误导** → 主控者唯一真写代码的阶段是 T6 apply，原文只说「探索/审查优先读 explore-master」；补上 explore-master 是**只读基线不得修改**、apply 写代码必须用该 change 的 feature worktree（`worktrees/<project>/<branch>/`，AGENTS.md 的强制 worktree 约定）。
  - **优先级未声明** → 末尾补「本指引只是知识源清单，执行细节与输出契约（Search Order、`Relevant specs consulted` / `Trust notes` 块）以工作区 SKILL.md 为准，冲突时一律以 SKILL.md 为准」——此前只写在 README 里，而 SKILL.md 是会被上下文压缩剪掉的历史消息、指引却每轮重渲染。
  - 保留 Jira 项并注明**由本指引补充**：intranet-aio 全仓未声明任何 MCP 接入方式，`theseus-retrieve-specs` 只把 JIRA key 当检索输入。
- 测试：knowledge 指引不含 needs-review/stale、含 active/draft、含 `git rev-parse --show-toplevel`、含只读基线与 feature worktree、含 SKILL.md 优先级声明；历史会话指引默认值一致、可置空、含能力式条件与边界文案，且不再重复出现在 business / knowledge 指引里。

- **修复「插件市场装不上 arena-v2」——10 条 peer 全部补 `optional: true`**：本插件的 `peerDependencies` 此前都不是 optional。插件市场的隔离暂存拉取目录没有 pnpm 配置（pnpm 默认 `auto-install-peers=true`），于是 pnpm 会去 registry 解析这些 peer 及其**传递闭包**；而 `@deepseek-ai/dsh-*` 全系只发预发布版（`dsh-invariants` 的 `latest` 还停在 `0.0.1-rc.1`，实际在用的是 `next: 0.1.1-rc.2` / `alpha: 0.1.2-alpha.3`），归并出的 `^0.1.1` 之类范围匹配不到任何版本 → `ERR_PNPM_NO_MATCHING_VERSION`，**拉取阶段就失败**（同仓 `plugin-market` peer 全 optional、`chat-rollback` peer 都有稳定版，故不受影响）。补齐 `peerDependenciesMeta` 后 pnpm 不再自动安装它们，也不会把一份重复的 dsh 闭包塞进 profile；运行期依旧由宿主的 `profiles/node_modules` 回退链按包名解析，peer 声明只作兼容性说明。
  - **为什么不是改版本范围**：`^0.1.1-rc.2` 匹配不到 `0.1.2-alpha.3`（semver 规定预发布只能匹配同一 `[major,minor,patch]` 元组），但把范围抬到 `^0.1.2-alpha.3` 会让 pnpm 真的下载整套 alpha 闭包，且上游一发 `0.1.3-alpha` 就原地复发；改成 `*` 更糟——`*` 同样排除预发布，pnpm 会去拉过期的 `latest`（实测装进来 `dsh-agent@0.1.0-rc.6`、`dsh-system-prompt@0.0.1-rc.1`）。optional 是唯一既不误装、又对 rc/alpha 宿主通吃的写法。

## 0.32.1（fix：结算包装文本解析 + 缺失的 {question} 传递 + awaiting 自愈续跑）

- **修复结算协议解析失败（session-406356e0 事故）**：dsh 的 subagent-settled 包装文本把协议拼在行中间（`…Its closing message:STAGE_DONE explore CONFIRMED`，无换行、不在行首），旧 `parseStageResult` 只认行首 → 返回 null → 回退 awaiting，而主代理仍被结算消息唤醒完成 judge+record（states 已推进到 propose），宿主却因 phase=awaiting 不再派发 → **流程停在 propose，探索者收不到下一阶段**。修复：协议标记改为**全文搜索**（取最后一个），不再要求行首。
- **自愈续跑（防御）**：即使协议再次解析失败，主代理回合结束时宿主以 Theseus 状态文件为真相恢复——`phase=awaiting` 且残留 `kStage/workflowId` 时，读 `openspec/states/<id>.json`：explore→propose 派发 propose；propose→review 派发挑战者；readiness→apply 直接进入 apply 回合（跳过重复 record，record 已完成才会推进）。正常路径不受影响。
- **补齐 `{question}` 传递**：`explorePrompt` 新增用户原始表述占位符（`「{question}」`），k_init 派发 explore 时用 `collectUserQuestion` 机器提取用户原文填充——用户的主题/范围/背景/约束不再依赖主控者自觉转述。
- **检索指引新增历史会话源**：`DEFAULT_SEARCH_GUIDE`（business）新增第 5 项——若具备检索本地 dsh 历史会话的能力（例如技能列表中有 `session-search` 或其它等价的会话检索技能/工具），可将当前工作区相关的过往会话作为搜索源（短查询定位候选、拉取完整上下文，引用时注明 session id 与日期）；没有该能力则跳过本项，不影响其它场景/部署。
- **绑定即续跑（k_init 按状态文件跳阶段）**：会话焦点已有绑定时跳过意图门控，读 `openspec/states/<id>.json` 的 currentStage 直接续跑——`propose` → 派发 propose（跳过重复 explore/record）；`review` → 直接送审；`user-readiness-review` → 续 readiness；`apply` → 主控者 apply 回合；`archive/done` → 直接收尾关闭。重启/重开后发一条消息（如「继续」）即可从断点继续，不再重跑已完成阶段。
- 测试：结算包装文本解析、同消息多协议标记取最后一个、explore 模板含 `{question}`。

## 0.32.0（feat：知识沉淀场景 = Theseus workflow 对抗流程）

- **知识沉淀（knowledge）场景整体重构为 Theseus workflow 对抗流程**（不再复用 business 的质疑/终评结构）：
  - **三代理分工**：主控者（主代理）持 Theseus CLI（mode/judge/record）与**全部** ask_user_question；探索者子代理（label `arena-explorer:knowledge`）执行 theseus-explore / theseus-propose / theseus-user-readiness-review，requirement-report 经 **subagent_fork 派生 reporter** 后台执行；挑战者子代理（label `arena-challenger:knowledge`）执行 theseus-review-spec，**只写 review.md、只返回 "Done"**。判定一律读文件（review.md 的 Overall Verdict、openspec/states 的 currentStage），不依赖子代理自述。
  - **文件所有权**：探索者写除 review.md 与 Theseus 运行时（`openspec/states/`、`openspec/.runtime/`）外的一切工件；挑战者只写 review.md；主控者只经 CLI 变更运行时状态（T6 apply 阶段在 worktree 写代码）。
  - **阶段机（knowledge 专属 phase）**：`k_init`（绑定 workflow + judge）→ `k_explore`（探索者）→ `k_gate`（主控者 judge+record，宿主验证 states 文件推进）→ `k_propose`（探索者，Metadata Interview 经 `NEED_QUESTION` 中继）→ `k_gate` → `k_review`（挑战者）→ `k_verdict`（按 review.md 分支：READY → 报告询问 → `k_readiness` → CLEARED 后主控者 `k_apply`；NEEDS_REVISION → 固定提问「再来一轮修订」，同意重新 propose 再送审，**无轮次上限**；NOT_READY → 主控者列出五维 FAIL 项 / Action Items / 未完成 Anchor Trace，record NOT_READY 后**直接关闭**）→ `k_ask`（中继提问：主控者 ask_user_question，宿主提取答案回传探索者并回到原阶段）。
  - **探索者返回协议**（宿主机器解析）：`STAGE_DONE <stage> <result>` / `NEED_QUESTION <问题JSON>` / `BLOCKED <原因>`；无法解析 → 保守回等待态可重试。
  - **readiness 分支**：CLEARED → apply；NOT_CLEARED / NEEDS_REVISION → 主控者总结后关闭。
  - **apply 验证**：主控者 `k_apply` 回合结束后宿主读 `openspec/states/<id>.json` 确认 currentStage=archive 才收尾，否则注入提醒留场重试。
  - **场景化收尾提醒**：knowledge 关闭时注入「T7 worktree-commit-push / T8 openspec-impl-doc / T9 theseus-archive-change 需用户明确指示」，不再用 business 的「禁止写操作」文案。
- **双子代理固定模型**：`registerContinuableSetup` 按 label 识别挑战者**与**探索者，两者都装 `challengerModel`（deepseek-v4-pro · max）与各自 persona（探索者=explorerPrompt，挑战者=challengerPrompt）。
- **配置扩展**：`scenePersonas.<scene>` 新增 `explorerPrompt` / `explorePrompt` / `proposePrompt` / `reviewPrompt` / `readinessPrompt` / `reportPrompt`（knowledge 默认六件套，其它场景回落空串）；新增顶层 `knowledgeInstruction`（默认 `DEFAULT_KNOWLEDGE_INSTRUCTION`）。
- **检索指引**：`sceneSearchGuide.knowledge` 默认注入 Theseus 知识源指引（openspec specs/changes/drafts、openspec/states、spec-meta.ts、Jira、explore-master worktree），不再为空。
- **固定提问**：`arena_k_report`（生成报告/跳过）、`arena_k_revision`（再来一轮修订/结束并保留当前工件），选项文案固定，宿主用 `parseKnowledgeChoice` 机器判定。
- 新增纯函数与测试：`parseStageResult`、`parseReviewFileVerdict`、`parseKnowledgeChoice`、`collectAskAnswerText`、`explorerLabelFor` / `isExplorerLabel` / `sceneFromAnyLabel`；测试覆盖双 label、协议行解析、review.md 判定（含 `**bold**` 与全角冒号兼容）、固定提问、中继答案提取、knowledge 默认 persona/模板/指令/检索指引。
- 修复：`dispatchArenaRound` 内 `subagents` 局部变量与 id 追踪 Map 同名遮蔽（business 派发改用 `subagentsSvc` 局部名）。

## 0.31.0（feat：终评仍存疑由用户决定是否再来一轮 + 收尾输出完整结论）

- **终评结论机器判定**：终评轮模板新增「**最后单独一行**输出 `结论：认可` / `结论：仍存疑`（qa 为 `结论：通过`）」要求；新增 `parseVerdictOutcome`——标记行优先（取最后一处，正文复述模板不会误判）→ 末尾两行 → 全文兜底；存疑标记先于认可检查（「不认可」「未通过」含肯定词子串），并剔除「存疑已解决」「仍未解决项：无」等消解性表述。**无法判定时保守按「仍存疑」**——把决定权交回用户，而不是直接关掉竞技场。判定结果存进侧文件新字段 `verdictOutcome`（`approved` / `disputed`；新一轮、收尾、派发失败时复位）。
- **仍存疑 → 问用户是否再来一轮**：`present` 阶段按结论分叉注入指示——仍存疑时主代理**必须调用 `ask_user_question`**（问题 id 固定 `arena_another_round`，选项文案固定「再来一轮（修正 + 终评）」/「结束竞技，输出结论」）。宿主用新增的 `collectAnotherRoundChoice` 从会话事件机器提取用户选择（只看**最后一次挑战者结算之后**的 ask_user_question 工具结果，避免把作答/修正阶段的澄清提问误读成续轮意愿）：选「再来一轮」→ 主代理在本回合内完成修正、`turn/end` 后宿主再派发一次终评轮；选「结束」/ 没问 / 无法判定 → 收尾关闭（不会卡在 present）。
- **收尾必须输出完整结论**：新增配置 `conclusionPrompt`（默认 `DEFAULT_CONCLUSION_PROMPT`，`''` = 不注入）——终评认可、或用户拒绝再来一轮时注入【结论输出要求】：结论本身 / 依据与出处 / 经质疑修正的要点 / 仍未解决项 / 建议的下一步，明确禁止只给概览摘要，并重申执行边界（只给建议，不改代码文档）。默认指令第 3 条同步重写为「呈现终评 → 按结论分支收尾」。
- **轮次计数保留但不参与判定**：`verdictRounds`（侧文件）与 `maxVerdictRounds`（配置）作为既有设计保留，**不记录、不累加、不设上限**——是否再来一轮完全由用户逐轮决定，可无限循环。
- `arena_finish`（兼容保留工具）描述同步为宿主驱动语义。
- 测试：`parseVerdictOutcome`（标记行/末尾回退/存疑优先/消解性表述/多场景标记/空值）、`parseAnotherRoundAnswer`（固定选项/自定义否定优先/非 JSON）、`collectAnotherRoundChoice`（结算前提问不计入/非 ask 工具结果不计入/没问 = null）、`conclusionPrompt` 默认值与指令断言。

## 0.30.1（fix）

- **修复本轮运行失败 `invalid session reference URI`**：dsh 的 session-reference 预处理器会对 user 消息文本里的 `dsh-session:[base64url]` 解码校验——组装好的质疑/终评消息发给挑战者时，若主代理回答或工具摘要（`summarizeToolArgs` 80 字截断）含 `dsh-session:` 片段，非 canonical 即抛错导致挑战者 run 失败；即便 URI 合法，挑战者预处理器也会**解引用注入被引用会话上下文**（隔离漏洞）。
- **修复**：新增 `sanitizeSessionRefs`（`dsh-session:` → `dsh-session：` 全角冒号，破坏 URI 形态），`composeRoundText` 返回前统一中和，`steerArenaNote` 注入文本同样中和——既防预处理器抛错，又防挑战者解引用主上下文（强化隔离）。
- 测试：`sanitizeSessionRefs`（裸 URI/mention/截断/原样/幂等/非字符串）+ `composeRoundText` 输出不含 ASCII `dsh-session:`。

## 0.30.0（feat：flash 意图识别）

- **flash 意图识别门控**：`/arena` 开启时，用户消息到达即进入作答阶段（主代理零延迟作答），同时**并行**用 `deepseek-v4-flash`（`reasoningEffort=off`，无思考）判定该消息 `need_answer` / `no_need_answer`；`turn/end` 时取结果——`no_need_answer`（纯测试/问候/确认/闲聊，如"测试"）**不派发挑战者**、静默复位 awaiting；`need_answer` 或判定失败（保守放行）→ 照常派发质疑轮。
- 宿主调用参考 dsh-session-title-llm：`settingsCtx.get('llm')` + `llm.stream` + `BlockAssembler`；输出解析 `parseIntentOutput`（JSON 优先、`no_need_answer` 先于 `need_answer` 子串检查）；模型不支持 `reasoningEffort:'off'` 时自动省略重试。
- 新配置 `intent`：`enabled`（默认 true）/ `provider`（deepseek-official）/ `model`（deepseek-v4-flash）/ `reasoningEffort`（off）/ `timeoutMs`（3000）/ `maxTokens`（16）。`intent.enabled=false` 或 flash 不可用时回退 `need_answer`（行为同 0.29.3，不更差）。
- 测试：`parseIntentOutput`（JSON/裸词/子串/空/垃圾）+ `intent` 配置默认断言。

## 0.29.3（fix）

- **修复宿主派发必失败**：`startContinuable` / `followup` 内部会调用 `signal.throwIfAborted()`，此前宿主派发未传 `signal` → `Cannot read properties of undefined (reading 'throwIfAborted')`，导致 `/arena` 开启后质疑轮派发每次都抛错回退等待态（触发表现为"没触发"）。现在派发统一携带插件级 `dispatchAbort.signal`（卸载时 abort）。

## 0.29.2（chore：触发诊断）

- 宿主派发失败（live 主代理不可用 / 无会话事件 / subagents 服务缺失 / `startContinuable`·`followup` 抛错）现在**注入会话可见**（主代理会把 `⚠ 竞技场…派发失败：<原因>` 呈现给用户），并回到等待态可重试——不再只进终端日志。
- `session/event` 事件追踪日志（user/message、turn/start、turn/end + phase），配合终端可定位「开启后未触发」是事件没到、phase 未推进还是派发抛错。

## 0.29.1（fix）

- 设置「竞技场」卡片改为**浏览器式页签**：顶部 [业务探索 | 知识沉淀 | 测试用例] tab 栏（激活页签 business 高亮 + 底部连接内容卡），点击切换，内容区只展示当前场景的 persona——不再三场景竖排挤成一条。

## 0.29.0（feat）

- **三场景 persona 内容接入 + 设置卡片**：
  - 每场景独立 persona 集（`scenePersonasOf`：场景默认 > 顶层 business 默认 > `scenePersonas` 配置覆盖），流程按场景选用——主代理 persona、挑战者 persona、质疑/终评模板全部场景化（registerContinuableSetup 按挑战者 label 场景取，installMainPersona 按会话场景取，composeRoundText/arena_compose/派发按场景取模板）；
  - 新增 knowledge / qa 默认 persona（知识沉淀=Knowledge Expert/审查者 READY·NEEDS_REVISION；测试用例=QA Expert/用户视角逐条验收），business 沿用原 Technical Expert/Business Analyst；
  - **设置弹窗「竞技场」卡片**：注册进 `settings.section`（设置页导航出现「竞技场」），从新路由 `/arena-v2/personas` 拉取三场景全部 persona 只读展示（与 business 共用默认的场景标注），zh/en 双语文案；
  - 新配置 `scenePersonas`（`{ scene: { mainPersona?/challengerPrompt?/challengePrompt?/verdictPrompt? } }`）。
- 测试：新增 `scenePersonasOf`（默认回落/场景差异/配置覆盖）覆盖。

## 0.28.0（feat：宿主驱动）

- **竞技回合改为宿主驱动**（不再依赖主代理自觉编排）：开启竞技场后，回合由 `session/event` 状态机自动推进——用户消息 → 主代理作答（phase=answer）→ `turn/end` → 宿主 `composeRoundText` 机器提取四字段组装质疑轮 → `subagents.startContinuable`（首轮）/ `followup`（复用）派发（phase=challenge）→ 挑战者结算回传（`subagent-settled`）→ 主代理修正（phase=revise）→ `turn/end` → 宿主组装终评轮 `followup`（phase=verdict）→ 终评回传（phase=present）→ 主代理呈现 → `turn/end` → 宿主关闭。**`/arena` 开启后下一条消息必然进入竞技**。
- **phase 扩展**：awaiting/answer/challenge/revise/verdict/present + `pendingDispatch`（侧文件持久化，重启按状态恢复）；派发失败回退 awaiting，下一条消息可重试。
- **默认指令重写**：主代理不再调用 `arena_compose` / `send_message` / `arena_finish`，只按「竞技阶段」指示作答/修正/呈现并结束回合；回合模板仍注入供其了解挑战者收到的内容。
- **新配置 `subagentProvider`**（默认 `spawn`）：宿主创建挑战者的 provider。
- **宿主 API**：`agents.get(sessionId)` 取 live 主代理；`startContinuable` / `followup` 派发。
- 测试：指令断言改为宿主驱动语义；新增 `subagentProviderOf` 覆盖。

## 0.27.4（chore：诊断）

- 为「开启竞技场后下一条消息未触发竞技流程」问题加运行时诊断日志：系统提示注入的每个门控（`enabled` / `arenaOn` / `hasSubagent` / 深度 / 会话来源）、注入成功与否、`setArenaMode` 落盘结果。复现时看 dsh web 终端输出即可定位失败门。

## 0.27.3（fix）

- 点击 chip **开启**竞技场后自动弹出场景浮层（鼠标此刻已在 chip 上，无需移开再 hover）——点击成功且开启时 `setExpanded(true)`，关闭时收起；场景锁定（已有挑战者）的会话 `showScenePick` 为 false，不会误弹。

## 0.27.2（fix）

- chip 场景浮层只在**竞技场已开启**（且会话尚无挑战者）时出现——未开启时 hover 不反应（chip 是普通开关，点击以默认场景开启后再 hover 可换场景）；与 hero（开启才显示场景段）行为一致。

## 0.27.1（fix）

- 修复场景点击"直接消失 + 无反应"：chip 浮层改为**命令成功后才收起**（不再点选即收），期间浮层保持打开（场景按钮即选中反馈），配合下方延迟修复后点击即时点亮。
- 修复 hero 场景点击 ~1s 延迟：场景锁定检查原来冷缓存时每次打一次慢的 `listChildren`。`statePayload`（每次状态拉取，挂载/轮询都会走）改为经 `cachedChallengerEntry` **顺带预热锁定检查缓存**，TTL 2s→10s——挂载后场景点击基本命中缓存，无需再等 `listChildren`；`hasChallengerCached` 保留内存 Map 同步快路径，`subagent/start` / `agent/disposed` 失效缓存。

## 0.26.2（fix）

- 场景按钮排版放宽：字号 12px→13px、左右内边距 10px→14px、最小高度 22px→26px、加 `white-space:nowrap`（防止四个汉字被挤压/换行）；分段控件内边距 2px→3px、圆角 8px→10px，滑块（`.ra2-thumb`）对齐同步（top/bottom 3px）。hero 场景段与 chip 浮层共用同一控件、同步生效。

## 0.26.1（fix）

- 修复 composer chip 场景浮层 hover 问题：浮层与 chip 之间有 8px 空隙，鼠标从 chip 移向浮层时经过空白（不在 wrap DOM 内）会触发 `mouseLeave` → 浮层在点中场景前收起。新增 `.ra2-chipScenes::before` 透明桥接区（覆盖空隙，属于浮层元素 → 不触发离开）。
- 修复场景选择变慢：场景锁定检查原来每次点击都打一次异步 `listChildren`。新增 `hasChallengerCached`（内存快路径 `challengers` Map + 2s TTL 正负缓存，`subagent/start` / `agent/disposed` 失效）；命令与路由的锁定检查走缓存；场景点击时浮层立即收起（即时反馈，不等命令返回）。

## 0.24.0（feat）

- **竞技工具按会话注册**：`arena_compose` / `arena_finish` 不再全局注册，改为随竞技场开启注册到该会话作用域（`agent.ctx.tools`）、关闭即卸载——关闭后模型看不到这两个工具，机制上无法再走竞技流程（不依赖模型自觉，即使历史上下文残留竞技指令）。
- **场景检索指引**：新增 `sceneSearchGuide` 配置（按场景的字符串字典，空 = 不注入），系统提示按当前场景注入「回答前主动检索的知识源」策略。

## 0.23.1（fix）

- 修复 composer chip hover 屏幕狂闪：场景选择原来是**内联渲染**在输入栏（`.rArena_wrap` 内联展开），展开后 composer 布局被撑宽重排、chip 随之中位移动 → 鼠标"离开→进入"无限振荡。改为**绝对定位浮层**（`.ra2-chipScenes`，`bottom: calc(100% + 8px)` 悬于 chip 上方，不占布局）；浮层是 wrap 的 DOM 子节点，移入浮层不触发 `mouseLeave`；打开时点击外部关闭；选择/切换成功后自动收起。
- 说明：**已有挑战者的会话场景锁定**（不显示场景选择）是预期行为；无挑战者的会话 hover 现在稳定展示场景浮层。

## 0.23.0（feat）

- **挑战者按场景区分**：挑战者身份携带场景（label = `arena-challenger:<scene>`，旧版无后缀兼容为 business）；`challengers` 缓存与 `resolveChallenger` 按 (会话, 场景) 定位；`registerContinuableSetup` 按场景 label 识别并安装固定模型 + persona（内容暂用业务探索一套，结构已按场景就绪——persona 管理结构性重做）。
- **场景锁定**：会话**已有挑战者**后不允许切换场景——chip/hero 不显示场景选择，`/arena <scene>` 与 `?scene=` 写场景均拒绝（命令与路由按 `listChildren` 枚举挑战者判断）；开启即复用原场景挑战者（`send_message` 接续），跨开关/重启保留。
- **无挑战者的场景选择**：输入栏 chip 在会话无挑战者时 **hover / 键盘聚焦展开场景分段控件**（同空对话态控件），点场景即以该场景开启（`/arena <scene>`）；点 chip 本体以默认场景（business）开启。空白页 hero 开关场景段不变。
- **/arena 命令场景参数**：`/arena off` 关闭；`/arena business|knowledge|qa` 指定场景开启（首词是场景键则作场景，其余为消息）；无场景键时整段为消息、场景按会话原场景解析（默认 business）。已开启状态下换场景（无挑战者）同样生效。
- **状态路由扩展**：`/arena-v2/state` 返回 `hasChallenger` / `challengerScene`（异步枚举子代理按 label 判断），chip 据此决定是否展示场景选择；写场景分支同样执行场景锁定。
- **系统提示场景化**：注入「当前场景」+ 当前场景的挑战者 id；指令改用 `{challengerLabel}` 占位符（不再硬编码固定 label）。
- 测试：新增 `challengerLabelFor` / `isChallengerLabel` / `sceneFromLabel` / `parseArenaCommand` 覆盖；指令断言更新。

## 0.22.0（feat）

- 场景高亮改为**滑动滑块**：`.ra2-sceneSeg` 内新增 `.ra2-thumb` 绝对定位高亮块，通过 `transform`/`width` 过渡在场景按钮间**平滑移动**（.18s ease-in-out；`prefers-reduced-motion` 下禁用过渡）。原按钮各自的 `aria-pressed` 背景高亮移除（高亮统一由滑块提供，选中文字保持 business-primary 加粗）。
- 滑块定位：repaint 后 rAF 读取布局值（offsetLeft/offsetWidth）；ResizeObserver 兜底（段显示/窗口缩放/字号变化重定位）；不可见（竞技场关闭）时不定位。

## 0.21.3（fix）

- 修复 hero 开关"弹出"延迟：挂载不再等会话快照（原实现要求 `sessionId` 就绪才找 hero 行，加上 60ms 防抖与行重建时 remove→重建，页面画完后 pill 才出现）。现在**hero 行一出现即挂载**（应用启动首帧的 hero 页也直接随页面出现，与 composer 里 chip 同帧）；行元素被 React 重建时只把 wrap 挪到新行（不重建、不闪）；调度改为 30ms 节流合并，长尾 DOM 变化不再推迟挂载。会话 id 未就绪前交互守卫（点击/保存跳过），id 解析后自动水合状态。

## 0.21.2（fix）

- 修复场景按钮闪烁：切场景的 `sceneBusy` 改为**纯逻辑防重入守卫**——不进 repaint 签名、不再写 `disabled`（移除 `.ra2-sceneBtn:disabled` 样式）。场景保存期间按钮外观完全不变（点击后仅选中高亮移动一次），保存快速、无可见禁用态。

## 0.21.1（fix）

- hero 开关 pill 文案改为英文 **"Arena"**（与输入栏 chip 一致，不再随 locale 显示「竞技场」）。
- 修复场景点击闪烁：切场景不再把 pill 置为 disabled（原实现共用 busy 状态，场景保存期间 `.ra2-toggle:disabled` 的 opacity 变暗导致 pill 闪一下）；busy 拆分为 `toggleBusy` / `sceneBusy`——切场景只禁用场景按钮，pill 不受影响。

## 0.21.0（feat）

- **空白页 hero 开关**：新对话空白页（hero workspace row，锚点与 model-arena v1 同款）新增 "Arena" pill（样式模仿 v1 的 hero toggle）；开启后开关右侧只显示场景分段控件——业务探索 / 知识沉淀 / 测试用例——不做模型选择、不做 skill。
- **场景状态**：会话侧文件新增 `scene`（business/knowledge/qa，未知回落 business）；`/arena-v2/state` 路由返回 `scene`，并支持 `?scene=` 保存；场景当前仅存状态、不切换竞技行为（行为接入见 README「场景」）。
- **双入口状态互通**：输入栏 chip 与空白页 hero 开关共用同一份侧文件状态；任一切换开关/保存场景后经 `arenaBus` 通知双方重新拉取 `/arena-v2/state`，刷新 / 切会话不丢。
- **注入**：client 新增 `sessions` 服务（取当前会话 id，定位 hero 行）。
- 测试：smoke 新增 `SCENES` / `normalizeScene` 覆盖。
