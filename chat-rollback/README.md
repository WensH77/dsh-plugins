# dsh-plugin-chat-rollback

对话页扩展：在每条**用户消息**的操作条里（与复制按钮同行）加一个「回滚」图标按钮，
点击后**回滚到这条消息之前** —— 截断历史、创建继承相同 cwd / agent 预设的新会话、
把这条消息的文本**预填进新会话输入框**，原会话自动归档。

> dsh 会话是 append-only 日志，不支持原地截断，因此「回滚」= 从该处**分叉出新分支**继续。

## 功能速览

| 能力 | 说明 |
|---|---|
| 回滚入口 | 用户消息操作条内、**与复制按钮同行**（DOM 注入；平台无用户消息操作条插槽，定位失败降级为气泡下方） |
| 回滚语义 | 截断到这条消息**之前**，该消息文本自动预填新会话输入框（draft 为空时生效） |
| 确认与冲突门 | 点一次 → 服务端逐文件比对 hash：无冲突 → 红色 ✓ 待确认；有冲突 → **?** 列出被其他会话改动的文件，再点一次 → ✓ 确认；焦点离开自动取消 |
| 代码回滚 | 轮次快照（tar.zst + 逐文件 hash manifest）+ 恢复撤销目标轮次之后的改动；恢复前生成 recovery 备份 |
| 快照继承 | 回滚 / fork 子会话**硬链接**继承祖先快照，seed 历史内可继续代码回滚 |
| 自动归档 | 原会话归档（侧边栏隐藏；**当前 dsh 无 unarchive API，归档后不可从 UI 恢复**），避免旧分支与回滚会话并列 |
| 降级路径 | 无快照 / 快照禁用 / 非 cwd 工作区 → 纯对话回滚并在界面提示 |

## 工作原理

### 两个半区

| 文件 | 角色 |
|---|---|
| `lib/index.js` | **Node 端** Cordis 插件：`turn/start` 时快照 cwd；提供 `POST /chat-rollback/rollback`、`POST /chat-rollback/prune-archived` |
| `lib/client.js` | **浏览器端** bundle：DOM 注入按钮（MutationObserver 扫描 `[data-chat-anchor-key]` 用户气泡行 → 会话快照 `chat.nodes` 解析 `anchorSeq`）、两段式确认、预填、打开新会话 |

### 轮次快照

```
turn/start 事件
  --> tar -C <cwd> --exclude=.git --exclude=node_modules -cf - . | zstd
  --> ~/.dsh/chat-rollback-snapshots/<sessionId>/turn-<n>.tar.zst
```

- 每轮对话开始前快照一次 = **上一轮结束后的工作区状态**（快照粒度 = 轮次）
- 默认排除 `.git` / `node_modules`（可配置 `excludes`）
- 快照互相独立；回滚 / fork 子会话以**硬链接**继承（零拷贝共享 inode，跨文件系统自动降级为复制）
- **继承受保护**：快照目标已存在（只可能来自继承）时跳过本轮写入，避免用被其他分支改过的共享目录覆盖准确的祖先状态
- **逐文件 hash manifest**：每个 `turn/start` 同时写 `turn-N.files.json`（`{相对路径: sha256}`，排除项与恢复一致），用于回滚前比对单个文件内容
- **turn/end 后置 manifest**：每个 `turn/end` 写 `turn-N.end.files.json` = 本轮结束后的状态，作为「本会话最后写入」的冲突参照基准（不继承，各会话自己生成）

### 回滚语义（由目标事件类型决定）

| 目标 | 语义 |
|---|---|
| `user/message` | **回滚到这条消息之前**：seed 截断到它之前（仍在运行的轮次一并剪除）；`nextInput` = 该消息自己的文本 |
| `assistant/message`（兼容旧版） | 截断到该消息**之后**；`nextInput` = 截断点之后的第一条用户输入 |

处理流程：

