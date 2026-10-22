# dsh-plugin-rerun-button

没有按钮，没有端点。DSH 因为崩溃、被强杀或关闭超时退出后，**本轮被补记为
`interrupted` 的那个会话，在恢复时自动接着跑**：宿主投递一条带来源标记的「继续」，
模型继续干活。

## 触发条件

只认一种情况：`turn/end` 的 reason 是 `interrupted`。

这个 reason 只在两种时候出现——恢复一个未闭合的轮次（agent-loop resume 补记），或冷读
日志时由 session-query 合成。运行中的 Agent 循环永远不会现场发它。所以抓到一条
`interrupted` 就等于抓到了「刚被修复的中断轮次」，历史里早已修复过的中断不会重复触发。

`completed`（跑完了）、`aborted`（人为停止）、`error`（请求失败/断网）、`blocked`、
`max-tokens`、`forked` 都不处理。

## 工作方式

1. 插件监听 `agent/created`（每次打开/恢复会话都会触发）。
2. 直接读该会话在内存里的事件（`session.ownEvents()`），取最后一条 `turn/end` 的 reason。
3. 只有 reason 是 `interrupted` 时才投递一条消息：

   ```js
   agent.followup(createUserMessage({
     content: [{ type: 'text', text: '继续' }],
     source: { kind: 'rerun-button', form: 'notice', summary: '继续' },
   }))
   ```

4. 投递后 flush 落盘。Agent 已经在跑就跳过；同一条会话在一个进程里只投递一次。

## 为什么不用 session/event

崩溃遗留轮次的收尾不走 `Session.append`：agent-loop 在 resume 时直接把 `turn/end` 写进持久化
文件，再以 seed 形式建进 Session；seed 不发 `session/event`。所以在事件流上永远抓不到这条
`interrupted`。反过来在 `agent/created` 时读内存日志才是可靠的。

判定是幂等的：续跑本身会开出新的一轮，把「最后一条 `turn/end`」推进到 `completed`，下次恢复
就不会再触发。

## 为什么不是用户消息

会话的每一轮都必须有输入（Agent 的入口只有 `send` / `followup` / `steer` / `inject`，
没有「空轮」）。走 `session.prompt()` 会产生 `source.kind = 'user'` 的消息——聊天里就是
一条用户气泡，和手打没区别。带自定义来源的消息被 Chat 渲染成「收到执行请求」的触发条目，
模型收到的仍然是一句「继续」。

## 边界

- **不会后台批量拉起历史会话**。只有被恢复（打开）的那个会话会续跑；没打开的不动。
- 同一进程内每个会话只续跑一次。进程再次崩溃重启后，新产生的中断会再续一次。
- 投递失败只记一条 warn，不重试，避免和崩溃循环互相喂饭。
- 文本固定为「继续」。要按界面语言区分（英文发 `continue`）需要改宿主侧来源，目前没做。

## 安装

```bash
plugin_manager install_bundle target=/绝对路径/dsh-plugins/rerun-button
```

**宿主插件，改完需要重启 `dsh web` 才生效**（进程内加载）。浏览器端没有代码，刷新页面即可
看到旧的 Rerun 按钮消失。

## 文件

- `lib/index.js`：全部逻辑（事件监听 + 投递）。
- `test/smoke.mjs`：用假 ctx 驱动控制器，覆盖事件认定、就绪/未就绪、运行中跳过、去重、超时。
- `locale/*.json`：插件管理页显示的标题与说明。
