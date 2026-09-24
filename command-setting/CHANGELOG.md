# Changelog

本文件记录 `dsh-plugin-command-setting` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

## 0.8.4

- **修复 0.8.3 的 ask 切换通知被 v4 会话准入整条拒掉（静默退化）**：0.8.3 注入的那条 notice 用的是 v3 包装写法 `source: { kind: 'plugin', plugin: 'command-setting', form: 'notice' }`，而当前会话格式是 v4——message source 的 `kind` 必须是**生产者自有**的（非空字符串且不能是裸 `'plugin'`），落盘编码（`session-persistence-jsonl` 的 `encodeEvent` → `dsh-session-format-v3-to-v4` 的 `assertV4RowAdmission` → `source()`）会抛 `format v4 message requires a producer-owned source kind`。实测：把插件真实的 `buildAskNotice(true)` 交给 `releasedV4SessionFormatCodec.encodeEvent`，正是这条报错。后果是 `/ask`、`/ask off` 的切换通知进不了会话日志（转录里没有这条 notice，重载后模型看不到模式已变），ask 开关本身仍生效——0.8.3 想修的问题原样还在。
  - 现按 v4 升级器（`producerKind`）对未登记插件名的映射结果改写：`kind: 'plugin:dsh-plugin-command-setting'`，删掉 `plugin` 字段。
  - 同一 build 的内存 `session.append` 不筛 source，拒掉发生在写盘那一站；0.8.3 的 warn 文案（`ask notice inject failed`）与写盘 warn 哪个先出现取决于具体路径，两者都只记 warn、不整轮失败。
- 测试：node smoke 的 `ask notice` 断言改为钉新 kind（并断言 source 上不存在 `plugin` 字段）；新增一条不依赖宿主包的准入护栏——两条 notice 的 `source.kind` 必须非空、不得等于 `'plugin'`、不得携带 `plugin` 字段（该规则来自 `dsh-session-format-v3-to-v4` 的 `source()`）。把 `kind` 改回裸 `'plugin'` 时这条护栏与 kind 断言会一起 FAIL（已实测）。
- 未改行为的部分：`/ask`、`/ask off` 的开关语义、`ask:policy` 提示段、`tools.guard` 硬拦、侧文件恢复、重复开关不注入，均与 0.8.3 一致。

## 0.8.3

- **修复 `/ask off` 感知不到（ask 模式切换现在注入会话上下文）**：症状是关闭 ask 后 agent 仍按 ask 模式作答（继续以“当前是 ask 模式”为由拒绝改动文件）。根因有两条：
  - slash 命令走 `commands` 的 **log-only 生命周期**（`command/run` / `command/done` 只进会话日志），命令文本**不下发模型**——`/ask off` 这件事模型完全看不到；
  - `ask:policy` 系统提示段只是「有 / 无」的静态渲染：关闭时本会话的段被 disposer 摘掉，但模型拿到的是“少了点什么”，而不是“模式变了”，加上它自己历史里写过“当前处于 ask 模式”，就继续沿用旧结论。
  现与宿主 `dsh-plan-mode` 的 narration 同机制：`/ask`、`/ask off` 成功切换后调用 `agent.inject`，注入一条 `source: { kind: 'plugin', plugin: 'command-setting', form: 'notice' }` 的 user 消息（「用户已把本会话切换为 ask（只问答）模式…」/「用户已把本会话切回普通模式（ask 已关闭）：只读限制已解除…」），排在 next-step、不唤醒空闲会话，随下一次请求进入模型上下文并留在会话历史里供后续步骤/轮次读到；判定 `noop` 的重复开关不注入，注入失败只记 warn、不影响开关本身生效。
- `buildAskNotice(active)` 由 `lib/ask.js` 导出、`lib/index.js` 转发；新增 peer 声明 `@deepseek-ai/dsh-llm`（`^0.1.5-alpha.1`，`createUserMessage` 来自它，与 arena-v2 同口径）。
- 测试：node smoke 新增 `ask notice` 一组（切换注入一条 user notice + `form: 'notice'`/plugin 字段、进入装段、退出卸段卸 guard、重复 off 不注入、侧文件写在临时 HOME 且真实 `~/.dsh/command-setting-ask.json` 逐字节不变）。

