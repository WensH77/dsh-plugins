# Changelog

本文件记录 `dsh-plugin-chat-rollback` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

## 0.2.1

- **补上 `repository` 字段**（`WensH77/dsh-plugins#path:chat-rollback`）：插件市场的「检查更新 / 更新 / 帮我更新」按 *市场安装记录 > 包内 repository > profile 依赖的 `github:` spec* 三级回退取仓库地址。此前本包缺第二级，若不是用 `github:` spec 安装（例如 `git+https://`、tarball、`link:`），更新通道会直接报「git 通道需要 GitHub 仓库地址（repository 字段缺失）」。

## 0.2.0

- **TOCTOU 收窄（二次冲突校验）**：`preflight` 与真正执行之间其他会话的写入，在 `rollback` 端点再次检测——有冲突且未确认 → `409 {code:'conflict', files}`，客户端回到「?」确认态；确认后带 `force=1` 重发才执行。冲突判定逻辑提取为 `rollbackConflictState`，preflight 与 rollback 共用（`handlePreflight` 相应瘦身）
- **空快照安全网**：恢复点快照为空（如 `excludes` 配成 `'*'`、快照损坏/回归）且工作区非空时，回滚会清空整个工作区——未确认 → `409 {code:'empty-snapshot'}`；确认（`force=1`）后执行。注意：回滚到首条消息（清空 agent 全部改动）也属此类，会多一次确认
- **restore 失败自动回滚**：恢复失败时自动用 recovery 备份把工作区还原到恢复前状态（`codeRollback.rolledBack` 供客户端提示），不再停在半恢复状态
- **快照原子写**：`snapshotWorkspace` 先落 `.tmp` 再 rename，杜绝「zstd 中途失败留下 size>0 半截文件」被 size>0 守卫误认为完整快照（此前会永久使用损坏快照）；`zstd -T0` 多线程压缩
- **快照任务按 session 串行化**：同一会话的 turn-N 快照 + manifest 原子成组完成后才开始 turn-N+1，避免快速连续 turn（steer）下 tar 与 hash 交错读取被 agent 修改中的工作区
- **hashWorkspace 并发 sha256**：8 并发小池提升大工作区清单生成吞吐（不做 mtime 缓存——preflight 依赖当前哈希精确性）
- **isExcluded 快路径**：无元字符且无 `/` 的裸模式（`.git`/`node_modules`）走「段包含」判定，避开 pm 回溯；修复快路径误伤含 `/` 模式（`build/output` 被 split 拆段而漏排）的回归
- **findPruneExpr 保守化**：含 `[` 的模式不再参与 find 剪枝（find 与 libarchive 字符类语义有分歧，剪枝过头 = 漏文件），一律交 isExcluded 后置过滤
- **lazy prune 竞态修复**：rollback 开头的惰性清理跳过本次源会话目录，避免与快照硬链接继承并发（跨文件系统 copyFile 降级路径）
- **客户端**：`mounted` Map 泄漏修复（scan 清理 `!isConnected` 行）；runRollback 改 ndjson 阶段流（`stream=1`），busy 期间展示「备份/恢复/继承/归档」进度文案；409 冲突/空快照回到确认态；`rollback.rolledBack`/`rollback.emptyWarn`/`rollback.conflictRecheck` 等新文案
- **平台支持声明**（README）：macOS/Linux（依赖系统 `sh`/`tar`/`find`/`zstd`）；Windows 不支持
- 测试：新增 S（二次冲突 409+force）、T（空快照守卫 409+force）；M 补 `rolledBack` 断言；H2/H3 适配空快照守卫的 force 流程；差分 fuzz 固化为 `test/matcher-fuzz.mjs`（固定种子、可复现、win32 跳过）

### 0.1.5 审查修复（自审发现的两个真实缺陷）

- **伪流修复**：ndjson 进度流初版把阶段收集到数组、在全部执行完成后才 writeHead 一次性写出——客户端 fetch 直到响应结束才收到所有行，进度提示退化为完成瞬间的闪烁。改为通过 409 校验后立即 writeHead，各阶段执行时即时 `res.write`（新增测试 U 断言阶段行按执行顺序即时到达）
- **forcePending 修复**：初版客户端把所有确认点击都带 `force=1`，正常 preflight 通过后的确认也绕过执行前二次校验，TOCTOU 收窄形同虚设。改为仅 409（冲突/空快照）之后的确认携带 force（`forcePending` 标记），正常确认不带 force——服务端二次校验在首次执行时仍然生效（client-emit 测试扩为四段流程：preflight → 409 conflict → 确认 → force 重发，断言两次请求的 force 差异）
- 空快照守卫的 `find` 加排除剪枝：工作区仅剩被排除内容（如只有 `.git`）时不再误报 409
- `backupWorkspace` 返回值检查：备份失败时告警（自动回滚兜底不可用）
- README 已知限制补充：快照串行化的时效性说明、匹配器与本机 bsdtar 对齐的跨平台注记

### 排除语义与快照管线（并入 0.2.0，原 0.1.4）

- **排除模式重写为 tar `--exclude` 语义的忠实移植**（libarchive `__archive_pathmatch` 的 JS 移植）：未锚定、按路径元素尝试、`*` 跨 `/`、`?`、`[...]`（`!`/`^` 取反、范围）、`^`/`$` 锚定、前导 `./` 归一化——快照、哈希清单、恢复剪枝三侧共用同一判定，与真实 bsdtar 差分 fuzz 1000 组零分歧（含 macOS 系统 libarchive 与上游的 `[!a]` 末端行为差异对齐）
- **修复致命缺陷：裸 `.*`/`*` 类模式把整包清空**——旧快照命令 `tar -cf - .` 会把起始点 `.` 归档，未锚定匹配下 `.*` 命中起始点导致快照为空，回滚时解包空快照 + 剪枝会删除工作区全部文件（recovery 备份同样为空，无法挽回）。快照管线改为 find 清单 + `tar -T`（`--null`/`--no-recursion`），归档不含起始点：`.*` 现在可以安全地一键忽略所有点文件，且支持含换行的文件名、每条目只入档一次、空目录保留
- **修复含 `/` 与通配排除项的三侧不一致**：旧 isExcluded 只认顶层前缀/字面段，而 tar 侧对 `build/output` 这类模式任意深度生效——恢复剪枝会把 tar 已排除路径下的文件误删。三侧统一后此问题消除
- **修复移植 bug**：`*` 回溯递归未传递已消费的模式下标，模式被反复重入导致深度超限返回 -1 并被当作「匹配」（`*.log` 曾误判 `plain.txt` 为排除）
- README 默认 excludes 笔误修正（`['git', ...]` → `['.git', 'node_modules']`），补充排除模式语义、`.*` 用法与快照管线说明

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
