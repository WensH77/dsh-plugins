# Changelog

本文件记录 `dsh-plugin-tool-both` 的历次改动（由 git 提交历史整理）。安装、使用、仓库结构见 [README.md](./README.md)。

## 0.2.0

- 移除设置页「工具呈现模式」卡片：预设选择器里的「BOTH模式」选项与自动安装的预设就是全部界面
- 删除 `lib/client.js`（浏览器层设置卡片）
- 删除 `/tool-both/status`、`/tool-both/install` 端点与 `webServer`/`settings` 注入
- 仅保留 host 层激活时安装 both 预设（幂等、不覆盖手改）

## 0.1.0

- 双工具通道编排（`lib/index.js`、`lib/client.js`、`lib/presentation.js`）
- `preset/both` 预设（`agent.cordis.yml`、`preset.yml`）
- smoke 测试