## 0.8.2

- **补齐 client 侧短 id inject 的 peer 声明**：`client.js` 用 `["slots","locale","commandUi","sessions","remote","remote.commands"]` 注入，但 `peerDependencies` 里只有 `cordis` + `schemastery`——短 id 不进机器依赖判定，宿主改名或移除时扫描不会报错。现按 plugin-market 的口径补上提供这些服务的宿主客户端包：`@deepseek-ai/dsh-client-locale`（`locale`）、`@deepseek-ai/dsh-client-ui-session`（`sessions`）、`@deepseek-ai/dsh-client-ui-renderer`（`slots`）、`@deepseek-ai/dsh-client-ui-commands`（`commandUi`）、`@deepseek-ai/dsh-client-ui-workspace`（`remote`，`remote.commands` 是它挂载的命名空间服务）。范围 `*`，`peerDependenciesMeta` 里全部标 `optional`（与 plugin-market 一致）。
- 运行时行为、注入列表与设置页语义均未改动。

## 0.8.1

- **修复划词引用浮标 hover 发透**：hover 底色原用 `--dsw-alias-interactive-bg-hover`（半透明叠加色，在消息背景上看起来像变透明），改为不透明变量 `--dsw-alias-interactive-bg-hover-solid`（该变量缺失时回退到与常态一致的不透明菜单底色），并加深边框 `--dsw-alias-border-l3`；hover 反馈保留、不再发透。

## 0.8.0

- **划词引用（新增，浏览器端）**：在对话消息里拖动选中文字，选区上方浮出「**引用**」胶囊；点击把选中文本逐行加 `> `（空行保留裸 `>`）成 Markdown 引用块，追加到当前会话 composer 末尾——草稿非空时先空一行、引用块后再留一空行，光标停在下方，可直接接着提问：
  - **只对消息区生效**：`pointerup` 后读 `window.getSelection()`，要求非折叠、文本非空、落在 `[data-conversation-scroll]` 内且不在 `[data-composer-seat]`/输入控件里；浮标 `position:fixed` 贴选区上方，滚动/空白点击/Esc 自动消失；
  - **保住已有 chip**：点浮标时 `pointerdown` 阻止默认行为保住选区（按住期间忽略 `selectionchange`）；草稿里已有 `@`/`#` 原子引用 chip 时走 shell 的 `paste` 追加，否则用 `setDraft`（保证按段落换行）——`setDraft` 会把 chip 压成纯文本，故分流；
  - **依赖宿主契约**：`[data-conversation-scroll]`/`[data-composer-seat]` DOM 标记与 `ctx.get("conversation").input.shell(id)`（`SessionInput` 的 `state`/`setDraft`/`paste`）；缺失时特性静默不启用，无 DOM 环境（测试/非浏览器）返回 undefined。
- 测试：client-smoke 新增 `quoteSelectionText`（逐行 `>`、空行、CRLF、空白/非字符串）、`appendQuoteToDraft`（空草稿/已有草稿/空引用）、`quoteAnchor`（消息区命中、折叠/空文本/composer/区外/输入控件/零矩形/null 拒绝）、`insertQuote`（setDraft 追加、空选区 no-op、有 chip 走 paste、缺会话/缺 shell）与伪 DOM 下的 `installQuoteSelection`（按钮挂载、监听安装、显示与定位、点击写入草稿、折叠隐藏、dispose 移除监听与按钮）。

## 0.7.2

- **跨工作区候选展示工作区名字**：`#` 菜单「其他工作区」分组里，会话行的位置信息由「缩写目录路径」改为**工作区名字**（`workspaces` 快照 `items` 的 `title`，如 `intranet-aio` / `dsh-browser`），再接相对更新时间；未注册为工作区的目录没有名字，仍退回缩写的目录路径。当前工作区分组的行保持只显示时间（位置即当前工作区，无需重复）。
- 测试：client-smoke 新增 `hashWorkspaceNames`（path → title 映射、空 title/空 path/非对象条目跳过）、`hashEntries` 携带工作区名、`buildHashRows` 优先显示名字且未注册目录回退路径、apply 端到端装配断言工作区名。

