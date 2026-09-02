# Changelog

本文件记录 `dsh-plugin-tool-both` 的历次改动（由 git 提交历史整理）。安装、使用、仓库结构见 [README.md](./README.md)。

## 0.2.2

- **smoke test 改为零外部依赖**：此前 `test/smoke.mjs` import 了 `js-yaml` 与 `@deepseek-ai/cordis-plugin-include`（entryListSchema），工作区没装这两个包，`npm test` 直接 `ERR_MODULE_NOT_FOUND`。运行时本就不需要它们（`lib/` 只用 node 内置模块 + 两个宿主提供的 peer）。现在 preset 校验改为对**静态 shipped 文件**的结构化检查（preset.yml 的 name/description/order 行、composition 的顶层行要么是 group 要么有 name、tool-presentation 行含 `mode: both`），不再做 YAML/宿主 dialect 解析——文件随 preset 原样发布，结构固定，字符串级断言足够。

## 0.2.1

- **补上 `repository` 字段**（`WensH77/dsh-plugins#path:tool-both`）：插件市场的「检查更新 / 更新 / 帮我更新」按 *市场安装记录 > 包内 repository > profile 依赖的 `github:` spec* 三级回退取仓库地址。此前本包缺第二级，若不是用 `github:` spec 安装（例如 `git+https://`、tarball、`link:`），更新通道会直接报「git 通道需要 GitHub 仓库地址（repository 字段缺失）」。

## 0.2.0

- 移除设置页「工具呈现模式」卡片：预设选择器里的「BOTH模式」选项与自动安装的预设就是全部界面
- 删除 `lib/client.js`（浏览器层设置卡片）
- 删除 `/tool-both/status`、`/tool-both/install` 端点与 `webServer`/`settings` 注入
- 仅保留 host 层激活时安装 both 预设（幂等、不覆盖手改）

## 0.1.0

- 双工具通道编排（`lib/index.js`、`lib/client.js`、`lib/presentation.js`）
- `preset/both` 预设（`agent.cordis.yml`、`preset.yml`）
- smoke 测试
