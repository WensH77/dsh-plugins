/**
 * dsh-plugin-graceful-inject — 宿主端装配。
 *
 * 「优雅注入」是一个插件、两个**可插拔**的注入功能，各自有独立开关：
 *
 *   - `resume`（续跑）：DSH 因崩溃/被强杀/关闭超时退出后，本轮被补记为 `interrupted`
 *     的会话自动投递一条带来源标记的「继续」。默认开。触发面两个：会话被打开时，
 *     以及宿主启动时扫描上次运行中的会话并在后台接管（不需要先点开它）。
 *   - `supervise`（监工）：会话标题栏的秒表按钮，点击后往当前会话注入
 *     「汇报当前任务进度」。默认开。
 *
 * 开关写在 profile 的 `cordis.patch.yml` 里（见 README「配置」），关掉的模块既不注册
 * 监听也不注册端点；浏览器端按钮读 `GET /graceful-inject/state` 决定画不画。
 *
 * 两个功能都只做「投递一条带来源的消息」这一件事，不碰会话内容；续跑例外地在
 * `<DSH_HOME>/graceful-inject/running/` 里维护运行标记（见 lib/resume.js）。
 * 具体实现见 lib/resume.js 与 lib/supervise.js。
 */
import z from '@deepseek-ai/schemastery';
import { mountResume } from './resume.js';
import { createStateHandler, createSuperviseHandler, SUPERVISE_TEXT } from './supervise.js';

const name = 'graceful-inject';
/** 宿主服务：两个功能都用 agents；续跑还要 timer，监工还要 webServer。 */
const inject = ['agents', 'sessions', 'timer', 'webServer'];

/**
 * 两个功能的开关，以及监工注入的文本。
 *
 * 模块是独立的：关掉 `resume` 不影响监工按钮，关掉 `supervise` 也照常自动续跑。
 * 两个都关掉时插件只剩状态端点（用来告诉浏览器端别画按钮），等价于停用。
 *
 * `superviseText` 是**运行时**可改的：写进 profile 的 `cordis.patch.yml` 后，dsh 的热重载
 * 会重建插件实例、重新读这个值，下一次点击就注入新文本，不需要重启进程。
 */
const Config = z.object({
  resume: z.boolean().default(true),
  supervise: z.boolean().default(true),
  superviseText: z.string().default(SUPERVISE_TEXT)
});

/**
 * 注册插件：按开关装配功能模块。
 * @param ctx - 宿主上下文。
 * @param config - 经 {@link Config} 校验后的配置。
 */
function apply(ctx, config) {
  const options = {
    resume: config?.resume !== false,
    supervise: config?.supervise !== false,
    // 空字符串没有意义（注入一条空消息），回落默认文本。
    superviseText: typeof config?.superviseText === 'string' && config.superviseText.trim() !== ''
      ? config.superviseText
      : SUPERVISE_TEXT
  };

  // 状态端点在两个功能都关闭时也要在：它是浏览器端唯一的开关信号。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/graceful-inject/state',
    handler: createStateHandler(options)
  }), 'graceful-inject: state endpoint');

  if (options.supervise) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/graceful-inject/supervise',
      handler: createSuperviseHandler(ctx, options)
    }), 'graceful-inject: supervise endpoint');
    ctx.logger.info('graceful-inject: 功能二 supervise 已启用（按钮 → POST /graceful-inject/supervise）');
  } else {
    ctx.logger.info('graceful-inject: 功能二 supervise 已关闭（不注册端点，浏览器端不画按钮）');
  }

  if (options.resume) {
    ctx.effect(() => mountResume(ctx), 'graceful-inject: resume listener');
  } else {
    ctx.logger.info('graceful-inject: 功能一 resume 已关闭（不监听 agent/created / session/event，不维护运行标记）');
  }
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
