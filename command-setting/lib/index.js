// dsh-plugin-command-setting — node half
// Hides selected slash-commands from the Web command menu (the "+" / "/" popup).
//
// - The hidden list is a settings namespace ("command-setting"), persisted in
//   ~/.dsh/settings.yaml and hot-reloaded; config.hidden is the composition
//   base (the initial default).
// - The registry's `list` view is filtered, so hidden commands no longer
//   appear in the menu and direct slash invocation stops resolving; every
//   change notifies the browser command directory through commands/change.
// - Two webServer endpoints serve the settings page:
//     GET  /command-setting/catalog  -> { ok, commands, hidden }
//     POST /command-setting/set      -> body { hidden: string[] }
import z from '@deepseek-ai/schemastery';

const name = 'command-setting';
const inject = ['commands', 'webServer', 'agents', 'sessions'];
const SETTINGS_NS = 'command-setting';
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const DEFAULT_HIDDEN = ['export', 'feedback', 'permission'];
// System commands that can never be hidden: enforced on every read and write,
// so even a hand-edited settings.yaml cannot hide them.
const PROTECTED = ['plan', 'goal'];
const cleanHidden = (list) => list.filter((entry) => !PROTECTED.includes(entry));

const Config = z.object({ hidden: z.array(z.string()) });

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done) => {
    // 框架已预解析 body 时直接取用（防止 webServer 升级后 data 事件不再来、
    // 端点挂起）；否则手动聚合，超 64KB 截断为 '{}'（后续 JSON 校验兜底 400）。
    if (typeof req.body === 'string') {
      done(req.body);
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) truncated = true;
      else chunks.push(chunk);
    });
    req.on('end', () => done(truncated ? '{}' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done('{}'));
  });
}

/**
 * 注册 webServer 路由并容忍 re-init 时残留的同路径旧路由（停用/重载后旧 handler
 * 已随旧 ctx 失效，probe 会报 inactive context）：命中 duplicate 先清掉旧路由
 * 再重新注册，保证「停用后重新启用」幂等。
 */
function registerWebRoute(ctx, route) {
  // 把路由绑定到插件 ctx 生命周期：停用（ctx dispose）时 cordis 自动执行清理
  // 注销路由，重新启用再注册不会撞 duplicate route（实测停用后旧路由会残留，
  // 旧 handler 已随旧 ctx 失效）。兜底：命中 duplicate 时清掉残留路由后重注册。
  return ctx.effect(() => {
    try {
      return ctx.webServer.register(route);
    } catch (error) {
      if (!/duplicate/.test(String(error?.message ?? error))) throw error;
      const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes;
      if (table && typeof table.delete === 'function') table.delete(route.path);
      return ctx.webServer.register(route);
    }
  });
}

