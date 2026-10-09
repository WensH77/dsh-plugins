# 变更日志

## 0.3.0

- 记录与删除都改为**先问用户**：出现「不记就会忘」的事、或清单里某条看起来已办结时，先用
  `ask_user_question` 问要不要记 / 要不要删，得到肯定答复才动 TODO.md。用户跳过某一问或到点没答
  （pending）一律按「不记、不删」处理，下一次向用户开口时说明「这条还没记 / 还没删」。用户已在对话里
  明说要记、要删的不重复问，说过「别问了」「你自己看着办」的本次会话免问、按铁律自己办（这条授权同时
  解开「铁律说删除要用户确认」的死结）；一轮最多一次 ask，多条问题放进同一个 `questions` 数组，记录侧
  的问题 id 因此补了序号槽位（`todo_record_<工作区>-1`、`-2`…）。原铁律「办结即删除」相应改为
  「办结的条目**经用户确认后**删除」。
- 触发器写进**常驻文本**（`lib/convention.js`）而不是只留在技能里：技能要模型主动加载才生效，
  而「发现值得记的事就提问」得每轮都成立。防唠叨的守卫（一轮最多一次、答过「不记」「先留着」的不再提）
  与跳过后要回报的义务同样常驻——只写进技能的话，不加载技能的会话会每轮重问、跳过的事静默消失。
  免问授权那句「这种授权即视为已经点头」也放在常驻：常驻自己不能一边说「自己办」一边留着
  「删除须用户确认」不做解释。优先级也写在常驻：已被明确拒过的条目不被后来的概括授权翻案，
  「授权自办」与「没有工具/被宿主拒绝」同时成立时以授权为准。常驻文本同时带上提问走不通时的替代动作——被委派的子代理
  手里其实**有** `ask_user_question`，卡在宿主运行期拒绝（`DELEGATED_CALLER`：被另一个活代理托管时
  不能和用户交互，见 `dsh-user-questions` 的 `assertLiveRoot`），所以条件是「被拒绝或没有工具」而不是
  「没有工具」；这段文本也注入子代理（`lib/index.js` 对每个 `agent/created` 都挂）。
- 技能（`skill/todo-memory/SKILL.md`）新增「先问再动：记录与删除都先问用户」一节，含触发点、两条硬规矩
  （没肯定答复不写不删、一轮最多问一次）、提问话术（问题 id 与选项文案，选项 `记录 (Recommended)` /
  `不记录` 与 `删除 (Recommended)` / `先留着`）；`description` / `whenToUse` 同步覆盖「已办结 → 问是否删除」。
- 测试：宿主端 smoke 69 → 91 项。新增断言覆盖常驻文本里的触发器、「不记、不删」、删除要点头、免问出口、
  「授权即等于已点头」、一轮最多一次、答过或跳过的不再问、跳过要回报、已拒过的不被授权翻案、
  子代理替代动作、无上层代理时的出口，
  技能里的「先问再动」、`ask_user_question`、`先留着`、跳过不落盘、记录侧 id 序号槽位、路由描述；
  另加跨文本**逐字一致**断言——删除铁律那句话，以及 A/B/C 三类小节名，在常驻文本 / 技能 / 骨架文件里
  必须相同（改一处漏另一处会静默不一致，照抄出来的小节名也才不会各写各的）。
- 文档：插件 README 说明「先问用户」的实际约束面（触发器常驻、选项文案在技能、无代码拦截）；
  修掉两条与代码对不上的旧陈述（「入口只在引导页」漏了标题栏按钮；README 把固定选项文案算在常驻短文头上）；
  `package.json` 的 description 补上这条行为。

## 0.2.3

- 修：页签与标题栏入口在**冷会话**上报「读取失败：no live session with id session-…」。
  端点原先把 `ctx.sessions.get(id)` 当作唯一来源，只有**进程内存里的活跃会话**能定位工作区；
  而界面里能打开的会话不止这些——宿主进程重启后仍留在界面上的旧会话、侧栏翻出来的历史会话，
  都只存在于落盘记录里，于是 404。改为两步解析会话 cwd：先查内存会话表，找不到再问持久化服务
  `ctx.get('sessionPersistence')?.stat(id)`。`stat()` 只读落盘 header，不读事件日志、也不把
  会话恢复成活的（宿主自己的文件 RPC 就是这套解析，见 `dsh-api-workspace-files` 的
  `workspaceFileScope`）；没挂持久化服务时退回旧行为。两处都没有该 id 才回 404
  （`code: no-session`；文案由 `no live session with id …` 改成 `unknown session id …`）。
  顺带把页签的报错文案本地化：`no-session` 不再原样抛宿主那句英文，改为
  「找不到这个会话（可能已结束，或来自上一次 dsh 进程），无法确定工作区」。
- 测试：宿主端 smoke 补冷会话命中 / 冷会话无 cwd / 活跃会话优先 / 无持久化服务 / `stat` 抛错
  五组断言；客户端 smoke 补 `no-session` 的本地化文案断言。

