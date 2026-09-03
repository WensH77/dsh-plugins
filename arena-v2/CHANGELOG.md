# 变更日志（arena-v2）

> 0.21.0 之前的历史改动未整理成 changelog（本目录当时尚未随版本记录）；此前版本可参考 git 提交与 README。

## 0.33.34（opt：readiness→apply 确认门去重——面试已确认「apply 启动决定」时不再重复提问）

- **现象**（90527e05 14:28–14:30）：「进入 apply」被问两次且语义重复：先由就绪评审面试内的 `readiness_q14b`（apply 启动决定）询问并获确认「确认进入 apply」，随后 readiness CLEARED 的确认门又用 `arena_k_advance` 再问一次「是否确认进入 apply 阶段」。
- **修复**：k_gate（kNext=apply）阶段指示新增**先去重**步骤——若已进行的就绪评审 Q&A 已含「apply 启动决定」且用户已选「确认进入 apply」（read user-readiness.review.md 核对），**不再重复提问**：直接呈现结算与 Requirement Alignment 表、judge、record `user-readiness-review.completed CLEARED` 后结束回合；仅当评审未含该决定（或未确认）才问 `arena_k_advance`。宿主推进不变：主控者不提问时按文件真相（Theseus 到 apply）走 dispatch 进入 apply 回合。
- **同类问题排查结论**：① review READY 门一次问两道（报告 + 进入 user-readiness）为既有设计（两问内容不同、非重复）；② 「上一轮提问被中断未收到作答」重发为重启/未答恢复兜底（非同一轮重复）；③ explore/propose 的 Metadata Interview 与阶段确认门不同义、无重叠；④ readiness 面试内其它问题与确认门不同义。**唯一语义重复点即 apply 这一处**，已修。
- 测试：npm test 全绿（阶段指示为模板文案，无新增纯函数）。

## 0.33.33（fix：user-readiness NEEDS_REVISION 确认修订后未派发 propose、竞技场误关）

- **现象**（90527e05 13:17–13:18）：user-readiness 结算 `NEEDS_REVISION`（用户拍板 Panel Discussion 语义变更需回 propose 收编）→ 主控者呈现并问 `arena_k_advance` → 用户确认"推回修订" → 主控者补齐 record（`review.completed READY` + `user-readiness-review.completed NEEDS_REVISION`，workflow 已回 **propose**）→ 回合结束宿主却**直接关场**：探索者从未被委派重新 propose。
- **根因**：readiness 阶段 `NOT_CLEARED / NEEDS_REVISION` 结算把 k_gate 置为 `kNext='close'`；k_gate 的 close 分支**无条件 finishArenaRound**——没有像 review NEEDS_REVISION（k_verdict 分支）那样的"确认修订 → 派发 propose"路径，也不看 Theseus 文件真相。主控者按 persona 已 record（文件已到 propose），宿主仍关场。
- **修复**：k_gate `kNext==='close'` 分支先读 Theseus 状态：若 `currentStage==='propose'`（=用户已确认修订且 record 生效的文件真相）→ 写 k_propose/pendingDispatch=propose 并**派发 propose 修订轮**给探索者（修订提示引用 user-readiness.review.md 差异与 Action Items），不关场；仅当文件仍停在 user-readiness-review / review（未确认/未 record）才 `finishArenaRound` 收尾。
- 附带核实：关场路径 `finishArenaRound` 调用 `disposeMainPersona`（卸载 arena persona 段、arena 工具、/goal 影子、restrict/guard disposer）——arena 退出后主代理 persona 不残留；本现场 13:18:29 的 `active:true+awaiting+清空` 状态是 `setArenaMode(开启)` 的写入形状（用户重新开启），非清理遗漏。
- 测试：npm test 全绿（该分支属宿主状态机，无新增纯函数用例）。

## 0.33.33（feat：就绪题问答透传重构——宿主直问（方案 B），主代理退出 Q&A 热路径；对账随弹窗必现）

- **背景**：问题/答案透传链此前含 4 个模型/运行时关节（探索者打包→回合末条截断→主代理转述提问→主代理回传），0.33.27–0.33.32 六连补丁全部是"提高某一关节自觉度"，反复打补丁治标。
- **重构（方案 B，团队共享文件零改动）**：
  - 宿主在 readiness NEED_QUESTION 结算时，经 **`ctx.userQuestions.ask`** 直接向用户提问（UI 与 ask_user_question 同一管道；`agent` 传 live 主代理）；`user-readiness.review.md` 仍只读不改、探索者产出与 theseus skill 不变；
  - **答案正确与否的透传由宿主保证**：把文件末节 Reconciliation 作为**问题文本前缀**随弹窗逐题呈现（aligned/discrepancy/未作预测均含），不再依赖探索者打包/主代理转述/注入时序；
  - 作答由宿主**原文回传**探索者（无措辞漂移），随后恢复 k_readiness 等待下一题或阶段结算；
  - **防双重提问（结构性）**：pre-step 在就绪题回合把消息整体替换为「宿主代问」注记（含对账）——主代理看不到题面 JSON；k_ask turn/end 在宿主提问挂起期间跳过"未取到回答→回等待态"处理；
  - **回退链**：userQuestions 不可用 / 题面解析失败 / ask 中止 → 自动回退旧路（k_ask + 主控者按 0.33.29 必读规则转问 + 0.33.31 注入兜底），流程不断。
- 纯函数：`buildReadinessAskQuestions(questionJsonText, reconc)`（解析 NEED_QUESTION JSON、对账前缀、剔除线索字段只留展示字段）、`readinessTurnHostAsk(st, msgText)`（是否由宿主代问并替换回合）。
- 测试：新增 8 用例（对账前缀/线索剔除/非 JSON/k_readiness 判定/非题消息/非 active）；npm test 全绿。

## 0.33.32（fix：agent/pre-step 注入时序——pre-step 与宿主 k_ask 写入存在竞态，settle 裸题回合漏注入）

- **现象**（0.33.31 实测）：注入只出现在用户「继续」触发的回合（13:05:02），而探索者发裸题直接触发的回合（12:54:46 q12、12:58:58 q13、13:06:00 q14）**均无注入**——主控者照样先裸问、后一轮才补对账，观感乱序。
- **根因**：pre-step（agent-loop 回合开始）与宿主的 session/event→写 k_ask 存在竞态；settle 触发的回合里 pre-step 常先于 k_ask 写入执行 → 0.33.31 的判定（仅当 phase===k_ask）拿到的是 k_readiness → 跳过注入。
- **修复**：注入判定放宽到两类：①宿主已写 k_ask（kPrev=k_readiness，含用户续跑回合）；②仍停在 **k_readiness/pendingDispatch=readiness** 但本回合消息**确在携带一道就绪题**（含 `NEED_QUESTION`）——用消息内容判定，不依赖宿主状态写入先后；探索者已打包对账（含标记）仍跳过；非题消息（如 reporter 状态同步）不误注入；同一对账去重不变。
- 测试：`readinessPreStepShouldInject` +3（k_readiness+NEED_QUESTION→注入、k_readiness 非题消息→不注入、纯 NEED_QUESTION→注入）；npm test 全绿。

## 0.33.31（fix：宿主可见注入 agent/pre-step——裸题回合开始前把对账作为 plugin 消息并入，机械兜底的最终形态）