function apply(ctx, config = {}) {
  let hiddenSet = new Set(cleanHidden(Array.isArray(config.hidden) ? config.hidden : DEFAULT_HIDDEN));
  let scope = null;
  let disposeWatch = null;

  const notifyChange = () => {
    try {
      ctx.commands.notifyChange();
    } catch (error) {
      ctx.logger.warn('command-setting: notifyChange failed: ' + String(error?.message ?? error));
    }
  };
  // Apply an authoritative hidden list: refresh the filter and tell the browser
  // directory to re-sync. Used by the settings watcher and the write path alike.
  const applyHidden = (next) => {
    hiddenSet = new Set(cleanHidden(Array.isArray(next) ? next : []));
    notifyChange();
  };

  // Instance-level shadow: the Typert gateway resolves RPC methods on the live
  // service instance (Reflect.get(receiver, implementation)), so this own
  // property is exactly what remote.commands.list ends up calling. The original
  // is restored on dispose so a stop/start cycle never stacks filters and a
  // stopped plugin leaves the menu exactly as it found it.
  const service = ctx.commands;
  const original = service.list.bind(service);
  service.list = (agent) => original(agent).filter((descriptor) => !hiddenSet.has(descriptor.name));

  /** 当前「已知命令面」全集：浏览器贡献命令（客户端上报，如 /model）∪ 全局
   * 注册 ∪ 所有 live 会话的 agent 注册。贡献命令只存在于浏览器（commandUi.live.
   * contributions），node 端命令面看不到它们——全集必须并入客户端上报的名单，
   * 否则 /model 这类贡献命令的 hidden 会被当成幽灵清掉。命令面不可靠（服务
   * 缺失/任一 agent 读取失败）时返回 null——宁可不清，避免误删。 */
  const collectKnown = (contributions) => {
    const names = new Set(contributions ?? []);
    try {
      for (const descriptor of original(undefined)) names.add(descriptor.name);
    } catch {
      return null;
    }
    let sessions;
    try {
      sessions = ctx.sessions?.list?.();
    } catch {
      return null;
    }
    if (sessions === undefined) return null;
    for (const session of sessions ?? []) {
      const id = session?.id;
      if (typeof id !== 'string') continue;
      let agent;
      try {
        agent = ctx.agents.get(id);
      } catch {
        continue;
      }
      if (agent === undefined) continue;
      try {
        for (const descriptor of original(agent)) names.add(descriptor.name);
      } catch {
        // 单个 agent 命令面读取失败：全集不完整，保守放弃本次清理
        return null;
      }
    }
    return names;
  };

  /** 归档清理：hidden 中已不在已知命令面的条目（命令被卸载/更名后的残留）
   * 主动移除并持久化。只清理「命令面可信」的情况——客户端已上报贡献命令
   * （contributions 参数存在）、存在 ≥1 个 live 会话（agent 面至少覆盖当前
   * 会话）、collectKnown 非 null。否则一律不清，保证有效隐藏永不丢失。
   * 只在确有幽灵条目时才写入 settings，避免频繁写。 */
  const sweepArchived = async (contributions) => {
    try {
      if (contributions === null || contributions === undefined) return; // 贡献面未知
      const sessions = ctx.sessions?.list?.();
      if (!Array.isArray(sessions) || sessions.length === 0) return; // 无 live 会话，agent 面缺失
      const known = collectKnown(contributions);
      if (known === null) return;
      const current = cleanHidden([...hiddenSet]);
      const survivors = current.filter((entry) => known.has(entry));
      if (survivors.length === current.length) return;
      hiddenSet = new Set(survivors);
      ctx.logger.info('command-setting: swept archived hidden entries: ' + current.filter((e) => !survivors.includes(e)).join(', '));
      if (scope !== null) await scope.update({ hidden: survivors });
      notifyChange();
    } catch (error) {
      ctx.logger.warn('command-setting: sweep archived hidden entries failed: ' + String(error?.message ?? error));
    }
  };

  const disposers = [
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/command-setting/catalog',
      handler: async (req, res) => {
        try {
          // 归档清理：仅在客户端上报了贡献命令面（contributions 参数存在）时
          // 执行——参数缺失意味着调用方不了解浏览器贡献命令（外部/旧客户端），
          // 清理会把 /model 这类贡献命令的 hidden 误删。参数存在即使为空串，
          // 也代表"贡献面已知为空"，命令面可信。
          const url = new URL(req.url ?? '/', 'http://x');
          const contributionsParam = url.searchParams.get('contributions');
          if (contributionsParam !== null) {
            const contributionSet = new Set(
              contributionsParam.split(',').filter((entry) => COMMAND_NAME.test(entry))
            );
            await sweepArchived(contributionSet);
          }
          // Unfiltered views: the settings page must still list hidden commands
          // so they can be shown again — global registrations always, plus the
          // UNFILTERED agent-scoped registrations of the requesting session
          // (?session=<id>). Hidden agent-scoped commands are filtered from the
          // live directory, so without this union the settings page could not
          // show (or un-hide) them and pruning would drop them from the list.
          // Client-side contribution commands are merged in by the browser half.
          const byName = new Map();
          for (const descriptor of original(undefined)) byName.set(descriptor.name, descriptor);
          const sessionId = url.searchParams.get('session') ?? '';
          if (sessionId !== '' && /^[A-Za-z0-9-]+$/.test(sessionId)) {
            try {
              // commands.list() scopes by the AGENT object (the scoped-layer key),
              // not by the wire sessionId — the Typert gateway resolves the id to
              // the agent before calling. Mirror that here so agent-scoped commands
              // (e.g. /compact, registered inside the code preset composition) show
              // up in the settings page and can be un-hidden.
              const agent = ctx.agents.get(sessionId);
              if (agent !== void 0) {
                for (const descriptor of original(agent)) byName.set(descriptor.name, descriptor);
              }
            } catch (error) {
              ctx.logger.warn('command-setting: per-session catalog failed: ' + String(error?.message ?? error));
            }
          }
          const commands = [...byName.values()].map((descriptor) => ({
            name: descriptor.name,
            description: descriptor.description,
            ...(descriptor.input === void 0 ? {} : { hint: descriptor.input.hint })
          }));
          sendJson(res, 200, { ok: true, commands, hidden: cleanHidden([...hiddenSet]), protected: PROTECTED });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/command-setting/set',
      handler: async (req, res) => {
        try {
          const payload = JSON.parse((await readBody(req)) || '{}');
          const raw = payload.hidden;
          if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
            sendJson(res, 400, { ok: false, code: 'bad-hidden', message: 'hidden must be an array of command names' });
            return;
          }
          for (const entry of raw) {
            if (!COMMAND_NAME.test(entry)) {
              sendJson(res, 400, { ok: false, code: 'bad-name', message: 'invalid command name "' + entry + '"' });
              return;
            }
          }
          if (scope === null) {
            sendJson(res, 503, { ok: false, code: 'settings-unavailable', message: 'settings service is not mounted' });
            return;
          }
          // Protected system commands are dropped before persisting; duplicates
          // collapse (the list is a set semantically).
          await scope.update({ hidden: [...new Set(cleanHidden(raw))] });
          // scope.update refreshes hiddenSet and notifies the browser (the real
          // registration does it via scope.watch; the leaked-reuse substitute
          // does it inside its own update).
          sendJson(res, 200, { ok: true, hidden: cleanHidden([...hiddenSet]) });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    () => {
      service.list = original;
    }
  ];

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    try {
      scope = settings.register(SETTINGS_NS, z.object({ hidden: z.array(z.string()) }), {
        base: { hidden: [...hiddenSet] }
      });
      disposeWatch = scope.watch(() => applyHidden(scope.get()?.hidden));
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
      scope = {
        get: () => settings.get(SETTINGS_NS),
        update: async (patch) => {
          await settings.update(SETTINGS_NS, patch);
          applyHidden(patch?.hidden ?? []);
        }
      };
    }
    hiddenSet = new Set(cleanHidden(scope.get()?.hidden ?? []));
    // 注意：启动时不做归档清理——此刻通常没有 live 会话、也拿不到浏览器贡献
    // 命令面，命令面不完整；清理只在 catalog 读取（客户端已上报贡献面）时惰性
    // 进行，保证有效隐藏（贡献命令/agent 命令）永不被误删。
  });

  ctx.logger.info('command-setting: hiding /' + [...hiddenSet].join(', /') + ' from the command menu (settings namespace ' + SETTINGS_NS + ')');

  return () => {
    for (const dispose of disposers) dispose();
    if (disposeWatch) disposeWatch();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
