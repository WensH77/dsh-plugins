// dsh-plugin-command-setting — 入口（装配编排）。
//
// 按域拆分（重构后布局）：
//   lib/commands.js    命令隐藏域：规约/保护集 + 菜单过滤 + 全集 + 归档清理
//   lib/ask.js         ask（只问答）模式域：判定/提示段/状态文件 + 会话级控制器
//   lib/routes.js      端点路由（catalog / set / ask-state）+ HTTP 样板
//   lib/index.js       入口：注入声明 + Config + apply 装配（本文件）
//
// 职责（不变）：把指定 slash 命令从 Web 命令菜单（"+" / "/" 弹层）隐藏，设置页
// 支持隐藏/显示；hidden 清单持久化在 settings 命名空间（~/.dsh/settings.yaml，
// 热重载），config.hidden 为组合基底；/ask 提供会话级只问答模式。
import z from '@deepseek-ai/schemastery';
import { createAskController, askToolDenyReason, buildAskSection } from './ask.js';
import { cleanHidden, COMMAND_NAME, DEFAULT_HIDDEN, shadowCommandList } from './commands.js';
import { registerRoutes } from './routes.js';

const name = 'command-setting';
const inject = ['commands', 'webServer', 'agents', 'sessions'];
const SETTINGS_NS = 'command-setting';

const Config = z.object({ hidden: z.array(z.string()) });

function apply(ctx, config = {}) {
  // env：路由/清理/过滤共用的可变共享状态（index 负责装配，域模块经它读写）。
  const env = { ctx, scope: null, original: null };
  env.hiddenSet = new Set(cleanHidden(Array.isArray(config.hidden) ? config.hidden : DEFAULT_HIDDEN));
  const notifyChange = () => {
    try {
      ctx.commands.notifyChange();
    } catch (error) {
      ctx.logger.warn('command-setting: notifyChange failed: ' + String(error?.message ?? error));
    }
  };
  env.notifyChange = notifyChange;
  // Apply an authoritative hidden list: refresh the filter and tell the browser
  // directory to re-sync. Used by the settings watcher and the write path alike.
  const applyHidden = (next) => {
    env.hiddenSet = new Set(cleanHidden(Array.isArray(next) ? next : []));
    notifyChange();
  };

  const disposers = [shadowCommandList(env)];
  // ask（只问答）模式控制器：会话级开关 + per-agent 机械拦截 + 状态侧文件
  const ask = createAskController(ctx);
  env.ask = ask;
  for (const dispose of registerRoutes(env)) disposers.push(dispose);
  // /ask 命令（与 /plan 同级）；注册失败（register 抛错）时 askCommand 为 null
  const askCommand = ask.registerAskCommand();
  if (askCommand !== null && askCommand !== undefined) disposers.push(askCommand);
  // dsh web 重启 / 会话销毁：agent/created 恢复、agent/disposed 卸载拦截
  disposers.push(ask.watchLifecycle());

  let disposeWatch = null;
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    try {
      env.scope = settings.register(SETTINGS_NS, z.object({ hidden: z.array(z.string()) }), {
        base: { hidden: [...env.hiddenSet] }
      });
      disposeWatch = env.scope.watch(() => applyHidden(env.scope.get()?.hidden));
    } catch (error) {
      // settings.register ties the namespace to the SETTINGS PROVIDER's fiber,
      // not this plugin's — stopping this plugin leaks the registration, so a
      // later re-activation throws "already registered". Reuse the live
      // registration through the service's own read/write methods instead of
      // failing to start. (No watcher exists on this path; the write path still
      // refreshes through the substitute update below.)
      const message = String(error?.message ?? error)
      // 注册绑定在 settings 服务生命周期上，停用后会泄漏；重新启用时 register 抛
      // "already registered"（或相近措辞）属预期，直接复用现存注册。其余错误
      // （schema/校验问题）仍 fail loud，避免静默吞掉真问题。
      if (!/already registered|already exists|duplicate/i.test(message)) throw error;
      env.scope = {
        get: () => settings.get(SETTINGS_NS),
        update: async (patch) => {
          await settings.update(SETTINGS_NS, patch);
          applyHidden(patch?.hidden ?? []);
        }
      };
    }
    env.hiddenSet = new Set(cleanHidden(env.scope.get()?.hidden ?? []));
    // 注意：启动时不做归档清理——此刻通常没有 live 会话、也拿不到浏览器贡献
    // 命令面，命令面不完整；清理只在 catalog 读取（客户端已上报贡献面）时惰性
    // 进行，保证有效隐藏（贡献命令/agent 命令）永不被误删。
  });

  ctx.logger.info('command-setting: hiding /' + [...env.hiddenSet].join(', /') + ' from the command menu (settings namespace ' + SETTINGS_NS + ')');

  return () => {
    for (const dispose of disposers) dispose();
    if (disposeWatch !== null) disposeWatch();
  };
}

export { Config, apply, inject, name, askToolDenyReason, buildAskSection };
export default { Config, apply, inject, name, askToolDenyReason, buildAskSection };
