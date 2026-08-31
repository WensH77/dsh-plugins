# Changelog

本文件记录 `dsh-plugin-command-setting` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

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
