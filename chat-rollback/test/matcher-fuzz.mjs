// dsh-plugin-chat-rollback — 匹配器差分 fuzz：JS 移植（libarchive
// __archive_pathmatch，见 lib/index.js）vs 本机真实 bsdtar 的 --exclude 判定。
// 用插件实际使用的 find -T 管线（不含起始点，与生产一致）；固定种子保证可
// 复现；win32 无 bsdtar 时跳过。防匹配器随改动漂移（0.1.4 曾靠此发现 3 处
// 移植分歧：'*' 递归重入、'[!a]' 末端差异、'/' 前缀处理）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 从 lib/index.js 截取匹配器（与包内实现同源，不为此导出测试专用 API）。
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const start = src.indexOf('const MATCH_MAX_RECURSION');
const end = src.indexOf('/** find 剪枝表达式');
const { matchPath, EXCLUDE_FLAGS } = new Function(src.slice(start, end) + '\nreturn { matchPath, EXCLUDE_FLAGS };')();

/** mulberry32：固定种子 PRNG（确定性，CI 可复现）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('matcher fuzz vs local bsdtar (find -T pipeline)', { skip: process.platform === 'win32' ? 'bsdtar/find unavailable on win32' : false }, async () => {
  const rnd = mulberry32(0xC0FFEE);
  const segNames = ['a', 'b', 'x.txt', '.env', '.hidden', 'build', 'output', 'foo', '222b', 'a1111', 'bar', 'log', 'app.log', 'c-d', 'e_f', 'UPPER'];
  const randSeg = () => segNames[Math.floor(rnd() * segNames.length)];
  const randPath = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, randSeg).join('/');
  const atoms = ['a', 'b', '*', '?', '.', 'x', 'log', 'out*', '[ab]', '[!a]', '[a-c]', '^', '$', '/', 'build', '.*', 't?t'];
  const randPat = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => atoms[Math.floor(rnd() * atoms.length)]).join('');

  const dir = await mkdtemp(join(tmpdir(), 'crb-fuzz-'));
  try {
    const paths = [];
    for (let i = 0; i < 40; i += 1) paths.push('d' + i + '/' + randPath());
    await Promise.all(paths.map(async (p) => {
      await mkdir(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(dir, p), 'x');
    }));
    await mkdir(join(dir, 'emptydir'), { recursive: true });

    let checked = 0;
    for (let t = 0; t < 25; t += 1) {
      const pattern = randPat();
      const findOut = execFileSync('find', ['.', '-mindepth', '1', '-print0'], { cwd: dir, maxBuffer: 1 << 30 });
      const tarOut = execFileSync('tar', ['--null', '--no-recursion', '-C', dir, '--exclude=' + pattern, '-T', '-', '-cf', '-'], { input: findOut, maxBuffer: 1 << 30 });
      const listing = execFileSync('tar', ['-tf', '-'], { input: tarOut, encoding: 'utf8' });
      const archived = new Set(listing.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '').replace(/\/$/, '')));
      for (const p of paths) {
        const js = !!matchPath(pattern, p, EXCLUDE_FLAGS);
        const tarExcluded = !archived.has(p);
        checked += 1;
        assert.strictEqual(js, tarExcluded, `pattern=${JSON.stringify(pattern)} path=${JSON.stringify(p)}`);
      }
    }
    assert.ok(checked >= 1000, `fuzz checked ${checked} pairs (expect >= 1000)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
