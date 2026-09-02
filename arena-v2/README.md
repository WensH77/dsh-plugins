# dsh-plugin-arena-v2（arena v2）

arena v2：**双入口开启竞技场**——输入栏 "Arena" chip，或**新对话空白页 hero 开关**（模仿 model-arena v1 的 hero toggle：开启后开关右侧**只显示场景分段控件**——业务探索/知识沉淀/测试用例，**无模型选择与 skill**）；也可直接输入 `/arena`。开启后主代理自动创建**可接续子代理**作为**竞技场挑战者**。**多轮对话复用同一个挑战者**：首轮用 `subagent` 创建并拿到 durable 的 `subagentId`，后续轮次用 `send_message` 给同一个 id 续聊——挑战者的上下文跨轮次累积，不会每轮都新开子代理。

**竞技场模式是会话级协作状态**（存于 `~/.dsh/arena-v2` 侧文件，按会话 id，重启后恢复）：未开启时一切照常（预设 persona、无竞技指令）；开启后从**下一条消息**开始竞技。

**挑战者模型固定为 `deepseek-v4-pro` · 推理深度 `max`，与父代理完全解耦**：父代理用什么模型、什么推理深度都不影响挑战者。

**主代理与挑战者分别注入完全不同的 persona**（参考 model-arena 业务探索场景）：主代理被注入「Technical Expert（技术专家）」persona；挑战者被注入「Business Analyst（业务分析师，质疑 + 终评）」persona。两套 persona 互相独立，且都覆盖（阴影）掉预设的 coding-agent persona；未开启竞技场的会话与其它子代理不受影响。

**知识沉淀场景（Theseus workflow 对抗流程）**：与业务探索完全不同——**主控者（主代理）**持 Theseus CLI（`mode/judge/record`）与**全部** `ask_user_question`，**探索者子代理**（`arena-explorer:knowledge`）执行 theseus-explore / theseus-propose / theseus-user-readiness-review（requirement-report 经 subagent_fork 派生 reporter 后台执行），**挑战者子代理**（`arena-challenger:knowledge`）执行 theseus-review-spec、**只写 review.md、只返回 `Done`**。判定一律读文件：review.md 的 `Overall Verdict`（READY → 报告询问 → user-readiness → CLEARED 后主控者 apply；NEEDS_REVISION → 问用户是否再来一轮修订，无轮次上限；NOT_READY → 列出不通过项后直接结束）与 `openspec/states/<id>.json` 的 currentStage（record 生效验证）。两子代理均固定 `deepseek-v4-pro · max`、独立上下文、可接续复用。详见「知识沉淀场景」一节。

**竞技流程（业务探索，结构化回合，宿主驱动）**：开启竞技场后，**回合完全由宿主自动推进**（不依赖主代理自觉）——用户发消息 → 主代理（Technical Expert）作答（歧义先澄清）→ 回合结束 → **宿主**组装**结构化消息**（用户问题、回答正文（不含思维链）、提到的文件、工具操作记录**四字段全部由宿主侧从会话事件机器提取**）→ 宿主创建/复用挑战者 → 挑战者（Business Analyst）逐条质疑 → 结算回传 → 主代理呈现质疑、逐条回应并修正（质疑指出指代未确认时先回问用户）→ 回合结束 → **宿主**组装终评稿续聊挑战者 → 挑战者终评 → 结算回传 → 主代理呈现终评并按结论分支收尾（见下）→ 回合结束 → **宿主关闭竞技场**。多轮对话可接续：始终复用同一个挑战者。

**终评收尾（用户决定是否再来一轮）**：宿主从终评正文机器判定结论（终评模板要求最后单独一行输出 `结论：认可` / `结论：仍存疑`；无标记时回退扫描末尾两行与全文；**无法判定时保守按「仍存疑」**处理，把决定权交回用户）——

- **认可** → 主代理原样呈现终评，再按**【结论输出要求】整理并输出本轮完整结论**（不是概览），结束回合 → 宿主关闭竞技场；
- **仍存疑** → 主代理原样呈现终评，并**必须调用 `ask_user_question`** 询问用户是否再来一轮「修正 → 终评」（问题 id 固定 `arena_another_round`，选项文案固定「再来一轮（修正 + 终评）」/「结束竞技，输出结论」，宿主按此从会话事件机器提取用户选择）：
  - 用户选**再来一轮** → 主代理在**本回合内**针对仍存疑条目完成修正后结束回合 → 宿主再送一次终评轮（可无限次循环，**不计轮次、不设上限**，每轮都由用户决定）；
  - 用户选**结束** / 未按要求询问 / 选择无法判定 → 主代理按【结论输出要求】整理输出完整结论，宿主关闭竞技场。

