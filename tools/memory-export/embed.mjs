#!/usr/bin/env node
/**
 * 记忆向量化层：用本地 Qwen3-Embedding-0.6B（ONNX q8）编码 ~/.dsh/memory-export/memories/。
 *
 * 用法：
 *   node embed.mjs                 # 增量编码：按 mem_id 复用旧向量，只编码新增/变更
 *   node embed.mjs --limit 100     # 只输出排序后的前 100 条（调试；其余下次全量补齐）
 *   node embed.mjs --smoke         # 50 条 smoke：维度/范数/重复编码/5 条改写查询召回
 *   node embed.mjs --force         # 忽略已有向量，全部重新编码
 *   node embed.mjs --text-field statement+evidence \
 *                  --out-vectors ~/.dsh/memory-export/vectors-ev.bin
 *                                  # 文档侧拼上 evidence，产物写到 vectors-ev.*
 *
 * 产物（默认 ~/.dsh/memory-export/）：
 *   vectors.bin               全部向量按固定顺序拼接的 Float32Array 裸字节
 *   vectors.meta.jsonl        每条一行 id/mem_id/session_id/.../text/text_sha256/offset
 *   vectors.meta.json         维度、条数、模型 id、dtype、生成时间
 *   vectors.checkpoint.json   本次运行状态
 *
 * 增量规则：
 *   - 先给每条记忆算 mem_id（定义见 mem-id.mjs），输出顺序固定为
 *     session_id → seq → mem_id，与 memories 文件顺序无关。
 *   - 旧 meta 里同一 mem_id 且 text_sha256 相同的向量直接复用，只编码新增/变更；
 *     旧 meta 里不再存在的 mem_id 被删除。
 *   - 产物先写到 <file>.tmp-<pid>，全部完成后再原子替换；崩溃不会留下半份文件。
 *   - 旧 meta 没有 mem_id/text_sha256（升级前）时无法复用，等价于一次全量重编码。
 *
 * 约定：
 *   - 文档侧默认只用 statement，不加指令；查询侧加 QUERY_INSTRUCTION。
 *   - --text-field statement+evidence 时文档文本为 `statement + "\n" + evidence`
 *     （evidence 为空则退回 statement）；meta 里的 text 仍记 statement，text_sha256
 *     记的是实际编码文本的指纹。
 *   - 批大小默认 1：同一文本单独编码与跟长文本同批编码余弦只有 0.955，
 *     同批重复编码是 1.000000。--batch >1 会打印 warning，向量不可复现、不可跨次比较。
 *   - 池化 last_token（tokenizer 必须 padding_side=left），输出归一化到 L2=1。
 *   - 模型只从 hf-mirror.com 下载（本机到 huggingface.co 不通）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  assignMemIds,
  assertRowidUnique,
  compareRecords,
  textSha256,
} from './mem-id.mjs';

const HOME = os.homedir();
const DEFAULT_MEMORIES_DIR = path.join(HOME, '.dsh', 'memory-export', 'memories');
const DEFAULT_OUT_DIR = path.join(HOME, '.dsh', 'memory-export');
const MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const DTYPE = 'q8';
const DIM = 1024;
const NORM_TOL = 1e-3;
const CHECKPOINT_EVERY = 500;
// 默认 1：同一文本的向量会随同批组成变化（实测单条 vs 混批余弦 0.955），
// batch 16 每次全量重编码都会把向量换一遍，评测指标随之漂移。正式库用 1。
const DEFAULT_BATCH = 1;
const MIRROR = 'https://hf-mirror.com/';
const CACHE_DIR = path.join(HOME, '.cache', 'huggingface', 'transformers');
const TEXT_FIELDS = ['statement', 'statement+evidence'];
const DEFAULT_TEXT_FIELD = 'statement';
const DEFAULT_VECTORS_NAME = 'vectors.bin';
const QUERY_INSTRUCTION =
  'Instruct: Given a Chinese personal-memory search query, retrieve the memories that answer it\nQuery:';

const VECTOR_BYTES = DIM * 4;

function die(msg, code = 1) {
  process.stderr.write(`[embed] error: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    smoke: false,
    force: false,
    limit: null,
    batch: DEFAULT_BATCH,
    dir: DEFAULT_MEMORIES_DIR,
    out: DEFAULT_OUT_DIR,
    textField: DEFAULT_TEXT_FIELD,
    outVectors: null,
    outMeta: null,
    help: false,
  };
  const needValue = (i, flag) => {
    if (i + 1 >= argv.length) die(`${flag} 缺少参数值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') opts.smoke = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--limit') {
      const v = needValue(i, a);
      i++;
      opts.limit = Number(v);
      if (!Number.isInteger(opts.limit) || opts.limit <= 0) die(`--limit 必须是正整数，收到 ${v}`);
    } else if (a === '--batch') {
      const v = needValue(i, a);
      i++;
      opts.batch = Number(v);
      if (!Number.isInteger(opts.batch) || opts.batch < 1 || opts.batch > 64) {
        die(`--batch 必须是 1..64 的整数，收到 ${v}`);
      }
    } else if (a === '--dir') {
      opts.dir = path.resolve(needValue(i, a));
      i++;
    } else if (a === '--out') {
      opts.out = path.resolve(needValue(i, a));
      i++;
    } else if (a === '--text-field') {
      const v = needValue(i, a);
      i++;
      if (!TEXT_FIELDS.includes(v)) {
        die(`--text-field 只能是 ${TEXT_FIELDS.join('|')}，收到 ${v}`);
      }
      opts.textField = v;
    } else if (a === '--out-vectors') {
      opts.outVectors = path.resolve(needValue(i, a));
      i++;
      if (!opts.outVectors.endsWith('.bin')) die('--out-vectors 必须是 .bin 文件路径');
    } else if (a === '--out-meta') {
      opts.outMeta = path.resolve(needValue(i, a));
      i++;
    } else if (a.startsWith('-')) {
      die(`未知参数 ${a}（--help 查看用法）`);
    } else {
      die(`多余的参数 ${a}（--help 查看用法）`);
    }
  }
  if (opts.batch > 1) {
    process.stderr.write(
      `[embed] warn: --batch ${opts.batch} > 1，同一文本的向量会随同批组成变化` +
        `（实测单条 vs 混批余弦 0.955，同批重复编码 1.000000），结果不可复现；` +
        `正式库请用 --batch 1\n`,
    );
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`用法: node embed.mjs [选项]

  --smoke              编码 50 条并打印 smoke 报告（不写 vectors.bin）
  --limit N            只输出排序后的前 N 条（调试；其余记录下次全量运行补齐）
  --batch N            批大小，默认 ${DEFAULT_BATCH}（1 才可复现；>1 会打印 warning）
  --dir <dir>          记忆 JSON 目录，默认 ${DEFAULT_MEMORIES_DIR}
  --out <dir>          产物目录，默认 ${DEFAULT_OUT_DIR}
  --text-field F       文档编码文本：statement | statement+evidence，默认 ${DEFAULT_TEXT_FIELD}
  --out-vectors <f>    向量输出路径（.bin），默认 <out>/vectors.bin；
                       meta/meta.json/checkpoint 默认按同名派生
  --out-meta <f>       meta.jsonl 输出路径，默认按向量路径同名派生
  --force              忽略已有向量全部重新编码（迁移/换模型时用）
  -h, --help           显示本帮助
`);
}

function loadMemories(dir, textField = DEFAULT_TEXT_FIELD) {
  if (!fs.existsSync(dir)) die(`记忆目录不存在: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const records = [];
  let memoryFiles = 0;
  let parseFailures = 0;
  let withEvidence = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      parseFailures++;
      process.stderr.write(`[embed] warn: 跳过无法解析的 ${file}: ${err.message}\n`);
      continue;
    }
    memoryFiles++;
    const sessionId = data.session_id || path.basename(file, '.json');
    const cwd = data.cwd ?? null;
    for (const m of data.memories || []) {
      const text = typeof m.statement === 'string' ? m.statement.trim() : '';
      if (!text) continue;
      const evidence = typeof m.evidence === 'string' ? m.evidence.trim() : '';
      if (evidence) withEvidence++;
      const embedText =
        textField === 'statement+evidence' && evidence ? `${text}\n${evidence}` : text;
      records.push({
        id: `${sessionId}:${m.seq}`,
        session_id: sessionId,
        cwd,
        kind: m.kind ?? null,
        seq: m.seq ?? null,
        time: m.time ?? null,
        text,
        statement: text,
        evidence,
        embedText,
        offset: records.length,
      });
    }
  }
  return { records, files: files.length, memoryFiles, parseFailures, withEvidence };
}

function idDuplicates(records) {
  const seen = new Map();
  for (const r of records) seen.set(r.id, (seen.get(r.id) || 0) + 1);
  let duplicateIds = 0;
  for (const n of seen.values()) if (n > 1) duplicateIds += n - 1;
  return { uniqueIds: seen.size, duplicateIds };
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function stripBin(file) {
  return file.endsWith('.bin') ? file.slice(0, -4) : file;
}

/**
 * 默认产物名不变（vectors.bin / vectors.meta.jsonl / vectors.meta.json /
 * vectors.checkpoint.json）；指定 --out-vectors 时其余文件按同名派生，
 * 例如 vectors-ev.bin -> vectors-ev.meta.jsonl / vectors-ev.meta.json /
 * vectors-ev.checkpoint.json，不会碰 baseline 的 vectors.*。
 */
