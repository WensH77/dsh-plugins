#!/usr/bin/env node
/**
 * 记忆检索层：关键词（FTS5 + bigram）+ 向量（sqlite-vec KNN）+ RRF 融合。
 *
 * 用法：
 *   node mem-search.mjs "<query>" [--k 5] [--strategy s1|s2|s3|s4|s5|s6] [--kw-weight N]
 *                       [--keyword-mode tokens|phrase] [--expand]
 *                       [--rerank] [--no-rerank] [--rerank-depth N]
 *                       [--project <子串>] [--kind <kind>]
 *                       [--collapse-dups] [--duplicates <file>]
 *                       [--miss-threshold N] [--miss-cosine N]
 *                       [--json] [--no-vector] [--no-keyword] [--no-miss-log]
 *
 * 失败查询记录：CLI 默认把空结果 / 过滤后为空 / 执行异常 / 低置信度追加到
 * ~/.dsh/memory-export/miss-log.jsonl（字段见 recordMiss）；--no-miss-log 关闭。
 * 低置信度判据：重排开启时 top rerank 分数 <= --miss-threshold（默认 2）；
 * --no-rerank 时 top 结果的向量余弦 <= --miss-cosine（默认 0.35）。
 * 日志超过 5 MB 轮转为 miss-log.1.jsonl。评测脚本 import search() 不触发记录。
 *
 * --collapse-dups：按 duplicates.jsonl（refresh 的去重标记）折叠重复簇，
 *   同一簇只返回排名最靠前的一条，被折叠的 mem_id 记在结果的 also 里。
 *
 * 每条结果都带 mem_id（稳定身份，定义见 mem-id.mjs），offset 只用于排序/展示。
 *
 * 召回：关键词 + 向量（sqlite-vec KNN），各自取 routeLimit 条。
 * 融合策略：
 *   s1  等权 RRF（基线）
 *   s2  查询类型路由（旧行为，保留作基线）：含精确 token（exact 或 mixed）→
 *       关键词为主、向量补齐；纯自然语言 → 向量为主、关键词补齐
 *   s3  加权 RRF：关键词路权重 --kw-weight（默认 3），向量路权重 1
 *   s4  关键词优先回填：关键词 top-k，不足 k 再用向量补齐
 *   s5  三类路由：exact → 关键词优先；mixed → 等权 RRF；natural → 向量优先
 *   s6  三类路由：exact → 关键词优先；mixed / natural → 向量优先
 *
 * 查询分类（classifyQuery）：
 *   exact   抽出 token 后，剩余文本只剩标点/空白（纯 token 或 token 序列）
 *   mixed   抽得出 token，且剩余文本里中文 >= 2 字，或非 token 的 ASCII 字母 >= 20
 *   natural 抽不出 token
 *   s2 为保持改造前基线，仍把 mixed 归入「有 token → 关键词优先」，
 *   新路由只在 s5/s6 里生效。
 *
 * 关键词路（--keyword-mode）：
 *   tokens（默认）先按规则抽出精确 token，对每个 token 做 FTS 匹配（token 内部按
 *     bigram 展开后 AND），token 之间 OR；排序按「命中 token 数 → bm25 → 名次」。
 *     抽不到 token 的纯中文查询回退到旧行为。
 *   phrase 旧行为：整句 bigram 按序短语匹配。保留用于对照。
 *
 * --expand：只对判为 natural 的查询触发。用 deepseek-flash 生成 3-5 条中文关键词
 *   变体。--expand-target 决定变体喂给哪条路（默认 keyword）：keyword 逐条跑关键词路
 *   再按 RRF 合并；vector 逐条做 KNN，同一 offset 取余弦最大值后按相似度降序进入融合；
 *   both 两边都喂。显式写 vector/both 时不必再加 --expand。扩展失败或空变体时降级
 *   为只用原查询。
 *
 * --rerank（CLI 默认开启）：只对 natural / mixed 查询触发，取融合后的 top-N
 *   （--rerank-depth，默认 100）交给 deepseek-flash 按 1-5 分判相关性后重排，再取前 k。
 *   候选按固定种子打乱后编号，避免位置偏差；解析失败/超时退化为原始顺序。
 *   exact 查询不重排。--no-rerank 可回到纯融合排序。
 *
 * --project / --kind 在融合前对两路候选做外层过滤；不进入 vec0 的 KNN 查询
 *（vec0 的 KNN 不支持对 auxiliary column 加 WHERE）。带过滤时初始候选深度放大到
 * 500，若过滤后不足 k 条则按 ×4 自适应加深，直到两路都取尽（最多 20000）。
 *
 * 向量：查询侧加与 embed.mjs 相同的 instruction，last-token 池化 + L2 归一化，
 *       默认 L2 距离（向量已单位化，等价 cosine）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { getExpansion } from './query-expand.mjs';
import { memIdToRowid } from './mem-id.mjs';
import {
  rerankCandidates,
  rerankStats,
  DEFAULT_RERANK_DEPTH,
  DEFAULT_RERANK_MODEL,
  DEFAULT_TIMEOUT_MS as DEFAULT_RERANK_TIMEOUT_MS,
  DEFAULT_SEED as DEFAULT_RERANK_SEED,
  MIN_RERANK_DEPTH,
  MAX_RERANK_DEPTH,
} from './rerank.mjs';

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.dsh', 'memory-export');
const DEFAULT_DB = path.join(DATA_DIR, 'memory.db');
const MISS_LOG_FILE = path.join(DATA_DIR, 'miss-log.jsonl');
const DUPLICATES_FILE = path.join(DATA_DIR, 'duplicates.jsonl');
const MISS_LOG_ROTATED = path.join(DATA_DIR, 'miss-log.1.jsonl');
const MISS_LOG_MAX_BYTES = 5 * 1024 * 1024;
const MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const DTYPE = 'q8';
const DIM = 1024;
const MIRROR = 'https://hf-mirror.com/';
const CACHE_DIR = path.join(HOME, '.cache', 'huggingface', 'transformers');
const QUERY_INSTRUCTION =
  'Instruct: Given a Chinese personal-memory search query, retrieve the memories that answer it\nQuery:';

const ROUTE_LIMIT = 50;
const FILTER_ROUTE_LIMIT = 500;
// vec0 的 KNN 查询上限是 4096，超过会报 "k value in knn query too large"。
// 4096 仍不够时走精确过滤回退（全表算距离），见 search()。
const MAX_FILTER_ROUTE_LIMIT = 4096;
const RRF_K = 60;
const DEFAULT_STRATEGY = 's6';
const DEFAULT_KW_WEIGHT = 3;
const DEFAULT_KEYWORD_MODE = 'tokens';
const KEYWORD_MODES = ['tokens', 'phrase'];
const DEFAULT_EXPAND_TARGET = 'keyword';
// 重排分数（1-5）<= 2 视为「语义上答不上来」；不重排时用 top 结果的向量余弦 <= 0.35。
const DEFAULT_MISS_THRESHOLD = 2;
const DEFAULT_MISS_COSINE = 0.35;
// --collapse-dups 打开时多取这么多倍的候选，避免同簇成员占满 k 个槽位。
const COLLAPSE_OVERFETCH = 4;
const EXPAND_TARGETS = ['keyword', 'vector', 'both'];
const STRATEGIES = ['s1', 's2', 's3', 's4', 's5', 's6'];
const STATEMENT_PREVIEW = 160;
// 空扩展结果按进程去重 warn（评测里同一查询会被反复检索）。
const emptyExpansionWarned = new Set();

/* ------------------------------ miss log --------------------------------- */

// 只在 CLI 主流程里启用：评测脚本 import search() 直接调用，不会写日志。
// 记录空结果 / 过滤后为空 / 执行异常，供 miss-review.mjs 汇总与人工标注。
let missContext = null;

