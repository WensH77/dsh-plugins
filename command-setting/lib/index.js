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

function apply(ctx, config = {}) {
  let hiddenSet = new Set(cleanHidden(Array.isArray(config.hidden) ? config.hidden : DEFAULT_HIDDEN));
  let scope = null;

  // Instance-level shadow: the Typert gateway resolves RPC methods on the live
  // service instance (Reflect.get(receiver, implementation)), so this own
  // property is exactly what remote.commands.list ends up calling.
  const service = ctx.commands;
  const original = service.list.bind(service);
  service.list = (agent) => original(agent).filter((descriptor) => !hiddenSet.has(descriptor.name));

  const disposers = [
    ctx.webServer.register({
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
    ctx.webServer.register({
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
          // scope.watch() below refreshes hiddenSet and notifies the browser.
          sendJson(res, 200, { ok: true, hidden: cleanHidden([...hiddenSet]) });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    })
  ];

  ctx.inject(['settings'], (settingsCtx) => {
    scope = settingsCtx.settings.register(SETTINGS_NS, z.object({ hidden: z.array(z.string()) }), {
      base: { hidden: [...hiddenSet] }
    });
    hiddenSet = new Set(cleanHidden(scope.get().hidden ?? []));
    settingsCtx.effect(() => () => {
      scope = null;
    }, 'command-setting: settings scope');
    scope.watch(() => {
      hiddenSet = new Set(cleanHidden(scope.get().hidden ?? []));
      try {
        ctx.commands.notifyChange();
      } catch (error) {
        ctx.logger.warn('command-setting: notifyChange failed: ' + String(error?.message ?? error));
      }
    });
  });

  ctx.logger.info('command-setting: hiding /' + [...hiddenSet].join(', /') + ' from the command menu (settings namespace ' + SETTINGS_NS + ')');

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
