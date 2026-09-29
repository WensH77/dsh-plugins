# dsh-plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）web profile 编写的一组插件。

仓库是**多插件 monorepo**：每个插件是一个独立包目录（各自的 `package.json` / `README.md` / `CHANGELOG.md`），
可以直接从 GitHub 按子目录安装，不需要发布到 npm；顶层没有统一 lockfile，各插件版本独立维护。

## 在用插件

| 插件 | 目录 | 功能 |
|---|---|---|
| **command-setting** | [`command-setting/`](command-setting/README.md) | 输入区增强：外置 Plan / Ask 切换按钮（`/plan`、`/ask`——ask 为会话级只问答模式，禁改/禁建文件）、`#` 引用历史会话（跨工作区/未归档/主代理）、划词引用。**0.9.0 起移除原「命令隐藏」功能**，不再过滤命令菜单 |
| **todo-tab** | [`todo-tab/`](todo-tab/README.md) | Todo 页签 + 待办约定：右侧栏新增只读「Todo」页签展示当前工作区的 `~/.dsh/memory/<工作区>/TODO.md`（路径按会话 cwd 末段推出，无写端点），标题栏入口优先用 DSH 原生文件预览打开；并把待办约定改成插件携带——每个 agent 的 prompt 上常驻「触发器 + 铁律」，完整规范做成 `todo-memory` 技能按需加载，骨架作为 `template/TODO.md` 随插件分发 |
| **context-xray** | [`context-xray/`](context-xray/README.md) | 上下文 X 光：注册 `context_xray` 工具，把会话上下文拆成块（系统提示词 / 各类注入 / 用户消息 / 工具结果 / 自己写进上下文的工具入参与回复正文），用各块关键词在 reasoning 里被提及的次数做归因代理——输出三口径来源占比（提及 / 体积 / 累计）、词汇重叠榜、时间分布、关键词归因力表，外加两张排查清单（未闭合的用户输入、回复里无出处的标识符）；另有离线入口 `tools/xray.mjs` 可直接读任意历史会话，`--json` 喂给别的程序 |
| **dsh-version-check** | [`dsh-version-check/`](dsh-version-check/README.md) | dsh 版本状态灯：侧边栏品牌名下方显示已装 dsh 版本与更新状态（启动 + 每小时检测 `deepseek-harness` 最新发布），点击跑本地插件契约扫描 + 直连 LLM 逐版本分析——判断新版本会不会影响本机已装插件的运行期兼容性，给出可复制的升级命令、版本变更明细与扫描证据。**原名 plugin-market**：0.16.0 移除原「插件市场」的设置页 tab 与安装/更新/卸载功能，0.17.0 更名为 dsh-version-check |

## 已弃用存档（`deprecated/`）

不再维护、也不再提供安装指引，各目录 README 顶部有弃用说明，代码与测试保留作存档。

| 插件 | 目录 | 曾经的用途 / 弃用原因 |
|---|---|---|
| **arena-v2** | [`deprecated/arena-v2/`](deprecated/arena-v2/README.md) | 类 plan 的 chip/hero 双入口 + `/arena` 开启竞技场，主代理自动创建可接续子代理作为挑战者。后续方案为 Theseus Crew |
| **chat-rollback** | [`deprecated/chat-rollback/`](deprecated/chat-rollback/README.md) | 对话回滚：用户消息操作条里的回滚按钮，创建新会话并预填该消息文本，附带轮次快照的代码回滚、fork 快照继承、原会话自动归档。已停止维护；本机副本早在 2026-09-15 卸载（insert 段、profile 依赖、node_modules 与 7.6 GB 快照目录一并删除），2026-09-29 归档 |
| **model-arena** | [`deprecated/model-arena/`](deprecated/model-arena/README.md) | 模型竞技场 v1（挑战模式）：hero 视图选场景/模型后一次提问，自动跑「模型1 回答 → 模型2 质疑 → 模型1 修正 → 模型2 终评」。曾由 arena-v2 取代 |
| **session-export** | [`deprecated/session-export/`](deprecated/session-export/README.md) | 会话导出长图：会话标题栏按钮把当前会话导成 PNG，只含用户输入与模型输出（剔除思考与工具调用），长会话自动拆多张 |
| **temperature-inject** | [`deprecated/temperature-inject/`](deprecated/temperature-inject/README.md) | 温度注入：会话页开关 + 滑杆，经 `agent/request` waterfall 改写子代理的 `LlmCallConfig`。弃用原因是它无效——同 prompt 下 T0/T1 的组内相似度 0.470 vs 0.359，视觉方向仍雷同，真正拉开差异的是 prompt 里的设计约束；而且它要生效必须关掉 thinking，后续实测确认 thinking 模式下 temperature 被屏蔽（见 `tools/`），等于用方案质量换多样性 |
| **tool-both** | [`deprecated/tool-both/`](deprecated/tool-both/README.md) | 工具呈现模式 both：激活时安装「BOTH模式」预设，原生工具直调与 run_code 并存。弃用原因是 both 在同一请求里重复渲染工具入参类型声明（`interface ToolArgsMap` 35,940 字符，占 SDK 段的 76%），而实测 77% 的 both 会话一次 `run_code` 都没调过 |

