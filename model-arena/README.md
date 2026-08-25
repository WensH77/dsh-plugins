# dsh-plugin-model-arena（模型竞技场）

dsh web 模型竞技场插件（挑战模式）：**按场景分流——「知识沉淀」场景走 review 循环（主模型产出结构化方案，挑战者作为审查者给出 `Overall Verdict` READY / NEEDS_REVISION；不认可则修正后终审，循环直到认可或累计 3 次不认可，随后审查循环结束）；「业务探索」「测试用例」场景保持原有挑战流程（模型1 回答 → 模型2 质疑 → 模型1 修正 → 模型2 终评）**。模型2 的输出以用户消息注入主会话原生对话流（竞技场 tab 保持现状，仅作模型2 后台输出）。

- **仅空会话（hero）配置**：空会话时，在「文件夹 + agent 模式」选择旁出现「竞技场」toggle（默认关闭）；开启后出现与输入框同源的两级菜单，选择竞技场模型 + 推理等级（输入框当前模型被排除）；**目录仅两个模型时自动选择另一个**（无需手动选择），并在 composer 切换模型时联动切换（竞技场会话创建后模型冻结）
- **未配置时发送被阻止**：竞技场开启但未选模型时，composer 被平台「会话阻塞」机制禁用（占位符提示先选模型），避免静默退出竞技场变成普通会话；两模型自动模式下目录一解析即就绪、不会被阻塞
- **真实竞技场（v3，tab 形态）**：配置好后发送首条消息 → 创建第二会话（竞技场模型，**与当前会话同一 workspace**，权限跟随当前会话的权限预设）；会话 header 出现原生 **【对话 | 竞技场】** tab（注册 `conversation.view` 槽位，跟随联动状态动态注册/注销），「竞技场」tab 内渲染竞技场模型对话（提示词 + 推理 + 回复 + 工具调用/工具结果/图片，随流式更新）；两个 agent 并行回复；后续每条消息自动镜像到竞技场会话
- 竞技场会话**不出现在侧边栏**（竞争者隐身：`.YDXeBa_title` 精确匹配「竞技场」/「Arena」的列表行 `display:none`，且切换守卫会把任何切入竞技场会话的选择弹回其联动主会话，防止与模型2私聊扰乱上下文）；「竞技场」tab 是竞技场会话的唯一界面；切换会话/关闭竞技场时 tab 与联动一并还原；**归档主会话时联动归档竞技场会话**（订阅 workspaces 列表快照的 archivedSessionIds，检测到主会话新归档即调用 archiveSession 归档其联动会话）

## 变更日志

历次改动见 [CHANGELOG.md](./CHANGELOG.md)。

## 架构

| 文件 | 角色 |
|---|---|
| lib/index.js | Node 端：settings 注册（links + **challenges 持久化** + persona 映射 + workspaceSkills），`system-prompt/assemble` 注入挑战角色（仅 persona 映射中的会话）；知识沉淀场景轮询 `openspec/` 检测 `propose.completed` 并经 `arena.reviewRequest` 回写浏览器端 |
| lib/client.js | 浏览器端：hero toggle + 两级菜单选择 + 两模型自动联动（autoArenaModel）+ 竞技场运行时（镜像、`conversation.view`「竞技场」tab 注册、tab 内渲染）+ review 循环编排（`reviewRequest` 驱动）+ **challenge 持久化与恢复**（persistChallenge、alignChallengeAfterRestore：刷新/重启后按实时快照三态对齐——主模型轮 running/已完成自动推进、真 idle 等「继续」，挑战者轮未回复立即重注入）；纯函数（buildModelOptions、buildEffortChoices、conflictsWithInput、findArenaModel、autoArenaModel、totalModelsOf、textOfContent、assistantRows、buildRoundPrompt、parseReviewVerdict、roundLabelOf、formatToolTrail、toolArgsSummary、buildRoleSeed、buildMainRoleSeed、buildReviseMessage、pathBasename、stripMarkdown、toPersistedChallenge、fromPersistedChallenge、isResumableChallenge、isMainModelPhase、isChallengerPhase、isTerminalPhase、resolveMainResume、resolveChallengerResume）独立导出供测试 |

