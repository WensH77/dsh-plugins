# Changelog

本文件记录 `dsh-plugin-chat-rollback` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

## 0.1.3

- 快照清理修复（针对磁盘只涨不落，实测用户目录达 191GB）：
  - **写侧前缀过滤**：`onSessionEvent` 只给标准 `session-` 会话写快照——arena 对局会话、旧格式 id 不再产生新快照（此前每轮全量累积，且清理侧不认这些前缀，写了清不掉）
  - **统一清理函数 `pruneSnapshots`**：回收三类目录——已归档会话（含手动归档，此前只能等下次回滚惰性清理）、非标准前缀目录（存量一次性回收，带快照内容守卫防误删）、孤儿目录（registry 无记录且停止活动超 24h，缓冲 attach 竞态）
  - **定时兜底清理**：新增 `pruneIntervalMs` 配置（默认 1 小时，`0` 禁用），workspaceRegistry 无归档事件可监听，靠周期扫描收敛磁盘占用
  - `POST /chat-rollback/prune-archived` 端点行为扩展为统一清理，响应含 `pruned`（已归档/非标准）与 `orphaned`（孤儿）
- 新增测试：写侧前缀过滤（N）、统一清理端点（O，含缓冲期与内容守卫）、定时兜底（P）

## 0.1.2

- 恢复三侧保护统一：文件剪枝 + 空目录清理均应用 excludes，快照内空目录保留、排除项空目录（如空 `node_modules/`）不被清理
- recovery 备份排除 `.git`/`node_modules`（与恢复保护一致）
- tar/find 路径改用 shq 单引号转义，修复含 `$`/反引号的工作区
- manifest/preflight 改流式 sha256，避免大文件整读入内存
- 修复回滚预填 emit 广播：绑定会话 ctx 作 thisArg，只预填新会话 composer（原裸 emit 会跑全部 listener）
- 新增 client-emit 测试 + fork-rollback 空目录/降级/失败路径覆盖

## 0.1.1

- 版本 bump（随 plugin-market 0.2.0 发布批次）

## 0.1.0

- 用户消息回滚：截断 seed 到消息之前 + 预填其文本到新会话
- 轮次级工作区快照（tar.zst，排除 `.git`/`node_modules`）+ 跨回滚/fork 分支硬链接继承
- 恢复侧 `.git` 保护、源会话自动归档、两段式确认（blur 取消）、历史回退图标
- last-write manifest 语义：end-manifest 优先、later-start 回退、逐文件 hash 冲突门 + fork 回滚测试
- 裸名 excludes（`.git`/`node_modules`）任意深度匹配（snapshot/restore/hash/prune 统一）
