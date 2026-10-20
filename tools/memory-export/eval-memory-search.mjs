#!/usr/bin/env node
/**
 * 检索评测：eval-set.json（45 条：paraphrase 30 / keyword 10 / mixed 5）上对比多种组合。
 *
 * 用法：
 *   node eval-memory-search.mjs [--db <file>] [--set <file>] [--repeat 20]
 *                               [--k 5] [--configs A,B,C,D,E,F,S1,S5,S6]
 *                               [--compare-db <file>] [--validate-only] [--no-latency]
 *
 * --compare-db 用同一套评测集把 --db（baseline）与指定库（如富化库）逐条对照，
 * 只支持不触发查询扩展的组合（S1/S2/S5/S6 等）；报告两组指标、paraphrase 与
 * keyword 的逐条名次，以及两边延迟 p50。
 *
 * 组合（A-F 为原有六种；S1/S5/S6 为混合查询路由实验）：
 *   A  仅关键词 · phrase（旧关键词路）
 *   B  仅关键词 · tokens（新关键词路）
 *   C  仅向量
 *   C2 仅向量 + --expand-target vector（变体各自 KNN，同 offset 取余弦最大）
 *   D  s2 路由 + 新关键词路（旧二分类路由基线）
 *   E  仅向量 + --expand（对照：扩展只服务关键词路，预期与 C 相同）
 *   F  s2 路由 + 新关键词路 + --expand
 *   S1 s1 等权 RRF + 新关键词路（对照组）
 *   S5 s5 三类路由 + 新关键词路（mixed → 等权 RRF）
 *   S6 s6 三类路由 + 新关键词路（mixed → 向量优先）
 *   F2 s6 + 新关键词路 + --expand-target vector
 * 额外诊断：
 *   G  仅关键词 · tokens + --expand（隔离扩展对关键词路的实际影响）
 *   C3 仅向量 + --expand-target both（按构造与 C2 等价，作一致性检查）
 *   F3 s6 + 新关键词路 + --expand-target both
 *
 * 指标（k=5）：hit@5 / P@5 / MRR@5 / MRR@50，排名深度 200。
 * 延迟：每查询预热 1 次，再跑 --repeat 次（k=5、routeLimit=50）；扩展 API 的
 * 往返延迟单独统计（缓存命中不算），token 用量与成本单独汇总。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  openSearchDb,
  initModel,
  search,
  classifyQuery,
  keywordSearch,
  extractKeywordTokens,
} from './mem-search.mjs';
import { expansionStats, estimateExpansionCostUsd, getCachedCallStats } from './query-expand.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DEFAULT_DB = path.join(HOME, '.dsh', 'memory-export', 'memory.db');
const DEFAULT_SET = path.join(HERE, 'eval-set.json');
const RANK_DEPTH = 200;

const CONFIGS = [
  {
    id: 'A',
    label: 'A 仅关键词·phrase',
    options: { strategy: 's1', vector: false, keywordMode: 'phrase' },
  },
  {
    id: 'B',
    label: 'B 仅关键词·tokens',
    options: { strategy: 's1', vector: false, keywordMode: 'tokens' },
  },
  { id: 'C', label: 'C 仅向量', options: { strategy: 's1', keyword: false } },
  {
    id: 'C2',
    label: 'C2 仅向量+扩展向量',
    options: { strategy: 's1', keyword: false, expandTarget: 'vector' },
  },
  {
    id: 'D',
    label: 'D s2+tokens',
    options: { strategy: 's2', keywordMode: 'tokens' },
  },
  {
    id: 'E',
    label: 'E 仅向量+expand',
    options: { strategy: 's1', keyword: false, expand: true },
  },
  {
    id: 'F',
    label: 'F s2+tokens+expand',
    options: { strategy: 's2', keywordMode: 'tokens', expand: true },
  },
  {
    id: 'S1',
    label: 'S1 s1+tokens',
    options: { strategy: 's1', keywordMode: 'tokens' },
  },
  {
    id: 'S5',
    label: 'S5 s5+tokens',
    options: { strategy: 's5', keywordMode: 'tokens' },
  },
  {
    id: 'S6',
    label: 'S6 s6+tokens',
    options: { strategy: 's6', keywordMode: 'tokens' },
  },
  {
    id: 'F2',
    label: 'F2 s6+tokens+扩展向量',
    options: { strategy: 's6', keywordMode: 'tokens', expandTarget: 'vector' },
  },
];

const DIAG_CONFIGS = [
  {
    id: 'P',
    label: 'P s2+phrase（旧默认）',
    options: { strategy: 's2', keywordMode: 'phrase' },
    extra: true,
  },
  {
    id: 'G',
    label: 'G 仅关键词·tokens+expand',
    options: { strategy: 's1', vector: false, keywordMode: 'tokens', expand: true },
    extra: true,
  },
  {
    id: 'C3',
    label: 'C3 仅向量+扩展both',
    options: { strategy: 's1', keyword: false, expandTarget: 'both' },
    extra: true,
  },
  {
    id: 'F3',
    label: 'F3 s6+tokens+扩展both',
    options: { strategy: 's6', keywordMode: 'tokens', expandTarget: 'both' },
    extra: true,
  },
];

const ALL_CONFIGS = [...CONFIGS, ...DIAG_CONFIGS];
const SUBSETS = ['paraphrase', 'keyword', 'mixed'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const MIN_CWDS = 12;
const MIN_OUTSIDE_INTRANET_AIO = 10;

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    set: DEFAULT_SET,
    repeat: 20,
    k: 5,
    validateOnly: false,
    latency: true,
    configs: null,
    compareDb: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = path.resolve(argv[++i]);
    else if (a === '--compare-db') opts.compareDb = path.resolve(argv[++i]);
    else if (a === '--set') opts.set = path.resolve(argv[++i]);
    else if (a === '--repeat') opts.repeat = Number(argv[++i]);
    else if (a === '--k') opts.k = Number(argv[++i]);
    else if (a === '--validate-only') opts.validateOnly = true;
    else if (a === '--no-latency') opts.latency = false;
    else if (a === '--configs') {
      opts.configs = argv[++i]
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node eval-memory-search.mjs [--db <file>] [--set <file>] [--repeat 20] [--k 5]\n' +
          '                                [--configs A,B,C,C2,C3,D,E,F,F2,F3,G,S1,S5,S6] [--no-latency] [--validate-only]\n' +
          '                                [--compare-db <file>]  # 与 --db 逐条对照（不支持扩展组合）\n',
      );
      process.exit(0);
    } else throw new Error(`未知参数 ${a}`);
  }
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat 必须是正整数');
  if (!Number.isInteger(opts.k) || opts.k < 1) throw new Error('--k 必须是正整数');
  if (opts.configs) {
    const known = new Set(ALL_CONFIGS.map((c) => c.id));
    for (const id of opts.configs) {
      if (!known.has(id)) throw new Error(`未知组合 ${id}（可选 ${[...known].join(',')}）`);
    }
  }
  return opts;
}

/* --------------------- 评测集目标解析（稳定标识） ------------------------- */

// target 的稳定标识：session_id + seq + kind + statement_hash。
// offset 是位置主键，记忆一变就整体平移，只作缓存/兼容字段。
const STABLE_TARGET_FIELDS = ['session_id', 'seq', 'kind', 'statement_hash'];

