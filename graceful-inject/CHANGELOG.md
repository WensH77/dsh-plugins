# Changelog

## 0.9.0

- **修：监工打断之后不会继续执行被打断的任务**。原因在 `cancel` 的语义：它中止的是**整轮**，
  不只是当前步骤。旧版只排了一条「汇报当前任务进度」的 `steer`，模型汇报完这一轮以
  `aborted` 收尾，被打断的工作没有任何东西接回去；而续跑功能只认 `interrupted`（崩溃遗留），
  用户点击导致的 `aborted/user` 不在其中。一次催进度于是变成一次终止任务。
- 运行中点击现在排两条消息：`cancel` → `steer`（汇报）→ `followup`（续跑）。顺序不能反：
  `cancel` 会丢弃排队中的 `steer`。
- **续跑不在打断当下排，改为等汇报那一轮跑完**：`cancel` 之后提交的任何唤醒输入都会被宿主
  改投到「下一轮」队列，然后原样显示在输入框上方——可编辑、带 ↑ 按钮，用户看到的是
  「这条没发出去」（实测日志：注入后 13 秒它仍挂在 `next-turn` 队列里）。改成
  `agent.whenIdle()` 落定后再 `followup`，宿主为它单独开一轮，Chat 里是正常的触发条目。
  同一会话在等待期间重复点击不会排第二条续跑。
- **只有真有半路的工作才排续跑**：打断时扫 `ownEvents()`，有 `tool/call` 没有配对
  `tool/result` 才排。模型只是在输出文字时被打断，汇报那一轮会自然接着做，再多排一轮
  续跑只是多一条空转的「收到执行请求」（实测：汇报里已经把问题答完，续跑那一轮花 4 秒
  只回一句「已做完」）。判定必须在 `cancel` 之前做——取消会把在跑的工具落盘成「已中止」，
  之后就分不清本来在不在跑。
- 新增续跑正文 `AFTER_REPORT_TEXT`（`lib/supervise.js`）：`接着执行刚才被监工打断的任务：
  被打断的那一步没做完就继续做完，已经做完就只回一句结论，不要等我确认。` 被打断的工具
  调用落盘成 `tool call aborted` 的错误结果（跑没跑完不确定），所以明说没做完就重做。
- 空闲的 Agent 没有被打断的任务：只 `steer` 开一轮，不 `cancel`、不排续跑。
- `POST /graceful-inject/supervise` 的响应多一个 `resume: true|false`，说明这次有没有排上续跑；
  排续跑抛错时记 warn、照常回 200（汇报已经注入，不能因为续跑失败让用户以为没点上）。
- 客户端不变：会话里会多出一条续跑的触发条目，是预期行为。
- **监工默认文本简化为「汇报当前任务进度」**：续跑由插件另排一轮，原句里的「不要停止你现在手头
  的事情」既和打断冲突、又没有必要。profile 里的 `superviseText` 同步改掉才会生效（patch 是整行
  替换，插件的默认值被配置覆盖）。
- 测试：运行中注入断言「`cancel` → `steer` → `followup`」的顺序与续跑正文；空闲注入断言不排
  续跑；续跑排失败时仍回 200、`resume=false` 并记 warn。

## 0.8.1

- **修：正常重启（Ctrl-C / SIGTERM）后不触发续跑**。dsh 收到信号后先 dispose 整棵 fiber 树
  （`profile-boot` 里 `createProcessShutdown(dispose)`），agent 会给正在跑的轮次补一条
  `turn/end`，reason 是 `{ kind: 'aborted', reason: { kind: 'disposed' } }`，然后才退出。
  旧版插件把这个收尾当成「这一轮结束了」：`session/event` 监听器删掉运行标记，启动扫描
  又要求磁盘日志停在未闭合轮次上（`hasOpenTurn`），于是正常重启既没有标记也没有未闭合轮次，
  什么都不做——只有被 `kill -9` 的崩溃才会续跑。
- 新增 `isDisposedTurnEnd()` / `lastTurnEndedByDispose()`：把 dispose 补的收尾和
  「跑完了」「用户按了停止」区分开。`session/event` 收到这种 `turn/end` 时**保留**运行标记；
  启动扫描接受两种「没跑完」的形态（未闭合轮次、disposed 收尾）。
- 启动扫描接管成功后**直接向控制器登记投递**，不再依赖 `agent/created` 的 `interrupted` 判定：
  disposed 收尾的会话在 resume 时不会补 `interrupted` 收尾，等 `agent/created` 就是干等。
  已被用户提前点开的会话也补这一条（未闭合轮次的会话仍由 `agent/created` 接管，不重复）。