> `verdictRounds`（侧文件字段）与 `maxVerdictRounds`（配置）作为既有设计**保留但不参与判定**：不记录、不累加、不设上限。

## 工作方式

1. **入口（客户端）**：`lib/client.js` 提供两个开关入口，状态互通——
   - **输入栏 chip**：注册进输入栏的 `conversation.input.left` 列表槽（与其它入口共存）。样式与 command-setting 的 plan 开关一致（带边框胶囊，开启态 business 高亮）。**会话无挑战者**时，hover / 键盘聚焦展开场景分段控件（同空对话态控件），点场景即以该场景开启（`/arena <scene>`）；点 chip 本体以默认场景（business）开启；**会话已有挑战者**时场景锁定——chip 是普通开关（点击 `/arena` 用原场景开启、`/arena off` 关闭），不显示场景选择。开启后高亮显示，再次点击执行 `/arena off`。
   - **空白页 hero 开关**：新对话空白页（hero workspace row，锚点与 model-arena v1 同款）DOM 注入 "Arena" pill（样式模仿 v1 的 hero toggle）。**开启后开关右侧只显示场景分段控件：业务探索 / 知识沉淀 / 测试用例——不做模型选择、不做 skill**（空白页会话无挑战者，场景可选）。开关与场景经 `/arena-v2/state` 路由读写宿主侧文件（`?scene=` 保存场景）；与 chip 状态互通（任一入口切换/改场景后经 `arenaBus` 通知双方重新拉取），刷新页面 / 切换会话不丢。
   - 也可以直接在输入框输入 `/arena`（支持 `off` / `business` / `knowledge` / `qa` 参数）。
2. **竞技场模式（宿主侧）**：`/arena` 命令把模式状态（含场景）写入 `~/.dsh/arena-v2` 侧文件（按会话 id），并同步主代理 persona 的安装/卸载。**参数**：`/arena off` 关闭；`/arena business|knowledge|qa` 指定场景开启（首词是场景键则作场景，其余为消息）；无场景键时整段为消息，场景按会话原场景解析（默认 business）。**场景锁定**：会话已有挑战者时不允许切换场景（命令与路由均拒绝）。**开关态可恢复**：chip / hero 开关挂载或切换会话时 fetch `/arena-v2/state?session=<id>`（宿主 web 路由，与 command-setting 同款）从侧文件读回开关态、场景与挑战者存在性——刷新页面不丢。
3. **与预设无关**：竞技只由开关状态（chip 或空白页 hero 开关）决定。挑战者由**宿主**用 `subagents.startContinuable` 创建（provider 默认 `spawn`，可用配置 `subagentProvider` 覆盖）——不依赖主代理调用 subagent 工具；预设只须提供 delegation 后端（standard / PTC / BOTH / cordis 等均可）。**宿主驱动的前提**：会话有可用的 subagent 服务；指令注入前仍按会话作用域检查 `subagent` 工具存在，没有（如 minimal）就跳过，不会进入无法创建挑战者的坏状态。
4. **双 persona（宿主侧）**：persona 是命名槽 `deployment:persona`，最近作用域注册的段落覆盖外层——
   - **主代理**：竞技场模式开启时在目标会话自己的作用域（`agent.ctx`）注册 `mainPersona`（默认「Technical Expert」）；`/arena off` 或会话销毁时卸载；`''` 则保留预设。重启后由 `agent/created` 按 `~/.dsh/arena-v2` 侧文件恢复安装；
   - **挑战者**：`registerContinuableSetup` 贡献里在子代理自己的作用域（`childCtx`）注册 `challengerPrompt`（默认「Business Analyst」）作为挑战者系统 persona——挑战者只在竞技场开启后创建，创建时即注入。
