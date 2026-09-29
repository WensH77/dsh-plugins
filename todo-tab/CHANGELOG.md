# 变更日志

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