- **遗留问题**（90527e05 对账丢失链收官）：0.33.27 宿主注记通道不落地；0.33.28/0.33.29 主控者必读指令（实证在其 system prompt）不执行（12:52 后 q11/q12 提问前零次 read）；0.33.30 探索者"对账+下一题同条回合末消息"硬格式仍属模型自觉。三者都非机械保证。
- **修复（机械）**：arena 注册 `agent/pre-step`（与 theseus `<theseus-workflow-context>` 同一注入机制）——当主控者即将转问"裸题"（竞技场状态 k_ask/kPrev=k_readiness 且触发回合的消息未含对账标记）时，宿主在回合开始前读 `user-readiness.review.md` 末节 Reconciliation，作为 **plugin 消息**（`source:{kind:'plugin'}`）并入本回合：
  - 对账与提问同回合、对用户与模型都可见——不依赖主控者/探索者任何一边的模型自觉；
  - 探索者已打包对账（消息含标记）→ 不重复注入；同一对账只注入一次（in-memory 去重）；首题/无待问/非 knowledge 均跳过；
  - 全 try/catch：pre-step 基决策失败返回空 enter，注入失败回落原决策，绝不影响回合推进。
- 纯函数：`readinessPreStepShouldInject(st, msgText)`、`stepTextOf(messages)`、`arenaPluginMessage(text)`（plugin 消息信封，镜像 theseus）。
- 测试：`readinessPreStepShouldInject` 6 用例（裸题→注入/无问题/非 readiness/非 active/非 knowledge/已打包不重复）；npm test 全绿。
- 说明：plugin 消息的 UI 呈现形态与 theseus workflow-context 一致（进程内同机制）；这是当前 dsh 插件 API 下能做到的**最高机械保证**。

## 0.33.30（fix：约束探索者——就绪评审对账改「单条回合末消息硬格式」+ 送达机制解释）

- **遗留问题**（90527e05 复现链）：主控者侧已加两层指令（0.33.28 条件必读、0.33.29 无条件必读+违例观测），实测 12:52 重启加载 0.33.29 后 q11/q12 提问前主控者**仍零次 read 文档**——文本规则对主控者无效。回到根因：探索者每轮其实都产出对账（写进 user-readiness.review.md），但把它发成**回合中段** assistant 文本、随后继续工具调用，回合末条只有「下一题」——dsh 只回传**回合最后一条**，对账从未送达主控者/用户。探索者自身并不知道"中段消息不会送达"（它以为自己已经发出了）。
- **修复（约束探索者）**：探索者 persona 的对账规则升级为**硬格式 + 机制解释**：
  - 「就绪评审对账硬格式」：每道题作答后，对账（规则揭示、用户答案、**答案是否正确 aligned/discrepancy/未作预测**）+ 下一道题必须放在**同一条回合末消息**，固定排版（对账前置、NEED_QUESTION 在后）；首题免对账。
  - **整个回合只能以这一条 assistant 消息收尾**——先写完全部工件（Reconciliation），**禁止回合中段先发对账再继续调用工具**；
  - 明确写出原因：dsh 只回传回合最后一条，中段输出=用户永远看不到答案对错（90527e05 根因），主控者只会收到裸的下一题并被直接转问。
- 主控者侧 0.33.29 无条件必读保留作双保险；宿主补发（0.33.27）保留作兜底。
- 测试：探索者 persona 断言 +3（硬格式、回合最后一条、禁止中段先发）；npm test 全绿。

## 0.33.29（fix：readiness 对账规则改「无条件必读」+ 宿主执行观测——0.33.28 条件式指令模型未执行）

- **遗留问题**（接 0.33.28）：0.33.28 把对账义务写进主控者指令（条件式："若消息未含对账则 read"），实测 12:40 重启后指令确在主控者 system prompt（两处标记验证），q10→q11 仍直接转问——LLM 对"先判断缺失再动作"的条件分支执行不稳定。文档侧证据充分：`user-readiness.review.md` 每答一题都写 Reconciliation（aligned / discrepancy / 未作预测均记录），宿主解析器可稳定取出——问题只在主控者不去读。
- **修复**：规则改为**无条件必读**（删除"若缺失"判断，少一个分支）：就绪评审每收到一道新题、转问用户前**必须先用 read 读 `user-readiness.review.md`**；末节若有尚未呈现的 `Reconciliation`（含 User answer 的最后一节，无论 aligned/discrepancy/未作预测）先**原文呈现**再转问下一题；无未呈现对账（首题/已呈现）则直接转问。同步更新主控者常驻指令与 k_ask 阶段提示两处。
- **执行观测（0.33.29）**：新增纯函数 `readinessAskSkippedDocRead(events)`——turn/end 时检测当前回合是否出现"未 read user-readiness.review.md 就调用就绪题 ask_user_question"的违例，命中记 warn 日志（不阻断；阻断需 dsh 提供宿主可拦截/改写子代理分发的能力，超出插件范围）。
- 测试：指令新文案断言 +2；`readinessAskSkippedDocRead` 5 用例（未读即问→true、先读后问→false、非就绪题不检、读在问后→true、缺失→false）；npm test 全绿。
- 说明：若无条件必读仍被模型跳过，下一档是宿主导流（裸题弹回 + 探索者补发）或 dsh 侧宿主 ask/append 能力——按需再上。

## 0.33.28（fix：readiness 对账兜底载体修正——「每答必回对账」改为主控者转问前的硬性义务）

- **遗留问题**（接 0.33.27）：0.33.27 的宿主补发用 `steerArenaNote` 注记让主控者转述上一题对账——但注记经 steer 注入与「subagent-settled 触发主控者回合同帧」竞争，实际不落地（本会话历史 ⚠ 类注记零出现）；探索者仍把对账发成回合中段消息（只回传回合末条）→ 用户仍看不到「答案正确与否」（90527e05 重核 R1/R2 复现：探索者 12:32:38/12:33:44 均产出对账，末条只有下一题，主控者直接转问）。
- **修复（方案 A）**：把义务放在唯一执行者（主控者）身上、数据源用确定性文件——知识沉淀主代理指令与 k_ask 阶段提示同时加入**硬性步骤**：转问下一题前，若本消息未含上一题「答案是否正确」/「对账」且非本场首题 → **必须先 read `user-readiness.review.md` 末节（含 `User answer` 的最后一节）的 `Reconciliation` 原文原样转述给用户，再转问下一题；上一题对账未呈现前禁止转问下一题**。探索者漏打包/中段消息都不再导致用户看不到对账——主控者有明确动作（read 文件）与禁令（禁跳步转问）。
- 测试：`DEFAULT_KNOWLEDGE_INSTRUCTION` 断言 +2（含硬性步骤与禁令文案）；npm test 全绿。

## 0.33.27（fix：user-readiness 预测题「每答必回对账」的机械兜底——探索者对账消息丢失时宿主代读补发）

