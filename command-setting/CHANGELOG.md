# Changelog

本文件记录 `dsh-plugin-command-setting` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

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
