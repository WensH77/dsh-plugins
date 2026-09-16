# dsh-plugin-todo-tab

在 dsh web 的**右侧栏**新增一个「Todo」页签，只读展示**当前工作区**的待办文件：

```
<DSH_HOME>/memory/<工作区>/TODO.md
```

`<工作区>` 取当前会话 cwd 的最后一段（如 cwd 是 `/Users/me/Documents/dsh-plugins`，就读
`~/.dsh/memory/dsh-plugins/TODO.md`），与 `~/.dsh/AGENTS.md` 的待办约定一致。

## 功能

- **会话标题栏的「Todo」按钮**（主要入口）：优先用 **DSH 原生的文件预览**打开 TODO.md——即右侧栏里
  那个按扩展名分派实现的预览页签，`.md` 由产品自己的 Markdown 渲染器渲染；文件不存在时退回插件
  自己的 Todo 页签，把「还没有 TODO.md」和应放路径说清楚。
- 右侧栏引导页也有一个「Todo」胶囊（页签类型的常规入口），打开的是插件自己的页签。
- 插件自己的页签里显示工作区名、文件绝对路径、字节数与修改时间，带「刷新」与「渲染 / 原文」切换。
- **只读**：没有编辑入口、没有写端点，插件不修改任何文件。

## 工作原理

- **宿主端**（`lib/index.js`）注册一个端点 `GET /todo-tab/data?session=<id>`：按会话 id 查
  宿主自己的会话表拿到 `header.cwd`，推出工作区名与 TODO.md 路径后读文件返回。调用方只能
  给会话 id，给不了路径，所以没有任意文件读取面；端点只有这一条，且是纯读。
- **浏览器端**（`lib/client.js`）走 DSH 右侧栏页签的两段式注册：类型注册进
  `ctx.sidebarRightTabs`（`kind: "todo"`，页面型，带一个引导页胶囊），本体注册进
  `sidebar.right.pane.tab` 槽位（key 与类型 id 相同）。页签本体拿到会话级插槽的标准属性
  `sessionId`，据此取数渲染。
- **入口为什么有两个**：页签类型不会自动出现在标签条上——它要等 `openTab(kind)` 才会成为页签。
  引导页胶囊是 DSH 的原生入口，但只有在引导页可见时才看得到（已有会话会恢复它自己记录的标签
  布局，往往不显示引导页）；所以另外往 `conversation.session.header.actions` 挂了一个标题栏
  按钮，保证一眼能看见、一点就开（`ctx.sidebarRight.openTab` 会顺带展开收起状态的栏）。
- **Markdown 为什么有两套渲染**：DSH 右侧栏本身有原生 Markdown 渲染——文档预览包
  （`dsh-client-ui-sidebar-documentpreview`）按扩展名把 `.md` 交给它自己的 Markdown 实现
  （`MarkdownBody` → `MarkdownText`）。但那是一个**文件预览页签类型**，只能通过
  `dsh-resource://file/…` 资源地址打开，插件没法把任意文本塞进去渲染；而它的渲染组件由 DSH 在构建期
  内联进那个 bundle，运行时 `require` 不到。
  所以标题栏按钮的做法是：向宿主问出 TODO.md 的绝对路径，编成 session 作用域的资源地址
  （`dsh-resource://file/session/<会话 id>//<绝对路径>`，path 段以空段开头还原前导 `/`）交给原生
  预览——宿主读文件的契约本就允许工作区之外的绝对路径；拿不到文件时再用插件自带的那套。
  自带的是子集解析器（`parseMarkdown`，纯函数、可单测）：标题、段落、有序/无序列表、任务清单
  （含缩进子项）、引用、分隔线、围栏代码，行内 `code` / **粗体** / *斜体* / 链接；不支持表格、
  图片与 CommonMark 的边角语法。
- 页签内容不缓存：打开或点「刷新」时现取，改完 TODO.md 点一下刷新就能看到新内容。

## 安装

```bash
# 本地路径（推荐，便于改完即验）
dsh plugin --profile web add /path/to/dsh-plugins/todo-tab

# 或从仓库按子目录安装
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:todo-tab'
```

本插件是 **bundle 包**（`dsh.bundle.patch` 指向自己的 `cordis.patch.yml`），安装时会把自己
插入 profile 组合树，不需要手写 `cordis.patch.yml` 条目。装完**重启 dsh web** 生效：

```bash
dsh web
```

卸载：

```bash
dsh plugin --profile web remove dsh-plugin-todo-tab
```

## 使用

- 会话标题栏右侧点「Todo」：有 TODO.md 就用 DSH 原生文件预览打开（页签标题是 `TODO.md`，
  Markdown 由产品渲染）；没有文件时打开插件自己的页签，显示应放路径。
- 或：右侧栏 → 引导页（空面板默认页，或标签条的「+」）→ 点「Todo」胶囊，打开插件自己的页签。

## 配置

无配置项。

## 测试

```bash
npm test                                        # = 两个 smoke
node test/smoke.mjs                             # 宿主端：定位域 + 端点行为 + 只读/不可注入
node test/client-smoke.mjs                      # 浏览器端：注册面 + 只读约定 + 渲染不抛错
```

宿主端改动（`lib/index.js`）需重启 dsh web 生效；浏览器端（`lib/client.js`）在客户端 HMR
可用时刷新页面即可。

## 已知限制

- **按 cwd 末段命名工作区**：两个不同目录同名（如 `a/src`、`b/src`）会共用同一份 TODO.md。
  这是 `~/.dsh/AGENTS.md` 的既有约定，本插件如实照做，不做去重。
- **入口只在引导页**：页签类型不会常驻在标签条上，必须从引导页胶囊打开；打开后与其它页签
  一样可停靠、浮动、分屏（由右侧栏本身提供）。
- **无变更监听**：不看文件 mtime，也不会自动刷新，需要手动点「刷新」。
- **端点只认活会话**：`/todo-tab/data` 走宿主的 `ctx.sessions.get(id)`（与 command-setting 等
  插件同一套做法），进程里没有这个活会话时回 404。GUI 里选中的会话是活的，正常使用无感；
  但若在服务重启后用一个尚未恢复的会话打开页签，会先看到 `no session with id …`，选中该会话
  后点「刷新」即可。
- 没有写能力是刻意的：TODO.md 的增删改仍由代理按 `~/.dsh/memory/TEMPLATE.md` 的约定维护。
