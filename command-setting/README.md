# dsh-plugin-command-setting

dsh web 输入区增强插件。名字保留历史 id（`command-setting`），但**0.9.0 起不再提供「命令隐藏」**——原「从 “+” / “/” 菜单隐藏指定命令」的功能已整体移除，原因见 [CHANGELOG.md](./CHANGELOG.md)。

现存能力：

- **外置 Plan 按钮**：composer 工具行左侧新增 Plan 切换按钮（点击调用 /plan）
- **Ask 只问答模式（/ask）**：composer 工具行 Plan 按钮**左侧**新增 Ask 按钮（点击调用 /ask）——开启后该会话进入**只问答模式**：agent 只回答问题、可读文件与 run_code 验证，**禁止改动或创建任何文件**（执行级硬拦，模型层面无法绕过、用户强行要求也拦不住），并禁止诱导性提问（如“需要我帮你改 xxx 吗”）
- **# 引用历史会话**：在输入框输入 `#` 弹出**会话引用**菜单，选中后插入与 `@` 会话引用**完全等效**的原子引用（`@[标题](dsh-session:…)`，宿主照常捕获该会话快照作为背景上下文）。与 `@` 的差别是 `#` **只列会话、不列文件**，且仅限三类会话：**未归档**、**主代理**（排除 subagent 子会话）、**跨工作区**（候选直接读客户端会话列表，跨工作区会话按「其他工作区 / 当前工作区」分组，永不因同工作区会话过多而被挤掉）
- **划词引用**：在消息文本上拖动选中文字，选区上方浮出「**引用**」小胶囊；点击把选中文本转成 Markdown 引用块（逐行 `> `）追加到当前会话的 composer 末尾，光标停在引用块下方，直接接着提问即可
- **不再改动命令菜单**：插件既不隐藏命令，也不过滤菜单；命令面完全由 dsh 自身（命令注册 + agent preset）决定。**ask 模式为会话级开关**（侧文件 `~/.dsh/command-setting-ask.json` 持久化，dsh web 重启后恢复）

## 功能速览

| 能力 | 说明 |
|---|---|
| Plan 切换 | composer 工具行左侧独立按钮，点击执行 `/plan`（进入）或 `/plan off`（退出），替换内置的 Plan 芯片 |
| Ask 只问答模式 | composer 工具行最左侧独立按钮（Plan 左侧），点击执行 `/ask`（进入）或 `/ask off`（退出）；开启后会话级只读——禁改/禁建文件（`tools.guard` 执行级硬拦 + 系统提示约束）、禁诱导改动提问 |
| # 会话引用 | 输入 `#` 打开会话引用菜单（**只列会话**）；候选限定「未归档 + 主代理 + 跨工作区」，按「其他工作区 / 当前工作区」分组各限 25 行，跨工作区行显示**工作区名字**；选中插入与 `@` 会话引用同构的原子 mention，宿主按既有 session-reference 机制捕获快照 |
| 划词引用 | 选中消息文本 → 选区上方浮出「引用」按钮 → 点击把选中文本作为 Markdown 引用块追加到当前会话 composer（草稿已有 `@`/`#` chip 时走 paste 追加，不破坏 chip） |

## 工作原理

### 两个半区

| 文件 | 角色 |
|---|---|
| `lib/index.js` | **Node 端** Cordis 插件：`GET /command-setting/ask-state`（会话 ask 开关）；`/ask` 命令 + 会话级 ask 拦截安装/恢复（`tools.guard` + `systemPrompt` 段 + 切换通知注入） |
| `lib/ask.js` | ask 域：只读判定（`askToolDenyReason` / `isBashWrite`）、提示段（`buildAskSection`）、切换通知（`buildAskNotice`）、会话级控制器与状态侧文件 |
| `lib/routes.js` | webServer 路由（ask-state）+ HTTP 样板 |
| `lib/client.js` | **浏览器端** bundle：Plan 按钮 + Ask 按钮（`conversation.input.left` 插槽，Ask 在 Plan 左侧）+ `#` 会话引用源（包装 input-trigger 的会话 controller，把 `#token` 路由到独立会话源）+ 划词引用浮标 |

