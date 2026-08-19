# dsh-plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）web profile 编写的一组插件。
仓库采用 **pnpm 子目录依赖** 结构：每个插件是一个独立的包目录，可直接从 GitHub 安装，无需发布 npm。

## 插件清单

| 插件 | 目录 | 功能 |
|---|---|---|
| **chat-rollback** | [`chat-rollback/`](chat-rollback/README.md) | 对话回滚：在用户消息操作条（与复制按钮同行）点击回滚到这条消息之前，创建新会话并预填该消息文本，附带轮次快照的代码回滚、fork 快照继承、原会话自动归档 |
| **command-setting** | [`command-setting/`](command-setting/README.md) | 命令设置：从 “+” / “/” 命令菜单隐藏/显示 slash 命令（默认 export/feedback/permission），设置页管理 + 外置 Plan 切换按钮 |
| **dsh-at-file** | [`dsh-at-file/`](dsh-at-file/README.md) | @ 路径引用（fork 自 [omdsh-dev/dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) v0.6.3）：输入框输入 `@` 搜索当前工作区并插入文件/目录路径引用，不注入文件内容；设置页可管理文件名过滤规则 |
| **model-arena** | [`model-arena/`](model-arena/README.md) | 模型竞技场开关：以普通 `/arena` 命令形式出现，切换竞技场启用标记（开发中） |

各插件目录内有完整的独立 README（功能、原理、安装、配置、测试、已知限制）。

## 快速安装（dsh web）

前置：`dsh plugin` 命令会把参数转发给 **PATH 上的 pnpm**（`npm i -g pnpm` 或 corepack）。仓库是**公开**的，直接安装即可，无需任何凭据或配置。

```bash
# 1) 安装两个插件（公开仓库，HTTPS 拉取，无需 SSH key；跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:chat-rollback'
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:command-setting'
```

> 装了 GitHub SSH key 的机器也可用简写（等价，走 SSH）：
> `dsh plugin --profile web add 'github:WensH77/dsh-plugins#path:chat-rollback'`
> （command-setting 同理）

```yaml
# 2) ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: chat-rollback
      name: dsh-plugin-chat-rollback
    - id: command-setting
      name: dsh-plugin-command-setting
      config:
        hidden: ['export', 'feedback', 'permission']
```

```bash
# 3) 重启 dsh web
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

# 依赖解析（两个插件 import @deepseek-ai/*，仓库根需要能解析到它们；
# 若本机已安装 dsh，可软链其 node_modules）
ln -s <dsh 安装路径>/node_modules node_modules

# 测试
node --test chat-rollback/test/fork-rollback.mjs     # chat-rollback 测试（4 项：快照/继承/回滚/恢复保护）
node command-setting/test/smoke.mjs                  # command-setting node 端测试
node command-setting/test/client-smoke.mjs           # command-setting 浏览器端测试
```

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
├── node_modules            # 测试依赖解析（软链，已 gitignore）
└── .gitignore
```
