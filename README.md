# dsh-plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）web profile 编写的一组插件。
仓库采用 **pnpm 子目录依赖** 结构：每个插件是一个独立的包目录，可直接从 GitHub 安装，无需发布 npm。

## 插件清单

| 插件 | 目录 | 功能 |
|---|---|---|
| **chat-rollback** | [`chat-rollback/`](chat-rollback/README.md) | 对话回滚：在用户消息操作条（与复制按钮同行）点击回滚到这条消息之前，创建新会话并预填该消息文本，附带轮次快照的代码回滚、fork 快照继承、原会话自动归档 |
| **command-setting** | [`command-setting/`](command-setting/README.md) | 命令设置：从 “+” / “/” 命令菜单隐藏/显示 slash 命令（默认 export/feedback/permission），设置页管理 + 外置 Plan 切换按钮 |
| **model-arena** | [`model-arena/`](model-arena/README.md) | 模型竞技场（挑战模式）：空会话 hero 视图旁开启「竞技场」toggle，选择场景与竞技场模型后一次提问，自动执行「模型1 回答 → 模型2 质疑 → 模型1 修正 → 模型2 终评」 |
| **plugin-market** | [`plugin-market/`](plugin-market/README.md) | 插件市场（基础版，仿 [dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub)）：设置 → 插件页新增「插件市场」tab——两阶段安装（隔离拉取 + 分层安全审查 + 确认安装，任务可视化、可中断）、检查更新/更新（git 通道，更新附带与本地已装代码的差异审查）、卸载、开关、仓库地址管理（保存用户填写的仓库）、待重启提示、清理缓存；侧边栏 dsh 版本状态灯（启动+每小时检测 deepseek-harness 新版本，点击开新会话分析破坏性更新） |
| **session-export** | [`session-export/`](session-export/README.md) | 会话导出长图：会话标题栏「导出长图」按钮，把当前会话从第一条到最新一条导出为长图 PNG——只展示用户输入与模型输出，自动剔除思考（Think/reasoning）与工具调用等过程内容（GFM 子集 Markdown 排版、主题取色、长会话自动拆多张） |
| **tool-both** | [`tool-both/`](tool-both/README.md) | 工具呈现模式（both）：激活时自动安装「BOTH模式」预设——原生工具直调与 run_code 并存、无 code-only 限制（消除 PTC 模式下大量 `unknown tool "read"` 报错），另提供可挂进任意 agent preset 的呈现行组件 |

各插件目录内有完整的独立 README（功能、原理、安装、配置、已知限制）。

## 快速安装（dsh web）

前置：`dsh plugin` 命令会把参数转发给 **PATH 上的 pnpm**（`npm i -g pnpm` 或 corepack）。仓库是**公开**的，直接安装即可，无需任何凭据或配置。

**chat-rollback / command-setting**（普通插件，git 通道安装）：

```bash
# 安装两个插件（公开仓库，HTTPS 拉取，无需 SSH key；跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:chat-rollback'
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:command-setting'
```

> 装了 GitHub SSH key 的机器也可用简写（等价，走 SSH）：
> `dsh plugin --profile web add 'github:WensH77/dsh-plugins#path:chat-rollback'`
> （command-setting 同理）

**plugin-market**（插件管理器本身，建议本地/克隆安装，安装后可管理其它插件）：

```bash
git clone https://github.com/WensH77/dsh-plugins.git
dsh plugin --profile web add ./plugin-market
```

**tool-both**（一键开启 both 工具呈现模式，普通插件，git 通道安装）：

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:tool-both'
```

**session-export**（会话导出长图，普通插件，git 通道安装）：

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:session-export'
```

**model-arena**：手动安装（见 [model-arena/README.md](model-arena/README.md)）。

安装后在补丁层启用（chat-rollback / command-setting / tool-both / session-export 示例；plugin-market 为 bundle 包，无需此步，重启即加载）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: chat-rollback
      name: dsh-plugin-chat-rollback
    - id: command-setting
      name: dsh-plugin-command-setting
      config:
        hidden: ['export', 'feedback', 'permission']
    - id: tool-both
      name: dsh-plugin-tool-both
    - id: session-export
      name: dsh-plugin-session-export