5. **宿主驱动回合（宿主侧）**：`session/event` 订阅驱动状态机（phase 持久化在侧文件）——
   - 用户消息（`user/message`）且空闲（phase=awaiting）→ phase=answer（主代理作答）；
   - 主代理回合结束（`turn/end`，phase=answer）→ **宿主** `composeRoundText` 机器提取四字段组装质疑轮 → `startContinuable`（首轮）/ `followup`（复用）派发 → phase=challenge；
   - 挑战者结算 → 父会话自动收到 `subagent-settled` 消息（phase=challenge）→ phase=revise（主代理呈现质疑并修正）；
   - 主代理回合结束（`turn/end`，phase=revise）→ **宿主**组装终评轮 → `followup` → phase=verdict；
   - 终评结算回传（phase=verdict）→ 宿主 `parseVerdictOutcome` 机器判定结论（`approved` / `disputed`，无法判定保守按 `disputed`）→ phase=present（主代理呈现终评）；
   - 主代理回合结束（`turn/end`，phase=present）→ 结论为 `disputed` 且 `collectAnotherRoundChoice` 从会话事件读到用户选了「再来一轮」→ 回到 phase=verdict 再派发一次终评；否则（认可 / 用户拒绝 / 没问 / 无法判定）→ **宿主**关闭竞技场。
   系统提示按 phase 注入「当前竞技阶段」指示（作答/质疑中/修正/终评中/终评呈现），主代理只负责当前阶段的动作；**派发失败（如 provider 未注册）时回退 awaiting，下一条消息可重试**。phase 与 pendingDispatch 持久化，重启后按状态恢复推进。
6. **竞技工具按会话注册（宿主侧）**：`arena_compose` / `arena_finish` **不全局注册**，而是随竞技场开启注册到该会话作用域（`agent.ctx.tools`）、关闭即卸载（宿主驱动下主代理默认不再调用它们，仅作兼容保留）。同时**竞技场模式下禁用 `goal` 工具**（`tools.restrict({ deny: ['goal'] })`，关闭即恢复）——防止主代理经 goal 绕过竞技场门控。
8. **竞技场子代理固定模型（宿主侧）**：插件用 `ctx.subagents.registerContinuableSetup` 在子代理的创建窗口（新建与冷恢复都会走）里，按 label（`arena-challenger:<scene>` / `arena-explorer:<scene>`）识别竞技场子代理并安装固定的模型选择（`installModelSelection`，与 api-proxy 给 Web 会话固定模型是同一机制）。它在 `agent/request` 瀑布里把子代理每次请求的 `provider` / `model` / `reasoningEffort` 覆盖为固定值——不依赖继承父代理路由，父代理完全自由；同父会话的其它子代理、其它会话的子代理也不受影响。
9. **挑战者与主代理上下文隔离**：挑战者是**独立会话**（`Session.create` 全新日志，父代理历史不进入）；系统提示 = 同一 preset 组成 + 挑战者 persona（`deployment:persona`，子作用域阴影覆盖 preset persona）+ subagent 上下文。**主代理的运行时注册不泄漏**：主 persona 注册在主代理自己的 `agent.ctx`、自动竞技指令 section 显式排除子代理会话（`origin === 'subagent'` 返回空）、arena_compose/arena_finish 工具注册在主代理 `ctx.tools`。挑战者只收到**组装好的回合消息**（用户问题 + 主代理回答正文 + 提到的文件 + 工具摘要，不含思考/推理与完整工具结果）与同工作区上下文（读文件所需）；组装文本中的 `dsh-session:` 会话引用会被中和（全角冒号）——既防止 session-reference 预处理器对截断 URI 抛错，也防止挑战者解引用主会话上下文。
10. **挑战者 id 追踪（宿主侧）**：宿主派发时自己记录 (会话, 场景) → 挑战者 id；另监听 `subagent/start` 并用 `ctx.subagents.listChildren` 按 label（`arena-challenger:<scene>`）找回，供重启/冷恢复对齐。

### 场景与挑战者（按场景复用/新建）

场景键：**业务探索 / 知识沉淀 / 测试用例**（`business` / `knowledge` / `qa`，存于 `~/.dsh/arena-v2` 侧文件）。子代理身份**携带场景与角色**（label = `arena-challenger:<scene>` / `arena-explorer:<scene>`，旧版无后缀挑战者视为 business）：

