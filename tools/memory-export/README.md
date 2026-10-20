# 历史会话导出层

把 `~/.dsh/sessions` 下的 dsh 会话日志导出成只含真人提问、assistant 正文和错误类工具结果的 JSON，供后续 LLM 蒸馏。工具结果（成功部分）、reasoning、注入的 AGENTS.md / skill 目录 / 运行时上下文、子代理会话默认排除。

## 用法

    node tools/memory-export/export-sessions.mjs [--root <dir>] [--out <dir>] [--since <ISO|N天>]
        [--session <id前缀>] [--limit <N>] [--jobs <N>] [--include-subagents]
        [--include-unknown-source] [--include-tool-errors | --no-tool-errors]
        [--tool-error-max-chars <N>] [--force] [--dry-run]

默认 `~/.dsh/sessions` → `~/.dsh/memory-export`（仓库外）。首轮后按 `state.json` 的 bytes+mtimeMs 跳过未变文件，不解压。

`--include-tool-errors` 默认开启，只收**错误类**的 `tool/result`，成功的结果一律不收；`--no-tool-errors` 关掉，回到旧行为。`--tool-error-max-chars N` 限单条文本长度，默认 1500。

错误类判据，三条任一成立：

- `data.error` 存在（实测形如 `{"name":"SessionQueryError","code":"SESSION_QUERY_PERSISTENCE_FAILED"}`）；
- `data.message.isError === true`，或老格式外层 `tool-result` 块的 `isError === true`；
- 文本命中 `\[status: [^\]]*exit code: [1-9]\d*\]`（`exit code: 0` 不算错）。

刻意不做 `error` 关键词匹配，避免把正常输出里带 "error" 字的行收进来。

`tool/result` 有两种历史结构，都要读：新格式 `message.content` 直接是 `{type:"text"}` 块、`message.toolCallId` 在顶层；老格式（`.jsonl` v0/v3）外面包一层 `{type:"tool-result", content:[...], isError, toolCallId}`，callId 也可能只在 `message.source.callId`。只按新格式读会让老日志里的错误全部静默丢失（实测全量 1759 个日志里有 3085 条错误属老结构）。

`--include-subagents` 默认关闭，开启后 `origin=subagent` 或 `delegationDepth>0` 的会话也会导出。这类会话里没有真人用户：所有 `source.kind='user'` 消息（任务书、`[中继答案]`、多轮指令）都是上游代理写的，导出时统一标成 `role: "task-brief"`。普通会话的消息角色不变。

## 产物

- `sessions/<session-id>.json`：`schema`（当前 `dsh-session-export/4`）、`session`（id/cwd/createdAt/lastEventTime/eventCount/messageCount/lastEventType/parentSession/origin/delegationDepth/agentPreset/formatVersion/sourceFile/sourceBytes/sourceMtimeMs）、`stats`（events/messages/userChars/assistantChars/toolErrorMessages/toolErrorChars）、`messages`。`lastEventTime` 是日志里所有事件 `time` 的最大值（无事件 time 时退回 createdAt）。`eventCount` 是日志里所有带顶层 `type` 和 `time` 的事件行条数，包含 `tool/result`、`step/start`、`session-log-*` 等不进 `messages` 的类型；`messageCount` 等于 `stats.messages`，是导出的 user/assistant/tool-error 条数；`stats.events` 是非空行总数（含无法解析的行）。schema 3 及更早的导出文件里 `eventCount` 还是消息数，需要用当前代码重跑 export（schema 4）后才换成事件数口径。
- `messages` 按日志流顺序（即 seq 顺序）混排四种角色，均含 `seq/time/role/text`：
  - `user`：真人提问；`assistant`：assistant 正文；
  - `task-brief`：仅 `--include-subagents` 导出的子代理会话出现，是该会话里**每一条** `source.kind='user'` 消息（上游代理写的任务书、`[中继答案]` 或多轮指令），避免蒸馏把它们当成用户需求。
  - `tool-error`：错误类工具结果，额外字段 `tool`（优先用 `message.toolCallId`、缺失时用 `source.callId` 回查 `tool/call` 的 `name`，查不到为 `null`）、`truncated: true`（仅文本被 `--tool-error-max-chars` 截断时出现）、`error: {name, code}`（仅 `data.error` 存在时出现）。文本去掉首尾空白后为空的结果不导出。
- `manifest.jsonl`：追加日志，每行 `id/status/sourceFile/sourceBytes/sourceMtimeMs/messages/userChars/assistantChars/exportedAt`，失败带 `error`；status 为 exported / skipped_subagent / skipped_no_user / skipped_old / failed / unchanged。命中增量的 unchanged 不重复追加。
- `state.json`：`{schema, updatedAt, byFile: {"<相对路径>": {bytes, mtimeMs, sessionId, status}}}`。`schema` 与当前版本不符时整份忽略、全部重导（抽取逻辑变了但源文件 mtime 没变，不这么做会一直命中旧结果）。

同一 session id 的多份格式文件只导出 mtime 最新的一份。stdout 一行汇总 JSON，进度与失败走 stderr，有失败退出码 1。

`--no-tool-errors` 真写盘会用「无 tool-error」的产物覆盖同名文件，并把 state 更新成 `dsh-session-export/4`；之后默认参数重跑会命中 unchanged 而不会补回 tool-error。要恢复就在默认参数下加 `--force`。只想看计数请用 `--no-tool-errors --dry-run`，不落盘。

## 会话蒸馏

`distill.mjs` 把 `sessions/<id>.json` 逐份发给 `https://api.deepseek.com/chat/completions`，抽出原子记忆。整份会话不切块；默认一次请求，命中 boost 条件时再发一次。

    node tools/memory-export/distill.mjs [--sample N] [--sessions id1,id2]
        [--model deepseek-flash|deepseek-v4-pro] [--concurrency 4] [--force]
        [--dry-run] [--out <dir>] [--thinking on|off] [--max-output-tokens 8000]
        [--sessions-dir <dir>] [--min-idle-minutes 30] [--archive-state <path>]
        [--seed N] [--timeout-ms N] [--status] [--backfill-state]

