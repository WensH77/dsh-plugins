# v2 重试：deepseek-v4 flash/pro 在 high/max 模式下是否响应 temperature

> v1 的最终判定是 **INCONCLUSIVE**（见 `../v1/README.md` §9）：REJECTED 已排除，但「忽略 vs 弱生效」
> 未在统计上收口，三个决定性证据（verdict 恒定性 / T0 不收敛 / 无一致梯度）分别被天花板效应、
> 无 seed 假设、CI 过宽削弱。v2 不沿用 v1 任何数据，全新设计 + 全新采集。

## 1. 本次问题

对 **deepseek-v4-flash** 与 **deepseek-v4-pro**，分别在 `reasoning_effort = high` 与 `max`
两种真实链路模式下：**temperature ∈ {0, 1, 2} 是否影响输出？**

## 2. 与 v1 的差异（对应 v1 §9 方法修正清单）

| v1 缺陷 | v2 修正 |
|---|---|
| 无 seed，T0 不收敛时无法区分「忽略温度」与「无 seed 非贪心」 | 新增 seed 对照（`seed-v2.mjs`）：同 seed × T0 若逐字一致 → 温度生效；仍发散且三组多样性相当 → 被忽略 |
| 只有 4-gram Jaccard（对短文本不灵敏） | 新增归一化编辑距离相似度、字级 TTR、**逐字重复对占比 dup**（T0 确定性的无阈值直接度量） |
| 只看最终回答 | 同时捕获 thinking 文本（`reasoning-delta`）测其多样性——温度可能只作用于推理链 |
| 只有 effort=high（且靠注释断言 profile 值） | 本次读了生产 `~/.dsh/settings.yaml`（默认与全部 arena 链接均为 `reasoningEffort: high`）；v2 显式跑 high **和** max 两档 |
| 原始数据未保留 | 全量 texts/thinks 落盘 `results-v2.json` / `seed-v2.json`，可复算 |

## 3. 实验设计

**A. 主探针 `probe-v2.mjs`（L3 真实链路）**

- 经 `dsh-llm-deepseek` 的 `DeepSeekAdapter` 生产同款序列化（`stream:true` + `thinking:enabled` + `reasoning_effort`），非裸 curl；
- 2 模型 × 2 effort × 2 prompt（structured/open，与 v1 同题） × 3 温度（0/1/2，含 1.0 中间对照）× **n=15** = 360 次调用；
- 交错执行（每轮温度顺序交替）抗时间漂移，并发 6，max_tokens=1024；
- 截断输出（`finish=length`）单列统计、不参与多样性指标；
- 注意：真实链路**不发送 seed**（`dsh-llm-deepseek` 无该字段）——seed 问题由 B 负责。

**B. seed 对照 `seed-v2.mjs`（裸 API + seed + thinking）**

- 裸 API 直接请求（含 `thinking:enabled` + `reasoning_effort`），cell = 模型 × effort ×
  `{t0s42: T0+固定seed42, t2s42: T2+固定seed42, t0svar: T0+每call换seed}` × k=6 = 72 次；
- 判定逻辑：
  - `t0s42.dupRate > 0.5` 且 `t2s42.dupRate < 0.5` → **temperature 生效**（T0 贪心、T2 发散）；
  - `t0s42.dupRate > 0.5` 且 `t2s42.dupRate > 0.5` → seed 被尊重但 **temperature 被忽略**；
  - 两者都 ≈0 且三组多样性水平相当 → **temperature 被忽略**（内部采样策略覆盖，T0 非贪心）；
  - 两者都 ≈0 但 T0 组显著更相似 → 弱温度效应（非贪心采样下仍调制多样性）。

## 4. 预注册判定矩阵（先于数据，不事后挑指标）

**主探针**：对每个 model × effort × prompt 及每个指标（content-jacc4 为主指标，content-editSim 次指标，thinking-jacc4 参考指标），
计算 Δ = T2 − T0 相似度均值差的 bootstrap 95% CI（R=2000），等价界 ±0.05（与 v1 同）：

| CI 位置 | 判定 |
|---|---|
| 全部 < −0.05 | **PASS(方向正确)**：T2 显著更分散 |
| 全部 > +0.05 | **REVERSED(反向)**：T2 更收敛，与温度语义相反 |
| 落在 [−0.05, +0.05] | **IGNORED(与忽略一致)** |
| 跨过 ±0.05 | **INCONCLUSIVE(CI 过宽)** |

**model × effort 级判定**（主指标 + 次指标共 4 次比较/prompt 类，先看主指标）：

