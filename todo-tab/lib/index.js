// dsh-plugin-todo-tab — 宿主端。
//
// 两件事：
//   1) 只读端点 GET /todo-tab/data?session=<id>：按会话 cwd 的工作区名读
//      <DSH_HOME>/memory/<工作区>/TODO.md 并返回；没有写端点。
//   2) 待办约定常驻注入 + 运行时技能（见 lib/convention.js）：把原先写在
//      ~/.dsh/AGENTS.md 的约定改成插件携带，随安装分发。
//
// 会话 id 只用于查宿主自己的会话表（ctx.sessions.get），不接受调用方给路径，
// 因此不存在任意文件读取面。
import { CONTEXT_NAME, CONTEXT_ORDER, conventionText, loadSkill } from './convention.js';
import { readTodo, workspaceNameOf } from './memory.js';

const name = 'todo-tab';
const inject = ['webServer', 'sessions'];
/** 会话 id 形状（与宿主其它端点一致），用于挡掉空值与畸形输入。 */
const SESSION_ID = /^[A-Za-z0-9-]+$/;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/**
 * 构建端点处理器。导出以便测试直接注入假 ctx 调用，不必起 HTTP 服务。
 * @param ctx - 携带 `sessions` 服务的宿主上下文。
 * @returns webServer 的 handler。
 */
function createHandler(ctx) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const sessionId = url.searchParams.get('session') ?? '';
      if (!SESSION_ID.test(sessionId)) {
        sendJson(res, 400, { ok: false, code: 'bad-session', message: 'missing or malformed session id' });
        return;
      }
      const session = ctx.sessions.get(sessionId);
      if (session === undefined) {
        sendJson(res, 404, { ok: false, code: 'no-session', message: 'no live session with id ' + sessionId });
        return;
      }
      const workspace = workspaceNameOf(session.header?.cwd);
      if (workspace === null) {
        sendJson(res, 409, { ok: false, code: 'no-workspace', message: 'session has no cwd to derive a workspace from' });
        return;
      }
      const todo = await readTodo(workspace);
      sendJson(res, 200, { ok: true, workspace, ...todo });
    } catch (error) {
      ctx.logger.warn('todo-tab: read failed: ' + String(error?.message ?? error));
      sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
    }
  };
}

/**
 * 待办约定的常驻注入 + 技能注册。
 *
 * 两个坑，都踩过：
 *   1) **约定挂在 agent 自己的 scope 上**。`SystemPrompt.assemble` 只合并 global 层与该 agent 的
 *      scope 链，插件自己的 scope 不在链上——挂插件 ctx 会静默不进任何 prompt（Theseus Crew 在
 *      0.36.34 之前踩过同一个坑）。所以按 `agent/created` 逐个挂，`agent/disposed` 时释放。
 *   2) **技能要经 `agent.ctx.inject(['skills'], …)` 注册，不能直接写 `agent.ctx.skills`**。skills
 *      服务由 host 组合的另一行提供，不在 agent ctx 的 fiber 链上，而 agent ctx 没有声明 inject，
 *      cordis 会直接拒：`cannot get property "skills" without inject`。0.2.0 的技能就是这样丢的
 *      （异常被下面的 catch 降级成 warn，warn 又落在被缓冲的日志里，内外都看不见）。`inject` 给出的
 *      scoped ctx 作用域仍是该 agent，所以技能照旧落在 agent 层。
 *
 * `ctx.inject` 而非顶层 inject：缺这些服务时只损失约定注入，端点与页签照常工作。
 *
 * @param ctx - 宿主上下文。
 * @returns disposer 集合（由 cordis 随注入作用域回收）。
 */