默认读 `~/.dsh/memory-export/sessions`，写 `~/.dsh/memory-export/memories`，状态表 `~/.dsh/memory-export/archive-state.json`。

- `--sample N` 分层抽样：N>=20 时取 10 个含 tool-error、5 个最大、5 个最小（按消息字符数）、覆盖 5 个 cwd，其余用固定种子随机补齐；N<20 按比例缩小配额。同一种子结果可复现。
- `--sessions` 接受完整 id 或唯一前缀。
- `--dry-run` 不发请求，stderr 打增量计数（将蒸/新会话/重蒸/pending/unchanged）和逐会话判定（含 `events`/`messages` 计数），stdout 打一个完整请求 prompt 的前 60 行。
- 只蒸馏已归档会话：最后事件距今 >= `--min-idle-minutes`（默认 30）才算归档，否则计入 pending 跳过。
- 归档状态表按唯一键 `<session_id>-<eventCount>` 记录 `eventCount`/`lastEventTime`：该 `session_id` 在表里没有 → 新会话；`eventCount` 与 `lastEventTime` 都相同且产物存在 → unchanged；任一不同 → 重蒸；`status: failed` 下次运行会重试。`eventCount` 是日志总事件数，所以只追加成功的 `tool/result`、`step/start` 等（消息数不变）也会触发重蒸。同一个 `session_id` 只保留 `eventCount` 最大的一条，保存时旧键被移除；`createdAt` 仍留在条目字段里，但不进键。产物文件存在但表里没有的旧产物不会自动算作已处理，用 `--backfill-state` 一次性补记（用当前导出的 `session.eventCount` 作基线）。
- 两阶段蒸馏：先按 CLI 设置（默认 disabled/8000）跑；若 `userChars+assistantChars >= 10000`、`< 100000` 且每千字符记忆数 `< 0.22`，立刻用 enabled/32000 重跑并采用该结果，`phase: "boost"`；否则 `phase: "base"`。boost 失败时保留 base 结果。
- `--force` 忽略状态表重蒸所有已归档会话，pending 仍跳过。
- `--status` 只读统计：导出总数、表里 ok/failed、pending（附最近 3 个 idle 分钟与 `events`/`messages` 计数）、版本已变（附最近 3 个及前后 `eventCount`）、孤儿条目（按 `session_id` 判定）。stdout 输出 JSON。
- 429/5xx/网络错误/超时按 1s、2s、4s、8s 指数退避重试 4 次。
- 响应先按 JSON 解析，失败时剥掉 ```json 围栏再试。模型偶尔会输出缺引号/逗号的非法 JSON（finish_reason 仍是 stop，如 `"kind":decision"`），解析失败会重发一次，两次都失败才记 failed；token 按实际请求次数累计。
- 输出 `memories/<session-id>.json`。模型只输出 kind/statement/evidence/tags，不再输出 seq；脚本在转录里定位 evidence，回填 seq/time/matchCount，并补 session_id/cwd/model/distilledAt。顶层还带 `phase`（base/boost）与 `settings`（`{model, thinking, maxOutputTokens}`）。
- 子代理会话的 `task-brief` 在转录里照常展示，提示词要求把它当上游代理的消息、不从中抽 preference/decision，只作为理解上下文。这一条不只靠提示词：校验阶段会把 evidence 定位到 `task-brief` 的 preference/decision 直接丢弃，计 `task-brief-kind`。
- `memories/manifest.jsonl` 追加 `session_id/model/phase/settings/memories/invalid/input_tokens/output_tokens/reasoning_tokens/elapsed_ms/status`。
- `DISTILL_DEBUG_INVALID=1` 会把被丢弃的条目写到 `<out>/invalid-debug.jsonl`，用于排查 evidence 问题。

校验：kind 必须在 5 类枚举内；evidence 非空且不超过 200 字；evidence 在该会话全部消息里按空白归一化做子串匹配，找不到时再忽略全部空白试一次；命中多处取第一处并记 matchCount。找不到记 evidenceNotFound，超过 200 字记 evidenceTooLong，重复 statement 也丢弃；evidence 落在 `task-brief` 上的 preference/decision 记 `task-brief-kind` 丢弃。丢弃计数与原因写 stderr，summary 的 `invalidReasons` 也带一份，不中断。

模型只交 evidence、不交 seq，是为了避开「凭空编号 / 引用未导出工具输出」这类失效：提示词要求 evidence 是同一条消息里的连续逐字片段，禁止拼接多行或多条消息、改标点、改词；定位不到就丢弃，不做模糊匹配。

请求默认 `thinking: {type:"disabled"}`：flash/pro 的 reasoning token 也计入 max_tokens，实测 2000 会被推理吃光、content 为空；抽取是结构化任务，关掉思考后同样的 max_tokens 能完整返回。`--thinking on` 会改发 `{type:"enabled"}`（省略该字段等价于开启），响应里的 `usage.completion_tokens_details.reasoning_tokens` 单独记进 manifest/summary 的 `reasoning_tokens`。2026-10-19 的 20 会话抽样实测：`--thinking on --max-output-tokens 16000` 两次跑分别有 4/20、6/20 个会话因 reasoning 吃光 16K 预算而失败（`finish_reason=length`，content 为空或 JSON 截断），所以 `on` 至少要配 32000；默认仍用 `off`。

`--max-output-tokens` 默认 8000：中文 JSON 每条记忆约 150-250 token，2000 在长会话上会 `finish_reason=length` 截断（实测 50 个抽样里 16 个）；v4-pro 在最大的两个会话上需要 16000。

