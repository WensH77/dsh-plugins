# dsh-plugin-command-setting

dsh web 命令设置插件：

- **命令菜单管理**：从 “+” / “/” 命令菜单中隐藏/显示指定 slash 命令（默认隐藏 export / feedback / permission），设置页新增「命令设置」区
- **外置 Plan 按钮**：composer 工具行左侧新增 Plan 切换按钮（点击调用 /plan）
- **Ask 只问答模式（/ask）**：composer 工具行 Plan 按钮**左侧**新增 Ask 按钮（点击调用 /ask）——开启后该会话进入**只问答模式**：agent 只回答问题、可读文件与 run_code 验证，**禁止改动或创建任何文件**（执行级硬拦，模型层面无法绕过、用户强行要求也拦不住），并禁止诱导性提问（如“需要我帮你改 xxx 吗”）
- **全局生效**：命令菜单管理配置保存在全局 settings.yaml（`command-setting` 命名空间），对所有会话一致生效；设置页目录不随当前会话漂移，也不会被某个会话的局部命令面悄悄改写。**ask 模式为会话级开关**（侧文件 `~/.dsh/command-setting-ask.json` 持久化，dsh web 重启后恢复）

## 功能速览

| 能力 | 说明 |
|---|---|
| 隐藏命令 | 从命令菜单移除，直接斜杠输入也不再解析为命令；设置页可随时恢复 |
| 受保护命令 | `plan` / `goal` / `ask` 为系统命令，**不可隐藏**（读/写两侧强制） |
| 全局持久化 | `hidden` 列表写入 settings.yaml（`command-setting` 命名空间），热更新即时生效 |
| 归档清理 | hidden 中已不存在的命令名（命令被卸载/更名后的残留）**主动检测并自动清理**：设置页读取目录时比对「浏览器贡献命令 ∪ 全局命令 ∪ 所有 live 会话的 agent 命令」全集，幽灵条目自动移除并持久化。**仅在命令面可信时清理**（客户端已上报贡献命令面、存在 live 会话、全集收集成功）——有效隐藏（贡献命令 /model、agent 命令、全局命令）永不被误删 |
| 双端过滤 | 服务端过滤 host 命令；浏览器端过滤客户端贡献命令（如 /model） |
| Plan 切换 | composer 工具行左侧独立按钮，点击执行 `/plan`（进入）或 `/plan off`（退出），替换内置的 Plan 芯片 |
| Ask 只问答模式 | composer 工具行最左侧独立按钮（Plan 左侧），点击执行 `/ask`（进入）或 `/ask off`（退出）；开启后会话级只读——禁改/禁建文件（`tools.guard` 执行级硬拦 + 系统提示约束）、禁诱导改动提问 |

## 工作原理

### 两个半区

| 文件 | 角色 |
|---|---|
| `lib/index.js` | **Node 端** Cordis 插件：shadow `commands.list` 过滤 host 命令；`GET /command-setting/catalog`（未过滤目录）、`POST /command-setting/set`（写 hidden）、`GET /command-setting/ask-state`（会话 ask 开关）；settings 命名空间持久化 + `commands/change` 通知；`/ask` 命令 + 会话级 ask 拦截安装/恢复（`tools.guard` + `systemPrompt` 段） |
| `lib/client.js` | **浏览器端** bundle：设置页 section（`settings.section` 插槽）+ 命令目录过滤（shadow `commandUi.candidates/matchEnter/matchSpace`）+ Plan 按钮 + Ask 按钮（`conversation.input.left` 插槽，Ask 在 Plan 左侧） |

### Ask 只问答模式（会话级）

1. **开关**：composer 工具行 Ask 按钮（Plan 左侧，order -1）点击执行 `/ask`（进入）或 `/ask off`（退出）；直接输入 `/ask` 亦可。状态写入 `~/.dsh/command-setting-ask.json`（`{ 会话id: true }`），dsh web 重启后 `agent/created` 时自动恢复（`GET /command-setting/ask-state?session=<id>` 供按钮回显）。
2. **提示约束**：开启时给该会话注入 `ask:policy` 系统提示段——专注问答、可读文件与 run_code/内联命令验证；**禁止改动或创建文件**；用户强行要求“直接改”时拒绝并提示先 `/ask off`；**禁止诱导性追加提问**（“需要我帮你改 xxx 吗”“需要我现在改 xxx 吗”“要不要顺手把 xxx 也改了”等）。
3. **执行级硬拦（tools.guard）**：注册在该会话 agent.ctx 的工具守卫在每次工具 dispatch 前判定——`edit` / `write` / `str_replace_editor` 一律拒绝；`bash` 检测到写命令/重定向（`cp`/`mv`/`rm`/`tee`/`sed -i`/`>`/`>>` 等）也拒绝；`read` / `grep` / `glob` / `run_code` 与只读 bash（`node -e` / `python3 -c` / 运行已有脚本 / `ping` / `curl`）放行。守卫返回拒绝文案而非静默放行，模型层面无法绕过（与 arena-v2 的 guard 同机制）；关闭 ask（`/ask off`）或会话销毁时随 disposer 卸载。
4. **范围**：ask 为**会话级**——只影响开启它的会话主代理，其它会话、子代理不受影响；只读约束只作用于本会话的工具面，不改变全局 sandbox/approval 策略。

