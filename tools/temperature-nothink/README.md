# temperature-nothink：非 thinking 模式下 temperature 是否生效

## 1. 为什么补这一格

`../temperature-p0/` 两轮（v1 360 次、v2 432 次）都在 **thinking 模式**（`reasoning_effort: high/max`）下跑，
结论是 temperature 空转。但 [DeepSeek Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode/) 的原文限定是
**thinking 模式**不支持 `temperature`，对**非 thinking 模式**只字未提——那一格从未测过，
而它正是「配置页要不要禁用温度输入」这个产品结论的关键。

本 tool 就是那一格：`thinking: {type: "disabled"}` + `temperature ∈ {0,1,2}`。

## 2. 固定方法（改了就不是同一实验）

| 项 | 值 |
|---|---|
| 模型 | `deepseek-flash`（`deepseek-v4-flash` 现为其 legacy 别名） |
| thinking | `{"type": "disabled"}` |
| 传输 | 裸 API `https://api.deepseek.com/chat/completions`，`stream: false`，`max_tokens: 64` |
| 题目 | 「请完成下面的句子。『今天下班以后，我决定去____。』只填写空白部分。不要解释。」 |
| 温度 | 0 / 1 / 2，每档重复 **50** 次（共 150 次） |
| 执行 | 交错（每轮温度顺序交替）抗时间漂移，并发 6 |
| 归一化 | 去首尾引号、句末标点、空白（保留原文另存） |

指标：不同回答数 / 众数占比 / Shannon 熵 / 字级 TTR / 两两相似度（2-gram Jaccard）/ 逐字重复对占比。

温度生效的预期方向：温度↑ → 不同回答数↑、熵↑、众数占比↓、两两相似度↓。

## 3. 与 temperature-p0 的关键差异

- 上两轮走 `DeepSeekAdapter` 真实链路且 **thinking 默认开启**；本轮显式关闭 thinking、走裸 API。
- 上两轮温度被 thinking 模式屏蔽，因此无论怎么测都「无效」；本轮是真正未被屏蔽的对照组。
- 上两轮的相似度指标对本题（1~5 字答案）不适用，本轮改用**类别计数/熵/众数占比**为主指标。

## 4. 运行

```bash
node tools/temperature-nothink/probe-nothink.mjs                        # 默认 0,1,2 × 50
node tools/temperature-nothink/probe-nothink.mjs --n 50 --concurrency 6
node tools/temperature-nothink/probe-nothink.mjs --temps 0,0.5,1,2 --n 30
```

凭据：`$DEEPSEEK_API_KEY` 或 `~/.dsh/.credentials.yaml`。输出：终端汇总 + `results-nothink.json`（原始回答全量，可复算）。

## 5. 运行记录

### 运行 1 · `deepseek-flash` · `thinking:disabled` · temps 0/1/2 · n=50/档

150 次调用，**0 失败 / 0 截断（全 `finish=stop`）/ 0 空输出 / 0 thinking 泄漏**，总用时 0.3min。

| 温度 | n | 不同回答 | 占比 | 众数占比 | 熵 (bit) | 字级 TTR | 两两相似度 | 逐字重复对 |
|---|---|---|---|---|---|---|---|---|
| 0 | 50 | 1 | 2.0% | 100.0% | 0.00 | 0.020 | 1.000 | 1.000 |
| 1 | 50 | 4 | 8.0% | 90.0% | 0.61 | 0.084 | 0.811 | 0.811 |
| 2 | 50 | 14 | 28.0% | 48.0% | 2.73 | 0.290 | 0.292 | 0.250 |

回答分布：

- **T0**：`健身房`×50 —— 50/50 逐字相同，完全贪心。
- **T1**：`健身房`×45、`超市买点菜`×3、`吃火锅`×1、`散步`×1。
- **T2**：`健身房`×24、`吃火锅`×6、`超市买点菜`×5、`健身房锻炼`×3、`看电影`×2、`超市买菜`×2、
  `健身房锻炼一下`×1、`跑步`×1、`附近的公园散步`×1、`吃顿好的犒劳一下自己`×1、
  `我以前常去的那家书店看看有没有新到的推理小说`×1、`附近的公园走走`×1、`电影院`×1、
  `倒垃圾的路上先重写上周失败的爱`×1。

**结论：非 thinking 模式下 temperature 生效，且方向完全符合温度语义**——不同回答数、熵、TTR 随温度单调↑，
众数占比、两两相似度、逐字重复对随温度单调↓。三档差异极大（T0 与 T1 的不同回答数 1 vs 4、
T0 与 T2 为 1 vs 14），无需统计检验。

