# temperature-inject：给主代理委派的子代理注入「指定模型 + 关闭 thinking + 指定温度」

> **已弃用（仅作存档，不再维护）**
>
> 弃用原因：**温度对"快速出 HTML 方案"这类多步 agentic 任务不是有效杠杆。**
> 实测（同一 prompt、零风格指定、每个温度并发 3 个子代理）：温度 0 与 1 的组内相似度只有
> 0.470 vs 0.359，渲染出来仍是同一类设计（控制台/现代后台 + 筛选卡 + sticky 表格）——
> 真正拉开方案差异的是 prompt 里的设计约束，不是采样温度。而要让温度生效必须先关闭
> thinking（降低方案质量），且 1.5 起输出会直接退化成 token soup。
>
> 完整实验数据与结论保留在 §7；宿主端与客户端（会话页开关 + 0~1/step 0.2 滑杆）都已实现
> 并通过测试（宿主 36 项 + 浏览器端全绿），代码留作参考。
> 若将来还要用：可用区间 **0~1**，默认值取 1（与主代理的服务端默认值一致）。

## 1. 它做什么

在主代理用 `subagent` / `subagent_fork` 委派出的子代理**发起模型请求之前**，把该请求的
`LlmCallConfig` 改写成：

```
model            = 配置值（默认 deepseek-flash）
reasoningEffort  = 'off'      ← 关闭 thinking
temperature      = 配置值（0~2）
```

主代理自身不受影响；不改派发、不拦截工具、不碰会话内容。

## 2. 为什么必须走 `agent/request`

| 事实 | 出处 |
|---|---|
| `AgentOptions` 只有 `provider`/`model`/`reasoningEffort`/`maxTokens`，**没有 temperature** | `dsh-agent/lib/types/runtime-types.d.ts:21-30` |
| `agent/request` waterfall 的返回值 `LlmCallConfig` **有** `temperature` | `dsh-llm/lib/types/call-config.d.ts:16-23` |
| 子代理与主代理共用同一个 waterfall 发射点 | `dsh-agent-loop/lib/index.js:1143` |
| 插件根 ctx 上不带 scope tag 的监听器覆盖全部 agent（含子代理） | `dsh-agent/lib/index.js:198` + `dsh-scope/lib/index.js:316-330` |
| `reasoningEffort: 'off'` → 线上 `thinking: {type:'disabled'}` | `dsh-llm-deepseek/lib/index.js:35` |
| `temperature` 无任何范围校验，适配器直接透传 | `dsh-llm/lib/types/call-config.d.ts:20`、`dsh-llm-deepseek/lib/index.js:245` |

两个关键推论：

- **temperature 在 `AgentOptions` 层无法表达**，所以"低温子代理"只能靠本插件这类注入实现；
- **DeepSeek 的 thinking 模式不支持 temperature**，所以要让温度真的生效，就必须同时把
  `reasoningEffort` 置为 `'off'`——这两件事在本插件里是绑定的。

## 3. 判据：为什么不用 run.id 映射

子代理被判定为命中的依据是它自己的持久属性：

- `agent.session.header.origin === 'subagent'`（子代理会话在创建时就写入）
- `agent.session.header.parentSession`（父会话 id，会话白名单用它）

不用 `subagent/start` 事件去登记 `run.id → 温度`，因为**有时序竞态**：该事件在
`provider.start()` 返回后才发（`dsh-subagent/lib/index.js:3159-3172`），而子代理的
prompt 在 `provider.start()` 内部就已投递、turn 已经开始
（`dsh-subagent-in-process-driver/lib/index.js:180-217`）。用 agent 自身的 header 判定则
完全没有这个问题。

## 4. 配置项（`cordis.patch.yml` 的 `config` 块）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时监听器原样放行 |
| `model` | `deepseek-flash` | 目标模型；空串 = 不改 |
| `provider` | `''` | 目标 provider；**空串 = 不改**（同 provider 下换 model 最稳） |
| `effort` | `off` | 目标 reasoning effort；`off` 才关 thinking；空串 = 不改 |
| `temperature` | `1` | 合法区间 0~2，但**多步 agentic 任务的实测可用区间是 0~1**（默认取 1，与主代理的服务端默认值一致；见 §7）。越界会被夹到边界，原值记在 `config.clampedFrom` |
| `sessions` | `[]` | 只对这些**主会话 id** 生效（无 UI 时的白名单）；空数组 = 不按白名单放行 |
| `autoEnable` | `false` | 无 UI 场景的兜底：`true` 时所有会话默认开启 |
| `includeMain` | `false` | 调试用：也让主代理被改写（正常别开） |

**状态模型**：`config` 是全局默认；**会话页的开关与温度是会话级覆盖**（宿主内存态，按父会话 id），
**默认关闭**——用户在某会话打开「温度调节」后，才对该会话派出的子代理生效。会话级设置一旦存在
即为权威：在那里关掉就是关掉，不会回落到 `config.sessions` / `autoEnable`。