- **事故**（session-90527e05）：user-readiness 面试中 Q1 答完用户能看到「第 1 题对账 / 答案是否正确」，Q2/Q3（Pulse、客户主导）答完后看不到——只有下一题。探索者 b7f2664a 会话日志证明其**每轮都写了对账**（含答案是否正确）；但 Q2/Q3 轮把对账发成**回合中段**的 assistant 文本、随后继续工具调用，回合末条只含「下一题 NEED_QUESTION」——dsh 只把子代理**回合末条**回传父会话 → 对账丢失。Q1 轮把对账与下一题打包在同一条末条消息（探索者 persona `readinessPrompt` 规定的形态）→ 正常送达。属 LLM 消息排版漂移，时好时坏。
- **修复（机械兜底，不依赖探索者排版）**：knowledge 结算处理在 readiness 阶段收到 NEED_QUESTION（下一题）时，先检查该消息是否已含对账标记（`hasReadinessReconcileText`：含「答案是否正确」/「对账」则探索者已打包，跳过）；缺失时宿主代读 `openspec/changes/<workflow>/user-readiness.review.md` 中**最后一题已作答**的 Reconciliation（`lastAnsweredReconciliationOf`，按段落取含 `User answer` 的末节），以 ⧉ 注形式指示主控者先把该对账原文转述给用户再转问下一题。用户答「不确定——一起核对」时文件同样有 Reconciliation（规则揭示 + 未作预测说明），兜底天然兼容。
- 纯函数 + 测试：`hasReadinessReconcileText` 3 用例、`lastAnsweredReconciliationOf` 4 用例（含「不确定」fixture、无已答题返回 null）；npm test 全绿。
- 主控者 persona 本已允许 read user-readiness.review.md 原文引用（.784），此处把「内容可得性」从模型自觉升级为宿主保证。

## 0.33.26（fix：「主控者禁创建新子代理」补执行级硬门 tools.guard——restrict 对 own 层注册的 subagent 结构性无效）

- **事故**（session-90527e05，接 0.33.25）：propose 确认后主代理在 10:30:40 直接用 `subagent` 工具**自建了挑战者** ee8feef6（label 是自拟描述串、非 arena-challenger），宿主 k_gate 文件真相派发又建了正式挑战者 99b0fc28 → 双挑战者并存；99b0fc28 随后被外部停止、review.md 无人产出、竞技场关闭。
- **根因**：0.33.20 起「主控者禁 subagent/subagent_fork」的实现只有 `tools.restrict({deny})` **软过滤**，而 dsh-tools 的 restrict 只能过滤 scope「继承」（global/preset 层）的工具（`restrictableNames` 只收 inherited）；`subagent` 由 dsh-tool-subagent 注册在**会话 own 层**（runtimeCtx 动态注册），不在可限制清单 → restrict 整单抛 "unknown global tool" → catch 逐名重试仍失败、只记 warn → **对 subagent 从未生效**。对照实证：同一次 deny 里继承层的 goal 工具全程被滤、subagent_fork 重启后被滤，唯独 own 层的 subagent 每轮 request header 都可见。
- **修复**：`installMainPersona`（knowledge 场景）在 restrict 之外补 `agent.ctx.tools.guard()` **执行级硬门**——guard 在 dispatch 前按 `exec.name` 判定，命中 `CHILD_CREATE_TOOL_NAMES` 即返回拒绝文案（工具调用整体失败，主代理可见原因）。纯函数 `childCreateDenyReason(name)` 输出文案（undefined = 放行）。作用域精确：经 agent.ctx 注册只对该会话主代理生效，子代理 own 层不受影响（探索者 fork reporter 的 subagent_fork 照常可用）；`send_message` 不在名单（向已存在探索者/挑战者委派保持开放）；宿主派发走 ctx.subagents API 不经主代理工具、不受影响。restrict 仍负责隐藏继承层工具（goal / subagent_fork）。
- 测试：`childCreateDenyReason` 六用例（subagent/subagent_fork 拒绝、send_message/list_agents/缺失名放行）；npm test 全绿。
- 恢复/验证：重启加载 0.33.26 后，在任一 knowledge 竞技场会话让主代理尝试 `subagent`/`subagent_fork` → 应收到拒绝文案；`send_message` 照常可用。

## 0.33.25（fix：子代理任务在途信号窗口化——修复 NEED_QUESTION 中继后 k_gate 被历史 send_message 永久 stay 的卡死）

- **事故**（session-90527e05，2026-09-03 上午）：知识沉淀 explore → propose 全流程走通、用户确认、主控者 record `propose.completed`（Theseus 已推进到 **review**），但 10:05:33 回合结束后宿主**没有**派发 review 挑战者——侧文件停在 k_gate、review.md 不存在，流程卡死在 review 之前。
- **根因**：0.33.22 把「子代理任务在途」检测（`hasArenaChildDelegation`）接到 knowledge turn/end 时用的是 `sessionEventsOf(session)` **全量历史**事件，只认"历史里是否出现过对竞技场子代理的 send_message"。而 0.33.20 起的正常路径——探索者 NEED_QUESTION（如 Metadata Interview）时主控者用 `send_message` 把用户回答直传探索者（k_ask 中继）——会**永久残留**在事件流里；此后每次 k_gate 决策 `childTaskInFlight=true` → `planKnowledgeGate` 无条件返回 **stay**（stay 优先于 dispatch/close，且只记日志无任何可见提示）→ 竞技场既不开下一阶段也不关场。同会话两次确认门对照：explore 门（09:56，历史无 send_message）正常派发 propose；propose 门（10:05，历史含 09:59:35 的中继）卡死——唯一差别即那一次中继。
- **修复**：新增纯函数 `roundEventsOf(events)`（取**最后一次 turn/start 之后**的事件；无 turn/start 回退最后一次 subagent-settled 之后；锚点语义与 `collectAskAnswerText` 一致），在途检测改为 `hasArenaChildDelegation(roundEventsOf(eventsK), …)`——只有**本回合**主控者向竞技场子代理的 send_message 才算在途。修订轮/补派/rerun 等**当回合**委派仍正确 stay；历史回合的合法中继不再误伤。k_gate / k_ask / k_verdict 三处共用同一修正信号。
- 测试：`roundEventsOf` 六用例（空/全量回退/settle 兜底/turn/start 优先）+ 组合回归两条（历史中继 → 不在途 → 确认门 dispatch 派发 review——本次事故形态；本回合委派 → 仍在途 → stay）；npm test 全绿。
- 恢复：重启加载 0.33.25 后，对卡住的会话重开 `/arena knowledge` 发「继续」走 k_init 续跑（读 currentStage=review → 直接派发 review 挑战者），或直接在已开状态发「继续」由 k_gate 回合按修正后的在途判定正常派发。

## 0.33.24（feat：knowledge 探索者与挑战者模型分离——探索者改用官方 deepseek-v4-flash · high）

- **动机**：知识沉淀的探索者是高频长链路工件生成角色（explore/propose/readiness 全由它跑），与评审对抗的挑战者共用 deepseek-v4-pro · max 性价比低；探索者切到官方 deepseek-v4-flash · 推理深度 high，挑战者保持不变。
- **改动**：
  - 新增 `DEFAULT_EXPLORER_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }` 与纯函数 `explorerModelOf(cfg)`（配置优先、缺省字段回退默认，与 `challengerModelOf` 同构）；
  - Config 新增 `explorerModel`（z.object 默认值同上），settings 注册 base 同步加入；
  - `dispatchKnowledge` 按角色取模型：`role === 'explorer'` → `explorerModelOf`，挑战者（含 business/qa）→ `challengerModelOf`；创建请求的 `agentOptions` 随之分离。
- **注意**：模型随创建请求注入并持久化进子代理 descriptor——**已存在的探索者（如 2bf6aff4）继续用旧模型**，新配置只对之后新建的探索者生效（新工作流/新会话，或现有子代理被重建后）。探索者 fork 的 reporter（requirement-report PPT）继承探索者模型（fork 不带 modelSelection），即也会用 flash·high。
- 测试：`DEFAULT_EXPLORER_MODEL` 值、`explorerModelOf` 四用例（空配置回退/覆盖/缺省推理深度/与挑战者默认分离）、Config 默认一致；README 配置表与示例 yaml 增 `explorerModel`；npm test 全绿。