**顺带补上一个 temperature-p0 v2 缺的阳性对照**：v2 在 thinking 模式下测出 T0 `dupRate=0`（非贪心），
却无法证明这是「温度被忽略」而非「seed 未生效」；本轮非 thinking 模式 T0 `dupRate=1.000`（1225 对全同），
说明**同一模型在参数被真正尊重时会给出完全确定性的 T0 输出**。两轮合起来指向同一个机制：
temperature 的生效与否由 thinking 模式开关决定，而不是模型不支持该参数。

### 运行 2 · `deepseek-flash` · `thinking:enabled (effort=high)` · temp 0 · n=50

同题、同模型、同温度值，**唯一变量是 thinking 开关**。命令：

```bash
node tools/temperature-nothink/probe-nothink.mjs --thinking enabled --effort high --temps 0 --n 50 --max-tokens 2048 --out results-thinking-high-t0.json
```

50 次调用，0 失败 / 0 截断 / 0 空输出，用时 0.2min。thinking 确认真正启用：50/50 条含
`reasoning_content`（平均 433 字思考），平均 completion tokens 143.8，平均延迟 1487ms（对比关闭时 685ms、1 token）。

| 配置 | n | 不同回答 | 占比 | 众数占比 | 熵 (bit) | 逐字重复对 | 平均延迟 |
|---|---|---|---|---|---|---|---|
| thinking=disabled · T0 | 50 | 1 | 2.0% | 100% | 0.00 | 1.000 | 685ms |
| thinking=disabled · T1 | 50 | 4 | 8.0% | 90% | 0.61 | 0.811 | 673ms |
| thinking=disabled · T2 | 50 | 14 | 28.0% | 48% | 2.73 | 0.250 | 741ms |
| **thinking=high · T0** | 50 | **7** | **14.0%** | **42%** | **2.28** | **0.248** | 1487ms |

thinking=high · T0 分布：`健身房`×21、`看电影`×12、`超市`×6、`超市买东西`×5、`超市买点东西`×2、
`散步`×2、`健身房锻炼`×2。

**结论**：`temperature=0` 在 thinking 模式下**不再是贪心解码**——多样性（7 种、熵 2.28、逐字重复对 0.248）
落在非 thinking 的 T1 与 T2 之间，与"参数被忽略、走服务端默认采样"一致；而同一个 T0 在关闭 thinking 后
是 50/50 逐字相同、熵为 0。**同一模型、同一温度值，唯一差别是 thinking 开关，输出确定性从 100% 掉到
24.8% 的重复对**——temperature 参数在 thinking 模式下确实被屏蔽，与官方文档「Thinking mode does not
support the temperature ... will also have no effect」一致，而不是模型本身不响应温度。

### 运行 3 · `deepseek-flash` · `thinking:disabled` · temps 0.5 / 1.5 · n=50

补齐曲线中间两点。100 次调用，0 失败 / 0 截断 / 0 空输出，用时 0.2min。

| 温度 | n | 不同回答 | 占比 | 众数占比 | 熵 (bit) | 字级 TTR | 两两相似度 | 逐字重复对 |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 50 | 1 | 2.0% | 100% | 0.00 | 0.020 | 1.000 | 1.000 |
| 1.5 | 50 | 7 | 14.0% | 78% | 1.27 | 0.122 | 0.630 | 0.612 |

分布：

- **T0.5**：`健身房`×50
- **T1.5**：`健身房`×39、`吃火锅`×4、`超市买点菜`×3、`超市买菜回家做饭`×1、`健身房锻炼`×1、`看电影`×1、`超市买菜`×1

### 五档合并曲线

命令：`node tools/temperature-nothink/plot-curve.mjs`（读 `results-nothink.json` + `results-nothink-0515.json`，按温度合并）。
产物：`curve.svg`（矢量）、`curve.html`（图 + 数据表 + 分布）、`curve.png`（位图预览）。

| 温度 | 不同回答数 | 熵 (bit) | 众数占比 | 逐字重复对 |
|---|---|---|---|---|
| 0 | 1 | 0.00 | 100% | 100.0% |
| 0.5 | 1 | 0.00 | 100% | 100.0% |
| 1 | 4 | 0.61 | 90% | 81.1% |
| 1.5 | 7 | 1.27 | 78% | 61.2% |
| 2 | 14 | 2.73 | 48% | 25.0% |

曲线形态：**0 与 0.5 两点完全重合**（众数 100%、逐字重复对 1.000、熵 0），即低温度区存在一个
「贪心平台」；从 0.5 到 2 才是加速上升段（熵 0 → 0.61 → 1.27 → 2.73，近似凸曲线；
众数占比 100% → 90% → 78% → 48%）。这道题上 **temperature ≤ 0.5 与 0 的行为无法区分**，
要拉开多样性需把温度提到 1 以上。