0. 预检（`POST /chat-rollback/preflight`，只读不落盘）：比对「目标 manifest `turn-(turn+1).files.json`」「本会话最后写入」「当前工作区」三份逐文件 hash；某文件「当前 != 目标 且 当前 != 本会话最后写入」即判为**冲突**（被其他会话改动过）。「本会话最后写入」优先取最新的 end manifest（`turn-N.end.files.json`）；缺失时回退到**比恢复点更新**的 start manifest（`turn/start N` 记录的是第 N-1 轮结束后的状态，仍是合法参照）；两者都缺失（典型：单轮会话且该轮未正常 turn/end 结束）时无法归因文件归属，直接返回无冲突（`reason: 'no-end-manifest'`），恢复仍先生成 recovery 备份兜底
1. 创建新会话（seed 截断，**先建会话后恢复**，create 失败不破坏工作区）
2. 取消源 agent（运行中时，`keepInbox` 保留排队输入）
3. 恢复快照 `turn-(turn+1)`（turn = seed 内最后一个完成轮次）：先备份当前工作区到 `<新会话>/recovery-<ts>.tar.zst`，再解包覆盖 + 清理快照后新增的文件
4. 硬链接继承源会话 `turn-1..turn-(turn+1)` 快照到新会话目录
5. 归档源会话并清理其快照（恢复失败则跳过归档、保留快照可重试）

```
POST /chat-rollback/rollback?session=<id>&seq=<n>
--> { ok, sessionId, sourceSessionId, sourceTurn, codeRollback,
      inheritedSnapshots, archivedSource, sourceCancelled, nextInput? }
```

## 安装（GitHub 公开仓库，无需发布 npm）

前置：`dsh plugin` 命令会把参数转发给 **PATH 上的 pnpm**（`npm i -g pnpm` 或 corepack）。仓库是**公开**的，直接安装即可，无需任何凭据或配置。

```bash
# 1) 安装（公开仓库，HTTPS 拉取，无需 SSH key；跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:chat-rollback'
```

> 装了 GitHub SSH key 的机器也可用简写（等价，走 SSH）：`dsh plugin --profile web add 'github:WensH77/dsh-plugins#path:chat-rollback'`

```yaml
# 2) ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: chat-rollback
      name: dsh-plugin-chat-rollback
```

```bash
# 3) 重启 dsh web
dsh web
```

说明：

- **更新**：仓库有新提交后运行 `dsh plugin --profile web update dsh-plugin-chat-rollback`（git 依赖会锁定到 lockfile 中的提交）
- **卸载**：`dsh plugin --profile web remove dsh-plugin-chat-rollback` 并移除 patch.yml 条目
- 纯 JS、无 prepare 构建脚本 → 安装无需 allowBuilds；`dsh plugin add` 打印的 `declares no dsh.bundle` 警告是预期提示（普通插件不是 bundle 层，忽略即可）
- pnpm v9 **不支持**「分支 + 子目录」组合写法（`#分支#path:` 会解析失败）；需要锁定版本时先 clone 仓库再用本地路径 `dsh plugin --profile web add ./chat-rollback`

## 配置

插件 `Config`（cordis.patch.yml 中 `config` 字段，均可省略）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `snapshotDir` | `~/.dsh/chat-rollback-snapshots` | 快照根目录 |
| `excludes` | `['git', 'node_modules']` | 快照与恢复排除的路径（tar `--exclude` 语义） |
| `snapshotEnabled` | `true` | 设为 `false` 禁用轮次快照（退化为纯对话回滚） |

## 使用

1. 打开会话，找到要回滚到的那条**用户消息**（回滚到它之前）
2. 点击消息操作条中的回滚按钮 → 服务端逐文件比对 hash：无冲突显示红色 ✓；有冲突显示 **?**（hover 列出被其他会话改动的文件）→ 再点一次 ✓ 确认（焦点离开会取消确认）
3. 新会话自动创建并打开：历史保留到该消息之前，该消息文本已在输入框里，回车继续对话即可

## 测试