## 0.33.23（feat：知识沉淀断点自愈——宿主在 `agent/created` 时机按 Theseus 真相对齐，自动重建并派发缺失阶段）

- **事故**（session-98182034）：竞技场在 17:36:49 被误关（0.33.21 已修其成因），主控者随后在竞技场关闭状态下完成了 propose.completed 的 record（Theseus 推进到 review），17:38:50 回合结束时宿主因竞技场已关没有派发 review 挑战者——流程停在 review 之前，而主控者被禁创建子代理、无法自救。原恢复路径（重开竞技场 + 发「继续」走 k_init 续跑）依赖用户手动操作。
- **修复（择机创建挑战者）**：新增 `reconcileKnowledgeResume`，挂在 **`agent/created`** 时机（会话被打开/重启挂载即触发）：
  - 读 Theseus 绑定（`openspec/.runtime/sessions/dsh__<sessionId>.json`）与 `openspec/states` 的 currentStage，经纯函数 `knowledgeStageResumeOf` 映射续跑目标（explore/propose → 探索者；**review → 挑战者**；user-readiness-review → 探索者；apply → 注入 apply 回合提示）；
  - 侧文件 **inactive 且已清空**（被误关/中断）→ 自动重建侧文件（active+scene+phase/pending/workflowId）、重装主控者 persona、按阶段完整模板派发（review 即创建挑战者）；
  - 侧文件 **active 且停在对应工作阶段**（重启中断）→ 走既有 `kickResumeChild` 短续跑；
  - 用户**明确关闭**（active=false 但 workflowId/kStage 保留，即 /arena off 路径）→ 不自动重开，尊重开关意图；
  - archive/done/未知 → 不动；30s 节流防重复。
- 测试：`knowledgeStageResumeOf` 九用例（含 review→挑战者、apply→null pending、archive/done 不续跑）；npm test 全绿。

## 0.33.22（refactor：把 0.33.21 的「修订轮在途」泛化为「子代理任务在途」——成因与行为解耦）

- **归因修正**：0.33.21 把 k_gate 里「主控者 send_message 委派给竞技场子代理」统称"修订轮"不准确——同样的信号形态还包括：中断后的 **rerun/续跑**（本次事故的实质）、宿主漏派/派发失败后的**补派**、NEED_QUESTION **答案直传**（主控者替代宿主中继）、report fork 的催办/补充要求、k_verdict 后主控者**直接下发修订指令**、以及用户显式指示的追加任务。行为（留场等结算）只取决于「任务是否已交到子代理手上」，与成因无关。
- **改动**：
  1. 新增纯函数 `hasArenaChildDelegation(events, childIds)`：检测事件段内主控者向竞技场子代理（durable id 集合）发起过 `send_message`——「子代理任务在途」的机械信号；
  2. `planKnowledgeGate` 第 5 参更名 `childTaskInFlight`、stay 理由统一为 `child-task-in-flight`；
  3. 接入点扩到三处：k_gate（原 0.33.21 逻辑，删除内联检测改用共享信号）、**k_verdict**（READY 未确认、NEEDS_REVISION/NOT_READY 未选择时，若任务在途 → stay 留场而非关场）、**k_ask**（主控者已直接回传答案 → 只恢复阶段状态、跳过宿主重复中继，避免探索者收到双份答案）；
  4. 共享信号在 knowledge turn/end 开头一次计算（按 label 缓存的 explorer/challenger id）。
- 测试：`hasArenaChildDelegation` 六用例（命中/非竞技场目标/非 send_message/空 id/不匹配/事件缺失），`planKnowledgeGate` 理由更新；npm test 全绿。

## 0.33.21（fix：k_gate 修订轮「在途」误判——主控者跳过提问直接委派时不再误关竞技场）

- **事故**（session-98182034 17:36:49）：0.33.20 的 stay 只认「当回合的 arena_k_revision 回答」。主控者沿用早前（17:10）的修订授权、**没有当场重问**就 send_message 委派修订轮 → 该回合 turn/end 时宿主读不到任何确认、Theseus 状态也未推进 → 按「未确认且未 record」**关闭竞技场**。随后主控者在竞技场关闭状态下完成了 propose.completed 的 record（Theseus 推进到 review），17:38:50 回合结束时宿主因竞技场已关而没有派发 review 挑战者——流程停在 review、竞技场已关（状态文件 mtime=17:36:49 即为关场时刻）。
- **修复**：`planKnowledgeGate` 增加第 5 参 `revisionInFlight`——k_gate 回合内检测主控者向竞技场子代理（按 label 缓存的 durable id：explorer/challenger）发起过 `send_message` 工具调用，即视为修订轮在途 → stay 留场等待其结算；不依赖主代理「记得提问」。其余决策不变。
- 测试：`planKnowledgeGate` 增两条在途用例（stay 优先于推进判定、无确认也不误关）；npm test 全绿。
- 恢复本次卡点：竞技场已关、Theseus 已到 review——重开知识沉淀竞技场后发「继续」即可：k_init 续跑读 states=review → 宿主直接派发 review 挑战者，无需重跑 explore/propose（工件已齐）。

## 0.33.20（change：knowledge 委派限制从「全禁」改为「只禁创建」——send_message 开放，主控者只能向已存在的子代理委派）

- **动机**：0.33.9/0.33.17 的「subagent / subagent_fork / send_message 全禁」在门控 blocked 时制造了无解死锁——主控者既不能自己修工件（阶段 skill 不由其执行）、又不能派人修（委派全禁），宿主 k_gate 又没有修订轮通道（session-98182034 实证：propose judge 因 design.md 缺失 blocked，用户选「修订轮」后主控者无路可走，流程停在 k_gate）。禁止造成的损失大于它防的「擅自委派」。
- **新规则**：knowledge 场景只禁用**创建新子代理**的工具 `subagent` / `subagent_fork`；`send_message` 开放——主控者只能向**已存在**的探索者/挑战者委派任务（宿主未派发时的补派、门控 blocked 时的修订轮），新副本没有阶段上下文、游离于状态机外，仍被禁止。goal 工具与 /goal 命令维持禁用。
- **配套改动**：
  1. **k_gate 修订轮留场**：新增纯函数 `planKnowledgeGate`——用户同意修订轮（`arena_k_revision` → continue）→ action=stay，保持 k_gate 等待探索者修订结算，既不推进也不按「未确认→关场」误关；其余按 `planKnowledgeAdvance`。
  2. **阶段指示**：三个确认门（explore/propose/apply）的 gateText 均补「judge 未通过 → 说明失败项 → 问 `arena_k_revision` → 同意则 send_message 修订轮指令给探索者（列出失败项+返回协议）→ 等修订结算再重新确认；拒绝 → 关场」。
  3. **提示不再静默**：`steerArenaNote` 增加 inject 回退与日志——steer 不可用/取不到 live 主代理时不再无声丢提示（本次 retry 提示静默丢失的修复）。
- 主控者 persona【分工】与 `DEFAULT_KNOWLEDGE_INSTRUCTION` 同步改写：创建类工具禁用、send_message 开放、只能向已存在的探索者/挑战者委派、续跑复用优先不新建副本、goal 仍禁。
- 测试：persona/指令断言换新语义（9 条），`planKnowledgeGate` 四分支（stay 优先 / 无修订回落原决策 / 拒绝修订关场）；npm test 全绿。