```

> tool-both 启用后自动安装「BOTH模式」预设，预设选择器即可选用（详见 [tool-both/README.md](tool-both/README.md)）。

```bash
# 重启 dsh web
dsh web
```

更新 / 卸载：

```bash
dsh plugin --profile web update dsh-plugin-chat-rollback      # 更新（git 依赖锁定在 lockfile 的提交）
dsh plugin --profile web remove dsh-plugin-chat-rollback     # 卸载（并移除 patch.yml 条目）
```

> 说明：纯 JS 插件、无 prepare 构建脚本，安装无需 allowBuilds；`dsh plugin add` 打印的
> `declares no dsh.bundle` 警告是预期提示（普通插件不是 bundle 层，忽略即可）。
> pnpm v9 不支持「分支 + 子目录」组合写法（`#分支#path:` 会解析失败），需要锁定版本时先 clone 再用本地路径：
> `dsh plugin --profile web add ./chat-rollback`。

## 本地开发

```bash
git clone https://github.com/WensH77/dsh-plugins.git   # 公开仓库，HTTPS 即可
cd dsh-plugins

# 依赖解析（插件 import @deepseek-ai/*，仓库根需要能解析到它们；
# 若本机已安装 dsh，可软链其 node_modules）
ln -s <dsh 安装路径>/node_modules node_modules

# 测试
node --test chat-rollback/test/fork-rollback.mjs     # chat-rollback 测试（8 项：快照/继承/回滚/预填/恢复保护/冲突检测/双会话端到端）
node chat-rollback/test/client-emit.mjs              # chat-rollback 浏览器端：回滚预填 emit 定向性（防 composer 广播）
node command-setting/test/smoke.mjs                  # command-setting node 端测试
node command-setting/test/client-smoke.mjs           # command-setting 浏览器端测试
node model-arena/test/smoke.mjs                      # model-arena node 端测试
node model-arena/test/client-smoke.mjs               # model-arena 浏览器端测试
node tool-both/test/smoke.mjs                        # tool-both 测试（导出/预设安装/幂等/loader 方言）
node session-export/test/smoke.mjs                   # session-export node 端测试（转录抽取/标题/接口/路由）
node session-export/test/client-smoke.mjs            # session-export 浏览器端测试（Markdown/分段/词典）
node --check plugin-market/lib/index.js plugin-market/lib/client.js   # plugin-market 语法检查
```

> plugin-market host 端（lib/index.js）改动需重启 dsh web 生效；client 端（lib/client.js）每次请求实时加载。

## 仓库结构

```
dsh-plugins/
├── chat-rollback/          # 对话回滚插件
│   ├── lib/index.js        #   Node 端：轮次快照 + rollback 端点
│   ├── lib/client.js       #   浏览器端：用户气泡回滚按钮（DOM 注入）
│   ├── test/               #   fork/rollback 测试
│   └── package.json        #   dsh.client 声明 + peer 依赖
├── command-setting/        # 命令设置插件
│   ├── lib/index.js        #   Node 端：目录过滤 + catalog/set 端点
│   ├── lib/client.js       #   浏览器端：设置页 + Plan 按钮
│   ├── test/               #   smoke 测试
│   └── package.json
├── model-arena/            # 模型竞技场（挑战模式）
│   ├── lib/index.js        #   Node 端：links/persona 持久化 + system-prompt 角色注入
│   ├── lib/client.js       #   浏览器端：hero toggle + 竞技场运行时 + 挑战编排
│   ├── test/               #   smoke 测试
│   └── package.json
├── tool-both/              # 工具呈现模式（both）：原生直调与 run_code 并存
│   ├── lib/index.js        #   Node 端：激活时安装 both 预设
│   ├── lib/presentation.js #   agent 层呈现行组件（./presentation，默认 both）
│   ├── preset/both/        #   分发的 both 预设（标准组成 + presentation both）
│   ├── test/               #   smoke 测试
│   └── package.json
├── session-export/         # 会话导出长图（只含用户输入 + 模型输出，剔除思考/工具调用）
│   ├── lib/index.js        #   Node 端：转录抽取 + /session-export/data 端点
│   ├── lib/client.js       #   浏览器端：标题栏导出按钮 + Markdown 渲染 + 长图栅格化
│   ├── test/               #   smoke 测试
│   └── package.json
├── plugin-market/          # 插件市场（基础版）
│   ├── lib/index.js        #   Node 端：清单/开关/安装/更新/卸载/审查/清理 路由
│   ├── lib/client.js       #   浏览器端：插件市场 tab（任务可视化 + 审查报告弹窗）
│   └── package.json
├── node_modules            # 测试依赖解析（软链，已 gitignore）
└── .gitignore
```
