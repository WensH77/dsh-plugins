/**
 * dsh-plugin-rerun-button — 宿主端。
 *
 * 没有按钮，没有端点。它做一件事：**DSH 因崩溃/被强杀/关闭超时退出后，本轮被补记为
 * `interrupted` 的那个会话，在恢复时自动接着跑**。
 *
 * 为什么不在 `session/event` 里抓：崩溃遗留轮次的收尾是 agent-loop 在 resume 时直接
 * 追加到持久化文件、并以 seed 形式建进 Session 的（见 dsh-agent-loop 的 resume 流程），
 * 既不经过 `Session.append`，seed 也不发 `session/event`。所以在事件流上永远看不到它。
 *
 * 可靠的做法是反过来：监听 `agent/created`，直接读该会话在内存里的事件（`ownEvents()`），
 * 看最后一条 `turn/end` 的 reason。`interrupted` 只会在恢复未闭合轮次时出现——运行中的
 * Agent 循环从不现场发它——所以这个判断天然幂等：续跑本身会开出新的一轮，把「最后一条
 * turn/end」推进到 completed，下次恢复就不会再触发。
 *
 * 续跑方式：`agent.followup(createUserMessage({ content: ['继续'], source: { kind: 'rerun-button' } }))`。
 * 消息带自定义来源，聊天里显示成「收到执行请求」的触发条目，不是一条用户发言；模型收到
 * 的仍然是一句「继续」。会话的每一轮都必须有输入（Agent 的入口只有 send/followup/steer/
 * inject，没有「空轮」），所以能改的是这条输入的身份，不是取消输入。
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

const name = 'rerun-button';
const inject = ['agents', 'sessions', 'timer'];
/** 自动投递的文本。模型两种都懂，这里跟 UI 默认语言走中文。 */
const TEXT = '继续';
/** 等 Agent 就绪的轮询间隔与上限（约 10 秒）。 */
const RETRY_MS = 250;
const RETRY_LIMIT = 40;

/** 组装那条「继续」消息。导出一份便于测试直接断言。 */
function continueMessage(text = TEXT) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    // 自定义来源：Chat 据此渲染成触发条目，而不是用户气泡。
    source: { kind: 'rerun-button', form: 'notice', summary: boundContextSummary(text) }
  });
}

/**
 * 读一个会话最后一条 `turn/end` 的 reason。
 *
 * 按顺序扫一遍事件，跟踪未闭合的 turn。最后一条 turn 还没结束时返回 undefined——那是
 * 运行中或刚中断尚未收尾，不该自动续跑。
 *
 * @param session - 会话对象（需要 `ownEvents()`）。
 * @returns reason.kind（`interrupted` / `completed` / …），或 undefined。
 */
function lastTurnEndReason(session) {
  if (typeof session?.ownEvents !== 'function') return undefined;
  let openTurn;
  let lastReason;
  for (const event of session.ownEvents()) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn;
    } else if (event.type === 'turn/end') {
      lastReason = event.data?.reason?.kind;
      if (openTurn === event.data.turn) openTurn = undefined;
    }
  }
  return openTurn === undefined ? lastReason : undefined;
}

/**
 * 创建自动续跑控制器。导出以便测试用假 ctx 驱动，不必起宿主进程。
 *
 * @param ctx - 携带 agents / sessions / timer 的宿主上下文。
 * @returns `{ arm, onCreated, armed, fired }`；`onCreated(agent)` 在 Agent 就绪时判断是否续跑。
 */
function createAutoResume(ctx) {
  /** 本进程里登记过的会话（同一进程只处理一次）。 */
  const armed = new Set();
  /** 已经投递过的会话，防重复。 */
  const fired = new Set();

  const deliver = async (sessionId, agent, text) => {
    fired.add(sessionId);
    try {
      agent.followup(continueMessage(text));
      await ctx.sessions.flush(agent.session);
      ctx.logger.info('rerun-button: 已为中断的会话 ' + sessionId + ' 自动投递「' + text + '」');
    } catch (error) {
      // 保持 fired：一次失败不重试，避免和崩溃循环互相喂饭。
      ctx.logger.warn('rerun-button: 自动续跑失败 ' + sessionId + ': ' + String(error?.message ?? error));
    }
  };

  /** 等目标会话的 Agent 就绪后投递；Agent 已在跑就不打扰。 */
  const waitAndDeliver = (sessionId, text) => {
    let attempts = 0;
    const tick = () => {
      if (fired.has(sessionId)) return;
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) {
        attempts += 1;
        if (attempts > RETRY_LIMIT) {
          ctx.logger.warn('rerun-button: 会话 ' + sessionId + ' 的 Agent 迟迟没有就绪，放弃自动续跑');
          return;
        }
        ctx.timeout(tick, RETRY_MS);
        return;
      }
      if (agent.status === 'running') {
        // 恢复后已经在跑（例如用户同时手动发了消息），不重复投递。
        fired.add(sessionId);
        return;
      }
      void deliver(sessionId, agent, text);
    };
    tick();
  };

  /**
   * 登记一个会话。
   * @param sessionId - 会话 id。
   * @param text - 投递内容，缺省「继续」。
   */
  const arm = (sessionId, text = TEXT) => {
    if (typeof sessionId !== 'string' || sessionId === '' || armed.has(sessionId)) return;
    armed.add(sessionId);
    waitAndDeliver(sessionId, text);
  };

  /**
   * Agent 就绪时判断：这个会话是否因崩溃停在了半路。
   * @param agent - 新建或恢复的 Agent。
   */
  const onCreated = (agent) => {
    const session = agent?.session;
    if (session === undefined) return;
    // 子代理会话由父代理驱动，不掺和。
    if (session.header?.origin === 'subagent') return;
    if (lastTurnEndReason(session) !== 'interrupted') return;
    arm(agent.id);
  };

  return { arm, onCreated, armed, fired };
}

/**
 * 注册监听。绑在插件 ctx 生命周期上，停用即回收。
 * @param ctx - 宿主上下文。
 */
function apply(ctx) {
  const controller = createAutoResume(ctx);
  ctx.on('agent/created', ({ agent }) => {
    controller.onCreated(agent);
  });
  ctx.logger.info('rerun-button: 恢复中断轮次后自动续跑（' + TEXT + '）');
}

export { apply, continueMessage, createAutoResume, inject, lastTurnEndReason, name, TEXT };
export default { apply, inject, name };
