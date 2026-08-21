// dsh-plugin-tool-both — node half
//
// One-click "both" tool presentation for dsh web:
//
// 1) On activation, materializes the `both` agent preset (BOTH模式) under
//    <dshHome>/.agent-presets/both so every deployment can pick it in the
//    preset selector without hand-copying files. Idempotent and
//    non-clobbering: files that already exist (e.g. user edits) are left
//    alone, so re-enabling or updating the plugin never overwrites them.
//
// 2) Two webServer endpoints back a small settings card:
//      GET  /tool-both/status  -> { ok, defaultPreset, installed, path, files }
//      POST /tool-both/install -> re-materialize missing files (same
//                                 non-clobbering semantics; the preset
//                                 discovery re-reads roots per call, so the
//                                 picker sees the result without a restart).
//
// This plugin is HOST-plane: it never calls ctx.tools.presentAs() (that
// requires an agent-scoped context). The actual mode switch is either the
// shipped preset (which uses the built-in `@deepseek-ai/dsh-agent-tool-
// presentation` row with mode: both) or the `./presentation` row this package
// also exports for users who want to add both to their own preset.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

const name = 'tool-both';
const inject = ['webServer', 'settings'];

const PRESET_ID = 'both';
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'];

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
 * 注册 webServer 路由并容忍 re-init 时残留的同路径旧路由（停用/重载后旧
 * handler 已随旧 ctx 失效）：命中 duplicate 先清掉旧路由再重新注册，保证
 * 「停用后重新启用」幂等。
 */
function registerWebRoute(ctx, route) {
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

/** The directory the `both` preset lives in under a harness home. */
export function presetTarget(homeDir) {
  return join(homeDir, '.agent-presets', PRESET_ID);
}

/**
 * Materialize the shipped `both` preset under a harness home. Never clobbers
 * an existing file unless `overwrite` is set, so hand edits survive.
 * @returns {Promise<{presetId: string, path: string, created: string[], skipped: string[], failed: {file: string, error: string}[]}>}
 */
export async function installBothPreset(homeDir, { overwrite = false } = {}) {
  const targetDir = presetTarget(homeDir);
  await mkdir(targetDir, { recursive: true });
  const created = [];
  const skipped = [];
  const failed = [];
  for (const file of PRESET_FILES) {
    const source = new URL(file, new URL('../preset/both/', import.meta.url));
    const dest = join(targetDir, file);
    try {
      let exists = false;
      try {
        await stat(dest);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists && !overwrite) {
        skipped.push(file);
        continue;
      }
      const content = await readFile(source, 'utf8');
      await writeFile(dest, content, 'utf8');
      created.push(file);
    } catch (error) {
      failed.push({ file, error: String(error?.message ?? error) });
    }
  }
  return { presetId: PRESET_ID, path: targetDir, created, skipped, failed };
}

/** Whether every preset file is present (used by the status endpoint). */
export async function presetInstalled(homeDir) {
  const targetDir = presetTarget(homeDir);
  const present = [];
  const missing = [];
  for (const file of PRESET_FILES) {
    try {
      await stat(join(targetDir, file));
      present.push(file);
    } catch {
      missing.push(file);
    }
  }
  return { installed: missing.length === 0, present, missing };
}

function apply(ctx) {
  const logger = ctx.logger ?? { warn: () => {}, info: () => {} };

  // 1) Materialize the preset on activation. Warn-only: a read-only home or a
  //    missing package file must not take the plugin (or the host) down.
  ctx.effect(() => {
    let homeDir;
    try {
      homeDir = dshHomePath();
    } catch (error) {
      logger.warn('tool-both: cannot resolve dsh home: ' + String(error?.message ?? error));
      return undefined;
    }
    installBothPreset(homeDir).then((result) => {
      if (result.failed.length > 0) {
        logger.warn('tool-both: preset install incomplete: ' + result.failed.map((f) => f.file + ' (' + f.error + ')').join(', '));
      } else if (result.created.length > 0) {
        logger.info('tool-both: installed "both" preset at ' + result.path);
      }
    }, (error) => {
      logger.warn('tool-both: preset install failed: ' + String(error?.message ?? error));
    });
    return undefined;
  }, 'tool-both: install preset');

  // 2) Status + install endpoints.
  const readDefaultPreset = () => {
    try {
      const doc = ctx.settings?.get('agent-presets');
      return doc && typeof doc.default === 'string' ? doc.default : null;
    } catch {
      return null;
    }
  };

  registerWebRoute(ctx, {
    kind: 'exact',
    path: '/tool-both/status',
    handler: async (req, res) => {
      let homeDir;
      try {
        homeDir = dshHomePath();
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'no-home', message: String(error?.message ?? error) });
        return;
      }
      const status = await presetInstalled(homeDir);
      sendJson(res, 200, {
        ok: true,
        defaultPreset: readDefaultPreset(),
        path: presetTarget(homeDir),
        ...status
      });
    }
  });

  registerWebRoute(ctx, {
    kind: 'exact',
    path: '/tool-both/install',
    handler: async (req, res) => {
      await readBody(req);
      let homeDir;
      try {
        homeDir = dshHomePath();
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'no-home', message: String(error?.message ?? error) });
        return;
      }
      try {
        const result = await installBothPreset(homeDir);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'install-failed', message: String(error?.message ?? error) });
      }
    }
  });
}

export { apply, inject, name };
export default { apply, inject, name };
