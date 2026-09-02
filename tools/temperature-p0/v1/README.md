# P0 验证：deepseek-v4 系列是否响应 temperature —— 测试方法与验收标准

> 背景：dsh 主聊天链路走 OpenAI 兼容 Chat Completions（`{baseURL}/chat/completions`），
> `temperature` 未定义时不发该字段（`dsh-llm-deepseek:244`），由 provider 默认（DeepSeek chat 默认 1.0）。
> 但**协议有参数 ≠ 模型响应参数**——DeepSeek 的 reasoning 类模型（deepseek-reasoner/R1）在同一个
> chat completions 接口下忽略 temperature（[R1 issue #436](https://github.com/deepseek-ai/DeepSeek-R1/issues/436)），
> 部分兼容部署甚至报错（[temperature is deprecated](https://errs.dmxapi.cn/detail.php?id=4252)）。
> 本目录的目标：用可复现实验判定 deepseek-v4-flash / deepseek-v4-pro 到底属于哪种，并给出验收标准。

## 1. 测试分层

| 层级 | 内容 | 工具 | 结论能力 |
|---|---|---|---|
| L1 协议探针 | 同 prompt、temp=0 vs temp=2，各少量请求 | `probe.mjs`（本目录） | 排除"报错/字段被剥离"；初步看是否有差异 |
| L2 行为 A/B | 每 arm N=20+，固定 prompt + 固定 max_tokens，交错执行 | `probe.mjs --n 30` | 统计判定"生效 / 忽略 / 弱生效" |
| L3 链路复现 | 经 dsh 真实链路（stream:true + thinking/reasoning_effort 序列化）发请求 | 小型 dsh 插件或临时服务 | 确认真实调用路径下行为一致（温度与推理参数是否互斥） |

> L3 必要性的原因：竞技场/主会话真实请求带 `thinking` 与 `reasoning_effort`（`dsh-llm-deepseek:242`），
> 可能与 temperature 有交互；L2 的裸 chat/completions 结论不能直接外推。

## 2. 运行

```bash
# 快速探针（L1，约 12 次请求）
node tools/temperature-p0/probe.mjs --model deepseek-v4-flash --temps 0,2 --n 6

# 完整 A/B（L2，建议跑两个模型 × {0, 1.0, 2} × 20+）
node tools/temperature-p0/probe.mjs --model deepseek-v4-flash,deepseek-v4-pro --temps 0,1,2 --n 20
```

凭据：优先 `$DEEPSEEK_API_KEY`，否则读 `~/.dsh/.credentials.yaml`（与 dsh web 同源）。
端点：`$DEEPSEEK_BASE_URL` 或 `https://api.deepseek.com`（`deepseek-official` 默认，`dsh-llm-deepseek:1650`）。

## 3. 观察什么

探针输出每个 arm（model × temperature）：
- **失败率 + 错误详情** → 判定 REJECTED（温度被拒）还是正常；
- **verdict 格式解析率** → 结构化任务下格式稳定性（温度高 → 格式漂移风险）；
- **组内两两相似度**（字符 4-gram Jaccard）→ 温度生效时 temp 越低组内越相似、temp 越高越分散；
- **输出预览** → 肉眼确认多样性差异。

## 4. 验收标准（P0 判定矩阵）

判定前**先预注册**指标与阈值（避免事后挑数据）；建议跑 `--n 20` 以上、两轮交错执行（A B B A）抗时间漂移。

| 判定 | 标准（全部满足才算） | 后续动作 |
|---|---|---|
| **PASS（温度生效）** | (a) T0 与 T2 在 ≥2 个指标上差异显著且方向符合预期（T0 相似度更高 / verdict 解析率更高或持平；T2 更分散）；(b) 差异幅度超过容差（如相似度中位数差 ≥ 0.10，或效应量 Cohen's d ≥ 0.8）；(c) 两极端值均无 API 报错；(d) L3 链路复现一致 | 执行 P1 注入；再做 0.1/0.3/0.5 校准，把建议值落成可执行默认 |
| **IGNORED（温度被忽略）** | 差异不显著（p ≥ 0.2）**且** 95% CI 落在预设等效界内（如相似度差 < 0.05，用等价性检验 TOST，避免"样本不够所以测不出"误判）；N 足够（事前 power：能检出 d=0.8 效应） | 温度特性对 v4 空转 → 转向 `reasoning_effort`/prompt 控制；配置页对这类模型禁用温度输入并提示 |
| **REJECTED（温度被拒）** | ≥3 个不同 prompt 稳定复现 4xx/报错，或经代理抓包确认字段被剥离 | 注入器按模型能力门控（**绝不向不支持模型发 temperature**）；配置页禁用+警示。此情形最危险：注入可能使整次调用失败 |
| **部分模型** | 按模型分别判定（如 flash PASS、pro IGNORED） | 注入器 per-model 路由；配置页按模型显示可用性 |

关键判读陷阱：
1. **"无显著差异" ≠ "被忽略"**——必须先做 power/等价性检验，否则小样本下的"没测出来"会被误判成"模型忽略"；
2. **不能只测极端值**——加一个 `temperature: 1.0`（provider 默认）做中间对照，区分"被忽略"与"弱生效"（0 与 2 接近、1.0 居中 → 弱生效）；
3. **必须 L3 复现**——裸请求生效不代表带 `thinking/reasoning_effort` 的真实链路生效。

## 5. 决策后的落地（对应主调研的 P0→P1→P2）

- PASS → 按主调研 P1（agent/request 注入 + compaction/审查温度）+ P2（轮次级粒度、0~2 护栏）执行；
- IGNORED/REJECTED → 主调研结论整体重定向：温度配置页改为"模型能力感知"（不支持的模型禁用），
  控制手段转向 `reasoning_effort`；REJECTED 时注入器必须先加能力门控再上线。

## 6. 初步实测（2026-08-24，deepseek-official，https://api.deepseek.com）

> 结果供参考，样本有限（n=10~12/arm），尚未做多重检验与 L3 链路复现，不构成最终判定。

**结构化评审题（n=12/arm，verdict 行为）：**

| model | temp=0 | temp=1 | temp=2 | 观察 |
|---|---|---|---|---|
| flash 相似度 | 0.376 | 0.378 | 0.373 | 完全平坦 |
| pro 相似度 | 0.422 | 0.411 | 0.378 | 单调微降（Δ=0.044，CI 高度重叠） |
| 两模型 verdict | 全 NEEDS_REVISION | 同 | 同 | **36/36 判定行为对温度零敏感** |
| API 错误 | 0 | 0 | 0 | 排除 REJECTED |

**开放题（n=10/arm，多样性指标更灵敏）：**

| model | temp=0 | temp=2 | 观察 |
|---|---|---|---|
| flash 相似度 | 0.120（CI 0.102–0.143） | 0.193（CI 0.168–0.219） | **反向**：高温反而更相似，且 CI 不重叠 |
| pro 相似度 | 0.293（CI 0.244–0.340） | 0.224（CI 0.184–0.267） | 期望方向但 Δ 小、CI 重叠，弱信号 |

**关键观察：`temperature=0` 不产生确定性输出**（两模型相似度 0.12~0.42，远低于"贪心解码应有的 ~1.0"）。
若温度参数真实生效，temp=0 应近乎逐字一致。实测两点共同指向：
**温度参数对 deepseek-v4-flash/pro 基本无效（或被子模型内部采样策略覆盖）**：
(1) T0 不收敛；(2) flash 上 T2 反而比 T0 更相似（方向与温度语义相反），模型间方向不一致。

**初步倾向：IGNORED（待决定性验证）**。剩余工作：更大 N + 多重检验、多 prompt、以及最关键的
**L3（经 dsh 真实链路，带 thinking/reasoning_effort）复现**——真实链路行为可能与裸 chat/completions 不同，
是最终定案的必要一步。> ⚠️ 本节为初步观察；正式判定见 §9（**已修正为 INCONCLUSIVE**）。

## 7. L2 正式版实测（2026-08-24，n=20/arm，交错执行，bootstrap R=1000，α=0.0125）

2 模型 × 2 prompt × 3 温度 × 20 = 240 次调用，**0 失败 / 0 报错（REJECTED 排除）**。指标：组内两两相似度
（字符 4-gram Jaccard）均值差 Δ = T2 − T0，bootstrap p 与 95% CI。

| model × prompt | T0 | T1 | T2 | Δ(T2−T0) | p | 95% CI | 判定 |
|---|---|---|---|---|---|---|---|
| flash × structured | 0.374 | 0.355 | 0.334 | −0.041 | 0.368 | [−0.137, 0.033] | INCONCLUSIVE |
| pro × structured | 0.411 | 0.441 | 0.423 | +0.012 | 0.566 | [−0.032, 0.055] | INCONCLUSIVE |
| flash × open | 0.099 | 0.131 | 0.107 | +0.008 | 0.861 | [−0.074, 0.093] | INCONCLUSIVE |
| pro × open | 0.249 | 0.241 | 0.279 | +0.030 | 0.533 | [−0.064, 0.127] | INCONCLUSIVE |

**决定性证据（不受相似度噪声影响）：verdict 行为恒定性**——structured 题 120 次调用（40/arm/温度）中
**119/120 输出 NEEDS_REVISION**，temp 从 0 到 2 判定行为完全一致（唯一例外：flash@T2 有 1/20 未按格式输出
verdict 行，是 120 次中唯一的格式漂移，发生在最高温）。**温度参数对"评审判定"这一竞技场核心输出零影响。**

**辅助证据：`temperature=0` 不产生确定性输出**——若参数真实生效，T0 应近似贪心解码（相似度 → ~1.0）；
实测 T0 相似度仅 0.099~0.411，且各温度曲线非单调（flash×open: 0.099/0.131/0.107；pro×open: 0.249/0.241/0.279），
无一致梯度。

**结论：**
1. REJECTED 排除（两极端值零报错）；
2. 4/4 比较均不显著（p ≥ 0.368 >> α），方向不一致，无温度梯度 → **无证据表明温度影响输出**；
3. 竞技场评审判定行为对温度**零敏感**（120 次唯一结论）——对该用途，温度配置页"设了也白设"；
4. 正式口径：相似度差的等价性检验样本仍不足（CI 跨 ±0.05 等效界），"忽略 vs 弱生效"未在统计上收口；
   但结合 (2)(3) 与 T0 不收敛，实际倾向 **IGNORED（温度被内部采样策略覆盖）**——
   ⚠️ 属初步倾向而非判定，正式判定见 §9（已修正为 INCONCLUSIVE；verdict 恒定性为任务天花板效应，
   T0 不收敛前提依赖无 seed 假设，均不作判定依据）；
5. 残余风险：pro×open 的 Δ=+0.030 与 flash×structured 的 Δ=−0.041 方向相反且都不显著——即使存在弱效应，
   也不改变判定行为；高温下确有格式漂移风险（flash@T2 1/20）。

**下一步（定案剩余项）**：L3 经 dsh 真实链路（stream:true + thinking/reasoning_effort）复现；
若 L3 一致 → 判定 IGNORED，温度配置页对该模型重定向为 reasoning_effort/prompt 控制，注入器按模型能力门控。

## 8. L3 真实链路实测（2026-08-24，DeepSeekAdapter 生产同款，stream:true，reasoningEffort=high）

> 非裸 curl：直接实例化 `dsh-llm-deepseek` 的 `DeepSeekAdapter`，走 `prepareCall → stream` 真实序列化
> 路径（与 harness 生产一致，含 `stream:true`/`stream_options`/`reasoning_effort:high`——profile 实际配置，
> `settings.yaml` agent-default-model 与全部 arena 链接均为 high）。2 模型 × 2 prompt × 3 温度 × n=10 = 120 次，
> **0 失败**。

| model × prompt | T0 | T1 | T2 | Δ(T2−T0) | p | 95% CI | 判定 |
|---|---|---|---|---|---|---|---|
| flash × structured | 0.337 | 0.410 | 0.408 | +0.071 | 0.148 | [−0.033, 0.165] | INCONCLUSIVE |
| pro × structured | 0.401 | 0.409 | 0.386 | −0.015 | 0.763 | [−0.110, 0.090] | INCONCLUSIVE |
| flash × open | 0.156 | 0.131 | 0.160 | +0.003 | 0.956 | [−0.108, 0.133] | INCONCLUSIVE |
| pro × open | 0.310 | 0.294 | 0.313 | +0.003 | 0.953 | [−0.131, 0.149] | INCONCLUSIVE |

**verdict 恒定性**：structured 题 60 次真实链路调用（20/温度）**60/60 NEEDS_REVISION**，判定行为对温度零敏感。

**与 L2 对照**：真实链路（带 reasoning_effort=high）行为与 L2 裸请求**一致**——8/8 比较全不显著、方向不一致
（flash×structured +0.071 反向、pro×structured −0.015 弱期望向、两 open ≈ 0）、温度曲线非单调、T0 不收敛
（相似度 0.16~0.40，远非贪心应得的 ~1.0）。**L3 假设（真实链路行为不同）未获支持。**

## 9. P0 最终判定（L2 + L3 合计 360 次调用，0 失败）——**已修正：INCONCLUSIVE**

> **判定修正记录（2026-08-24）**：本节早期版本将结论定案为 IGNORED，存在三处超出证据的错误——
> (1) 违反 §4 预注册矩阵：IGNORED 要求 CI 落入 ±0.05 等效界且等价性收口，实测 8/8 比较全部
> INCONCLUSIVE（CI 全部跨界）；(2) 以「verdict 恒定性」这一**未预注册**的指标作决定性证据，而该
> 恒定性实为结构化题的任务天花板效应（粗粒度二值 + 答案近乎确定），只证明任务不敏感；(3) 以
> 「T0 不收敛」作辅助证据，而请求体无 seed（probe.mjs:62-68），temperature=0 不保证跨请求确定性，
> 前提不成立。现按证据范围回退为 INCONCLUSIVE。

| 验收项 | 结果 |
|---|---|
| REJECTED | **排除**：360 次 0 报错（temperature 字段被接受） |
| PASS | 不支持：8/8 比较不显著（p ≥ 0.148）、方向不一致、无一致温度梯度 |
| IGNORED | **不成立**（预注册条件未满足：CI 全部跨 ±0.05 等效界，等价性未收口；verdict 恒定性是任务天花板效应，非判定依据） |
| **INCONCLUSIVE（正式判定）** | temperature 对 v4 是否生效**既未证明也未证伪** |

**能严格成立的陈述（仅此两条）**：
1. REJECTED 排除：temperature 字段被接受，两极端值 0/2 在 360 次调用中无任何 API 报错；
2. 在「结构化评审题 × deepseek-v4-flash/pro」这一具体任务×模型×prompt 组合下，未观察到温度导致的
   判定变化——**这是任务级结论，不得外推**。

**业务后果（全部降级为与证据匹配的弱化表述）**：
1. ~~温度配置页对这两个模型"设了也白设"~~ → **未检测到**对评审判定与两类 prompt 措辞的温度效应；
   main 模型内容生成多样性（提案/测试用例）**未覆盖**，不能推广到三场景×两角色；
2. ~~控制手段转向 reasoning_effort~~ → **待验证假设**（需操纵 effort 的对照实验），非实验结论；
   profile 当前已为 high，动无可动；
3. ~~注入器按模型能力门控~~ → 方向合理但**能力清单机制未建立**（需逐模型实测，本实验仅 flash/pro 两模型）。

**若要真正定案，需补齐的方法修正清单**：
1. **seed 对照组**：同 seed 下 T0 应确定性 → 分离「忽略/钳制」与「无 seed 非贪心」两种解释；
2. **预注册 TOST + 事前 power**（能检出 d=0.8 的 N），α 按实际比较次数校正，报精确 p 值并保留原始数据；
3. **换灵敏指标**：token 级多样性、困惑度、对齐编辑距离，并先做指标对温度效应的效度检验
   （4-gram Jaccard 对短文本不灵敏，见 §7 指标讨论）；
4. **补 main 模型内容生成任务**（测试用例/提案生成多样性），覆盖配置页三场景；
5. **L3 读生产 settings.yaml**（而非空配置注释断言），核对生产端点；
6. §6/§7 的「倾向 IGNORED」均为初步倾向而非判定，以本节 INCONCLUSIVE 为准。