## 安装

前置：`dsh plugin` 会把参数转发给 **PATH 上的 pnpm**（`npm i -g pnpm` 或 corepack）。
仓库是**公开**的，git 安装走 HTTPS，无需任何凭据或 SSH key。

**bundle 包**（自带 `cordis.patch.yml`，安装时把自己插入 profile 组合树，不需要手写补丁）：
`todo-tab` / `context-xray` / `dsh-version-check`

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:todo-tab'
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:context-xray'
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:dsh-version-check'
```

想改代码、或要锁版本，就 clone 后按本地路径装（`dsh-version-check` 自己的 README 用的是这种写法）：

```bash
dsh plugin --profile web add ./todo-tab
```

**普通插件**（要在 `~/.dsh/profiles/web/cordis.patch.yml` 顶层数组里手写 insert）：
`command-setting`

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:command-setting'
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: command-setting
      name: dsh-plugin-command-setting
```

装完重启 dsh web：

```bash
dsh web
```

更新 / 卸载（包名见上面各插件的 `package.json`；`dsh-version-check` 没有 `dsh-plugin-` 前缀）：

```bash
dsh plugin --profile web update dsh-plugin-command-setting   # 更新（git 依赖锁定在 lockfile 的提交）
dsh plugin --profile web remove dsh-plugin-command-setting   # 卸载（并移除 patch.yml 条目）
```

> - 装了 GitHub SSH key 的机器可用简写（等价，走 SSH）：
>   `dsh plugin --profile web add 'github:WensH77/dsh-plugins#path:command-setting'`
> - 纯 JS 插件、没有 prepare 构建脚本 → 安装无需 allowBuilds；普通插件安装时打印的
>   `declares no dsh.bundle` 是预期提示（普通插件不在 bundle 层，忽略即可）。
> - pnpm v9 不支持「分支 + 子目录」组合写法（`#分支#path:` 会解析失败）；要锁版本就 clone 后走上面的本地路径写法。

## 本地开发

```bash
git clone https://github.com/WensH77/dsh-plugins.git   # 公开仓库，HTTPS 即可
cd dsh-plugins

# 测试要 import @deepseek-ai/*（各插件的 peer 依赖）。node_modules 与根 package.json 都不入库，
# 指向本机 dsh 安装的 node_modules 即可：
ln -s "$(npm root -g)/@deepseek-ai/dsh/node_modules" node_modules
```

各插件目录（含归档的）都可直接 `npm test`（= 该目录 `package.json` 里的 `scripts.test`）。等价的直接命令与当前断言数：

```bash
node command-setting/test/smoke.mjs                  # command-setting node 端（47 项）
node command-setting/test/client-smoke.mjs           # command-setting 浏览器端（95 项）
node todo-tab/test/smoke.mjs                         # todo-tab 宿主端（69 项：约定注入/技能注册/端点/只读）
node todo-tab/test/client-smoke.mjs                  # todo-tab 浏览器端（49 项：注册面/渲染/打开失败文案）
node --test context-xray/test/smoke.mjs              # context-xray（22 项：拆块/归因折扣/体积校准/两张清单/工具注册）
node dsh-version-check/test/smoke.mjs                # dsh-version-check 契约快照 + client 渲染（157 项）
node --check dsh-version-check/lib/index.js dsh-version-check/lib/client.js
```

已弃用插件的测试（同一套 node 脚本，改存档代码时可拿来回归）：

```bash
node --test deprecated/chat-rollback/test/fork-rollback.mjs deprecated/chat-rollback/test/matcher-fuzz.mjs
                                                     # 22 项：fork/回滚（21）+ excludes 匹配器差分 fuzz（1）
node deprecated/chat-rollback/test/client-emit.mjs   # 浏览器端：回滚预填 emit 定向性（防 composer 广播）
node deprecated/arena-v2/test/smoke.mjs
node deprecated/model-arena/test/smoke.mjs
node deprecated/model-arena/test/client-smoke.mjs
node deprecated/session-export/test/smoke.mjs
node deprecated/session-export/test/client-smoke.mjs
node deprecated/temperature-inject/test/smoke.mjs
node deprecated/temperature-inject/test/client-smoke.mjs
node deprecated/tool-both/test/smoke.mjs
```

> 宿主端（Node 半段）改动要**重启 dsh web** 才生效（`dsh-version-check` 的 `lib/index.js`、`lib/dsh.js`、
> `lib/patch.js`、`lib/routes.js` 同理）；浏览器端（`lib/client.js`）每次请求实时加载，刷新页面即可。
> 宿主 peer 范围：需要 `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-home-paths` 的三个插件声明
> `>=0.1.7-rc.1 <0.3.0`，客户端注入依赖一律 `*`。宿主换版本线时这些范围要跟着 bump，
> 否则 dsh-version-check 的契约扫描会报 `range-break`（属声明失真，无运行期影响）。

