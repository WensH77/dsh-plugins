#!/usr/bin/env node
/**
 * 去重统计与标记（只统计/标记，不删除任何数据）：
 * 对 vectors.bin 里全部记忆向量做全量两两余弦比较，统计 > 阈值的疑似重复；
 * --write 时把配对追加到 duplicates.jsonl（mem_id_a / mem_id_b / cosine / marked_at），
 * 同一对（无序）只写一次。refresh.mjs 的第四步用 --write --json 调用。
 *
 * 用法：
 *   node dedupe-stats.mjs [--threshold 0.95] [--examples 3] [--dir <向量目录>]
 *                         [--write] [--out <duplicates.jsonl>] [--json]
 *
 * 默认只打印报告到 stdout：疑似重复对数、涉及记录数、聚类情况、按 cwd/kind 的分布、例子。
 * 9,044² / 2 ≈ 4,100 万次 1024 维点积，本机约 24 秒。
 * 超过 2 万条时应改为分块或候选剪枝（当前没有做）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const DEFAULT_DIR = path.join(HOME, '.dsh', 'memory-export');
const DIM = 1024;

function parseArgs(argv) {
  const opts = { threshold: 0.95, examples: 3, dir: DEFAULT_DIR, write: false, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--examples') opts.examples = Number(argv[++i]);
    else if (a === '--dir') opts.dir = path.resolve(argv[++i]);
    else if (a === '--write') opts.write = true;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node dedupe-stats.mjs [--threshold 0.95] [--examples 3] [--dir <向量目录>]\n' +
        '                            [--write] [--out <duplicates.jsonl>] [--json]\n',
      );
      process.exit(0);
    } else throw new Error(`未知参数 ${a}`);
  }
  if (!(opts.threshold > -1 && opts.threshold < 1)) throw new Error('--threshold 必须在 (-1, 1) 内');
  if (!Number.isInteger(opts.examples) || opts.examples < 1) throw new Error('--examples 必须是正整数');
  return opts;
}

function truncate(text, n = 180) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

function loadRecords(dir) {
  const metaPath = path.join(dir, 'vectors.meta.jsonl');
  const binPath = path.join(dir, 'vectors.bin');
  const lines = fs
    .readFileSync(metaPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const records = lines.map((line, i) => {
    const m = JSON.parse(line);
    if (!m.mem_id) throw new Error(`vectors.meta.jsonl 第 ${i + 1} 行缺少 mem_id`);
    return {
      offset: Number(m.offset),
      mem_id: m.mem_id,
      id: m.id,
      session_id: m.session_id,
      cwd: m.cwd,
      kind: m.kind,
      seq: m.seq,
      text: m.text,
    };
  });
  for (let i = 0; i < records.length; i++) {
    if (records[i].offset !== i) {
      throw new Error(`vectors.meta.jsonl 第 ${i + 1} 行的 offset=${records[i].offset}，期望 ${i}`);
    }
  }
  const buf = fs.readFileSync(binPath);
  if (buf.length !== records.length * DIM * 4) {
    throw new Error(`vectors.bin 字节数 ${buf.length} ≠ ${records.length}×${DIM * 4}`);
  }
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { records, vectors, bytes: buf.length };
}

function normsOf(vectors, n) {
  const inv = new Float64Array(n);
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * DIM;
    for (let k = 0; k < DIM; k++) {
      const x = vectors[base + k];
      sum += x * x;
    }
    const norm = Math.sqrt(sum);
    if (norm < min) min = norm;
    if (norm > max) max = norm;
    inv[i] = norm > 0 ? 1 / norm : 0;
  }
  return { inv, min, max };
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function pct(part, total) {
  return total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * 把配对追加进 duplicates.jsonl：按无序 mem_id 对去重，已有的不重复写。
 * 只标记不删除；标记过但后来低于阈值的对保留（marked_at 是首次标记时间）。
 */
