# dsh-plugin-session-export

> **⚠️ 已弃用（归档）**：会话导出插件已停止维护，移入 `deprecated/` 仅作存档，不再提供安装/更新指引。以下内容保留原状，仅作历史参考。

dsh web 对话页扩展：在会话标题栏提供一个「导出长图」按钮，把**当前会话**从第一条到最新一条的对话导出为**一张**长图 PNG——只展示用户输入与模型输出，自动剔除思考（Think / reasoning）与工具调用等过程内容。

导出图片自带完整样式（随当前主题取色）：用户消息右侧气泡、模型输出全文 Markdown 排版（标题 / 加粗 / 代码块 / 表格 / 列表 / 引用等），并带会话标题、消息时间与消息数页眉。

## 工作原理

- **数据源（node 半段 `lib/index.js`）**：`GET /session-export/data?session=<id>` 读取会话的 append-only 事件日志，按「人类可见的完整对话」规则抽取导出内容：
  - 只保留 `surfaceOp === 'append'` 的事件（压缩 / 编辑产生的 replacement 副本是模型侧视图，不进入导出，用户看过的原话不丢失）；
  - `user/message` 只取 `source.kind === 'user'` 的真实用户输入（插件 / 系统注入的上下文不算用户输入）；
  - `assistant/message` 只取 `text` 内容块——`reasoning`（思考 / Think）、`tool-call` 块被丢弃并计数上报；空内容（仅承载用量）与纯工具调用步骤不产生可见文本，跳过；
  - 标题取最新 `session/title`，否则回退到第一条用户消息首行。
- **渲染（浏览器半段 `lib/client.js`）**：按钮挂在 `conversation.session.header.actions` 槽位。点击后拉取数据，用自带的 GFM 子集 Markdown 渲染器把每条消息渲染成 XHTML，按当前主题取色生成独立样式；消息按高度打包成段（每段 ≤ `segmentHeight`），每段通过 SVG `foreignObject` 栅格化到 canvas（无第三方依赖），再拼接成**一整张**长图 PNG 下载。
- **高度与完整度**：每个分段的高度**直接测量真实布局**（`offsetHeight`），不用逐条消息预测求和——避免取整漂移导致底部被裁。最终**始终只下载一张图**：总高超出浏览器 canvas 高度上限（约 32000px）时自动降低栅格倍率（`scale`）而非拆成多张，保证从第一条到最后一条（含页脚）完整呈现。

## 安装

```bash
dsh plugin --profile web add 'git+https://github.com/WensH77/dsh-plugins.git#path:session-export'
```

在补丁层启用：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 顶层数组追加
- insert:
    - id: session-export
      name: dsh-plugin-session-export
```

重启 dsh web 后，打开任意有内容的会话，标题栏右侧会出现导出按钮（图片图标）。点击即可下载长图。

## 使用

1. 打开要导出的会话；
2. 点击标题栏的导出图标（悬停提示「导出当前会话为长图」）；
3. 浏览器下载**一张** `<会话标题>.png`；导出按钮下方会短暂显示结果提示（含消息数 / 已隐藏的思考条数 / 失败原因）。

> 导出内容 = 用户输入 + 模型输出，从对话最开始到结束；思考（Think）、工具调用、系统注入的上下文、压缩摘要等一律不出现。用户消息中的图片附件以占位框标注（导出不含图片）。

## 配置

`settings.yaml` 中 `session-export` 段（均可省略，使用默认值）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `width` | `860` | 导出图片宽度（CSS px，客户端夹取 480–1400） |
| `scale` | `2` | 栅格倍率（device px / CSS px，1–3），越高越清晰、文件越大；总高超限时自动下调以保持**单张完整**图片 |
| `segmentHeight` | `8000` | 分段栅格高度（CSS px，每段分别绘制后拼成一张） |
| `maxMessages` | `4000` | 导出消息数上限（防御性保护，超出后响应带 `truncated` 标记） |

## 测试

```bash
node test/smoke.mjs          # node 半段：抽取规则 / 标题推导 / 接口契约 / 路由注册
node test/client-smoke.mjs   # 浏览器半段：模块加载 / Markdown→XHTML / 分段打包 / 文件名 / 词典对齐
npm test                     # 以上两者
```

## 已知限制

- Markdown 为 GFM 常用子集（标题、加粗/斜体/删除线、行内与围栏代码、列表含嵌套与任务项、引用、表格、分隔线、链接）；极少数复杂 Markdown（如 HTML 混排、脚注）按纯文本展示。
- 图片附件不进入导出（用户消息显示占位标注）；模型输出的内联图片同样以文本占位。
- 栅格化在浏览器本地完成，会话极长时生成与下载可能耗时数秒；极长会话（总高超过 canvas 上限）会自动降倍率保证单张完整，图片会更窄/更小。
- 导出的是会话日志中的完整对话（append 视图），与界面分页窗口无关。

## 变更日志

见 [CHANGELOG.md](./CHANGELOG.md)。
