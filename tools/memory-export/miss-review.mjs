#!/usr/bin/env node
/**
 * 失败查询审阅：读 ~/.dsh/memory-export/miss-log.jsonl（mem-search.mjs 追加）。
 *
 * 用法：
 *   node miss-review.mjs --list [--days N]   按 qid 去重，按出现次数降序打印
 *   node miss-review.mjs --stats             总条数、去重后条数、reason 分布、最近 7 天
 *   node miss-review.mjs --append-pending    去重后的 query 追加进 eval-set.pending.json
 *
 * --promote 暂未实现：把 pending 标成正式 case 需要人判断 target（session/seq/kind），
 * 先人工标注，再按 README 的步骤并入 eval-set.json。本脚本不会改 eval-set.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MISS_LOG = path.join(HOME, '.dsh', 'memory-export', 'miss-log.jsonl');
const PENDING = path.join(HERE, 'eval-set.pending.json');
const PENDING_SCHEMA = 'dsh-eval-pending/1';
const DAY_MS = 24 * 60 * 60 * 1000;

function die(msg, code = 1) {
  process.stderr.write(`[miss-review] error: ${msg}\n`);
  process.exit(code);
}

function printHelp() {
  process.stdout.write(`用法: node miss-review.mjs <模式> [选项]

  --list [--days N]   按 qid 去重后打印：次数、最近一次时间、reason、query
  --stats             总条数、去重后条数、按 reason 分布、最近 7 天新增
  --append-pending    把去重后的 query 追加进 ${PENDING}
                      已存在的 qid 不重复加；不改 eval-set.json
  --promote <qid> --session <id> --seq <n> --kind <kind>
                      暂未实现：标注需要人工判断，先保留在 pending
  -h, --help          显示本帮助

日志文件: ${MISS_LOG}
轮转文件 miss-log.1.jsonl 不在本脚本的读取范围内（只读当前文件）。
`);
}

function parseArgs(argv) {
  const opts = { mode: null, days: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.mode = 'list';
    else if (a === '--stats') opts.mode = 'stats';
    else if (a === '--append-pending') opts.mode = 'append-pending';
    else if (a === '--promote') opts.mode = 'promote';
    else if (a === '--days') {
      const v = argv[++i];
      if (v == null) die('--days 缺少参数值');
      opts.days = Number(v);
      if (!Number.isInteger(opts.days) || opts.days < 1) die(`--days 必须是正整数，收到 ${v}`);
    } else if (a === '--help' || a === '-h') {
      opts.mode = 'help';
    } else {
      die(`未知参数 ${a}（--help 查看用法）`);
    }
  }
  if (!opts.mode) {
    printHelp();
    process.exit(1);
  }
  return opts;
}

/* ------------------------------ miss log -------------------------------- */

