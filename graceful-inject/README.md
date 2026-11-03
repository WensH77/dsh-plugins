# dsh-plugin-graceful-inject

一个插件、两个**可插拔**的注入功能，各自有开关：

| 功能 | 开关 | 做什么 |
|---|---|---|
| **续跑**（resume） | `resume` | DSH 因崩溃、被强杀或关闭超时退出后，本轮被补记为 `interrupted` 的会话自动投递一条「这条通知来自插件「优雅注入」…，继续」；宿主启动时还会扫描上次运行中的会话并在后台接管，**不需要先点开那个会话** |
| **监工**（supervise） | `supervise` | 会话标题栏出现一个秒表图标，点一下往当前会话注入「这条通知来自插件「优雅注入」…，不要停止你现在手头的事情，汇报当前任务进度」 |

两者共用一条通道：宿主往会话里投递一条**带自定义来源**的消息，聊天里能看出它不是用户
打的，而不是一条用户气泡；模型收到的仍然是那句指令。区别在投递时机与 Chat 的呈现：

- 续跑用 `followup`，永远开一轮新工作，Chat 显示为「收到执行请求」的触发条目；
- 监工用 `steer`：Agent 正在跑时在最近一个步骤边界被消费，是**上下文注入**（不新开轮）；
  Agent 空闲时 `steer` 会直接开一轮，这时才是触发条目。

## 配置：两个开关 + 一段可运行时改的注入文本

配置写在 profile 的 `cordis.patch.yml` 里，按行 id 覆盖：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: graceful-inject
  config:
    resume: false
    supervise: true
    superviseText: '不要停止你现在手头的事情，汇报当前任务进度'
