// Smoke test for the tool-both plugin.
// - Node half: exports, preset installer (creation / idempotency / overwrite),
//   status helper, apply() with a fake ctx.
// - Shipped preset: composition carries the both presentation row; preset.yml
//   is valid YAML with name/description/order.
// - Presentation row: exports + Config defaults to both.
// - Client bundle: syntax check (node --check, browser code is not executed).
// Run: node test/smoke.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';

import { apply, inject, name, installBothPreset, presetInstalled, presetTarget } from '../lib/index.js';
import * as presentation from '../lib/presentation.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG = join(ROOT, '..');
const PRESET_DIR = join(PKG, 'preset', 'both');

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failed += 1;
    console.log(' FAIL ' + label + (detail !== undefined ? '  -> ' + detail : ''));
  }
}

// ── node half exports ───────────────────────────────────────────────────────
console.log('node half:');
check('exports apply/inject/name', ['apply', 'inject', 'name'].every((k) => typeof apply === 'function' && inject !== void 0 && typeof name === 'string'), 'missing export');
check('name is tool-both', name === 'tool-both', name);
check('inject lists webServer + settings', Array.isArray(inject) && inject.includes('webServer') && inject.includes('settings'), String(inject));
check('installer helpers exported', typeof installBothPreset === 'function' && typeof presetInstalled === 'function' && typeof presetTarget === 'function');

// ── preset installer ────────────────────────────────────────────────────────
console.log('preset installer:');
const home = await mkdtemp(join(tmpdir(), 'tool-both-smoke-'));
try {
  const target = presetTarget(home);
  check('target path is <home>/.agent-presets/both', target === join(home, '.agent-presets', 'both'), target);

  const first = await installBothPreset(home);
  check('first install creates both files', first.created.length === 2 && first.skipped.length === 0 && first.failed.length === 0, JSON.stringify(first));
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    const dest = await readFile(join(target, file), 'utf8');
    const source = await readFile(join(PRESET_DIR, file), 'utf8');
    check('installed ' + file + ' matches shipped content', dest === source);
  }

  // Idempotency: a hand-edited file must survive a re-run.
  const marker = '# local edit marker\n';
  await writeFile(join(target, 'preset.yml'), marker + (await readFile(join(target, 'preset.yml'), 'utf8')), 'utf8');
  const second = await installBothPreset(home);
  check('second install skips existing files', second.created.length === 0 && second.skipped.length === 2 && second.failed.length === 0, JSON.stringify(second));
  const after = await readFile(join(target, 'preset.yml'), 'utf8');
  check('hand edit preserved', after.startsWith(marker));

  // overwrite: true restores the shipped content.
  const third = await installBothPreset(home, { overwrite: true });
  check('overwrite rewrites files', third.created.length === 2, JSON.stringify(third));
  const restored = await readFile(join(target, 'preset.yml'), 'utf8');
  check('content restored after overwrite', !restored.startsWith(marker));

  const st = await presetInstalled(home);
  check('presetInstalled true when complete', st.installed === true && st.missing.length === 0, JSON.stringify(st));

  await rm(join(target, 'agent.cordis.yml'));
  const st2 = await presetInstalled(home);
  check('presetInstalled false when a file is missing', st2.installed === false && st2.missing.includes('agent.cordis.yml'), JSON.stringify(st2));
} finally {
  await rm(home, { recursive: true, force: true });
}

// ── shipped preset content ──────────────────────────────────────────────────
console.log('shipped preset:');
const composition = await readFile(join(PRESET_DIR, 'agent.cordis.yml'), 'utf8');
check('composition carries the both presentation row', composition.includes("- id: tool-presentation") && composition.includes("mode: both"), 'presentation row missing');
check('composition keeps the standard tool rows', composition.includes("tool-bash") && composition.includes("tool-fs") && composition.includes("tool-web"), 'tool rows missing');
const metadata = yaml.load(await readFile(join(PRESET_DIR, 'preset.yml'), 'utf8'));
check('preset.yml parses with name/description/order', metadata && typeof metadata.name === 'string' && typeof metadata.description === 'string' && typeof metadata.order === 'number', JSON.stringify(metadata));

// Load the composition under the REAL loader dialect (handles the `!!js`
// expressions plain js-yaml rejects) — the same shape dsh-agent-presets
// health-checks before mounting.
const loaded = yaml.load(composition, { schema: entryListSchema });
const rows = Array.isArray(loaded) ? loaded : loaded?.rows;
check('composition loads under entryListSchema as an entry list', Array.isArray(rows) && rows.length > 0, 'not an entry list');
const rowNames = Array.isArray(rows) ? rows.filter((r) => !r.group).map((r) => r.name) : [];
check('every row names a plugin', rowNames.every((n) => typeof n === 'string' && n.length > 0), JSON.stringify(rowNames.filter((n) => typeof n !== 'string')));
const presRow = Array.isArray(rows) ? rows.find((r) => r.id === 'tool-presentation') : undefined;
check('tool-presentation row resolves mode: both', presRow !== void 0 && presRow.config?.mode === 'both', JSON.stringify(presRow));

// ── presentation row ────────────────────────────────────────────────────────
console.log('presentation row:');
check('exports { Config, apply, inject, name }', ['Config', 'apply', 'inject', 'name'].every((k) => k in presentation), Object.keys(presentation).join(','));
check('Config mentions both (default)', String(presentation.Config).includes('both'), String(presentation.Config));
check('inject lists tools', Array.isArray(presentation.inject) && presentation.inject.includes('tools'), String(presentation.inject));
check('apply runs without throwing (native path)', (() => {
  let threw = null;
  try {
    presentation.apply({ tools: { presentAs: () => {} }, inject: () => {} }, { mode: 'native' });
  } catch (error) {
    threw = error;
  }
  return threw === null;
})());

// ── client bundle syntax ────────────────────────────────────────────────────
console.log('client bundle:');
try {
  execFileSync(process.execPath, ['--check', join(PKG, 'lib', 'client.js')], { stdio: 'pipe' });
  check('client.js passes node --check', true);
} catch (error) {
  check('client.js passes node --check', false, String(error?.stderr ?? error));
}

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
