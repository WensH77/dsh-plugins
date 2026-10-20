#!/usr/bin/env node
/**
 * 记忆检索库构建层：把 memories/*.json + vectors.bin + vectors.meta.jsonl 装进
 * ~/.dsh/memory-export/memory.db（SQLite），供 mem-search.mjs 查询。
 *
 * 用法：
 *   node build-db.mjs                 # 已有库且校验通过时跳过，否则重建
 *   node build-db.mjs --rebuild       # 全量重建（先写临时库，再原子替换）
 *   node build-db.mjs --vectors ~/.dsh/memory-export/vectors-ev.bin \
 *                     --out ~/.dsh/memory-export/memory-ev.db
 *                                    # 用指定向量文件建独立库
 *
 * 库结构：
 *   memories(offset UNIQUE, mem_id PK, id_int UNIQUE, session_id, cwd, kind, seq, time,
 *            statement, evidence, tags, text_len, text_sha256)
 *   mem_fts  contentless FTS5，只索引 statement 的 CJK 重叠 bigram 展开结果（rowid=offset）
 *   mem_vec  vec0(float[1024])，rowid = mem_id 前 16 位十六进制转 int64（清符号位）
 *
 * 约定：
 *   - mem_id 是身份（定义见 mem-id.mjs），id_int 是它在 vec0/FTS 里的整数 rowid；
 *     offset 只是排序/展示列，重建时按 meta 行号重新赋值，不承担身份。
 *   - 记忆与向量按 mem_id 对齐：meta 里必须有 mem_id/text_sha256，条数必须与 memories 一致。
 *   - 建表前设置 auto_vacuum=INCREMENTAL 与 journal_mode=WAL。
 *   - sqlite-vec 走 node:sqlite 的 loadExtension；rowid 用 BigInt 绑定
 *     （node:sqlite 把 JS number 绑成 REAL，vec0 会报 "Only integers are allowed"）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import {
  assignMemIds,
  assertRowidUnique,
  memIdToRowid,
  textSha256,
} from './mem-id.mjs';

const HOME = os.homedir();
const DEFAULT_OUT_DIR = path.join(HOME, '.dsh', 'memory-export');
const DEFAULT_MEMORIES_DIR = path.join(DEFAULT_OUT_DIR, 'memories');
const DEFAULT_DB = path.join(DEFAULT_OUT_DIR, 'memory.db');

const SCHEMA_VERSION = 2;
const DIM = 1024;
const VECTOR_BYTES = DIM * 4;
const NORM_WARN_TOL = 1e-2;

function die(msg, code = 1) {
  process.stderr.write(`[build-db] error: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    rebuild: false,
    help: false,
    dir: DEFAULT_MEMORIES_DIR,
    vectorsDir: DEFAULT_OUT_DIR,
    db: DEFAULT_DB,
  };
  const needValue = (i, flag) => {
    if (i + 1 >= argv.length) die(`${flag} 缺少参数值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rebuild') opts.rebuild = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dir') {
      opts.dir = path.resolve(needValue(i, a));
      i++;
    } else if (a === '--vectors') {
      opts.vectorsDir = path.resolve(needValue(i, a));
      i++;
    } else if (a === '--out') {
      opts.db = path.resolve(needValue(i, a));
      i++;
    } else if (a.startsWith('-')) {
      die(`未知参数 ${a}（--help 查看用法）`);
    } else {
      die(`多余的参数 ${a}（--help 查看用法）`);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`用法: node build-db.mjs [选项]

  --rebuild          全量重建（默认：库已存在且校验通过时跳过）
  --dir <dir>        记忆 JSON 目录，默认 ${DEFAULT_MEMORIES_DIR}
  --vectors <path>   向量目录或 .bin 文件（按同名派生 .meta.jsonl / .meta.json），
                     默认 ${DEFAULT_OUT_DIR}/vectors.bin
  --out <file>       数据库路径，默认 ${DEFAULT_DB}
  -h, --help         显示本帮助
`);
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const ALNUM_RE = /[A-Za-z0-9_]/;

/**
 * 中文 bigram 展开：连续 CJK 字符展开成两两重叠的 bigram（n=1 时保留单字），
 * 英文/数字/下划线原样保留（小写），其余字符一律当分隔符。
 * 写入端与查询端必须用同一规则，否则 FTS5 短语匹配对不上。
 */
