# Changelog

本文件记录 `dsh-plugin-command-setting` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

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