## 0.33.19（feat：断点续跑——「继续」恢复所有子代理工作阶段，不再需要手动关开竞技场）

- **缺口**：宿主进程重启/崩溃会掐断正在运行的**子代理回合**（无结算、无工件），重启后阶段按侧文件恢复为子代理工作阶段（knowledge 的 k_explore / k_propose / k_review / k_readiness，business/qa 的 challenge / verdict），但宿主只响应 `awaiting` 阶段的新消息 → 用户发「继续」被忽略、宿主不重派 → 死锁。实证（session-98182034）：propose 委派 16:28:43 已送达探索者并开工（skill 已加载、spec-meta 已检索），16:32 重启 dsh web 把该回合掐断；之后主代理只能反复简报「等待宿主派发」，16:33 的「继续」无效。
- **修复**：用户消息落在子代理工作阶段（且 `pendingDispatch` 与阶段一致）时，宿主先确认对应子代理**未在运行**，再幂等重派同一阶段：
  - 新增纯函数 `knowledgeChildStageOf`（阶段 → {pending, role}）、`childWorkOf`（active + 阶段/pendingDispatch 一致才算可续跑目标）、`kickResumeText`（**短续跑指令**，自带该阶段返回协议——子代理历史中已有完整委派，不重发整份模板、不污染上下文）；
  - `kickResumeChild`：子代理 live 且 `status==='running'` → 跳过（正常工作中不双发）；durable 子代理存在 → 投递短续跑指令（30s 节流防重复）；子代理从未创建（崩溃落在派发状态写入与 `startContinuable` 之间）→ knowledge 按阶段完整模板重建（与 k_init 续跑一致）、business/qa 走 `dispatchArenaRound` 重建；
  - 主代理交互阶段（k_init / k_gate / k_ask / k_verdict / k_apply / answer / revise / present）**不需要**续跑：用户消息本来就会到达主代理，由其按阶段指示推进（0.33.18 起事件源已修，k_gate 确认提取可靠）。
- 行为变化：knowledge 任一子代理阶段与 business/qa 挑战/终评轮被中断（重启/崩溃/手动停服务）后，在该会话发任意消息（如「继续」）即自动续跑同阶段；正常工作中发消息仍照旧忽略。
- 测试：`knowledgeChildStageOf` 全映射、`childWorkOf`（未开启 / pendingDispatch 不一致 / workflowId 未绑定 / k_gate 不续跑 / business/qa 命中）、`kickResumeText` 各阶段协议行；npm test 全绿。

## 0.33.18（fix：`.session.events` 事件源全面适配 dsh 0.1.2-alpha.4——回答/字段提取此前全部落空）

- **事故**：0.33.15 适配 subagents API 时漏掉另一处破坏性变更——dsh 0.1.2-alpha.4 的 `Session` **不再暴露 `.events`**（只有 `snapshotEvents()` 与公开的 `log`）。lib 里所有 `agent.session?.events` / `resolveMainAgent(...)?.session?.events` 运行时恒为 undefined，宿主机器提取整条失效：
  - knowledge 阶段推进确认门（k_gate）把用户已点的「确认，进入下一阶段」判成「没确认」→ **静默关场、propose 从未派发**（session-98182034 实证：15:38:07 用户点确认、record 已把 Theseus 状态文件推进到 propose，宿主 15:38:16 turn/end 后直接关场；同一会话派发给探索者的「用户原始表述」也显示「（无）」，尽管用户写了完整消息——两处独立读取都取空）；
  - business/qa 的质疑轮/终评轮组装（composeRoundText 四字段）、终评「再来一轮」选择读取同样受影响。
- **修复**：新增 `sessionEventsOf(session)` 统一取事件日志——`snapshotEvents()` 优先（与持久化 jsonl 同源，含 turn/start 全部日志事件），兼容旧 `.events` / `.log`；五处读取点全部替换：`arena_compose` 工具、`readAnotherRoundChoice`（business present）、`dispatchArenaRound`（business/qa 组装）、knowledge turn/end 的 `eventsK`（session/event 处理器直接拿收到的 Session 快照，不再绕 agents 注册表）。
- **锚点与一次多问**：
  - `collectAskAnswerText` 改为返回**窗口内全部**回答文本（数组）——终评 READY「一次问两道」（领导层报告 + 进入 user-readiness）此前只认最后一条工具结果，必丢其一；`parseAdvanceChoice` / `parseKnowledgeChoice` 改为接受单条或数组，按各自固定 id 取用；
  - business 的 `collectAnotherRoundChoice` 锚点与 knowledge 统一为「最后一次 turn/start 之后」（无则回退最后一次结算之后），覆盖挑战者实时消息先到、主代理提问先于 `subagent-settled` 入库的乱序（session-cceff284 同类，session-98182034 再次复现）。
- **k_gate 文件真相兜底（不再静默误关）**：新增纯函数 `planKnowledgeAdvance` 统一推进决策——用户明确「暂停」→ 关场；确认但 record 未生效 → 注入提醒留场重试；确认回答提取不到但 Theseus 状态文件已推进到下一阶段（主控者 persona 只在用户确认后 judge+record，状态文件推进即确认的机器信号）→ **按文件真相派发**；未确认且未 record → 关场并注入**可见**提示（附「重开 + 继续」续跑指引），不再无声关闭。
- 测试：`sessionEventsOf`（snapshotEvents / 旧 .events / .log / 抛错回退）、`collectAskAnswerText` 数组语义、同回合双问条按 id 各取、`parseAdvanceChoice`/`parseKnowledgeChoice` 数组入参、`planKnowledgeAdvance` 五分支、跨回合污染防护保持；npm test 全绿。用真实事故会话日志回放验证：乱序事件 → 提取到确认 → `advance=continue` → `dispatch`。

## 0.33.17（fix：竞技场 v2 模式下真正禁用 goal——0.33.9 的 deny 名单从未生效）

- **事故**：0.33.9 起 `tools.restrict({ deny: ['goal', …] })` 里的 `'goal'` **不是任何已注册工具名**——dsh 0.1.2-alpha.4 的 tool-goal 注册的是 `get_goal` / `create_goal` / `update_goal`。restrict 校验全部名字后才生效，遇到 unknown name 整单抛错 → 被 catch 跳过，**等于从未生效**。实证：知识沉淀主会话（a4eacb32）在竞技场开启窗口内多次 `send_message` / `subagent` 调用全部成功（无 deny 错误）——主控者「不得擅自委派/建 goal」此前全靠提示词约束。
- **修复**（机械两层，均随竞技场开启安装、关闭恢复）：
  1. 工具 deny 改用**真实工具名**：`get_goal` / `create_goal` / `update_goal`（business/qa 同），知识沉淀额外加 `subagent` / `subagent_fork` / `send_message`；restrict **整单失败时逐名重试**，让能命中的名字仍然生效（个别名字缺失的会话不再整体跳过）。
  2. `/goal` 命令影子：竞技场开启期间在主会话作用域注册同名 `goal` 命令，遮蔽预设作用域（tool-both 的 command-goal）——用户键入 `/goal`（含 goal 条 UI 快捷：pause/resume/edit/clear）一律返回固定拒绝文案（`ARENA_GOAL_BLOCK_TEXT`），关闭竞技场随 disposer 恢复原命令。
- 主控者 persona【分工】与 knowledge 指令同步声明：goal 工具（`get_goal` / `create_goal` / `update_goal`）与 `/goal` 命令在竞技场开启期间同样不可用（回合与推进由宿主门控，不由 goal 驱动）。
- 测试：persona / knowledge 指令含 goal 禁用声明；`ARENA_GOAL_BLOCK_TEXT` 导出并断言含禁用提示。