成本：`estimatedCostUsd` 按 dsh provider 数据里的单价算（flash 0.30/1.20、pro 1.32/3.96 美元每百万 input/output token），命中 `prompt_cache_hit_tokens` 的部分按 cache 价；summary 里的 `cacheHitTokens` 是命中数。重跑同一会话会大量命中缓存，汇总里的美元会明显低于冷跑；冷跑成本可用 input/output token 乘全价估算。

`--dry-run` 的 token 估算按 3.1 字符/token（导出层实测 1670 万字符≈536 万 token）。中文占比高的抽样会偏低：50 个抽样实际 1,940,894 字符 → 969,964 input token，约 2.0 字符/token。

## 记忆向量化

`embed.mjs` 用本地 `onnx-community/Qwen3-Embedding-0.6B-ONNX`（q8，1024 维）把 `memories/` 的 `statement` 编码成 L2 单位向量。模型从 `hf-mirror.com` 下载（本机到 huggingface.co 不通），缓存到 `~/.cache/huggingface/transformers`。

    node tools/memory-export/embed.mjs [--smoke] [--limit N] [--batch 1] [--force]
        [--dir <dir>] [--out <dir>]
        [--text-field statement|statement+evidence]
        [--out-vectors <file>] [--out-meta <file>]

- 文档侧默认只编码 `statement`，不加指令；查询侧加 `Instruct: Given a Chinese personal-memory search query, retrieve the memories that answer it\nQuery: `。
- 批大小默认 1，`--batch 16` 仍可显式指定，但会打印 warning。原因是同一个模型对同一文本的向量会随同批组成变化：实测同一句话单独编码 vs 与长文本同批编码，余弦只有 0.955；同批重复编码是 1.000000。用 batch 16 时每次全量重编码都会把所有向量换一遍，评测指标随之漂移——不带重排的 hit@5 实测从 0.556 掉到 0.444。正式库 9,044 条用 `--batch 1` 编码：23.56 条/秒，编码 383.8 秒（进程总耗时 384.6 秒），向量可复现；`vectors.meta.json` 会记录本次用的 `batch`。
- `--text-field statement+evidence` 把文档文本改成 `statement + "\n" + evidence`（evidence 为空则退回 statement），meta 里的 `text` 仍记 statement，输出顺序仍是固定排序；`--out-vectors` / `--out-meta` 把产物写到指定文件（meta.json 与 checkpoint 按向量文件同名派生），不会覆盖 baseline 的 `vectors.*`。
- 富化实验实测（8,852 条，q8，batch 16；该实验在 batch 16 下完成，向量与 batch 1 不可跨次比较）：12.16 条/秒，编码 728.2 s，进程总耗时 729.2 s；向量范数最大偏差 1.1e-6、NaN 0。S6 上 paraphrase hit@5 0.20 → 0.13（进 top-5 3 → 2 条），MRR@5 0.07 → 0.08；keyword 10/10、MRR 1.00 不变。验收门槛（top-5 多 ≥2 条或 MRR@5 提升 ≥0.05）未达，默认仍为 `statement`，富化留作实验开关。
- 池化 `last_token`，要求 tokenizer `padding_side=left`（脚本会断言，不主动改）；输出归一化到 L2=1。
- 稳定身份：`mem_id = sha256(session_id + '\0' + seq + '\0' + 归一化 evidence)[:16]`，归一化是 trim + 连续空白折叠（定义集中在 `mem-id.mjs`，与 `statement_hash` 口径一致但输入是 evidence）。输出顺序固定为 `session_id → seq → mem_id`，与 memories 的文件名顺序无关。
- 按 mem_id 增量：读旧 `vectors.meta.jsonl`，同一 `mem_id` 且 `text_sha256` 相同的向量直接复用，只编码新增/变更，删除已不存在的 mem_id；没有要编码的记录时不加载模型（9,044 条实测 embed 耗时约 0.3 秒，主要是读入并原样重写 37 MB 向量）。旧产物没有 `mem_id/text_sha256` 时无法复用，等价于一次全量重编码。
- 产物：`vectors.bin`（Float32Array 裸字节，按固定顺序拼接）、`vectors.meta.jsonl`（每条一行，含 `id/mem_id/session_id/cwd/kind/seq/time/text/text_sha256/offset`）、`vectors.meta.json`、`vectors.checkpoint.json`。`offset` 是输出位置，只用于排序/展示。
- 写入先落到 `<file>.tmp-<pid>`，全部完成后原子替换；崩溃不会留下半份向量或半份 meta。升级前那套「共同前缀续跑」已去掉。
- 同一 `session_id + seq + evidence` 可能抽出多条不同 statement 的记忆（实测 9,044 条里有 2 组）。这属于「同一输入」而不是 sha256 前缀碰撞：这类记录用 `base + 归一化 statement + kind` 再哈希一次得到 16 位 id，不会丢掉其中一条；写入前还会检查两个 mem_id 转 int64 后是否撞 rowid，撞了就报错并打印两个 mem_id。
- `--limit N` 只输出排序后的前 N 条（调试用；其余记录下次正常运行会补编码）。
- 校验 NaN/Inf、维度、L2 范数偏差 >1e-3，计数写进汇总 JSON；`--smoke` 不写产物。
- `id=<session_id>:<seq>` 仍不唯一（9,044 条只有 5,360 个唯一 id），只作兼容字段；下游一律用 `mem_id`。

2026-10-19 的稳定 id 迁移：旧 `vectors.meta.jsonl` 没有 `mem_id/text_sha256`，跑一次 `embed.mjs` 全量重编码（9,044 条，383.8 秒），再 `build-db --rebuild`。迁移前把 `vectors.bin`、`vectors.meta.jsonl`、`memory.db` 备份到同目录的 `*-backup-stableid`（保留，不自动删除）。迁移后 `eval-memory-search --validate-only` 的 69 条 target 全部按稳定标识解析，`eval-rerank S6,S6+R50` 的 hit@5 仍是 0.511 / 0.689，90 个逐条名次与迁移前完全一致；抽样 94 条逐条比较，迁移前后向量余弦 1.000000（batch 1 可复现）。