## 0.7.1

- **修复 `#` 只能引用当前工作区会话（跨工作区失效）**：候选原先复用宿主的 `remote.sessionReferenceResolver.candidates`，而该接口默认只取 `candidateLimit`（50）条、且**同 cwd 优先**排序后 `slice`——当前工作区会话一多（本机实测 318 个），跨工作区候选被整段挤出，表现就是「# 只能 attach 当前工作区会话」。改为**直接读客户端会话列表**（`sessions` 快照，含全部工作区，自带 `displayTitle`/`cwd`/`origin`/`updatedAt`）自行组装候选：
  - 分组呈现「**其他工作区**（在前）/ **当前工作区**（在后）」，各自按最近活动排序、各限 25 行，跨工作区会话始终可见；无法确定当前工作目录时退回单一按最近活动排序的列表；
  - query 仍匹配标题 / 会话 id / 工作目录（大小写不敏感）；继续排除自身、subagent 子会话、已归档会话，并额外跳过空会话（`blank`，没有可引用的历史）与非 ASCII id；
  - 规范 mention 改由本插件生成（`@[label](dsh-session:<base64url(JSON id)>)`，label 转义 `\`/`]`），与宿主 `formatSessionReferenceMention`/`encodeSessionReferenceUri` 逐字节一致（已用真实宿主编解码器对拍），因此选中后的引用仍与 `@` 会话引用完全等效；
- 测试：client-smoke 新增 mention 编码对拍（URI 载荷 + label 转义 + 空 label 回退）、`hashEntries`（自身/subagent/空/归档剔除、当前 cwd 解析、same 标记、标题/cwd/id 三种 query 命中、缺失列表容错、非 ASCII id 跳过）、`buildHashRows`（其他工作区分组在前、当前工作区在后、分组内按最近活动排序、跨工作区显示 cwd、home 缩写、缺 cwd 文案、单列表回退、每组 25 行上限、非法输入容错）。

## 0.7.0

- **`#` 引用历史会话（新增，浏览器端）**：composer 输入 `#` 弹出会话引用菜单，选中插入与 `@` 会话引用**完全等效**的原子 mention（`@[标题](dsh-session:<base64url id>)`，宿主 `session-reference` 服务照常校验并捕获该会话的有界只读快照）。与 `@` 的差别：**只列会话不列文件**，且仅限「**未归档** + **主代理** + **跨工作区**」——
  - 未归档：排除 `ctx.workspaces` 快照 `archivedSessionIds` 中的会话；
  - 主代理：排除客户端会话列表里 `origin === 'subagent'` 的子会话；
  - 跨工作区：不按当前工作目录过滤，非当前工作区的会话在描述中显示其工作目录（home 缩写为 `~`）与相对更新时间；
- **宿主适配（input-trigger 只认 `/` 与 `@`）**：`TriggerChar` 是封闭联合，`#` 无法直接 `registerSource`。实现为给每个会话 controller 包一层——把活跃 `#token` 在**同一 span** 改写成等价 `@token` 交给宿主探测器，再拦截该 controller 的 source roster，使该 hit 只解析到插件的 `#` 源（不混入 `@` 的文件/会话统一菜单）；词边界/空白规则与 `@` 一致（`#` 后接空白不触发，Markdown 标题不受影响）。`#ab` 与 `@ab` 的 hit 字段完全相同，宿主 `track` 的 `same` 短路会把旧 source 的菜单留在屏上，故哈希性质切换（`#`↔`@`）时先关菜单再委托，确保 source 正确换面。停用插件时还原 controller 与原 `@` 行为；
- **数据与降级**：候选复用 `remote.sessionReferenceResolver.candidates`（标题/mention/cwd/时间），归档集与主代理判定分别读客户端 `workspaces` / `sessions` 快照；`inputTriggers` 或任一服务缺失时特性静默不启用，其余命令设置功能不受影响；
- 测试：client-smoke 新增 `hashTokenAt`（词边界/空白/非法输入）、`buildHashRows`（归档/subagent/无 mention 剔除、同/跨工作区描述、home 缩写、空输入容错）、`installHashTrigger`（源注册、已有/晚建 controller 包装、`#`→`@` 改写与 roster 路由、plain `@` 不受影响、frozen 不触发、claimed 仍触发、dispose 全量还原）。

