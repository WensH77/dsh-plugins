#!/usr/bin/env node
// 一键增量刷新：export → distill（增量）→ embed（按 mem_id 增量）→ build-db --rebuild
// → dedupe --write → status。锁、日志、失败即停都在这一层处理；各步骤的产物格式由各自脚本负责。
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(homedir(), '.dsh', 'memory-export');
const LOG_PATH = join(OUT_DIR, 'refresh.log');
const LOCK_PATH = join(OUT_DIR, 'refresh.lock');
const DB_PATH = join(OUT_DIR, 'memory.db');
const DUPLICATES_PATH = join(OUT_DIR, 'duplicates.jsonl');
const DEFAULT_DEDUPE_THRESHOLD = 0.9;
// 锁文件里没有可用 pid 时，按 mtime 判断是否过期；有 pid 时以进程是否存活为准。
const LOCK_STALE_MS = 30 * 60 * 1000;
const FAIL_TAIL_LINES = 20;
const DEFAULT_MIN_IDLE_MINUTES = 30;

const USAGE = `用法: node refresh.mjs [选项]

  --dry-run             只读探测：export --dry-run + distill --dry-run，报告将导出/将蒸/pending
                        计数与是否需要 embed；不写锁、不写日志、不改库
  --full-embed          忽略已有向量全部重新编码（兜底；正常按 mem_id 增量）
  --skip-embed          跳过向量化与建库，库保持上次状态（memories 可能领先于库）
  --skip-dedupe         跳过去重标记步骤（不更新 ${DUPLICATES_PATH}）
  --dedupe-threshold N  去重标记阈值（余弦 >= N），默认 ${DEFAULT_DEDUPE_THRESHOLD}
  --no-distill          跳过蒸馏；此时 memories 视为未变，只导出、编码、重建库、打印状态
  --no-subagents        导出时不包含子代理会话（默认包含，子代理会话的 user 消息会标成 task-brief）
  --min-idle-minutes N  透传给 distill，会话最后事件距今 >= N 分钟才算已归档，默认 ${DEFAULT_MIN_IDLE_MINUTES}
  -h, --help            显示本帮助

步骤：export → distill → embed（按 mem_id 增量，只编码新增/变更）
      → build-db --rebuild → dedupe --write → distill --status
锁：  ${LOCK_PATH}；进程存活或 mtime 未超过 30 分钟时拒绝第二次运行，结束（含失败/中断）自动清理。
日志：${LOG_PATH}，每步一行耗时与关键计数；失败写步骤名并附 stderr 末尾 ${FAIL_TAIL_LINES} 行。
`;

function nowIso() {
  return new Date().toISOString();
}

function fmtMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

let logEnabled = true;

