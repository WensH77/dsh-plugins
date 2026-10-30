# Changelog

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
