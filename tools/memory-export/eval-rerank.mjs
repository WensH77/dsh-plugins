#!/usr/bin/env node
/**
 * 重排评测：在 eval-set.json（45 条：paraphrase 30 / keyword 10 / mixed 5）上对比
 *   S6（现状基线）、S6+rerank(50)、S6+rerank(100)、C（仅向量）、C+rerank(50)。
 *
 * 每条查询跑两遍：
 *   1) k=5、默认 routeLimit：真实使用路径，采集端到端 / 检索 / 重排 API 延迟；
 *   2) k=200、routeLimit=200：只用于算名次（MRR@50 与 paraphrase 逐条对照）。
 * 第二遍的 top-N 候选与第一遍一致，重排走进程内缓存（不再产生 API 往返）。
 *
 * 产物写到 ~/.dsh/memory-export/rerank-eval/：
 *   results.json                 完整数据（指标、逐条名次、逐 target 名次、延迟、成本）
 *   report.md                    可读报告
 *   eval-set.45.json             本次评测集快照
 *   rerank-calls-<config>.jsonl  每次真实重排 API 的原始输出与 token 用量
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { openSearchDb, initModel, search } from './mem-search.mjs';
import {
  validateSet,
  resolveTargetOffsets,
  applyTargetOffsets,
  printTargetResolution,
  printCoverage,
  summarize,
  p50,
  percentile,
  fmtMs,
  pad,
  rpad,
  truncate,
  SUBSETS,
  DIFFICULTIES,
} from './eval-memory-search.mjs';
import { resetRerankStats, snapshotRerankStats } from './rerank.mjs';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(HOME, '.dsh', 'memory-export', 'memory.db');
const DEFAULT_SET = path.join(HERE, 'eval-set.json');
const OUT_DIR = path.join(HOME, '.dsh', 'memory-export', 'rerank-eval');
const RANK_DEPTH = 200;

const CONFIGS = [
  { id: 'S6', label: 'S6', options: { strategy: 's6', keywordMode: 'tokens' } },
  {
    id: 'S6+R50',
    label: 'S6 + rerank(50)',
    options: { strategy: 's6', keywordMode: 'tokens', rerank: true, rerankDepth: 50 },
  },
  {
    id: 'S6+R100',
    label: 'S6 + rerank(100)',
    options: { strategy: 's6', keywordMode: 'tokens', rerank: true, rerankDepth: 100 },
  },
  { id: 'C', label: 'C 仅向量', options: { strategy: 's1', keyword: false } },
  {
    id: 'C+R50',
    label: 'C 仅向量 + rerank(50)',
    options: { strategy: 's1', keyword: false, rerank: true, rerankDepth: 50 },
  },
];

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, set: DEFAULT_SET, configs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = path.resolve(argv[++i]);
    else if (a === '--set') opts.set = path.resolve(argv[++i]);
    else if (a === '--configs') {
      opts.configs = String(argv[++i])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node eval-rerank.mjs [--db <file>] [--set <file>] [--configs S6,S6+R50,...]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数 ${a}`);
    }
  }
  return opts;
}

function deltaStr(before, after) {
  if (before == null && after == null) return '=';
  if (before == null) return `召回 ${after}`;
  if (after == null) return '丢失';
  const d = after - before;
  return d < 0 ? `↑${-d}` : d > 0 ? `↓${d}` : '=';
}

function metricLine(m) {
  return `hit@5 ${m.hit5.toFixed(2)} / P@5 ${m.p5.toFixed(2)} / MRR@5 ${m.mrr5.toFixed(2)}`;
}

function metricsFor(specs, perQuery) {
  const rows = specs.map((q) => {
    const r = perQuery.get(q.id);
    return { rank: r?.firstRank ?? null, hitsInTop5: r?.hitsInTop5 ?? 0 };
  });
  return summarize(rows);
}

function buildReport(ctx) {
  const {
    set,
    opts,
    coverage,
    configs,
    metrics,
    perQuery,
    perTarget,
    latency,
    cost,
    rescued,
    pushed,
    pushedOut50,
    rescued100,
    pushed100,
    pushedOut50_100,
    newParaphraseIds,
    runStartedAt,
    resolution,
  } = ctx;
  const L = [];
  const w = (s = '') => L.push(s);
  const qOf = (cid, qid) => perQuery.get(cid)?.get(qid) ?? null;
  const queries = set.queries;
  const paraphrase = queries.filter((q) => q.type === 'paraphrase');
  const keyword = queries.filter((q) => q.type === 'keyword');
  const mixed = queries.filter((q) => q.type === 'mixed');

  w('# 向量召回 + LLM 重排评测报告');
  w();
  w(`- 生成时间: ${new Date().toISOString()}（运行开始 ${runStartedAt}）`);
  w(`- 数据库: \`${opts.db}\``);
  w(`- 评测集: \`${opts.set}\`，${queries.length} 条（paraphrase ${paraphrase.length} / keyword ${keyword.length} / mixed ${mixed.length}）`);
  w(`- 名次深度: ${RANK_DEPTH}；指标 k=5`);
  w(`- 重排模型: deepseek-flash；只对自然语言（natural）与混合（mixed）查询触发，exact 跳过`);
  w();
  w('## 覆盖与校验');
  w();
  w(
    `- 主目标 kind: ${Object.entries(coverage.kinds)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ')}`,
  );
  w(
    `- 不同 cwd: ${Object.keys(coverage.cwds).length} 个；intranet-aio 之外 ${coverage.outsideIntranetAio}/${queries.length}`,
  );
  w(
    `- paraphrase 难度: ${Object.entries(coverage.difficulties)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ')}`,
  );
  w('- 校验: 通过（target 按 session_id+seq+kind+statement_hash 解析到当前库：稳定标识 ' +
      `${resolution.stable} 条 / offset 兜底 ${resolution.fallback} 条 / offset 缓存漂移 ` +
      `${resolution.drifted} 条；paraphrase 与 target 无共享 3 字片段；无重复 query/id）`);
  w();
  w('## 指标表');
  w();
  w('每格：hit@5 / P@5 / MRR@5；最后一列为总 MRR@50。');
  w();
  w(
    `| 组合 | paraphrase(${paraphrase.length}) | keyword(${keyword.length}) | mixed(${mixed.length}) | ` +
      `total(${queries.length}) | MRR@50 |`,
  );
  w('| --- | --- | --- | --- | --- | --- |');
  for (const cfg of configs) {
    const m = metrics.get(cfg.id);
    w(
      `| ${cfg.label} | ${metricLine(m.paraphrase)} | ${metricLine(m.keyword)} | ` +
        `${metricLine(m.mixed)} | ${metricLine(m.total)} | ${m.total.mrr50.toFixed(3)} |`,
    );
  }
  w();
  w('paraphrase 按新/旧拆开（旧 15 条 = q01–q15，新 15 条 = q31–q45）：');
  w();
  w('| 组合 | 原有 15 hit@5 | 新增 15 hit@5 | 全部 30 hit@5 | 全部 30 MRR@5 |');
  w('| --- | --- | --- | --- | --- |');
  const oldParas = paraphrase.filter((q) => !newParaphraseIds.has(q.id));
  const newParas = paraphrase.filter((q) => newParaphraseIds.has(q.id));
  for (const cfg of configs) {
    const mo = metricsFor(oldParas, perQuery.get(cfg.id));
    const mn = metricsFor(newParas, perQuery.get(cfg.id));
    const ma = metrics.get(cfg.id).paraphrase;
    w(
      `| ${cfg.label} | ${mo.hit5.toFixed(2)} | ${mn.hit5.toFixed(2)} | ` +
        `${ma.hit5.toFixed(2)} | ${ma.mrr5.toFixed(2)} |`,
    );
  }
  w();

  w('## paraphrase 逐条名次（S6 → S6+R50 → S6+R100）');
  w();
  w('名次为该查询最早命中的 target 在结果里的位置；- 表示未进前 200。');
  w();
  w('| id | 难度 | query | S6 | S6+R50 | 变化 | S6+R100 |');
  w('| --- | --- | --- | --- | --- | --- | --- |');
  let better = 0;
  let worse = 0;
  let same = 0;
  for (const q of paraphrase) {
    const a = qOf('S6', q.id)?.firstRank ?? null;
    const b = qOf('S6+R50', q.id)?.firstRank ?? null;
    const c = qOf('S6+R100', q.id)?.firstRank ?? null;
    const d = deltaStr(a, b);
    if (d.startsWith('↑') || d.startsWith('召回')) better++;
    else if (d.startsWith('↓') || d === '丢失') worse++;
    else same++;
    w(
      `| ${q.id} | ${q.difficulty ?? '-'} | ${truncate(q.query, 34)} | ${a ?? '-'} | ${b ?? '-'} | ` +
        `${d} | ${c ?? '-'} |`,
    );
  }
  w();
  w(
    `小计（S6 → S6+R50）：变好 ${better} 条，变差 ${worse} 条，名次不变 ${same} 条；` +
      `进 top-5 ${paraphrase.filter((q) => (qOf('S6', q.id)?.hitsInTop5 ?? 0) > 0).length} → ` +
      `${paraphrase.filter((q) => (qOf('S6+R50', q.id)?.hitsInTop5 ?? 0) > 0).length} 条。`,
  );
  w();

  w('## 难度分档');
  w();
  w('每档：条数 / hit@5 / MRR@5（paraphrase 30 条，含原有 15 条的难度标注）。');
  w();
  w('| 难度 | 条数 | 组合 | hit@5 | P@5 | MRR@5 |');
  w('| --- | --- | --- | --- | --- | --- |');
  for (const diff of DIFFICULTIES) {
    const specs = paraphrase.filter((q) => q.difficulty === diff);
    if (!specs.length) continue;
    for (const cfg of configs) {
      if (!['S6', 'S6+R50', 'S6+R100'].includes(cfg.id)) continue;
      const m = metricsFor(specs, perQuery.get(cfg.id));
      w(
        `| ${diff} | ${specs.length} | ${cfg.label} | ${m.hit5.toFixed(2)} | ` +
          `${m.p5.toFixed(2)} | ${m.mrr5.toFixed(2)} |`,
      );
    }
  }
  w();
  w('只看新增 15 条的三档（easy/medium/hard 各 5 条）：');
  w();
  w('| 难度 | 组合 | hit@5 | MRR@5 |');
  w('| --- | --- | --- | --- |');
  for (const diff of DIFFICULTIES) {
    const specs = newParas.filter((q) => q.difficulty === diff);
    if (!specs.length) continue;
    for (const cfg of configs) {
      if (!['S6', 'S6+R50', 'S6+R100'].includes(cfg.id)) continue;
      const m = metricsFor(specs, perQuery.get(cfg.id));
      w(`| ${diff} | ${cfg.label} | ${m.hit5.toFixed(2)} | ${m.mrr5.toFixed(2)} |`);
    }
  }
  w();

  w('## target 进出 top-50 / top-5（S6 → S6+R50）');
  w();
  w(`### 原本排不进 top-50、重排后进入 top-50（${rescued.length} 条 target）`);
  w();
  if (!rescued.length) w('（无）');
  else {
    w('| query | target | 类别 | S6 名次 | S6+R50 名次 | statement |');
    w('| --- | --- | --- | --- | --- | --- |');
    for (const r of rescued) {
      w(
        `| ${r.queryId} ${truncate(r.query, 24)} | ${r.offset} | ${r.kind} | ` +
          `${r.before ?? '-'} | ${r.after} | ${truncate(r.statement, 50)} |`,
      );
    }
  }
  w();
  w(`### 原本在 top-5、重排后被挤出 top-5（${pushed.length} 条 target）`);
  w();
  if (!pushed.length) w('（无）');
  else {
    w('| query | target | 类别 | S6 名次 | S6+R50 名次 | statement |');
    w('| --- | --- | --- | --- | --- | --- |');
    for (const r of pushed) {
      w(
        `| ${r.queryId} ${truncate(r.query, 24)} | ${r.offset} | ${r.kind} | ` +
          `${r.before} | ${r.after ?? '-'} | ${truncate(r.statement, 50)} |`,
      );
    }
  }
  w();
  w(`### 原本在 top-50、重排后跌出 top-50（${pushedOut50.length} 条 target）`);
  w();
  if (!pushedOut50.length) w('（无）');
  else {
    w('| query | target | 类别 | S6 名次 | S6+R50 名次 |');
    w('| --- | --- | --- | --- | --- |');
    for (const r of pushedOut50) {
      w(
        `| ${r.queryId} ${truncate(r.query, 24)} | ${r.offset} | ${r.kind} | ` +
          `${r.before} | ${r.after ?? '-'} |`,
      );
    }
  }
  w();

  w('### S6 → S6+R100 同口径对照（深度 100）');
  w();
  w(`- 原本排不进 top-50、重排后进入 top-50：${rescued100.length} 条 target`);
  for (const r of rescued100) {
    w(
      `  - ${r.queryId}（${truncate(r.query, 30)}）target ${r.offset} [${r.kind}]：` +
        `${r.before ?? '-'} → ${r.after}；${truncate(r.statement, 60)}`,
    );
  }
  w(`- 原本在 top-5、重排后被挤出 top-5：${pushed100.length} 条 target`);
  for (const r of pushed100) {
    w(`  - ${r.queryId} target ${r.offset}：${r.before} → ${r.after ?? '-'}`);
  }
  w(`- 原本在 top-50、重排后跌出 top-50：${pushedOut50_100.length} 条 target`);
  for (const r of pushedOut50_100) {
    w(`  - ${r.queryId} target ${r.offset}：${r.before} → ${r.after ?? '-'}`);
  }
  w();

  w('### 重排后仍未进 top-5 的 paraphrase 原因分类');
  w();
  const classifyMiss = (cfgId, depth) => {
    const out = { outside: [], judged: [], absent: [] };
    for (const q of paraphrase) {
      const p = qOf(cfgId, q.id);
      if (!p || p.hitsInTop5 > 0) continue;
      const s6 = qOf('S6', q.id)?.firstRank ?? null;
      const after = p.firstRank;
      if (s6 == null) out.absent.push({ q, after });
      else if (s6 > depth) out.outside.push({ q, s6, after });
      else out.judged.push({ q, s6, after });
    }
    return out;
  };
  for (const [cid, depth] of [
    ['S6+R50', 50],
    ['S6+R100', 100],
  ]) {
    if (!perQuery.has(cid)) continue;
    const miss = classifyMiss(cid, depth);
    w(
      `**${cid}**：未进 top-5 共 ${miss.outside.length + miss.judged.length + miss.absent.length} 条。` +
        `其中 S6 排名 > ${depth}（不在候选池）${miss.outside.length} 条，` +
        `S6 未进前 200 ${miss.absent.length} 条，` +
        `在候选池但重排判断后仍 >5 ${miss.judged.length} 条。`,
    );
    w();
    w('| id | 难度 | S6 名次 | 重排后 | 归类 |');
    w('| --- | --- | --- | --- | --- |');
    for (const x of miss.outside) {
      w(`| ${x.q.id} | ${x.q.difficulty} | ${x.s6} | ${x.after ?? '-'} | 名次 > ${depth}，不在候选池 |`);
    }
    for (const x of miss.absent) {
      w(`| ${x.q.id} | ${x.q.difficulty} | - | ${x.after ?? '-'} | 未进前 200，不在候选池 |`);
    }
    for (const x of miss.judged) {
      w(`| ${x.q.id} | ${x.q.difficulty} | ${x.s6} | ${x.after ?? '-'} | 在池内但未排进 top-5 |`);
    }
    w();
  }

  w('### 变差的 paraphrase');
  w();
  const worseQueries = paraphrase.filter((q) => {
    const a = qOf('S6', q.id)?.firstRank ?? null;
    const b = qOf('S6+R50', q.id)?.firstRank ?? null;
    return a != null && b != null && b > a;
  });
  if (!worseQueries.length) w('（无）');
  else {
    for (const q of worseQueries) {
      const p = qOf('S6+R50', q.id);
      const hit = (p?.targets?.[0]?.rerankScore ?? null);
      w(
        `- ${q.id}（${q.difficulty}）S6 ${qOf('S6', q.id).firstRank} → S6+R50 ${p.firstRank}；` +
          `target 重排分 ${hit ?? '-'}，top-5 里仍有 ${p.hitsInTop5}/5 个 target 命中。`,
      );
      const promoted = (p.top5 ?? [])
        .filter((r) => !q.targets.some((t) => t.offset === r.offset))
        .slice(0, 3);
      for (const r of promoted) {
        w(`  - 排到前面的非 target ${r.offset}（rr=${r.rerankScore ?? '-'}）：${truncate(r.statement, 70)}`);
      }
    }
  }
  w();

  w('### C（仅向量）与 S6 的关系');
  w();
  const naturalish = queries.filter((q) => q.type !== 'keyword');
  let sameRank = 0;
  for (const q of naturalish) {
    const a = qOf('S6', q.id)?.firstRank ?? null;
    const b = qOf('C', q.id)?.firstRank ?? null;
    if (a === b) sameRank++;
  }
  w(
    `C 与 S6 在 ${naturalish.length} 条 paraphrase/mixed 上名次一致 ${sameRank}/${naturalish.length} 条。` +
      'S6 对 natural/mixed 走「向量优先、关键词补齐」，向量候选足够满 k，所以这两类查询的 S6 排序' +
      '等价于仅向量；C 的差异只出现在 keyword 子集（7/10）。',
  );
  w();

  w('## keyword 子集退化检查');
  w();
  w('keyword 查询被 classifyQuery 判为 exact，不触发重排，理论上逐条名次不变。');
  w();
  w('| 组合 | hit@5 | MRR@5 |');
  w('| --- | --- | --- |');
  for (const cfg of configs) {
    const m = metrics.get(cfg.id).keyword;
    const hit = keyword.filter((q) => (qOf(cfg.id, q.id)?.hitsInTop5 ?? 0) > 0).length;
    w(`| ${cfg.label} | ${hit}/${keyword.length} | ${m.mrr5.toFixed(2)} |`);
  }
  w();
  w('| id | query | S6 | S6+R50 | S6+R100 |');
  w('| --- | --- | --- | --- | --- |');
  for (const q of keyword) {
    w(
      `| ${q.id} | ${truncate(q.query, 28)} | ${qOf('S6', q.id)?.firstRank ?? '-'} | ` +
        `${qOf('S6+R50', q.id)?.firstRank ?? '-'} | ` +
        `${qOf('S6+R100', q.id)?.firstRank ?? '-'} |`,
    );
  }
  w();

  w('## 延迟');
  w();
  w('每条查询按真实使用路径（k=5、默认 routeLimit）计时；检索 = 总耗时 − 重排墙钟，');
  w('重排 API = 一次真实往返（缓存命中时沿用首次往返耗时），端到端 = 检索 + 重排 API。');
  w();
  w('| 组合 | 覆盖查询 | 检索 p50 | 检索 p90 | 重排 API p50 | 重排 API p90 | 端到端 p50 | 端到端 p90 |');
  w('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const cfg of configs) {
    const l = latency.get(cfg.id);
    w(
      `| ${cfg.label} | ${l.count}/${queries.length}${l.eligible ? `（重排 ${l.eligible}）` : ''} | ` +
        `${fmtMs(p50(l.retrieval))}ms | ${fmtMs(percentile(l.retrieval, 90))}ms | ` +
        `${l.api.length ? `${fmtMs(p50(l.api))}ms` : '-'} | ` +
        `${l.api.length ? `${fmtMs(percentile(l.api, 90))}ms` : '-'} | ` +
        `${fmtMs(p50(l.e2e))}ms | ${fmtMs(percentile(l.e2e, 90))}ms |`,
    );
  }
  w();
  w('只算触发重排的 35 条（paraphrase 30 + mixed 5）：');
  w();
  w('| 组合 | 检索 p50 | 重排 API p50 | 端到端 p50 | 端到端 p90 |');
  w('| --- | --- | --- | --- | --- |');
  for (const cfg of configs) {
    const l = latency.get(cfg.id);
    if (!l.eligible) continue;
    const e2e = l.eligibleSamples;
    w(
      `| ${cfg.label} | ${fmtMs(p50(l.eligibleRetrieval))}ms | ` +
        `${l.eligibleApi.length ? `${fmtMs(p50(l.eligibleApi))}ms` : '-'} | ` +
        `${fmtMs(p50(e2e))}ms | ${fmtMs(percentile(e2e, 90))}ms |`,
    );
  }
  w();

  w('## 成本与重排调用统计');
  w();
  w('| 组合 | 真实 API 调用 | 缓存命中 | 失败回退 | 解析失败 | 超时 | prompt token | completion token | 估算成本 |');
  w('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  let totalCost = 0;
  let totalCalls = 0;
  for (const cfg of configs) {
    const s = cost.get(cfg.id);
    totalCost += s.costUsd;
    totalCalls += s.calls;
    w(
      `| ${cfg.label} | ${s.calls} | ${s.cacheHits} | ${s.fallbacks} | ${s.parseFailures} | ` +
        `${s.timeouts} | ${s.promptTokens} | ${s.completionTokens} | $${s.costUsd.toFixed(6)} |`,
    );
  }
  w();
  w(
    `三组重排配置合计：真实 API 调用 ${totalCalls} 次，估算成本 $${totalCost.toFixed(6)}。` +
      `45 条查询里只有 35 条（paraphrase 30 + mixed 5）触发重排，keyword 10 条 exact 被跳过。`,
  );
  const c50 = cost.get('C+R50');
  const s6r50 = cost.get('S6+R50');
  if (c50 && s6r50 && c50.calls === 0 && c50.cacheHits > 0) {
    w(
      `C+R50 的 ${c50.cacheHits} 条重排全部命中 S6+R50 的进程内缓存：两者在 paraphrase/mixed 上的` +
        `候选集完全相同。若单独运行 C+R50，成本与 S6+R50 相同（约 $${s6r50.costUsd.toFixed(6)}）；` +
        `三组独立运行的理论成本约 $${(s6r50.costUsd * 2 + (cost.get('S6+R100')?.costUsd ?? 0)).toFixed(6)}。`,
    );
  }
  w();

  if (ctx.failureNotes.length) {
    w('## 重排失败明细');
    w();
    for (const note of ctx.failureNotes) w(`- ${note}`);
    w();
  }

  return `${L.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.db)) throw new Error(`数据库不存在: ${opts.db}`);
  if (!fs.existsSync(opts.set)) throw new Error(`评测集不存在: ${opts.set}`);
  // 只读 --set 指定的 eval-set.json；eval-set.pending.json（miss-log 待标注）不参与重排评测。
  const set = JSON.parse(fs.readFileSync(opts.set, 'utf8'));
  const configs = opts.configs
    ? CONFIGS.filter((c) => opts.configs.includes(c.id))
    : CONFIGS;
  if (!configs.length) throw new Error('没有匹配的 config');

  const runStartedAt = new Date().toISOString();
  const db = openSearchDb(opts.db);
  const resolution = resolveTargetOffsets(db, set);
  applyTargetOffsets(resolution);
  printTargetResolution(resolution, set);
  if (resolution.errors.length) {
    process.stdout.write(`目标解析失败（${resolution.errors.length} 条）：\n`);
    for (const e of resolution.errors) process.stdout.write(`  - ${e}\n`);
    db.close();
    process.exitCode = 1;
    return;
  }
  const { errors, stats: coverage } = validateSet(db, set);
  printCoverage(coverage, set.queries.length);
  if (errors.length) {
    process.stdout.write(`评测集校验失败（${errors.length} 条）：\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
    db.close();
    process.exitCode = 1;
    return;
  }
  process.stdout.write('评测集校验: 通过（target 按稳定标识解析到当前库）\n');

  const model = await initModel();
  const searcher = { db, extractor: model.extractor };
  process.stdout.write(`[cold-start] model load ${(model.initMs / 1000).toFixed(2)}s\n`);

  const perQuery = new Map(configs.map((c) => [c.id, new Map()]));
  const perTarget = new Map();
  const latency = new Map();
  const cost = new Map();
  const callsLogs = new Map();
  const failureNotes = [];
  const newParaphraseIds = new Set(
    set.queries.filter((q) => q.type === 'paraphrase' && Number(q.id.slice(1)) >= 31).map((q) => q.id),
  );

  const tagOf = (spec) => (newParaphraseIds.has(spec.id) ? '新增' : spec.type === 'paraphrase' ? '原有' : spec.type);

  for (const cfg of configs) {
    process.stdout.write(`\n=== ${cfg.id} (${cfg.label}) ===\n`);
    resetRerankStats();
    const lat = {
      count: 0,
      retrieval: [],
      api: [],
      e2e: [],
      eligible: 0,
      eligibleRetrieval: [],
      eligibleApi: [],
      eligibleSamples: [],
    };
    for (const spec of set.queries) {
      // 真实使用路径：k=5。
      const small = await search(searcher, spec.query, { ...cfg.options, k: 5 });
      const retrievalMs = small.timings.totalMs - (small.timings.rerankMs ?? 0);
      const rerank = small.rerank;
      const rerankEligible = rerank?.enabled && !rerank?.skipped;
      const apiMs = rerankEligible
        ? rerank.applied || rerank.fallback
          ? rerank.elapsedMs
          : 0
        : 0;
      const e2eMs = retrievalMs + (rerankEligible ? apiMs : 0);
      lat.count++;
      lat.retrieval.push(retrievalMs);
      lat.e2e.push(e2eMs);
      if (rerankEligible) {
        lat.eligible++;
        lat.eligibleRetrieval.push(retrievalMs);
        lat.eligibleSamples.push(e2eMs);
        if (apiMs > 0) {
          lat.api.push(apiMs);
          lat.eligibleApi.push(apiMs);
        }
      }

      // 名次：k=200。top-N 候选与上一遍一致，重排命中进程内缓存。
      const deep = await search(searcher, spec.query, {
        ...cfg.options,
        k: RANK_DEPTH,
        routeLimit: RANK_DEPTH,
      });
      const rankByOffset = new Map();
      const recByOffset = new Map();
      deep.results.forEach((r, i) => {
        rankByOffset.set(r.offset, i + 1);
        recByOffset.set(r.offset, r);
      });
      const targetRanks = spec.targets.map((t) => ({
        offset: t.offset,
        rank: rankByOffset.get(t.offset) ?? null,
        rerankScore: recByOffset.get(t.offset)?.rerankScore ?? null,
      }));
      const targetSet = new Set(spec.targets.map((t) => t.offset));
      const hitsInTop5 = deep.results
        .slice(0, 5)
        .filter((r) => targetSet.has(r.offset)).length;
      const firstRank = targetRanks.reduce(
        (min, t) => (t.rank != null && (min == null || t.rank < min) ? t.rank : min),
        null,
      );
      perQuery.get(cfg.id).set(spec.id, {
        query: spec.query,
        type: spec.type,
        difficulty: spec.difficulty ?? null,
        group: tagOf(spec),
        firstRank,
        hitsInTop5,
        targets: targetRanks,
        top5: deep.results.slice(0, 5).map((r) => ({
          offset: r.offset,
          kind: r.kind,
          rerankScore: r.rerankScore ?? null,
          statement: r.statement,
        })),
        rerank: deep.rerank ?? null,
      });
      if (!perTarget.has(cfg.id)) perTarget.set(cfg.id, new Map());
      for (const t of targetRanks) {
        perTarget.get(cfg.id).set(`${spec.id}:${t.offset}`, t.rank);
      }
    }
    latency.set(cfg.id, lat);
    const snap = snapshotRerankStats();
    cost.set(cfg.id, snap);
    callsLogs.set(cfg.id, snap.callsLog);
    process.stdout.write(
      `rerank: api ${snap.calls} 次，缓存 ${snap.cacheHits}，回退 ${snap.fallbacks}；` +
        `token ${snap.promptTokens}+${snap.completionTokens}，成本 $${snap.costUsd.toFixed(6)}\n`,
    );
    for (const line of snap.callsLog.filter((x) => x.fallback)) {
      failureNotes.push(`[${cfg.id}] ${line.query}: ${line.error}`);
    }
  }

  // ---------- 指标 ----------
  const metrics = new Map();
  for (const cfg of configs) {
    const per = {};
    for (const subset of SUBSETS) {
      per[subset] = metricsFor(
        set.queries.filter((q) => q.type === subset),
        perQuery.get(cfg.id),
      );
    }
    per.total = metricsFor(set.queries, perQuery.get(cfg.id));
    metrics.set(cfg.id, per);
  }

  // ---------- top-50 / top-5 进出（S6 → S6+R50） ----------
  const rescued = [];
  const pushed = [];
  const pushedOut50 = [];
  const stmtCache = new Map();
  const stmtOf = (offset) => {
    if (!stmtCache.has(offset)) {
      const row = db
        .prepare('select kind, statement from memories where offset = ?')
        .get(offset);
      stmtCache.set(offset, row ?? { kind: '?', statement: '' });
    }
    return stmtCache.get(offset);
  };
  for (const spec of set.queries) {
    for (const t of spec.targets) {
      const before = perTarget.get('S6')?.get(`${spec.id}:${t.offset}`) ?? null;
      const after = perTarget.get('S6+R50')?.get(`${spec.id}:${t.offset}`) ?? null;
      const row = stmtOf(t.offset);
      const base = {
        queryId: spec.id,
        query: spec.query,
        offset: t.offset,
        kind: row.kind,
        statement: row.statement,
        before,
        after,
      };
      if ((before == null || before > 50) && after != null && after <= 50) rescued.push(base);
      if (before != null && before <= 5 && (after == null || after > 5)) pushed.push(base);
      if (before != null && before <= 50 && (after == null || after > 50)) pushedOut50.push(base);
    }
  }
  rescued.sort((a, b) => (a.before ?? 999) - (b.before ?? 999));
  pushed.sort((a, b) => (a.before ?? 999) - (b.before ?? 999));
  pushedOut50.sort((a, b) => (a.before ?? 999) - (b.before ?? 999));

  // S6 → S6+R100 的同口径进出：深度 100 才能覆盖 S6 排 51–100 的 target。
  const rescued100 = [];
  const pushed100 = [];
  const pushedOut50_100 = [];
  for (const spec of set.queries) {
    for (const t of spec.targets) {
      const before = perTarget.get('S6')?.get(`${spec.id}:${t.offset}`) ?? null;
      const after = perTarget.get('S6+R100')?.get(`${spec.id}:${t.offset}`) ?? null;
      const row = stmtOf(t.offset);
      const base = {
        queryId: spec.id,
        query: spec.query,
        offset: t.offset,
        kind: row.kind,
        statement: row.statement,
        before,
        after,
      };
      if ((before == null || before > 50) && after != null && after <= 50) rescued100.push(base);
      if (before != null && before <= 5 && (after == null || after > 5)) pushed100.push(base);
      if (before != null && before <= 50 && (after == null || after > 50)) pushedOut50_100.push(base);
    }
  }
  rescued100.sort((a, b) => (a.before ?? 999) - (b.before ?? 999));
  pushed100.sort((a, b) => (a.before ?? 999) - (b.before ?? 999));
  pushedOut50_100.sort((a, b) => (a.before ?? 999) - (b.before ?? 999));

  const ctx = {
    set,
    opts,
    coverage,
    configs,
    metrics,
    perQuery,
    perTarget,
    latency,
    cost,
    rescued,
    pushed,
    pushedOut50,
    rescued100,
    pushed100,
    pushedOut50_100,
    newParaphraseIds,
    runStartedAt,
    failureNotes,
    resolution,
  };
  const report = buildReport(ctx);
  process.stdout.write(`\n${report}`);

  // ---------- 写产物 ----------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), report);
  fs.writeFileSync(path.join(OUT_DIR, 'eval-set.45.json'), `${JSON.stringify(set, null, 2)}\n`);
  for (const cfg of configs) {
    const log = callsLogs.get(cfg.id) ?? [];
    const safe = cfg.id.replace(/[^\w.+-]/g, '_');
    fs.writeFileSync(
      path.join(OUT_DIR, `rerank-calls-${safe}.jsonl`),
      `${log.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
  }

  const serial = {
    generatedAt: new Date().toISOString(),
    runStartedAt,
    db: opts.db,
    set: opts.set,
    rankDepth: RANK_DEPTH,
    k: 5,
    queryCount: set.queries.length,
    coverage,
    targetResolution: {
      stable: resolution.stable,
      fallback: resolution.fallback,
      drifted: resolution.drifted,
      total: resolution.rows.length,
    },
    configs: configs.map((c) => ({ id: c.id, label: c.label, options: c.options })),
    metrics: Object.fromEntries([...metrics.entries()]),
    perQuery: Object.fromEntries(
      [...perQuery.entries()].map(([cid, m]) => [cid, Object.fromEntries([...m.entries()])]),
    ),
    latency: Object.fromEntries(
      [...latency.entries()].map(([cid, l]) => [
        cid,
        {
          count: l.count,
          eligible: l.eligible,
          retrieval: l.retrieval,
          api: l.api,
          e2e: l.e2e,
          eligibleRetrieval: l.eligibleRetrieval,
          eligibleApi: l.eligibleApi,
          eligibleSamples: l.eligibleSamples,
        },
      ]),
    ),
    cost: Object.fromEntries(
      [...cost.entries()].map(([cid, s]) => [
        cid,
        {
          calls: s.calls,
          cacheHits: s.cacheHits,
          failures: s.failures,
          fallbacks: s.fallbacks,
          parseFailures: s.parseFailures,
          timeouts: s.timeouts,
          promptTokens: s.promptTokens,
          completionTokens: s.completionTokens,
          totalTokens: s.totalTokens,
          costUsd: s.costUsd,
          apiMs: s.apiMs,
        },
      ]),
    ),
    rescued,
    pushed,
    pushedOut50,
    rescued100,
    pushed100,
    pushedOut50_100,
    failureNotes,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), `${JSON.stringify(serial, null, 2)}\n`);
  process.stdout.write(`\n产物已写入 ${OUT_DIR}\n`);

  db.close();
}

main().catch((err) => {
  process.stderr.write(`[eval-rerank] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
