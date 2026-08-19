// dsh-plugin-model-arena — node half
// Persists the model-arena switch and serves it to the browser half.
//
// - The switch is a settings namespace ("model-arena"), persisted in
//   ~/.dsh/settings.yaml and hot-reloaded; config.enabled is the composition
//   base (the initial default, e.g. from cordis.patch.yml).
// - Two webServer endpoints serve the browser half:
//     GET  /model-arena/state -> { ok, enabled }
//     POST /model-arena/set   -> body { enabled: boolean } -> { ok, enabled }
// - The arena feature itself is not implemented yet: toggling only persists the
//   flag for future work.
import z from '@deepseek-ai/schemastery';

const name = 'model-arena';
const inject = ['webServer'];
const SETTINGS_NS = 'model-arena';

const Config = z.object({ enabled: z.boolean() });

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
  // Local fallback: the config base (or the schema default) when the settings
  // service is not mounted; kept in sync by scope.watch() once mounted.
  let enabled = typeof config.enabled === 'boolean' ? config.enabled : false;
  let scope = null;

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/model-arena/state',
      handler: (req, res) => {
        const current = scope === null ? enabled : (scope.get().enabled ?? enabled);
        sendJson(res, 200, { ok: true, enabled: current });
      }
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/model-arena/set',
      handler: async (req, res) => {
        try {
          const payload = JSON.parse((await readBody(req)) || '{}');
          const next = payload.enabled;
          if (typeof next !== 'boolean') {
            sendJson(res, 400, { ok: false, code: 'bad-enabled', message: 'enabled must be a boolean' });
            return;
          }
          if (scope === null) {
            sendJson(res, 503, { ok: false, code: 'settings-unavailable', message: 'settings service is not mounted' });
            return;
          }
          await scope.update({ enabled: next });
          // scope.watch() below refreshes the local fallback; the response
          // carries the resolved value (schema/base/user composition).
          sendJson(res, 200, { ok: true, enabled: scope.get().enabled ?? next });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    })
  ];

  ctx.inject(['settings'], (settingsCtx) => {
    scope = settingsCtx.settings.register(SETTINGS_NS, Config, {
      base: { enabled }
    });
    enabled = scope.get().enabled ?? enabled;
    settingsCtx.effect(() => () => {
      scope = null;
    }, 'model-arena: settings scope');
    scope.watch(() => {
      enabled = scope.get().enabled ?? false;
    });
  });

  ctx.logger.info('model-arena: /arena toggle ready (settings namespace ' + SETTINGS_NS + ')');

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
