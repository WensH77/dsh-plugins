# Changelog

本文件记录 `dsh-plugin-command-setting` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

## 0.3.1

- 外置 Plan 按钮补传 `images` 参数：`commands/execute` 的 wire 契约为 `(agentId, line, images)`，`images` 为必填严格数组参数；此前只传 `(sid, line)` 导致网关参数校验失败、按钮 title 报错，现与内置 Plan 芯片一致补传 `[]`

## 0.3.0

- 在 `+` 和 `/` 菜单隐藏/显示 slash 命令：全局 `settings.yaml` 持久化、保护 plan/goal、host + browser 双端过滤
- composer 外置 plan-mode 开关
- dispose 时恢复命令面 + 幂等路由注册