// 归一化：所有空白（含全角空格）折叠成单个半角空格，去首尾空白。不改变大小写。
function normalizeStatement(statement) {
  return String(statement).replace(/\s+/g, ' ').trim();
}

function statementHash(statement) {
  return createHash('sha256').update(normalizeStatement(statement), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 按稳定标识在当前库里解析每个 target 的 offset。
 * 不修改 set；调用方拿到 rows 后调 applyTargetOffsets()。
 * - 稳定标识齐全：只看 session_id+seq+kind 命中的记忆，再按 statement_hash 唯一确定；
 *   解析不到就报「目标已失效」并带上完整标识，不静默跳过。
 * - 稳定标识全缺：退回 offset 兜底。
 * - 只缺一部分：报错，不允许半新半旧。
 */
function resolveTargetOffsets(db, set) {
  const errors = [];
  const rows = [];
  let stable = 0;
  let fallback = 0;
  let drifted = 0;
  const byKey = db.prepare(
    'select offset, statement from memories where session_id = ? and seq = ? and kind = ?',
  );
  const byOffset = db.prepare('select offset from memories where offset = ?');
  for (const q of set.queries ?? []) {
    (q.targets ?? []).forEach((t, idx) => {
      const pos = idx + 1;
      const missing = STABLE_TARGET_FIELDS.filter((f) => t[f] == null);
      if (missing.length === 0) {
        const candidates = byKey.all(t.session_id, t.seq, t.kind);
        const hits = candidates.filter((r) => statementHash(r.statement) === t.statement_hash);
        if (hits.length === 0) {
          const detail = candidates.length
            ? `同键下 ${candidates.length} 条记忆的 statement_hash 均不匹配`
            : '同键下没有记忆';
          errors.push(
            `${q.id}: target#${pos} 目标已失效（session_id=${t.session_id} seq=${t.seq} ` +
              `kind=${t.kind} statement_hash=${t.statement_hash}；${detail}）`,
          );
          return;
        }
        if (hits.length > 1) {
          errors.push(
            `${q.id}: target#${pos} 稳定标识命中 ${hits.length} 条记忆（offset ` +
              `${hits.map((h) => h.offset).join(',')}），statement_hash 不足以区分`,
          );
          return;
        }
        if (t.offset != null && t.offset !== hits[0].offset) drifted++;
        rows.push({ ref: t, qid: q.id, pos, from: t.offset ?? null, to: hits[0].offset, mode: 'stable' });
        stable++;
        return;
      }
      if (missing.length < STABLE_TARGET_FIELDS.length) {
        errors.push(
          `${q.id}: target#${pos} 稳定标识不完整（缺 ${missing.join(', ')}），补齐后重跑，不退回 offset`,
        );
        return;
      }
      if (t.offset == null) {
        errors.push(`${q.id}: target#${pos} 既无稳定标识也无 offset`);
        return;
      }
      if (!byOffset.get(t.offset)) {
        errors.push(
          `${q.id}: target#${pos} offset ${t.offset} 在 memories 表里不存在，且无稳定标识可回退`,
        );
        return;
      }
      rows.push({ ref: t, qid: q.id, pos, from: t.offset, to: t.offset, mode: 'offset' });
      fallback++;
    });
  }
  return { errors, rows, stable, fallback, drifted };
}

function applyTargetOffsets(resolution) {
  for (const row of resolution.rows) row.ref.offset = row.to;
}

function printTargetResolution(resolution, set) {
  const total = (set.queries ?? []).reduce((n, q) => n + (q.targets?.length ?? 0), 0);
  process.stdout.write(
    `目标解析: ${total} 条 target，稳定标识解析 ${resolution.stable} 条` +
      `，offset 兜底 ${resolution.fallback} 条，offset 缓存漂移 ${resolution.drifted} 条\n`,
  );
}

/* ----------------------------- 评测集校验 -------------------------------- */

function ngrams(s, n = 3) {
  const out = new Set();
  const arr = Array.from(String(s).toLowerCase());
  for (let i = 0; i + n <= arr.length; i++) out.add(arr.slice(i, i + n).join(''));
  return out;
}

function asciiTokens(s) {
  return [...String(s).matchAll(/[A-Za-z][A-Za-z0-9_.\-/]*/g)]
    .map((m) => m[0])
    .filter((t) => t.length >= 3);
}

function normalizeQuery(query) {
  return String(query).replace(/\s+/g, ' ').trim().toLowerCase();
}

function validateSet(db, set) {
  const errors = [];
  const stats = {
    types: {},
    kinds: {},
    cwds: {},
    difficulties: {},
    outsideIntranetAio: 0,
  };
  const seenIds = new Set();
  const seenQueries = new Map();
  for (const q of set.queries) {
    for (const field of ['id', 'query', 'type', 'targets', 'note']) {
      if (q[field] == null) errors.push(`${q.id ?? '?'}: 缺字段 ${field}`);
    }
    if (q.id != null) {
      if (seenIds.has(q.id)) errors.push(`${q.id}: id 重复`);
      seenIds.add(q.id);
    }
    const qkey = normalizeQuery(q.query ?? '');
    if (seenQueries.has(qkey)) {
      errors.push(`${q.id}: query 与 ${seenQueries.get(qkey)} 重复（${q.query}）`);
    } else {
      seenQueries.set(qkey, q.id ?? '?');
    }
    if (!SUBSETS.includes(q.type)) errors.push(`${q.id}: 未知 type ${q.type}`);
    if (q.type === 'paraphrase') {
      if (!DIFFICULTIES.includes(q.difficulty)) {
        errors.push(`${q.id}: paraphrase 缺少合法 difficulty（easy|medium|hard）`);
      } else {
        stats.difficulties[q.difficulty] = (stats.difficulties[q.difficulty] ?? 0) + 1;
      }
    }
    if (!Array.isArray(q.targets) || q.targets.length === 0) {
      errors.push(`${q.id}: targets 为空`);
      continue;
    }
    if (q.type === 'paraphrase' && q.targets.length > 3) {
      errors.push(`${q.id}: paraphrase targets 超过 3 条`);
    }
    stats.types[q.type] = (stats.types[q.type] ?? 0) + 1;
    const targets = [];
    for (const t of q.targets) {
      const row = db
        .prepare('select offset, cwd, kind, statement from memories where offset = ?')
        .get(t.offset);
      if (!row) {
        errors.push(`${q.id}: target offset ${t.offset} 不存在`);
        continue;
      }
      targets.push(row);
    }
    if (targets.length === 0) continue;
    const main = targets[0];
    stats.kinds[main.kind] = (stats.kinds[main.kind] ?? 0) + 1;
    stats.cwds[main.cwd] = (stats.cwds[main.cwd] ?? 0) + 1;
    if (!String(main.cwd).startsWith('/Users/wens.huang/Documents/intranet-aio')) {
      stats.outsideIntranetAio++;
    }

    if (q.type === 'paraphrase') {
      const qg = ngrams(q.query);
      for (const t of targets) {
        const shared = [...qg].filter((g) => ngrams(t.statement).has(g));
        if (shared.length) {
          errors.push(
            `${q.id}: 与 target ${t.offset} 共享 3 字片段 ${JSON.stringify(shared.slice(0, 8))}`,
          );
        }
      }
    }
    if (q.type === 'keyword' || q.type === 'mixed') {
      const tokens = asciiTokens(q.query);
      if (tokens.length === 0) errors.push(`${q.id}: ${q.type} 查询缺少 ASCII token`);
      if (q.type === 'keyword') {
        // 裸 token 查询：target 必须能被新关键词路（token 模式）召回到。
        const kwOffsets = new Set(
          keywordSearch(db, q.query, 10000, { mode: 'tokens' }).rows.map((r) => r.offset),
        );
        for (const t of targets) {
          if (!kwOffsets.has(t.offset)) {
            errors.push(`${q.id}: target ${t.offset} 不在关键词路（tokens）候选里`);
          }
        }
      } else {
        for (const t of targets) {
          const st = String(t.statement).toLowerCase();
          if (!tokens.some((tk) => st.includes(tk.toLowerCase()))) {
            errors.push(`${q.id}: target ${t.offset} 不含查询里的精确 token`);
          }
        }
      }
    }
  }
  // 覆盖门槛：整份评测集必须达到至少 12 个不同 cwd、5 种 kind、10 条非 intranet-aio 主目标。
  const cwdCount = Object.keys(stats.cwds).length;
  if (cwdCount < MIN_CWDS) {
    errors.push(`覆盖不足: 不同 cwd ${cwdCount} 个 < ${MIN_CWDS}`);
  }
  for (const kind of ['decision', 'fact', 'open_question', 'pitfall', 'preference']) {
    if (!stats.kinds[kind]) errors.push(`覆盖不足: kind ${kind} 未出现`);
  }
  if (stats.outsideIntranetAio < MIN_OUTSIDE_INTRANET_AIO) {
    errors.push(
      `覆盖不足: intranet-aio 之外的主目标 ${stats.outsideIntranetAio} 条 < ${MIN_OUTSIDE_INTRANET_AIO}`,
    );
  }
  return { errors, stats };
}

function printCoverage(stats, total) {
  const kinds = Object.entries(stats.kinds)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  const cwds = Object.entries(stats.cwds)
    .map(([k, v]) => `${k.split('/').slice(-1)[0]} ${v}`)
    .join(' / ');
  const diffs = Object.entries(stats.difficulties)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  const cwdCount = Object.keys(stats.cwds).length;
  process.stdout.write(
    `覆盖: 主目标 kind {${kinds}}；cwd ${cwdCount} 个 {${cwds}}；` +
      `intranet-aio 之外 ${stats.outsideIntranetAio}/${total}；paraphrase 难度 {${diffs}}\n`,
  );
  process.stdout.write(
    `覆盖门槛: cwd ${cwdCount}/${MIN_CWDS}  ${cwdCount >= MIN_CWDS ? 'OK' : 'FAIL'}；` +
      `kind ${Object.keys(stats.kinds).length}/5；` +
      `非 intranet-aio ${stats.outsideIntranetAio}/${MIN_OUTSIDE_INTRANET_AIO} ` +
      `${stats.outsideIntranetAio >= MIN_OUTSIDE_INTRANET_AIO ? 'OK' : 'FAIL'}\n`,
  );
}

/* -------------------------------- 指标 ----------------------------------- */

function p50(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function fmtMs(n) {
  if (n == null) return '-';
  return n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(2) : n.toFixed(1);
}

function truncate(text, n) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function rpad(s, n) {
  return String(s).padStart(n);
}

async function rankQuery(searcher, spec, config) {
  const out = await search(searcher, spec.query, {
    ...config.options,
    k: RANK_DEPTH,
    routeLimit: RANK_DEPTH,
  });
  const targetOffsets = new Set(spec.targets.map((t) => t.offset));
  let rank = null;
  for (let i = 0; i < out.results.length; i++) {
    if (targetOffsets.has(out.results[i].offset)) {
      rank = i + 1;
      break;
    }
  }
  const hitsInTop5 = out.results
    .slice(0, 5)
    .filter((r) => targetOffsets.has(r.offset)).length;
  return { rank, hitsInTop5, out };
}

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, hit5: 0, p5: 0, mrr5: 0, mrr50: 0 };
  let hit5 = 0;
  let p5 = 0;
  let mrr5 = 0;
  let mrr50 = 0;
  for (const { rank, hitsInTop5 } of rows) {
    if (hitsInTop5 > 0) hit5++;
    p5 += hitsInTop5 / 5;
    if (rank != null && rank <= 5) mrr5 += 1 / rank;
    if (rank != null && rank <= 50) mrr50 += 1 / rank;
  }
  return {
    n,
    hit5: hit5 / n,
    p5: p5 / n,
    mrr5: mrr5 / n,
    mrr50: mrr50 / n,
  };
}

function metricCell(m) {
  return `${m.hit5.toFixed(2)} ${m.p5.toFixed(2)} ${m.mrr5.toFixed(2)}`;
}

function buildConfigs(selected) {
  if (!selected) return ALL_CONFIGS;
  return ALL_CONFIGS.filter((c) => selected.includes(c.id));
}

/* ------------------------- baseline vs 对照库 ----------------------------- */

async function runCompare(opts, set, configs) {
  if (!fs.existsSync(opts.compareDb)) throw new Error(`对照库不存在: ${opts.compareDb}`);
  const compareConfigs = configs.filter(
    (c) => !c.options.expand && c.options.expandTarget == null,
  );
  if (compareConfigs.length === 0) {
    throw new Error('--compare-db 只支持不触发查询扩展的组合（如 S1/S5/S6）');
  }
  if (compareConfigs.length !== configs.length) {
    process.stdout.write(
      `--compare-db: 跳过会触发查询扩展的组合 ${configs
        .filter((c) => !compareConfigs.includes(c))
        .map((c) => c.id)
        .join(',')}（不调用云端 API）\n`,
    );
  }

  const sides = [
    { key: 'baseline', label: 'baseline', dbPath: opts.db },
    { key: 'enriched', label: '富化', dbPath: opts.compareDb },
  ];
  for (const side of sides) side.db = openSearchDb(side.dbPath);

  process.stdout.write(`baseline db: ${opts.db}  ${(fs.statSync(opts.db).size / 1024 ** 2).toFixed(1)} MB\n`);
  process.stdout.write(
    `富化库     : ${opts.compareDb}  ${(fs.statSync(opts.compareDb).size / 1024 ** 2).toFixed(1)} MB\n`,
  );
  process.stdout.write(
    `eval set: ${opts.set}  查询 ${set.queries.length} 条  repeat=${opts.repeat}  k=${opts.k}\n`,
  );
  process.stdout.write(`configs: ${compareConfigs.map((c) => c.id).join(', ')}\n`);

  let invalid = false;
  for (const side of sides) {
    // baseline 的解析结果写回 set（两边沿用同一组 offset，与旧行为一致）；
    // 富化库只解析校验，不改 set，避免把它的 offset 套到 baseline 上。
    const resolution = resolveTargetOffsets(side.db, set);
    if (side.key === 'baseline') {
      applyTargetOffsets(resolution);
      printTargetResolution(resolution, set);
    } else {
      const moved = resolution.rows.filter((r) => r.to !== r.ref.offset).length;
      if (moved) {
        process.stdout.write(
          `${side.label} 目标解析: ${moved} 条 target 的 offset 与 baseline 不同，对照继续沿用 baseline 的 offset\n`,
        );
      }
    }
    if (resolution.errors.length) {
      invalid = true;
      process.stdout.write(`\n${side.label} 目标解析失败（${resolution.errors.length} 条）：\n`);
      for (const e of resolution.errors) process.stdout.write(`  - ${e}\n`);
    }
    const { errors, stats } = validateSet(side.db, set);
    printCoverage(stats, set.queries.length);
    if (errors.length) {
      invalid = true;
      process.stdout.write(`\n${side.label} 评测集校验失败（${errors.length} 条）：\n`);
      for (const e of errors) process.stdout.write(`  - ${e}\n`);
    } else {
      process.stdout.write(`${side.label} 评测集校验: 通过\n`);
    }
  }
  if (invalid) {
    for (const side of sides) side.db.close();
    process.exitCode = 1;
    return;
  }

  const model = await initModel();
  for (const side of sides) side.searcher = { db: side.db, extractor: model.extractor };
  process.stdout.write(`[cold-start] model load ${(model.initMs / 1000).toFixed(2)}s\n`);

  // 逐条排名（深度 RANK_DEPTH）；同一进程、同一模型、同一评测集。
  const ranks = new Map();
  for (const side of sides) {
    for (const cfg of compareConfigs) {
      const m = new Map();
      for (const spec of set.queries) {
        m.set(spec.id, await rankQuery(side.searcher, spec, cfg));
      }
      ranks.set(`${side.key}:${cfg.id}`, m);
    }
  }

  const getRank = (sideKey, cfgId, queryId) =>
    ranks.get(`${sideKey}:${cfgId}`).get(queryId)?.rank ?? null;
  const getHits = (sideKey, cfgId, queryId) =>
    ranks.get(`${sideKey}:${cfgId}`).get(queryId)?.hitsInTop5 ?? 0;

  const metrics = new Map();
  const computeMetrics = (sideKey, cfgId) => {
    const per = {};
    for (const subset of SUBSETS) {
      const rows = set.queries
        .filter((q) => q.type === subset)
        .map((q) => ({ rank: getRank(sideKey, cfgId, q.id), hitsInTop5: getHits(sideKey, cfgId, q.id) }));
      per[subset] = summarize(rows);
    }
    per.total = summarize(
      set.queries.map((q) => ({
        rank: getRank(sideKey, cfgId, q.id),
        hitsInTop5: getHits(sideKey, cfgId, q.id),
      })),
    );
    return per;
  };
  for (const cfg of compareConfigs) {
    for (const side of sides) metrics.set(`${side.key}:${cfg.id}`, computeMetrics(side.key, cfg.id));
  }

  process.stdout.write(
    `\n===== baseline vs 富化（k=${opts.k}；每格 hit@5 / P@5 / MRR@5） =====\n`,
  );
  const subsetCounts = Object.fromEntries(
    SUBSETS.map((s) => [s, set.queries.filter((q) => q.type === s).length]),
  );
  process.stdout.write(
    `${pad('组合', 20)} | ${pad(`paraphrase(${subsetCounts.paraphrase})`, 21)} | ` +
      `${pad(`keyword(${subsetCounts.keyword})`, 21)} | ` +
      `${pad(`mixed(${subsetCounts.mixed})`, 21)} | ` +
      `${pad(`total(${set.queries.length})`, 21)} | MRR@50\n`,
  );
  for (const cfg of compareConfigs) {
    for (const side of sides) {
      const m = metrics.get(`${side.key}:${cfg.id}`);
      process.stdout.write(
        `${pad(`${side.label}·${cfg.id}`, 20)} | ${pad(metricCell(m.paraphrase), 21)} | ` +
          `${pad(metricCell(m.keyword), 21)} | ${pad(metricCell(m.mixed), 21)} | ` +
          `${pad(metricCell(m.total), 21)} | ${m.total.mrr50.toFixed(3)}\n`,
      );
    }
  }

  for (const cfg of compareConfigs) {
    const mBase = metrics.get(`baseline:${cfg.id}`);
    const mExp = metrics.get(`enriched:${cfg.id}`);

    process.stdout.write(
      `\n===== paraphrase target 名次逐条对照（${cfg.id}：baseline → 富化） =====\n`,
    );
    process.stdout.write(
      `${pad('id', 4)} ${pad('query', 30)} ${rpad('baseline', 9)} ${rpad('富化', 9)}  变化\n`,
    );
    let better = 0;
    let worse = 0;
    let same = 0;
    for (const spec of set.queries.filter((q) => q.type === 'paraphrase')) {
      const rb = getRank('baseline', cfg.id, spec.id);
      const re = getRank('enriched', cfg.id, spec.id);
      const delta = rb == null && re == null ? 0 : (re ?? 201) - (rb ?? 201);
      if (delta < 0) better++;
      else if (delta > 0) worse++;
      else same++;
      process.stdout.write(
        `${pad(spec.id, 4)} ${pad(truncate(spec.query, 28), 30)} ${rpad(rb ?? '-', 9)} ` +
          `${rpad(re ?? '-', 9)}  ` +
          `${rb == null && re != null ? '新召回' : rb != null && re == null ? '丢失' : delta < 0 ? `↑${-delta} 变好` : delta > 0 ? `↓${delta} 变差` : '='}\n`,
      );
    }
    process.stdout.write(
      `小计: 变好 ${better} 条，变差 ${worse} 条，不变 ${same} 条；` +
        `进 top-5: ${set.queries.filter((q) => q.type === 'paraphrase' && getHits('baseline', cfg.id, q.id) > 0).length} → ` +
        `${set.queries.filter((q) => q.type === 'paraphrase' && getHits('enriched', cfg.id, q.id) > 0).length}\n`,
    );
    process.stdout.write(
      `paraphrase: baseline hit@5=${mBase.paraphrase.hit5.toFixed(2)} P@5=${mBase.paraphrase.p5.toFixed(2)} ` +
        `MRR@5=${mBase.paraphrase.mrr5.toFixed(2)} → 富化 hit@5=${mExp.paraphrase.hit5.toFixed(2)} ` +
        `P@5=${mExp.paraphrase.p5.toFixed(2)} MRR@5=${mExp.paraphrase.mrr5.toFixed(2)}\n`,
    );

    process.stdout.write(`\n===== keyword 子集退化检查（${cfg.id}：baseline → 富化） =====\n`);
    process.stdout.write(
      `${pad('id', 4)} ${pad('query', 26)} ${rpad('baseline', 9)} ${rpad('富化', 9)}  变化\n`,
    );
    let changed = 0;
    for (const spec of set.queries.filter((q) => q.type === 'keyword')) {
      const rb = getRank('baseline', cfg.id, spec.id);
      const re = getRank('enriched', cfg.id, spec.id);
      const delta = rb == null && re == null ? 0 : (re ?? 201) - (rb ?? 201);
      if (delta !== 0) changed++;
      process.stdout.write(
        `${pad(spec.id, 4)} ${pad(truncate(spec.query, 24), 26)} ${rpad(rb ?? '-', 9)} ` +
          `${rpad(re ?? '-', 9)}  ${delta > 0 ? `↓${delta}` : delta < 0 ? `↑${-delta}` : '='}\n`,
      );
    }
    process.stdout.write(
      `小计: 名次变化 ${changed}/${set.queries.filter((q) => q.type === 'keyword').length}；` +
        `baseline hit@5=${mBase.keyword.hit5.toFixed(2)} MRR@5=${mBase.keyword.mrr5.toFixed(2)} → ` +
        `富化 hit@5=${mExp.keyword.hit5.toFixed(2)} MRR@5=${mExp.keyword.mrr5.toFixed(2)}\n`,
    );
  }

  if (opts.latency) {
    process.stdout.write(
      `\n===== 延迟对照（k=${opts.k}，routeLimit=50，每查询预热 1 次 + ${opts.repeat} 次计时） =====\n`,
    );
    process.stdout.write(
      `${pad('组合', 20)} ${rpad('p50 ms', 9)} ${rpad('p90 ms', 9)} ${rpad('encode p50', 12)}\n`,
    );
    for (const cfg of compareConfigs) {
      for (const side of sides) {
        const samples = [];
        const encodeSamples = [];
        for (const spec of set.queries) {
          await search(side.searcher, spec.query, { ...cfg.options, k: opts.k });
          for (let i = 0; i < opts.repeat; i++) {
            const out = await search(side.searcher, spec.query, { ...cfg.options, k: opts.k });
            samples.push(out.timings.totalMs);
            if (out.timings.encodeMs) encodeSamples.push(out.timings.encodeMs);
          }
        }
        process.stdout.write(
          `${pad(`${side.label}·${cfg.id}`, 20)} ${rpad(fmtMs(p50(samples)), 9)} ` +
            `${rpad(fmtMs(percentile(samples, 90)), 9)} ${rpad(fmtMs(p50(encodeSamples)), 12)}\n`,
        );
      }
    }
  }

  for (const side of sides) side.db.close();
}

/* -------------------------------- main ----------------------------------- */

// pending 是 miss-log 待人工标注的 query，不是正式评测集的一部分：
// 只用于 validate-only 提示条数，不进 set.queries，不参与校验失败判定。
// eval-rerank.mjs 只读 eval-set.json，天然忽略 pending。
function pendingPathForSet(setPath) {
  return path.join(path.dirname(setPath), 'eval-set.pending.json');
}

function countPendingCases(setPath) {
  const pendingPath = pendingPathForSet(setPath);
  try {
    const obj = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    return Array.isArray(obj.entries) ? obj.entries.length : 0;
  } catch {
    // 文件不存在或解析失败都只影响提示，不阻断评测。
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.db)) throw new Error(`数据库不存在: ${opts.db}（先运行 build-db.mjs）`);
  if (!fs.existsSync(opts.set)) throw new Error(`评测集不存在: ${opts.set}`);
  const set = JSON.parse(fs.readFileSync(opts.set, 'utf8'));
  if (!Array.isArray(set.queries)) throw new Error('eval-set 缺少 queries 数组');
  const configs = buildConfigs(opts.configs);

  if (opts.compareDb) {
    await runCompare(opts, set, configs);
    return;
  }

  const openStarted = performance.now();
  const db = openSearchDb(opts.db);
  const dbOpenMs = performance.now() - openStarted;

  process.stdout.write(`db: ${opts.db}  ${(fs.statSync(opts.db).size / 1024 ** 2).toFixed(1)} MB\n`);
  process.stdout.write(
    `eval set: ${opts.set}  查询 ${set.queries.length} 条  repeat=${opts.repeat}  k=${opts.k}\n`,
  );
  process.stdout.write(
    `configs: ${configs.map((c) => c.id).join(', ')}` +
      `${configs.some((c) => c.options.expand) ? '  （含 --expand）' : ''}\n`,
  );

  const resolution = resolveTargetOffsets(db, set);
  applyTargetOffsets(resolution);
  printTargetResolution(resolution, set);
  if (resolution.errors.length) {
    process.stdout.write(`\n目标解析失败（${resolution.errors.length} 条）：\n`);
    for (const e of resolution.errors) process.stdout.write(`  - ${e}\n`);
    db.close();
    process.exitCode = 1;
    return;
  }

  const { errors, stats } = validateSet(db, set);
  printCoverage(stats, set.queries.length);
  if (errors.length) {
    process.stdout.write(`\n评测集校验失败（${errors.length} 条）：\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
    db.close();
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    '评测集校验: 通过（target 均按稳定标识解析到当前库；paraphrase 无共享 3 字片段；' +
      'keyword target 在 tokens 候选里）\n',
  );
  if (opts.validateOnly) {
    const pendingPath = pendingPathForSet(opts.set);
    if (fs.existsSync(pendingPath)) {
      const pendingCount = countPendingCases(opts.set);
      process.stdout.write(
        pendingCount == null
          ? `pending: 无法解析，已忽略（${pendingPath}；不计入评测集）\n`
          : `pending: ${pendingCount} 条（eval-set.pending.json，未计入评测集）\n`,
      );
    }
    db.close();
    return;
  }

  const needsVector = configs.some((c) => c.options.keyword === false || c.options.vector !== false);
  let extractor = null;
  let initMs = null;
  if (needsVector) {
    const model = await initModel();
    extractor = model.extractor;
    initMs = model.initMs;
  }
  const searcher = { db, extractor };
  process.stdout.write(
    `[cold-start] model load ${initMs == null ? 'skipped' : `${(initMs / 1000).toFixed(2)}s`}  ` +
      `db open ${fmtMs(dbOpenMs)}ms\n`,
  );

  // ---------- 分类与 token 抽取预览 ----------
  process.stdout.write('\n===== 查询分类（S2 路由依据）/ token 抽取（tokens 模式） =====\n');
  for (const spec of set.queries) {
    const cls = classifyQuery(spec.query);
    const toks = extractKeywordTokens(spec.query);
    process.stdout.write(
      `${spec.id} [${pad(spec.type, 10)}] ${cls.kind.padEnd(7)} ` +
        `${pad(cls.signals.length ? truncate(cls.signals.join(','), 38) : '-', 40)} ` +
        `tokens=${toks.length ? truncate(toks.map((t) => `${t.raw}`).join(','), 60) : '-'}\n`,
    );
  }

  // ---------- 排名 ----------
  const rankMatrix = new Map();
  const top5Matrix = new Map();
  const candMatrix = new Map();
  const expandSamples = new Map();
  for (const cfg of configs) {
    rankMatrix.set(cfg.id, new Map());
    top5Matrix.set(cfg.id, new Map());
    candMatrix.set(cfg.id, new Map());
  }

  process.stdout.write(
    '\n===== 首个 target 排名 / top-5 命中数（深度 200，- = 未进前 200） =====\n',
  );
  process.stdout.write(
    `${pad('id', 4)} ${pad('type', 10)} ${pad('query', 32)} ` +
      configs.map((c) => rpad(c.id, 8)).join(' ') +
      '\n',
  );
  for (const spec of set.queries) {
    const cells = [];
    for (const cfg of configs) {
      const { rank, hitsInTop5, out } = await rankQuery(searcher, spec, cfg);
      rankMatrix.get(cfg.id).set(spec.id, rank);
      top5Matrix.get(cfg.id).set(spec.id, hitsInTop5);
      candMatrix.get(cfg.id).set(spec.id, {
        keyword: out.candidates.keyword,
        keywordFiltered: out.candidates.keywordFiltered,
        vector: out.candidates.vector,
        variants: out.keywordVariants?.length ?? 0,
        tokens: out.tokens ?? [],
        keywordMode: out.keywordMode,
        expandVariants: out.expand?.variants ?? null,
        expandTarget: out.expandTarget ?? null,
        expand: out.expand ?? null,
        vectorEncoded: out.candidates.vectorEncoded ?? 1,
        vectorVariants: out.vectorVariants ?? null,
        variantEncodeMs: out.timings.variantEncodeMs ?? 0,
      });
      if (cfg.options.expand && cfg.options.keyword !== false && out.expand) {
        expandSamples.set(spec.id, { query: spec.query, ...out.expand });
      }
      cells.push(rpad(`${rank ?? '-'}/${hitsInTop5}`, 8));
    }
    process.stdout.write(
      `${pad(spec.id, 4)} ${pad(spec.type, 10)} ${pad(truncate(spec.query, 30), 32)} ` +
        `${cells.join(' ')}\n`,
    );
  }

  // ---------- 分类型指标 ----------
  const metrics = new Map();
  for (const cfg of configs) {
    const per = {};
    for (const subset of SUBSETS) {
      const rows = set.queries
        .filter((q) => q.type === subset)
        .map((q) => ({
          rank: rankMatrix.get(cfg.id).get(q.id),
          hitsInTop5: top5Matrix.get(cfg.id).get(q.id),
        }));
      per[subset] = summarize(rows);
    }
    per.total = summarize(
      set.queries.map((q) => ({
        rank: rankMatrix.get(cfg.id).get(q.id),
        hitsInTop5: top5Matrix.get(cfg.id).get(q.id),
      })),
    );
    metrics.set(cfg.id, per);
  }

  const mainConfigs = configs.filter((c) => !c.extra);
  const diagConfigs = configs.filter((c) => c.extra);
  const subsetCounts = Object.fromEntries(
    SUBSETS.map((s) => [s, set.queries.filter((q) => q.type === s).length]),
  );
  const printMetricTable = (list, title) => {
    process.stdout.write(`\n===== ${title}（k=${opts.k}；每格 hit@5 / P@5 / MRR@5） =====\n`);
    process.stdout.write(
      `${pad('组合', 22)} | ${pad(`paraphrase(${subsetCounts.paraphrase})`, 21)} | ` +
        `${pad(`keyword(${subsetCounts.keyword})`, 21)} | ` +
        `${pad(`mixed(${subsetCounts.mixed})`, 21)} | ` +
        `${pad(`total(${set.queries.length})`, 21)} | MRR@50\n`,
    );
    for (const cfg of list) {
      const m = metrics.get(cfg.id);
      process.stdout.write(
        `${pad(cfg.label, 22)} | ${pad(metricCell(m.paraphrase), 21)} | ` +
          `${pad(metricCell(m.keyword), 21)} | ${pad(metricCell(m.mixed), 21)} | ` +
          `${pad(metricCell(m.total), 21)} | ${m.total.mrr50.toFixed(3)}\n`,
      );
    }
  };
  printMetricTable(mainConfigs, '指标');
  if (diagConfigs.length) printMetricTable(diagConfigs, '额外诊断组合');

  // ---------- mixed 子集 target 名次（S5/S6 路由对照） ----------
  const mixedSpecs = set.queries.filter((q) => q.type === 'mixed');
  if (mixedSpecs.length) {
    process.stdout.write('\n===== mixed 子集 target 名次（所选组合） =====\n');
    process.stdout.write(
      `${pad('id', 4)} ${pad('class', 8)} ${pad('query', 28)} ` +
        `${configs.map((c) => rpad(c.id, 8)).join(' ')}\n`,
    );
    for (const spec of mixedSpecs) {
      const cls = classifyQuery(spec.query);
      const cells = configs.map((cfg) => rpad(rankMatrix.get(cfg.id).get(spec.id) ?? '-', 8));
      process.stdout.write(
        `${pad(spec.id, 4)} ${pad(cls.kind, 8)} ${pad(truncate(spec.query, 26), 28)} ` +
          `${cells.join(' ')}\n`,
      );
    }
  }

  // ---------- keyword 子集 hit@5 检查 ----------
  const keywordSpecs = set.queries.filter((q) => q.type === 'keyword');
  if (keywordSpecs.length) {
    process.stdout.write('\n===== keyword 子集 hit@5 检查 =====\n');
    for (const cfg of configs) {
      const hit = keywordSpecs.filter(
        (q) => (top5Matrix.get(cfg.id).get(q.id) ?? 0) > 0,
      ).length;
      const m = metrics.get(cfg.id).keyword;
      process.stdout.write(
        `${pad(cfg.label, 22)} hit@5 ${hit}/${keywordSpecs.length}  ` +
          `P@5=${m.p5.toFixed(2)}  MRR@5=${m.mrr5.toFixed(2)}\n`,
      );
    }
  }

  // ---------- 组合等价性 & s2 改造前后 ----------
  const sameRanks = (x, y) => {
    if (!rankMatrix.has(x) || !rankMatrix.has(y)) return null;
    for (const spec of set.queries) {
      if (rankMatrix.get(x).get(spec.id) !== rankMatrix.get(y).get(spec.id)) return false;
    }
    return true;
  };
  const eqCE = sameRanks('C', 'E');
  const eqDF = sameRanks('D', 'F');
  if (eqCE != null || eqDF != null) {
    process.stdout.write('\n===== 组合等价性 =====\n');
    if (eqCE != null) {
      process.stdout.write(
        `C（仅向量）与 E（仅向量+expand）逐条名次${eqCE ? '完全一致' : '有差异'}：` +
          '扩展只服务关键词路，--no-keyword 时不会发起扩展调用。\n',
      );
    }
    if (eqDF != null) {
      process.stdout.write(
        `D（s2+tokens）与 F（s2+tokens+expand）逐条名次${eqDF ? '完全一致' : '有差异'}：` +
          's2 对 natural 查询向量优先，向量候选总是 >=k，扩展出来的关键词候选进不了 top-k。\n',
      );
    }
  }

  if (rankMatrix.has('P') && rankMatrix.has('D')) {
    process.stdout.write('\n===== s2 改造前后（P phrase → D tokens） =====\n');
    process.stdout.write(
      `${pad('id', 4)} ${pad('type', 10)} ${pad('query', 26)} ${rpad('P rank', 7)} ${rpad('D rank', 7)}  变化\n`,
    );
    let better = 0;
    let worse = 0;
    for (const spec of set.queries) {
      const rp = rankMatrix.get('P').get(spec.id);
      const rd = rankMatrix.get('D').get(spec.id);
      const delta = rp == null && rd == null ? 0 : (rd ?? 201) - (rp ?? 201);
      if (rp == null && rd != null) better++;
      else if (rp != null && rd == null) worse++;
      else if (delta < 0) better++;
      else if (delta > 0) worse++;
      if (rp !== rd) {
        process.stdout.write(
          `${pad(spec.id, 4)} ${pad(spec.type, 10)} ${pad(truncate(spec.query, 24), 26)} ` +
            `${rpad(rp ?? '-', 7)} ${rpad(rd ?? '-', 7)}  ` +
            `${rp == null && rd != null ? '新召回' : rp != null && rd == null ? '丢失' : delta < 0 ? `↑${-delta}` : `↓${delta}`}\n`,
        );
      }
    }
    process.stdout.write(`小计: 变好 ${better} 条，变差 ${worse} 条\n`);
    const p = metrics.get('P').total;
    const d = metrics.get('D').total;
    process.stdout.write(
      `总计: P hit@5=${p.hit5.toFixed(2)} MRR@5=${p.mrr5.toFixed(2)} → ` +
        `D hit@5=${d.hit5.toFixed(2)} MRR@5=${d.mrr5.toFixed(2)}\n`,
    );
  }

  // ---------- mixed 子集关键词候选数 ----------
  if (rankMatrix.has('A') && rankMatrix.has('B')) {
    process.stdout.write('\n===== mixed 子集关键词候选数（A phrase → B tokens） =====\n');
    process.stdout.write(
      `${pad('id', 4)} ${rpad('A候选', 7)} ${rpad('B候选', 7)} ${rpad('B token数', 10)}  tokens\n`,
    );
    for (const spec of set.queries.filter((q) => q.type === 'mixed')) {
      const a = candMatrix.get('A').get(spec.id);
      const b = candMatrix.get('B').get(spec.id);
      process.stdout.write(
        `${pad(spec.id, 4)} ${rpad(a.keyword, 7)} ${rpad(b.keyword, 7)} ${rpad(b.tokens.length, 10)}  ` +
          `${truncate(b.tokens.join(', '), 70) || '-'}\n`,
      );
    }
  }

  // ---------- 关键词子集不退化检查 ----------
  if (rankMatrix.has('A') && rankMatrix.has('B')) {
    process.stdout.write('\n===== 关键词子集退化检查（A phrase → B tokens） =====\n');
    process.stdout.write(`${pad('id', 4)} ${pad('query', 26)} ${rpad('A rank', 7)} ${rpad('B rank', 7)}  变化\n`);
    let changed = 0;
    for (const spec of set.queries.filter((q) => q.type === 'keyword')) {
      const ra = rankMatrix.get('A').get(spec.id);
      const rb = rankMatrix.get('B').get(spec.id);
      const delta = ra == null && rb == null ? 0 : (ra ?? 201) - (rb ?? 201);
      if (delta !== 0) changed++;
      process.stdout.write(
        `${pad(spec.id, 4)} ${pad(truncate(spec.query, 24), 26)} ${rpad(ra ?? '-', 7)} ` +
          `${rpad(rb ?? '-', 7)}  ${delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : '='}\n`,
      );
    }
    const ma = metrics.get('A').keyword;
    const mb = metrics.get('B').keyword;
    process.stdout.write(
      `小计: 名次变化 ${changed}/10；A hit@5=${ma.hit5.toFixed(2)} MRR@5=${ma.mrr5.toFixed(2)} ` +
        `P@5=${ma.p5.toFixed(2)}；B hit@5=${mb.hit5.toFixed(2)} MRR@5=${mb.mrr5.toFixed(2)} ` +
        `P@5=${mb.p5.toFixed(2)}\n`,
    );
  }

  // ---------- 扩展效果（B → G，仅关键词路） ----------
  if (rankMatrix.has('B') && rankMatrix.has('G')) {
    process.stdout.write('\n===== 扩展对关键词路的实际影响（B 无扩展 → G tokens+expand） =====\n');
    process.stdout.write(
      `${pad('id', 4)} ${pad('type', 10)} ${pad('query', 26)} ${rpad('B rank', 7)} ${rpad('G rank', 7)}  变化\n`,
    );
    let better = 0;
    let worse = 0;
    for (const spec of set.queries) {
      const rb = rankMatrix.get('B').get(spec.id);
      const rg = rankMatrix.get('G').get(spec.id);
      const delta = rb == null && rg == null ? 0 : (rg ?? 201) - (rb ?? 201);
      if (rb == null && rg != null) better++;
      else if (rb != null && rg == null) worse++;
      else if (delta < 0) better++;
      else if (delta > 0) worse++;
      if (rb !== rg) {
        process.stdout.write(
          `${pad(spec.id, 4)} ${pad(spec.type, 10)} ${pad(truncate(spec.query, 24), 26)} ` +
            `${rpad(rb ?? '-', 7)} ${rpad(rg ?? '-', 7)}  ` +
            `${rb == null && rg != null ? '新召回' : rb != null && rg == null ? '丢失' : delta < 0 ? `↑${-delta}` : `↓${delta}`}\n`,
        );
      }
    }
    process.stdout.write(`小计: 变好 ${better} 条，变差 ${worse} 条\n`);
  }

  // ---------- paraphrase 子集名次对照（C → C2，以及 S6 → F2） ----------
  const printParaphraseDiff = (baseId, expId, title, note) => {
    if (!rankMatrix.has(baseId) || !rankMatrix.has(expId)) return;
    const specs = set.queries.filter((q) => q.type === 'paraphrase');
    process.stdout.write(`\n===== ${title} =====\n`);
    process.stdout.write(
      `${pad('id', 4)} ${pad('query', 30)} ${rpad(`${baseId} rank`, 9)} ${rpad(`${expId} rank`, 9)}  变化\n`,
    );
    let better = 0;
    let worse = 0;
    let same = 0;
    for (const spec of specs) {
      const rb = rankMatrix.get(baseId).get(spec.id);
      const re = rankMatrix.get(expId).get(spec.id);
      const delta = rb == null && re == null ? 0 : (re ?? 201) - (rb ?? 201);
      if (delta < 0) better++;
      else if (delta > 0) worse++;
      else same++;
      process.stdout.write(
        `${pad(spec.id, 4)} ${pad(truncate(spec.query, 28), 30)} ${rpad(rb ?? '-', 9)} ` +
          `${rpad(re ?? '-', 9)}  ` +
          `${delta < 0 ? `↑${-delta} 变好` : delta > 0 ? `↓${delta} 变差` : '='}\n`,
      );
    }
    process.stdout.write(`小计: 变好 ${better} 条，变差 ${worse} 条，不变 ${same} 条\n`);
    const mb = metrics.get(baseId).paraphrase;
    const me = metrics.get(expId).paraphrase;
    process.stdout.write(
      `paraphrase: ${baseId} hit@5=${mb.hit5.toFixed(2)} MRR@5=${mb.mrr5.toFixed(2)} → ` +
        `${expId} hit@5=${me.hit5.toFixed(2)} MRR@5=${me.mrr5.toFixed(2)}\n`,
    );
    if (note) process.stdout.write(`${note}\n`);
  };
  printParaphraseDiff(
    'C',
    'C2',
    'paraphrase 子集 target 名次对照（C 仅向量 → C2 仅向量+扩展向量）',
    'C2 每条变体各做一次 KNN，同一 offset 取余弦最大值；↑ 表示名次前移（变好），↓ 表示后移（变差）。',
  );
  printParaphraseDiff(
    'S6',
    'F2',
    'paraphrase 子集 target 名次对照（S6 默认 → F2 s6+扩展向量）',
    null,
  );

  // ---------- 扩展向量路统计（排名阶段） ----------
  const vectorExpandConfigs = configs.filter(
    (c) => c.options.expandTarget === 'vector' || c.options.expandTarget === 'both',
  );
  if (vectorExpandConfigs.length) {
    process.stdout.write('\n===== 扩展向量路统计（排名阶段，每查询一次） =====\n');
    process.stdout.write(
      `${pad('组合', 24)} ${rpad('有变体查询', 10)} ${rpad('变体编码', 8)} ${rpad('变体/查询', 10)} ` +
        `${rpad('变体enc p50', 12)} ${rpad('单查询enc p50', 15)} ${rpad('KNN查询/查询', 13)} ${rpad('缓存命中', 8)}\n`,
    );
    for (const cfg of vectorExpandConfigs) {
      const rows = set.queries
        .map((q) => candMatrix.get(cfg.id).get(q.id))
        .filter((c) => c?.vectorVariants?.length);
      const variantSamples = rows.flatMap((c) =>
        c.vectorVariants.filter((v) => !v.error).map((v) => v.encodeMs),
      );
      const perQuerySamples = rows.map((c) => c.variantEncodeMs);
      const variantTotal = variantSamples.length;
      const variantPerQuery = rows.length ? variantTotal / rows.length : 0;
      const knnPerQuery = rows.length
        ? rows.reduce((a, c) => a + c.vectorEncoded, 0) / rows.length
        : 0;
      const cacheHits = rows.filter((c) => c.expand?.fromCache).length;
      process.stdout.write(
        `${pad(cfg.label, 24)} ${rpad(rows.length, 10)} ${rpad(variantTotal, 8)} ` +
          `${rpad(variantPerQuery.toFixed(1), 10)} ${rpad(fmtMs(p50(variantSamples)), 12)} ` +
          `${rpad(fmtMs(p50(perQuerySamples)), 15)} ${rpad(knnPerQuery.toFixed(1), 13)} ` +
          `${rpad(`${cacheHits}/${rows.length}`, 8)}\n`,
      );
    }
  }

  // ---------- 扩展样例 ----------
  if (expandSamples.size) {
    process.stdout.write('\n===== 查询扩展样例（自然语言查询） =====\n');
    for (const [id, e] of expandSamples) {
      process.stdout.write(
        `${id}  ${truncate(e.query, 40)}  ${e.fromCache ? '[缓存]' : `[API ${fmtMs(e.elapsedMs)}ms]`}\n`,
      );
      for (const v of e.variants) process.stdout.write(`    - ${v}\n`);
      if (e.error) process.stdout.write(`    ! ${e.error}\n`);
    }
  }

  // ---------- 延迟 ----------
  if (opts.latency) {
    process.stdout.write(
      `\n===== 延迟（k=${opts.k}，routeLimit=50，每查询预热 1 次 + ${opts.repeat} 次计时） =====\n`,
    );
    const latency = new Map();
    for (const cfg of configs) {
      const samples = [];
      const encodeSamples = [];
      const expandSamplesMs = [];
      const variantEncodeSamples = [];
      const variantCounts = [];
      for (const spec of set.queries) {
        await search(searcher, spec.query, { ...cfg.options, k: opts.k });
        for (let i = 0; i < opts.repeat; i++) {
          const out = await search(searcher, spec.query, { ...cfg.options, k: opts.k });
          samples.push(out.timings.totalMs);
          if (out.timings.encodeMs) encodeSamples.push(out.timings.encodeMs);
          if (out.timings.expandMs) expandSamplesMs.push(out.timings.expandMs);
          if (out.vectorVariantCount) {
            variantEncodeSamples.push(out.timings.variantEncodeMs);
            variantCounts.push(out.vectorVariantCount);
          }
        }
      }
      latency.set(cfg.id, {
        p50: p50(samples),
        p90: percentile(samples, 90),
        encodeP50: encodeSamples.length ? p50(encodeSamples) : null,
        expandP50: expandSamplesMs.length ? p50(expandSamplesMs) : null,
        variantEncodeP50: variantEncodeSamples.length ? p50(variantEncodeSamples) : null,
        variantCountAvg: variantCounts.length
          ? variantCounts.reduce((a, b) => a + b, 0) / variantCounts.length
          : null,
      });
    }
    const printLatencyTable = (list) => {
      process.stdout.write(
        `${pad('组合', 24)} ${rpad('p50 ms', 9)} ${rpad('p90 ms', 9)} ` +
          `${rpad('encode p50', 11)} ${rpad('变体enc p50', 12)} ${rpad('变体数/查询', 11)} ` +
          `${rpad('expandCache p50', 16)}\n`,
      );
      for (const cfg of list) {
        const l = latency.get(cfg.id);
        process.stdout.write(
          `${pad(cfg.label, 24)} ${rpad(fmtMs(l.p50), 9)} ${rpad(fmtMs(l.p90), 9)} ` +
            `${rpad(fmtMs(l.encodeP50), 11)} ${rpad(fmtMs(l.variantEncodeP50), 12)} ` +
            `${rpad(l.variantCountAvg == null ? '-' : l.variantCountAvg.toFixed(1), 11)} ` +
            `${rpad(fmtMs(l.expandP50), 16)}\n`,
        );
      }
    };
    printLatencyTable(mainConfigs);
    if (diagConfigs.length) {
      process.stdout.write('\n--- 额外诊断 ---\n');
      printLatencyTable(diagConfigs);
    }
  }

  // ---------- 扩展调用统计 ----------
  process.stdout.write('\n===== 查询扩展调用统计 =====\n');
  process.stdout.write(
    `本次进程: API 调用 ${expansionStats.calls} 次；缓存命中 ${expansionStats.cacheHits} 次；失败 ${expansionStats.failures} 次\n`,
  );
  if (expansionStats.calls > 0) {
    process.stdout.write(
      `token: prompt ${expansionStats.promptTokens} + completion ${expansionStats.completionTokens} ` +
        `= ${expansionStats.totalTokens}\n`,
    );
    process.stdout.write(
      `成本估算: $${estimateExpansionCostUsd().toFixed(6)}（flash 0.30/1.20 美元每百万 input/output）\n`,
    );
    process.stdout.write(
      `单次 API 往返: p50 ${fmtMs(p50(expansionStats.apiMs))}ms  ` +
        `p90 ${fmtMs(percentile(expansionStats.apiMs, 90))}ms  ` +
        `min ${fmtMs(Math.min(...expansionStats.apiMs))}ms  ` +
        `max ${fmtMs(Math.max(...expansionStats.apiMs))}ms\n`,
    );
  }
  // 缓存里记录了每次原始 API 调用的 usage 与耗时；重复评测命中缓存时用这份数据报告真实成本。
  const naturalQueries = set.queries
    .filter((q) => classifyQuery(q.query).kind === 'natural')
    .map((q) => q.query);
  const cached = getCachedCallStats(naturalQueries);
  if (cached.count > 0) {
    process.stdout.write(
      `缓存中记录的原始 API 调用（${cached.count} 条自然查询）: prompt ${cached.promptTokens} + ` +
        `completion ${cached.completionTokens} = ${cached.totalTokens} token；` +
        `成本估算 $${cached.costUsd.toFixed(6)}\n`,
    );
    process.stdout.write(
      `单次往返: p50 ${fmtMs(p50(cached.apiMs))}ms  p90 ${fmtMs(percentile(cached.apiMs, 90))}ms  ` +
        `平均值 ${fmtMs(cached.apiMs.reduce((a, b) => a + b, 0) / cached.apiMs.length)}ms\n`,
    );
  }

  db.close();
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[eval] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}

export {
  validateSet,
  resolveTargetOffsets,
  applyTargetOffsets,
  printTargetResolution,
  statementHash,
  printCoverage,
  rankQuery,
  summarize,
  p50,
  percentile,
  fmtMs,
  truncate,
  pad,
  rpad,
  SUBSETS,
  DIFFICULTIES,
};