会话级端点（客户端 UI 用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/temperature-inject/session?session=<id>` | 读该会话的 `{enabled, temperature, effective, testedRange, step}` |
| `POST` | `/temperature-inject/session` | 写 `{session, enabled?, temperature?}`；温度被夹到 **0~1** |

### 4.1 客户端 UI（会话页）

| 位置 | 组件 | 行为 |
|---|---|---|
| `conversation.input.left` | 开关按钮 | 常驻。关闭显示「温度 关」，打开显示「温度 1.0」；点击切换并把状态写回宿主 |
| `conversation.input.dock` | 温度滑杆 | **仅在开关打开时渲染**：`input[type=range]`，范围 **0~1**、step **0.2**；拖动本地即时反馈，停手 180ms 后落盘 |

滑杆是自己写的 `input[type=range]`：DSH 的 `dsh-client-ui-primitives` 里没有 Slider/Range
组件（只有 `Switch`/`Input`/`Menu`/`Modal`/`Pill`/`Tag`/`StateDot`/`Tooltip` 等）。
两个挂载点共享同一个模块级 store（缓存 + 订阅），所以一打开开关，滑杆立即出现。
状态不走 `settings` 命名空间——`settings` 是全局文档，而这里是 per-session 的。

## 5. 安装与启用

```bash
cd /path/to/dsh-plugins
dsh plugin --profile web add ./temperature-inject      # 本地路径安装
# 或（跟随默认分支最新提交）
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:temperature-inject'
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 顶层数组追加：

```yaml
- insert:
    - id: temperature-inject
      name: dsh-plugin-temperature-inject
      config:
        enabled: true
        model: deepseek-flash
        effort: off
        temperature: 1
        # sessions: ['<主会话 id>']   # 可选：只对某个会话生效
```

重启 `dsh web`（首次把插件条目读进来需要它）。

> 首次加载**客户端**（`lib/client.js` 与 `package.json` 的 `dsh.client`）同样需要这次重启；
> 之后 `client.js` 每次请求实时重载，改它不必再重启。

> 装好之后，`config` 块里的值（例如 `temperature`）改动会**热重载**：dsh 重新 apply 本插件，
> 端点里的 `config` 立即变化、`state.startedAt` 随之刷新，**不需要再重启**（实测：改
> `temperature: 2 → 1` 后未动进程，端点即刻返回 1）。所以做温度对照实验时，改 patch.yml →
> 等几秒 → `curl` 确认新值 → 直接委派，不必逐次重启。

## 6. 怎么测（四层，逐层加强）

### 第 0 层：宿主端单测（不需要装到 dsh 里）

```bash
node temperature-inject/test/smoke.mjs        # 23 项：配置收敛 / 判定分支 / waterfall 装配 / 端点
```

### 第 1 层：端点自检（确认插件活着、配置读对了）

```bash
curl -s http://127.0.0.1:3080/temperature-inject/state | python3 -m json.tool
```

期望：`config` 是你在 patch.yml 里写的值，`state.requests == 0`。
启动日志里也有一行 `temperature-inject: 已启用 → 子代理 model=… effort=off temperature=…`。

### 第 2 层：注入是否真的发生（委派一个子代理后）

在会话里让主代理派子代理，例如：

> 用 subagent 工具并发派 3 个子代理，各写一个 HTML UI 方案，分别存到 ui-1.html / ui-2.html / ui-3.html，不要互相参考。

然后：

```bash
curl -s http://127.0.0.1:3080/temperature-inject/state \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('injected=',d['state']['injected'],'skipped=',d['state']['skipped']); print(json.dumps(d['state']['recent'][-1:], ensure_ascii=False, indent=1))"
```

期望：`injected` 增加，`recent` 里每条带 `agentId` / `parentSession` / `patch`
（`{"model":"deepseek-flash","reasoningEffort":"off","temperature":1}`）。
dsh web 的终端里也会出现 `[temperature-inject] inject child=… parent=… {…}`。

### 第 3 层（最硬）：子代理的请求头里确实是这个 config

会话日志是 zstd 压缩的 JSONL，`request/header` 事件的 `data.header.config` **就是**
`LlmCallConfig`（实测形态：`{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high","maxTokens":256000}`）。

```bash
# 找最近 10 分钟内更新的子代理日志
find ~/.dsh/sessions -name "session.jsonl.zstd" -newermt "-10 minutes"

# 看它第一条请求的 config（应含 reasoningEffort:"off" 与 temperature:1）
F=$(find ~/.dsh/sessions -name "session.jsonl.zstd" -newermt "-10 minutes" | head -1)
zstd -dc "$F" | grep -m1 '"request/header"' | grep -o '"config":{[^}]*}'
```

期望输出类似 `"config":{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"off","temperature":1,...}`。