### # 会话引用（跨工作区 / 未归档 / 主代理）

1. **触发**：输入框里 `#` 在草稿开头或空白之后开启 token，候选菜单实时按标题/会话 id/工作目录过滤；选中插入原子引用，序列化与 `@` 会话引用完全相同（`@[标题](dsh-session:<base64url id>)`），宿主 `session-reference` 服务照常在 `agent/pre-step` 校验并捕获该会话的有界只读快照。
2. **宿主限制与适配**：dsh 的 input-trigger 只识别 `/` 与 `@`（`TriggerChar` 是封闭联合），`#` 不能直接 `registerSource`。本插件给每个会话 controller 包一层——把活跃的 `#token` 在**同一 span** 上改写成等价的 `@token` 交给宿主自己的探测器，再拦截该 controller 的 source roster，使这个 hit 只解析到插件的 `#` 源（不会混入 `@` 的文件/会话统一菜单）。`#ab` 与 `@ab` 的 hit 字段完全相同，宿主 `track` 的 `same` 短路会保留旧 source 的菜单，因此 `#`↔`@` 切换时先关菜单再委托，保证 source 正确换面；停用插件时完整还原 controller 与原 `@` 行为。
3. **三个准入条件**（`#` 与 `@` 会话引用的唯一差别）：
   - **未归档**：排除 `ctx.workspaces` 快照里 `archivedSessionIds` 中的会话；
   - **主代理**：排除 `origin === 'subagent'` 的子会话（fork 出来的主会话仍保留）；
   - **跨工作区**：候选直接读客户端会话列表（含全部工作区），按「**其他工作区** / **当前工作区**」两个分组呈现，各自按最近活动排序、各限 25 行——跨工作区会话因此始终可见；其他工作区的会话在描述里显示其**工作区名字**（未注册目录退回缩写的目录路径），再接更新时间。
4. **为什么不复用宿主的候选接口**：`remote.sessionReferenceResolver.candidates` 默认只取 `candidateLimit`（50）条、且**同 cwd 优先**排序后截断——当前工作区会话一多（实测 300+），跨工作区候选会被整段挤出，表现就是「# 只能 attach 当前工作区会话」。因此候选与规范 mention（`@[label](dsh-session:<base64url(JSON id)>)`，label 转义 `\`/`]`）都由本插件从客户端会话列表（`sessions` 快照，自带 `displayTitle`/`cwd`/`origin`/`updatedAt`）组装，与宿主 `session-reference` 的编解码逐字节同构。空会话（`blank`，没有可引用的历史）与非 ASCII id 会被跳过；`sessions`/`workspaces` 服务缺失时候选为空、静默降级，不影响其余功能。

### 划词引用（消息文本 → composer）

1. **触发**：`pointerup` 后读取 `window.getSelection()`——选区非折叠、文本非空、落在消息滚动区 `[data-conversation-scroll]` 内，且不在 `[data-composer-seat]` / 输入控件里，就在选区上方浮出「引用」胶囊（`position:fixed`，随滚动/空白点击/Escape 消失）。`pointerdown` 到浮标上会 `preventDefault` 保住选区，`selectionchange` 在按住期间忽略。
2. **写入**：点击后把选中文本逐行加 `> `（空行保留裸 `>`）成 Markdown 引用块，追加到当前会话草稿末尾：草稿非空时先空一行，引用块后再留一空行，光标停在下方；随后清空选区并聚焦 composer。
3. **保 chip**：草稿里已有 `@`/`#` 原子引用 chip 时走 shell 的 `paste`（追加），避免 `setDraft` 把 chip 压成纯文本；没有 chip 时用 `setDraft`（保证按段落换行）。两者都是宿主 `conversation.input.shell(id)` 的既有能力。
4. **依赖的宿主契约**：`[data-conversation-scroll]` / `[data-composer-seat]` DOM 标记、`ctx.get("conversation").input.shell(id)`（`SessionInput` 的 `state`/`setDraft`/`paste`）。任一缺失时该特性静默不启用，其余功能不受影响。

### Ask 只问答模式（会话级）

