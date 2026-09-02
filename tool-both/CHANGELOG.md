# Changelog

本文件记录 `dsh-plugin-tool-both` 的历次改动（由 git 提交历史整理）。安装、使用、仓库结构见 [README.md](./README.md)。

## 0.2.4

- **预设重新生成，BOTH 恢复全能力**：`preset/both/agent.cordis.yml` 按 dsh 0.1.2-alpha.4 自带的 `standard` 预设整体重做（原文件是 0.1.0-rc.8 时代的快照，一直没跟上）。dsh 自 alpha.3 起把 `/goal` 命令从 host 平面移到 preset 层（host 显式禁用、各 preset 自行挂载），旧快照因此缺了 `command-goal` 行——BOTH 模式会话里 `/goal` 斜杠命令消失。本次重做同步带回全部增量：goals 段补挂 `@deepseek-ai/dsh-command-goal`、subagent 配置补 `modelSelectionSettings: true`、`tool-web` 的 `fetch` 改回 `true`，并删去已失效的 `registerContinuableSetup` 时代注释。
- 运行时已安装副本（`~/.dsh/.agent-presets/both/agent.cordis.yml`）已同步；新会话即生效。

## 0.2.3

- **peer 范围切到 alpha 线**：`@deepseek-ai/dsh-home-paths` 从 `^0.1.0-rc.8` 改为 `^0.1.2-alpha.4`、`cordis` 从 `^4.0.1` 改为 `^4.0.2`——跟随 dsh 0.1.2-alpha 通道（`alpha` dist-tag 全家桶互相声明 `^0.1.2-alpha.4` / `cordis ^4.0.2`）。semver 下 `^0.1.2-alpha.4` 只匹配同一元组的预发布（上游切 `0.1.3-alpha` 需再 bump）；安装/运行期不受其强制，旧 rc 宿主照常运行。

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
