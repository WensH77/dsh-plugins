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
const inject = ['commands', 'webServer', 'agents'];
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
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(''));
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

  const disposers = [
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/command-setting/catalog',
      handler: (req, res) => {
        // Unfiltered views: the settings page must still list hidden commands
        // so they can be shown again — global registrations always, plus the
        // UNFILTERED agent-scoped registrations of the requesting session
        // (?session=<id>). Hidden agent-scoped commands are filtered from the
        // live directory, so without this union the settings page could not
        // show (or un-hide) them and pruning would drop them from the list.
        // Client-side contribution commands are merged in by the browser half.
        const byName = new Map();
        for (const descriptor of original(undefined)) byName.set(descriptor.name, descriptor);
        const url = new URL(req.url ?? '/', 'http://x');
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
          // Protected system commands are dropped before persisting.
          await scope.update({ hidden: cleanHidden(raw) });
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
  });

  ctx.logger.info('command-setting: hiding /' + [...hiddenSet].join(', /') + ' from the command menu (settings namespace ' + SETTINGS_NS + ')');

  return () => {
    for (const dispose of disposers) dispose();
    if (disposeWatch) disposeWatch();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
