# anchored-monitor 插件原理审计（静态代码级）

审计对象：`@a9i5k4/dsh-anchored-monitor` v0.3.0（github.com/Aik358/dsh-anchored-monitor）
审计日期：2026-09-01。以下行号基于该版本源码/构建产物。

## 1. 架构

```
┌─ DSH host 进程 ─────────────────────────────┐   ┌─ 独立监控进程 (127.0.0.1:9301) ─┐
│ lib/index.js (818 行)                        │   │ dist/monitor/index.js             │
│  · llm/stream → reasoning-delta 1s 节流推送   │──▶│  · 词典正则计数 → 窗口聚合 → 评分  │
│  · session/event → 整块兜底推送               │   │  · 基线/趋势/异常 → 状态机         │
│  · agent/pre-step → L1 hint 注入             │◀──│  · SSE 广播 intervention_triggered │
│  · system-prompt/assemble → L2 persona/工具   │   │  · 日志只记 textLength+词频(不落原文)│
│  · 15s 看门狗拉起监控进程 + 1.5s 轮询干预     │   └─────────────────────────────────┘
└──────────────────────────────────────────────┘
```

Web 客户端（lib/client.js, 281KB, 含 6 张 base64 表情）：侧栏入口 + 毛玻璃浮层 + 变阻器条 + 设置页。

## 2. 判据与三带

`persona_ratio = count(let me) / (count(正向词) + count(let me))`（session-manager.ts:101）
- <0.2 spec（稳定带） / 0.2–0.5 mixed（过渡带） / ≥0.5 react（坏吸引子）
- 0–100 的"思考强度分"是 UI 装饰；状态机吃的是波段跨越（bandHit 自带证据，不需趋势佐证）

## 3. 干预三级

| 级别 | 触发 | 动作（lib/index.js） |
|---|---|---|
| L1 | 进 mixed 带 | `agent.followup()` 注入建议式 hint（措辞纪律：禁命令式） |
| L2 | 进 react 带 | `agent.cancel({keepInbox:true})` + assemble 换 persona + 收缩工具 + followup 续跑 |
| L3 | L2 重试耗尽 | 同 L2 + 重启建议 |

L2 重置载荷（config/default.yaml）：persona = `"You are a helpful software engineer assistant."`（46 字符），
工具 = `["bash", "str_replace_editor"]`。

## 4. 审计发现的问题

### 4.1 🔴 载荷丢失（严重，实测确认）

- `session-manager.ts:610` 快照 map 只挑 `{level, reason, timestamp, sequence, status, ackedAt}`，**丢弃 payload**
- host 插件 `pollInterventions` 只走 `/api/sessions/:id` 轮询，**不订阅 SSE**
- 实测：SSE 事件带 payload（hintText / reset），快照不带（`payload present? false`）；监控进程无其他返回 payload 的 HTTP 路由
- 后果：L1 → 注入空消息；L2/L3 → `pendingResets` 退化为 `{systemPrompt:'', tools:[]}` → assemble 把 persona 换成空串、
  工具被 `Set([]).has()` 过滤成空数组 → **下一轮模型一个工具都没有**
- 讽刺点：走 SSE 的 `preset/` 分支反而是对的；被推荐为默认的 Web 插件路径坏了
- 修复：快照 map 补一行 `payload: i.payload`。SSE 端到端已实测可正常出 payload（sse-test）

### 4.2 🟡 词典重复计数

- 词典：正向 `we`(2.0)/`let's`(1.5)/`we'll`(1.2)/`we need`(1.2)/`our`(0.8)；负向仅 `let me`(3.0)
- `\bwe\b` 同时命中 `we need`、`we'll`。实测样例 `"We need to inspect… We'll check…"` →
  计数 `we:2, we'll:1, we need:1`，正向合计 6，而字面独立 `we` 是 0
- 正向分母被系统性放大 ~2×，0.2/0.5 边界被悄悄推向"更难触发"——而这两个数值抄自 router-standard 的
  **独立计数**口径，口径不一致使边界失去宣称的实测依据

### 4.3 🟡 流式增量偷换窗口语义

- `llm/stream` 1s 节流切块 → `window.size: 20` 的单位从"20 个 reasoning 块"变"20 个 1 秒切片"；
  `baseline_min_samples: 10` 同理。同一配置在 log_tail 源与 stream 源下含义不同
- 切块可能把跨边界的 `let me` 切成 `let`+` me` 漏计（概率低，方向=漏 negative=偏向不触发）

### 4.4 🟢 上游理论已被部分撤回

`dsh-router-standard/docs/apology.md`（2026-08-16，作者 yjh051108）：
- "官方刻意设计双模式——错误"；"路由层被训坏了——错误"
- "论文理论解释部分（假设 A1–A4 及强归因）已标注作废"
- "Pro 是完全不同的另一回事…不能把 Flash 经验直接套到 Pro 上"
- "'Let me' 低效但不是废物"——复杂规划任务上它携带 "We need" 不具备的深度推理能力，应**当路由用**而非压制

anchored-monitor 的 README/CHANGELOG（2026-08-17~19）在其后仍把该理论当既定结论引用，
且宣称"专为 V4 Pro 0813 调校"，与作者"Pro 是另一回事"的修正直接冲突。

### 4.5 🟢 其他

- `EventSource` 在 Node 26 非全局（`--experimental-eventsource`）；`preset/anchored-monitor.mjs:119`、
  `src/plugin/ipc-client.ts` 都直接 `new EventSource`。默认 handleInterventions:false 绕开，按 README 说法改为 true 即崩
- `context.agent.session` 不在公开类型 `AssembleContext`（只有 scope/signal）里，只是运行时实现细节
  （dsh-agent dispatch.js `assembleContextFor` 确实传 agent）。DSH 一改即静默失效（`if(!session) return`，不报错）
- 自证循环：L2 续跑文本自带 `we will…`，会进模型上下文 → ratio 回 spec 可能只是模型复读提示词
- 默认 `session_id_pattern` 是 `~/.dsh/sessions/{sessionId}/events.jsonl`，真实布局是
  `~/.dsh/sessions/<项目slug>/session-<uuid>/session.jsonl.zstd` —— log_tail 源默认扫不到东西

## 5. 结论

- 作为可视化仪表：可用（工程扎实：全参数 YAML + schema 校验、离线回放、网格校准、loopback 加固、日志不落原文）
- 作为自动干预器：不可用。载荷 bug 使 L2 实际效果是"空 persona + 零工具"；默认完整提示词场景从第 1 块即
  ratio≈0.98 → 永久 L2 循环（README 自称"打架不是监控"，实测是 291/296 会话的默认情况）
- 与本次调查结论（tools/thinking-voice/README.md）合并看：干预的变量（语态漂移）本身不存在——
  语态由问题形式决定，不由 persona/工具集控制
