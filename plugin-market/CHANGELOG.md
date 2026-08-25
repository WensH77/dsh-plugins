# Changelog

本文件记录 `dsh-plugin-market` 的历次改动（由 git 提交历史整理）。安装、使用、端点、配置见 [README.md](./README.md)。

## 0.4.4

- 修复「检查更新后无法更新」：安全审查关闭时，检查更新仅提示「有更新」却没有更新入口——已安装卡片检测到更新时直接显示「更新」按钮（审查开启且有隔离任务时仍走审查报告弹窗确认；审查关闭时直接 git 通道更新，不重新审查）
- `/update` 支持 `review: false`：无隔离任务路径跳过差异审查直接安装（与安装链路审查开关一致）；审查开启时该路径生成的报告同样保存为该插件新版本
- 更新成功后清除该插件的「有更新」残留提示；本地 link/file 安装插件的禁用「检查更新」按钮增加说明（源码目录 git pull + 重启）

## 0.4.3

- 新增「帮我安装」：安装失败（migrate 阶段）时保留失败任务卡片并加「帮我安装」按钮，点击后打开可见 harness 会话（attach 当前 workspace），首条消息预填安装请求 + 失败原因 + profile 目录，让会话诊断并完成安装；任务标记「已交给会话」、按钮幂等
- 失败任务保留在任务列表（此前直接删除），向客户端暴露 `error` 与 `helpSessionId`

## 0.4.2

- 来源展示回退：无已存 repo 覆盖时，先回退到包自身 `repository` 字段、再回退到 `github:` 依赖说明，CLI 安装的 git 插件也能显示仓库并检查更新

## 0.4.1

- 修复空 `[]` patch 层：剥离 `[]` 空 patch 标记后再追加 insert/disable 块，避免挂到 dsh 默认 `cordis.patch.yml`（注释 + `[]`）时产生非法 YAML
- insert 层已写入 patch 但未进运行树的插件显示在「待重启」区；安装后探测 HMR，未热更则上报 `restart:true`

## 0.4.0

- 更新改为隔离环境直接安装 + 差异审查（`updateJobId` 直接安装）
- 侧边栏 dsh 版本状态灯：检测 deepseek-harness 最新 `dsh-v*` tag，点击开新会话分析破坏性更新，判定持久化到 `plugin-market-dsh.json`
- 新增 `/dsh-version`、`/dsh-version/check`、`/dsh-version/analyze` 端点

## 0.2.1

- allowBuilds 恢复：自动写 pnpm `allowBuilds`（git prepare / 被忽略的构建）并重试
- stream pnpm Progress 到安装/拉取进度条
- 保留已装插件的审查报告（protected）+ `/review` 端点；repo override 去重

## 0.2.0

- 两阶段安装：隔离拉取 + 分层安全审查 + 确认安装，任务可视化（状态/阶段/耗时，1s 轮询，可中断）
- 安全审查走 harness 会话（`agents.create` + followup + 日志轮询提取 JSON），LLM 直连兜底；审查开关关闭需连点 5 次、1 秒保护
- 更新附带与本地已装代码的逐文件差异审查（method: `update-diff`）
- 卸载先删依赖后删配置（失败可重试）；bundle 卸载写临时禁用行立即卸载
- 安装时保存用户填写的仓库地址（manual 标记区分手动修改）；待重启卡片与仓库地址展示优化

## 0.1.0

- 插件市场 tab：来源管理（npm/git/auto）、安装/更新/卸载/开关、分层 L0+L1 安全审查、待重启分区