## 0.6.0

- **代码重构与瘦身（纯重构，外部行为与契约不变：HTTP 端点 / 响应字段 / settings 命名空间与 hidden 语义 / 受保护命令 / /ask 会话语义与侧文件格式 / 注入契约 / 浏览器槽位与按钮行为全部不变）**：
  - **宿主端按域拆 4 文件**：单文件 `lib/index.js`（约 610 行）拆为 `commands`（命令隐藏域：COMMAND_NAME / DEFAULT_HIDDEN / PROTECTED / cleanHidden + 菜单过滤 shadowCommandList + 命令面全集 collectKnown + 归档清理 sweepArchived）、`ask`（ask 只问答模式域：isBashWrite / askToolDenyReason / buildAskSection / 状态侧文件读写 + 会话级控制器 createAskController——per-agent 拦截安装卸载、/ask 命令注册、agent/created|disposed 生命周期恢复）、`routes`（sendJson / readBody / registerWebRoute + catalog / set / ask-state 三端点）、`index.js` 瘦身为 96 行入口（name/inject/Config/apply 装配 + settings 命名空间注入）；
  - **共享状态收编**：apply 内部分散闭包改为 `env` 共享对象（ctx / original 未过滤命令面 / hiddenSet / scope / notifyChange / ask 控制器），三个端点与清理逻辑经 env 读写，模块间依赖单向无环；
  - **client 保守瘦身**：Plan / Ask 两个外置按钮注入块的重复 `execute` 闭包（20+ 行）收编为模块级 `executeSlashCommand`（wire 契约注释随函数归位）；
  - **死代码清理**：删除零引用的 `askActiveFor`（无调用方、index 未导出）；模块级导出面保持原样（`askToolDenyReason` / `buildAskSection` 仍由 index 转发）。
  - **测试护栏**：npm test（smoke ALL PASS + client-smoke PASS）全绿。

## 0.5.0

- **Ask 只问答模式（会话级，/ask + Ask 按钮）**：composer 工具行 Plan 按钮左侧新增 Ask 按钮（`conversation.input.left` 槽 order -1），点击执行 `/ask` / `/ask off`；开启后该会话进入只问答模式——
  - **专注解答 + 禁改文件（执行级硬拦）**：注入 `ask:policy` 系统提示段（专注问答、可读文件与 run_code/内联命令验证、禁改/禁建文件、禁诱导性改动提问如“需要我帮你改 xxx 吗”）；同时在该会话 agent.ctx 注册 `tools.guard`——`edit` / `write` / `str_replace_editor` 与含写命令/重定向的 `bash`（cp/mv/rm/tee/sed -i/>/>> 等）在 dispatch 前一律拒绝并返回说明，模型层面无法绕过；用户强行要求“直接改”也不会发生（需先 `/ask off`）；
  - **只读验证不受限**：`read` / `grep` / `glob` / `run_code`、`node -e` / `python3 -c`、运行已有脚本、`ping` / `curl` 等放行；
  - **会话级 + 重启恢复**：状态按会话存储（`~/.dsh/command-setting-ask.json`），`/ask` 命令只切换当前会话；dsh web 重启后 `agent/created` 时自动恢复拦截（`GET /command-setting/ask-state?session=<id>` 供按钮回显激活态）；子代理/其它会话不受影响；
  - `ask` 加入受保护命令（不可隐藏——隐藏会失去唯一退出通道）。

## 0.4.2

- **`cordis` peer 从 `^4.0.1` 改为 `^4.0.2`**：跟随 dsh 0.1.2-alpha 通道（alpha 全家桶统一声明 `cordis ^4.0.2`），与仓库其它插件对齐。