/** 与 mem-search.mjs 的 normalizeMissQuery 保持一致。 */
function normalizeMissQuery(query) {
  return String(query ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 与 mem-search.mjs 的 missQueryId 保持一致。 */
function missQueryId(query) {
  return crypto.createHash('sha1').update(normalizeMissQuery(query), 'utf8').digest('hex');
}

function readMissLog() {
  let text;
  try {
    text = fs.readFileSync(MISS_LOG, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { records: [], invalid: 0 };
    throw err;
  }
  const records = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      invalid++;
      continue;
    }
    if (!entry || typeof entry.query !== 'string' || !entry.query.trim()) {
      invalid++;
      continue;
    }
    records.push({
      ...entry,
      qid: typeof entry.qid === 'string' && entry.qid ? entry.qid : missQueryId(entry.query),
    });
  }
  return { records, invalid };
}

function tsValue(ts) {
  const n = Date.parse(String(ts ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** 按 qid 去重；count 为出现次数，latest 为 ts 最大的一条（同 ts 取后出现的）。 */
function dedupe(records) {
  const byQid = new Map();
  for (const rec of records) {
    let entry = byQid.get(rec.qid);
    if (!entry) {
      entry = { qid: rec.qid, query: rec.query, count: 0, latest: rec };
      byQid.set(rec.qid, entry);
    }
    entry.count++;
    if (tsValue(rec.ts) >= tsValue(entry.latest.ts)) {
      entry.latest = rec;
      entry.query = rec.query;
    }
  }
  return [...byQid.values()].sort(
    (a, b) =>
      b.count - a.count ||
      tsValue(b.latest.ts) - tsValue(a.latest.ts) ||
      a.qid.localeCompare(b.qid),
  );
}

function filterSince(records, days) {
  if (days == null) return records;
  const cutoff = Date.now() - days * DAY_MS;
  return records.filter((rec) => tsValue(rec.ts) >= cutoff);
}

/* -------------------------------- modes --------------------------------- */

function modeList(opts) {
  const { records, invalid } = readMissLog();
  if (invalid) process.stderr.write(`[miss-review] warn: 跳过 ${invalid} 行无法解析/缺 query\n`);
  const scoped = filterSince(records, opts.days);
  const entries = dedupe(scoped);
  const scope = opts.days == null ? '全部' : `最近 ${opts.days} 天`;

  process.stdout.write(`miss-log: ${MISS_LOG}\n`);
  process.stdout.write(
    `${scope}: ${scoped.length} 条记录，去重后 ${entries.length} 条` +
      `${records.length === 0 ? '（文件不存在或为空）' : ''}\n`,
  );
  if (entries.length === 0) return;

  process.stdout.write('\n');
  process.stdout.write(
    `${'次数'.padEnd(4)}  ${'最近一次'.padEnd(24)}  ${'reason'.padEnd(15)}  query\n`,
  );
  for (const e of entries) {
    process.stdout.write(
      `${String(e.count).padEnd(4)}  ${String(e.latest.ts ?? '-').padEnd(24)}  ` +
        `${String(e.latest.reason ?? '-').padEnd(15)}  ${e.query.replace(/\s+/g, ' ')}\n`,
    );
  }
}

function modeStats() {
  const { records, invalid } = readMissLog();
  if (invalid) process.stderr.write(`[miss-review] warn: 跳过 ${invalid} 行无法解析/缺 query\n`);
  const entries = dedupe(records);
  const recent = filterSince(records, 7);
  const recentUnique = dedupe(recent);
  const reasons = new Map();
  for (const rec of records) {
    const reason = String(rec.reason ?? '-');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  process.stdout.write(`miss-log: ${MISS_LOG}\n`);
  process.stdout.write(`总条数: ${records.length}\n`);
  process.stdout.write(`去重后: ${entries.length}\n`);
  process.stdout.write('按 reason 分布:\n');
  if (reasons.size === 0) {
    process.stdout.write('  （无记录）\n');
  } else {
    for (const [reason, count] of [...reasons].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      process.stdout.write(`  ${reason}: ${count}\n`);
    }
  }
  process.stdout.write(
    `最近 7 天: ${recent.length} 条记录（去重后 ${recentUnique.length} 个查询）\n`,
  );
}

function readPending() {
  let text;
  try {
    text = fs.readFileSync(PENDING, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { schema: PENDING_SCHEMA, entries: [] };
    throw err;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    die(`pending 文件不是合法 JSON，拒绝覆盖: ${PENDING}（${err.message}）`);
  }
  if (!obj || !Array.isArray(obj.entries)) {
    die(`pending 文件缺少 entries 数组，拒绝覆盖: ${PENDING}`);
  }
  if (obj.schema && obj.schema !== PENDING_SCHEMA) {
    die(`pending 文件 schema=${obj.schema}，期望 ${PENDING_SCHEMA}，拒绝覆盖: ${PENDING}`);
  }
  return { ...obj, schema: obj.schema ?? PENDING_SCHEMA, entries: obj.entries };
}

function modeAppendPending() {
  const { records, invalid } = readMissLog();
  if (invalid) process.stderr.write(`[miss-review] warn: 跳过 ${invalid} 行无法解析/缺 query\n`);
  if (records.length === 0) {
    process.stdout.write(`miss-log 无记录（${MISS_LOG}），未创建 pending。\n`);
    return;
  }

  const pending = readPending();
  const existing = new Set(
    pending.entries
      .map((entry) => entry?.qid ?? (entry?.query ? missQueryId(entry.query) : null))
      .filter(Boolean),
  );
  const addedAt = new Date().toISOString();
  const added = [];
  for (const entry of dedupe(records)) {
    if (existing.has(entry.qid)) continue;
    existing.add(entry.qid);
    added.push({
      qid: entry.qid,
      query: entry.query,
      addedAt,
      source: 'miss-log',
      targets: [],
      status: 'unlabeled',
    });
  }

  if (added.length === 0) {
    process.stdout.write(
      `没有新增：${pending.entries.length} 条 query 已在 pending 里（${PENDING}）\n`,
    );
    return;
  }

  const output = {
    schema: PENDING_SCHEMA,
    entries: [...pending.entries, ...added],
  };
  const tmp = `${PENDING}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, PENDING);
  process.stdout.write(
    `已追加 ${added.length} 条；跳过已存在 ${existing.size - added.length} 条；` +
      `pending 共 ${output.entries.length} 条 → ${PENDING}\n`,
  );
}

/* -------------------------------- main ---------------------------------- */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help') {
    printHelp();
    return;
  }
  if (opts.mode === 'list') modeList(opts);
  else if (opts.mode === 'stats') modeStats();
  else if (opts.mode === 'append-pending') modeAppendPending();
  else if (opts.mode === 'promote') {
    process.stderr.write(
      '[miss-review] error: --promote 暂未实现。标注 target 需要人工判断；' +
        'pending 里的 query 先保持未标注，按 README「失败查询收集」的步骤人工并入 eval-set.json。\n',
    );
    process.exit(2);
  }
}

main();