```bash
node --test chat-rollback/test/fork-rollback.mjs   # 或 npm test（依赖仓库根 node_modules 解析 @deepseek-ai/*）
node chat-rollback/test/client-emit.mjs            # 浏览器端：回滚预填 emit 定向性（vm 加载 bundle）
```

覆盖：轮次快照排除 `.git`/`node_modules`；逐文件 hash manifest 写入与排除；fork 子会话硬链接继承（含 manifest）；**用户消息回滚**（截断到消息之前 + 预填自身文本 + open-turn 剪除、steer 场景排队消息保留）；助手消息回滚（旧版语义）；含 `.git` 的旧版快照恢复时**不回滚 git 状态**（解包侧 excludes 保护）；**preflight 冲突检测**（本会话自改 → 无冲突；外部改动/新增文件 → 命中冲突并列出文件）；**双会话端到端**（会话1新建文件 → 会话2改动 → 回滚2 → 回滚1：有 end manifest 时回滚1无冲突且删除文件；无 end manifest 时同样无冲突，`reason: 'no-end-manifest'`）；**空目录保护**（快照内空目录恢复后保留、排除项空目录如空 `node_modules/` 不被剪枝清理删除）；**recovery 备份排除 `.git`/`node_modules`**；**含 `$` 路径的工作区**快照/恢复（shell 转义，防 `$HOME` 展开）；**`snapshotEnabled:false` 降级**（纯对话回滚、不写快照、工作区不动）；**恢复失败路径**（源会话不归档、快照保留可重试）。

## 已知限制

- 快照粒度为**轮次**（每轮开始前一次），非每次工具调用；回滚恢复的是 seed 最后一个完成轮次**结束后**的状态（用户消息回滚 = 该消息所在轮次开始前的状态），轮次内部的中间状态无法恢复
- 快照自插件启动后生效：插件安装/重启之前的历史会话没有快照（降级为纯对话回滚）；继承只覆盖源会话已有的档位
- 恢复操作覆盖共享工作区（目标轮次之后的修改被撤销）；恢复前有 recovery 备份，可手动 `zstd -dc <backup> | tar -C <cwd> -xf -` 撤销（备份与快照一样排除 `.git`/`node_modules`——恢复对排除项路径三侧都不改动，无需备份它们）
- **恢复保护**：解包、文件剪枝、空目录清理三侧均应用 excludes —— 即使快照内混入 `.git`/`node_modules`（旧版插件产物或外部归档），恢复也绝不动这两类路径；快照内本有的空目录也会被保留（实测：含 `.git` 的快照恢复后仓库 HEAD 保持当前提交，空的 `node_modules/` 目录不被清掉）
- **清理策略：归档即清理** —— 回滚成功后源会话立即归档，其快照随即删除（recovery 备份位于新会话目录，不受影响）；其余已归档会话的快照在下次回滚时惰性清理，也可 `POST /chat-rollback/prune-archived` 手动清理；未归档会话的快照永久保留
- **共享 cwd 与冲突门**：并存会话共享同一目录；回滚前按文件 hash 比对，被其他会话改动过的文件会先以 **?** 提示冲突、需二次确认才覆盖（`POST /chat-rollback/preflight`）。运行中的源会话（steer 中途）跳过冲突门——其未落盘改动与外部改动无法区分，回滚会取消该 agent
- **无 end manifest 时的信息缺口**：本会话最后写入参照缺失（end manifest 未写入、且没有更晚的 start manifest）时，冲突门无法区分「文件是本会话自己写的」还是「其他会话改的」。此时按无冲突放行（`reason: 'no-end-manifest'`），避免把本会话新建的文件误报为冲突（场景：回滚会话2后文件已回到会话1内容，再回滚会话1不应提示冲突）；代价是同条件下若确有其他会话的未回滚写入，不会提前告警——恢复前生成的 recovery 备份可手动撤销
- 回滚目标是消息事件 seq，必须在会话日志范围内；异常中断（interrupted）的半成品消息没有稳定 messageId，不显示回滚入口
- 新会话依赖 agents/workspaceRegistry 服务（host 平面可用）；agentPresets 在 web profile 位于 host 平面之外，通过 `ctx.get()` 可选获取并优雅降级（preset 组合失败、workspace 挂载失败均不阻断回滚）