## 0.33.13（fix：mainPersona【流程】step 4 同步——NOT_READY 统一与 READY 执行者约束此前漏改 persona 文本）

- 0.33.11/0.33.12 只改了 handler、k_verdict 阶段指示与 `DEFAULT_KNOWLEDGE_INSTRUCTION`，**漏了 `mainPersona` 自己的【流程】step 4**——设置页（/arena-v2/personas 渲染 mainPersona）里仍是旧文案「NOT_READY → 不再送审…关闭」，与运行行为矛盾。
- 修复：mainPersona【流程】step 4 同步——
  - READY：一次问两道（报告 + 进入 user-readiness，固定 id），两道确认后**只结束回合**，user-readiness 与 requirement-report 由宿主派探索者执行（fork reporter 后台出 PPT），不得亲自加载/执行这两个 skill；
  - NEEDS_REVISION：呈现原文 → 问 `arena_k_revision`；同意 → record NEEDS_REVISION（推回 propose）→ 宿主重派探索者；拒绝 → record NEEDS_REVISION 后关闭；
  - NOT_READY：与 NEEDS_REVISION **同样处理**（原文列出 FAIL 项 → 问是否再来一轮；同意 → record NEEDS_REVISION 推回 propose；拒绝 → record NOT_READY 后关闭）。
- 测试：persona 含「NOT_READY → 与 NEEDS_REVISION 同样处理」，不再含旧版「NOT_READY → 不再送审」。

## 0.33.16（chore：依赖对齐——工作区 @deepseek-ai 软链到宿主 dsh 副本，消除混版本）

- 根因：插件的 `@deepseek-ai/*` import 按 Node 文件路径解析到 `~/Documents/dsh-plugins/node_modules`（8/25 安装的 rc.2 快照），而宿主 dsh 是自包含的 0.1.2-alpha.4（全局安装、与工作区路径不相交）——dsh 升级只更新 host/profile，插件工作区副本无人统一重装 → 混版本（本次仅 dsh-subagent 被显式升到 alpha.4）。
- 修复（方案 A：插件工作区「指向本地 dsh」）：把工作区 `node_modules/@deepseek-ai/{dsh-system-prompt,dsh-llm,dsh-tools,schemastery}` **软链到宿主 dsh 的嵌套副本**（dsh-subagent 已是 alpha.4 不动）；此后 dsh 升级，插件自动跟随宿主版本，永不混版本。
- 连带修复：宿主 0.1.2-alpha.4 的 dsh-system-prompt 已移除 `PERSONA_ORDER`——插件改为本地常量 `PERSONA_ORDER = 0`（等价于 `SECTION_ORDERS.DEPLOYMENT_PERSONA = 0`，旧版值亦为 0），消除指向后必然出现的 import 崩溃。
- 验证：arena-v2 与全部兄弟插件（chat-rollback/command-setting/model-arena/plugin-market/session-export/tool-both）在宿主副本解析下均可加载，smoke 全绿。
- 注意：此后**不要在 dsh-plugins 里对这四个包执行 `npm install`**（会覆盖软链）；dsh 升级后无需任何操作。

## 0.33.15（fix：适配 dsh 0.1.2-alpha.4——subagents API 破坏性变更，自动派发失效）

- **事故**：dsh 升级到 0.1.2-alpha.4 后竞技场 v2 不再自动派发。全量核对发现两处破坏性变更：
  1. `ctx.subagents.followup` **已移除**（替换为 Agent 相邻消息 `sendMessage` 与 host-only `queueHostSubagentPrompt`）——宿主派发的能力检查 `typeof followup !== 'function'` 恒失败 → 每次派发都走「subagents 服务不可用」回退 → 无自动派发；
  2. `ctx.subagents.registerContinuableSetup` **已移除**——固定模型/探索者·挑战者 persona 的创建窗口注入静默失效。
- **修复**：
  - 续聊改用 `queueHostSubagentPrompt`（`@deepseek-ai/dsh-subagent/internal`，符号键 host 队列，保留宿主来源）；服务为远程 face 未实现符号时回退 `sendMessage`（agent-message 归属）。封装为 `queueToChild`。
  - 固定模型 + persona 改为 **创建请求注入**：`startContinuable` 的 `request` 带 `agentOptions`（provider/model/reasoningEffort，spawn provider 支持）与 `persona`（阴影 deployment:persona）——两者随 descriptor 持久化、冷恢复重放，替代被移除的创建窗口钩子。探索者=explorerPrompt、挑战者=challengerPrompt，业务/知识沉淀两条派发链都已切换。
  - 移除 `installModelSelection` / `foldSubagentDescriptor` 依赖与 `subagent/provider-added` 挂载逻辑。
- 其余 API 核对无影响：`session/event`、`agent/created`、`subagent/start`、`agent/disposed`、`tools.restrict`、`commands.register`、`webServer.register`、`createUserMessage`/`BlockAssembler`、`listChildren`（entry: kind/id/mode/label）均保持兼容。
- 遗留风险：`PERSONA_ORDER` 仍在用（workspace 解析的 dsh-system-prompt 0.1.1-rc.2 有导出）；若宿主解析统一到 0.1.2-alpha.4 该常量已移除，届时需改用 `SECTION_ORDERS`。

## 0.33.14（fix：工作区门控下只剩单场景时不再显示场景选择）

- chip：可选场景（allowedScenes）**多于一个**才显示 hover 场景浮层；只剩一个（如非 intranet-aio 只剩 business）时点击 chip 直接开启/关闭，开启后不再自动弹浮层。
- hero：可选场景 ≤1 时整个场景分段控件隐藏（开启即默认场景），不再出现单按钮场景段。
- 纯客户端改动。

## 0.33.13（feat：知识沉淀 / 测试用例场景仅限 intranet-aio 工作区）

- 场景按工作区门控：新增配置 `sceneWorkspace`（scene -> cwd 必须包含的目录子串；'' 或缺失 = 不限），默认 `knowledge: 'intranet-aio'`、`qa: 'intranet-aio'`——**知识沉淀与测试用例仅在 intranet-aio 工作区可见可用**（含其 worktrees 子目录），business 不受限。可整体改配置放开。
- 宿主侧：
  - `/arena-v2/state` 返回 `allowedScenes`（由会话 cwd + sceneWorkspace 计算；cwd 未知只放行业务）；
  - `/arena` 命令显式指定被门控场景且 cwd 不满足 → 拒绝（提示仅限 intranet-aio）；
  - `/arena-v2/state?scene=` 写场景同门控（400）。
- 客户端：chip hover 场景浮层与空白页 hero 场景分段控件按 `allowedScenes` 过滤按钮；当前场景若被隐藏则回落 business。
- 纯函数 `scenesAllowedIn(cwd, gate)` 导出并测试（intranet-aio 命中 / 非命中 / 子目录 / cwd 未知 / 无门控配置）。

## 0.33.12（fix：把方案 A 的执行者边界写死——readiness/PPT 归子代理，主代理不得自跑）