/** 查询归一化：trim + 连续空白折叠 + 小写。 */
export function normalizeMissQuery(query) {
  return String(query ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 归一化查询的 sha1，用于 miss-log 去重。 */
export function missQueryId(query) {
  return crypto.createHash('sha1').update(normalizeMissQuery(query), 'utf8').digest('hex');
}

function rotateMissLogIfNeeded() {
  let size;
  try {
    size = fs.statSync(MISS_LOG_FILE).size;
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (size <= MISS_LOG_MAX_BYTES) return;
  fs.renameSync(MISS_LOG_FILE, MISS_LOG_ROTATED);
}

/**
 * 追加一条失败查询。任何写盘错误都吞掉：日志是旁路，不能影响检索本身。
 * 入口在 die()/main() 的 catch 与空结果分支，正常有结果不调用。
 */
function recordMiss(reason, { error = null, topScore = null, elapsedMs = null } = {}) {
  const ctx = missContext;
  if (!ctx || !ctx.enabled) return;
  const elapsed = elapsedMs ?? performance.now() - ctx.startedAt;
  const entry = {
    ts: new Date().toISOString(),
    query: ctx.query,
    reason,
    k: ctx.k,
    project: ctx.project ?? null,
    kind: ctx.kind ?? null,
    topScore: topScore == null || !Number.isFinite(Number(topScore)) ? null : Number(topScore),
    elapsedMs: Math.max(0, Math.round(elapsed)),
    mode: ctx.mode,
    error: error == null ? null : String(error),
    qid: missQueryId(ctx.query),
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    rotateMissLogIfNeeded();
    fs.appendFileSync(MISS_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 忽略：写日志失败不影响检索。
  }
}

function die(msg, code = 1) {
  // 参数校验阶段的 die 发生在 missContext 建立之前，不会被记录；
  // 建立之后的 die（库缺失、扩展/模型加载失败）算执行异常。
  recordMiss('error', { error: msg });
  process.stderr.write(`[mem-search] error: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    query: null,
    k: 5,
    project: null,
    kind: null,
    strategy: DEFAULT_STRATEGY,
    kwWeight: DEFAULT_KW_WEIGHT,
    keywordMode: DEFAULT_KEYWORD_MODE,
    expand: false,
    expandExplicit: false,
    expandTarget: DEFAULT_EXPAND_TARGET,
    rerank: true, // 验收门槛已达标（paraphrase hit@5 +24pp、keyword 不退化），CLI 默认开启
    rerankDepth: DEFAULT_RERANK_DEPTH,
    rerankModel: DEFAULT_RERANK_MODEL,
    rerankTimeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
    json: false,
    missLog: true,
    missThreshold: DEFAULT_MISS_THRESHOLD,
    missCosine: DEFAULT_MISS_COSINE,
    collapseDups: false,
    duplicatesFile: DUPLICATES_FILE,
    vector: true,
    keyword: true,
    db: DEFAULT_DB,
    help: false,
  };
  const needValue = (i, flag) => {
    if (i + 1 >= argv.length) die(`${flag} 缺少参数值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-miss-log') opts.missLog = false;
    else if (a === '--collapse-dups') opts.collapseDups = true;
    else if (a === '--miss-threshold') {
      const v = needValue(i, a);
      i++;
      opts.missThreshold = Number(v);
      if (!Number.isFinite(opts.missThreshold) || opts.missThreshold < 0 || opts.missThreshold > 5) {
        die(`--miss-threshold 必须是 0..5 的数字，收到 ${v}`);
      }
    } else if (a === '--miss-cosine') {
      const v = needValue(i, a);
      i++;
      opts.missCosine = Number(v);
      if (!Number.isFinite(opts.missCosine) || opts.missCosine < -1 || opts.missCosine > 1) {
        die(`--miss-cosine 必须是 -1..1 的数字，收到 ${v}`);
      }
    } else if (a === '--duplicates') {
      opts.duplicatesFile = path.resolve(needValue(i, a));
      i++;
    }
    else if (a === '--no-vector') opts.vector = false;
    else if (a === '--no-keyword') opts.keyword = false;
    else if (a === '--expand') {
      opts.expand = true;
      opts.expandExplicit = true;
    } else if (a === '--no-expand') {
      opts.expand = false;
      opts.expandExplicit = true;
    }
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--rerank') opts.rerank = true;
    else if (a === '--no-rerank') opts.rerank = false;
    else if (a === '--rerank-depth') {
      const v = needValue(i, a);
      i++;
      opts.rerankDepth = Number(v);
      if (
        !Number.isInteger(opts.rerankDepth) ||
        opts.rerankDepth < MIN_RERANK_DEPTH ||
        opts.rerankDepth > MAX_RERANK_DEPTH
      ) {
        die(`--rerank-depth 必须是 ${MIN_RERANK_DEPTH}..${MAX_RERANK_DEPTH} 的整数，收到 ${v}`);
      }
    } else if (a === '--keyword-mode') {
      const v = needValue(i, a);
      i++;
      if (!KEYWORD_MODES.includes(v)) {
        die(`--keyword-mode 只能是 ${KEYWORD_MODES.join('|')}，收到 ${v}`);
      }
      opts.keywordMode = v;
    } else if (a === '--expand-target') {
      const v = needValue(i, a);
      i++;
      if (!EXPAND_TARGETS.includes(v)) {
        die(`--expand-target 只能是 ${EXPAND_TARGETS.join('|')}，收到 ${v}`);
      }
      opts.expandTarget = v;
    } else if (a === '--k') {
      const v = needValue(i, a);
      i++;
      opts.k = Number(v);
      if (!Number.isInteger(opts.k) || opts.k < 1 || opts.k > 200) {
        die(`--k 必须是 1..200 的整数，收到 ${v}`);
      }
    } else if (a === '--project') {
      opts.project = needValue(i, a);
      i++;
    } else if (a === '--kind') {
      opts.kind = needValue(i, a);
      i++;
    } else if (a === '--strategy') {
      const v = needValue(i, a);
      i++;
      if (!STRATEGIES.includes(v)) die(`--strategy 只能是 ${STRATEGIES.join('|')}，收到 ${v}`);
      opts.strategy = v;
    } else if (a === '--kw-weight') {
      const v = needValue(i, a);
      i++;
      opts.kwWeight = Number(v);
      if (!Number.isFinite(opts.kwWeight) || opts.kwWeight <= 0) {
        die(`--kw-weight 必须是正数，收到 ${v}`);
      }
    } else if (a === '--db') {
      opts.db = path.resolve(needValue(i, a));
      i++;
    } else if (a.startsWith('-')) {
      die(`未知参数 ${a}（--help 查看用法）`);
    } else {
      if (opts.query !== null) die(`多余的参数 ${a}（查询请用引号包成一段）`);
      opts.query = a;
    }
  }
  if (opts.help) return opts;
  if (opts.query == null || opts.query.trim() === '') die('缺少查询语句');
  if (!opts.vector && !opts.keyword) die('--no-vector 与 --no-keyword 不能同时使用');
  return opts;
}

function printHelp() {
  process.stdout.write(`用法: node mem-search.mjs "<query>" [选项]

  --k N              返回条数，默认 5（1..200）
  --strategy NAME    融合策略 s1|s2|s3|s4|s5|s6，默认 ${DEFAULT_STRATEGY}
  --kw-weight N      s3 的关键词路权重，默认 ${DEFAULT_KW_WEIGHT}
  --keyword-mode M   关键词路 tokens|phrase，默认 ${DEFAULT_KEYWORD_MODE}
                     tokens=抽取精确 token（OR 合并），phrase=整句 bigram 短语
  --expand           对自然语言查询调用 deepseek-flash 扩展查询变体（默认关）
  --no-expand        关闭查询扩展
  --expand-target T  变体喂给哪条路：keyword|vector|both，默认 ${DEFAULT_EXPAND_TARGET}
                     显式写 vector/both 时即使不加 --expand 也会触发扩展；
                     变体进向量路时各自做 KNN，同一条记忆取余弦最大值
  --rerank           对 natural / mixed 查询用 ${DEFAULT_RERANK_MODEL} 重排候选
                     （CLI 默认开启；exact 查询不重排）
  --no-rerank        关闭重排（回到纯融合排序）
  --rerank-depth N   取融合后前 N 条交给重排，默认 ${DEFAULT_RERANK_DEPTH}（${MIN_RERANK_DEPTH}..${MAX_RERANK_DEPTH}）
                     候选顺序按固定种子打乱；解析失败/超时退化为原始顺序
  --project <子串>   只保留 cwd 包含该子串的候选（大小写不敏感）
  --kind <kind>      只保留指定 kind 的候选
  --json             输出完整字段（含 evidence/tags/routes）
  --miss-threshold N 重排开启时，top rerank 分数 <= N 记 low-confidence，默认 ${DEFAULT_MISS_THRESHOLD}
  --miss-cosine N    --no-rerank 时用 top 结果的向量余弦阈值，默认 ${DEFAULT_MISS_COSINE}
  --collapse-dups    按 ${DUPLICATES_FILE} 的标记折叠重复簇，同簇只返回一条并在结果里带 also
  --duplicates <f>   指定去重标记文件（默认 ${DUPLICATES_FILE}）
  --no-miss-log      不把空结果/低置信度/异常查询追加到 ${MISS_LOG_FILE}
  --no-vector        只跑关键词路
  --no-keyword       只跑向量路
  --db <file>        数据库路径，默认 ${DEFAULT_DB}
  -h, --help         显示本帮助
`);
}

function truncateChars(text, n) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

/* ------------------------------- bigram ---------------------------------- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const ALNUM_RE = /[A-Za-z0-9_]/;

/**
 * 与 build-db.mjs 的 expandBigrams 必须逐字一致。
 * 连续 CJK → 重叠 bigram（n=1 保留单字）；英文/数字/下划线小写原样；其余当分隔符。
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

/* ---------------------------- token extraction --------------------------- */

/**
 * 关键词路的精确 token 抽取。规则（命中任一条即收，按出现顺序去重）：
 *   1. 引号内字符串："..."、'...'、`...`、中文引号；内容整体作为一个 token。
 *   2. 含符号的 ASCII 串：. _ - / \ : # > @ ~ + = % & ? 等，例如
 *      webServer.register、chrome.sidePanel.open()、bcg-mail-blocks.py、-U0、URL/路径。
 *      命令按空白拆成段，每段单独判断（git diff -U0 → -U0 是 token）。
 *   3. camelCase（sidePanel、canOpenLink）。
 *   4. 全大写缩写（STALE_MS、API），允许数字和下划线。
 *   5. 长度 >= 6 的纯 ASCII 单词（bigram、mailhog、clickable）。
 *   6. 首字母大写的专有名词（Cegid、Silae），长度 >= 5，排除常见英文虚词。
 * 中文不抽 token：纯中文查询走旧 bigram 短语回退；混合查询里的中文部分不参与。
 */

const QUOTED_RE = /"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|“([^”\n]+)”|‘([^’\n]+)’/g;
// 一段「ASCII 串」的字符集合；符号后面统一判断。开头的 . / \ : # > @ 等会被裁掉，
// 但开头的 - 保留（-U0、--flag 这类命令行参数本身就是 token）。
const ASCII_RUN_RE = /[A-Za-z0-9_.\-/\\:#>@~+%=&?$*]+/g;
const LEAD_TRIM_RE = /^[.\/\\:#>@~+=%&?$*]+/;
const TAIL_TRIM_RE = /[.\/\\:#>@~+=%&?$*\-]+$/;
const SYMBOL_RE = /[._/\\:#>@~+=%&?$\-]/;
const PROPER_STOPWORDS = new Set(
  (
    'about after again against also another because been before being below between ' +
    'both call called calls can could did does doing done down during each even every ' +
    'first from further have having here hers herself himself into itself just like ' +
    'made make many more most much must myself once only other ought over same should ' +
    'some such than that their theirs them themselves then there these they this those ' +
    'through under until very was were what when where which while who whom why will ' +
    'with would your yours yourself'
  ).split(' '),
);

function trimAsciiRun(run) {
  return String(run).replace(LEAD_TRIM_RE, '').replace(TAIL_TRIM_RE, '');
}

function classifyAsciiRun(run) {
  if (!/[A-Za-z]/.test(run)) return null;
  if (SYMBOL_RE.test(run)) return 'symbol';
  if (/[a-z][A-Z]/.test(run)) return 'camel';
  if (/^[A-Z0-9_]+$/.test(run) && /[A-Z]/.test(run)) return 'acronym';
  if (/^[A-Za-z]+$/.test(run) && run.length >= 6) return 'long';
  // 「纯 ASCII 词」放宽到含数字/下划线后仍不带其他符号的串（sales30、v2sample）。
  if (/^[A-Za-z0-9_]+$/.test(run) && /^[a-z0-9_]+$/.test(run) && run.length >= 6) return 'long';
  if (/^[A-Z][a-z]+$/.test(run) && run.length >= 5 && !PROPER_STOPWORDS.has(run.toLowerCase())) {
    return 'proper';
  }
  return null;
}

/**
 * 返回 [{ raw, kind, terms }]，rules 见上。terms 是 expandBigrams(raw) 的去重结果，
 * 即 FTS5 索引侧真正会出现的词项；token 内部用 AND 组合这些词项。
 */
export function extractKeywordTokens(text) {
  const source = String(text ?? '');
  const tokens = [];
  const seen = new Set();
  const push = (raw, kind) => {
    const value = String(raw).trim();
    if (!value) return;
    const terms = [...new Set(expandBigrams(value))];
    if (terms.length === 0) return;
    const key = terms.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push({ raw: value, kind, terms });
  };

  // 1) 引号内字符串：先抽走，并从扫描语料里抹掉，避免内部 ASCII 被重复抽取。
  let remaining = source;
  for (const m of source.matchAll(QUOTED_RE)) {
    const content = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    push(content, 'quoted');
    const start = m.index ?? 0;
    remaining =
      remaining.slice(0, start) +
      ' '.repeat(m[0].length) +
      remaining.slice(start + m[0].length);
  }

  // 2) ASCII 串按空白/中文分段。中文和空白天然是分隔符（不在 ASCII_RUN_RE 里）。
  for (const m of remaining.matchAll(ASCII_RUN_RE)) {
    const run = trimAsciiRun(m[0]);
    if (run.length < 2) continue;
    const kind = classifyAsciiRun(run);
    if (kind) push(run, kind);
  }
  return tokens;
}

function buildFtsExpr(terms) {
  const quoted = terms.map((t) => `"${String(t).replace(/"/g, '""')}"`);
  return quoted.length === 1 ? quoted[0] : quoted.join(' AND ');
}

/* -------------------------------- DB ------------------------------------- */

export function openSearchDb(dbPath = DEFAULT_DB) {
  if (!fs.existsSync(dbPath)) die(`数据库不存在: ${dbPath}（先运行 build-db.mjs）`);
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.loadExtension(getLoadablePath());
  } catch (err) {
    db.close();
    die(`加载 sqlite-vec 扩展失败: ${err.message}`);
  }
  // 预热一次：让 SQLite 页缓存与 FTS5 段读进来，单次 CLI 的延迟更接近稳定值。
  db.prepare('select count(*) as c from memories').get();
  return db;
}

/* ------------------------------- encoder --------------------------------- */

export async function initModel() {
  const started = performance.now();
  const tf = await import('@huggingface/transformers');
  const { pipeline, env } = tf;
  env.remoteHost = MIRROR;
  env.cacheDir = CACHE_DIR;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: DTYPE,
    device: 'cpu',
  });
  const paddingSide = extractor?.tokenizer?.padding_side ?? null;
  if (paddingSide !== 'left') {
    throw new Error(
      `tokenizer.padding_side=${JSON.stringify(paddingSide)}，last-token 池化要求 left padding`,
    );
  }
  return { extractor, initMs: performance.now() - started };
}

export async function encodeQuery(extractor, query) {
  const text = `${QUERY_INSTRUCTION} ${query}`;
  const tensor = await extractor([text], { pooling: 'last_token', normalize: true });
  const dims = tensor?.dims;
  if (!Array.isArray(dims) || dims.length !== 2 || dims[0] !== 1 || dims[1] !== DIM) {
    throw new Error(`查询向量维度异常: dims=${JSON.stringify(dims)}`);
  }
  const data = tensor.data;
  const vec = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) vec[i] = data[i];
  return vec;
}

/* ------------------------------ retrieval -------------------------------- */

const SELECT_FIELDS = `
  m.offset, m.mem_id, m.session_id, m.cwd, m.kind, m.seq, m.time,
  m.statement, m.evidence, m.tags, m.text_len
`;

function rowToRecord(row) {
  let tags = [];
  try {
    tags = JSON.parse(row.tags || '[]');
  } catch {
    tags = [];
  }
  return {
    offset: Number(row.offset),
    mem_id: row.mem_id,
    session_id: row.session_id,
    cwd: row.cwd,
    kind: row.kind,
    seq: row.seq,
    time: row.time,
    statement: row.statement,
    evidence: row.evidence,
    tags: Array.isArray(tags) ? tags : [],
    text_len: Number(row.text_len ?? 0),
  };
}

function whereClause(filterOpts, params) {
  const where = ['mem_fts MATCH ?'];
  if (filterOpts.kind) {
    where.push('m.kind = ?');
    params.push(filterOpts.kind);
  }
  if (filterOpts.project) {
    where.push('instr(lower(m.cwd), ?) > 0');
    params.push(filterOpts.project.toLowerCase());
  }
  return where.join(' AND ');
}

/** 旧关键词路：整句 bigram 按序短语匹配。 */
function keywordSearchPhrase(db, query, limit, filterOpts) {
  const tokens = expandBigrams(query);
  if (tokens.length === 0) return { tokens, rows: [], keywordMode: 'phrase' };
  const phrase = `"${tokens.join(' ')}"`;
  const params = [phrase];
  const where = whereClause(filterOpts, params);
  const rows = db
    .prepare(
      `SELECT ${SELECT_FIELDS}, bm25(mem_fts) AS rank
         FROM mem_fts
         JOIN memories m ON m.offset = mem_fts.rowid
        WHERE ${where}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(...params, limit);
  return { tokens, phrase, rows: rows.map(rowToRecord), keywordMode: 'phrase' };
}

/**
 * 新关键词路：每个 token 单独跑一次 FTS（token 内部 bigram AND），token 之间 OR。
 * 合并排序：命中 token 数降序 → Σ(-bm25) 降序 → 单 token 最好名次升序 → offset。
 * 本库是 contentless FTS5，实测 bm25() 可用（SQLite 3.53.4 / node:sqlite），
 * 所以没有走「命中数 + 位置」的自算分回退。
 */
function keywordSearchTokens(db, query, limit, filterOpts) {
  const extracted = extractKeywordTokens(query);
  if (extracted.length === 0) {
    // 纯中文查询不抽 token：保留旧 bigram 短语匹配作为回退。
    const out = keywordSearchPhrase(db, query, limit, filterOpts);
    return { ...out, keywordMode: 'tokens', tokens: [], fallback: 'phrase' };
  }
  const byOffset = new Map();
  const tokenDetails = [];
  for (const token of extracted) {
    const expr = buildFtsExpr(token.terms);
    const params = [expr];
    const where = whereClause(filterOpts, params);
    const rows = db
      .prepare(
        `SELECT ${SELECT_FIELDS}, bm25(mem_fts) AS rank
           FROM mem_fts
           JOIN memories m ON m.offset = mem_fts.rowid
          WHERE ${where}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(...params, limit);
    tokenDetails.push({
      raw: token.raw,
      kind: token.kind,
      terms: token.terms,
      matched: rows.length,
    });
    rows.forEach((row, i) => {
      const rec = rowToRecord(row);
      const rank = i + 1;
      const bm25 = -Number(row.rank);
      let entry = byOffset.get(rec.offset);
      if (!entry) {
        entry = { rec, hits: 0, bm25Sum: 0, bestRank: Infinity, tokenRanks: [] };
        byOffset.set(rec.offset, entry);
      }
      entry.hits += 1;
      entry.bm25Sum += bm25;
      entry.bestRank = Math.min(entry.bestRank, rank);
      entry.tokenRanks.push({ token: token.raw, rank });
    });
  }
  const merged = [...byOffset.values()]
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        b.bm25Sum - a.bm25Sum ||
        a.bestRank - b.bestRank ||
        a.rec.offset - b.rec.offset,
    )
    .slice(0, limit)
    .map((entry) => ({
      ...entry.rec,
      keywordHits: entry.hits,
      keywordBestRank: entry.bestRank,
      matchedTokens: entry.tokenRanks.map((t) => t.token),
    }));
  return {
    tokens: extracted.map((t) => t.raw),
    tokenDetails,
    rows: merged,
    keywordMode: 'tokens',
  };
}

export function keywordSearch(
  db,
  query,
  limit = ROUTE_LIMIT,
  { mode = DEFAULT_KEYWORD_MODE, filter = {} } = {},
) {
  return mode === 'phrase'
    ? keywordSearchPhrase(db, query, limit, filter)
    : keywordSearchTokens(db, query, limit, filter);
}

export function vectorSearch(db, queryVector, limit = ROUTE_LIMIT) {
  const blob = Buffer.from(
    queryVector.buffer,
    queryVector.byteOffset,
    queryVector.byteLength,
  );
  // KNN 只能把 LIMIT 放进子查询；metadata 在外层 JOIN，过滤放到 JS 里做。
  const rows = db
    .prepare(
      `SELECT ${SELECT_FIELDS}, v.distance AS distance
         FROM (SELECT rowid, distance FROM mem_vec
                WHERE embedding MATCH ?
                ORDER BY distance
                LIMIT ?) v
         JOIN memories m ON m.id_int = v.rowid
        ORDER BY v.distance`,
    )
    .all(blob, limit);
  return rows.map((row) => ({ ...rowToRecord(row), distance: Number(row.distance) }));
}

/**
 * vec0 返回 L2 距离。embed.mjs 已把向量单位化，所以 ||a-b||² = 2 - 2cos，
 * 即 cosine = 1 - d²/2。距离理论上落在 [0,2]，做一次 clamp 防浮点越界。
 */
export function cosineFromL2(distance) {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 0;
  return Math.max(-1, Math.min(1, 1 - (d * d) / 2));
}

/**
 * 多条查询/变体各做一次 KNN 后合并：同一个 offset 取余弦最大值，而不是按 rank 做 RRF。
 * 排序按合并后的余弦降序；同分时用该 offset 在单条查询里的最好名次，再按 offset 稳定排序。
 * 返回的每条带 similarity（余弦）与 vectorMatches（每条查询的 rank / 余弦，供报告）。
 */
export function mergeVectorCandidates(lists) {
  // 只有原查询时保持原样，不往记录里加额外字段，避免改变既有输出形状。
  if (lists.length === 1) return lists[0].rows;
  const merged = new Map();
  for (const { source, query, rows } of lists) {
    rows.forEach((rec, i) => {
      const cosine = cosineFromL2(rec.distance);
      const match = { source, query, rank: i + 1, cosine };
      let entry = merged.get(rec.offset);
      if (!entry) {
        entry = {
          ...rec,
          similarity: cosine,
          vectorMatches: [match],
        };
        merged.set(rec.offset, entry);
      } else {
        entry.vectorMatches.push(match);
        if (cosine > entry.similarity) {
          entry.similarity = cosine;
          entry.distance = rec.distance;
        }
      }
    });
  }
  return [...merged.values()].sort(
    (a, b) =>
      b.similarity - a.similarity ||
      Math.min(...a.vectorMatches.map((m) => m.rank)) -
        Math.min(...b.vectorMatches.map((m) => m.rank)) ||
      a.offset - b.offset,
  );
}

export function passesFilter(rec, { project = null, kind = null } = {}) {
  if (kind && rec.kind !== kind) return false;
  if (project) {
    const needle = project.toLowerCase();
    const haystack = String(rec.cwd ?? '').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * 精确过滤版关键词检索：把 project/kind 推进 SQL，先过滤再取 limit 条。
 * 用于 KNN 深度到顶后仍凑不满 k 的兜底。keyword-mode 与普通检索一致。
 */
export function keywordSearchFiltered(
  db,
  query,
  limit,
  filterOpts = {},
  { mode = DEFAULT_KEYWORD_MODE } = {},
) {
  return keywordSearch(db, query, limit, { mode, filter: filterOpts });
}

/**
 * 精确过滤版向量检索：对过滤后的行做全表距离计算（vec_distance_L2），
 * 不受 vec0 KNN 的 4096 上限影响。慢（全表 9,044 行），只在兜底时调用。
 */
export function vectorSearchFiltered(db, queryVector, limit, filterOpts = {}) {
  const where = [];
  const params = [queryVector];
  if (filterOpts.kind) {
    where.push('m.kind = ?');
    params.push(filterOpts.kind);
  }
  if (filterOpts.project) {
    where.push('instr(lower(m.cwd), ?) > 0');
    params.push(filterOpts.project.toLowerCase());
  }
  const rows = db
    .prepare(
      `SELECT ${SELECT_FIELDS}, vec_distance_L2(v.embedding, ?) AS distance
         FROM mem_vec v
         JOIN memories m ON m.id_int = v.rowid
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY distance
        LIMIT ?`,
    )
    .all(...params, limit);
  return rows.map((row) => ({ ...rowToRecord(row), distance: Number(row.distance) }));
}

/* ----------------------------- query class ------------------------------- */

// mixed 判据阈值。中文阈值取 2：单个汉字可能只是 token 旁边的单位/量词（「STALE_MS 值」），
// 2 个及以上才算自然语言措辞；纯 token 查询剩 0 个汉字，eval-set 的 5 条混合查询剩 >= 10 个，
// 2 落在两者之间，分类不依赖阈值附近的巧合。
// 英文阈值取 20：token 序列里常见的短词（git、diff、curl、exit）加起来不到 20 个字母，
// 而一句话的自然语言英文通常超过 20；eval-set 里没有英文自然语言查询，这个阈值只防误伤。
const MIXED_CJK_MIN = 2;
const MIXED_EN_LETTERS_MIN = 20;

function countCjkChars(text) {
  let n = 0;
  for (const ch of String(text ?? '')) if (CJK_RE.test(ch)) n++;
  return n;
}

/**
 * 把抽出的 token 从原文里抹成空格（按出现顺序各抹一次），剩下的就是「非 token 内容」。
 * 引号 token 的 raw 是不带引号的内容，indexOf 仍能定位；定位不到就跳过。
 */
function stripTokenRaws(text, tokens) {
  let rest = String(text ?? '');
  for (const token of tokens) {
    const raw = String(token.raw ?? '');
    if (!raw) continue;
    const idx = rest.indexOf(raw);
    if (idx < 0) continue;
    rest = rest.slice(0, idx) + ' '.repeat(raw.length) + rest.slice(idx + raw.length);
  }
  return rest;
}

/**
 * 查询分三类，判据直接复用关键词路的 token 抽取规则（extractKeywordTokens），
 * 保证「分类说有 token」与「tokens 模式真能抽出 token」始终一致：
 *   exact   抽得出 token，且抹掉 token 后只剩标点/空白（纯 token 或 token 序列）
 *   mixed   抽得出 token，且剩余文本里中文 >= MIXED_CJK_MIN 字，
 *           或非 token 的 ASCII 字母 >= MIXED_EN_LETTERS_MIN
 *   natural 抽不出 token
 * 返回 { kind, tokens, signals }。signals 只用于展示：每个 token 一条 `kind:raw`，
 * mixed 追加 `mixed:cjk=N,en=N` 说明触发原因。
 */
export function classifyQuery(query) {
  const text = String(query ?? '');
  const tokens = extractKeywordTokens(text);
  if (tokens.length === 0) return { kind: 'natural', tokens: [], signals: [] };
  const tokenSignals = tokens.map((t) => `${t.kind}:${t.raw}`);
  const rest = stripTokenRaws(text, tokens);
  const cjk = countCjkChars(rest);
  const enLetters = (rest.match(/[A-Za-z]/g) ?? []).length;
  const mixed =
    cjk >= MIXED_CJK_MIN || enLetters >= MIXED_EN_LETTERS_MIN;
  return {
    kind: mixed ? 'mixed' : 'exact',
    tokens: tokens.map((t) => t.raw),
    signals: mixed
      ? [...tokenSignals, `mixed:cjk=${cjk},en=${enLetters}`]
      : tokenSignals,
  };
}

/* -------------------------------- fusion --------------------------------- */

/**
 * RRF：两路候选过滤后按下标重新排 rank，score = Σ weight / (60+rank)。
 * weights 缺省时等价等权（s1）。同分时按最好名次、再按 offset 稳定排序。
 */
export function fuseRrf(lists, k = 5, rrfK = RRF_K, weights = {}) {
  const merged = new Map();
  for (const { name, items } of lists) {
    const weight = Number(weights[name] ?? 1);
    for (let i = 0; i < items.length; i++) {
      const rec = items[i];
      let entry = merged.get(rec.offset);
      if (!entry) {
        entry = { ...rec, score: 0, routes: { keywordRank: null, vectorRank: null } };
        merged.set(rec.offset, entry);
      }
      const rank = i + 1;
      entry.score += weight / (rrfK + rank);
      if (name === 'keyword') entry.routes.keywordRank ??= rank;
      if (name === 'vector') {
        entry.routes.vectorRank ??= rank;
        if (entry.routes.distance == null) entry.routes.distance = rec.distance ?? null;
      }
    }
  }
  const bestRank = (entry) =>
    Math.min(
      entry.routes.keywordRank ?? Infinity,
      entry.routes.vectorRank ?? Infinity,
    );
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score || bestRank(a) - bestRank(b) || a.offset - b.offset,
    )
    .slice(0, k);
}

/**
 * 优先级融合：先按 primary 路的次序取前 k 条，不足 k 条再用 secondary 路补齐。
 * 结果里的 score 只用于展示排序（按最终位置给出递减值），不代表 RRF 分数。
 */
export function fusePriority(primaryName, primaryItems, secondaryName, secondaryItems, k = 5) {
  const entries = new Map();
  const ensure = (rec) => {
    let entry = entries.get(rec.offset);
    if (!entry) {
      entry = { ...rec, score: 0, routes: { keywordRank: null, vectorRank: null } };
      entries.set(rec.offset, entry);
    }
    return entry;
  };
  primaryItems.forEach((rec, i) => {
    const entry = ensure(rec);
    entry.routes[`${primaryName}Rank`] ??= i + 1;
  });
  secondaryItems.forEach((rec, i) => {
    const entry = ensure(rec);
    entry.routes[`${secondaryName}Rank`] ??= i + 1;
    if (entry.routes.distance == null) entry.routes.distance = rec.distance ?? null;
  });
  const order = [];
  const seen = new Set();
  const push = (rec) => {
    if (seen.has(rec.offset)) return;
    seen.add(rec.offset);
    order.push(rec.offset);
  };
  primaryItems.slice(0, k).forEach(push);
  for (const rec of secondaryItems) {
    if (order.length >= k) break;
    push(rec);
  }
  return order.map((offset, i) => ({
    ...entries.get(offset),
    score: 1 / (RRF_K + i + 1),
  }));
}

function fuseByStrategy(strategy, queryClass, opts, keywordItems, vectorItems) {
  const k = opts.k;
  const both = opts.keyword && opts.vector;
  const kind = queryClass.kind;
  // s2 保持改造前的二分类语义：只要抽得出 token（exact 或 mixed）就关键词优先。
  // 这样 P（s2+phrase）与 D（s2+tokens）仍是可复现的历史基线，修复只体现在 s5/s6。
  if (strategy === 's2' && both && kind !== 'natural') {
    return fusePriority('keyword', keywordItems, 'vector', vectorItems, k);
  }
  if (strategy === 's2' && both) {
    return fusePriority('vector', vectorItems, 'keyword', keywordItems, k);
  }
  if (strategy === 's5' && both) {
    if (kind === 'exact') return fusePriority('keyword', keywordItems, 'vector', vectorItems, k);
    if (kind === 'natural') return fusePriority('vector', vectorItems, 'keyword', keywordItems, k);
    // mixed：等权 RRF，两路名次都算数（落到函数末尾的 fuseRrf）
  }
  if (strategy === 's6' && both) {
    return kind === 'exact'
      ? fusePriority('keyword', keywordItems, 'vector', vectorItems, k)
      : fusePriority('vector', vectorItems, 'keyword', keywordItems, k);
  }
  if (strategy === 's4' && both) {
    return fusePriority('keyword', keywordItems, 'vector', vectorItems, k);
  }
  const lists = [];
  if (opts.keyword) lists.push({ name: 'keyword', items: keywordItems });
  if (opts.vector) lists.push({ name: 'vector', items: vectorItems });
  const weights = strategy === 's3' ? { keyword: opts.kwWeight } : {};
  return fuseRrf(lists, k, RRF_K, weights);
}

/**
 * 关键词变体合并：每条变体各一个有序候选表，按 RRF（k=60，等权）合成一条关键词路候选。
 * 只有一条变体（或只有它非空）时直接沿用该表，不改变单路排序。
 */
function mergeKeywordLists(lists, limit) {
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0].items.slice(0, limit);
  const merged = new Map();
  for (const { name, items } of lists) {
    void name;
    for (let i = 0; i < items.length; i++) {
      const rec = items[i];
      let entry = merged.get(rec.offset);
      if (!entry) {
        entry = { rec, score: 0, bestRank: Infinity };
        merged.set(rec.offset, entry);
      }
      entry.score += 1 / (RRF_K + i + 1);
      entry.bestRank = Math.min(entry.bestRank, i + 1);
    }
  }
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score || a.bestRank - b.bestRank || a.rec.offset - b.rec.offset,
    )
    .slice(0, limit)
    .map((entry) => entry.rec);
}

/**
 * 对一条查询（及其扩展变体）跑关键词路，合并成单条候选表。
 * perVariant 记录每条变体实际走的模式与 token，供评测报告。
 */
function keywordSearchVariants(db, variants, limit, filterOpts, mode) {
  const lists = [];
  const perVariant = [];
  const tokens = [];
  let modeUsed = mode;
  let fallback = null;
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const out = keywordSearch(db, variant.query, limit, { mode, filter: filterOpts });
    perVariant.push({
      query: variant.query,
      source: variant.source,
      mode: out.keywordMode,
      tokens: out.tokens,
      fallback: out.fallback ?? null,
      matched: out.rows.length,
    });
    if (out.tokenDetails) modeUsed = 'tokens';
    if (out.fallback === 'phrase') fallback = 'phrase';
    for (const tk of out.tokens) if (!tokens.includes(tk)) tokens.push(tk);
    if (out.rows.length > 0) lists.push({ name: `kw:${i}`, items: out.rows });
  }
  return {
    rows: mergeKeywordLists(lists, limit),
    perVariant,
    tokens,
    keywordMode: modeUsed,
    fallback,
  };
}

/* ------------------------------ 去重折叠 -------------------------------- */

let duplicateCache = null;

/**
 * 读 duplicates.jsonl（refresh 的去重步骤写）并做并查集。
 * 同一对只写一次、只标记不删除；这里只用于 --collapse-dups。
 */
function loadDuplicateClusters(file) {
  if (duplicateCache && duplicateCache.file === file) return duplicateCache.roots;
  const roots = new Map();
  const find = (id) => {
    let root = id;
    while (roots.get(root) !== root) root = roots.get(root);
    while (roots.get(id) !== root) {
      const next = roots.get(id);
      roots.set(id, root);
      id = next;
    }
    return root;
  };
  const add = (id) => {
    if (!roots.has(id)) roots.set(id, id);
  };
  if (!fs.existsSync(file)) {
    process.stderr.write(
      `[mem-search] warn: 去重标记文件不存在（${file}），--collapse-dups 不生效\n`,
    );
  } else {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let pair;
      try {
        pair = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof pair.mem_id_a !== 'string' || typeof pair.mem_id_b !== 'string') continue;
      add(pair.mem_id_a);
      add(pair.mem_id_b);
      const ra = find(pair.mem_id_a);
      const rb = find(pair.mem_id_b);
      if (ra !== rb) roots.set(rb, ra);
    }
  }
  duplicateCache = { file, roots };
  return roots;
}

