# Changelog

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
  （`GET /rerun-button/state` 已移除）。
- 只对最后一轮显示；子代理会话不显示。
- 样式改成左对齐的 28px 描边胶囊，跟随宿主主题 token。

## 0.3.0

- 按钮改为条件出现：新增只读端点 `GET /rerun-button/state?session=<id>`，读会话日志最后一条
  `turn/end` 的 reason；只有 `interrupted`（进程退出）、`error`（请求失败/断网）、`blocked`、
  `max-tokens` 才显示。`completed`（跑完）、`forked`、`aborted`（人为停止）不显示。
- 最后一轮尚未结束（运行中）时不显示，也不发状态查询。
- 子代理会话不显示。

## 0.2.1

- 子代理会话（快照里 `subagent` 非空）里按钮置灰，提示「子代理会话由父会话驱动，Rerun 不可用」。
  宿主端 `resolveAgent` 对这类会话一律以 `session/agent-busy` 拒绝，投递不可能成功。

## 0.2.0

- 改为宿主端投递：`POST /rerun-button/continue` → `agent.followup(...)`，消息带
  `source.kind = 'rerun-button'`，聊天里显示为「收到执行请求」的触发卡片，不再是用户气泡。
- 客户端不再走 `session.prompt()`，不再依赖 `sessions` 服务。
- 端点限制：POST only、会话 id 形状校验、请求体 4 KiB、文本 500 字符。

## 0.1.0

- 新增聊天页顶部 Rerun 按钮（`conversation.session.header.utilities`）。
- 点击后向当前会话发送「继续」/`continue`；会话运行中按钮禁用；失败原因显示在按钮旁。
