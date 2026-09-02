// Smoke test for the tool-both plugin.
// - Node half: exports, preset installer (creation / idempotency / overwrite),
//   status helper, apply() with a fake ctx.
// - Shipped preset: composition carries the both presentation row; preset.yml
//   carries name/description/order (structural checks — zero external deps).
// - Presentation row: exports + Config defaults to both.
// Run: node test/smoke.mjs
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
check('inject is empty (no service dependencies since the settings card was removed)', Array.isArray(inject) && inject.length === 0, String(inject));
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
const presetYml = await readFile(join(PRESET_DIR, 'preset.yml'), 'utf8');
const metaLines = {
  name: presetYml.split('\n').find((l) => l.startsWith('name:')),
  description: presetYml.split('\n').find((l) => l.startsWith('description:')),
  order: presetYml.split('\n').find((l) => /^order: \d+$/.test(l)),
};
check('preset.yml carries name/description/order', Object.values(metaLines).every((v) => typeof v === 'string'), JSON.stringify(metaLines));
check('preset.yml names BOTH模式', (metaLines.name ?? '').includes('BOTH模式'), metaLines.name);

const composition = await readFile(join(PRESET_DIR, 'agent.cordis.yml'), 'utf8');
check('composition carries the both presentation row', composition.includes("- id: tool-presentation") && composition.includes("mode: both"), 'presentation row missing');
check('composition keeps the standard tool rows', composition.includes("tool-bash") && composition.includes("tool-fs") && composition.includes("tool-web"), 'tool rows missing');

// The shipped composition is static, so structural checks stand in for a full
// load: every top-level row (`- id: <id>` at column 0) must either be a group
// or name a plugin, and the presentation row must carry mode: both. A real
// YAML/dialect parse is deliberately avoided — the plugin has no runtime deps,
// and this file ships unchanged with the preset.
const rowBlocks = composition.split(/\n- id: /).slice(1);
const unnamed = rowBlocks.filter((block) => {
  const head = block.split('\n').slice(0, 3).join('\n');
  return !head.includes('group: true') && !head.includes('name:');
});
check('every non-group row names a plugin', unnamed.length === 0, JSON.stringify(unnamed.map((b) => b.split('\n')[0])));
const presRow = rowBlocks.find((b) => b.startsWith('tool-presentation'));
check('tool-presentation row resolves mode: both', presRow !== void 0 && presRow.includes('mode: both') && presRow.includes('@deepseek-ai/dsh-agent-tool-presentation'), JSON.stringify(presRow ?? null));

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

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