- **会话已有竞技场子代理** → 场景锁定（原场景）：任何入口（chip / hero / 命令 / 路由）都不允许切换场景，开启即复用该场景子代理；
- **会话无子代理** → 开启时选择场景（chip hover 展开 / hero 常显 / `/arena <scene>`），首条消息创建该场景子代理；此后场景锁定，同一场景的子代理跨轮次、跨开关复用（`followup` 接续）；
- **knowledge 场景两个子代理**：探索者 `arena-explorer:knowledge` + 挑战者 `arena-challenger:knowledge`，各自独立上下文、都固定 deepseek-v4-pro · max。

business/qa 沿用质疑-修正-终评双回合；knowledge 走 Theseus workflow 对抗流程（见下）。

**多源检索指引（`sceneSearchGuide`）**：向主代理注入「回答前主动检索的知识源」策略——**business**：Jira / git / openspec / 代码库交叉验证并注明来源；**knowledge**：Theseus 知识源（`openspec/specs/**`、`openspec/changes/**`、`openspec/drafts/**`、`openspec/states/`、`scripts/spec-meta.ts`、Jira、explore-master worktree）——**与工作区 theseus 技能对齐**：按 frontmatter 真实状态词汇判定可信度（`status: active` 可采信 / `status: draft` 先对代码验证，与 `theseus-retrieve-specs` 的 Trust Handling 一致）、spec-meta 用 `node "$(git rev-parse --show-toplevel)/scripts/spec-meta.ts"` 调用、explore-master 标注只读基线且 **apply 写代码走 feature worktree**、末尾声明「冲突时以工作区 SKILL.md 为准」；qa 默认不注入。可按场景在 `sceneSearchGuide` 里覆盖或置空（空 = 该场景不注入）。

**历史会话检索指引（`sessionHistoryGuide`）**：与场景检索指引并列的独立段落，**全场景共用、只注入主代理**（挑战者/探索者是独立会话，回捞父会话历史既无意义又会污染对抗，故不注入）。**能力式条件**：正文以「若你具备检索本地 dsh 历史会话的能力（例如技能列表中有 `session-search` 或其它等价技能/工具）…」开头——没有该能力的部署整段自然失效，宿主不做技能探测。触发场景（用户提到当前会话之外的过往内容 / 复用本会话没有出处的结论 / 质疑里出现「这个之前定过」类争议）、用法（短查询定位候选 → 拉完整上下文 → 再作答，引用注明 session id 与日期）与边界（字面子串匹配、**搜不到不等于没发生过**、当前会话内的内容直接回看上文）都写在指引里。`''` = 不注入。

### 知识沉淀场景（Theseus workflow 对抗流程）

主控者（主代理）持 Theseus CLI 与全部 ask_user_question；探索者子代理执行阶段 skill 并产出工件（**除 review.md 与 Theseus 运行时外的一切工件**）；挑战者子代理执行 theseus-review-spec，**只写 review.md、只返回 `Done`**。判定一律读文件，不依赖子代理自述。宿主阶段机（phase 持久化侧文件）：

```
用户消息 → k_init（主控者绑定 workflow + judge；已绑定则按 states 文件续跑对应阶段）
  → k_explore（探索者 theseus-explore）→ 结算：
       STAGE_DONE explore CONFIRMED → k_gate（主控者**原样呈现结算原文** + 问用户是否进入下一阶段（arena_k_advance）；确认后 judge+record，宿主验证 states=propose；暂停/未问 → 关闭竞技场）
       NEED_QUESTION <JSON> → k_ask（主控者 ask_user_question，宿主回传答案 → 回到原阶段）
       BLOCKED <原因> → 告警回等待态
  → k_propose（探索者 theseus-propose，Metadata Interview 经 NEED_QUESTION 中继）
  → k_gate（原样呈现结算原文 + 问用户确认进入 review；确认后 record propose.completed，宿主验证 states=review）
  → k_review（挑战者 theseus-review-spec 写 review.md，返回 Done）
  → k_verdict（主控者读 review.md Overall Verdict，**原文呈现 verdict / Action Items**）：
       READY          → 一次问两道：是否生成领导层报告（arena_k_report）+ 是否进入 user-readiness（arena_k_advance）
                         → k_readiness（探索者 user-readiness-review；生成报告时先 fork reporter 后台执行）
                         → CLEARED → k_gate（原样呈现 + 确认进入 apply）→ k_apply（主控者 theseus-apply-change，worktree 实现 + 测试报告）
                           NOT_CLEARED / NEEDS_REVISION → 主控者原样呈现 + 总结后关闭
       NEEDS_REVISION → 问用户是否再来一轮修订（arena_k_revision）
                        同意 → 重新 k_propose（读 review.md Action Items）→ 再送审（无轮次上限）
                        拒绝 → 主控者总结 + record NEEDS_REVISION → 关闭
       NOT_READY      → 主控者原文逐条列出五维 FAIL 项 / Action Items / 未完成 Anchor Trace，
                        record NOT_READY → 关闭（workflow 停在 review 待人工处理）
关闭 → 注入收尾提醒：T7 worktree-commit-push / T8 openspec-impl-doc / T9 theseus-archive-change 需用户明确指示
```