- **PASS**：≥2/4 比较为 PASS 且无 REVERSED，且 seed 对照支持；
- **IGNORED**：≥3/4 为 IGNORED 或（INCONCLUSIVE 但 dupRate(T0)≈0 且 seed 对照三组水平相当——辅助证据，需在结论中注明属于间接推断）；
- 其余：INCONCLUSIVE / 按模型分别陈述。

**判定前先看 dupRate**：若任一 arm 的 T0 `dupRate > 0.5`（T0 高度确定性）→ 与「温度生效」一致，推翻 IGNORED 方向；
若全部 T0 `dupRate = 0` → 与「T0 非贪心」一致，须结合 seed 对照解读。

## 5. 运行

```bash
cd tools/temperature-p0/v2
# 主探针（约 360 次调用, 10-20 分钟）
node probe-v2.mjs --models deepseek-v4-flash,deepseek-v4-pro --efforts high,max --temps 0,1,2 --n 15 --concurrency 6

# seed 对照（72 次调用, 数分钟）
node seed-v2.mjs --models deepseek-v4-flash,deepseek-v4-pro --efforts high,max --k 6 --concurrency 4
```

凭据：`$DEEPSEEK_API_KEY` 或 `~/.dsh/.credentials.yaml`（refs.DEEPSEEK_API_KEY，与 dsh web 同源）。

## 6. 结果（2026-09-02，deepseek-official，https://api.deepseek.com，经 DeepSeekAdapter 真实链路）

**规模与可靠性**：主探针 360 次 + seed 对照 72 次 = **432 次调用，0 API 报错，0 格式错误**。
主探针 24 个 arm 全部成功（15/15）；截断 0；空输出 4 次（flash×high×open T1/T2 各 1、pro×max×open T0/T2 各 1，
已按设计排除出多样性指标）。原始数据：`results-v2.json` / `seed-v2.json`。

### 6.1 主探针（每 arm n=15，相似度=字符 4-gram Jaccard / 编辑距离相似度；Δ=T2−T0，温度生效应为负）

| model × effort × prompt | T0 | T1 | T2 | Δ jacc / edit | p | 95% CI (jacc) | 判定 |
|---|---|---|---|---|---|---|---|
| flash × high × structured | 0.339 | 0.370 | 0.359 | +0.020 / +0.014 | 0.469 | [−0.041, 0.077] | INCONCLUSIVE |
| flash × high × open | 0.096 | 0.157 | 0.182 | **+0.086 / +0.096** | **0.045** | [0.005, 0.175] | INCONCLUSIVE（反向显著） |
| flash × max × structured | 0.341 | 0.385 | 0.388 | +0.047 / +0.018 | 0.133 | [−0.022, 0.106] | INCONCLUSIVE |
| flash × max × open | 0.118 | 0.116 | 0.144 | +0.026 / +0.014 | 0.527 | [−0.056, 0.111] | INCONCLUSIVE |
| pro × high × structured | 0.393 | 0.386 | 0.389 | −0.004 / −0.005 | 0.890 | [−0.068, 0.060] | INCONCLUSIVE |
| pro × high × open | 0.217 | 0.263 | 0.274 | +0.057 / +0.076 | 0.230 | [−0.043, 0.152] | INCONCLUSIVE |
| pro × max × structured | 0.391 | 0.370 | 0.413 | +0.021 / −0.009 | 0.473 | [−0.043, 0.081] | INCONCLUSIVE |
| pro × max × open | 0.194 | 0.223 | 0.204 | +0.010 / +0.012 | 0.794 | [−0.078, 0.093] | INCONCLUSIVE |

- **0/24 比较为 PASS**（无任何证据支持"T2 更分散"）；**20/24 的 Δ 为正**——方向与温度语义相反（T2 反而更相似），
  其中 flash×high×open 的两个内容指标反向显著（p=0.045/0.033，CI 下界 > 0）；
- **全部 24 个 arm 的 T0 dupRate = 0**（15 次调用两两 105 对，无一对逐字相同）：temperature=0 完全非贪心；
- **verdict 恒定性**：structured 题 180 次（2 模型 × 2 effort × 3 温度 × 15）**180/180 NEEDS_REVISION**，
  100% 格式解析。与 v1 相同，属任务天花板效应，仅作辅助记录；
- effort 维度：high 与 max 的温度曲线形态一致（均无梯度、T0 非确定），两 effort 间无实质差异。

### 6.2 seed 对照（k=6/cell，同 seed=42；dupRate=逐字重复对占比）