function writePairs(file, pairs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = new Set();
  let needsNewline = false;
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    needsNewline = content.length > 0 && !content.endsWith('\n');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        if (p.mem_id_a && p.mem_id_b) existing.add([p.mem_id_a, p.mem_id_b].sort().join('\u0000'));
      } catch {
        /* 忽略坏行 */
      }
    }
  }
  const markedAt = new Date().toISOString();
  const lines = [];
  for (const pair of pairs) {
    const [a, b] = [pair.a, pair.b].sort();
    const key = `${a}\u0000${b}`;
    if (existing.has(key)) continue;
    existing.add(key);
    lines.push(JSON.stringify({
      mem_id_a: a,
      mem_id_b: b,
      cosine: Number(pair.cosine.toFixed(6)),
      marked_at: markedAt,
    }));
  }
  if (lines.length > 0) {
    fs.appendFileSync(file, `${needsNewline ? '\n' : ''}${lines.join('\n')}\n`);
  }
  return { file, added: lines.length, total: existing.size };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = performance.now();
  process.stderr.write(`[dedupe] 读取 ${opts.dir}/vectors.*\n`);
  const { records, vectors, bytes } = loadRecords(opts.dir);
  const n = records.length;
  process.stderr.write(`[dedupe] ${n} 条 × ${DIM} 维，${(bytes / 1024 ** 2).toFixed(1)} MB\n`);

  const { inv, min: normMin, max: normMax } = normsOf(vectors, n);
  process.stderr.write(
    `[dedupe] norm 范围 ${normMin.toFixed(6)}..${normMax.toFixed(6)}，开始 ${((n * (n - 1)) / 2).toLocaleString()} 次点积\n`,
  );

  const threshold = opts.threshold;
  const pairs = [];
  let pairCount = 0;
  let dotMax = -Infinity;
  let simMax = -Infinity;
  const bands = { '>0.99': 0, '0.97–0.99': 0, '0.95–0.97': 0, '0.90–0.95': 0, '<0.90': 0 };
  const pairsByCwd = new Map();
  const pairsByKind = new Map();
  const degree = new Uint32Array(n);
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const topPairs = [];
  const maxKeep = Math.max(opts.examples, 20);

  for (let i = 0; i < n; i++) {
    const baseI = i * DIM;
    const invI = inv[i];
    for (let j = i + 1; j < n; j++) {
      const baseJ = j * DIM;
      let dot = 0;
      for (let k = 0; k < DIM; k++) dot += vectors[baseI + k] * vectors[baseJ + k];
      if (dot > dotMax) dotMax = dot;
      const sim = dot * invI * inv[j];
      if (sim > simMax) simMax = sim;
      if (sim > 0.99) bands['>0.99']++;
      else if (sim > 0.97) bands['0.97–0.99']++;
      else if (sim > 0.95) bands['0.95–0.97']++;
      else if (sim > 0.9) bands['0.90–0.95']++;
      else bands['<0.90']++;

      // 例子始终保留余弦最高的若干对：即使没有 pair 超过阈值，也能给出“最接近”的具体素材。
      if (topPairs.length < maxKeep || sim > topPairs[topPairs.length - 1].sim) {
        topPairs.push({ sim, i, j });
        topPairs.sort((x, y) => y.sim - x.sim);
        if (topPairs.length > maxKeep) topPairs.pop();
      }

      if (sim < threshold) continue;

      pairCount++;
      degree[i]++;
      degree[j]++;
      union(i, j);
      pairs.push({ a: records[i].mem_id, b: records[j].mem_id, cosine: sim });

      const a = records[i];
      const b = records[j];
      const cwdKey = a.cwd === b.cwd ? a.cwd ?? '(null)' : `${a.cwd ?? '(null)'} ↔ ${b.cwd ?? '(null)'}`;
      pairsByCwd.set(cwdKey, (pairsByCwd.get(cwdKey) ?? 0) + 1);
      const kindKey = [a.kind ?? '(null)', b.kind ?? '(null)'].sort().join(' ↔ ');
      pairsByKind.set(kindKey, (pairsByKind.get(kindKey) ?? 0) + 1);

    }
  }

  const elapsedMs = performance.now() - started;

  // 聚类：只统计 size>=2 的连通分量
  const rootSize = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    rootSize.set(r, (rootSize.get(r) ?? 0) + 1);
  }
  const clusters = [...rootSize.values()].filter((s) => s >= 2);
  const clusteredRecords = clusters.reduce((a, b) => a + b, 0);
  const largestCluster = clusters.length ? Math.max(...clusters) : 0;

  const involvedCwd = new Map();
  const involvedKind = new Map();
  let involved = 0;
  for (let i = 0; i < n; i++) {
    if (degree[i] === 0) continue;
    involved++;
    const cwd = records[i].cwd ?? '(null)';
    const kind = records[i].kind ?? '(null)';
    involvedCwd.set(cwd, (involvedCwd.get(cwd) ?? 0) + 1);
    involvedKind.set(kind, (involvedKind.get(kind) ?? 0) + 1);
  }

  let written = null;
  if (opts.write) {
    const file = opts.out ?? path.join(opts.dir, 'duplicates.jsonl');
    written = writePairs(file, pairs);
    process.stderr.write(
      `[dedupe] 写入 ${written.file}：本次新增 ${written.added} 对，文件共 ${written.total} 对\n`,
    );
  }

  const summary = {
    ok: true,
    threshold,
    records: n,
    pairs: pairCount,
    newPairs: written?.added ?? 0,
    totalMarkedPairs: written?.total ?? null,
    duplicatesFile: written?.file ?? null,
    involved,
    clusters: clusters.length,
    largestCluster,
    simMax,
    dotMax,
    elapsedMs: Math.round(elapsedMs),
    writtenAt: new Date().toISOString(),
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  const w = (s = '') => process.stdout.write(`${s}\n`);
  w(`去重统计（只统计/标记，不删除）  threshold=cos>=${threshold}`);
  w(`记录数: ${n}  向量: ${DIM} 维  ${(bytes / 1024 ** 2).toFixed(1)} MB`);
  w(`两两比较: ${((n * (n - 1)) / 2).toLocaleString()} 次  耗时: ${(elapsedMs / 1000).toFixed(1)}s`);
  w(`余弦最大值: ${simMax.toFixed(6)}  点积最大值: ${dotMax.toFixed(6)}`);
  w(
    `分档: >0.99 ${bands['>0.99'].toLocaleString()}  ` +
      `0.97–0.99 ${bands['0.97–0.99'].toLocaleString()}  ` +
      `0.95–0.97 ${bands['0.95–0.97'].toLocaleString()}  ` +
      `0.90–0.95 ${bands['0.90–0.95'].toLocaleString()}`,
  );
  w('');
  w(`疑似重复对: ${pairCount.toLocaleString()} 对（${pct(pairCount, ((n * (n - 1)) / 2))} 的 pair）` +
    `${written ? `；本次新写 ${written.added} 对，${written.file} 共 ${written.total} 对` : ''}`);
  w(`涉及记录: ${involved.toLocaleString()} / ${n}（${pct(involved, n)}）`);
  w(
    `重复簇: ${clusters.length.toLocaleString()} 个（size≥2），覆盖 ${clusteredRecords.toLocaleString()} 条，` +
      `最大簇 ${largestCluster} 条`,
  );
  w('');

  const printMap = (title, map, limit, denominator) => {
    w(title);
    const entries = topEntries(map, limit);
    if (entries.length === 0) w('  （无）');
    for (const [key, count] of entries) {
      w(`  ${String(count).padStart(6)}  ${pct(count, denominator).padStart(6)}  ${key}`);
    }
    w('');
  };
  printMap('按 cwd（重复对，top 10）:', pairsByCwd, 10, pairCount);
  printMap('按 kind 组合（重复对，top 10）:', pairsByKind, 10, pairCount);
  printMap('涉及记录按 cwd（top 10）:', involvedCwd, 10, involved);
  printMap('涉及记录按 kind:', involvedKind, 20, involved);

  w(
    pairCount > 0
      ? `例子（余弦最高的 ${opts.examples} 对）:`
      : `例子（没有 pair 超过阈值；下面是余弦最高的 ${opts.examples} 对，均未超过 ${threshold}）:`,
  );
  for (let e = 0; e < Math.min(opts.examples, topPairs.length); e++) {
    const { sim, i, j } = topPairs[e];
    const a = records[i];
    const b = records[j];
    w('');
    w(
      `--- 例子 ${e + 1}: cos=${sim.toFixed(6)}（${sim >= threshold ? '达到' : '未达到'}阈值） ` +
        ` mem_id ${a.mem_id} ↔ ${b.mem_id}`,
    );
    w(`  A: [${a.kind}] ${a.cwd}`);
    w(`     session=${a.session_id} seq=${a.seq} id=${a.id}`);
    w(`     ${truncate(a.text)}`);
    w(`  B: [${b.kind}] ${b.cwd}`);
    w(`     session=${b.session_id} seq=${b.seq} id=${b.id}`);
    w(`     ${truncate(b.text)}`);
  }
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[dedupe] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  }
}
