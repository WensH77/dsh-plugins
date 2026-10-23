# 本地会话记忆系统：现状与实测结论

截至 2026-10-19。本文记录已经建成的四层管线、实测量化结果、踩到的坑，以及停下来时判断的下一步。所有数字都是本机跑出来的；标「估算」的地方没有实测。

## 一、管线与产物

```
~/.dsh/sessions/           原始会话日志（1,758 个，v0/v3/v4 三种格式，压缩 1.2 GB）
        │  导出（export-sessions.mjs）
        ▼
~/.dsh/memory-export/sessions/   957 个会话，44,822 条消息，37 MB
        │  蒸馏（distill.mjs，deepseek-flash）
        ▼
~/.dsh/memory-export/memories/   8,852 条原子记忆
        │  向量化（embed.mjs，Qwen3-Embedding-0.6B ONNX q8）
        ▼
~/.dsh/memory-export/vectors.bin 8,852 × 1024 float32，36 MB
        │  建库（build-db.mjs）
        ▼
~/.dsh/memory-export/memory.db   44.7 MB（memories + FTS5 bigram + vec0）
        │  检索（mem-search.mjs）
        ▼
关键词 ∪ 向量 → RRF → top-k 记忆 + session/seq 溯源
```

代码都在 `~/Documents/dsh-memory/`，数据都在 `~/.dsh/memory-export/`（仓库外）。

## 二、实测数据

### 导出层

| 项 | 值 |
|---|---|
| 处理日志 | 1,758 个（正则 `session(\.v\d+)?\.jsonl(\.zstd)?`，排除 `.bak`/`.lock`） |
| 产出会话 | 957 个（排除 613 个子代理会话、162 个无真人输入的会话） |
| 消息 | 44,822 条（user 7,811 / assistant 33,210 / tool-error 3,801） |
| 体积 | 37 MB，全量 13.4 秒，增量 0.17 秒 |

### 蒸馏层

| 项 | 值 |
|---|---|
| 记忆条数 | 14,704 条（1,615 个会话，含 648 个子代理会话）；9.1 条/会话 |
| 五类分布 | fact 7,485 / pitfall 3,378 / decision 1,959 / open_question 1,465 / preference 417 |
| 无效条目 | 333 条（3.63%，全量首轮）：证据找不到 219、证据超长 112、kind 非法 2 |
| 上下文约束 | 蒸馏提示词要求每条记忆自带适用范围（项目/文件/版本/前提）；「只摘规范原文、没写适用对象」的直接丢弃，计 `context-free` |
| token | 输入 9.40 M、输出 1.12 M |
| 成本 | 估算 $3.20（按全价冷跑 $4.16），13 分 24 秒 |
| 模型 | `deepseek-flash`；`deepseek-v4-pro` 在同样 10 个会话上成本 4.25 倍、无效 37.7%，已弃用 |
| thinking | 关闭。20 会话 A/B：16K 预算下开思考有 6/20 会话 reasoning 吃光 token、content 为空、0 条记忆；32K 能救回，但冷跑成本 2.3 倍、输出 token 7.5 倍、耗时 6–8 倍，人工对照质量 3:3 平手。个别高价值长会话可单独用 ≥32K 跑 on |

### 向量层

| 项 | 值 |
|---|---|
| 模型 | `onnx-community/Qwen3-Embedding-0.6B-ONNX`，q8，1024 维，last-token 池化，L2 归一化 |
| 吞吐 | **batch 1**：24.5 条/秒；增量按 `mem_id`，新增 2 条只需 1.4 秒，空跑 refresh 1.86 秒 |
| 校验 | 范数 0.999999–1.000001，NaN/Inf 0，同一句两次编码余弦 1.000000 |
| 可复现性 | **向量依赖同批文本**：同一句单独编码 vs 与长文本同批，余弦只有 0.955；同批重复才是 1.000000。所以默认 `--batch 1`，`--batch >1` 会 warning |
| 缓存 | 模型 613 MB 落在 `~/.cache/huggingface/transformers`，加载 0.5–0.7 秒 |

### 检索层