## 实验与探针（`tools/`）

不是插件，是几个一次性验证与调查脚本，保留是为了让结论可复核。

| 目录 | 结论 |
|---|---|
| [`tools/temperature-p0/`](tools/temperature-p0/README.md) | deepseek-v4 是否响应 temperature（两轮都在 thinking 模式下跑）：v1（360 次调用）判 INCONCLUSIVE，仅作存档；v2（432 次调用，补 seed 对照与 dupRate）判定 **temperature 空转**——high / max 两种 effort 下都没有可检测的效应 |
| [`tools/temperature-nothink/`](tools/temperature-nothink/README.md) | 补上 thinking 关闭的那一格：非 thinking 模式下 temperature **生效**，方向符合温度语义（温度↑ → 回答更分散）。也就是说 temperature 有没有用由 thinking 开关决定，不是模型不支持该参数 |
| [`tools/thinking-voice/`](tools/thinking-voice/README.md) | 「We need / Let me」思维链语态调查（21,646 块真实数据 + 因果对照实验）：语态由**提问形式**触发，不是 persona 锚定出来的稳定状态，也无法被强制或锚定 |

## 仓库结构

```
dsh-plugins/
├── command-setting/          # 输入区增强（Plan/Ask 按钮、# 会话引用、划词引用）
│   ├── lib/index.js          #   Node 端：ask 装配 + ask-state 端点
│   ├── lib/ask.js            #   ask（只问答）域：判定/提示段/切换通知/会话控制器
│   ├── lib/routes.js
│   ├── lib/client.js         #   浏览器端：Plan/Ask 按钮 + # 会话引用 + 划词引用
│   ├── test/                 #   smoke / client-smoke
│   └── package.json
├── todo-tab/                 # Todo 页签 + 待办约定（bundle 包）
│   ├── lib/index.js          #   Node 端：GET /todo-tab/data 只读端点 + 约定注入
│   ├── lib/memory.js         #   定位域：cwd → 工作区名 → TODO.md 路径 + 读盘
│   ├── lib/convention.js     #   待办约定域：常驻文本 + SKILL.md 解析/加载
│   ├── lib/client.js         #   浏览器端：右侧栏页签类型 + 引导胶囊 + 只读渲染
│   ├── skill/todo-memory/    #   完整规范（注册成运行时技能，按需加载）
│   ├── template/TODO.md      #   骨架文件（拷出来当起点）
│   ├── cordis.patch.yml      #   bundle 补丁层（自插入 profile 组合树）
│   └── package.json
├── context-xray/             # 上下文 X 光（bundle 包）
│   ├── lib/index.js          #   Node 端：注册 context_xray 工具
│   ├── lib/mention.js        #   归因核心：拆块 + 分词 + df 加权 + 体积校准 + 两张排查清单
│   ├── lib/render.js         #   markdown 渲染（tool 与 CLI 共用一份）
│   ├── lib/stopwords.js      #   中英停用词表
│   ├── tools/xray.mjs        #   离线入口：直读会话 jsonl（zstd）
│   ├── cordis.patch.yml      #   bundle 补丁层（自插入 profile 组合树）
│   └── package.json
├── dsh-version-check/        # dsh 版本状态灯（bundle 包，原名 plugin-market）
│   ├── lib/index.js          #   Node 端：检测编排 + 契约扫描 + LLM 分析路由（前缀 /dsh-version-check）
│   ├── lib/dsh.js            #   dsh 发布版本检测与升级命令生成
│   ├── lib/patch.js          #   profile 补丁/依赖检查
│   ├── lib/routes.js lib/util.js
│   ├── lib/client.js         #   浏览器端：侧边栏版本状态灯 + 判定弹窗
│   ├── cordis.patch.yml      #   bundle 补丁层（自插入 profile 组合树）
│   └── package.json
├── deprecated/               # 已弃用存档（README 顶部均带弃用横幅）
│   ├── chat-rollback/        #   对话回滚：宿主端 lib 7 文件（快照/冲突/排除匹配/会话/路由）+ client.js + 3 个测试
│   └── arena-v2/  model-arena/  session-export/  temperature-inject/  tool-both/
├── tools/                    # 非插件：验证探针与调查脚本（见上一节）
│   ├── temperature-p0/       #   temperature 是否生效（v1/v2 两轮）
│   ├── temperature-nothink/  #   非 thinking 模式下的那一格
│   └── thinking-voice/       #   思维链语态调查
├── node_modules/             # 测试依赖解析（软链，已 gitignore）
└── .gitignore
```

各插件目录内的 README 写功能、原理、安装、配置与已知限制，历次改动见同目录的 `CHANGELOG.md`。
