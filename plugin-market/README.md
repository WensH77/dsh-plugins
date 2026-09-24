# dsh-plugin-market（dsh 版本状态灯）

0.16.0 起本插件只做一件事：在侧边栏品牌名（DeepSeek Harness）下方注入一个 **dsh 版本状态灯**，
检测 dsh 本体（`deepseek-ai/deepseek-harness`）有没有新版本，并支持点击分析新版本会不会影响
本机已装插件的运行期兼容性。

> 历史版本里的「设置 → 插件 → 插件市场」tab（插件清单 / 开关 / 源管理 / 安装 / 更新 / 卸载 /
> 安全审查 / 清理缓存）已在 0.16.0 整体删除，设置页不再有本插件的入口。相关宿主模块
> `lib/install.js`、`lib/review.js`、`lib/pnpm.js` 一并移除。

## 状态灯

- **检测对象与节奏**：按 GitHub Releases 取 `deepseek-ai/deepseek-harness` 的最新发布版本
  （release 语义，非 git commit hash；限流时回退 `git ls-remote --tags`），web 启动时检测一次 +
  每 1 小时同步。
- **颜色语义**：绿 = 已是最新；黄 = 有新版本（尚未分析，或分析后判定无兼容性问题）；
  红 = 有新版本且可能影响已装插件运行期兼容性；灰 = 无法检查。
- **文字**（简约拼接，无 hover 文案）：`v0.1.1-rc.2` / `v0.1.1-rc.2 · 有新版本` /
  `v0.1.1-rc.2 · 兼容性问题` / `v0.1.1-rc.2 · 正在分析新版本…`。
- **点击行为**：
  - 已有判定（红 / 黄）→ 弹出判定弹窗：结论、摘要、**可复制的升级命令**（rc/beta → `@next`、
    alpha → 精确版本、正式版 → `@latest`）、版本变更明细、变更要点、可能受影响的插件、
    本地插件契约扫描证据、详情。报告文本一律简体中文。
  - 尚未分析（黄灯待分析）→ 先跑 L1 本地插件契约扫描（机器判定，不依赖 LLM），再静默直连 LLM
    （`ctx.llm.stream`，跟随 `agent-default-model`，120s 超时，不建会话）逐版本分析
    「当前版本 → 最新版本」之间每一个版本，给出 `breakingChanges` 与逐版本 `breaking` 标注。
- **分析期间的文案时机**：点击后立即切成「正在分析新版本…」并转 1s 快轮询；服务端在
  「拉版本材料 + L1 契约扫描」阶段仍是 idle，客户端用 120s 守卫期忽略这种陈旧响应，
  既不把文案打回去也不退回 60s 慢轮询，判定写回后 1s 内切到结果。
- **L1 契约扫描**：枚举已安装用户插件，读 `dsh.client.inject` 注入名、`lib/*.js` 里的
  `@deepseek-ai/…` 引用字面量与声明的宿主依赖范围；按精确版本号从 npm registry 拉目标版本的
  `dsh-web-app`/`dsh-base` 依赖闭包做对比，产出 `removed-module`（宿主模块消失）与
  `range-break`（声明范围不覆盖目标版本）。按声明 section 定档：只有 `removed-module` 与
  `dependencies` 越界计入「受影响」；`devDependencies` 越界记为开发期提示、`peer` 越界为声明
  失真，两者都不作为破坏性更新的判据。registry 不可达时降级 `local-only`（仅指纹），不阻塞分析。
- **点击幂等**：分析进行中重复点击不并发起第二次；远端版本未变且判定口径一致时直接复用已有判定。
  判定口径版本 `verdictSchema` 升级后旧缓存作废、点击即按当前口径重新分析。
- **持久化**：判定写在 `~/.dsh/plugin-market-dsh.json`，重启后仍生效；远端版本变化后重置为待分析。

## 端点

| 端点 | 方法 | 用途 |
|---|---|---|
| `/plugin-market/dsh-version` | GET | dsh 自更新状态（已装/远端版本 + 破坏性判定），供侧边栏状态灯 |
| `/plugin-market/dsh-version/check` | POST | 强制重新检测 dsh 更新 |
| `/plugin-market/dsh-version/analyze` | POST | 跑 L1 本地插件契约扫描 + 直连 LLM 逐版本分析，返回并持久化判定 |

## 配置

无强制配置。判定状态在 `~/.dsh/plugin-market-dsh.json`。

## 安装

```bash
dsh plugin --profile web add ./plugin-market
```

host 端代码改动（`lib/index.js`、`lib/dsh.js`、`lib/patch.js`、`lib/routes.js`）需重启 `dsh web`
生效；client 端（`lib/client.js`）每次请求实时加载，刷新页面即可。

## 开发

```bash
npm test              # = node test/smoke.mjs：契约快照 + client 渲染块假 DOM 执行
node --check lib/client.js
```

host 端零第三方依赖（只用 node 内置模块）；client 端为手写 module 包装，无需构建。

## License

MIT

## 变更日志

历次改动见 [CHANGELOG.md](./CHANGELOG.md)。
