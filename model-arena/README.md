# dsh-plugin-model-arena（模型竞技场）

dsh web 模型竞技场开关插件（**竞技场功能开发中**）：

- 在命令菜单（「+」按钮菜单 / 输入 "/" 的命令分组）注册**普通命令 /arena**
- 选择 /arena 弹出开关面板：显示当前状态（勾选标记），选择「开启 / 关闭模型竞技场」
  即切换并**持久化**到 settings.yaml（命名空间 `model-arena`，字段 `enabled: boolean`，默认 `false`），
  切换成功后 composer 顶部出现通知
- 开启/关闭**不影响任何对话行为**（功能开发中，仅状态占位，为后续竞技场功能留挂载点）

## 决策记录

- **入口为普通命令（非独立分区）**：曾计划新增「额外能力/EXTRA」菜单分区，但平台机制确认
  「+」按钮打开的菜单固定只显示「命令/Commands」一个分组（`toggleSource("command")` 硬编码），
  无法新增分区；独立分区只能在输入 "/" 时按触发器源显示。已按用户确认采用普通命令方案
- **命令贡献（contribution + popupSelect）而非 host 命令**：避免 host 命令在聊天流中产生
  持久 flow 节点噪音，与 /model 命令同机制；菜单中表现与普通命令一致

## 架构

| 文件 | 角色 |
|---|---|
| lib/index.js | **Node 端** Cordis 插件：注册 `model-arena` 设置命名空间（settings.yaml 持久化），提供 GET /model-arena/state 与 POST /model-arena/set |
| lib/client.js | **浏览器端** 插件包：注册 /arena 命令贡献（popupSelect 弹窗，options 读取当前状态、onSelect 写入并通知），无 React 依赖 |

数据流：

    弹窗打开（+ 菜单或 /arena）--> GET /model-arena/state --> 显示当前状态勾选
    选择开启/关闭 --> POST /model-arena/set { enabled }
      --> Node 端校验 --> settings scope.update({ enabled }) --> settings.yaml 落盘
      --> 弹窗关闭 + composer 顶部通知；失败弹窗保留显示错误（可重试）

## 安装（dsh web profile）

    # 1) 安装包体
    mkdir -p ~/.dsh/profiles/web/node_modules/dsh-plugin-model-arena
    cp -R model-arena/. ~/.dsh/profiles/web/node_modules/dsh-plugin-model-arena/

    # 2) ~/.dsh/profiles/web/cordis.patch.yml 追加（顶层数组）：
    - insert:
        - id: model-arena
          name: dsh-plugin-model-arena

    # 3) 重启 dsh web

## 配置（settings.yaml）

    model-arena:
      # 竞技场开关（默认 false；功能开发中，开启暂不影响对话）
      enabled: false

也可在 cordis.patch.yml 的 insert 中通过 `config.enabled` 设置组合基础值：
用户层（settings.yaml）一经修改即优先。

## 使用

1. 点击 composer 的「+」按钮（或输入 "/"），在命令列表中选择 **/arena**（也可直接输入 /arena 回车）
2. 弹出开关面板：当前状态带勾选标记
3. 选择「开启模型竞技场 / 关闭模型竞技场」→ 顶部通知确认，settings.yaml 同步落盘

## 测试

    node model-arena/test/smoke.mjs          # node 端：state/set 端点、校验、settings 降级
    node model-arena/test/client-smoke.mjs   # 浏览器端：模块加载、/arena 注册、字典对齐、options/onSelect

覆盖：默认关闭；set 持久化后 state 反映；非布尔 / 缺失 enabled 400；settings 未挂载时 set 503、
state 降级返回 config 基础值；config.enabled 作为组合基础层；浏览器端 /arena 贡献注册
（name/popupSelect/available）、zh-en 字典键对齐、options 勾选当前状态、onSelect POST 正确 body
并触发 success 通知。

## 已知限制

- **功能开发中**：开关仅持久化状态，不触发任何竞技场行为；开启时弹窗与通知均有「开发中」提示
- 状态**全局生效**（settings.yaml 命名空间），对所有会话一致；跨标签页同步通过每次打开弹窗
  重新读取实现（无常驻 UI 展示状态）
- /arena 为浏览器端命令贡献：不受 host 命令注册影响；若 command-setting 隐藏列表包含 arena，
  该命令将从菜单移除（本插件默认不隐藏）
