# 变更日志

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