function appendLog(line) {
  if (!logEnabled) return;
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${nowIso()} ${line}\n`);
  } catch (err) {
    process.stderr.write(`[refresh] warn: 写日志失败: ${err.message}\n`);
  }
}

function logBlock(label, text) {
  const lines = String(text ?? '').trimEnd().split('\n').slice(-FAIL_TAIL_LINES);
  for (const line of lines) appendLog(`${label} | ${line}`);
  return lines.join('\n');
}

function fail(msg, code = 1) {
  process.stderr.write(`[refresh] error: ${msg}\n`);
  process.exitCode = code;
  throw new Error(msg);
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    skipEmbed: false,
    noDistill: false,
    fullEmbed: false,
    skipDedupe: false,
    dedupeThreshold: DEFAULT_DEDUPE_THRESHOLD,
    minIdleMinutes: DEFAULT_MIN_IDLE_MINUTES,
    includeSubagents: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-embed') opts.skipEmbed = true;
    else if (a === '--no-distill') opts.noDistill = true;
    else if (a === '--full-embed') opts.fullEmbed = true;
    else if (a === '--skip-dedupe') opts.skipDedupe = true;
    else if (a === '--no-subagents') opts.includeSubagents = false;
    else if (a === '--dedupe-threshold') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= -1 || n >= 1) {
        fail(`--dedupe-threshold 需在 (-1, 1) 内，收到 ${v}`);
      }
      opts.dedupeThreshold = n;
    } else if (a === '--min-idle-minutes') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(`--min-idle-minutes 需为 >=0 的数字，收到 ${v}`);
      opts.minIdleMinutes = n;
    } else if (a === '-h' || a === '--help') opts.help = true;
    else fail(`未知参数: ${a}（--help 查看用法）`);
  }
  return opts;
}

// 最后一条可解析的 JSON 行；export/distill/embed 的 stdout 汇总都是单行 JSON。
function parseLastJson(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* 继续找上一行 */ }
  }
  return null;
}

function runStep(label, script, args, { stream = true } = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, [join(HERE, script), ...args], {
    cwd: HERE,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stream) process.stderr.write(d);
  });
  return new Promise((resolve) => {
    child.on('error', (err) => {
      resolve({
        label, ok: false, code: null, signal: null, error: err,
        stdout, stderr: `${stderr}${err?.stack || err}\n`, elapsedMs: performance.now() - started,
      });
    });
    child.on('close', (code, signal) => resolve({
      label, ok: code === 0, code, signal, stdout, stderr, elapsedMs: performance.now() - started,
    }));
  });
}

function stepFailed(res, detail = '') {
  const status = res.code != null ? `exit=${res.code}` : `signal=${res.signal ?? 'unknown'}`;
  const line = `step=${res.label} failed ${status} elapsed=${fmtMs(res.elapsedMs)}${detail ? ` ${detail}` : ''}`;
  appendLog(line);
  const tail = logBlock(`${res.label} stderr tail`, res.stderr);
  process.stderr.write(`\n[refresh] 失败：${line}\n${tail}\n`);
  return new Error(line);
}

function requireOk(res, detail = '') {
  if (!res.ok) throw stepFailed(res, detail);
  return res;
}

/* ---------------------------------- 锁 ---------------------------------- */

function readLockInfo() {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* 损坏或非 JSON */ }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function lockIsActive(info, st) {
  if (info && Number.isInteger(info.pid) && info.pid > 0) return pidAlive(info.pid);
  if (!st) return false;
  return Date.now() - st.mtimeMs < LOCK_STALE_MS;
}

function acquireLock() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeFileSync(fd, `${JSON.stringify({
        pid: process.pid,
        startedAt: nowIso(),
        cwd: process.cwd(),
        args: process.argv.slice(2),
      })}\n`);
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const st = statSync(LOCK_PATH, { throwIfNoEntry: false });
      const info = readLockInfo();
      if (lockIsActive(info, st)) {
        const holder = info
          ? `pid=${info.pid} 开始于 ${info.startedAt ?? '未知'}`
          : '锁文件无法解析';
        process.stderr.write(
          `[refresh] 另一个刷新正在运行（${holder}，锁 ${LOCK_PATH}），本次退出\n`,
        );
        appendLog(`refresh skipped lock-held ${info ? JSON.stringify(info) : 'unparsable'}`);
        return false;
      }
      process.stderr.write(`[refresh] 清理过期锁 ${LOCK_PATH}\n`);
      appendLog('refresh stale-lock removed');
      try { unlinkSync(LOCK_PATH); } catch { /* 可能刚被别的进程删掉 */ }
    }
  }
  process.stderr.write(`[refresh] 无法获取锁，本次退出（${LOCK_PATH}）\n`);
  appendLog('refresh aborted lock-acquire-failed');
  return false;
}

function releaseLock() {
  const info = readLockInfo();
  // 只删自己持有的锁：过期清理后可能已被另一个进程重建。
  if (!info || info.pid !== process.pid) return;
  try { unlinkSync(LOCK_PATH); } catch { /* 已被清理 */ }
}

/* --------------------------------- 辅助 --------------------------------- */

function countDbMemories() {
  if (!existsSync(DB_PATH)) return null;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      return Number(db.prepare('select count(*) as c from memories').get()?.c);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function buildDbCounts(stdout) {
  return {
    memories: Number(/记忆条数\s+(\d+)/.exec(stdout)?.[1] ?? NaN),
    fts: Number(/关键词索引\s+(\d+)/.exec(stdout)?.[1] ?? NaN),
    vectors: Number(/向量索引\s+(\d+)/.exec(stdout)?.[1] ?? NaN),
    dbSize: /DB 体积\s+(.+)$/m.exec(stdout)?.[1]?.trim() ?? null,
    buildSeconds: /建库耗时\s+([\d.]+)s/.exec(stdout)?.[1] ?? null,
  };
}

function printPlan(opts) {
  const s = (name) => join(HERE, name);
  const lines = [
    '[refresh] 计划：',
    `  1 导出    node ${s('export-sessions.mjs')}`,
    opts.noDistill
      ? '  2 蒸馏    跳过（--no-distill）'
      : `  2 蒸馏    node ${s('distill.mjs')} --min-idle-minutes ${opts.minIdleMinutes}`,
    opts.skipEmbed
      ? '  3 向量化  跳过（--skip-embed）'
      : `  3 向量化  node ${s('embed.mjs')}${opts.fullEmbed ? ' --force（--full-embed）' : '（按 mem_id 增量）'}`,
    opts.skipEmbed
      ? '  4 建库    跳过（--skip-embed，库保持上次状态）'
      : `  4 建库    node ${s('build-db.mjs')} --rebuild`,
    opts.skipDedupe
      ? '  5 去重    跳过（--skip-dedupe）'
      : `  5 去重    node ${s('dedupe-stats.mjs')} --write --threshold ${opts.dedupeThreshold}`,
    `  6 状态    node ${s('distill.mjs')} --status --min-idle-minutes ${opts.minIdleMinutes}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}