- **阶段推进确认门（不自动推进）**：每个阶段完成后，主控者必须**原样呈现子代理结算消息/结论原文（不摘要、不改写）**，并用固定问题 `arena_k_advance` 问用户是否进入下一阶段（propose / review / user-readiness / apply）；用户选「暂停，先不推进」或主控者没问 → 宿主**不推进**并关闭竞技场（Theseus 状态保留，可续跑）。只有用户确认后才 judge+record、宿主验证后派发下一阶段。
- **绑定**：knowledge 场景假定工作区已装 dsh-plugin-theseus；主控者 `k_init` 回合结束时宿主读 `openspec/.runtime/sessions/dsh__<sessionId>.json` 取 workflow id，未绑定则告警回等待态。
- **record 生效验证**：每个 k_gate 回合结束后宿主读 `openspec/states/<workflowId>.json` 的 currentStage 必须推进到预期阶段，否则注入提醒留场重试——子代理不碰 CLI，record 只属于主控者。
- **探索者返回协议**：`STAGE_DONE <stage> <result>` / `NEED_QUESTION <问题JSON>` / `BLOCKED <原因>`（一行，宿主机器解析；无法解析保守回等待态）。问题 JSON **只含 question / header / options / multi_select 展示字段**（禁止 correctIndex / 正确项位置 / why 等答案线索）。语言由三套 persona 的【工作语言】段统一声明（工作语言中文、契约工件英文、业务硬信息不翻译），委派模板与指令不再重复。
- **派发失败 / 中断**：派发失败注入告警回等待态可重试；子代理中断按产物已满足的 gate 幂等重放（阶段 skill 产物落盘、覆盖式写）。
- **file ownership**：探索者禁写 review.md、`openspec/states/`、`openspec/.runtime/`；挑战者只写 review.md；主控者只经 CLI 变更运行时状态（k_apply 在 worktree 写代码）。