| 项 | 值 |
|---|---|
| 建库 | 0.52 秒；两次 `--rebuild` 的 SHA-256 一致 |
| 体积 | DB 44.9 MB（FTS 索引约 1.9 MB + 向量 37.0 MB） |
| 延迟 p50 | 关键词 0.026 ms、向量 25.0 ms（其中 17–22 ms 是查询编码）、混合 24.9 ms |
| 默认策略 | `s6`：纯 token 查询走关键词优先，混合/自然语言查询走向量优先。关键词模式为 `tokens`（抽精确 token 单独检索，不再是整句 bigram 短语） |
| 重排 | `--rerank` 默认开，深度 100：把 top-100 候选打乱顺序交给 `deepseek-flash` 按 1–5 分判相关性，再取前 k。只对 natural / mixed 触发，纯 token 查询跳过 |
| 过滤 | 带 `--project`/`--kind` 时候选深度 500 → 2000 → 4096 自适应放大，到顶仍不足则全表精确过滤回退 |
| 45 条评测 | 总 hit@5 **0.711**、MRR@5 **0.659**（默认 depth 100；depth 50 为 0.667 / 0.633；无重排 0.489 / 0.397） |

## 三、45 条评测的细分结果

| 子集 | 条数 | hit@5 | MRR@5 | 说明 |
|---|---|---|---|---|
| paraphrase（改写问法） | 30 | **0.567** | 0.506 | 重排前 0.267；depth 50 时 0.500 |
| keyword（精确 token） | 10 | 1.00 | 1.00 | 关键词路全中，重排不会触发 |
| mixed（自然语言 + token） | 5 | 1.00 | 1.00 | token 抽取后有 5–200 条关键词候选 |

**重排是真正的拐点。** 30 条 paraphrase 上，hit@5 从 0.267 升到 0.533，12 条变好、0 条变差、18 条不变；keyword 子集 10/10 完全不变。代价是每条触发查询多约 1.9 秒和约 $0.0016。

口径说明：0.711 / 0.663 是 batch 16 旧向量上的数字，那批向量不可复现；换成 batch 1 后基线是 0.689 / 0.646。**这是换编码口径，不是效果退化**——增量对照（保留旧向量、只编码新增 258 条）在排除 q13 后 hit@5 与旧基线完全一致，说明合并没有造成系统性回落。

## 四、踩到的坑

1. **日志文件名会变。** 六周内从 `session.jsonl.zstd` 变成 `.v3.`、`.v4.`。依赖文件名前缀的脚本会静默丢掉最新数据，`~/.agents/skills/session-search` 就是这样失效的。
2. **工具结果的日志结构跨版本不同。** v0/v3 里 `tool/result` 外面多包一层 `{type:"tool-result", content:[...], isError, toolCallId}`，callId 在 `message.source.callId`。按新格式写抽取会静默丢掉 73% 的错误工具输出（3858 条里 3085 条），且不报错。
3. **小样本测试会高估。** 50 条样本上新模型 smoke 5/5 全中；放到 8,852 条全量语料，同一条查询掉到第 47 名。语义检索的评测必须在全量语料上做。
4. **评测集构造决定能量什么。** 最初 paraphrase 子集要求「与目标不共享 3 字以上片段」，而关键词路是整句 bigram 短语匹配，必然 0 候选，四种融合策略在那套配置下逐条相同，评不出差异。改成抽精确 token、并给混合查询单独分类后，mixed 子集第一次有关键词候选（5–200 条），融合才变得可评。
5. **P@5 有结构上限。** 一条查询只有 1 个 target 时 P@5 最高就是 0.2，跨子集比 P@5 没有意义，主判据应该用 hit@5 和 MRR。
6. **`session_id:seq` 不唯一。** 8,852 条记忆只有 5,236 个唯一 id，同一条消息会抽出多条记忆。主键必须用 `offset`。
7. **去重阈值要比直觉低。** 全量两两余弦最大只有 0.923；阈值 0.95 时一对都没有，0.90 时 11 对、20 条（0.2%）。明显改写的重复（如 `webServer.register` 按 path 去重）也只在 0.92 附近。
8. **FTS 索引体积对不上。** 实测 1.8 MB，早期记录说约 19 MB；用 60 条随机 4 字中文子串与 `LIKE` 全扫对照，召回 60/60，确认没建漏，19 MB 应来自含 evidence 或 trigram 的另一套配置。
9. **huggingface.co 在这台机器上不通**（curl 000、fetch 超时），`hf-mirror.com` 通。任何从 HF 拉模型的脚本必须设 `env.remoteHost`。
10. **`thinking` 不能靠省略字段来关闭。** 实测 DeepSeek 接口不传 `thinking` 字段仍然会思考（reasoning_tokens 2,108），只有 `{type:"disabled"}` 才是 0；而 reasoning 计入 `max_tokens`，预算不足时会吃光导致 content 为空。
11. **embedding 是批量相关的。** 同一句话单独编码与和长文本同批，余弦只有 0.955；同一条记录放进相邻两个 16 条批次，余弦 0.642 / 0.584。batch 16 全量重编码会让 8,662 条未改动记忆的向量全部漂移，评测 hit@5 从 0.556 掉到 0.444。默认必须 batch 1；这是「同一输入永远同一向量」的唯一保证。
12. **评测集的 target 不能用 `offset`。** offset 是位置主键，记忆一增一删就整体平移，每次合并都要手工重映射（本次 69 个 target 全变了）。已改成 `session_id + seq + kind + statement_hash` 的稳定标识，加载时解析成当前 offset；69/69 可解析。
13. **向量不能只追加、不能续跑。** 记忆顺序按会话文件名字典序，新会话会插到中间而不是末尾。现已改成 `mem_id` 稳定主键（`sha256(session_id + seq + 归一化 evidence)` 前 16 位），embed 按 `mem_id + text_sha256` 增量，新增 2 条只需 1.4 秒；`offset` 只作排序展示。
14. **子代理会话的 user 消息不是用户输入。** 委派任务书、`[中继答案]`、多轮指令的 `source.kind` 都记成 `user`。`--include-subagents` 会把子代理会话里所有 user 消息标成 `task-brief`，蒸馏时丢弃 evidence 落在 task-brief 上的 preference/decision（否则会抽出与父会话矛盾的「用户偏好」）。
15. **`session-` 开头的会话 id 不能用短前缀。** 8 位前缀会退化成 `session-`，命中几百个会话；要 `session-` + UUID 前 8 位（共 16 字符）才能唯一定位。