### 隐藏一条命令会发生什么

1. 设置页点「隐藏」→ `POST /command-setting/set` → 写入 settings.yaml（受保护命令被剔除）
2. 服务端 `commands.list` 过滤 → 命令从菜单移除、直接输入 `/name` 不再解析
3. 浏览器端 shadow `commandUi` 三入口 → 客户端贡献命令（如 /model）同样被过滤
4. `commands/change` / `settings/document-updated` 事件 → 浏览器目录即时刷新，无需重启

### 设置页目录的组成

目录 = 全局命令（host 注册）+ 当前会话的 agent 作用域命令 + 浏览器端贡献命令（如 /model），
全部可切换显示/隐藏。`catalog` 端点带 `?session=<id>` 时按 Agent 对象解析作用域命令
（如 /compact），隐藏过的 agent 作用域命令仍会列出以便恢复。**不做按会话的裁剪**：
hidden 是全局设置，绝不会被某个会话更窄的命令面悄悄改写。

### 归档清理（幽灵条目自动收敛）

hidden 是全局设置且不做按会话裁剪，但**已不存在的命令名会被主动清理**：设置页读取目录时
（客户端上报浏览器贡献命令面 + `?session=<id>`），用「浏览器贡献命令 ∪ 全局命令 ∪ 所有
live 会话的 agent 命令」作为已知命令面，不在其中的 hidden 条目（插件卸载、命令更名、预设
移除后的残留）自动从 settings.yaml 移除并通知刷新——无需手改文件。

**安全侧（有效隐藏永不丢失）**：
- 贡献命令（如 /model）只存在于浏览器，node 端看不到——清理必须在客户端上报贡献命令面
  （catalog 请求带 `contributions` 参数）后才执行；参数缺失（外部/旧客户端调用）不清理；
- 启动时不清理（此刻通常无 live 会话、也无贡献面，命令面不完整）；
- 无 live 会话、sessions 服务缺失、任一 agent 命令面读取失败时**放弃本次清理**。

**菜单可见 vs 设置页可见**：设置页目录是**未过滤视图**——隐藏的命令会带着"已隐藏"徽标
列出来（这是为了能恢复显示）；**命令菜单和直接斜杠输入**中的隐藏才真正生效（双端过滤）。

### 会话模式限制（沿用 dsh 自身机制）

命令是否在当前会话可用，由 dsh 的 agent preset（会话模式）决定 —— 命令只在其挂载的
agent 组合中注册/显示。极简模式（minimal）会话不包含的命令天然不出现，即使设置页选择了显示；
本插件不做自定义模式过滤。

## 安装（GitHub 公开仓库，无需发布 npm）

前置：`dsh plugin` 命令会把参数转发给 **PATH 上的 pnpm**（`npm i -g pnpm` 或 corepack）。仓库是**公开**的，直接安装即可，无需任何凭据或配置。

```bash
# 1) 安装（公开仓库，HTTPS 拉取，无需 SSH key；跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:command-setting'
```

> 装了 GitHub SSH key 的机器也可用简写（等价，走 SSH）：`dsh plugin --profile web add 'github:WensH77/dsh-plugins#path:command-setting'`

```yaml
# 2) ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: command-setting
      name: dsh-plugin-command-setting
      config:
        hidden: ['export', 'feedback', 'permission']
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

## 配置（settings.yaml）

```yaml
command-setting:
  # 全局隐藏的命令（默认 export / feedback / permission）
  hidden:
    - export
    - feedback
    - permission
```

`config.hidden`（patch.yml 中的配置）是**初始默认值**，一旦在设置页编辑过，settings.yaml
中的值即成为事实来源（两者合并，settings.yaml 优先）。`plan` / `goal` / `ask` 无论配置如何都不可隐藏。

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
- 状态与会话绑定并持久化（`~/.dsh/command-setting-ask.json`），重启 dsh web 后开启 ask 的会话自动恢复。

## 设置页

- 入口：设置页（General）中的「命令设置」区，位于 agent-presets 之后
- 每条命令显示名称、说明、当前状态徽章（已隐藏 / 显示中 / 系统），一键切换
- 修改立即写入 settings.yaml 并全局生效（commands/change 通知刷新）

## 测试

```bash
node command-setting/test/smoke.mjs          # node 端：catalog/隐藏过滤/作用域/ask 判定
node command-setting/test/client-smoke.mjs   # 浏览器端：模块加载/文案对齐/ask 按钮导出
```

## 变更日志

历次改动见 [CHANGELOG.md](./CHANGELOG.md)。
