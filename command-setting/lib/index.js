// dsh-plugin-command-setting — 入口（装配编排）。
//
// 按域拆分（0.9.0 后的布局）：
//   lib/ask.js         ask（只问答）模式域：判定/提示段/切换通知 + 状态文件 + 会话级控制器
//   lib/routes.js      端点路由（ask-state）+ HTTP 样板
//   lib/index.js       入口：注入声明 + Config + apply 装配（本文件）
//
// 职责：/ask 提供会话级只问答模式（机械拦截 + 提示约束）；此前还负责把指定
// slash 命令从 Web 命令菜单隐藏，该功能已在 0.9.0 整体移除（见 CHANGELOG）。
import z from '@deepseek-ai/schemastery';
import { createAskController, askToolDenyReason, buildAskSection, buildAskNotice } from './ask.js';
import { registerRoutes } from './routes.js';

const name = 'command-setting';
const inject = ['commands', 'webServer'];

// 空 schema：老的 patch.yml 若还写着 config.hidden，schemastery 会原样保留该键
// （不报非法），但它已不再有任何作用——命令隐藏随 0.9.0 移除。
const Config = z.object({});

function apply(ctx) {
  // env：路由与 ask 控制器共用的装配容器（域模块经它读写）。
  const env = { ctx, ask: null };
  // ask（只问答）模式控制器：会话级开关 + per-agent 机械拦截 + 状态侧文件
  const ask = createAskController(ctx);
  env.ask = ask;
  const disposers = registerRoutes(env);
  // /ask 命令（与 /plan 同级）；注册失败（register 抛错）时 askCommand 为 null
  const askCommand = ask.registerAskCommand();
  if (askCommand !== null && askCommand !== undefined) disposers.push(askCommand);
  // dsh web 重启 / 会话销毁：agent/created 恢复、agent/disposed 卸载拦截
  disposers.push(ask.watchLifecycle());

  ctx.logger.info('command-setting: ask (Q&A-only) mode ready');

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name, askToolDenyReason, buildAskSection, buildAskNotice };
export default { Config, apply, inject, name, askToolDenyReason, buildAskSection, buildAskNotice };