## 0.2.2

- 宿主 peer 声明由 `^0.1.5-alpha.1` 改为 `>=0.1.7-rc.1 <0.3.0`（`@deepseek-ai/dsh-home-paths`）。dsh 0.2.0-rc.1 启动时逐条判 `@deepseek-ai/dsh*` peer，`^0.1.5-alpha.1` 不覆盖 0.2.0-rc.1，插件被整包跳过（`dsh: skipping profile bundle "dsh-plugin-todo-tab"`），页签与待办约定注入都不加载；改后 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 均通过（宿主自带的 `evaluatePluginCompatibility` 实测）。本次只改声明，无代码改动。

## 0.2.1

- 修：`todo-memory` 技能自 0.2.0 起**从未注册成功**。`agent.ctx.skills` 会被 cordis 直接拒
  （`cannot get property "skills" without inject`：skills 由 host 组合的另一行提供，不在 agent ctx
  的 fiber 链上，而 agent ctx 没有声明 inject），异常又被降级成一条 warn，技能静默消失。
  改为经 `agent.ctx.inject(['skills'], …)` 注册——拿到的 scoped ctx 作用域仍是该 agent，
  注册照旧落在 agent 层。
- 修：注册条目缺 `source`。技能能进目录，但 `skills.get()` 会在 `validateDefinition` 里抛
  `loaded skill "todo-memory" source must be a string`；补 `source: 'custom'`。
- 补：技能挂载链加 `.catch`——少了它，这里的异常只是一条没人看见的 unhandled rejection；
  注册成功/失败各留一条日志（含 agent id）。
- 测试：假 agent ctx 按真实宿主形状挡回直接访问 `skills`（回归防护），并断言 inject 依赖、
  `source`、inject 的释放；挂载等待改为按条件轮询，不再赌一个 tick。

## 0.2.0

- 待办约定改由插件携带，不再依赖 `~/.dsh/AGENTS.md` 与 `~/.dsh/memory/TEMPLATE.md`：
  - 常驻注入（`lib/convention.js`）：每个 agent 的 **prompt scope** 上注一段
    `systemPrompt.context({ name: 'todo-tab:todo-memory', order: 700, … })`，内容是
    「触发器 + 铁律」；在 `agent/created` 挂、`agent/disposed` 释放。
    必须挂 agent scope——`assemble` 只合并 global 层与 agent 的 scope 链，挂插件 scope 会静默不进 prompt。
  - 技能：`skill/todo-memory/SKILL.md`（完整规范：分组、字段、骨架、示例）在同一个 agent ctx 上
    `skills.register({ provider: 'todo-tab' })`，由 `lib/convention.js` 的 `loadSkill()` 读盘并附上
    骨架文件路径。
  - 骨架：`template/TODO.md`，随插件分发。
  - 缺 `systemPrompt` / `skills` 服务时只损失约定注入（走 `ctx.inject`），端点与页签照常。
- 测试：宿主端 smoke 增加常驻文本、frontmatter 解析、技能加载、agent scope 挂载/释放/幂等断言。

## 0.1.0

- 首个版本：右侧栏新增只读「Todo」页签，展示当前工作区的
  `<DSH_HOME>/memory/<工作区>/TODO.md`。
- 宿主端 `GET /todo-tab/data?session=<id>`：按会话 cwd 末段定位工作区，只读返回文件内容，
  文件缺失时回 `exists: false` 与应放路径。
- 浏览器端注册右侧栏页签类型（`kind: "todo"`）与引导页胶囊，页面型打开；只读渲染，
  带路径/字节数/修改时间与「刷新」。
- 会话标题栏新增「Todo」入口按钮：页签类型不会自动出现在标签条上，只靠引导页胶囊太隐蔽
  （已有会话会恢复自己的标签布局，引导页常常看不到），改为标题栏一键打开并展开右侧栏。
- 标题栏入口打开失败时把原因显示在按钮旁边，不再只写 console：否则表现为「点了没反应」，
  无法排查。
- 修：「cannot get property "sidebarRight" without inject」——客户端 inject 漏了
  `sidebarRight`，cordis 拒绝未声明服务的访问，导致标题栏按钮点了没反应。
- 页签内容默认按 Markdown 渲染（自带子集解析器：标题/列表/任务勾选框/引用/围栏代码/行内
  code/粗体/斜体/链接），头部加「渲染 / 原文」切换；原文模式仍是原来的 `<pre>`。
- 标题栏入口改为优先用 **DSH 原生文件预览**打开 TODO.md（把绝对路径编成
  `dsh-resource://file/session/<会话 id>//<绝对路径>` 资源地址交给 `openResource`，`.md` 由
  产品自己的 Markdown 实现渲染）；文件不存在或端点异常时退回插件自己的 Todo 页签。
  排除了「复用原生渲染组件」这条路：它是文件预览页签类型的一部分，组件在构建期被内联，
  插件运行时 require 不到，只能通过资源地址借用。