// 向量与记忆是否对齐由 embed.mjs / build-db.mjs 按 mem_id 自己校验：embed 只编码
// 新增/变更，build-db 按 mem_id 对齐 meta 与向量，不再需要 refresh 重算全量。
function vectorsMetaHasMemId() {
  const metaPath = join(OUT_DIR, 'vectors.meta.jsonl');
  if (!existsSync(metaPath)) return false;
  try {
    const first = readFileSync(metaPath, 'utf8').split('\n').find((line) => line.trim());
    return Boolean(first && JSON.parse(first).mem_id);
  } catch {
    return false;
  }
}

/* --------------------------------- 主流程 -------------------------------- */

async function runPipeline(opts, memoriesBefore) {
  const t0 = performance.now();

  // 1) export
  process.stdout.write(`[refresh] 1/6 export: node ${join(HERE, 'export-sessions.mjs')}\n`);
  const expRes = requireOk(await runStep('export', 'export-sessions.mjs',
    opts.includeSubagents ? ['--include-subagents'] : []));
  const exp = parseLastJson(expRes.stdout);
  if (!exp) throw stepFailed(expRes, '无法解析 export 汇总 JSON');
  const expCounts = `files=${exp.files} exported=${exp.exported} unchanged=${exp.unchanged}`
    + ` skipped_subagent=${exp.skippedSubagent} skipped_no_user=${exp.skippedNoUser} failed=${exp.failed}`;
  process.stdout.write(`[refresh] export 完成 ${fmtMs(expRes.elapsedMs)}  ${expCounts}\n`);
  appendLog(`step=export ok elapsed=${fmtMs(expRes.elapsedMs)} ${expCounts}`);

  // 2) distill
  let dst = null;
  let distillFailed = false;
  if (opts.noDistill) {
    process.stdout.write('[refresh] 2/6 distill 跳过（--no-distill）\n');
    appendLog('step=distill skipped reason=--no-distill');
  } else {
    process.stdout.write(
      `[refresh] 2/6 distill: node ${join(HERE, 'distill.mjs')} --min-idle-minutes ${opts.minIdleMinutes}\n`,
    );
    const dstRes = await runStep('distill', 'distill.mjs', ['--min-idle-minutes', String(opts.minIdleMinutes)]);
    dst = parseLastJson(dstRes.stdout);
    const dstCounts = dst
      ? `sessions=${dst.sessions} succeeded=${dst.succeeded} failed=${dst.failed} memories=${dst.memories}`
        + ` invalid=${dst.invalid} new_sessions=${dst.newSessions} redistilled=${dst.redistilled}`
        + ` boosted=${dst.boosted} pending=${dst.pending} unchanged=${dst.unchanged}`
        + ` input_tokens=${dst.inputTokens} output_tokens=${dst.outputTokens}`
        + ` cost_usd=${dst.estimatedCostUsd}`
      : '（无法解析汇总 JSON）';
    if (!dstRes.ok || !dst) {
      // 部分会话失败（网络/API 抖动）时不再中止整条管线：已成功的会话产物已落盘，
      // 继续编码与建库，保证库与 memories 一致；失败项留在状态表，下次 refresh 自动重试。
      distillFailed = true;
      const status = dstRes.code != null ? `exit=${dstRes.code}` : `signal=${dstRes.signal ?? 'unknown'}`;
      process.stdout.write(`[refresh] distill 部分失败（${status}），继续编码/建库：${dstCounts}\n`);
      appendLog(`step=distill partial ${status} elapsed=${fmtMs(dstRes.elapsedMs)} ${dstCounts}`);
      if (dstRes.stderr) logBlock('distill stderr', dstRes.stderr);
    } else {
      process.stdout.write(`[refresh] distill 完成 ${fmtMs(dstRes.elapsedMs)}  ${dstCounts}\n`);
      appendLog(`step=distill ok elapsed=${fmtMs(dstRes.elapsedMs)} ${dstCounts}`);
    }
  }

  // distill 有产物时记录信号（只用于日志，embed 不再依赖它决定是否运行）。
  const embedSignal = dst ? dst.succeeded + dst.redistilled + dst.boosted : 0;

  // 3) embed：按 mem_id 增量，没变化时不加载模型；--full-embed 用 --force 兜底全量。
  let embedRan = false;
  let embedCounts = '';
  let embedEncoded = 0;
  let embedDeleted = 0;
  if (opts.skipEmbed) {
    process.stdout.write('[refresh] 3/6 embed 跳过（--skip-embed）\n');
    appendLog('step=embed skipped reason=--skip-embed');
  } else {
    const args = opts.fullEmbed ? ['--force'] : [];
    const mode = opts.fullEmbed ? '--full-embed（--force）' : '按 mem_id 增量';
    process.stdout.write(
      `[refresh] 3/6 embed: node ${join(HERE, 'embed.mjs')} ${mode}\n`,
    );
    appendLog(`step=embed start mode=${opts.fullEmbed ? 'full' : 'incremental'} distill_signal=${embedSignal}`);
    const embRes = requireOk(await runStep('embed', 'embed.mjs', args));
    const emb = parseLastJson(embRes.stdout);
    if (!emb) throw stepFailed(embRes, '无法解析 embed 汇总 JSON');
    embedEncoded = Number(emb.encoded ?? 0);
    embedDeleted = Number(emb.deleted ?? 0);
    embedRan = embedEncoded > 0;
    embedCounts = `total=${emb.total} encoded=${emb.encoded} reused=${emb.reused} deleted=${emb.deleted}`
      + ` items_per_second=${emb.itemsPerSecond} encode_ms=${emb.encodeMs}`
      + ` validation_errors=${(emb.validation?.nonFinite ?? 0) + (emb.validation?.dimMismatch ?? 0) + (emb.validation?.normOutOfTolerance ?? 0)}`;
    process.stdout.write(`[refresh] embed 完成 ${fmtMs(embRes.elapsedMs)}  ${embedCounts}\n`);
    appendLog(`step=embed ok mode=${opts.fullEmbed ? 'full' : 'incremental'} elapsed=${fmtMs(embRes.elapsedMs)} ${embedCounts}`);
  }

  // 4) build-db
  let after = memoriesBefore;
  if (opts.skipEmbed) {
    process.stdout.write('[refresh] 4/6 build-db 跳过：--skip-embed 时库保持上次状态\n');
    appendLog('step=build-db skipped reason=--skip-embed');
  } else {
    process.stdout.write(`[refresh] 4/6 build-db: node ${join(HERE, 'build-db.mjs')} --rebuild\n`);
    const dbRes = requireOk(await runStep('build-db', 'build-db.mjs', ['--rebuild']));
    const db = buildDbCounts(dbRes.stdout);
    if (!Number.isFinite(db.memories)) throw stepFailed(dbRes, '无法解析 build-db 记忆条数');
    after = db.memories;
    const dbCounts = `memories=${db.memories} fts=${db.fts} vectors=${db.vectors}`
      + ` db=${db.dbSize} build_seconds=${db.buildSeconds}`;
    process.stdout.write(`[refresh] build-db 完成 ${fmtMs(dbRes.elapsedMs)}  ${dbCounts}\n`);
    appendLog(`step=build-db ok elapsed=${fmtMs(dbRes.elapsedMs)} ${dbCounts}`);
  }

  // 5) dedupe：只标记不删除。向量没变且标记文件已存在时跳过（全量两两约 24s）。
  let dedupeRan = false;
  let dedupeCounts = '';
  const vectorChanged = !opts.skipEmbed
    && (opts.fullEmbed || embedEncoded > 0 || embedDeleted > 0);
  if (opts.skipDedupe) {
    process.stdout.write('[refresh] 5/6 dedupe 跳过（--skip-dedupe）\n');
    appendLog('step=dedupe skipped reason=--skip-dedupe');
  } else if (!vectorChanged && existsSync(DUPLICATES_PATH)) {
    process.stdout.write(
      `[refresh] 5/6 dedupe 跳过：向量未变化且 ${DUPLICATES_PATH} 已存在\n`,
    );
    appendLog('step=dedupe skipped reason=vectors-unchanged');
  } else {
    const args = [
      '--write',
      '--json',
      '--threshold', String(opts.dedupeThreshold),
    ];
    process.stdout.write(
      `[refresh] 5/6 dedupe: node ${join(HERE, 'dedupe-stats.mjs')} ${args.join(' ')}\n`,
    );
    const ddRes = requireOk(await runStep('dedupe', 'dedupe-stats.mjs', args, { stream: false }));
    const dd = parseLastJson(ddRes.stdout);
    if (!dd) throw stepFailed(ddRes, '无法解析 dedupe 汇总 JSON');
    dedupeRan = true;
    dedupeCounts = `records=${dd.records} pairs=${dd.pairs} new_pairs=${dd.newPairs}`
      + ` total_marked=${dd.totalMarkedPairs} clusters=${dd.clusters} sim_max=${dd.simMax}`
      + ` file=${dd.duplicatesFile}`;
    process.stdout.write(`[refresh] dedupe 完成 ${fmtMs(ddRes.elapsedMs)}  ${dedupeCounts}\n`);
    appendLog(`step=dedupe ok threshold=${opts.dedupeThreshold} elapsed=${fmtMs(ddRes.elapsedMs)} ${dedupeCounts}`);
  }

  // 6) status
  process.stdout.write(`[refresh] 6/6 status: node ${join(HERE, 'distill.mjs')} --status\n`);
  const stRes = requireOk(await runStep('status', 'distill.mjs', ['--status', '--min-idle-minutes', String(opts.minIdleMinutes)], { stream: false }));
  const st = parseLastJson(stRes.stdout);
  if (!st) throw stepFailed(stRes, '无法解析 status JSON');
  const stCounts = `exported=${st.exportedSessions} archived_ok=${st.archivedOk}`
    + ` archived_failed=${st.archivedFailed} pending=${st.pending} changed=${st.changed}`
    + ` unchanged=${st.unchanged} orphans=${st.orphans}`;
  process.stdout.write(`[refresh] status ${fmtMs(stRes.elapsedMs)}  ${stCounts}\n`);
  appendLog(`step=status ok elapsed=${fmtMs(stRes.elapsedMs)} ${stCounts}`);

  const totalMs = performance.now() - t0;
  return {
    totalMs,
    after,
    embedRan,
    embedCounts,
    embedEncoded,
    embedDeleted,
    dedupeRan,
    dedupeCounts,
    distillFailed,
    costUsd: dst?.estimatedCostUsd ?? 0,
    inputTokens: dst?.inputTokens ?? 0,
    outputTokens: dst?.outputTokens ?? 0,
    status: st,
  };
}