function outputPaths(opts) {
  const vectors = opts.outVectors ?? path.join(opts.out, DEFAULT_VECTORS_NAME);
  const custom = Boolean(opts.outVectors || opts.outMeta);
  const base = stripBin(vectors);
  return {
    vectors,
    meta: opts.outMeta ?? (custom ? `${base}.meta.jsonl` : path.join(opts.out, 'vectors.meta.jsonl')),
    metaJson: custom ? `${base}.meta.json` : path.join(opts.out, 'vectors.meta.json'),
    checkpoint: custom ? `${base}.checkpoint.json` : path.join(opts.out, 'vectors.checkpoint.json'),
  };
}

function prepareOutputDir(opts) {
  fs.mkdirSync(opts.out, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const paths = outputPaths(opts);
  if (opts.outVectors) fs.mkdirSync(path.dirname(paths.vectors), { recursive: true });
  if (opts.outMeta) fs.mkdirSync(path.dirname(paths.meta), { recursive: true });

  const previousMeta = readJsonIfExists(paths.metaJson);
  // --force 表示按本次配置重建，允许 textField 等配置变化。
  if (previousMeta && !opts.force) {
    const mismatch = [];
    if (previousMeta.dim !== DIM) mismatch.push(`dim=${previousMeta.dim}`);
    if (previousMeta.model !== MODEL_ID) mismatch.push(`model=${previousMeta.model}`);
    if (previousMeta.dtype !== DTYPE) mismatch.push(`dtype=${previousMeta.dtype}`);
    if (
      previousMeta.textField != null &&
      previousMeta.textField !== opts.textField
    ) {
      mismatch.push(`textField=${previousMeta.textField}`);
    }
    if (mismatch.length) {
      die(
        `已有产物与本次配置不符（${mismatch.join(', ')}）。为避免混写，请加 --force 重跑。`,
      );
    }
  }
  return paths;
}

/**
 * 读入上一次的 vectors.bin + vectors.meta.jsonl，按 mem_id 建索引供复用。
 * meta 行数与 bin 条数不一致时只取共同前缀（崩溃留下的后缀直接忽略）。
 * 升级前的老 meta 没有 mem_id/text_sha256，会被计入 withoutMemId，等价于全量重编码。
 */
function readPreviousOutputs(paths) {
  const bin = fs.existsSync(paths.vectors) ? fs.readFileSync(paths.vectors) : Buffer.alloc(0);
  const binCount = Math.floor(bin.length / VECTOR_BYTES);
  const entries = [];
  if (fs.existsSync(paths.meta)) {
    for (const line of fs.readFileSync(paths.meta, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        break; // 半行，丢弃后面全部
      }
    }
  }
  const count = Math.min(entries.length, binCount);
  if (count !== entries.length || count !== binCount) {
    process.stderr.write(
      `[embed] warn: 旧产物不一致（meta ${entries.length} 行，bin ${binCount} 条），` +
        `只复用共同前缀 ${count} 条\n`,
    );
  }
  const byId = new Map();
  let withoutMemId = 0;
  for (let i = 0; i < count; i++) {
    const m = entries[i];
    if (typeof m.mem_id === 'string' && typeof m.text_sha256 === 'string') {
      byId.set(m.mem_id, { index: i, textSha256: m.text_sha256 });
    } else {
      withoutMemId++;
    }
  }
  return { bin, byId, count, withoutMemId };
}

function writeCheckpoint(opts, out, extra) {
  const count = out.count;
  writeJsonAtomic(out.paths.checkpoint, {
    schema: 'dsh-memory-vectors-checkpoint/1',
    count,
    dim: DIM,
    model: MODEL_ID,
    dtype: DTYPE,
    textField: opts.textField,
    vectorsBytes: count * VECTOR_BYTES,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

function writeTopMeta(opts, out, extra) {
  writeJsonAtomic(out.paths.metaJson, {
    schema: 'dsh-memory-vectors/1',
    dim: DIM,
    count: out.count,
    model: MODEL_ID,
    dtype: DTYPE,
    pooling: 'last_token',
    normalized: true,
    textField: opts.textField,
    batch: opts.batch,
    documentTextFormat:
      opts.textField === 'statement+evidence' ? 'statement + "\\n" + evidence' : 'statement',
    documentInstruction: '',
    queryInstruction: QUERY_INSTRUCTION,
    generatedAt: new Date().toISOString(),
    ...extra,
  });
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function initModel(opts) {
  const tf = await import('@huggingface/transformers');
  const { pipeline, env } = tf;
  env.remoteHost = MIRROR;
  env.cacheDir = CACHE_DIR;
  env.allowLocalModels = true;
  env.useBrowserCache = false;

  const stats = {
    remoteHost: MIRROR,
    cacheDir: CACHE_DIR,
    initMs: 0,
    downloadMs: null,
    loadMs: null,
    downloadedBytes: 0,
    files: [],
    paddingSide: null,
  };

  const files = new Map();
  let firstEventAt = null;
  let lastFileDoneAt = null;
  let lastLogAt = 0;
  const started = performance.now();

  const onProgress = (p) => {
    if (!p || !p.status) return;
    const now = performance.now();
    if (firstEventAt === null) firstEventAt = now;
    const key = p.file || p.name;
    if (key) {
      let rec = files.get(key);
      if (!rec) {
        rec = { file: key, loaded: 0, total: 0 };
        files.set(key, rec);
      }
      if (p.status === 'initiate') {
        rec.total = p.total ?? rec.total;
      } else if (p.status === 'progress') {
        rec.loaded = p.loaded ?? rec.loaded;
        rec.total = p.total ?? rec.total;
      } else if (p.status === 'done') {
        if (p.loaded != null) rec.loaded = p.loaded;
        if (p.total != null) rec.total = p.total;
        rec.done = true;
        lastFileDoneAt = now;
      }
    }
    if (p.status === 'progress' && (key || '').includes('model_quantized.onnx')) {
      if (now - lastLogAt >= 2000 || p.loaded === p.total) {
        lastLogAt = now;
        const pct = p.total ? ((p.loaded / p.total) * 100).toFixed(1) : '?';
        const cacheHit = p.loaded === p.total && p.progress === 1;
        process.stderr.write(
          `[download] model_quantized.onnx ${pct}% ${formatBytes(p.loaded)}${
            p.total ? ` / ${formatBytes(p.total)}` : ''
          }${cacheHit ? ' (done)' : ''}\n`,
        );
      }
    }
  };

  process.stderr.write(`[model] remoteHost=${MIRROR}\n`);
  process.stderr.write(`[model] cacheDir=${CACHE_DIR}\n`);
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: DTYPE,
    device: 'cpu',
    progress_callback: onProgress,
  });
  const finished = performance.now();

  stats.initMs = Math.round(finished - started);
  const fileList = [...files.values()];
  stats.files = fileList.map((f) => ({
    file: f.file,
    bytes: f.loaded || f.total || 0,
  }));
  stats.downloadedBytes = fileList.reduce((sum, f) => sum + (f.loaded || f.total || 0), 0);
  if (firstEventAt !== null && lastFileDoneAt !== null) {
    stats.downloadMs = Math.round(lastFileDoneAt - firstEventAt);
    stats.loadMs = Math.round(finished - lastFileDoneAt);
  } else {
    stats.downloadMs = 0;
    stats.loadMs = stats.initMs;
  }

  const paddingSide = extractor?.tokenizer?.padding_side ?? null;
  stats.paddingSide = paddingSide;
  if (paddingSide !== 'left') {
    throw new Error(
      `tokenizer.padding_side=${JSON.stringify(paddingSide)}，last-token 池化要求 left padding；` +
        `请检查模型仓库的 tokenizer_config.json（本实现不主动修改它）。`,
    );
  }

  process.stderr.write(
    `[model] loaded ${MODEL_ID} dtype=${DTYPE} in ${(stats.initMs / 1000).toFixed(1)}s ` +
      `(download ${(stats.downloadMs / 1000).toFixed(1)}s, load ${(stats.loadMs / 1000).toFixed(1)}s, ` +
      `files ${fileList.length}, ${formatBytes(stats.downloadedBytes)})\n`,
  );

  return { extractor, stats };
}

function tensorRows(tensor, expectedRows) {
  const dims = tensor?.dims;
  if (!Array.isArray(dims) || dims.length !== 2) {
    throw new Error(`模型输出不是二维张量，dims=${JSON.stringify(dims)}`);
  }
  if (dims[0] !== expectedRows) {
    throw new Error(`模型输出 batch=${dims[0]}，期望 ${expectedRows}`);
  }
  if (dims[1] !== DIM) {
    throw new Error(`模型输出维度=${dims[1]}，期望 ${DIM}`);
  }
  const data = tensor.data;
  if (!data || typeof data.length !== 'number') throw new Error('模型输出 data 不是可读数组');
  const rows = [];
  for (let r = 0; r < dims[0]; r++) {
    rows.push(Float32Array.from(data.subarray(r * DIM, (r + 1) * DIM)));
  }
  return rows;
}

async function encodeTexts(extractor, texts, batchSize, onBatch) {
  const vectors = [];
  const started = performance.now();
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const tensor = await extractor(batch, { pooling: 'last_token', normalize: true });
    const rows = tensorRows(tensor, batch.length);
    for (const row of rows) vectors.push(row);
    if (onBatch) onBatch(i + batch.length, texts.length, performance.now() - started);
  }
  return { vectors, encodeMs: performance.now() - started };
}

function normOf(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i];
    sum += x * x;
  }
  return Math.sqrt(sum);
}