## 检索库

`build-db.mjs` 把 `memories/` 与 `vectors.*` 装进 `~/.dsh/memory-export/memory.db`。依赖 `sqlite-vec`（npm 包，本机 darwin-arm64 有预编译 `vec0.dylib`），用 Node 内置 `node:sqlite` 的 `loadExtension` 加载；`DatabaseSync` 要带 `{allowExtension:true}`，Node 需 ≥22.13（本机 v26）。

    node tools/memory-export/build-db.mjs [--rebuild] [--dir <dir>] [--vectors <dir|file>] [--out <file>]

- `--vectors` 传目录时用其中的 `vectors.bin` / `vectors.meta.jsonl`；传 `.bin` 文件时按同名派生 `.meta.jsonl` 与 `.meta.json`（例如 `vectors-ev.bin`）。meta 里必须有 `mem_id` 与 `text_sha256`；升级前的旧产物会直接报错并提示重跑 embed。`--out` 可建独立库：`--vectors ~/.dsh/memory-export/vectors-ev.bin --out ~/.dsh/memory-export/memory-ev.db`。

- `memories(offset UNIQUE, mem_id TEXT PRIMARY KEY, id_int UNIQUE, session_id, cwd, kind, seq, time, statement, evidence, tags, text_len, text_sha256)`；`mem_id` 是身份，`id_int` 是它在 vec0 里的整数 rowid，`offset` 只是排序/展示列（按 meta 行号赋值，同时充当 mem_fts 的 rowid），`tags` 存 JSON 数组。
- `mem_fts`：contentless FTS5（`content=''`、`contentless_delete=1`），只索引 `statement` 的 bigram 展开结果；rowid 用小的 `offset`（大 rowid 会把 FTS 索引撑大，实测 5.1 MB → 1.9 MB）。连续 CJK 展开成两两重叠的 bigram（n=1 保留单字），英文/数字/下划线小写原样，其余字符当分隔符。
- `mem_vec`：`vec0(embedding float[1024])`，rowid 用 `id_int`（mem_id 前 16 位十六进制转 int64，清掉符号位）。距离用默认 L2（向量已单位化，等价 cosine）。KNN 不支持对 auxiliary column 加 WHERE，过滤一律在拿到候选后做。
- 建库按 `mem_id` 对齐 meta 行与 memories：两边的 mem_id 集合必须一致，且重新算 `text_sha256` 必须与 meta 记录相同；不一致直接报错，不再按第 N 条位置比对。`id_int` 不参与任何 SELECT（超过 2^53，node:sqlite 读成 number 会抛 RangeError），需要时用 `cast(id_int as text)`。
- 建表前设 `auto_vacuum=INCREMENTAL` 与 `journal_mode=WAL`。默认写临时库、校验后原子替换；库已存在且条数/版本校验通过时跳过，`--rebuild` 强制全量重建。重复重建的 DB 字节一致。
- 当前全量：9,044 条，DB 46.4 MB（FTS 索引 1.9 MB，vec 数据 36.3 MB），单次重建约 0.6 s（迁移后实测 0.59 s）。
- vec0 的 rowid 必须用 BigInt 绑定：`node:sqlite` 把 JS number 绑成 REAL，会报 `Only integers are allows for primary key values on mem_vec`。

## 检索

`mem-search.mjs` 双路召回 + 可选的融合策略：

    node tools/memory-export/mem-search.mjs "<query>" [--k 5] [--strategy s1|s2|s3|s4|s5|s6]
        [--kw-weight N] [--keyword-mode tokens|phrase] [--expand]
        [--expand-target keyword|vector|both] [--rerank] [--rerank-depth N]
        [--project <子串>] [--kind <kind>]
        [--json] [--no-vector] [--no-keyword] [--no-miss-log]

- 关键词路，`--keyword-mode` 两种：
  - `tokens`（默认）：先从查询里抽精确 token，再对每个 token 跑 FTS。token 内部按 bigram 展开后 AND，token 之间 OR；候选排序按「命中 token 数 → Σ(-bm25) → 单 token 最好名次」。抽不到 token 的纯中文查询回退到旧行为。
  - `phrase`：旧行为，整句 bigram 按序短语匹配。保留用于对照。
  - token 抽取规则：引号内字符串（`"..."`、`'...'`、反引号、中文引号）；含 `. _ - / \ : # > @ ~ + = % & ?` 等符号的 ASCII 串；camelCase；全大写缩写；长度 ≥6 的纯 ASCII 词（含数字/下划线，如 `sales30`）；长度 ≥5 的首字母大写专有名词（排除常见英文虚词）。中文不抽 token。
  - 本库是 contentless FTS5，实测 `bm25(mem_fts)` 可用（SQLite 3.53.4 / node:sqlite），所以打分直接用 bm25，不需要自算「命中位置」回退。
  - 用途差异：旧 phrase 路在改写型（paraphrase）查询上恒为 0 候选；tokens 路对混合查询（自然语言 + 精确 token）能抽出 token，候选不再为 0。
- 查询分类 `classifyQuery()` 分三类，判据复用上面同一套 token 抽取，保证「分类说有 token」与 tokens 模式真能抽出 token 一致：
  - `exact`：抽得出 token，抹掉 token 后只剩标点/空白（纯 token 或 token 序列）。
  - `mixed`：抽得出 token，且剩余文本里中文 ≥ 2 字，或非 token 的 ASCII 字母 ≥ 20。
  - `natural`：抽不出 token。
  - 阈值取 2/20 的理由：单个汉字常是 token 旁边的单位或量词，2 字起才算自然语言措辞；纯 token 查询剩余 0 个汉字，eval-set 的 5 条混合查询剩余 ≥10 个，2 落在中间。英文 20 用来放过 token 序列里的短词（`git diff -U0` 只剩 8 个字母，`curl`/`exit` 之类更短），一句话的自然语言英文通常超过 20；eval-set 没有英文自然语言查询，这个阈值只防误伤。