- 确认方案 A 一直在代码里（k_verdict READY → `dispatchKnowledge('explorer','readiness')` + reportNote），从未改过；被改的是**运行行为**——最新会话主代理在 READY 回合抢跑，自己加载并执行了 theseus-user-readiness-review / requirement-report（seq 15395/15397 实证）。原因是提示只写了「拿到回答后结束回合」，没有负向约束。
- 修复（三处负向约束）：
  1. k_verdict READY 阶段指示：拿到回答后**只结束回合，不要执行任何阶段 skill**——user-readiness 与 requirement-report 由宿主派探索者执行（探索者 fork reporter 后台生成 PPT）；不得亲自加载/执行 theseus-user-readiness-review、requirement-report skill、不得自己提问预测题。
  2. 主控者 persona【分工】新增「**阶段 skill 不由你执行**」：theseus-explore/propose/user-readiness-review/review-spec/requirement-report 全部由子代理执行，主控者只做 CLI/record、门控提问、T6 apply。
  3. `DEFAULT_KNOWLEDGE_INSTRUCTION` 第 4 条 READY 段同步。
- 探索者 fork 不受主代理 `tools.restrict` 影响（dsh-agent-presets `composeFrom` 绑定父的 preset 而非父 agent scope，已代码级确认）——方案 A 链路完整可用。
- 测试：persona 含「阶段 skill 不由你执行」「不得亲自加载/执行它们」；指令含禁止自跑两个 skill。

## 0.33.11（feat：竞技场不再区分 NOT_READY 与 NEEDS_REVISION——都走「问用户是否再来一轮修订」）

- 此前 `k_verdict` 对 NOT_READY 直接收尾关闭（workflow 停 review），对 NEEDS_REVISION 问用户是否再来一轮——两者本质都是「探索者要重新修订」，区分没有意义且会误关（如 `event-page-trend-tracker` 的元数据 FAIL 其实可修）。现合并：
  - `k_verdict` 处理器：`not_ready` 与 `needs_revision` 走同一分支——呈现 review.md 原文（NOT_READY 含五维 FAIL 项）→ 问 `arena_k_revision` → 用户选「再来一轮」→ 宿主重新派发探索者 propose（修订轮，读 review.md Action Items / FAIL 项）；选「结束」/ 没问 → 按原 verdict 收尾关闭。
  - 阶段指示：NOT_READY 与 NEEDS_REVISION 提示统一——选「再来一轮」→ 主控者本回合 record review.completed NEEDS_REVISION（把 workflow 从 review 推回 propose）再结束回合；选「结束」→ 按原 verdict record（NOT_READY / NEEDS_REVISION）后总结关闭。
  - `DEFAULT_KNOWLEDGE_INSTRUCTION` 第 4 条与 README 流程图同步。
- 测试：指令含「NOT_READY 与 NEEDS_REVISION 同样处理」「推回 propose」。

## 0.33.10（fix：knowledge 检索源清单补上「历史会话」）

- 用户此前明确要求搜索源包含历史会话；0.33.0 把历史会话从 business 检索指引拆为独立的 `sessionHistoryGuide`（全场景、触发词驱动）时，**knowledge 的 `sceneSearchGuide`（KNOWLEDGE_SEARCH_GUIDE）遗漏了该项**——清单只有 openspec / workflow 运行时 / spec-meta / Jira / 代码库。结果是「最新一轮知识沉淀不翻历史会话」（用户消息无触发词 + 知识检索源清单里没有历史源）。
- 修复：`KNOWLEDGE_SEARCH_GUIDE` 新增第 6 项「历史会话（dsh 会话历史）」——绑定/续跑与准备探索输入时先 session-search 短查询 → `--show` 拉全文 → 素材并入探索输入并交叉验证；引用注明 session id 与日期。至此知识场景的检索源清单与用户预期一致，且不再只依赖触发词。
- 测试：knowledge 指引含「历史会话」「session-search」；原「历史会话不重复出现在 knowledge 指引」断言改为「作为检索源之一出现」。

## 0.33.9（feat：主控者不得擅自委派——prompt 硬性要求 + 主会话机械禁用委派工具）

- **主控者 persona【分工】新增硬性要求**（措辞微调、核心不变）：「**探索者与挑战者均由宿主派发**：执行 Theseus workflow 期间，不得擅自创建子代理（subagent / subagent_fork / send_message 已对你禁用）；任何任务续跑都以已有子代理优先（复用其上下文），不新建副本。」
- **主会话机械禁用**：知识沉淀场景开启时 `tools.restrict` 的 deny 列表从 `['goal']` 扩为 `['goal','subagent','subagent_fork','send_message']`（business/qa 仍只禁 goal），关闭竞技场时恢复。宿主派发走 subagents 服务 API、子代理会话是独立工具作用域，均不受影响——从机制上杜绝主控者「替宿主开子代理 / send_message 插队」的越权路径（此前仅靠提示词约束，实测出现 4 次野子代理 + 1 次补发）。
- **knowledge 指令第 1 条同步**：「subagent / subagent_fork / send_message 工具已对你禁用…任务续跑均以已有代理优先」。
- **收尾提醒补续跑指引**：knowledge 关闭时注入「如需继续：先 /arena knowledge 重开，宿主按 openspec/states 当前阶段自动续跑并复用已有探索者/挑战者——不要自行创建或委派子代理」。
- 测试：主控者 persona 含「均由宿主派发 / 不得擅自创建子代理 / 已有子代理优先」，knowledge 指令含「已对你禁用」。

## 0.33.8（fix：peer 范围切到 alpha 线——跟随 dsh 0.1.2-alpha 通道）

- **peerDependencies 全线切到当前 alpha 线**：`@deepseek-ai/dsh-*`（agent / api-remotes / client-locale / client-ui-conversation / llm / session / subagent / system-prompt / tools）从 `^0.1.1-rc.2`（system-prompt 为 `^0.1.0-rc.7`）改为 `^0.1.2-alpha.4`，`cordis` 从 `^4.0.1` 改为 `^4.0.2`——与 alpha 通道全家桶（`alpha` dist-tag = `0.1.2-alpha.4`，且各包 peer 互相声明 `^0.1.2-alpha.4` / `cordis ^4.0.2`）对齐。
- **为什么可以声明 alpha 范围**：semver 预发布规则下，`^0.1.2-alpha.4` 只匹配同一 `[major,minor,patch]` 元组的预发布，实测匹配 `0.1.2-alpha.4`、不匹配 `0.1.3-alpha`（上游切新元组需再 bump）、不匹配 `0.1.1-rc.2`（旧 rc 宿主）。声明它是"本插件以 0.1.2-alpha 线为开发基线"的**兼容性声明**，不参与安装/运行期强制——安装层仍由 `peerDependenciesMeta.optional` + 插件市场暂存目录 `autoInstallPeers: false` 兜底。
- 维护成本：上游每次切新 alpha 元组（如 `0.1.3-alpha`）都要再 bump 一遍本文件；只跟 rc 线的部署会与本声明不匹配（optional 兜底使其不阻塞安装）。

## 0.33.7（fix：重跑/重启后复用既有可接续子代理，不再新建副本）

- **派发前强制找回既有子代理**：`dispatchKnowledge`（探索者/挑战者）与 `dispatchArenaRound`（business 挑战者）在内存 id 缓存缺失时，先 `resolveSubagent/resolveChallenger(force)` 按 label 枚举 `listChildren` 找回既有可接续子代理——命中则直接 `followup` 续聊（上下文跨轮次保留），只有确实不存在才 `startContinuable` 新建。此前找回是懒异步的（offCreated/offStart/section 注入处 fire-and-forget），重跑/重启后的首次派发可能赶在找回完成前发生 → 误建新副本、丢失旧上下文。
- 与 0.33.6 的续跑路径（k_init 按 states 文件跳阶段）配合：重启后发「继续」→ 阶段恢复 + 同一探索者/挑战者续聊，整条链路确定性成立。