function isFiniteVector(vec) {
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return false;
  }
  return true;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function sliceChars(text, n) {
  return Array.from(text).slice(0, n).join('');
}

const QUERY_SPECS = [
  {
    query: '中文全文搜索为什么搜不到两个字',
    topic: 'FTS5 trigram / bigram 的中文分词坑',
    minScore: 8,
    find: (s) => {
      let score = 0;
      if (/FTS5/i.test(s)) score += 3;
      if (/trigram/i.test(s)) score += 4;
      if (/bigram/i.test(s)) score += 3;
      if (/中文/.test(s)) score += 2;
      if (/分词/.test(s)) score += 2;
      if (/tokenizer/i.test(s)) score += 1;
      if (/搜不到|召回|MATCH|2 字|两个字|3 个字符|三个字符/.test(s)) score += 1;
      return score;
    },
    topicHit: (s) => /FTS5|trigram|bigram|分词/i.test(s),
  },
  {
    query: 'Chrome 侧边栏打不开',
    topic: 'chrome.sidePanel.open() 手势丢失',
    minScore: 8,
    find: (s) => {
      let score = 0;
      if (/sidePanel\.open\(\)/i.test(s)) score += 5;
      if (/手势丢失/.test(s)) score += 3;
      if (/用户手势/.test(s)) score += 2;
      if (/手势/.test(s)) score += 2;
      if (/侧边栏|侧栏/.test(s)) score += 2;
      if (/打不开|无法.*打开|拒绝|失败|没反应/.test(s)) score += 1;
      return score;
    },
    topicHit: (s) => /sidePanel\.open|侧边栏|侧栏/i.test(s),
  },
  {
    query: '为什么子代理不能设温度',
    topic: 'DSH 委派接口不开放 temperature',
    minScore: 8,
    find: (s) => {
      let score = 0;
      if (/temperature/i.test(s)) score += 5;
      if (/温度/.test(s)) score += 3;
      if (/委派/.test(s)) score += 4;
      if (/不开放|不在.*开放|缺参数|设计边界|不允许/.test(s)) score += 3;
      if (/子代理/.test(s)) score += 1;
      return score;
    },
    topicHit: (s) => /temperature|温度/i.test(s),
  },
  {
    query: '邮件正文乱码怎么处理',
    topic: 'mailhog multipart + quoted-printable',
    minScore: 4,
    find: (s) => {
      let score = 0;
      const mailish = /邮件|mailhog|MIME|正文|html_part|bcg-mail/i.test(s);
      if (/quoted-printable/i.test(s)) score += 8;
      if (/multipart/i.test(s) && mailish) score += 6;
      if (/乱码/.test(s) && mailish) score += 5;
      if (/MIME/i.test(s)) score += 3;
      if (/邮件正文|正文.*邮件|邮件.*正文/.test(s)) score += 3;
      if (/mailhog/i.test(s)) score += 2;
      return score;
    },
    topicHit: (s) => /quoted-printable|multipart|MIME|邮件正文|邮件.*乱码/i.test(s),
  },
  {
    query: '测试用例怎么同步到 Xray',
    topic: 'QA approve 与 Xray sync 流程',
    minScore: 8,
    find: (s) => {
      let score = 0;
      if (/QA approve|qa_status/i.test(s)) score += 5;
      if (/QA approve/i.test(s) && /synced_flag/i.test(s)) score += 2;
      if (/Xray/i.test(s)) score += 4;
      if (/sync/i.test(s)) score += 4;
      if (/synced_flag/.test(s)) score += 3;
      if (/测试用例/.test(s)) score += 1;
      return score;
    },
    topicHit: (s) => /Xray|QA approve|synced_flag|qa_status/i.test(s),
  },
];