## 五、判断

- 关键词路在精确 token 上接近完美（10/10、MRR 1.00），且只要 0.026 ms，应该保留。
- **真正的瓶颈是「排序」不是「召回」。** 向量能把多数目标带进候选池，但排不进前 5；加 LLM 重排后 paraphrase hit@5 从 0.267 升到 0.533，keyword 完全不受影响。说明判断环节比编码环节更值得投入。
- 剩下的未命中**全部**是 target 不在候选池（含个别连前 200 都没有），没有一条是「在池内但重排判断错」。要再往上，只能改召回——换更大的 embedding 是唯一没试过的杠杆。
- 8,920 条、1024 维的规模下，sqlite-vec 暴力扫描 5 ms 量级，索引不是问题；真正会随时间恶化的是 1024 维的线性扫描延迟（年增 5–7 万条，第 2–3 年越过 100 ms），届时可用 MRL 从已存向量截到 512，不必重新编码。

## 六、试过什么

按时间顺序，每条都是实测结论：

1. **已做：关键词路改成抽精确 token**，并给「自然语言 + token」的查询单独分类。mixed 候选从 0 变成 5–200 条；默认策略改为 `s6`（exact → 关键词优先，mixed/natural → 向量优先），keyword 子集 10/10 不退化。
2. **已试无效：查询扩展**（两种用法）。只喂关键词路时零排名收益（E≡C、F≡D）；把变体也编码进向量路、逐条取最大余弦后，paraphrase hit@5 从 0.20 降到 0.13、延迟从 30 ms 涨到 96 ms。
3. **已试无效：文档侧富化**。编码文本改成 `statement + "\n" + evidence`，paraphrase hit@5 0.20 → 0.13、MRR@5 0.069 → 0.083，编码时间 1.82 倍；默认仍只编码 `statement`。
4. **已做且有效：LLM 重排**。top-100 候选打乱后交 `deepseek-flash` 按 1–5 分判相关性（默认 `--rerank-depth 100`），paraphrase hit@5 0.267 → 0.533、MRR@5 0.178 → 0.456，keyword 不变；代价是每条触发查询多约 2.9 秒、约 $0.0023。depth 50 时总分 0.667、延迟 1.9 秒。
5. **已做：纳入 648 个子代理会话**。分 3 批加 100 会话试点，共 +5,660 条记忆（9,044 → 14,704），成本约 $1.32。与父会话严格重复 0、Dice≥0.7 约 2%，人工读新增信息约 55%；约 11% 的记忆证据只来自任务书转述，属较低证据等级。语料 +63% 后评测 hit@5 从 0.689 降到 0.667（depth 50），depth 100 可回到 0.689。
5. **已做：编码改成 batch 1**。batch >1 时同一文本的向量会随批组成变化（余弦 0.955 甚至 0.64），全量重编码会让整个向量空间漂移；batch 1 同时更快（24.7 条/秒 vs 19.0）。
6. **已做：评测集目标改稳定标识**（`session_id + seq + kind + statement_hash`），不再用 `offset`，记忆增删后无需手工重映射。
7. **剩余方向**：换更大 embedding（Qwen3-Embedding-4B，需下载数 GB、编码约一小时）来改善召回深度；以及去重（阈值 0.90 左右，只标记不删除）。