function applyConvention(ctx) {
  return ctx.inject(['agents', 'systemPrompt', 'skills'], (promptCtx) => {
    // 技能正文是磁盘上的文件，读一次就够；先起请求，agent 到来时再挂。
    const skillReady = loadSkill().catch((error) => {
      promptCtx.logger.warn('todo-tab: skill load failed: ' + String(error?.message ?? error));
      return null;
    });
    /** agent id → 该 agent 上的 disposer 列表。 */
    const docked = new Map();

    const release = (agentId) => {
      const out = docked.get(agentId);
      if (out === undefined) return;
      docked.delete(agentId);
      for (const dispose of out) {
        try {
          dispose();
        } catch (error) {
          promptCtx.logger.warn('todo-tab: release failed: ' + String(error?.message ?? error));
        }
      }
    };

    const dock = (agent) => {
      const id = agent?.id;
      if (typeof id !== 'string' || id === '' || docked.has(id)) return;
      const out = [];
      docked.set(id, out);
      try {
        const dispose = agent.ctx?.systemPrompt?.context?.({
          name: CONTEXT_NAME,
          order: CONTEXT_ORDER,
          text: conventionText()
        });
        if (typeof dispose === 'function') out.push(dispose);
        else promptCtx.logger.warn('todo-tab: 约定未挂上（agent scope 上没有 systemPrompt.context）agent=' + id);
      } catch (error) {
        promptCtx.logger.warn('todo-tab: convention dock failed: ' + String(error?.message ?? error));
      }
      void skillReady.then((skill) => {
        // 技能读失败，或 agent 已经走了，就什么都不做。
        if (skill === null || !docked.has(id)) return;
        // 必须经 inject 拿 skills（见文件头第 2 点）：直接 `agent.ctx.skills` 会被 cordis 拒，
        // 异常只会变成一条没人看的 warn，技能静默消失。
        const offInject = agent.ctx?.inject?.(['skills'], (scoped) => {
          try {
            const dispose = scoped.skills?.register?.({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse,
              content: skill.content,
              // source 是 SkillRegistration 的必填项：少了它技能能进目录，但 `skills.get()`
              // 会在 validateDefinition 里抛「loaded skill "…" source must be a string」。
              source: 'custom',
              provider: name
            });
            if (typeof dispose !== 'function') {
              promptCtx.logger.warn('todo-tab: 技能未注册（scoped ctx 上没有 skills.register）agent=' + id);
              return;
            }
            // inject 回调可能晚于 agent/disposed；那时 out 已经 release 过，就地释放。
            if (docked.has(id)) out.push(dispose);
            else dispose();
            promptCtx.logger.info('todo-tab: 技能已注册 ' + skill.name + ' agent=' + id);
          } catch (error) {
            promptCtx.logger.warn('todo-tab: skill register failed: ' + String(error?.message ?? error));
          }
        });
        if (typeof offInject !== 'function') {
          promptCtx.logger.warn('todo-tab: 技能未注册（agent ctx 上没有 inject）agent=' + id);
          return;
        }
        if (docked.has(id)) out.push(offInject);
        else offInject();
      }).catch((error) => {
        // 少了这条 catch，技能挂载里抛出的任何东西都只会是一条没人看见的 unhandled rejection。
        promptCtx.logger.warn('todo-tab: skill dock failed: ' + String(error?.message ?? error));
      });
    };

    const offCreated = promptCtx.on('agent/created', ({ agent }) => {
      dock(agent);
    });
    const offDisposed = promptCtx.on('agent/disposed', ({ agent }) => {
      if (typeof agent?.id === 'string') release(agent.id);
    });
    // 插件后加载（重载/热更）时，已有活 agent 补挂一次。
    for (const agent of promptCtx.agents.list()) dock(agent);
    promptCtx.logger.info('todo-tab: 待办约定已接入（常驻 context + ' + CONTEXT_NAME + '，技能按 agent 注册）');

    return () => {
      offCreated();
      offDisposed();
      for (const id of [...docked.keys()]) release(id);
    };
  });
}

/**
 * 注册只读端点与待办约定注入。两者都绑在插件 ctx 生命周期上，停用即回收。
 * @param ctx - 宿主上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/todo-tab/data',
    handler: createHandler(ctx)
  }));
  ctx.logger.info('todo-tab: serving GET /todo-tab/data (read-only)');
  applyConvention(ctx);
}

export { apply, applyConvention, createHandler, inject, name };
export default { apply, inject, name };
