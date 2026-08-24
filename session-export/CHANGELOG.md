# Changelog

本文件记录 `dsh-plugin-session-export` 的历次改动（由 git 提交历史整理）。安装、使用、原理、配置见 [README.md](./README.md)。

## 0.1.2

- 修复 header 导出按钮显示整段 SVG 源码文本：图标 SVG 字符串被当作 React children 传入，React 会把字符串渲染成纯文本（需要 `dangerouslySetInnerHTML`）；改为经 `dangerouslySetInnerHTML` 注入真实 `<svg>` 元素
- 用真实 React（react-dom/server）渲染组件验证：修复前按钮内是转义文本 `&lt;svg`，修复后为真实 `<svg>` 元素
- client-smoke 新增按钮图标接线回归测试（mini createElement 结构断言：图标必须走 dangerouslySetInnerHTML、按钮无字符串 SVG 子节点）

## 0.1.1

- 修复导出长图出现「未渲染的 SVG 文本」：Markdown 渲染器在**列表项**与**表格单元格**路径漏了 HTML 转义，消息里的 `` `<backup>` `` / `` `<cwd>` `` 之类文本以裸 `<` 进入 XHTML，破坏 SVG `foreignObject` 的 XML，导致分段图片加载失败/错乱
- 列表/表格与段落/引用/标题路径统一先 `escapeMarkdownSource` 再行内渲染；新增列表、嵌套列表、表格单元格含 `<tag>` 的回归测试
- 用真实会话日志（169 条消息，含 `zstd -dc <backup> | tar -C <cwd> -xf -` 之类内容）在 headless Chrome 验证：修复前 3/3 分段 SVG 加载失败，修复后 3/3 全部成功

## 0.1.0

- 会话导出为长图：会话标题栏新增「导出长图」按钮（`conversation.session.header.actions` 槽位）
- 导出内容 = 用户输入 + 模型输出，从对话最开始到结束：只取 append 视图的 `user/message`（`source.kind === 'user'`）与 `assistant/message` 的 `text` 块，自动剔除思考（reasoning / Think）与工具调用（tool-call）并计数提示
- node 半段 `GET /session-export/data`：事件日志 → 导出转录 + 标题（`session/title` 优先，回退首条用户消息首行）+ 跳过计数 + 渲染配置
- 浏览器半段：无第三方依赖的 GFM 子集 Markdown → XHTML 渲染器（标题/加粗/斜体/删除线/行内与围栏代码/嵌套与任务列表/引用/表格/分隔线/链接），主题取色 + 分消息测高 + 分段打包，SVG `foreignObject` 栅格化到 canvas 并拼接为长图 PNG 下载
- 长会话按 `partHeight` 拆分为多张下载；单条超高消息降 1x 渲染防 canvas 超限；`maxMessages` 防御上限带 `truncated` 标记
- 新增 node / client 两侧 smoke 测试