数据流：

    hero 配置（toggle + 选场景/模型）
      --> 用户首问 --> 创建竞技场会话（同 workspace，不镜像首问）--> 输入框锁定
      --> 场景分流：知识沉淀走 review 循环；业务探索/测试用例走原有挑战流程
      --> [review] 主模型(intranet-aio, workflow) 自动 explore→propose 产出 proposal/design/tasks
             并 record propose.completed → node 半段检测 → 挑战者按注入的挑战者技能读文件审查
             写 review.md（含 Action Items）+ 返回一行 Overall Verdict READY/NEEDS_REVISION
             NEEDS_REVISION → 注入「先 record review.completed NEEDS_REVISION 回到 propose
             → 读 review.md 的 Action Items 改文件 → record propose.completed 重新送审」
             累计 3 次不认可 → 不发消息给主模型，node 半段直接写 Theseus 状态机退回 propose
             （review.completed NEEDS_REVISION），主模型自然停等人工；READY → record review.completed READY，model-arena 放手，主模型继续 readiness→apply
      --> [challenge] 模型1 回答 --> 模型2 质疑（注入）--> 模型1 修正 --> 模型2 终评（注入）
      --> 结束解锁（后续环节由宿主流程接管，本插件不改动）
      --> 每轮 phase 转换经 persistChallenge 写入 settings `challenges`
      --> 断网/刷新/重启 dsh 后恢复：syncArena 载入持久化基线 + alignChallengeAfterRestore
          按实时快照三态对齐——主模型轮 running/已完成自动推进、真 idle 放开输入框等
          「继续」；挑战者轮未回复立即重注入该轮提示词（切竞技场 tab 即触发）；终止态
          （done/aborted）不复活、不重武装 Theseus 桥

## 安装（dsh web profile）

```bash
# 推荐：git 通道安装（公开仓库，HTTPS 拉取；可经「插件市场」检查更新/更新，跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:model-arena'
```

> 手动拷贝安装（`mkdir -p ~/.dsh/profiles/web/node_modules/dsh-plugin-model-arena && cp -R model-arena/. ~/.dsh/profiles/web/node_modules/dsh-plugin-model-arena/`）
> 不产生 git 依赖，插件市场无法更新——已手动安装的用户可在插件市场点「检查更新」→「更新」，一键转为 git 通道安装。

    # ~/.dsh/profiles/web/cordis.patch.yml（顶层数组）：
    - insert:
        - id: model-arena
          name: dsh-plugin-model-arena

    # 重启 dsh web

## 使用

1. 新建/打开一个空会话（hero 视图）
2. 在文件夹、agent 模式选择旁点击「竞技场」toggle（默认关闭）
3. 开启后面板出现场景选择（默认「业务探索」，另有「知识沉淀 / 测试用例」）+**「挑战者技能」**（可选，点开后可用系统文件夹选择器选文件夹，或手动输入文件/文件夹路径；可为空；**按「工作区 × 场景」记忆**——每个场景独立记住自己的 skill，切换场景自动加载该场景的 skill）+「竞技场模型」两级菜单（输入框当前模型不在列表中）；**目录仅两个模型时自动选中另一个**，且在 composer 切换模型时联动切换（竞技场会话创建后冻结）
4. 发送首条消息（你的问题）→ 输入框锁定，按场景分流：
   - **知识沉淀**：主模型产出结构化方案 → 挑战者作为审查者输出 `**Overall Verdict**: READY`（认可）或 `NEEDS_REVISION`（不认可）+ Action Items；不认可 → 审查意见以**用户消息**注入主对话 → 主模型修正 → 挑战者终审，循环直到认可或累计 3 次不认可，随后审查循环结束、解锁输入框（后续环节由宿主流程接管，本插件不改动）
   - **业务探索 / 测试用例**（原有逻辑）：模型1 回答 → 模型2 质疑（用户消息注入）→ 模型1 修正 → 模型2 终评（用户消息收尾）
5. 流程结束解锁输入框，可提新一轮问题

## 测试

    npm test   # = node test/smoke.mjs && node test/client-smoke.mjs

覆盖：hero 开关/菜单/阻塞；两模型自动联动（纯函数 + hero 集成：自动选补集、不阻塞、切换跟随）；竞技场运行时（会话创建、模型选择、open 窗口、提示词镜像、view-ring tab 注册、tab 渲染、问题/审批交互、重入不重发历史、关闭还原）；tab 原生渲染（经 `require` seed 原语加载 MarkdownText/DisclosureRow/复制按钮，而非纯文本兜底 + `.ma-questionOpt` 基础规则回归守卫）；轮次分割线（`roundLabelOf` 关键词判定 + 分割线渲染）；权限预设应用；链接持久化（保存/恢复/卸载）；场景分流（business/knowledge/qa 的 review 标志）；review 循环编排（`reviewRequest` 驱动 propose/revise→review、文件路径传审查、Overall Verdict 解析、不认可计数与 3 次上限、停止/中止、`stopArenaWatch` 清理）；原有挑战流程（业务探索场景 answer→challenge→revise→final）；挑战者技能（选择/清除持久化到工作区×场景、场景切换加载各场景自己的 skill、文件夹选择守卫）；**对抗进度跨断网存活**（`toPersistedChallenge`/`fromPersistedChallenge` 往返与字段白名单/截断、`resolveMainResume`/`resolveChallengerResume` 三态判定、主模型轮 waiting 恢复不锁输入框 + 「继续」不重置进度并推进到挑战者轮、挑战者轮已回复 catch-up 不重复 prompt、未回复恢复时立即注入一次且 sync 不重复、aborted 终止态恢复不复活且不重武装 Theseus 桥）；纯函数（排除规则、模型挂钩等级、文本/块提取、工具/图片行、工具操作记录格式化、审查 prompt 与 challenge/final prompt 判定解析、轮次标签、`buildMainRoleSeed` 停在 propose 约束、`buildReviseMessage` 打回格式、`pathBasename`）。