## 0.33.6（fix：推进确认答案提取锚点错位——提问早于结算导致误关竞技场）

- **事故（session-cceff284）**：探索者通过 `subagent-report` 提前报告「explore 阶段完成」，主控者据此在真正的 `subagent-settled`（STAGE_DONE）到达**之前**就问了 `arena_k_advance`；宿主的答案提取 `collectAskAnswerText` 旧锚点是「最后一次 subagent-settled 之后」→ 答案在结算之前 → 提取为空 → `advance === null` → 保守关闭竞技场，propose 从未派发、自然也没有 review 前的确认提问。
- **修复**：`collectAskAnswerText` 锚点改为**当前回合的 `turn/start`**（提问必然发生在结算触发的同一回合内，无论早于/晚于结算消息都能命中；无 turn/start 事件时回退到旧锚点）。跨回合防护不变：只取最后一个 turn/start 之后的提问。
- **护栏**：knowledge 四个「等待中」阶段指示（探索中/提案中/审查中/就绪评审中）追加「即使收到子代理进度报告、或 Theseus 门控显示 ready，也不要提前行动——阶段完成由系统在结算后切换指示」。
- 测试：提问早于结算仍可提取并判定 continue、上一回合提问不计入本回合。

## 0.33.5（chore：工作语言声明收敛到三套 persona）

- knowledge 三套 persona（主控者 / 探索者 / 挑战者）各加一个统一的【工作语言】段：「工作语言用中文（Theseus 约定：对话、评审讨论、就绪面试均属工作语言）；契约工件按 skill 约定用英文，业务硬信息（代码、枚举值、字段名、路径、API 名、spec id）一律保持英文原文不翻译。」
- 其它位置的分散语言约束全部移除：探索者 persona 的题干/工件语言两行、`readinessPrompt` 委派模板的语言句、`DEFAULT_KNOWLEDGE_INSTRUCTION` 末尾的「用中文回答」——语言只在 persona 声明一次，避免重复与漂移。
- 测试：三套 persona 各含【工作语言】段与硬信息不翻译声明；委派模板与 knowledge 指令不再重复语言约束。

## 0.33.4（fix：题干语言改对齐 Theseus 工作语言约定）

- 0.33.3 把预测题题干钉成英文是**钉反方向**：`theseus-workflow-router` 的 Language & Anti-Loss Convention 明确「Working language (conversation, review discussion, **interview**) — free, typically the team's native language (e.g. Chinese)」，就绪面试属工作语言。改回：探索者 persona 与 `readinessPrompt` 规定**题干与选项用中文表述**（对账正文也用中文），题内业务硬信息（代码/枚举/字段名/API 名）保持英文原文不翻译；契约工件英文的约定不变（工件写作本就不受题干语言影响）。原生 Theseus 流程不会把中文提问当问题，语言漂移是竞技场委派/重跑强制重生成时暴露的，本版与原生约定对齐后即消除。
- 测试：persona/readiness 模板含「工作语言」与「保持英文原文」约定。

## 0.33.3（fix：预测题语言漂移 + 问题意图 JSON 答案泄露）

- **问题语言钉死英文**（修复「中断重跑后题干变中文」——实测 9/1 探索者问中文、9/2 新探索者问英文，语言从未被约束，重生成即漂移，属高概率）：探索者 persona 与 `readinessPrompt` 委派模板都规定「问题意图 JSON 的题干与选项一律英文（与 delta spec 一致）；对账正文可用中文；同一轮内语言不得漂移」。
- **问题意图 JSON 禁止答案线索字段**（修复「用户可见正确答案」——实测 9/1 输出 `正确项位置:2`、9/2 输出 `correctIndex:1`+`why`，随 subagent-settled 消息直接显示给用户）：JSON **只允许 question / header / options / multi_select 展示字段**，correctIndex / 正确项位置 / why / 规则 / 答案一律禁止（正确项位置只允许写进 user-readiness.review.md 工件）。`k_ask` 阶段指示与 `DEFAULT_KNOWLEDGE_INSTRUCTION` 第 3 条同步：主控者只照抄展示字段，发现线索字段一律忽略、不得向用户展示。
- 测试：探索者 persona / readiness 模板不含答案线索字段约定、含英文钉死约定、明确禁止 correctIndex。

## 0.33.2（feat：中继问答与对账全文原样转述）

- **子代理的一切问题与答案都由主代理原样转述**：`k_ask` 阶段指示改为两步——① 把结算消息里 NEED_QUESTION JSON 之外的**全部正文（对账、规则揭示、答案正确与否）原文呈现**，需要时**允许用 read 等工具**读 openspec 工件（user-readiness.review.md / review.md / decision-log）逐行引用，禁止改写/摘要；② 再用 JSON 原样 ask_user_question 提问。`DEFAULT_KNOWLEDGE_INSTRUCTION` 第 3 条同步强化。
- **探索者返回协议补充对账契约**：每道题用户作答后（尤其 user-readiness 预测题），先把对账正文（规则揭示、用户答案、**答案是否正确**、差异说明）原文输出在消息前部，再接下一道 NEED_QUESTION 或最终 STAGE_DONE；协议行放消息**最后**。
- **user-readiness 对齐表原文透传**：`k_gate` 的 apply 确认与收尾两条指示都要求主控者读 `openspec/changes/<workflow>/user-readiness.review.md`，把 Requirement Alignment 表（每道题规则、用户答案、✅/❌）**原文逐行转述**后再询问/记录。
- 测试：指令含「一切问题与答案都由你原样转述」「允许用 read 等工具」；探索者 persona 含「答案是否正确」。

## 0.33.1（feat：阶段推进用户确认门 + 子代理结论原文呈现）

- **阶段推进确认门（不自动推进）**：对齐 Theseus router 的「Ask the user before delegating」——`k_gate`（explore→propose / propose→review / readiness→apply）与 `k_verdict` READY→user-readiness 前，主控者必须用固定问题 `arena_k_advance`（选项「确认，进入下一阶段」/「暂停，先不推进」）问用户；宿主用新增的 `parseAdvanceChoice` 从会话事件机器判定——**用户确认才 judge+record 并派发下一阶段；选暂停、或主控者没问（无法判定）→ 一律不推进并关闭竞技场**（Theseus 状态保留，重启后「继续」可续跑）。README 流程图为各 gate 标注确认节点。
- **子代理结论原文呈现**：`k_gate` 与 `k_verdict` 的阶段指示全部要求主控者**原样呈现子代理结算消息 / review.md 的 Overall Verdict 与 Action Items 原文（不摘要、不改写、不省略协议行）**，之后才询问/记录；`DEFAULT_KNOWLEDGE_INSTRUCTION` 第 2/4 条同步（不再说「简报」）。
- `k_verdict` READY 阶段改为**一次问两道**：① `arena_k_report`（生成报告/跳过）② `arena_k_advance`（是否进入 user-readiness）——② 选暂停则关闭竞技场。
- 续跑语义不变：k_init 已绑定时的状态文件续跑**跳过确认门**（用户的「继续」消息即确认）；正常逐阶段推进仍需逐门确认。
- 测试：`parseAdvanceChoice`（固定 id/回落/否定优先/空）、`ARENA_K_ADVANCE_*` 导出、指令含确认门与「原文原样」要求。

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