function clusterRoot(roots, memId) {
  if (!roots.has(memId)) return memId;
  let root = memId;
  while (roots.get(root) !== root) root = roots.get(root);
  return root;
}

/** 同一簇只留排名最靠前的一条，被折叠掉的 mem_id 记进 also。 */
function collapseDuplicates(results, roots, k) {
  const kept = [];
  const byRoot = new Map();
  for (const rec of results) {
    const root = clusterRoot(roots, rec.mem_id);
    const keeper = byRoot.get(root);
    if (keeper) {
      keeper.also = keeper.also ?? [];
      keeper.also.push(rec.mem_id);
      continue;
    }
    const copy = { ...rec };
    byRoot.set(root, copy);
    kept.push(copy);
  }
  return kept.slice(0, k);
}

/**
 * 跑一次查询。timings 里 keywordMs / vectorMs(encode+knn) / expandMs / totalMs 供评测使用。
 * 带 project/kind 过滤时自适应放大候选深度，避免「先取 top-50 再过滤」导致冷门项目为空。
 */
export async function search(searcher, query, options = {}) {
  const opts = {
    k: 5,
    project: null,
    kind: null,
    strategy: DEFAULT_STRATEGY,
    kwWeight: DEFAULT_KW_WEIGHT,
    keywordMode: DEFAULT_KEYWORD_MODE,
    expand: false,
    expandExplicit: false,
    expandTarget: DEFAULT_EXPAND_TARGET,
    rerank: false,
    rerankDepth: DEFAULT_RERANK_DEPTH,
    rerankModel: DEFAULT_RERANK_MODEL,
    rerankTimeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
    rerankSeed: DEFAULT_RERANK_SEED,
    vector: true,
    keyword: true,
    routeLimit: null,
    maxRouteLimit: null,
    collapseDups: false,
    duplicatesFile: DUPLICATES_FILE,
    ...options,
  };
  if (!STRATEGIES.includes(opts.strategy)) {
    throw new Error(`未知策略 ${opts.strategy}（可选 ${STRATEGIES.join('|')}）`);
  }
  if (!KEYWORD_MODES.includes(opts.keywordMode)) {
    throw new Error(`未知 keywordMode ${opts.keywordMode}（可选 ${KEYWORD_MODES.join('|')}）`);
  }
  if (!EXPAND_TARGETS.includes(opts.expandTarget)) {
    throw new Error(
      `未知 expandTarget ${opts.expandTarget}（可选 ${EXPAND_TARGETS.join('|')}）`,
    );
  }
  if (!opts.vector && !opts.keyword) throw new Error('--no-vector 与 --no-keyword 不能同时使用');
  const rerankDepth = Number(opts.rerankDepth);
  if (
    !Number.isInteger(rerankDepth) ||
    rerankDepth < MIN_RERANK_DEPTH ||
    rerankDepth > MAX_RERANK_DEPTH
  ) {
    throw new Error(
      `rerankDepth 必须是 ${MIN_RERANK_DEPTH}..${MAX_RERANK_DEPTH} 的整数，收到 ${opts.rerankDepth}`,
    );
  }

  const strategy = opts.strategy;
  const filterActive = opts.project != null || opts.kind != null;
  const queryClass = classifyQuery(query);
  // exact 查询关键词本来就全中，不重排；只对 natural / mixed 触发。
  const rerankActive = opts.rerank === true && queryClass.kind !== 'exact';
  const started = performance.now();
  const timings = {
    keywordMs: 0,
    encodeMs: 0,
    variantEncodeMs: 0,
    knnMs: 0,
    vectorMs: 0,
    fuseMs: 0,
    expandMs: 0,
    rerankMs: 0,
  };

  // --expand 是总开关；显式把 expand-target 写成 vector/both 本身就表示要为向量路扩展，
  // 所以这两种取值不加 --expand 也会触发（只对 natural 查询，与旧行为一致）。
  // 显式写了 --expand / --no-expand 时以它为准，--no-expand 能压过 target=vector/both。
  const expandEnabled = opts.expandExplicit
    ? opts.expand === true
    : opts.expand || opts.expandTarget !== DEFAULT_EXPAND_TARGET;
  const keywordExpands =
    opts.keyword && (opts.expandTarget === 'keyword' || opts.expandTarget === 'both');
  const vectorExpands =
    opts.vector && (opts.expandTarget === 'vector' || opts.expandTarget === 'both');

  let expansion = null;
  let expansionVariants = [];
  if (expandEnabled && queryClass.kind === 'natural' && (keywordExpands || vectorExpands)) {
    const t = performance.now();
    const exp = await getExpansion(query);
    timings.expandMs += performance.now() - t;
    expansionVariants = exp.variants;
    expansion = {
      target: opts.expandTarget,
      variants: exp.variants,
      fromCache: exp.fromCache,
      elapsedMs: exp.elapsedMs,
      usage: exp.usage,
      error: exp.error,
    };
    // 空变体（HTTP 错误、解析不出、缓存里记着的失败）都降级为原查询；
    // 同一条查询在进程内只 warn 一次，避免评测循环刷屏。
    if (exp.variants.length === 0) {
      if (!emptyExpansionWarned.has(query)) {
        emptyExpansionWarned.add(query);
        process.stderr.write(
          `[mem-search] warn: 查询扩展没有可用变体（${exp.error ?? '空变体'}）；` +
            `降级为仅用原查询\n`,
        );
      }
    }
  }

  // 关键词路只接收该它接收的变体：expand-target=vector 时变体不进关键词路。
  const variants = [{ query, source: 'original' }];
  if (keywordExpands) {
    for (const v of expansionVariants) variants.push({ query: v, source: 'expand' });
  }

  const vectorQueries = [];
  const vectorVariantDetails = [];
  let vec = null;
  if (opts.vector) {
    if (!searcher.extractor) throw new Error('向量路需要先 initModel 并传入 extractor');
    const t0 = performance.now();
    vec = await encodeQuery(searcher.extractor, query);
    timings.encodeMs = performance.now() - t0;
    vectorQueries.push({ query, source: 'original', vector: vec });
    if (vectorExpands && expansionVariants.length) {
      for (const v of expansionVariants) {
        const t = performance.now();
        try {
          const variantVector = await encodeQuery(searcher.extractor, v);
          const encodeMs = performance.now() - t;
          timings.variantEncodeMs += encodeMs;
          vectorQueries.push({ query: v, source: 'expand', vector: variantVector });
          vectorVariantDetails.push({ query: v, encodeMs, matched: 0 });
        } catch (err) {
          const encodeMs = performance.now() - t;
          timings.variantEncodeMs += encodeMs;
          vectorVariantDetails.push({
            query: v,
            encodeMs,
            matched: 0,
            error: err?.message ?? String(err),
          });
          process.stderr.write(
            `[mem-search] warn: 扩展变体编码失败（${truncateChars(v, 40)}）：` +
              `${err?.message ?? err}；跳过该变体\n`,
          );
        }
      }
      if (vectorQueries.length === 1) {
        process.stderr.write(
          '[mem-search] warn: 全部扩展变体编码失败；向量路降级为仅用原查询\n',
        );
      }
    }
  }

  const configuredBaseLimit =
    opts.routeLimit ?? (filterActive ? FILTER_ROUTE_LIMIT : ROUTE_LIMIT);
  // 重排需要看到 top-N，N 可能大于 k 与默认 routeLimit；两条路都至少取到 N。
  const baseLimit = rerankActive ? Math.max(configuredBaseLimit, rerankDepth) : configuredBaseLimit;
  const maxLimit = opts.maxRouteLimit ?? (filterActive ? MAX_FILTER_ROUTE_LIMIT : baseLimit);
  const collapseDups = opts.collapseDups === true;
  const duplicateRoots = collapseDups ? loadDuplicateClusters(opts.duplicatesFile) : null;
  let fusionK = rerankActive ? Math.max(opts.k, rerankDepth) : opts.k;
  // 折叠后条数会变少，多取一些候选；上限由 routeLimit 决定。
  if (collapseDups) fusionK = Math.max(fusionK, opts.k * COLLAPSE_OVERFETCH);
  // fuseByStrategy 从 opts.k 取返回条数；重排时要先留下 top-N 再截到 k。
  const fusionOpts = fusionK === opts.k ? opts : { ...opts, k: fusionK };

  let limit = baseLimit;
  let attempts = 0;
  let keywordRows = [];
  let keywordFiltered = [];
  let vectorRows = [];
  let vectorFiltered = [];
  let keywordTokens = [];
  let keywordVariants = [];
  let keywordModeUsed = opts.keywordMode;
  let keywordFallback = null;
  let results = [];
  const filterOpts = { project: opts.project, kind: opts.kind };

  // 一条查询/变体一个 KNN 列表；多个列表按余弦最大值合并成一条向量路候选。
  const runVectorRoute = (routeLimit) => {
    if (vectorQueries.length <= 1) return vectorSearch(searcher.db, vec, routeLimit);
    const lists = vectorQueries.map((vq) => ({
      source: vq.source,
      query: vq.query,
      rows: vectorSearch(searcher.db, vq.vector, routeLimit),
    }));
    for (const list of lists) {
      if (list.source !== 'expand') continue;
      const detail = vectorVariantDetails.find((d) => d.query === list.query);
      if (detail) detail.matched = list.rows.length;
    }
    return mergeVectorCandidates(lists);
  };

  while (true) {
    attempts++;
    if (opts.keyword) {
      const t = performance.now();
      const out = keywordSearchVariants(
        searcher.db,
        variants,
        limit,
        filterOpts,
        opts.keywordMode,
      );
      keywordRows = out.rows;
      keywordTokens = out.tokens;
      keywordVariants = out.perVariant;
      keywordModeUsed = out.keywordMode;
      keywordFallback = out.fallback;
      timings.keywordMs += performance.now() - t;
    } else {
      keywordRows = [];
    }
    if (opts.vector) {
      const t = performance.now();
      vectorRows = runVectorRoute(limit);
      timings.knnMs += performance.now() - t;
    } else {
      vectorRows = [];
    }
    keywordFiltered = keywordRows.filter((r) => passesFilter(r, filterOpts));
    vectorFiltered = vectorRows.filter((r) => passesFilter(r, filterOpts));

    const tFuse = performance.now();
    results = fuseByStrategy(
      strategy,
      queryClass,
      fusionOpts,
      keywordFiltered,
      vectorFiltered,
    );
    timings.fuseMs += performance.now() - tFuse;

    if (!filterActive || results.length >= opts.k || limit >= maxLimit) break;
    const keywordExhausted = !opts.keyword || keywordRows.length < limit;
    const vectorExhausted = !opts.vector || vectorRows.length < limit;
    if (keywordExhausted && vectorExhausted) break;
    limit = Math.min(limit * 4, maxLimit);
  }

  const candidates = {
    keyword: keywordRows.length,
    keywordFiltered: keywordFiltered.length,
    vector: vectorRows.length,
    vectorFiltered: vectorFiltered.length,
    keywordVariants: keywordVariants.length,
    vectorEncoded: vectorQueries.length,
  };

  // 兜底：KNN 深度已到 vec0 上限（4096）仍凑不满 k，说明目标行排在很后面。
  // 此时对过滤后的行做精确距离计算（全表扫描），保证「除非真的没有，否则至少 k 条」。
  let fallback = null;
  if (filterActive && results.length < opts.k) {
    const tFuse = performance.now();
    const kwAll = opts.keyword
      ? keywordSearchVariants(searcher.db, variants, opts.k, filterOpts, opts.keywordMode)
      : { rows: [] };
    let vecAll = [];
    if (opts.vector) {
      vecAll =
        vectorQueries.length > 1
          ? mergeVectorCandidates(
              vectorQueries.map((vq) => ({
                source: vq.source,
                query: vq.query,
                rows: vectorSearchFiltered(searcher.db, vq.vector, opts.k, filterOpts),
              })),
            )
          : vectorSearchFiltered(searcher.db, vec, opts.k, filterOpts);
    }
    results = fuseByStrategy(strategy, queryClass, fusionOpts, kwAll.rows, vecAll);
    timings.fuseMs += performance.now() - tFuse;
    fallback = 'exact-filter';
  }

  // LLM 重排：只处理 natural / mixed；取融合后的 top-N，按模型分数重排，再截到 k。
  // 解析失败/超时/无 key 时 rr.order 为 null，保持融合顺序（fallback 计数在 rerank.mjs）。
  let rerankInfo = null;
  if (opts.rerank === true) {
    if (!rerankActive) {
      rerankInfo = {
        enabled: true,
        skipped: 'exact',
        depth: 0,
        sent: 0,
        applied: false,
        fallback: false,
        error: null,
        elapsedMs: 0,
        fromCache: false,
        usage: null,
        reason: '',
        model: opts.rerankModel,
      };
    } else if (results.length > 0) {
      const depth = Math.min(rerankDepth, results.length);
      const head = results.slice(0, depth);
      const tail = results.slice(depth);
      const tRerank = performance.now();
      const rr = await rerankCandidates({
        query,
        candidates: head,
        model: opts.rerankModel,
        seed: opts.rerankSeed,
        timeoutMs: opts.rerankTimeoutMs,
      });
      timings.rerankMs = performance.now() - tRerank;
      if (rr.order) {
        const byOffset = new Map(head.map((rec) => [rec.offset, rec]));
        const ordered = rr.order
          .map((offset) => byOffset.get(offset))
          .filter(Boolean)
          .map((rec) => ({ ...rec, rerankScore: rr.scores.get(rec.offset) ?? null }));
        const seen = new Set(ordered.map((rec) => rec.offset));
        const missing = head
          .filter((rec) => !seen.has(rec.offset))
          .map((rec) => ({ ...rec, rerankScore: rr.scores.get(rec.offset) ?? null }));
        results = [...ordered, ...missing, ...tail];
      }
      results = collapseDups
        ? collapseDuplicates(results, duplicateRoots, opts.k)
        : results.slice(0, opts.k);
      rerankInfo = {
        enabled: true,
        skipped: null,
        depth: rr.depth,
        sent: rr.sent,
        applied: rr.applied,
        fallback: rr.fallback,
        error: rr.error,
        elapsedMs: rr.elapsedMs,
        fromCache: rr.fromCache,
        usage: rr.usage,
        reason: rr.reason,
        model: rr.model,
      };
    } else {
      rerankInfo = {
        enabled: true,
        skipped: null,
        depth: 0,
        sent: 0,
        applied: false,
        fallback: false,
        error: 'no-candidates',
        elapsedMs: 0,
        fromCache: false,
        usage: null,
        reason: '',
        model: opts.rerankModel,
      };
    }
  }

  // 非重排路径（--no-rerank，或 exact 查询不触发重排）：融合返回的是 fusionK 条，
  // 打开 --collapse-dups 时先折叠再截到 k。
  if (collapseDups && !rerankActive) {
    results = collapseDuplicates(results, duplicateRoots, opts.k);
  }

  // top 结果的向量余弦，供 --no-rerank 的 low-confidence 判定与 miss-log 的 topScore。
  let topCosine = null;
  if (opts.vector && results.length > 0) {
    const top = results[0];
    let distance = top.routes?.distance ?? top.distance ?? null;
    if (distance == null && top.mem_id) {
      try {
        const row = searcher.db
          .prepare('select vec_distance_L2(embedding, ?) as d from mem_vec where rowid = ?')
          .get(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), memIdToRowid(top.mem_id));
        if (row && Number.isFinite(Number(row.d))) distance = Number(row.d);
      } catch {
        /* 计算失败就当没有余弦 */
      }
    }
    if (distance != null) topCosine = cosineFromL2(distance);
  }

  timings.vectorMs = timings.encodeMs + timings.variantEncodeMs + timings.knnMs;
  timings.totalMs = performance.now() - started;

  return {
    query,
    strategy,
    queryClass,
    tokens: keywordTokens,
    results,
    timings,
    candidates,
    routeLimit: limit,
    attempts,
    fallback,
    keywordMode: keywordModeUsed,
    keywordFallback,
    keywordVariants,
    collapseDups,
    topCosine,
    expand: expansion,
    expandTarget: opts.expandTarget,
    rerank: rerankInfo,
    vectorVariantCount: Math.max(0, vectorQueries.length - 1),
    vectorVariants: vectorVariantDetails.length ? vectorVariantDetails : null,
  };
}