async function dryRun(opts) {
  logEnabled = false;
  const t0 = performance.now();
  process.stdout.write('[refresh] dry-run：只读探测，不写锁、不写日志、不改库\n');
  printPlan(opts);
  const nowCount = countDbMemories();
  process.stdout.write(`[refresh] 当前库：${nowCount == null ? '不存在或无法读取' : `${nowCount} 条记忆`}\n`);

  if (opts.noDistill) {
    process.stdout.write('[refresh] export 探测：跳过蒸馏时用 export --dry-run 确认增量\n');
  }
  const expRes = await runStep('export', 'export-sessions.mjs',
    opts.includeSubagents ? ['--dry-run', '--include-subagents'] : ['--dry-run'], { stream: false });
  if (!expRes.ok) throw stepFailed(expRes, 'export --dry-run');
  const exp = parseLastJson(expRes.stdout);
  if (!exp) throw stepFailed(expRes, '无法解析 export 汇总 JSON');
  process.stdout.write(
    `[refresh] export 探测：files=${exp.files} 将导出=${exp.exported} unchanged=${exp.unchanged}`
    + ` skipped_subagent=${exp.skippedSubagent} skipped_no_user=${exp.skippedNoUser} failed=${exp.failed}`,
  );
  process.stdout.write(`（${fmtMs(expRes.elapsedMs)}）\n`);

  let willDistill = 0;
  let fresh = 0;
  let redistill = 0;
  let pending = 0;
  let unchanged = 0;
  if (!opts.noDistill) {
    const dstRes = await runStep(
      'distill', 'distill.mjs',
      ['--dry-run', '--min-idle-minutes', String(opts.minIdleMinutes)],
      { stream: false },
    );
    if (!dstRes.ok) throw stepFailed(dstRes, 'distill --dry-run');
    const m = /将蒸=(\d+)（新会话=(\d+) 重蒸=(\d+)） pending=(\d+) unchanged=(\d+)/
      .exec(dstRes.stderr);
    if (!m) throw stepFailed(dstRes, '无法解析 distill --dry-run 增量计数');
    willDistill = Number(m[1]);
    fresh = Number(m[2]);
    redistill = Number(m[3]);
    pending = Number(m[4]);
    unchanged = Number(m[5]);
    process.stdout.write(
      `[refresh] distill 探测（基于已导出产物）：将蒸=${willDistill} 新会话=${fresh}`
      + ` 重蒸=${redistill} pending=${pending} unchanged=${unchanged}`
      + `（${fmtMs(dstRes.elapsedMs)}）\n`,
    );
  }

  // embed 现在是按 mem_id 增量：没变化时只读 meta 比对，不加载模型，因此 dry-run 不再
  // 需要精确预测「会编码几条」，只报告会不会真的动向量。
  let needEmbed;
  let reason;
  if (opts.skipEmbed) {
    needEmbed = false;
    reason = '--skip-embed';
  } else if (!vectorsMetaHasMemId()) {
    needEmbed = true;
    reason = 'vectors.meta.jsonl 没有 mem_id（升级前产物），首次增量运行会全量重编码';
  } else if (opts.noDistill) {
    needEmbed = false;
    reason = '--no-distill，memories 视为未变，增量检查后预计无需编码';
  } else if (willDistill > 0) {
    needEmbed = true;
    reason = `distill 将处理 ${willDistill} 个会话，embed 会增量编码新增/变更`;
  } else {
    needEmbed = false;
    reason = `distill 将蒸 0 个会话（pending ${pending} 个尚未归档），增量检查后预计无需编码`;
  }
  process.stdout.write(`[refresh] 是否需要 embed：${needEmbed ? '是' : '否'}（${reason}）\n`);
  if (!opts.noDistill && exp.exported > 0) {
    process.stdout.write(
      `[refresh] 注：export 会写入 ${exp.exported} 个会话文件（新增或版本变化），`
      + '它们在 export 之后才进入蒸馏判定；若其中含已归档会话，真实运行时待蒸数会更高。\n',
    );
  }
  process.stdout.write(`[refresh] dry-run 完成 探测耗时 ${fmtMs(performance.now() - t0)}\n`);
}