1. **开关**：composer 工具行 Ask 按钮（Plan 左侧，order -1）点击执行 `/ask`（进入）或 `/ask off`（退出）；直接输入 `/ask` 亦可。状态写入 `~/.dsh/command-setting-ask.json`（`{ 会话id: true }`），dsh web 重启后 `agent/created` 时自动恢复（`GET /command-setting/ask-state?session=<id>` 供按钮回显）。
2. **提示约束**：开启时给该会话注入 `ask:policy` 系统提示段——专注问答、可读文件与 run_code/内联命令验证；**禁止改动或创建文件**；用户强行要求“直接改”时拒绝并提示先 `/ask off`；**禁止诱导性追加提问**（“需要我帮你改 xxx 吗”“需要我现在改 xxx 吗”“要不要顺手把 xxx 也改了”等）。
3. **切换通知（会话上下文注入）**：`/ask`、`/ask off` 成功切换后向该会话注入一条插件来源的 user notice（`agent.inject`，如「用户已把本会话切回普通模式（ask 已关闭）」），source 为 `{ kind: 'plugin:dsh-plugin-command-setting', form: 'notice', summary }`——v4 会话要求 `kind` 是生产者自有的，写裸 `'plugin'` 会让这条注入被落盘准入整条拒掉。slash 命令是 log-only 生命周期、**命令文本不下发模型**，系统提示段又只是「有 / 无」的静态渲染——没有这条通知时模型感知不到模式已变，会按旧模式继续作答（`/ask off` 后仍拒绝改文件）。通知排在下一步、不唤醒空闲会话，随下一次请求进入上下文并留在会话历史里；判定为 `noop` 的重复开关不注入。与宿主 `dsh-plan-mode` 的 narration 同机制。
4. **执行级硬拦（tools.guard）**：注册在该会话 agent.ctx 的工具守卫在每次工具 dispatch 前判定——`edit` / `write` / `str_replace_editor` 一律拒绝；`bash` 检测到写命令/重定向（`cp`/`mv`/`rm`/`tee`/`sed -i`/`>`/`>>` 等）也拒绝；`read` / `grep` / `glob` / `run_code` 与只读 bash（`node -e` / `python3 -c` / 运行已有脚本 / `ping` / `curl`）放行。守卫返回拒绝文案而非静默放行，模型层面无法绕过（与 arena-v2 的 guard 同机制）；关闭 ask（`/ask off`）或会话销毁时随 disposer 卸载。
5. **范围**：ask 为**会话级**——只影响开启它的会话主代理，其它会话、子代理不受影响；只读约束只作用于本会话的工具面，不改变全局 sandbox/approval 策略。

## 安装（GitHub 公开仓库，无需发布 npm）

前置：`dsh plugin` 命令会把参数转发给 **PATH 上的 pnpm**（`npm i -g pnpm` 或 corepack）。仓库是**公开**的，直接安装即可，无需任何凭据或配置。

```bash
# 1) 安装（公开仓库，HTTPS 拉取，无需 SSH key；跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:command-setting'
```

> 装了 GitHub SSH key 的机器也可用简写（等价，走 SSH）：`dsh plugin --profile web add 'github:WensH77/dsh-plugins#path:command-setting'`

```yaml
# 2) ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加（无需 config）
- insert:
    - id: command-setting
      name: dsh-plugin-command-setting
```

```bash
# 3) 重启 dsh web
dsh web
```

说明：

- **更新**：仓库有新提交后运行 `dsh plugin --profile web update dsh-plugin-command-setting`（git 依赖会锁定到 lockfile 中的提交）
- **卸载**：`dsh plugin --profile web remove dsh-plugin-command-setting` 并移除 patch.yml 条目
- 纯 JS、无 prepare 构建脚本 → 安装无需 allowBuilds；`dsh plugin add` 打印的 `declares no dsh.bundle` 警告是预期提示（普通插件不是 bundle 层，忽略即可）
- pnpm v9 **不支持**「分支 + 子目录」组合写法（`#分支#path:` 会解析失败）；需要锁定版本时先 clone 仓库再用本地路径 `dsh plugin --profile web add ./command-setting`

## 配置与存储