## 验证记录

- 参数校验：非数字 seq、越界 seq、不存在的会话均返回明确错误
- 用户消息目标：seed 截断到该消息**之前**（open-turn 剪除、seed 以最后一个 turn/end 或排队消息收尾）、nextInput = 该消息自身文本、代码回滚 = seed 最后一个完成轮次的 turn-(turn+1) 快照、首条用户消息回滚 = seed 保留 request/header（全新开始）
- 助手消息目标（旧语义）：seed = `events.slice(0, seq+1)`（含目标消息），meta 继承 cwd/seedLength/agentPreset，无 parentSession（顶层会话）
- workspace 解析 = 包含源会话的 workspace，attachSession 调用成功；preset 组合失败 / workspace 挂载失败均不阻断回滚；agents.create 异常则回滚返回 500（先建会话后恢复，create 失败不触碰工作区）
- 浏览器端：中英文文案；DOM 注入（MutationObserver → `chat.nodes` 解析 anchorSeq → 挂载按钮；steering 气泡同样挂载、未知/非用户节点不挂载）；两段式确认（自绘回滚箭头、确认态红色 ✓、busy 态旋转）；本地 Tooltip；blur 取消确认态
- **locale 订阅修复**：locale-change 重绘原用 WeakMap 的 `.values()`（WeakMap 无此方法，任何插件注册字典都会触发 `locale subscriber crashed`）；`mounted` 改为 Map（行在 detach 时删除，无泄漏），控制台报错消除
- 轮次快照：turn/start 触发 tar.zst 归档（排除 .git/node_modules）；同轮快照覆盖旧文件；快照失败仅告警不阻断对话
- 代码回滚 e2e（真实目录演练）：修改+新建+删除文件后回滚，文件恢复旧内容、新增文件被清理、被删文件恢复、recovery 备份生成；无快照路径返回 restored:false 且会话照常创建
- 预填通道：sessions.refresh() 后 binding 已物化，向新会话 emit `slash/input-insert-text`（draftRev 0）；用户已输入时静默跳过
- **预填定向修复（emit 广播）**：原实现 `binding.ctx.emit('slash/input-insert-text', ...)` 不带 dispatch subject——cordis 的 dispatch 仅在给定 `thisArg` 时做 context 过滤（`thisArg[Context.filter]`），裸 emit 会跑 hooks 表上的**全部** listener，在共享 session-ctx 架构下把回滚文本预填进**所有已挂载的 composer**。改为 `binding.ctx.emit(binding.ctx, ...)`（与 dsh input-trigger 的 `actx.bail(actx, ...)` 同形），`Context.filter` 只放行目标会话的 composer shell。新增 `test/client-emit.mjs`（vm 加载浏览器 bundle + 双会话 ctx stub，驱动两段式点击）断言：预填 emit 仅发往新会话 ctx、首个 dispatch 参数是会话 ctx（thisArg）、payload 携带回滚文本
- 快照继承：响应携带 inheritedSnapshots（界面提示可继续回滚）；硬链接共享 inode 零拷贝，跨文件系统降级 copyFile；继承失败不阻断，附 inheritNote
- fork 继承：session/created 判据（parentSession 且无 origin/delegationDepth）命中 fork 子会话；子代理（origin:"subagent"）与回滚子会话（无 parentSession）均不触发；回调 async 化，同步抛错不污染会话 attach
- 源 agent 取消：仅 running 时调用 agent.cancel（keepInbox），失败仅告警
- 恢复失败路径：codeRollback.restored:false 时源会话不归档、快照保留可重试；子会话已创建，对话回滚仍生效

## 变更日志

历次改动见 [CHANGELOG.md](./CHANGELOG.md)。