- 查询扩展 `--expand`（默认关）与 `--expand-target`（默认 `keyword`）：
  - 只对 `classifyQuery()` 判为 `natural` 的查询触发。用 `deepseek-flash` 生成 3-5 条中文关键词短语（每行一条）。`--expand-target` 决定变体喂给哪条路：`keyword` 逐条跑关键词路、变体间按 RRF（k=60）合并；`vector` 逐条编码并各做一次 KNN；`both` 两边都喂。显式写 `vector`/`both` 时即使不加 `--expand` 也会触发扩展（`--expand` 仍是 `keyword` 目标的开关）。
  - 向量路合并：vec0 返回 L2 距离，`embed.mjs` 已把向量 L2 归一化，所以 `cosine = 1 - d²/2`。同一个 offset 出现在多条查询/变体的 KNN 结果里时取余弦最大值，再按余弦降序进入融合，不按名次做 RRF。返回字段里带 `similarity` 与每条查询的 `vectorMatches`（source/rank/余弦），`candidates.vectorEncoded` 是本次实际编码并 KNN 的查询条数。
  - 降级：扩展 API 失败（无 key / 网络 / 超时 / HTTP 错误 / 解析不出变体）或返回空变体时只 warn 并只用原查询；单条变体编码失败会跳过该条，全部失败时再 warn 一次。空变体的 warn 在进程内按查询去重。
  - key 从 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` 读，不打印。结果缓存到 `~/.dsh/memory-export/expand-cache.json`，同一查询重复评测不重复调 API。缓存里目前有 16 条（15 条 paraphrase + 1 条 mixed q26，后者按 natural 规则不会再触发扩展）。
  - 注意：中文变体在 tokens 模式下仍走 bigram 短语回退，因此对关键词路，扩展只在模型猜中 statement 里逐字出现的 ASCII 标识符时才有候选。
  - 实测（30 条、k=5）：向量路扩展没有达到把默认目标从 `keyword` 改成 `vector` 的门槛。paraphrase 子集 C（仅向量）hit@5/MRR@5 = 0.20/0.07，C2（仅向量+扩展向量）= 0.13/0.08；名次变好 3 条、变差 10 条、不变 2 条。MRR@50 从 0.415 升到 0.433、总 MRR@5 从 0.40 升到 0.41，说明变体把部分 target 往前拉了（q06 120→17、q14 未进前 200→6），但同时也把更多不相关记忆顶进 top-5（top-5 槽位 52/75 来自变体）。因此默认仍为 `keyword`。
- LLM 重排 `--rerank`（CLI 默认开）与 `--rerank-depth`（默认 100，范围 20-200）：
  - 只对 `classifyQuery()` 判为 `natural` / `mixed` 的查询触发；`exact` 查询关键词本来就全中，不重排。重排取融合后的 top-N（N=depth），交给 `deepseek-flash` 按 1-5 分判相关性，再取前 k 条；N 之后的候选保持融合顺序，所以名次仍可算到 200。
  - prompt 里每条候选含 `kind` 与截断到 200 字的 `statement`，编号 `#1..#N`。编号前按固定种子（`DEFAULT_SEED=20261019`）做 Fisher-Yates 打乱，映射只留在进程内，避免模型偏好靠前的候选。
  - 打分标准是「3 个月后另一个没见过原会话的人，只能看这一条记忆来回答这个问题」：5 直接给出答案，4 强相关，3 部分相关，2 只沾边，1 不相关。
  - 模型只输出一个 JSON：`{"top":[{"i":编号,"score":1-5}],"reason":"一句话"}`。解析容忍代码围栏与前后赘述，`i` 越界/重复会被忽略；同分按融合名次做稳定排序，模型漏掉的候选按融合名次补在末尾（分数记 0，候选不丢）。
  - 解析失败、超时、HTTP 错误、无 key 都退化为原始顺序并计数（`fallbacks` / `parseFailures` / `timeouts`）。同一进程内相同 `(模型, 查询, 深度, 候选集)` 只真实请求一次，其余命中内存缓存。
  - key 从 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` 读，不打印；token 用量、API 往返、估算成本记在 `rerankStats`，评测脚本会汇总。
  - 实测（45 条、k=5，合并后 batch 1 正式库）：paraphrase hit@5 从 0.27 升到 0.53（depth 50）/0.60（depth 100），keyword 子集保持 10/10，总 hit@5 0.51→0.69/0.73。重排 API p50 约 2.03 s（depth 50），端到端 p50 约 2.06 s；35 条触发重排的查询成本约 $0.054（depth 50）/ $0.105（depth 100，旧向量实测）。验收门槛（paraphrase 多 ≥3 条进 top-5 且 keyword 不退化）已达标，因此 CLI 默认开启；库内 `search()` 仍默认不重排，由调用方显式 opt-in。端到端延迟从约 30 ms 升到约 2 s，不需要时用 `--no-rerank` 关闭。
  - 未进 top-5 的原因：depth 50 的 13 条全部是 target 不在候选池（7 条 S6 排名 >50、6 条未进前 200），没有「在池内但重排判断错」的案例；depth 100 救回 q39（79→1），单条验证 depth 200 可把 q40（105→1）拉回，但 S6 未进前 200 的 6 条重排无法触及。唯一变差是 q35（1→3，仍在 top-5）：重排把两条同样说明「默认 en」的记忆排到了它前面。详细报告见 `~/.dsh/memory-export/rerank-eval/report.md`。
- 向量：查询加 `embed.mjs` 的同一 instruction，last-token 池化 + L2 归一化，vec0 KNN 取候选（无过滤时 50 条）。
- 融合策略（默认 `s6`）：
  - `s1` 等权 RRF，k=60，`score = Σ 1/(60+rank)`（旧基线）。
  - `s2` 旧二分类路由（保留作对照基线）：抽得出 token（`exact` 或 `mixed`）→ 关键词为主、向量补齐；`natural` → 向量为主、关键词补齐。`mixed` 仍走关键词优先，是为了让 P/D 基线可复现，混合查询的修复只体现在 `s5`/`s6`。
  - `s3` 加权 RRF：关键词路权重 `--kw-weight`（默认 3，评测试过 2/3/5），向量路权重 1。
  - `s4` 关键词优先回填：先取关键词 top-k，不足 k 再用向量补齐。
  - `s5` 三类路由：`exact` → 关键词优先；`mixed` → 等权 RRF；`natural` → 向量优先。
  - `s6` 三类路由：`exact` → 关键词优先；`mixed` / `natural` → 向量优先。45 条评测试过（合并后 batch 1 正式库）：paraphrase hit@5 0.27、mixed 1.00、keyword 10/10，总 hit@5 0.51、MRR@5 0.44；合并前 batch 16 旧向量是 0.56/0.44；旧的 30 条集上总 hit@5 是 0.60。
- `--project`/`--kind` 在两路候选进入融合前做外层过滤。带过滤时初始候选深度放大到 500，过滤后不足 k 条就按 ×4 加深（500 → 2000 → 4096）。4096 是 vec0 KNN 的上限；仍不足时走精确过滤回退：把 project/kind 推进 SQL，关键词按命中数/bm25、向量用 `vec_distance_L2` 全表算距离，再融合。只要过滤后确有 k 条就不会为空。
- 输出每条含 `score/kind/cwd/session_id/seq/mem_id/statement`（截断 160 字）；`--json` 额外给 `offset/time/evidence/tags/text_len/routes`，以及折叠时出现的 `also`（被折叠的 mem_id 数组）。
- 去重折叠 `--collapse-dups`（默认关）：读 `duplicates.jsonl` 做并查集，同一簇只返回排名最靠前的一条，其余 mem_id 记在该条结果的 `also` 里。检索默认行为不变；打开后会多取 4 倍候选再折叠，尽量保持 k 条。`--duplicates <file>` 可指定标记文件。
- miss-log 低置信度：重排开启时 top rerank 分数 <= `--miss-threshold`（默认 2）记 `low-confidence`；`--no-rerank` 时 top 结果的向量余弦 <= `--miss-cosine`（默认 0.35）记 `low-confidence`。只记录，不改变返回。重排开了但没拿到分数（exact 查询跳过、调用回退）时不判定。首行会打印 `strategy`、查询分类（`class=natural/exact/mixed` 与命中的信号）、`kwMode` 以及 `routeLimit`/`fallback`；关键词路每条变体的模式、候选数与 token 也会逐行打印。
- 模型加载（冷启动）单独计时打印到 stderr。

## 一键刷新

`refresh.mjs` 把增量链路串起来：export → distill（只蒸已归档且版本变化的会话）→ embed（按 mem_id 增量）→ `build-db --rebuild` → dedupe（只标记）→ `distill --status`。

    node tools/memory-export/refresh.mjs [--dry-run] [--skip-embed] [--no-distill]
        [--full-embed] [--skip-dedupe] [--dedupe-threshold N] [--min-idle-minutes N]

- 默认 `export-sessions.mjs`（未变文件只 stat，不解压）→ `distill.mjs --min-idle-minutes 30` → embed → 强制重建库 → 去重标记 → 打印状态。`--min-idle-minutes` 原样透传给 distill。
- embed 现在每次都跑，但按 `mem_id` 增量：只编码新增/变更的记录，没有要编码的不加载模型（9,044 条约 0.3 秒，主要是重写向量文件）。新会话插到中间不再影响向量，不会再触发全量重编码。`--full-embed` 保留为兜底，等价于 `embed.mjs --force`。
- 去重是 build-db 之后的一步：跑 `dedupe-stats.mjs --write --json --threshold 0.90`，把余弦 >= 阈值的配对追加进 `~/.dsh/memory-export/duplicates.jsonl`，同一对不重复写，只标记不删除。向量没变化且标记文件已存在时跳过（全量两两约 24 秒）。`--skip-dedupe` 关闭这一步，`--dedupe-threshold` 改阈值。
- `--skip-embed` 跳过向量化和建库，库保持上次状态；`--no-distill` 跳过蒸馏，此时 memories 视为未变，只导出、增量检查、重建库、打印状态。
- `--dry-run` 只读：跑 `export-sessions.mjs --dry-run` 与 `distill.mjs --dry-run`，报告将导出/将蒸/新会话/重蒸/pending 计数和是否需要 embed；不写锁、不写日志、不动库。export 新写入的会话文件在导出后才进入蒸馏判定，所以真实运行的待蒸数可能高于 dry-run 的「将蒸」。
- 锁 `~/.dsh/memory-export/refresh.lock`：进程存活或（锁文件里没有可用 pid 时）mtime 未超过 30 分钟，第二次调用直接退出并提示；结束、失败、中断都会清理自己持有的锁。
- 日志追加到 `~/.dsh/memory-export/refresh.log`：每步一行，含 `elapsed` 与关键计数；失败时写 `step=<步骤> failed` 并附该步 stderr 末尾 20 行，进程以非零退出、不再执行后续步骤。
- **蒸馏部分失败不再中止整条管线**：网络抖动导致个别会话 `fetch failed` 时，已成功的产物照常编码、建库、去重，保证库与 memories 一致；日志记 `step=distill partial` 与 `refresh done partial`，进程仍以退出码 1 结束，失败会话留在状态表等下次重试。
- 定时任务 `com.wens.mem-refresh`（`~/Library/LaunchAgents/`）每天 **10:00、13:00、16:00** 各跑一次：正常几秒空跑，有失败时下一轮自动重试，不必等第二天。
- 空跑通常几秒（export 对未变文件只 stat，distill 全部 unchanged 不调 API，embed 增量检查约 0.3 秒，建库约 0.6 秒，去重因向量未变跳过）。有新增会话时耗时主要在蒸馏（API，实测 10 个会话约 24 秒）和只编码新增记忆（batch 1 约 25 条/秒）；全量重编码只在 --full-embed 或首次迁移时发生（约 6 分钟）。

## 评测与去重统计

    node tools/memory-export/eval-memory-search.mjs [--db <file>] [--repeat 20] [--set <file>]
        [--configs A,B,C,C2,C3,D,E,F,F2,F3,G,S1,S5,S6] [--no-latency] [--validate-only]
        [--compare-db <file>]
    node tools/memory-export/eval-rerank.mjs [--db <file>] [--set <file>]
        [--configs S6,S6+R50,S6+R100,C,C+R50]
    node tools/memory-export/dedupe-stats.mjs [--threshold 0.95] [--examples 3]
        [--dir <向量目录>] [--write] [--out <duplicates.jsonl>] [--json]

- `--db` 指定被评测的库。`--compare-db` 用同一评测集把 `--db`（baseline）与对照库逐条对照，只支持不触发查询扩展的组合（S1/S5/S6 等）：输出两组分类型指标、paraphrase 与 keyword 的逐条名次、两边延迟 p50。

`eval-set.json` 是 45 条带标注的查询：30 条改写型（与所有 target 的 statement 不共享 3 字以上连续片段；分 easy/medium/hard 三档各 5 条新增）、10 条关键词型（ASCII 标识符/命令/文件名/报错串/专有名词）、5 条混合型；覆盖 13 个 cwd、5 种 kind，32/45 条目标来自 intranet-aio 之外的项目。

target 用稳定标识定位，不再依赖会整体平移的 `offset`：每条 target 带 `session_id`、`seq`、`kind`、`statement_hash`（对空白归一化后的 statement 做 sha256 取前 16 位），`offset` 只作缓存/兼容字段。两个评测脚本加载时先按 `session_id + seq + kind` 查 `memories`，再用 `statement_hash` 唯一确定当前 `offset`；解析不到就报「目标已失效」并打印完整标识（缺字段、同键多条命中同理），不会静默跳过；只有四个稳定字段全缺时才退回 `offset`。记忆增删导致 offset 平移后不需要手工重映射。解析逻辑在 `eval-memory-search.mjs`（`resolveTargetOffsets` / `applyTargetOffsets`），`eval-rerank.mjs` 复用同一份实现。按稳定标识回查后，评测前还会校验 paraphrase 的 3 字片段约束、检查 query/id 是否重复、确认 keyword 型 target 都在 tokens 关键词路候选里；同时检查覆盖门槛（≥12 个 cwd、5 种 kind、≥10 条非 intranet-aio 主目标）。

`eval-rerank.mjs` 只跑重排相关的五组：`S6`（基线）、`S6+rerank(50)`、`S6+rerank(100)`、`C`（仅向量）、`C+rerank(50)`。每条查询分两遍：k=5 的真实路径用于延迟，k=200 的深路径用于名次；第二遍重排命中进程内缓存。输出指标、paraphrase 30 条逐条名次、难度分档、S6→重排的变好/变差、被救回/被挤出的 target、未进 top-5 的原因分类（候选池外/判断错）、延迟与成本，产物写到 `~/.dsh/memory-export/rerank-eval/`。

`eval-memory-search.mjs` 默认跑十一种组合：

- A 仅关键词·phrase（旧关键词路）
- B 仅关键词·tokens（新关键词路）
- C 仅向量
- C2 仅向量 + `--expand-target vector`
- D s2 路由 + 新关键词路（旧二分类路由基线）
- E 仅向量 + `--expand`（对照）
- F s2 路由 + 新关键词路 + `--expand`
- S1 s1 等权 RRF + 新关键词路（对照组）
- S5 s5 三类路由 + 新关键词路（mixed → 等权 RRF）
- S6 s6 三类路由 + 新关键词路（mixed → 向量优先）
- F2 s6 + 新关键词路 + `--expand-target vector`

另附诊断组合：`P` s2 + phrase（旧默认，用于复现改造前基线）、`G` 仅关键词·tokens + `--expand`（隔离扩展对关键词路的实际影响）、`C3` 仅向量 + `--expand-target both`（按构造与 C2 等价，作一致性检查）、`F3` s6 + `--expand-target both`，以及 `C`/`E`、`D`/`F` 的逐条名次等价性检查。

输出：逐条 target 排名、按 paraphrase/keyword/mixed 分组的 hit@5 / P@5 / MRR@5 / MRR@50、mixed 子集逐条 target 名次（各所选组合）、keyword 子集 hit@5 是否 10/10、mixed 子集 A→B 的候选数对比、keyword 子集 A→B 的逐条名次与指标（检查退化）、B→G 与 P→D 的逐条名次变化、paraphrase 子集 C→C2 与 S6→F2 的逐条名次对照、扩展向量路统计（有变体查询数/变体编码数/单条与单查询编码 p50/KNN 查询数/缓存命中）、扩展样例与 token 用量/成本、延迟表（p50/p90/编码 p50/变体编码 p50/变体数/缓存命中时的扩展耗时）。

延迟测量为每查询预热 1 次 + `--repeat` 次，k=5、routeLimit=50；扩展 API 的首次往返延迟单独汇总（缓存命中的重复评测不计入，命中次数单独计数），token 成本按 flash 0.30/1.20 美元每百万 input/output 估算。`--expand-target vector/both` 的额外成本主要是变体编码：实测单条变体 p50 约 22 ms、5 条变体合计约 111 ms，端到端 p50 从 C 的 30.9 ms 升到 C2 的 99.9 ms（S6 29.4 → F2 96.0）。`--validate-only` 只做目标解析与评测集校验（按稳定标识回查当前库，不加载模型）。`dedupe-stats.mjs` 对 `vectors.bin` 做全量两两余弦（9,044²/2 ≈ 4,089 万次点积，约 24 s），只统计/标记不删除；阈值高于模型实际相似度上限时结果为 0，可降低阈值看近似重复。`--write` 把 `cos >= threshold` 的配对按无序 `mem_id` 去重后追加进 `<dir>/duplicates.jsonl`（`mem_id_a/mem_id_b/cosine/marked_at`），`--json` 只输出一行机器可读汇总。当前 9,044 条在阈值 0.90 下实测 179 对、涉及 278 条、121 个簇，全量最大余弦 0.9496（`duplicates.jsonl` 里 179 行）。任务书上「11 对 / 最大 0.923」是更早 8,852 条时的数字，已被数据增长取代。超过 2 万条时应改为分块或候选剪枝，当前没有做（代码里有注释）。

## 失败查询收集

`mem-search.mjs` 默认把失败查询追加到 `~/.dsh/memory-export/miss-log.jsonl`（JSONL，一行一条，只追加）。触发条件：

- 结果为空（0 条）→ `reason: "empty"`；
- 带 `--project` / `--kind` 且过滤后为空 → `reason: "filtered-empty"`；
- 执行异常（参数解析完成之后：库不存在、sqlite-vec 或模型加载失败、检索抛错）→ `reason: "error"`，进程仍按原逻辑打印错误并以非零码退出。命令行参数本身的校验错误（未知参数、`--k` 越界、缺少 query）不记录——此时还没有可信的查询上下文。
- 有结果但语义上答不上来 → `reason: "low-confidence"`，并写当时的 `topScore`。判据分两种：重排开启时看 top 结果的 rerank 分数（1-5），`<= --miss-threshold`（默认 2）才记；`--no-rerank` 时看 top 结果的向量余弦，`<= --miss-cosine`（默认 0.35）才记。重排开了但没拿到分数（exact 查询跳过、调用回退）时不判定。只记录，不改变返回。

正常有结果且置信度够的查询不记。`--no-miss-log` 关闭记录。写日志失败（目录不可写等）静默忽略，不影响检索本身。评测脚本 import `search()` 直接调用，不会写这份日志。

字段：

    {"ts":"ISO","query":"...","reason":"empty|error|filtered-empty|low-confidence","k":5,
     "project":null,"kind":null,"topScore":null,"elapsedMs":0,"mode":"keyword+vector",
     "error":null,"qid":"<sha1>"}

- `qid` = sha1(归一化后的 query)，归一化 = trim + 连续空白折叠成单个空格 + 小写。`miss-review.mjs` 按它去重，算法与 `mem-search.mjs` 的 `missQueryId()` 一致。
- `mode` 由本次启用的路拼成 `keyword+vector` / `keyword` / `vector`。
- `topScore`：结果为空/异常/过滤后为空时为 `null`；`low-confidence` 时是触发判定的那个分数（重排开启时是 rerank 分数 1-5，`--no-rerank` 时是 top 结果的向量余弦）。
- `elapsedMs` 正常路径取 `search()` 的 `totalMs`；异常路径取从参数解析完成到失败经过的毫秒数。
- 轮转：追加前如果 `miss-log.jsonl` 超过 5 MB，先把它重命名为 `miss-log.1.jsonl`（覆盖上一份轮转文件），本次记录写进新的 `miss-log.jsonl`。`miss-review.mjs` 只读当前文件，不会自动合并轮转文件。

查看：

    node tools/memory-export/miss-review.mjs --list [--days N]
    node tools/memory-export/miss-review.mjs --stats
    node tools/memory-export/miss-review.mjs --append-pending

- `--list`：按 `qid` 去重，按出现次数降序打印次数、最近一次时间、最新一条的 `reason`、query；`--days N` 只看最近 N 天。
- `--stats`：总条数、去重后条数、按 `reason` 分布、最近 7 天新增（记录数与去重 query 数）。
- `--append-pending`：把去重后的 query 追加进 `eval-set.pending.json`，已存在的 `qid` 跳过。结构：

      {"schema":"dsh-eval-pending/1","entries":[
        {"qid":"...","query":"...","addedAt":"ISO","source":"miss-log","targets":[],"status":"unlabeled"}
      ]}

  只动 `eval-set.pending.json`，不碰 `eval-set.json`。pending 文件解析失败时直接报错、不覆盖原文件。

把 pending 标成正式 case 需要人工判断（`--promote` 未实现）：

1. 从 `--list` 挑 query，用 `mem-search.mjs "<query>"` 看 top-5，确认期望命中的 `session_id` / `seq` / `kind`。
2. 在 `eval-set.pending.json` 对应 entry 的 `targets` 里补 `{session_id, seq, kind, statement_hash}`，`status` 改为 `labeled`。`statement_hash` 算法见 `eval-set.json` 的 `rules.target_identity`。
3. 手工把这条 entry 并入 `eval-set.json` 的 `queries`（分配新 id、`type`、`difficulty`），再从 pending 里删掉。
4. 跑 `node eval-memory-search.mjs --validate-only`，确认 target 能按稳定标识解析、原有评测集仍通过。

`eval-memory-search.mjs --validate-only` 在 pending 文件存在时额外打印一行 `pending: N 条（eval-set.pending.json，未计入评测集）`；pending 不计入现有 45 条，也不参与校验失败判定。`eval-rerank.mjs` 只读 `eval-set.json`，同样忽略 pending。