插件不需要任何 `config`。**patch.yml 里若还留着 0.9.0 之前的 `config.hidden`，会被原样保留但不再生效**（命令隐藏已移除）。

唯一的持久化状态是 ask 开关：`~/.dsh/command-setting-ask.json`（纯文本 JSON，`{ 会话id: true }`，可手改、可随 `~/.dsh` 一起备份；删掉即所有会话回到普通模式）。

> 老版本写下的 `~/.dsh/command-setting-hidden.json` 已不再被读写，可以删除。

## 使用

### Ask 只问答模式（会话级）

```bash
/ask        # 开启：本会话只问答——禁改/禁建文件，可读文件与 run_code/内联命令验证
/ask off    # 关闭：恢复正常模式
```

- 或点击 composer 工具行最左侧的 **Ask** 按钮（Plan 按钮左侧）：按钮高亮 = 该会话 ask 已开启，再次点击退出；
- 开启期间 agent 的系统提示注入 ask 规则（专注解答、禁改文件、禁诱导改动提问），且 `edit` / `write` /
  `str_replace_editor` 与含写命令的 `bash` 在**执行前被硬拦**（返回拒绝说明）——即便你在对话里要求“直接改”，
  改动也不会发生；需要改动请先 `/ask off`；
- 只读验证手段不受限：`read` / `grep` / `glob` / `run_code`、`node -e` / `python3 -c`、运行已有脚本、
  `ping` / `curl` 等均可用于验证问题；
- 每次成功切换都会往会话里注入一条切换通知（如「用户已把本会话切回普通模式（ask 已关闭）：只读限制已解除」），
  所以 `/ask off` 之后 agent 立刻知道限制解除，不会再拿“当前是 ask 模式”当理由拒绝改动；
- 状态与会话绑定并持久化（`~/.dsh/command-setting-ask.json`），重启 dsh web 后开启 ask 的会话自动恢复。

### # 引用历史会话

在输入框输入 `#`（草稿开头或空格之后），弹出会话引用菜单：

```
#            # 打开完整候选列表（跨工作区）
#重构         # 按标题 / 会话 id / 工作目录过滤
```

- 菜单**只列会话**（`@` 会同时列文件与文件夹），候选项限定：**未归档**、**主代理**（不含 subagent 子会话）、**跨工作区**——候选按「**其他工作区**」（在前）与「**当前工作区**」（在后）分组，各按最近活动排序、各限 25 行；其他工作区的会话在描述里显示**工作区名字**（如 `intranet-aio`，未注册目录显示缩写的目录路径）与更新时间；
- 选中后插入原子引用（会话图标 + 标题），发送时序列化为 `@[标题](dsh-session:…)`，与 `@` 会话引用**完全等效**——宿主会把该会话的有界只读快照作为背景上下文交给模型；
- `#` 后接空白（例如写 Markdown 标题 `# 标题`）不会触发菜单，与 `@` 的 token 规则一致。

### 划词引用

1. 在对话消息里**拖动选中**一段文字（用户提问、模型回答、代码块都可以）；
2. 选区上方浮出「**引用**」小胶囊，点击它；
3. 选中内容会以 Markdown 引用块追加到输入框（例如 `> 这段文字`），光标落在引用块下方，接着提问即可：

```
> 之前的这段结论
> 第二行

（在这里继续问）
```

- 只对**消息区**的选区生效：输入框内选中文字不会弹浮标；
- 草稿里已经有 `@` 文件 / `#` 会话引用 chip 时，引用内容会追加在后面，不会破坏这些 chip；
- 浮标在滚动、点空白处或按 Esc 时自动消失。

## 设置页

本插件不再注册设置页区块（原先的「命令设置」区随命令隐藏功能一起移除）。

## 测试

```bash
node command-setting/test/smoke.mjs          # node 端：ask 判定/提示段/ask-state 端点/切换通知与拦截装卸 + 隐藏域已删护栏
node command-setting/test/client-smoke.mjs   # 浏览器端：模块加载/文案对齐 + # 检测/候选过滤/controller 包装与还原 + 划词引用（纯函数/伪 DOM 浮标）
```

## 变更日志

历次改动见 [CHANGELOG.md](./CHANGELOG.md)。