- 用户主动停止（`aborted` 但 reason 不是 `disposed`）、正常完成（`completed`）仍然不续跑。

## 0.8.0

- **续跑不再需要先点开会话**：上次进程崩溃 / 被强杀 / 关闭超时退出时正在跑的那一轮，会在宿主启动后
  被自动接管并续跑。插件在 `turn/start` 写运行标记 `<DSH_HOME>/graceful-inject/running/<sessionId>`、
  `turn/end` 删除；进程正常退出也不清标记（留给下一次启动看）。启动约 2.5 秒后扫描标记，读磁盘日志
  确认确实停在一轮中间（`hasOpenTurn`）后，用 `sessionController.resolveAgent(id)` 后台恢复 Agent，
  再由既有的 `agent/created` 监听投递续跑消息——和用户点开会话走同一条入口，模型 / preset 组装不用
  插件重做。
- 启动扫描会跳过：已收尾（删标记）、已归档（删标记）、子代理会话（删标记）、本进程已有 Agent、
  本进程写的标记（热重载）、以及标记里 pid 还活着（同一份 DSH_HOME 下另一个 dsh 进程正在跑）。
  读日志失败保留标记、下次启动再试；会话已删除 / 格式迁移要求 / 日志损坏这类确定性失败删标记。
  接管失败同样只对 `session/not-found` 删标记，`gateway/internal`、`agent-busy`、`writer-held`
  等瞬态失败保留标记下次重试；删标记前比对 pid + at，避免扫描期间用户点开、新轮改写标记被误删。
- 启动扫描挂在 `ctx.inject(['sessionController', 'sessionPersistence'])` 上（等宿主服务就绪再跑）；
  子 Fiber 随插件卸载，cleanup 不再把 `ctx.inject` 的返回值当 disposer（真实返回 Fiber，不是函数）。
- **续跑注入正文与监工共用来源前缀**：模型现在看到的是
  `这条通知来自插件「优雅注入」（dsh-plugin-graceful-inject），继续`，而不是裸的「继续」；
  两个功能共用一个 `NOTICE_PREFIX`，模型能把插件注入和用户手打区分开。
- 插件在会话运行中被加载 / 热重载时，装配阶段会补记当前未收尾的会话（否则这一轮没有新的
  `turn/start`，下一次重启会漏掉）。
- 测试：宿主端新增运行标记读写、`hasOpenTurn` / `isProcessAlive` / `dshHomePath`、启动扫描的
  接管与跳过面、热重载补记；`DSH_HOME` 指向临时目录，跑完清理。

## 0.7.0

- 插件改名并扩为两个功能：`dsh-plugin-auto-resume` → `dsh-plugin-graceful-inject`，目录
  `auto-resume/` → `graceful-inject/`。它不再只是「续跑」，而是「优雅注入」：两个可插拔的
  注入功能，各自有开关。
- **功能一 续跑（resume）**：沿用 0.6.0 的行为（`interrupted` 轮次恢复时投递「继续」），
  逻辑搬到 `lib/resume.js`，开关 `resume` 默认 `true`。
- **新增功能二 监工（supervise）**：会话标题栏 actions 区加一个秒表图标按钮，点击
  `POST /graceful-inject/supervise?session=<id>`，宿主用 `agent.steer(...)` 注入
  「不要停止你现在手头的事情，汇报当前任务进度」。用 `steer` 而不是 `followup`：
  监工对象通常正在跑，`followup` 要等这一轮结束。开关 `supervise` 默认 `true`，
  关掉时宿主不注册端点、浏览器端不画按钮。
- 同一会话 **10 秒最多注入一条**：连点、多标签页、脚本直调共用节流窗口，超出的请求回
  `429 throttled` 与剩余秒数；不同会话各自计时，404/403 等失败的请求不占用窗口。
- **运行中点击会先打断当前步骤**：`steer` 只在步骤边界被取走，卡在长等待工具（例如
  300 秒的 wait）里就等不到汇报。现在 `agent.status === 'running'` 时先
  `agent.cancel({ kind: 'user' }, { keepInbox: true })`，随后的 `steer` 在取消收敛后开新一轮。
- **监工文本可运行时配置**：新增 `superviseText`，写进 profile 的 `cordis.patch.yml`
  保存即生效（配置热重载重建插件实例），不用重启进程；按钮提示也读这个值。