## 0.4.1

- **补上 `repository` 字段**（`WensH77/dsh-plugins#path:command-setting`）：插件市场的「检查更新 / 更新 / 帮我更新」按 *市场安装记录 > 包内 repository > profile 依赖的 `github:` spec* 三级回退取仓库地址。此前本包缺第二级，若不是用 `github:` spec 安装（例如 `git+https://`、tarball、`link:`），更新通道会直接报「git 通道需要 GitHub 仓库地址（repository 字段缺失）」。

## 0.4.0

- **修复归档清理误删有效隐藏（隐藏的命令重新可见）**——0.3.2 的 sweep 存在两条误删路径：
  - **浏览器贡献命令（/model 等）必然被清**：它们只存在于客户端 `commandUi.live.contributions`，node 端命令面看不到；catalog 无条件 sweep 会把它们的 hidden 当幽灵移除 → 菜单恢复显示。修复：客户端 catalog 请求统一携带 `contributions` 参数（`load()` 与 `syncHidden()` 共用 `catalogUrl` helper，空贡献面也带空参数表示「已知为空」）；服务端仅在收到该参数时才执行 sweep，并把贡献命令并入已知命令面
  - **启动时 sweep 误删 agent-scoped 隐藏**：apply 末尾立即清理，此刻通常无 live 会话（无 agent 命令面）→ `/compact` 等 preset 命令的 hidden 被清。修复：删除启动时清理；sweep 增加「存在 ≥1 个 live 会话」前置条件，仅在设置页读取目录时惰性执行
- sweep 全集修正为「浏览器贡献命令 ∪ 全局命令 ∪ 所有 live 会话 agent 命令」；任一读取失败/服务缺失/无 live 会话 → 放弃清理（有效隐藏永不丢失）
- 测试：smoke 新增「贡献命令受保护」「无 contributions 参数不清理」「命令面完整时有效隐藏全部保留（不删不写）」；client-smoke 断言 load 与 syncHidden 的 catalog URL 都携带 contributions
- README：归档清理小节重写（安全侧条件 + 菜单可见 vs 设置页可见的区分）

### 命令隐藏管理与归档清理（并入 0.4.0，原 0.3.2）

- **归档清理**：hidden 中已不存在的命令名（命令被卸载/更名后的残留）主动检测并自动清理——启动时与每次 `catalog` 读取时比对「全局命令 ∪ 所有 live 会话的 agent 命令」全集，幽灵条目自动移除并持久化（`sweepArchived`）。命令面不可靠（sessions 缺失/任一 agent 读取失败）时放弃清理，防误删其他预设的 agent-scoped 命令
- **catalog 端点加 try/catch**：host `commands.list` 异常路径不再外抛未捕获错误，返回 500 JSON（与 `set` 端点行为对称）
- **客户端 candidates shadow 加数组防御**：host 返回非数组时不再崩命令菜单（与 `sessionRows` 的防御一致）
- **set 端点加固**：body 超 64KB 截断拒绝；重复条目去重；`req.body` 预解析兜底（防 webServer 升级后 body 事件不再到来导致端点挂起）
- 测试：smoke 新增幽灵清理（含 agent-scoped 保留、sessions 缺失放弃清理）与 set 端点校验（400/去重/受保护剔除/超限）；client-smoke 补交互测试（controller 聚合/toggle 成功与失败回滚、candidates/matchEnter/matchSpace shadow、`commands/change` 刷新、dispose 恢复）

## 0.3.1

- 外置 Plan 按钮补传 `images` 参数：`commands/execute` 的 wire 契约为 `(agentId, line, images)`，`images` 为必填严格数组参数；此前只传 `(sid, line)` 导致网关参数校验失败、按钮 title 报错，现与内置 Plan 芯片一致补传 `[]`

## 0.3.0

- 在 `+` 和 `/` 菜单隐藏/显示 slash 命令：全局 `settings.yaml` 持久化、保护 plan/goal、host + browser 双端过滤
- composer 外置 plan-mode 开关
- dispose 时恢复命令面 + 幂等路由注册