## 配置（settings.yaml 命名空间 `arena-v2`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `challengerModel.provider` | `deepseek-official` | 竞技场子代理（挑战者/探索者）固定模型提供方 |
| `challengerModel.model` | `deepseek-v4-pro` | 竞技场子代理固定模型 |
| `challengerModel.reasoningEffort` | `max` | 竞技场子代理固定推理深度 |
| `mainPersona` | 见 lib/index.js | 主代理 persona（`''` = 保留预设 persona） |
| `challengerPrompt` | 见 lib/index.js | 挑战者 persona（作为挑战者的系统 persona 注入） |
| `challengePrompt` | 见 lib/index.js | 质疑轮模板（占位符 `{question}`/`{answer}`/`{files}`/`{tools}`） |
| `verdictPrompt` | 见 lib/index.js | 终评轮模板（占位符 `{answer}`/`{files}`/`{tools}`；要求最后单独一行输出 `结论：认可`/`结论：仍存疑` 供宿主判定） |
| `conclusionPrompt` | 见 lib/index.js | 收尾时的【结论输出要求】（终评认可 / 用户拒绝再来一轮时注入，要求整理完整结论而非概览；`''` = 不注入） |
| `maxVerdictRounds` | `3` | **保留但不参与判定**：终评轮不记录、不累加、不设上限，是否再来一轮由用户逐轮决定 |
| `sceneSearchGuide` | 见 lib/index.js | 按场景注入主代理的检索指引（`scene -> 文本`，空 = 不注入；business 多源检索，knowledge Theseus 知识源，qa 空） |
| `sessionHistoryGuide` | 见 lib/index.js | 历史会话检索指引：全场景共用、**只注入主代理**（子代理不注入），能力式条件（有 `session-search` 等能力才生效）；`''` = 不注入 |
| `scenePersonas` | `{}` | 各场景 persona 覆盖：`{ business|knowledge|qa: { mainPersona?, challengerPrompt?, challengePrompt?, verdictPrompt?, explorerPrompt?, explorePrompt?, proposePrompt?, reviewPrompt?, readinessPrompt?, reportPrompt? } }`，缺省回落场景默认/顶层（business）值；knowledge 后六字段为探索者 persona 与阶段委派模板 |
| `knowledgeInstruction` | 见 lib/index.js | knowledge 场景注入主代理的自动竞技指令（Theseus 对抗流程，主控者视角；占位符 `{workflowId}`/`{explorePrompt}`/…） |
| `subagentProvider` | `spawn` | 宿主创建竞技场子代理使用的 provider（对应预设 delegation 组的 subagent provider） |
| `intent.enabled` | `true` | 是否启用 flash 意图识别（false = 始终按 need_answer 进入竞技） |
| `intent.provider` | `deepseek-official` | 意图模型 provider |
| `intent.model` | `deepseek-v4-flash` | 意图模型（flash 轻量、关思考） |
| `intent.reasoningEffort` | `off` | 意图判定关闭思考（模型不支持时自动省略） |
| `intent.timeoutMs` | `3000` | 意图判定超时（超时/失败保守放行 need_answer） |
| `intent.maxTokens` | `16` | 意图判定输出上限 |
| `instruction` | 见 lib/index.js | 注入的自动竞技指令文本（兼容 `{challengerPrompt}`/`{challengePrompt}`/`{verdictPrompt}` 占位符） |

> 与预设无关：不再有 `targetPresets`——**只看开关是否开启（chip 或空白页 hero 开关）**。竞技指令与主代理 persona 仅在竞技场模式开启的顶层会话注入；会话工具目录里没有 `subagent` 工具时（如 minimal 预设）自动跳过，不会进入无法创建挑战者的坏状态。

示例：

```yaml
arena-v2:
  enabled: true
  challengerModel:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
  mainPersona: |
    [arena-v2 host]
    你是 Technical Expert（技术专家），竞技场主答者。

    【答题时】
    1. 先回答用户问题。
    2. 用户问题含指代性口语词或多义术语时，必须先 ask_user_question 向用户澄清指代，再回答；调查只用于列出候选与依据，不替代澄清；不臆测、不先给结论再补问、不把「存在多个候选」当作最终答案。

    【面对质疑时】
    1. 收到挑战者的逐条质疑后，逐条修正你的回答。
    2. 不必全盘接受质疑，不认可的条目用 ask_user_question 提出异议。

    【执行边界】
    竞技场流程只做调查、评审、给出结论，不执行任何代码/文档修改（不写文件、不 edit、不改配置）。
    挑战者的「认可」只是评审结论，不是用户授权；代码/文档修改必须等待用户明确指示后再执行。

    用中文回答，禁止辩论。
  challengerPrompt: |
    [arena-v2 challenger]
    你是 Business Analyst（业务分析师），身份高于 Technical Expert。接下来的挑战流程中，你将负责用中文质疑并给出终评。禁止辩论，只按指示输出。
  challengePrompt: |
    [质疑轮]
    用户问题：「{question}」
    Technical Expert的回答：「{answer}」
    提到的文件：「{files}」
    Technical Expert 的工具操作记录：
    「{tools}」

    请用中文对上述回答**逐条质疑**：逐点审查回答中的每个观点、结论与依据，指出问题或漏洞；禁止辩论，只输出你的质疑（直接以质疑者口吻表达，不要自我称呼角色名）。
  verdictPrompt: |
    [终评轮]
    Technical Expert修正后的回答：「{answer}」
    提到的文件：「{files}」
    Technical Expert 的工具操作记录：
    「{tools}」

    修正已完成。请先**逐条核对**你上一轮提出的质疑是否在修正后的回答中被逐一回应：逐点对照每条质疑，确认已被解决或指出仍未解决的项；然后仅给出最终评审结论（认可或仍存疑）。禁止辩论，只输出你的结论，不要提出新的质疑。
    **最后单独一行**输出结论标记（供系统判定，不要加其它文字）：`结论：认可` 或 `结论：仍存疑`。
```