function expandBigrams(text) {
  const tokens = [];
  let cjk = [];
  let run = '';
  const flushCjk = () => {
    if (cjk.length === 1) tokens.push(cjk[0]);
    else {
      for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk[i] + cjk[i + 1]);
    }
    cjk = [];
  };
  const flushRun = () => {
    if (run) {
      tokens.push(run.toLowerCase());
      run = '';
    }
  };
  for (const ch of String(text ?? '')) {
    if (CJK_RE.test(ch)) {
      flushRun();
      cjk.push(ch);
    } else if (ALNUM_RE.test(ch)) {
      flushCjk();
      run += ch;
    } else {
      flushCjk();
      flushRun();
    }
  }
  flushCjk();
  flushRun();
  return tokens;
}

function loadMemories(dir) {
  if (!fs.existsSync(dir)) die(`记忆目录不存在: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const records = [];
  let memoryFiles = 0;
  let parseFailures = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      parseFailures++;
      process.stderr.write(`[build-db] warn: 跳过无法解析的 ${file}: ${err.message}\n`);
      continue;
    }
    memoryFiles++;
    const sessionId = data.session_id || path.basename(file, '.json');
    const cwd = data.cwd ?? null;
    for (const m of data.memories || []) {
      const statement = typeof m.statement === 'string' ? m.statement.trim() : '';
      if (!statement) continue;
      records.push({
        session_id: sessionId,
        cwd,
        kind: m.kind ?? null,
        seq: m.seq ?? null,
        time: m.time ?? null,
        statement,
        evidence: typeof m.evidence === 'string' ? m.evidence : '',
        tags: Array.isArray(m.tags) ? m.tags : [],
      });
    }
  }
  return { records, files: files.length, memoryFiles, parseFailures };
}

function resolveVectorPaths(spec) {
  // --vectors 既接受目录（沿用 vectors.bin / vectors.meta.jsonl），
  // 也接受具体 .bin 文件（如 vectors-ev.bin，同级派生 .meta.jsonl / .meta.json）。
  if (fs.existsSync(spec) && fs.statSync(spec).isFile()) {
    const base = spec.endsWith('.bin') ? spec.slice(0, -4) : spec;
    return {
      binPath: spec,
      metaPath: `${base}.meta.jsonl`,
      metaJsonPath: `${base}.meta.json`,
    };
  }
  return {
    binPath: path.join(spec, 'vectors.bin'),
    metaPath: path.join(spec, 'vectors.meta.jsonl'),
    metaJsonPath: path.join(spec, 'vectors.meta.json'),
  };
}

function loadVectors(spec, expectedCount) {
  const { binPath, metaPath, metaJsonPath } = resolveVectorPaths(spec);
  for (const p of [binPath, metaPath]) {
    if (!fs.existsSync(p)) die(`缺少向量产物: ${p}`);
  }
  let metaJson = null;
  if (fs.existsSync(metaJsonPath)) {
    try {
      metaJson = JSON.parse(fs.readFileSync(metaJsonPath, 'utf8'));
    } catch {
      metaJson = null;
    }
  }
  const dim = metaJson?.dim ?? DIM;
  if (dim !== DIM) die(`向量维度 ${dim} ≠ ${DIM}，本实现只支持 ${DIM}`);
  const bin = fs.readFileSync(binPath);
  const total = bin.length / (dim * 4);
  if (!Number.isInteger(total)) die(`vectors.bin 字节数 ${bin.length} 不是 ${dim * 4} 的整数倍`);
  if (total !== expectedCount) {
    die(`向量条数 ${total} ≠ 记忆条数 ${expectedCount}；请先重跑 embed.mjs`);
  }
  if (metaJson && Number.isInteger(metaJson.count) && metaJson.count !== total) {
    die(`vectors.meta.json 记的 count=${metaJson.count} ≠ 实际 ${total}`);
  }
  const entries = fs
    .readFileSync(metaPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        die(`vectors.meta.jsonl 第 ${i + 1} 行不是合法 JSON: ${err.message}`);
      }
    });
  if (entries.length !== expectedCount) {
    die(`vectors.meta.jsonl 行数 ${entries.length} ≠ 记忆条数 ${expectedCount}`);
  }
  const missing = entries.findIndex((m) => !m.mem_id || !m.text_sha256);
  if (missing >= 0) {
    die(
      `vectors.meta.jsonl 第 ${missing + 1} 行缺少 mem_id/text_sha256；` +
        `这是升级前的旧产物，请先跑 embed.mjs（会自动全量重编码）`,
    );
  }
  const vectors = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  return { bin, vectors, entries, dim, metaJson };
}

/**
 * 按 mem_id 把 meta 行与 memories 对齐，返回按 meta 顺序排好的行（offset=行号）。
 * 同时校验 text_sha256：它记的是 embed.mjs 实际编码的文本，textField 变了却没重编码会在这里报错。
 */
function validateAlignment(records, entries, vectors, metaJson) {
  const byId = new Map(records.map((rec) => [rec.mem_id, rec]));
  const textField = metaJson?.textField ?? 'statement';
  const rows = [];
  let nonFinite = 0;
  let normMin = Infinity;
  let normMax = 0;
  for (let offset = 0; offset < entries.length; offset++) {
    const meta = entries[offset];
    const rec = byId.get(meta.mem_id);
    if (!rec) {
      die(`vectors.meta.jsonl 第 ${offset + 1} 行的 mem_id ${meta.mem_id} 在 memories 里不存在`);
    }
    if (meta.session_id !== rec.session_id || meta.seq !== rec.seq || meta.text !== rec.statement) {
      die(
        `第 ${offset + 1} 条对不上：meta session_id=${meta.session_id} seq=${meta.seq}，` +
          `memories session_id=${rec.session_id} seq=${rec.seq}；mem_id=${meta.mem_id}`,
      );
    }
    const evidence = String(rec.evidence ?? '').trim();
    const expectedText =
      textField === 'statement+evidence' && evidence
        ? `${rec.statement}\n${evidence}`
        : rec.statement;
    if (meta.text_sha256 !== textSha256(expectedText)) {
      die(
        `第 ${offset + 1} 条（mem_id=${meta.mem_id}）text_sha256 与当前文本不符；` +
          `meta 记的编码文本可能是旧配置（textField=${textField}），请重跑 embed.mjs`,
      );
    }
    byId.delete(meta.mem_id);
    let sum = 0;
    const base = offset * DIM;
    for (let k = 0; k < DIM; k++) {
      const x = vectors[base + k];
      if (!Number.isFinite(x)) nonFinite++;
      sum += x * x;
    }
    const norm = Math.sqrt(sum);
    if (norm < normMin) normMin = norm;
    if (norm > normMax) normMax = norm;
    rows.push({
      ...rec,
      mem_id: meta.mem_id,
      text_sha256: meta.text_sha256,
      id_int: memIdToRowid(meta.mem_id),
      offset,
    });
  }
  if (byId.size > 0) {
    const sample = [...byId.keys()].slice(0, 3).join(', ');
    die(`memories 里有 ${byId.size} 条记忆没有对应向量（例如 ${sample}）；请先重跑 embed.mjs`);
  }
  if (nonFinite > 0) die(`向量里有 ${nonFinite} 个非有限值`);
  const normTol = Math.max(Math.abs(normMin - 1), Math.abs(normMax - 1));
  if (normTol > NORM_WARN_TOL) {
    die(`向量未单位化：norm 范围 ${normMin.toFixed(6)}..${normMax.toFixed(6)}（默认 L2 距离不再等价 cosine）`);
  }
  if (normTol > 1e-3) {
    process.stderr.write(
      `[build-db] warn: 向量 norm 偏离 1 最多 ${normTol.toExponential(2)}，仍按已归一化处理\n`,
    );
  }
  return { rows, normMin, normMax };
}

function openDb(file, { allowExtension = false } = {}) {
  const db = new DatabaseSync(file, allowExtension ? { allowExtension: true } : {});
  return db;
}

function loadVecExtension(db) {
  try {
    db.loadExtension(getLoadablePath());
  } catch (err) {
    die(`加载 sqlite-vec 扩展失败（${getLoadablePath()}）: ${err.message}`);
  }
  const row = db.prepare('select vec_version() as v').get();
  return row?.v ?? 'unknown';
}

function tableBytes(db, prefix) {
  try {
    const row = db
      .prepare("select coalesce(sum(pgsize), 0) as bytes from dbstat where name like ?")
      .get(`${prefix}%`);
    return Number(row?.bytes ?? 0);
  } catch {
    return null;
  }
}

function countRows(db, sql) {
  const row = db.prepare(sql).get();
  return Number(row?.c ?? 0);
}

function isValidExisting(dbPath, expectedCount) {
  if (!fs.existsSync(dbPath)) return { valid: false, reason: '不存在' };
  let db;
  try {
    db = openDb(dbPath, { allowExtension: true });
    loadVecExtension(db);
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== SCHEMA_VERSION) return { valid: false, reason: `user_version=${version}` };
    const memCount = countRows(db, 'select count(*) as c from memories');
    if (memCount !== expectedCount) return { valid: false, reason: `memories=${memCount}` };
    const vecCount = countRows(db, 'select count(*) as c from mem_vec');
    if (vecCount !== expectedCount) return { valid: false, reason: `mem_vec=${vecCount}` };
    const ftsCount = countRows(db, 'select count(*) as c from mem_fts');
    if (ftsCount !== expectedCount) return { valid: false, reason: `mem_fts=${ftsCount}` };
    const autoVacuum = Number(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
    return { valid: true, autoVacuum, memCount, ftsCount, vecCount };
  } catch (err) {
    return { valid: false, reason: `打开失败: ${err.message}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function buildDatabase(opts, records, vectors) {
  const dbPath = path.resolve(opts.db);
  const tmpPath = `${dbPath}.building-${process.pid}`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(tmpPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }

  const phase = {};
  const tOpen = performance.now();
  const db = openDb(tmpPath, { allowExtension: true });
  const vecVersion = loadVecExtension(db);

  // auto_vacuum 必须在建表前设置；journal_mode 在空库上也能立刻切换。
  db.exec('PRAGMA auto_vacuum=INCREMENTAL');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(`
    CREATE TABLE memories (
      offset      INTEGER NOT NULL UNIQUE,
      mem_id      TEXT PRIMARY KEY,
      id_int      INTEGER NOT NULL UNIQUE,
      session_id  TEXT NOT NULL,
      cwd         TEXT,
      kind        TEXT,
      seq         INTEGER,
      time        INTEGER,
      statement   TEXT NOT NULL,
      evidence    TEXT,
      tags        TEXT,
      text_len    INTEGER NOT NULL,
      text_sha256 TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE mem_fts USING fts5(
      statement_bigram,
      content='',
      contentless_delete=1,
      tokenize='unicode61'
    );
    CREATE VIRTUAL TABLE mem_vec USING vec0(embedding float[${DIM}]);
    PRAGMA user_version=${SCHEMA_VERSION};
  `);
  phase.openMs = performance.now() - tOpen;

  const tWrite = performance.now();
  const insMem = db.prepare(`
    INSERT INTO memories
      (offset, mem_id, id_int, session_id, cwd, kind, seq, time, statement, evidence,
       tags, text_len, text_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insFts = db.prepare('INSERT INTO mem_fts(rowid, statement_bigram) VALUES (?, ?)');
  const insVec = db.prepare('INSERT INTO mem_vec(rowid, embedding) VALUES (?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rec of records) {
      const textLen = Array.from(rec.statement).length;
      insMem.run(
        rec.offset,
        rec.mem_id,
        rec.id_int,
        rec.session_id,
        rec.cwd,
        rec.kind,
        rec.seq,
        rec.time,
        rec.statement,
        rec.evidence,
        JSON.stringify(rec.tags),
        textLen,
        rec.text_sha256,
      );
      const bigrams = expandBigrams(rec.statement).join(' ');
      // FTS 只是随库重建的索引，rowid 用小的 offset（大 rowid 会把 FTS 索引撑大）；
      // 需要稳定身份的是 vec0，它用 id_int。
      insFts.run(rec.offset, bigrams);
      const embedding = Buffer.from(
        vectors.buffer,
        vectors.byteOffset + rec.offset * VECTOR_BYTES,
        VECTOR_BYTES,
      );
      // vec0 的主键只接受整数；node:sqlite 会把 number 绑成 REAL，所以用 BigInt。
      insVec.run(rec.id_int, embedding);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(tmpPath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    die(`写入失败: ${err?.stack || err}`);
  }
  phase.writeMs = performance.now() - tWrite;

  const tOptimize = performance.now();
  db.exec("INSERT INTO mem_fts(mem_fts) VALUES('optimize')");
  const ftsBytes = tableBytes(db, 'mem_fts');
  const vecBytes = tableBytes(db, 'mem_vec');
  const memBytes = tableBytes(db, 'memories');
  const autoVacuum = Number(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  phase.optimizeMs = performance.now() - tOptimize;

  // 原子替换旧库；先清掉旧库可能留下的 WAL/SHM。
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  fs.renameSync(tmpPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(tmpPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }

  return {
    dbPath,
    bytes: fs.statSync(dbPath).size,
    ftsBytes,
    vecBytes,
    memBytes,
    autoVacuum,
    vecVersion,
    phase,
  };
}

function printSummary(info, extra) {
  const lines = [
    `memory.db: ${info.dbPath}`,
    `  记忆条数   ${extra.memCount}`,
    `  关键词索引 ${extra.ftsCount} 条`,
    `  向量索引   ${extra.vecCount} 条 × ${DIM} 维（sqlite-vec ${info.vecVersion}）`,
    `  DB 体积    ${formatBytes(info.bytes)}`,
    `  FTS 索引   ${info.ftsBytes == null ? '未知' : formatBytes(info.ftsBytes)}`,
    `  vec 索引   ${info.vecBytes == null ? '未知' : formatBytes(info.vecBytes)}`,
    `  建库耗时   ${(extra.elapsedMs / 1000).toFixed(2)}s`,
    `  auto_vacuum=${info.autoVacuum}（2=INCREMENTAL）  journal_mode=WAL`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const started = performance.now();
  const loaded = loadMemories(opts.dir);
  if (loaded.records.length === 0) die(`记忆目录里没有可用记录: ${opts.dir}`);
  // mem_id 是身份；这里只算一次，后面按它对齐 meta 行与向量。
  const { duplicateGroups } = assignMemIds(loaded.records);
  assertRowidUnique(loaded.records);
  if (duplicateGroups.length > 0) {
    process.stderr.write(
      `[build-db] warn: ${duplicateGroups.length} 组记录 session_id+seq+evidence 相同，用派生 mem_id（见 mem-id.mjs）\n`,
    );
  }
  const tRead = performance.now();

  const { vectors, entries, metaJson } = loadVectors(opts.vectorsDir, loaded.records.length);
  const { rows, normMin, normMax } = validateAlignment(loaded.records, entries, vectors, metaJson);
  const tVectors = performance.now();

  process.stderr.write(
    `[build-db] 读取 ${loaded.memoryFiles}/${loaded.files} 个文件，${rows.length} 条记忆；` +
      `向量 ${rows.length}×${DIM}；norm ${normMin.toFixed(6)}..${normMax.toFixed(6)}\n`,
  );
  if (loaded.parseFailures > 0) {
    process.stderr.write(`[build-db] warn: ${loaded.parseFailures} 个文件解析失败被跳过\n`);
  }

  const dbPath = path.resolve(opts.db);
  if (!opts.rebuild) {
    const existing = isValidExisting(dbPath, rows.length);
    if (existing.valid) {
      const bytes = fs.statSync(dbPath).size;
      process.stderr.write('[build-db] 库已是最新，跳过重建（--rebuild 强制重建）\n');
      const db = openDb(dbPath, { allowExtension: true });
      const vecVersion = loadVecExtension(db);
      const ftsBytes = tableBytes(db, 'mem_fts');
      const vecBytes = tableBytes(db, 'mem_vec');
      db.close();
      printSummary(
        {
          dbPath,
          bytes,
          ftsBytes,
          vecBytes,
          autoVacuum: existing.autoVacuum,
          vecVersion,
        },
        {
          memCount: existing.memCount,
          ftsCount: existing.ftsCount,
          vecCount: existing.vecCount,
          elapsedMs: performance.now() - started,
        },
      );
      return;
    }
    process.stderr.write(`[build-db] 需要重建：${existing.reason}\n`);
  }

  const info = buildDatabase(opts, rows, vectors);
  const elapsedMs = performance.now() - started;
  process.stdout.write(
    `[build-db] phases: read=${((tRead - started) / 1000).toFixed(2)}s ` +
      `vectors=${((tVectors - tRead) / 1000).toFixed(2)}s ` +
      `open=${(info.phase.openMs / 1000).toFixed(2)}s ` +
      `write=${(info.phase.writeMs / 1000).toFixed(2)}s ` +
      `optimize=${(info.phase.optimizeMs / 1000).toFixed(2)}s\n`,
  );
  printSummary(info, {
    memCount: rows.length,
    ftsCount: rows.length,
    vecCount: rows.length,
    elapsedMs,
  });
}

main().catch((err) => {
  process.stderr.write(`[build-db] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