/* -------------------------------- CLI ------------------------------------ */

function printResults(out) {
  const mode = [out.usedKeyword ? 'keyword' : null, out.usedVector ? 'vector' : null]
    .filter(Boolean)
    .join('+');
  const cls = out.queryClass
    ? `  class=${out.queryClass.kind}` +
      (out.queryClass.signals.length ? `(${out.queryClass.signals.join(',')})` : '')
    : '';
  const w = (s = '') => process.stdout.write(`${s}\n`);
  w(`query: ${out.query}`);
  w(
    `mode: ${mode}  strategy=${out.strategy}${out.strategy === 's3' ? `@${out.kwWeight}` : ''}${cls}` +
      `  kwMode=${out.keywordMode ?? '-'}  k=${out.k}  results=${out.results.length}`,
  );
  if (out.expand) {
    const e = out.expand;
    w(
      `expand(target=${e.target}): ${e.variants.length} 条变体` +
        `${e.fromCache ? '（缓存）' : ''}${e.error ? `  error=${e.error}` : ''}`,
    );
    for (const v of e.variants) w(`  - ${v}`);
  }
  if (out.rerank?.skipped) {
    w(`rerank: 跳过（${out.rerank.skipped}）`);
  } else if (out.rerank?.enabled) {
    const r = out.rerank;
    const usage = r.usage
      ? `  tokens ${r.usage.prompt_tokens ?? 0}+${r.usage.completion_tokens ?? 0}`
      : '';
    w(
      `rerank: model=${r.model} depth=${r.depth} sent=${r.sent} ` +
        `${r.applied ? '已应用' : '回退原顺序'}${r.fromCache ? '（缓存）' : ''}` +
        `  api=${r.elapsedMs == null ? '-' : `${r.elapsedMs.toFixed(1)}ms`}${usage}` +
        `${r.error ? `  error=${r.error}` : ''}`,
    );
  }
  if (out.vectorVariants?.length) {
    const encoded = out.vectorVariants.filter((v) => !v.error).length;
    w(
      `向量变体: 扩展编码 ${encoded}/${out.vectorVariants.length} 条` +
        `  encode 合计 ${(out.timings.variantEncodeMs ?? 0).toFixed(1)}ms` +
        `  KNN 共 ${out.candidates.vectorEncoded} 条查询`,
    );
    for (const v of out.vectorVariants) {
      w(
        `  vec变体[expand] 候选=${v.matched ?? '-'}  encode=${v.encodeMs.toFixed(1)}ms` +
          `${v.error ? `  error=${v.error}` : ''}  query=${truncateChars(v.query, 60)}`,
      );
    }
  }
  if (out.usedKeyword && out.keywordVariants?.length) {
    for (const v of out.keywordVariants) {
      const tk = v.tokens.length ? ` tokens=${v.tokens.join(',')}` : '';
      w(
        `  kw变体[${v.source}] mode=${v.mode}${v.fallback ? `→${v.fallback}` : ''}` +
          ` 候选=${v.matched}${tk}  query=${truncateChars(v.query, 60)}`,
      );
    }
  }
  w(
    `候选: 关键词 ${out.candidates.keyword}/${out.candidates.keywordFiltered}` +
      `  向量 ${out.candidates.vector}/${out.candidates.vectorFiltered}` +
      `  routeLimit=${out.routeLimit}${out.attempts > 1 ? `（放大 ${out.attempts} 次）` : ''}` +
      `${out.fallback ? `  fallback=${out.fallback}` : ''}`,
  );
  if (out.results.length === 0) {
    w('（没有命中）');
    return;
  }
  for (let i = 0; i < out.results.length; i++) {
    const r = out.results[i];
    const routes = [];
    if (r.routes.keywordRank != null) routes.push(`kw#${r.routes.keywordRank}`);
    if (r.routes.vectorRank != null) routes.push(`vec#${r.routes.vectorRank}`);
    w('');
    w(
      `#${i + 1}  score=${r.score.toFixed(6)}` +
        `${r.rerankScore != null ? `  rr=${r.rerankScore}` : ''}  [${r.kind ?? '?'}]  ` +
        `${r.cwd ?? '?'}  session=${r.session_id}  seq=${r.seq}  mem_id=${r.mem_id}  ` +
        `{${routes.join(' ')}}`,
    );
    w(`    ${truncateChars(r.statement, STATEMENT_PREVIEW)}`);
    if (r.also?.length) w(`    also: ${r.also.join(',')}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const startedAt = performance.now();
  missContext = {
    query: opts.query,
    k: opts.k,
    project: opts.project,
    kind: opts.kind,
    mode: [opts.keyword ? 'keyword' : null, opts.vector ? 'vector' : null]
      .filter(Boolean)
      .join('+'),
    startedAt,
    enabled: opts.missLog,
  };

  const searcher = { db: openSearchDb(opts.db), extractor: null };
  let initMs = null;
  if (opts.vector) {
    try {
      const { extractor, initMs: ms } = await initModel();
      searcher.extractor = extractor;
      initMs = ms;
    } catch (err) {
      die(`模型加载失败: ${err?.message || err}`);
    }
  }

  if (initMs != null) {
    process.stderr.write(`[cold-start] model ${MODEL_ID} ${DTYPE} 加载 ${(initMs / 1000).toFixed(2)}s\n`);
  } else {
    process.stderr.write('[cold-start] 模型加载跳过（--no-vector）\n');
  }

  const out = await search(searcher, opts.query, {
    k: opts.k,
    project: opts.project,
    kind: opts.kind,
    strategy: opts.strategy,
    kwWeight: opts.kwWeight,
    vector: opts.vector,
    keyword: opts.keyword,
    keywordMode: opts.keywordMode,
    expand: opts.expand,
    expandExplicit: opts.expandExplicit,
    expandTarget: opts.expandTarget,
    rerank: opts.rerank,
    rerankDepth: opts.rerankDepth,
    rerankModel: opts.rerankModel,
    rerankTimeoutMs: opts.rerankTimeoutMs,
    collapseDups: opts.collapseDups,
    duplicatesFile: opts.duplicatesFile,
  });
  out.k = opts.k;
  out.kwWeight = opts.kwWeight;
  out.usedKeyword = opts.keyword;
  out.usedVector = opts.vector;
  out.keywordMode = out.keywordMode ?? opts.keywordMode;

  // 失败查询旁路记录：空结果 / 过滤后为空 / 异常 / 低置信度（不改正常返回）。
  if (out.results.length === 0) {
    recordMiss(opts.project != null || opts.kind != null ? 'filtered-empty' : 'empty', {
      elapsedMs: out.timings?.totalMs ?? performance.now() - startedAt,
      topScore: null,
    });
  } else {
    // 重排开启：top rerank 分数 <= --miss-threshold 记 low-confidence；
    // --no-rerank：top 结果的向量余弦 <= --miss-cosine 记 low-confidence。
    // 重排开启但没拿到分数（exact 查询跳过、调用回退）时不判定，避免误报。
    const rerankActive = out.rerank?.enabled === true && !out.rerank.skipped;
    const topRerank = out.results[0]?.rerankScore ?? null;
    if (rerankActive) {
      if (Number.isFinite(topRerank) && topRerank <= opts.missThreshold) {
        recordMiss('low-confidence', {
          elapsedMs: out.timings?.totalMs ?? performance.now() - startedAt,
          topScore: topRerank,
        });
      }
    } else if (opts.rerank === false && out.topCosine != null && out.topCosine <= opts.missCosine) {
      recordMiss('low-confidence', {
        elapsedMs: out.timings?.totalMs ?? performance.now() - startedAt,
        topScore: out.topCosine,
      });
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out.results, null, 2)}\n`);
  } else {
    printResults(out);
  }
  searcher.db.close();
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    recordMiss('error', { error: err?.message || String(err) });
    process.stderr.write(`[mem-search] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