> 注意：挑战者 label = `arena-challenger:<scene>`（`subagent` 工具的 `description` 参数，场景由宿主按会话注入）。插件按场景 label 找回挑战者 id、安装固定模型并注入挑战者 persona；若自定义 `instruction` 里改了 description 或去掉了 `{challengerLabel}` 占位符，宿主侧的 id 找回、固定模型与 persona 注入都会失配（挑战者会退回继承父代理路由与预设 persona，仍可工作）。

## 安装

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:arena-v2'
```

手动拷贝安装：`mkdir -p ~/.dsh/profiles/web/node_modules/dsh-plugin-arena-v2 && cp -R arena-v2/. ~/.dsh/profiles/web/node_modules/dsh-plugin-arena-v2/`

cordis.patch.yml（顶层数组）：

```yaml
- insert:
    - id: arena-v2
      name: dsh-plugin-arena-v2
```

重启 dsh web 生效。

## 使用

**业务探索 / 测试用例：**

1. 任意预设（standard / PTC / BOTH / …都行，只要预设带 `subagent` 工具；minimal 不适用）——父代理用什么模型都行，挑战者固定 deepseek-v4-pro · max
2. 开启竞技场（未开启时一切照常）：
   - **空白页**：点击 "Arena" hero 开关，开启后其右侧显示场景分段控件（业务探索/知识沉淀/测试用例），点场景即开启；
   - **已有记录的会话**：hover 输入栏 "Arena" chip 展开场景段选场景开启，或直接点 chip 本体以默认场景（business）开启；**若该会话已有挑战者，场景锁定**——chip 是普通开关，直接点按原场景开启；
   - 或输入 `/arena`（支持 `/arena business|knowledge|qa` 指定场景）。
3. 发送业务问题——主代理（Technical Expert）先直接回答，再调用 `arena_compose` 工具（四字段机器提取）组装结构化消息创建该场景挑战者 `arena-challenger:<scene>`（创建即注入 Business Analyst persona）
4. 挑战者逐条质疑 → 主代理原样呈现质疑，逐条回应并修正回答（不认可的可用 ask_user_question 提出）→ 按【终评轮模板】再送挑战者终评 → 呈现终评：**认可**则整理并输出本轮完整结论后关闭；**仍存疑**则用 ask_user_question 问你要不要再来一轮「修正 → 终评」——同意就再跑一轮（不限次数），拒绝则整理输出完整结论并关闭
5. 继续发送内容：主代理用 `send_message` 复用**同一场景的同一个挑战者**，每轮「质疑轮 → 修正 → 终评轮」可接续；关闭后再次开启（原场景）仍复用
6. 结束竞技：再点 chip / hero 开关或输入 `/arena off`——主代理 persona 与竞技指令随之卸载（挑战者保留）

**知识沉淀（Theseus workflow 对抗流程）：**

1. 在 intranet-aio 等工作区（已装 dsh-plugin-theseus、openspec 就位）开新会话，`/arena knowledge` 开启（空白页 hero 选「知识沉淀」同理）；
2. 发送主题（或 `/theseus on --init <主题>` 先绑定已有 workflow）——主控者绑定/判定门控后，宿主自动派发**探索者**执行 explore → propose（Metadata Interview 问题由主控者代问）；
3. 探索者完成 propose 后宿主自动派发**挑战者**执行 theseus-review-spec（写 review.md，返回 Done），主控者按 review.md 结论分支：
   - READY → 问你「生成领导层报告？」→ 探索者 fork reporter 后台出 PPT + 继续 user-readiness（预测题逐道经主控者代问）→ CLEARED 后**主控者自己执行 apply**（worktree 实现 + 测试报告）；
   - NEEDS_REVISION → 问你「再来一轮修订？」——同意就重新 propose 再送审（不限次数），拒绝则总结关闭；
   - NOT_READY → 列出五维 FAIL 项 / Action Items / 未完成 Anchor Trace 后关闭（workflow 停在 review）。
4. 结束时会列出后续步骤：T7 worktree-commit-push、T8 openspec-impl-doc、T9 theseus-archive-change——按你明确指示执行，不自动 commit/push/archive。
5. **中断/重启续跑**：会话焦点已绑定 workflow 时，重开会话发任意消息（如「继续」）即可——宿主读 `openspec/states/<id>.json` 的 currentStage 自动跳到对应阶段（propose/review/user-readiness-review/apply）续跑，跳过已完成阶段、不重跑 explore、不重复 record；workflow 已 `archive/done` 则直接收尾。续跑消息本身即视为用户确认（不再逐阶段询问）；正常推进中每阶段仍须用户确认后才进入下一阶段。

## 测试

```bash
npm test   # node test/smoke.mjs
```

## 已知限制

- **执行边界（安全）**：竞技场流程只做调查/评审/结论，不执行代码/文档修改——主代理 persona 含【执行边界】（认可 ≠ 用户授权），且关闭竞技场时宿主会向主代理注入一条执行边界提醒；修改必须等用户明确指示（当前会话审批已禁用，无宿主弹窗兜底，靠指令约束）
- **宿主驱动**：回合（组装/创建挑战者/派发质疑·终评/关闭）由宿主自动推进，不依赖主代理自觉；主代理只负责作答/修正/呈现/收尾结论（按「竞技阶段」指示行事）。仍依赖：主代理按阶段指示结束回合（`turn/end` 触发派发）——若某回合主代理长时间不结束，回合不推进
- **终评仍存疑的续轮依赖提问格式**：宿主从 `ask_user_question` 的工具结果里机器提取用户选择（认固定问题 id `arena_another_round` 与固定选项文案，也兼容含「继续/同意」「结束/不继续」等词的自定义回答）；主代理若没问、或选择无法判定，宿主一律按「结束」收尾关闭——不会卡在 present 阶段
- 挑战者创建走 `subagents.startContinuable`（provider 默认 `spawn`，配置 `subagentProvider` 可覆盖）；若该 provider 未在宿主注册，派发失败会回退等待态（日志可见），下一条消息可重试
- 竞技场模式是会话级状态（`~/.dsh/arena-v2` 侧文件）：`/arena` 切换立即落盘，下一条消息起生效；chip 挂载时经 `/arena-v2/state` 路由恢复开关态，刷新页面不丢（样式与 command-setting 的 plan 开关一致）
- 挑战者 id 的宿主侧追踪、固定模型与 persona 注入都按场景 label（`arena-challenger:<scene>` / `arena-explorer:<scene>`）识别；同父会话的其它子代理不会污染提示里的 id，也不会被装上固定模型/竞技场 persona
- **知识沉淀场景**：依赖工作区已装 dsh-plugin-theseus（绑定/门控/record 均由主控者经 Theseus CLI 执行，宿主只读文件验证）；主控者若未绑定 workflow（k_init 结束未产出绑定）会告警回等待态；主控者 record 未生效（states 未推进）会注入提醒留场重试；探索者返回不可解析、review.md 缺失或 Overall Verdict 不可判定时保守处理（回等待态 / 按 NOT_READY 关闭）；探索者/挑战者 persona 只是职责契约，阶段 skill 的细节仍以 intranet-aio 的 SKILL.md 为准（skill 调整不影响 persona）
- 主代理 persona（`mainPersona`）与挑战者 persona 在各自作用域阴影覆盖预设 persona；未开启竞技场的会话与其它子代理保留预设 persona
- 挑战者固定模型在创建/冷恢复时安装；若配置里改了 `challengerModel`，已存在的挑战者会话要等下次冷恢复才生效
- 与预设无关，只看开关：竞技指令与主代理 persona 仅在竞技场模式开启（chip 或空白页 hero 开关）的顶层会话注入；会话没有 `subagent` 工具（如 minimal）时自动跳过；子代理会话本身不会注入（避免递归竞技）
- 场景锁定：会话已有挑战者后不允许切换场景（chip/hero 不显示场景选择，`/arena <scene>` 与 `?scene=` 写场景均拒绝）；挑战者身份按场景 label 区分，三场景各有默认 persona（business=Technical Expert/Business Analyst，知识沉淀=Knowledge Expert/审查者，测试用例=QA Expert/用户验收），`scenePersonas` 可逐字段覆盖；设置 →「竞技场」卡片可查看三场景全部 persona
- 若同时安装 model-arena v1，hero workspace row 会并排出现两个 "Arena" pill（v1 的 `.ma-toggle` 与本插件的 `.ra2-toggle`），互不干扰、各自独立