这一层同时验证了三件事：注入生效、`effort=off` 落到了真实请求、主代理自己的请求没被改。

### 第 4 层：行为验证（温度真的影响了输出）

用同一个 prompt 重复委派（或一次并发多个子代理），比较产出的差异度。
参照 `tools/temperature-nothink/` 的实测：关闭 thinking 后 T0/T0.5 完全贪心、T1.5~T2 明显发散。
若你把 `temperature` 调到 2 后仍看到多个子代理输出高度雷同，说明注入没生效。

## 7. 已知限制

- **只能整会话一个温度**：主代理派几个、派给谁由模型临场决定，插件事先不知道，所以无法
  "第 1 个用 0.5、第 2 个用 1.5"。需要按次不同温度只能改走宿主派发（`ctx.subagents.start`）。
- **只覆盖一层子代理**：判据用 `parentSession === 主会话`，子代理再派的孙代理不受影响。
  要让整棵树生效，把 `sessions` 留空并放宽判据（当前实现里 `sessions` 为空时只看
  `origin === 'subagent'`，此时孙代理也会被命中）。
- **关闭 thinking 有代价**：子代理不再推理，复杂任务的方案质量会下降。这是温度生效的必要代价。
- **`temperature` 越界会被夹**：不会报错，但端点里能用 `config.clampedFrom` 看出被夹过。
- **实测可用温度区间是 0~1，不是文档写的 0~2** —— 这是本插件最重要的一条约束。
  "文档的 0~2"是参数合法区间；"0~1"是**子代理能正常完成多步 agentic 任务**的区间。
  实测方式：同一份 prompt（零风格指定）、同一模型、关闭 thinking，每个温度并发 3 个子代理，
  任务是把一张页面截图重做成单文件 HTML（约 600 行）：

  | 温度 | 产出 | 组内相似度（字符 4-gram Jaccard） | 判定 |
  |---|---|---|---|
  | 0 | 3/3 可用（600 / 587 / 646 行） | 0.470（相同行 27.3%） | 可用，收敛 |
  | 1 | 3/3 可用（679 / 817 / 649 行） | 0.359（相同行 14.0%） | 可用，发散 |
  | 1.5 | 0/3 可用（3.4 KB / 0.8 KB / 0.3 KB） | 无法计算 | **崩坏** |
  | 2 | 0/3 可用（最早只吐 22 token） | — | **崩坏** |

  1.5 起的失败形态是 "token soup"：模型读图完全正常，但写长 HTML 时输出退化成无意义 token；
  三个子代理都在收尾里如实自证"文件是坏的、不可用"，其中一个明确指出退化
  "on a file this size"，并建议改为**分块生成 + 逐块校验**而不是一次大生成。
  跨任务对比更能说明问题：同一模型在**单轮短文本**任务上 T2 仍输出正常
  （见 `tools/temperature-nothink/`），一旦变成多步编排 + 长文件生成，1.5 就崩。
  **正式工况请把温度限制在 0~1；要用更高温度，必须把长输出拆成多段。**
  另注：温度 0 并不等于逐字确定——三份产出的相同行只占 27%（且多为 CSS reset 类样板），
  多步 agentic 自带的不确定性不是 temperature=0 能消除的。
- **结论（一句话）**：没有思考能力的模型不适合在高温下执行复杂工况。
- **客户端温度控件的规格（待实现）**：范围 **0~1**、step **0.2**。不要拿文档的 0~2 当滑杆范围——
  1.5 起是实测崩坏区。
- **参考：主代理的默认温度是 1，但当前不起作用**。DSH 不设置这个字段——`~/.dsh/settings.yaml`
  的 `agent-default-model` 只有 `model` 与 `reasoningEffort`，`LlmCallConfig` 的 seed 构造
  （`dsh-agent-loop/lib/index.js:1127-1147`）也不含它——于是走 DeepSeek 服务端默认值 **1**
  （官方文档：`temperature` … Default value: `1`）。但主代理默认 thinking 开启
  （`reasoningEffort: high`），而 temperature 在 thinking 模式下 "has no effect"，
  所以主代理实际是**名义 1.0、无效果**。若将来关掉主代理的 thinking，它的温度正好是 1——
  与本插件定的 0~1 上界一致。

## 8. 尚未验证的部分（诚实标注）

以下均为静态调研结论，**写这个插件时还没有实机跑过**：

1. `agent/request` 注入是否真的让线上请求体带上 `temperature`（第 3 层测试就是为验证它）；
2. `agent.session.header.origin` / `parentSession` 在 `agent/request` 触发时一定已就绪（依据是
   子代理会话创建时写入 meta，但未实测）；
3. `inject = ['webServer']` 是否让插件在 web profile 下按时激活；
4. `provide`/`model` 之外的字段（如 `maxTokens`）是否会被 adapter 的默认值覆盖。

按第 0→3 层顺序测下来，任何一层不符就停在那里排查。