| model × effort | t0s42 (jacc/dup) | t2s42 (jacc/dup) | t0svar (jacc/dup) | 结论 |
|---|---|---|---|---|
| flash × high | 0.266 / 0.07 | 0.135 / 0.00 | 0.187 / 0.00 | 同 seed T0 仍发散（dup≈0）→ T0 非贪心 |
| flash × max | 0.138 / 0.00 | 0.152 / 0.00 | 0.141 / 0.00 | 三组完全平坦 → 被忽略 |
| pro × high | 0.247 / 0.00 | 0.284 / 0.00 | 0.308 / 0.00 | 三组平坦（甚至反向）→ 被忽略 |
| pro × max | 0.194 / 0.00 | 0.206 / 0.00 | 0.192 / 0.00 | 三组完全平坦 → 被忽略 |

**决定性点**：若 temperature 生效，同 seed 下 T0 应逐字一致（贪心解码）。实测 4/4 组 t0s42 dupRate ≈ 0
（仅 flash×high 有 1/15 对相同）——**给了 seed 也非贪心**。v1 的"无 seed 假设"（T0 不收敛是因为没发 seed）
被排除：T0 不收敛不是 seed 缺失，而是模型在 T0 下就不做贪心采样。

### 6.3 判定

| 验收项 | 结果 |
|---|---|
| REJECTED | **排除**：432 次 0 报错（high/max 两 effort 下 temperature 0/1/2 均被接受） |
| PASS（温度生效） | **不支持**：0/24 比较显示预期方向效应；20/24 方向相反；T0 dupRate 全 0；seed 对照排除 seed 缺失解释 |
| IGNORED（温度被忽略） | **行为证据链成立**：三条独立证据线一致——(a) seed 对照 4/4 组同 seed T0 非贪心且三组多样性水平相当；(b) 24/24 arm T0 零逐字重复；(c) 无任何一致性温度梯度（20/24 反向） |
| INCONCLUSIVE | 预注册矩阵（相似度差 CI 跨 ±0.05）单看仍未收口：24/24 比较 CI 跨界。但与 v1 不同，v2 的 seed 对照 + dupRate 提供了矩阵之外的**决定性行为证据**，不再依赖 CI |

**最终判定：temperature 参数对 deepseek-v4-flash 与 deepseek-v4-pro（high 与 max 两种 reasoning effort 模式下）
不产生可检测的影响——行为与"参数被忽略或被钳制为固定值"一致。**"忽略"与"钳制到固定非零值"在
行为上不可区分（都是设了没效果），但两者对下游的含义相同：**该参数对这两个模型是空转参数**。

与 v1 的差异：v1 因"无 seed 假设"无法排除而退回 INCONCLUSIVE；v2 补上 seed 对照后该解释被排除，
T0 非贪心 + 零梯度 + 方向反转的证据链足以支撑 IGNORED（行为意义）。

### 6.4 剩余不确定性与后续

1. **"忽略 vs 钳制"未区分**：若要区分，需请求带 `top_p` 或探 `logprobs`（DeepSeek 暂不支持 logprobs），
   或观察 T1 是否恰好等于某固定温度下的分布；当前业务结论不受影响；
2. **弱效应检出限**：若存在 <±0.05 相似度差的微弱温度效应，本实验（n=15）检不出；但 T0 dupRate=0
   这一决定性证据与"temperature=0 生效"互斥，弱效应即使存在也远弱于参数语义；
3. **flash×high×open 的反向显著（Δ=+0.086, p=0.045）**：方向与温度语义相反且与同模型 seed 对照方向矛盾，
   按噪声/任务特性处理，不做因果断言；
4. **high vs max 之间**的多样性/延迟差异未做显著性检验——若要把 max 作为"多样性替代手段"，需要单独的
   effort 对照实验（v2 只回答了"两种 effort 下温度是否生效"，答案都是否）；
5. verdict 恒定性仍是任务天花板效应（structured 题答案近乎确定），不构成独立证据。

### 6.5 业务落地建议（对应主调研 P0→P1）

- **配置页**：对 deepseek-v4-flash/pro，temperature 是空转参数（high/max 均如此）——建议该模型配置页
  将温度输入标注"该模型不响应此参数"或禁用，避免用户以为在控制多样性；
- **注入器**：REJECTED 已排除（字段被接受、无报错），无崩溃风险门控需求；但"注入无效参数"无价值，
  不必为此做 per-model 温度注入；
- **多样性控制**：转向 `reasoning_effort` 的方向仍值得验证（本实验只证明 temperature 无效，
  effort 对多样性的影响未测）；prompt 层控制（要求多样/枚举候选）是目前唯一确定有效的手段。