```

注意宿主 patch 的语义是**整行 config 替换**，不是合并：想只关一个，另一个也要写全。

`superviseText` 就是按钮注入的那句话，默认值就是上面这句。**改它保存即生效**：dsh 会热重载
配置、重建插件实例，不用重启进程，下一次点击就注入新文本；按钮的提示（`aria-label`）也取自
这里，页面重新挂载后同步。空字符串没有意义，会被回落成默认文本。

注入时正文前面会自动加一句来源说明，模型看到的是：

```
这条通知来自插件「优雅注入」（dsh-plugin-graceful-inject），<superviseText>
```

`superviseText` 只配后半句；前缀固定，避免模型把插件通知当成用户手打的要求。按钮提示只显示
后半句。

| 键 | 默认 | 作用 |
|---|---|---|
| `resume` | `true` | 续跑开关 |
| `supervise` | `true` | 监工开关（关掉即不注册端点、不画按钮） |
| `superviseText` | 「不要停止你现在手头的事情，汇报当前任务进度」 | 监工注入的文本 |

| resume | supervise | 结果 |
|---|---|---|
| `true` | `true` | 两个功能都开（默认） |
| `false` | `true` | 只出不续跑：崩溃恢复后会话停在原地 |
| `true` | `false` | 只续跑：不注册监工端点，标题栏不画秒表 |
| `false` | `false` | 插件只剩一个状态端点，等价于停用 |

关掉 `supervise` 时宿主**不注册** `/graceful-inject/supervise`；浏览器端每次挂载都读
`GET /graceful-inject/state`，读到 `supervise: false` 就不画按钮——开关只有一处事实来源，
客户端没有自己的第二套配置（也不缓存探测结果，运行期关掉后重新挂载即生效）。

## 功能一：续跑（resume）

### 触发条件

- **会话被打开/恢复时**：只认 `turn/end` 的 reason 是 `interrupted`。
- **宿主启动时**：插件自己的运行标记显示上次进程退出时这个会话正在跑一轮，且磁盘日志里确实有
  `turn/start` 没有配对的 `turn/end`。

`interrupted` 这个 reason 只在两种时候出现——恢复一个未闭合的轮次（agent-loop resume 补记），或冷读
日志时由 session-query 合成。运行中的 Agent 循环永远不会现场发它。所以抓到一条
`interrupted` 就等于抓到了「刚被修复的中断轮次」，历史里早已修复过的中断不会重复触发。

`completed`（跑完了）、`aborted`（人为停止）、`error`（请求失败/断网）、`blocked`、
`max-tokens`、`forked` 都不处理。

### 工作方式

1. 插件在每一轮开始/结束时维护一份运行标记：`<DSH_HOME>/graceful-inject/running/<sessionId>`，
   `turn/start` 写，`turn/end` 删。内容 `{ pid, at }`，写入用「临时文件 + rename」，崩溃时不会留下半个 JSON。
2. **宿主启动**约 2.5 秒后（等 `sessionController` / `sessionPersistence` 装配完）扫描这些标记：
   - 读该会话的磁盘日志，只有确实停在一轮中间（有 `turn/start` 没有 `turn/end`）才接管；
   - 用 `sessionController.resolveAgent(id)` 后台恢复 Agent——和用户点开会话走同一条入口，
     模型 / preset 的组装不用插件重做；随后 `agent/created` 监听投递续跑消息；
   - 已收尾的标记直接删掉；删之前会比对标记内容（pid + at），避免扫描读日志的间隙里用户
     刚好点开、新轮把标记改写了却被误删。已归档、子代理、以及标记里的 pid 还活着（同一份
     DSH_HOME 下另一个 dsh 进程正在跑它）的会话跳过——前者防误叫醒，后者防跨进程抢会话。
3. **会话被打开/恢复时**（`agent/created`）：直接读该会话在内存里的事件（`session.ownEvents()`），
   取最后一条 `turn/end` 的 reason。
4. 只有 reason 是 `interrupted` 时才投递一条消息，正文和监工共用同一句来源说明：

   ```js
   agent.followup(createUserMessage({
     content: [{ type: 'text', text: '这条通知来自插件「优雅注入」（dsh-plugin-graceful-inject），继续' }],
     source: { kind: 'graceful-inject', form: 'notice', summary: '…' },
   }))
   ```

5. 投递后 flush 落盘。Agent 已经在跑就跳过；同一条会话在一个进程里只投递一次。

标记在进程正常退出时**也不清**——它本来就是写给下一次启动看的；轮次正常收尾（`turn/end`）才会删。
插件在会话运行中被加载 / 热重载时没有新的 `turn/start`，所以装配时会补记当前未收尾的会话。

### 为什么续跑判定不放在 session/event 里

`session/event` 只用来维护运行标记（`turn/start` / `turn/end`）。崩溃遗留轮次的收尾不走
`Session.append`：agent-loop 在 resume 时直接把 `turn/end` 写进持久化文件，再以 seed 形式建进
Session；seed 不发 `session/event`。所以在事件流上永远抓不到 `interrupted`，续跑判定得反过来在
`agent/created` 时读内存日志。

判定是幂等的：续跑本身会开出新的一轮，把「最后一条 `turn/end`」推进到 `completed`，下次
恢复就不会再触发。

## 功能二：监工（supervise）

### 工作方式

1. 浏览器端在 `conversation.session.header.actions` 挂一个 28px 的秒表图标按钮，`order: 60`
   （排在标题旁的 actions 区，和 Todo 入口同一排）。
2. 点击 → `POST /graceful-inject/supervise?session=<id>`。
3. 宿主取该会话的活跃 Agent。**正在跑就先打断当前步骤，再注入**：

   ```js
   if (agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
   agent.steer(createUserMessage({
     content: [{ type: 'text', text: '这条通知来自插件「优雅注入」（dsh-plugin-graceful-inject），' + superviseText }],
     source: { kind: 'graceful-inject', form: 'notice', summary: '…' },
   }))
   ```

   `steer` 只在步骤边界被取走，Agent 卡在 300 秒的等待工具里时等到黄花菜凉——所以运行中
   先 `cancel({ keepInbox: true })` 中止当前步骤，随后的 `steer` 作为唤醒输入在取消收敛后
   开新一轮。代价是被中断的工具需要重新发起，这是「不等待」的交换。

4. flush 落盘。反馈只有两层：图标短暂变色（成功绿 1.6 秒、失败红 3 秒），失败原因写进
   按钮的 `aria-label`（读屏可读）与控制台。**不画浮层提示**：这个槽位在标题栏内，
   `overflow: clip`，绝对定位的浮层会被裁掉。
5. 同一会话 **10 秒最多注入一条**：窗口内的重复请求回 `429 throttled` 与剩余秒数
   （`retryAfter`），客户端显示「10 秒内只能催一次，N 秒后再试」。节流按会话隔离，
   多个标签页和脚本直调共用同一个窗口。

### 为什么运行中要打断

`followup` 要等这一轮结束才轮到，用户点了半天看不到汇报，所以不用它。
`steer` 虽然能插进当前轮，但要等最近一个步骤边界——一个 300 秒的等待工具就把它挡住。
监工按钮的语义是「现在告诉我」，所以运行中先 `cancel` 中止当前步骤，再 `steer` 唤醒一轮。
空转的 Agent 没有可打断的步骤，直接 `steer` 就会开一轮（宿主文档：an idle driver starts a turn）。

### 为什么不是用户消息

会话的每一轮都必须有输入（Agent 的入口只有 `send` / `followup` / `steer` / `inject`，
没有「空轮」）。走 `session.prompt()` 会产生 `source.kind = 'user'` 的消息——聊天里就是
一条用户气泡，和手打没区别。带自定义来源的消息 Chat 会按来源渲染（续跑 / idle steer 是
触发条目，运行中 steer 是上下文注入行），模型收到的仍然是一句指令。

## 安装

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:graceful-inject'
# 或本地开发路径
dsh plugin --profile web add ./graceful-inject
```

宿主半段（`lib/index.js` 与两个功能模块）是进程内加载：dsh 的 profile hmr 通常能直接重载
已装的插件，看到 `cordis.patch.yml` 的 config 变更也会重载对应行；没生效时重启 `dsh web`。
浏览器端（`lib/client.js`）刷新页面即可。

从旧版 `dsh-plugin-auto-resume` 升级时：先 `dsh plugin --profile web remove dsh-plugin-auto-resume`，
再装本插件。旧插件是纯宿主、没有按钮，卸载不会留下客户端残留。

## 边界

- **启动时只接管「上次进程退出时正在跑」的会话**：插件在 `turn/start` 写运行标记、`turn/end` 删除，
  启动时按标记逐个校验磁盘日志。正常收尾的会话、没在跑的会话不会因为启动就被叫醒——不会批量拉起
  历史会话。
- 会话被打开时才走 `interrupted` 判定；没被标记覆盖的旧中断会话（插件装上之前就断掉的）仍按老路径：
  点开时续跑。
- 启动扫描在宿主装配完成约 2.5 秒后跑一次，不轮询；标记目录 `<DSH_HOME>/graceful-inject/running/`
  每个会话一个文件，文件名就是会话 id。
- 接管失败时，只有「会话真的不存在」（`session/not-found`）才删标记；`gateway/internal`、
  `agent-busy`、`writer-held` 等瞬态失败保留标记，下次启动再试。
- 同一份 `DSH_HOME` 下多个 dsh 进程并存时，标记里 pid 还活着会被跳过，避免抢别人正在跑的会话；
  pid 判断是 best-effort（新进程恰好复用了旧标记的 pid 时，用标记时间早于本进程启动来区分）。
- 同一进程内每个会话只续跑一次。进程再次崩溃重启后，新产生的中断会再续一次。
- 续跑投递失败只记一条 warn，不重试，避免和崩溃循环互相喂饭。
- 两条注入文本都固定为中文。要按界面语言区分（英文发 `continue` / `report progress`）
  需要改宿主侧来源，目前没做。
- **监工只在有活跃 Agent 的会话上可用**。宿主重启后打开的历史会话、或已经结束的会话，
  端点会回 `404 no-agent`，按钮点了会显示说明而不是静默失败。
- **监工端点只接受本部署可信页面**：自定义 `webServer` 路由不经过 api-gateway 的远程
  访问鉴权，而一次注入有副作用（会让当前会话继续跑）。所以 handler 优先用宿主
  `connection.isTrusted(req)`——和 `/api` 同一套判定：Host 必须属于本部署、
  `Sec-Fetch-Site: cross-site` 直接拒、带 `Origin` 时必须与 Host 同源，挡住 DNS rebinding
  与别的网页发起的跨站请求；没有 `connection` 服务时回落到 loopback 来源检查（403 `remote`）。

## 测试

```bash
npm test
# = node test/smoke.mjs && node test/client-smoke.mjs
```

- `test/smoke.mjs`：宿主端，用假 ctx 驱动 `createResumeController`、启动扫描与两个 handler，覆盖
  turn/end 读取、恢复判定、运行中跳过、去重、超时放弃、运行标记读写（临时 `DSH_HOME` 隔离）、
  启动扫描的接管/跳过面（未收尾、已收尾、已归档、子代理、本进程/活进程标记、读日志失败、接管失败）、
  方法/会话 id/无 Agent/不可信页面的拒绝面、`connection.isTrusted` 与 loopback 回落、state 快照
  （含 HEAD）、两种消息的正文与来源标记（含共用来源前缀）、Config 默认值，以及 `apply` 的装配面
  （四个开关组合各注册哪些端点与监听，含热重载补记运行标记）。
- `test/client-smoke.mjs`：浏览器端，在 vm 沙箱里加载工厂包装的 `lib/client.js`。除了槽位
  注册、`sessionId` 注入、端点构造、失败文案映射、开关探测（含失败降级、不缓存），还用
  一个最小 hooks 运行时**真的渲染组件**：开关放行后画按钮、点击发一次 POST、成功变绿、
  失败变红并把原因写进 `aria-label`、开关关闭时渲染空。

## 文件

- `lib/index.js`：装配两个模块 + `Config` 开关。
- `lib/resume.js`：功能一（事件监听 + 运行标记 + 启动扫描 + followup 投递）。
- `lib/supervise.js`：功能二（消息构造 + 两个端点 handler）。
- `lib/source.js`：两个功能共用的 `source.kind = 'graceful-inject'`。
- `lib/client.js`：浏览器端秒表按钮。
- `test/*.mjs`：上面两套 smoke。
- `locale/*.json`：插件管理页显示的标题与说明。
- `cordis.patch.yml`：bundle 补丁层（含默认开关）。

## 变更日志

见 [CHANGELOG.md](CHANGELOG.md)。