async function main() {
  const t0 = performance.now();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (opts.dryRun) {
    try {
      await dryRun(opts);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('step=')) {
        appendLog(`refresh dry-run failed unexpected: ${err?.stack || err}`);
      }
      process.exitCode = 1;
    }
    return;
  }

  if (!acquireLock()) return;

  const memoriesBefore = countDbMemories();
  appendLog(
    `refresh start pid=${process.pid} min_idle_minutes=${opts.minIdleMinutes}`
    + ` skip_embed=${opts.skipEmbed} no_distill=${opts.noDistill}`
    + ` memories_before=${memoriesBefore ?? 'unknown'}`,
  );

  const onSignal = (sig) => {
    appendLog(`refresh interrupted signal=${sig}`);
    releaseLock();
    process.exit(130);
  };
  const handlers = { SIGINT: onSignal, SIGTERM: onSignal, SIGHUP: onSignal };
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);

  let exitCode = 0;
  try {
    const out = await runPipeline(opts, memoriesBefore);
    const total = performance.now() - t0;
    const outcome = out.distillFailed ? 'partial' : 'ok';
    appendLog(
      `refresh done ${outcome} total=${fmtMs(total)} embed=${out.embedRan ? 'yes' : 'no'}`
      + ` encoded=${out.embedEncoded} deleted=${out.embedDeleted} dedupe=${out.dedupeRan ? 'yes' : 'no'}`
      + ` memories_before=${memoriesBefore ?? 'unknown'} memories_after=${out.after ?? 'unknown'}`
      + ` cost_usd=${out.costUsd}`,
    );
    if (out.distillFailed) {
      exitCode = 1;
      process.stdout.write(
        '[refresh] 警告：部分会话蒸馏失败，已用成功的部分完成编码与建库；'
        + '失败项保留在状态表，下次运行会自动重试。\n',
      );
    }
    const delta = memoriesBefore == null || out.after == null ? '?' : `${memoriesBefore} → ${out.after}`;
    process.stdout.write(
      `[refresh] 完成：总耗时 ${fmtMs(total)}，记忆 ${delta}，`
      + `蒸馏成本 $${Number(out.costUsd).toFixed(6)}（input ${out.inputTokens} / output ${out.outputTokens} tokens）\n`,
    );
    if (!out.embedRan) {
      process.stdout.write('[refresh] 本次没有重编码向量（增量检查后没有新增/变更）。\n');
    }
    if (out.dedupeRan) {
      process.stdout.write(`[refresh] 去重标记：${out.dedupeCounts}\n`);
    }
    process.stdout.write(`[refresh] 日志：${LOG_PATH}\n`);
  } catch (err) {
    if (!String(err?.message || '').startsWith('step=')) {
      appendLog(`refresh failed unexpected: ${err?.stack || err}`);
      process.stderr.write(`[refresh] 异常终止：${err?.stack || err}\n`);
    }
    exitCode = 1;
  } finally {
    for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
    releaseLock();
  }
  process.exitCode = exitCode;
}

main().catch((err) => {
  process.stderr.write(`[refresh] fatal: ${err?.stack || err}\n`);
  process.exitCode = 1;
});