function pickTargets(records) {
  const targets = [];
  for (const spec of QUERY_SPECS) {
    let best = null;
    for (let i = 0; i < records.length; i++) {
      const score = spec.find(records[i].text);
      if (score >= spec.minScore && (best === null || score > best.score)) {
        best = { index: i, score, record: records[i] };
      }
    }
    if (!best) {
      throw new Error(`smoke 目标定位失败：${spec.topic}（查询「${spec.query}」）`);
    }
    targets.push({ spec, ...best });
  }
  return targets;
}

function selectSmokeRecords(records) {
  const targets = pickTargets(records);
  const targetIndices = new Set(targets.map((t) => t.index));
  const fillCount = 50 - targets.length;
  for (let k = 0; k < fillCount; k++) {
    let idx = Math.floor(((k + 0.5) * records.length) / fillCount);
    let guard = 0;
    while (targetIndices.has(idx)) {
      idx = (idx + 1) % records.length;
      if (++guard > records.length) throw new Error('smoke 抽样失败');
    }
    targetIndices.add(idx);
  }
  const indices = [...targetIndices].sort((a, b) => a - b);
  const docs = indices.map((index) => ({ index, ...records[index] }));
  return { docs, targets };
}

function printSmokeReport(report) {
  const w = (s = '') => process.stderr.write(`${s}\n`);
  w('');
  w('================ memory embedding smoke ================');
  w(`model: ${MODEL_ID}  dtype: ${DTYPE}`);
  w(`sample: ${report.docs.length} 条（45 条全库均匀抽样 + 5 条目标）`);
  w(`model init: ${(report.model.initMs / 1000).toFixed(2)}s ` +
    `（download ${(report.model.downloadMs / 1000).toFixed(2)}s, load ${(report.model.loadMs / 1000).toFixed(2)}s）`);
  w(`dim: ${report.dim}`);
  w(`norm: min=${report.norms.min.toFixed(6)} max=${report.norms.max.toFixed(6)} mean=${report.norms.mean.toFixed(6)}`);
  w(`duplicate encode cosine: ${report.dupCosine.toFixed(6)}  ("${sliceChars(report.dupText, 60)}")`);
  w(`query prefix: ${JSON.stringify(QUERY_INSTRUCTION)} + " " + query`);
  w('');
  for (let qi = 0; qi < report.queries.length; qi++) {
    const q = report.queries[qi];
    w(`--- query ${qi + 1}/${report.queries.length}: ${q.query}`);
    w(`    expected topic: ${q.topic}`);
    w(`    target: ${q.target.id} [${q.target.kind}] ${sliceChars(q.target.text, 100)}`);
    w(`    target rank: ${q.targetRank == null ? 'not in top-5' : `#${q.targetRank}`}`);
    w(`    literal substring hits in 50: ${q.literalHits}/50 (target literal hit: ${q.targetLiteralHit ? 'yes' : 'no'})`);
    w('    top-5:');
    for (let i = 0; i < q.top5.length; i++) {
      const hit = q.top5[i];
      w(
        `      ${i + 1}. sim=${hit.similarity.toFixed(4)} [${hit.kind}] ${sliceChars(hit.text, 100)}` +
          `${hit.isTarget ? '  <= target' : ''}`,
      );
    }
    w(`    topic hit in top-5: ${q.topicHit ? 'yes' : 'no'}`);
    w('');
  }
  w(
    `smoke verdict: dimOK=${report.dim === DIM} normOK=${report.normOK} dupOK=${report.dupOK} ` +
      `topicTop5=${report.queries.filter((q) => q.topicHit).length}/${report.queries.length}`,
  );
  w('========================================================');
  w('');
}

async function runSmoke(opts, records) {
  const started = performance.now();
  const { docs, targets } = selectSmokeRecords(records);

  process.stderr.write(
    `[smoke] 选中 ${docs.length} 条：5 条目标 + 45 条均匀抽样；开始加载模型\n`,
  );
  const { extractor, stats: model } = await initModel(opts);

  let lastLog = 0;
  const { vectors, encodeMs } = await encodeTexts(
    extractor,
    docs.map((d) => d.embedText),
    opts.batch,
    (done, total) => {
      const now = Date.now();
      if (now - lastLog > 5000 || done === total) {
        lastLog = now;
        process.stderr.write(`[smoke] encoded ${done}/${total}\n`);
      }
    },
  );

  const norms = vectors.map(normOf);
  const actualDim = vectors[0]?.length ?? 0;
  const normsStats = {
    min: Math.min(...norms),
    max: Math.max(...norms),
    mean: norms.reduce((a, b) => a + b, 0) / norms.length,
  };
  const normOK = norms.every((n) => Math.abs(n - 1) <= NORM_TOL);

  const dupText = docs[0].text;
  const dupA = (await encodeTexts(extractor, [dupText], 1)).vectors[0];
  const dupB = (await encodeTexts(extractor, [dupText], 1)).vectors[0];
  const dupCosine = dot(dupA, dupB) / (normOf(dupA) * normOf(dupB));

  const queryTexts = QUERY_SPECS.map((s) => `${QUERY_INSTRUCTION} ${s.query}`);
  const queryResult = await encodeTexts(extractor, queryTexts, opts.batch);
  const queryVectors = queryResult.vectors;

  const queries = QUERY_SPECS.map((spec, qi) => {
    const qv = queryVectors[qi];
    const scored = vectors.map((v, i) => ({
      similarity: dot(qv, v),
      kind: docs[i].kind,
      text: docs[i].text,
      id: docs[i].id,
      index: docs[i].index,
      isTarget: docs[i].index === targets[qi].index,
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    const top5 = scored.slice(0, 5);
    const targetRank = top5.findIndex((x) => x.isTarget) + 1 || null;
    const literalHits = docs.filter((d) =>
      d.text.toLowerCase().includes(spec.query.toLowerCase()),
    ).length;
    const targetLiteralHit = targets[qi].record.text
      .toLowerCase()
      .includes(spec.query.toLowerCase());
    return {
      query: spec.query,
      topic: spec.topic,
      target: {
        id: targets[qi].record.id,
        kind: targets[qi].record.kind,
        text: targets[qi].record.text,
        index: targets[qi].index,
      },
      targetRank,
      literalHits,
      targetLiteralHit,
      topicHit: top5.some((x) => spec.topicHit(x.text)),
      top5: top5.map((x) => ({
        similarity: x.similarity,
        kind: x.kind,
        text: sliceChars(x.text, 100),
        id: x.id,
        isTarget: x.isTarget,
      })),
    };
  });

  const report = {
    docs,
    targets,
    model,
    dim: actualDim,
    norms: normsStats,
    normOK,
    dupText,
    dupCosine,
    dupOK: dupCosine >= 0.9999,
    queries,
    encodeMs,
  };
  printSmokeReport(report);

  const summary = {
    ok:
      normOK &&
      dupCosine >= 0.9999 &&
      actualDim === DIM &&
      queries.filter((q) => q.topicHit).length >= 4,
    mode: 'smoke',
    model: MODEL_ID,
    dtype: DTYPE,
    dim: actualDim,
    pooling: 'last_token',
    normalized: true,
    sampleSize: docs.length,
    targets: targets.map((t) => ({ topic: t.spec.topic, id: t.record.id, index: t.index })),
    norms: normsStats,
    normOK,
    dupCosine,
    dupOK: dupCosine >= 0.9999,
    topicTop5: queries.filter((q) => q.topicHit).length,
    queries: queries.map((q) => ({
      query: q.query,
      targetId: q.target.id,
      targetRank: q.targetRank,
      literalHits: q.literalHits,
      targetLiteralHit: q.targetLiteralHit,
      topicHit: q.topicHit,
      top5: q.top5.map((x) => ({
        similarity: Number(x.similarity.toFixed(6)),
        kind: x.kind,
        id: x.id,
        isTarget: x.isTarget,
        text: x.text,
      })),
    })),
    modelInit: model,
    encodeMs: Math.round(encodeMs),
    elapsedMs: Math.round(performance.now() - started),
    generatedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

async function runFull(opts, records, duplicateStats) {
  const started = performance.now();
  const sorted = [...records].sort(compareRecords);
  const targetCount = opts.limit ? Math.min(opts.limit, sorted.length) : sorted.length;
  const target = sorted.slice(0, targetCount);
  if (opts.limit) {
    process.stderr.write(
      `[embed] warn: --limit ${opts.limit} 只输出排序后的前 ${targetCount} 条，` +
        `其余 ${sorted.length - targetCount} 条不写进 meta（下次正常运行的增量会补编码）\n`,
    );
  }

  const paths = prepareOutputDir(opts);
  const previous = readPreviousOutputs(paths);
  const targetIds = new Set(target.map((r) => r.mem_id));
  let deleted = 0;
  for (const id of previous.byId.keys()) if (!targetIds.has(id)) deleted++;

  const reuse = new Map(); // 输出位置 -> 旧 vectors.bin 里的下标
  const toEncode = [];
  for (let i = 0; i < target.length; i++) {
    const rec = target[i];
    const prev = opts.force ? null : previous.byId.get(rec.mem_id);
    if (prev && prev.textSha256 === rec.text_sha256) reuse.set(i, prev.index);
    else toEncode.push(i);
  }
  process.stderr.write(
    `[embed] 预期 ${targetCount} 条（session_id+seq+mem_id 排序），复用 ${reuse.size} 条，` +
      `需编码 ${toEncode.length} 条，删除 ${deleted} 条（旧产物 ${previous.count} 条` +
      `${previous.withoutMemId ? `，其中 ${previous.withoutMemId} 条无 mem_id` : ''}）\n`,
  );

  const errors = { nonFinite: 0, dimMismatch: 0, normOutOfTolerance: 0, details: [] };
  const addError = (kind, memId, detail) => {
    errors[kind]++;
    if (errors.details.length < 10) errors.details.push({ kind, memId, detail });
  };

  let modelInfo = null;
  let encodeMs = 0;
  const encodedVectors = new Map(); // 输出位置 -> Float32Array
  if (toEncode.length > 0) {
    process.stderr.write('[embed] 加载模型\n');
    const { extractor, stats } = await initModel(opts);
    modelInfo = stats;
    for (let start = 0; start < toEncode.length; start += opts.batch) {
      const slice = toEncode.slice(start, start + opts.batch);
      const t0 = performance.now();
      const tensor = await extractor(
        slice.map((i) => target[i].embedText),
        { pooling: 'last_token', normalize: true },
      );
      encodeMs += performance.now() - t0;
      let rows;
      try {
        rows = tensorRows(tensor, slice.length);
      } catch (err) {
        errors.dimMismatch += slice.length;
        errors.details.push({ kind: 'dimMismatch', memId: target[slice[0]].mem_id, detail: err.message });
        throw err;
      }
      for (let k = 0; k < rows.length; k++) encodedVectors.set(slice[k], rows[k]);
      if (start + opts.batch >= toEncode.length || (start / opts.batch) % 500 === 0) {
        process.stderr.write(
          `[embed] encoded ${Math.min(start + opts.batch, toEncode.length)}/${toEncode.length}\n`,
        );
      }
    }
  }

  // 按固定顺序写临时产物，全部成功后再原子替换，崩溃不会留下半份文件。
  const tmpVectors = `${paths.vectors}.tmp-${process.pid}`;
  const tmpMeta = `${paths.meta}.tmp-${process.pid}`;
  const binFd = fs.openSync(tmpVectors, 'w');
  const metaFd = fs.openSync(tmpMeta, 'w');
  let count = 0;
  try {
    let pending = [];
    const flushBin = () => {
      if (pending.length === 0) return;
      fs.writeSync(binFd, Buffer.concat(pending));
      pending = [];
    };
    for (let i = 0; i < target.length; i++) {
      const rec = target[i];
      const reuseIndex = reuse.get(i);
      let buf;
      if (reuseIndex != null) {
        buf = previous.bin.subarray(reuseIndex * VECTOR_BYTES, (reuseIndex + 1) * VECTOR_BYTES);
      } else {
        const vec = encodedVectors.get(i);
        if (!vec) throw new Error(`内部错误：第 ${i} 条既未复用也未编码（${rec.mem_id}）`);
        buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      }
      const view = new Float32Array(buf.buffer, buf.byteOffset, DIM);
      if (!isFiniteVector(view)) {
        addError('nonFinite', rec.mem_id, '向量含 NaN/Inf');
      } else {
        const norm = normOf(view);
        if (Math.abs(norm - 1) > NORM_TOL) {
          addError('normOutOfTolerance', rec.mem_id, `norm=${norm}`);
        }
      }
      pending.push(buf);
      if (pending.length >= 64) flushBin();
      fs.writeSync(
        metaFd,
        `${JSON.stringify({
          id: rec.id,
          mem_id: rec.mem_id,
          session_id: rec.session_id,
          cwd: rec.cwd,
          kind: rec.kind,
          seq: rec.seq,
          time: rec.time,
          text: rec.text,
          text_sha256: rec.text_sha256,
          offset: i,
        })}\n`,
      );
      count++;
      if (count % 2000 === 0) process.stderr.write(`[embed] wrote ${count}/${targetCount}\n`);
    }
    flushBin();
    fs.fsyncSync(binFd);
    fs.fsyncSync(metaFd);
    fs.closeSync(binFd);
    fs.closeSync(metaFd);
  } catch (err) {
    try { fs.closeSync(binFd); } catch { /* ignore */ }
    try { fs.closeSync(metaFd); } catch { /* ignore */ }
    for (const f of [tmpVectors, tmpMeta]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    throw err;
  }
  if (count !== targetCount) {
    die(`写入完成但 count=${count}，目标 ${targetCount}，产物不一致`);
  }
  fs.renameSync(tmpVectors, paths.vectors);
  fs.renameSync(tmpMeta, paths.meta);

  const out = { paths, count };
  const extra = {
    status: 'complete',
    totalRecords: sorted.length,
    targetCount,
    encoded: toEncode.length,
    reused: reuse.size,
    deleted,
    idScheme: 'sha256(session_id\\0seq\\0normalized_evidence)[:16]',
  };
  writeCheckpoint(opts, out, extra);
  writeTopMeta(opts, out, {
    ...extra,
    validation: {
      nonFinite: errors.nonFinite,
      dimMismatch: errors.dimMismatch,
      normOutOfTolerance: errors.normOutOfTolerance,
    },
  });

  const totalElapsed = performance.now() - started;
  const validationErrors =
    errors.nonFinite + errors.dimMismatch + errors.normOutOfTolerance;
  const summary = {
    ok: validationErrors === 0,
    mode: 'full',
    model: MODEL_ID,
    dtype: DTYPE,
    dim: DIM,
    pooling: 'last_token',
    normalized: true,
    total: sorted.length,
    target: targetCount,
    count,
    encoded: toEncode.length,
    reused: reuse.size,
    deleted,
    encodeMs: Math.round(encodeMs),
    itemsPerSecond: toEncode.length > 0
      ? Number((toEncode.length / (encodeMs / 1000)).toFixed(2))
      : null,
    elapsedMs: Math.round(totalElapsed),
    modelInit: modelInfo,
    validation: {
      nonFinite: errors.nonFinite,
      dimMismatch: errors.dimMismatch,
      normOutOfTolerance: errors.normOutOfTolerance,
      details: errors.details,
    },
    duplicateIds: duplicateStats.duplicateIds,
    uniqueIds: duplicateStats.uniqueIds,
    outputs: {
      vectors: paths.vectors,
      meta: paths.meta,
      metaJson: paths.metaJson,
      checkpoint: paths.checkpoint,
      vectorsBytes: fs.statSync(paths.vectors).size,
      metaBytes: fs.statSync(paths.meta).size,
      metaJsonBytes: fs.statSync(paths.metaJson).size,
    },
    generatedAt: new Date().toISOString(),
  };
  process.stderr.write(
    `[embed] 完成：encoded=${toEncode.length} reused=${reuse.size} deleted=${deleted} ` +
      `count=${count} elapsed=${(totalElapsed / 1000).toFixed(2)}s\n`,
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const loaded = loadMemories(opts.dir, opts.textField);
  const { records } = loaded;
  if (records.length === 0) die(`记忆目录里没有可用记录: ${opts.dir}`);
  const duplicateStats = idDuplicates(records);

  const { duplicateGroups } = assignMemIds(records);
  assertRowidUnique(records);
  for (const rec of records) rec.text_sha256 = textSha256(rec.embedText);

  process.stderr.write(
    `[embed] 读取 ${loaded.memoryFiles}/${loaded.files} 个文件，${records.length} 条记忆` +
      `${loaded.parseFailures ? `，${loaded.parseFailures} 个文件解析失败` : ''}\n`,
  );
  process.stderr.write(
    `[embed] textField=${opts.textField}` +
      `${opts.textField === 'statement+evidence' ? `（有 evidence 的 ${loaded.withEvidence}/${records.length} 条）` : ''}` +
      `  输出 ${outputPaths(opts).vectors}\n`,
  );
  if (duplicateStats.duplicateIds > 0) {
    process.stderr.write(
      `[embed] warn: id=<session_id>:<seq> 有 ${duplicateStats.duplicateIds} 条重复` +
        `（${duplicateStats.uniqueIds} 个唯一 id / ${records.length} 条）；` +
        `id 是兼容字段，身份用 mem_id\n`,
    );
  }
  if (duplicateGroups.length > 0) {
    process.stderr.write(
      `[embed] warn: ${duplicateGroups.length} 组记忆的 session_id+seq+evidence 完全相同` +
        `（同一条 evidence 抽出多条 statement），这些记录用派生 mem_id：\n`,
    );
    for (const group of duplicateGroups) {
      process.stderr.write(
        `  base=${group.base} session=${group.records[0].session_id}` +
          ` seq=${group.records[0].seq}\n`,
      );
    }
  }

  if (opts.smoke) {
    const summary = await runSmoke(opts, records);
    process.exit(summary.ok ? 0 : 1);
  }

  const summary = await runFull(opts, records, duplicateStats);
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[embed] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