- **注入正文开头加来源说明**：`这条通知来自插件「优雅注入」（dsh-plugin-graceful-inject），`
  + `superviseText`。模型看到的只有正文，不写这句就会把插件通知当成用户手打的要求。
- 图标先是鞭子，但在 16px 标题栏下辨识度差（图标库里的 whip 缩放后更糊），改为秒表。
- 新增 `GET /graceful-inject/state`：浏览器端据此判断画不画按钮（开关只有宿主一处事实来源）；
  每次挂载都重新探测，不缓存。
- 监工端点只接受本部署可信页面：优先用宿主 `connection.isTrusted(req)`（Host / Origin /
  Sec-Fetch-Site，和 `/api` 同一套判定），没有该服务时回落 loopback 来源检查，回 `403 remote`。
  （初版只判 `remoteAddress`，挡不住 DNS rebinding 与跨站请求。）
- 按钮反馈改成不依赖布局的两层：图标短暂变色 + 失败原因写 `aria-label` 与控制台。标题栏
  `overflow: clip` 会裁掉绝对定位浮层，初版的 tooltip 与提示条实际看不见，已删除。
- `mountResume` 的 `agent/created` 监听包 try/catch：该事件被 await，监听器抛错会让会话创建
  失败，续跑只是附加行为，判定出错不能连累会话。
- 注入消息的 `source.kind` 统一为 `'graceful-inject'`（两个功能共用，`summary` 区分）。
- 测试补齐：`followup` / `steer` 分开 spy；`apply` 装配面四种开关组合；`isTrusted` 与 loopback
  回落；state HEAD；客户端用最小 hooks 运行时真渲染按钮、点击 POST、成功/失败状态与文案。
- `cordis.patch.yml` 带上默认开关（`resume: true` / `supervise: true`），配置写进 README。

## 0.6.0

- 插件改名：`dsh-plugin-rerun-button` → `dsh-plugin-auto-resume`，目录 `rerun-button/` →
  `auto-resume/`。它早就不再是按钮，改回与行为相符的名字。
- 投递消息的来源标记随之改为 `source.kind = 'auto-resume'`。

## 0.5.0

- 去掉按钮与两个 HTTP 端点，改为**自动续跑**：在 `agent/created` 时读会话内存日志，只有
  最后一条 `turn/end` 的 reason 是 `interrupted` 才自动投递一条带来源的「继续」。
  （不用 `session/event`：崩溃收尾事件是写持久化 + seed 建 Session，不会出现在事件流里。）
- 删除浏览器端（`lib/client.js`）与对应测试；插件现在是纯宿主插件。
- 同一进程内每个会话只续跑一次；Agent 已在运行则跳过；投递失败只记 warn 不重试。

## 0.4.0

- 按钮从标题栏工具区（`conversation.session.header.utilities`）移到聊天流里：
  `conversation.chat.turnTail`，即异常结束那一轮的折叠行之后、动作行之前。
- 显示判断改为浏览器端直接读 `turn.end.reason`，不再需要宿主状态端点
  （`GET /auto-resume/state` 已移除）。
- 只对最后一轮显示；子代理会话不显示。
- 样式改成左对齐的 28px 描边胶囊，跟随宿主主题 token。

## 0.3.0

- 按钮改为条件出现：新增只读端点 `GET /auto-resume/state?session=<id>`，读会话日志最后一条
  `turn/end` 的 reason；只有 `interrupted`（进程退出）、`error`（请求失败/断网）、`blocked`、
  `max-tokens` 才显示。`completed`（跑完）、`forked`、`aborted`（人为停止）不显示。
- 最后一轮尚未结束（运行中）时不显示，也不发状态查询。
- 子代理会话不显示。

## 0.2.1

- 子代理会话（快照里 `subagent` 非空）里按钮置灰，提示「子代理会话由父会话驱动，Rerun 不可用」。
  宿主端 `resolveAgent` 对这类会话一律以 `session/agent-busy` 拒绝，投递不可能成功。

## 0.2.0

- 改为宿主端投递：`POST /auto-resume/continue` → `agent.followup(...)`，消息带
  `source.kind = 'auto-resume'`，聊天里显示为「收到执行请求」的触发卡片，不再是用户气泡。
- 客户端不再走 `session.prompt()`，不再依赖 `sessions` 服务。
- 端点限制：POST only、会话 id 形状校验、请求体 4 KiB、文本 500 字符。

## 0.1.0

- 新增聊天页顶部 Rerun 按钮（`conversation.session.header.utilities`）。
- 点击后向当前会话发送「继续」/`continue`；会话运行中按钮禁用；失败原因显示在按钮旁。
