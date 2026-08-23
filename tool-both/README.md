# dsh-plugin-tool-both

一键开启 dsh **「both」工具呈现模式**：模型同时看到全部原生工具 schema 与 `run_code`（生成式 SDK），**没有 code-only 限制**——直接调 `read`/`edit`/`bash` 正常执行，模型也可以写 `run_code` 程序把多步操作一次往返批量编排。

> 背景：dsh 的 `code` 预设（PTC 模式）强制「只能直接调 run_code」，模型不遵守时每个直调都会刷 `unknown tool "read": only run_code is callable directly` 报错；`standard` 预设只有原生直调。`both` 是两者并存、互不限制的第三种呈现。

## 它做了什么

| 部分 | 层 | 作用 |
|---|---|---|
| `lib/index.js` | host 层 | 激活时自动把 **「BOTH模式」预设** 安装到 `~/.dsh/.agent-presets/both`（幂等、不覆盖已有文件） |
| `lib/presentation.js` | agent 层 | 呈现行组件（`./presentation`）：可挂进**任意 agent preset**，默认 `mode: both`（可配 native/code），适用于已有自定义预设的场景 |
| `preset/both/` | agent 层 | 现成的 both 预设：标准模式全部组成 + `@deepseek-ai/dsh-agent-tool-presentation`（`mode: both`）一行 |

> 设置页的「工具呈现模式」卡片（状态展示 + 一键补装）已按用户反馈移除——**选项（预设选择器里的「BOTH模式」）与预设（自动安装）就是全部界面**，不再有设置页展示。

`both` 模式需要 host 的 code runtime（`@deepseek-ai/dsh-code-runtime-worker-thread`）——dsh web 的 bundle 自带，直接可用。

## 安装（本地 / 分发）

插件是普通 JS 插件，无需构建。安装后重启 dsh web 生效：

```bash
# 本地仓库安装
dsh plugin --profile web add /Users/wens.huang/Documents/dsh-plugins/tool-both

# 或分发：仓库推送到 GitHub 后（公开仓库）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:tool-both'
```

启用（补丁层追加；`tool-both` 是 host 层插件，行为是安装预设）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: tool-both
      name: dsh-plugin-tool-both
```

```bash
dsh web   # 重启
```

## 使用

激活时插件已把 both 预设写入 `~/.dsh/.agent-presets/both`（预设发现实时重读，无需重启即可看到），任选其一：

- **按会话**：新会话的预设选择器里选「BOTH模式」（PTC 模式 = code、标准模式 = native 均保持原样）。
- **设为默认**：`~/.dsh/settings.yaml` 里 `agent-presets.default: both`（之后新建的会话默认 both，旧会话保持原预设）。

> 插件不再提供设置页卡片（已按用户反馈移除）；确认安装是否成功：`~/.dsh/.agent-presets/both/` 下应有 `agent.cordis.yml` 与 `preset.yml`，或直接看预设选择器里是否出现「BOTH模式」。

## 给已有自定义预设加 both（不换预设）

把 this 包作为 profile 依赖安装（见上，`dsh plugin add` 即可，无需 patch 启用——预设 loader 按包名解析），然后在你的 `agent.cordis.yml` 追加一行：

```yaml
- id: tool-both-presentation
  name: dsh-plugin-tool-both/presentation
```

默认 `mode: both`；想复用同一行做别的呈现可加 `config: { mode: code }` / `{ mode: native }`。

> 注意：`presentAs` 要求 agent 作用域上下文——呈现行**只能**放进 agent preset 组成（agent.cordis.yml），不能放进 profile 补丁（host 层会直接抛错）。这就是为什么预设里用的是内置的 `@deepseek-ai/dsh-agent-tool-presentation` 行（与 dsh 版本对齐），而本包额外导出一个同名替代行。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-tool-both   # 移除依赖 + patch.yml 条目
rm -rf ~/.dsh/.agent-presets/both                      # 手动删除安装的预设（如需）
```

## 仓库结构

```
tool-both/
├── lib/
│   ├── index.js          # host 层：激活时安装预设
│   └── presentation.js   # agent 层：呈现行组件（./presentation，默认 both）
├── preset/both/          # 分发的 both 预设（标准组成 + presentation both）
│   ├── agent.cordis.yml
│   └── preset.yml
├── test/smoke.mjs        # 导出 / 预设安装 / 幂等 / loader 方言校验
└── package.json
```

## 测试

```bash
node tool-both/test/smoke.mjs    # 导出 / 预设安装 / 幂等 / 不覆盖手改 / overwrite / loader 方言加载
```

## 已知限制

- **预设是快照**：`preset/both/agent.cordis.yml` 基于安装时 dsh 自带的 `standard` 预设复制（标准全部组成 + presentation 行）。dsh 后续版本给标准预设加新行时，需要重新生成本包的预设（重新 `cp` standard 并追加 presentation 行）。手改过 `~/.dsh/.agent-presets/both/*` 的部署不会被插件覆盖（安装幂等跳过已存在文件）。
- **需要 code runtime**：`both` 与 `code` 一样依赖 host 的 code runtime；没有 runtime 的部署会在挂载时失败（报出 `tool-presentation` 行）。dsh web 自带 runtime，普通使用无感。
- **呈现行不能放 host 层**：`presentAs` 需要 agent 作用域，`./presentation` 行只适用于 agent preset 组成。