## 已知限制

- **联动持久化需服务重启**：node 半段 settings 注册加载后，链接才会写入/恢复；重启前链接仅存内存；**v20 的 `challenges` schema 变更同样需重启 dsh web 生效**（重启前持久化走旧 schema，恢复仅靠内存 stateBySession）
- **多浏览器 tab 写冲突**：settings 命名空间共享，`persistChallenge` 为 last-write-wins（恢复以最新 `updatedAt` 为准）；同一竞技场会话建议单 tab 操作
- **重启 dsh 打断进行中 generation**：服务端进程重启后，刷新时正在跑的回合不会继续（会话与节点数据保留），主模型轮走「输入继续」恢复路径；刷新/断网（不重启）时后端回合继续跑、恢复后自动推进
- **推断恢复的边界（v20 修复）**：`inferRestoredChallenge` 仅在「link 存在 + 主会话有首问 + 无 done 信号（link.done / Theseus past review）」时把刷新后的 idle 兜底升级为进行中（propose/answer）；旧版本 aborted 会话（无持久化、无 done 信号）可能短暂恢复 header，由 120s 停滞看门狗兜底中止——优于流程静默；已结束会话（done/aborted 有持久化或 watch past review）不会被推断复活
- **tab 渲染与原生同款（无气泡）**：完整复刻左侧聊天渲染，**按原生语义分组**（user 气泡+时间戳一组、context 独立块、assistant 的 think+工具+正文一组、turn-tail 独立行；块间 gap 16px、块内对齐原生 userStack 8px / asstBlock 16px）——**context 节点**（原生「上下文注入」折叠行：IconBrowseOutline16 图标 + 标题 + **来源 label**（contextSourceLabel：plugin id / skill 名，与原生 contextProvenance 一致）+ 折叠摘要，点击整行/文字展开显示注入内容）、**Think 折叠行**（原生 IconThinkOutline16 图标 + "Think" 标题 + **原生 QWLzlG_separator 分隔符 + 折叠摘要露出**，点击整行展开 thinkBody）、**工具调用折叠行**（原生 IconCodeOutline16 图标 + **原生工具显示名**（TOOL_VARIANTS 映射：run_code→Code 等）+ **分隔符 + 摘要**，点击整行展开**code 值代码块**（原生 deriveBody：code variant 显示 argsRaw.code 实际代码，其他 variant 显示格式化 JSON））、**turn-tail 统计行**（HH:MM · 用时 · 首 token · tok/s）、markdown 正文经平台原生 MarkdownText 渲染；所有折叠行均 `expandOnRowClick`（点击文字即可展开），展开状态跨流式 repaint 保持；**复制按钮与原生一致**：仅 user 消息 + 回合末尾（turn-tail 对应位置）各一个（不在工具步骤/assistant 块内），原生 IconCopyOutline16→IconCheckOutline16 切换 + Tooltip hover 文案；**turn 复制仅含正文 text（不含 thinking/reasoning）**；对话 tab 保持原生时间戳行为（hover 显示）；权限 command 节点隐藏；**编排器注入的轮次提示词（user 节点）渲染为带标签的分割线**（质疑轮/终评轮/审查轮，横贯线 + 居中标签，见 v16）；镜像经 prompt 携带文本（图片附件仅左侧展示）
- **锚点依赖 bundle 结构**：hero 行类锚点为当前 bundle 结构，平台升级可能需调整
- **竞技场模型 ≠ 输入框模型**：hero 选择排除输入框当前模型；若选择发生在目录加载前，创建时会复核并跳过（提示冲突）；**仅两个模型时自动选补集并随输入框切换联动**（`autoArenaModel`），竞技场会话创建后模型冻结（`arenaLocked`），此后 composer 切换不再改竞技场模型
- **镜像略有滞后**：竞技场在消息落地后启动（数百 ms）；两 agent 并行但非严格同时
- **错误重试**：竞技场会话创建/镜像失败时，tab 内显示错误条 + 重试按钮；重试成功自动恢复联动与渲染