## 七、增量维护（已实现）

**不能靠「输出文件是否存在」判断是否已处理。** 会话是追加写的，已蒸馏的会话会继续变长；导出层也会重写 `sessions/<id>.json`。状态表在 `~/.dsh/memory-export/archive-state.json`：

```json
{"session_id":"...", "createdAt":1790000000000,
 "eventCount":421, "lastEventTime":1790000000000,
 "model":"deepseek-flash", "thinking":"disabled", "maxOutputTokens":8000,
 "phase":"base|boost", "memories":12, "invalid":1, "chars":42000,
 "status":"ok|failed", "archivedAt":"...", "distilledAt":"..."}
```

- **唯一键是 `<session_id>-<eventCount>`**，同一会话只保留 eventCount 最大的一行。`createdAt` 不进键（会话身份用 id 就够），`lastEventTime` 也不进键（它会随会话增长而变）。
- **只蒸馏已归档的会话。** header 里只有 `createdAt`、没有 `updatedAt`；`availability` 只有 `live` / `persisted`。归档判据是 `now - lastEventTime >= 240 分钟`（4 小时，可用 `--min-idle-minutes` 改）；未归档记为 `pending`，静默后再处理。
- **变更检测用 `(eventCount, lastEventTime)`，不要用 bytes/mtime。** 而且 `eventCount` 必须是**日志总事件数**，不是消息数——否则只追加成功的工具输出时计数不变，会永久漏检（已实测：只加一条成功 `tool/result`，`eventCount 6→7`、`messageCount` 不变，正确判为 `version-changed`）。
- **两阶段决策在首次蒸馏时一次做完**：先 `disabled/8000`；算密度；若 `chars >= 10000`、密度 `< 0.22`、`chars < 100000`，立刻用 `enabled/32000` 重跑并采用它的结果。这样存储是**追加式**的。
- **变更会话**：版本变了就重蒸。记忆用稳定主键 `mem_id = sha256(session_id + seq + 归一化 evidence)[:16]`，向量按 `mem_id + text_sha256` 增量，新会话插到中间不再触发全量重编码（新增 2 条约 1.4 秒）。
- **一键刷新 `refresh.mjs`**：export → distill → embed（增量）→ dedupe（0.90）→ conflict-scan → build-db → status；带文件锁与 `refresh.log`。空跑约 2 秒，有新会话时约 2 分钟（编码与去重占大头），API 成本只来自新会话蒸馏和冲突判定。
- **记忆状态**：`memory-status.jsonl` 追加事件，取最后一条，状态为 `active / superseded / conflict / duplicate`。检索默认只出 active，`--include-superseded` 查历史。
- **冲突判定**：候选 = 「共享对象锚点（ticket / 文件名 / `--flag` / 版本号 / 低频技术词）且余弦 ≥0.60」∪「余弦 ≥0.85」，交给 `deepseek-flash` 判 supersede / conflict / complement / unrelated。方向由时间强制：只有更晚的记忆能取代更早的；时间相同只能 conflict，且两条都标 conflict；时间不同时较晚一条保持 active 并记 `conflict_with`。成本约 $0.0001/对，随 refresh 每天跑。

## 八、复现

```bash
cd ~/Documents/dsh-memory

node export-sessions.mjs            # 导出，约 19 秒（未变文件只 stat，0.3 秒）
node distill.mjs --backfill-state   # 首次接入：补记已有产物，不调 API
node distill.mjs --status           # 看 pending / changed / orphans
node distill.mjs                    # 增量蒸馏，只处理已归档且版本变化的会话
node embed.mjs                      # 向量化（增量：按 mem_id 复用旧向量，只编码新增/变更）
node build-db.mjs --rebuild         # 建库，约 0.6 秒
node mem-search.mjs "<query>" --k 5 # 检索（默认带 LLM 重排）
node refresh.mjs                    # 一键刷新：export → distill → embed → dedupe → conflict-scan → build-db → status

node eval-memory-search.mjs --validate-only   # 校验评测集（稳定标识解析）
node eval-memory-search.mjs --repeat 20       # 策略对比
node eval-rerank.mjs                          # 重排评测
node dedupe-stats.mjs --threshold 0.90        # 去重统计
```

依赖：`@huggingface/transformers@4.3.1`、`sqlite-vec@0.1.9`，外加系统 `zstd` 命令。API key 只用于蒸馏，从 `~/.dsh/.credentials.yaml` 读取。
