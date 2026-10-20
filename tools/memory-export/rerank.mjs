#!/usr/bin/env node
/**
 * LLM 重排：把融合后的 top-N 候选交给 deepseek-flash 判相关性，按分数重排。
 *
 * - key 从 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY 读（复用 query-expand.mjs），绝不打印。
 * - 候选顺序用固定种子打乱后再编号 #1..#N，映射只在进程内保存，避免模型的位置偏差。
 * - 模型输出只接受一个 JSON：{"top":[{"i":编号,"score":1-5}],"reason":"一句话"}。
 *   容忍代码围栏与前后赘述；解析失败、超时、HTTP 错误都返回 order=null，
 *   由调用方退化为原始顺序，并计入 fallbacks。
 * - token 用量、API 往返耗时、成本记在 rerankStats；同一进程内相同
 *   (模型, 查询, 深度, 候选集) 只真实请求一次，其余命中内存缓存。
 */

import { performance } from 'node:perf_hooks';
import { readApiKey } from './query-expand.mjs';

const API_URL = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_RERANK_MODEL = 'deepseek-flash';
export const DEFAULT_RERANK_DEPTH = 100;
export const MIN_RERANK_DEPTH = 20;
export const MAX_RERANK_DEPTH = 200;
export const DEFAULT_SEED = 20261019;
export const DEFAULT_TIMEOUT_MS = 45000;
const STATEMENT_LIMIT = 200;

// 与 distill.mjs / query-expand.mjs 的单价保持一致（美元 / 百万 token）。
const PRICE_USD_PER_TOKEN = { input: 0.3 / 1e6, output: 1.2 / 1e6 };

const SYSTEM_PROMPT = `你是记忆检索的重排器。给定一个问题与一组候选记忆，判断每条记忆对回答该问题的可用程度。

打分标准（假设 3 个月后，另一个没见过原会话的人，只能看这一条记忆来回答这个问题）：
5 = 直接给出答案（结论、做法或关键事实），不用再查
4 = 强相关，包含答案的主要部分，只需少量推断
3 = 部分相关，只提供背景或相邻信息
2 = 只沾边，有词面重合但答非所问
1 = 不相关

规则：
1. 按上述标准给每条候选打 1-5 的整数分。不要因为措辞相似就给高分，要看它是否真的能回答问题。
2. 候选编号 #1..#N 与相关程度无关，不要假设靠前的更相关。
3. 只输出一个 JSON 对象，不要代码围栏、不要解释、不要输出候选原文：
{"top":[{"i":编号,"score":1-5}],"reason":"一句话"}
4. top 必须包含全部 N 条候选，按分数从高到低排列；同分可任意顺序。reason 不超过 40 字。`;

export const rerankStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  fallbacks: 0,
  parseFailures: 0,
  timeouts: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  candidatesScored: 0,
  apiMs: [],
  costUsd: 0,
  callsLog: [],
};

export function resetRerankStats() {
  rerankStats.calls = 0;
  rerankStats.cacheHits = 0;
  rerankStats.failures = 0;
  rerankStats.fallbacks = 0;
  rerankStats.parseFailures = 0;
  rerankStats.timeouts = 0;
  rerankStats.promptTokens = 0;
  rerankStats.completionTokens = 0;
  rerankStats.totalTokens = 0;
  rerankStats.candidatesScored = 0;
  rerankStats.apiMs = [];
  rerankStats.costUsd = 0;
  rerankStats.callsLog = [];
}

export function snapshotRerankStats() {
  return {
    calls: rerankStats.calls,
    cacheHits: rerankStats.cacheHits,
    failures: rerankStats.failures,
    fallbacks: rerankStats.fallbacks,
    parseFailures: rerankStats.parseFailures,
    timeouts: rerankStats.timeouts,
    promptTokens: rerankStats.promptTokens,
    completionTokens: rerankStats.completionTokens,
    totalTokens: rerankStats.totalTokens,
    candidatesScored: rerankStats.candidatesScored,
    apiMs: [...rerankStats.apiMs],
    costUsd: rerankStats.costUsd,
    callsLog: [...rerankStats.callsLog],
  };
}

function truncateChars(text, n) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------- 打乱 ------------------------------------ */

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 固定种子的 Fisher-Yates。返回新数组，不改入参；同一种子与同一候选集
 * 永远得到同一顺序，便于复现与内存缓存。
 */
export function shuffleWithSeed(items, seed = DEFAULT_SEED) {
  const out = [...items];
  const rand = mulberry32(seed >>> 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------ 请求/解析 -------------------------------- */

export function buildRerankPrompt(query, candidates) {
  const lines = [];
  for (let i = 0; i < candidates.length; i++) {
    const rec = candidates[i];
    lines.push(
      `#${i + 1} [${rec.kind ?? '?'}] ${truncateChars(rec.statement, STATEMENT_LIMIT)}`,
    );
  }
  const user = `问题：${query}\n\n候选记忆（共 ${candidates.length} 条）：\n${lines.join('\n')}`;
  return { system: SYSTEM_PROMPT, user };
}

function extractJson(content) {
  let s = String(content ?? '').trim();
  if (!s) return null;
  // 去代码围栏；模型可能写成 ```json ... ``` 或在 JSON 前后带说明。
  s = s.replace(/^```(?:json)?\s*/i, '');
  const fenceEnd = s.lastIndexOf('```');
  if (fenceEnd >= 0) s = s.slice(0, fenceEnd);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

export function parseRerankContent(content, n) {
  const json = extractJson(content);
  if (json == null) return null;
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  const top = Array.isArray(obj?.top) ? obj.top : null;
  if (!top) return null;
  const entries = [];
  const seen = new Set();
  for (const item of top) {
    const i = Number(item?.i);
    const score = Number(item?.score);
    if (!Number.isInteger(i) || i < 1 || i > n) continue;
    if (!Number.isFinite(score)) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    entries.push({ i, score: Math.max(1, Math.min(5, score)) });
  }
  if (entries.length === 0) return null;
  return {
    entries,
    reason: typeof obj.reason === 'string' ? truncateChars(obj.reason, 200) : '',
  };
}

async function requestRerank({ apiKey, model, query, candidates, timeoutMs }) {
  const { system, user } = buildRerankPrompt(query, candidates);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 4000,
          temperature: 0,
          stream: false,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeoutErr = new Error(`请求超时（${timeoutMs}ms）`);
        timeoutErr.timeout = true;
        throw timeoutErr;
      }
      throw err;
    }
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error(`响应不是 JSON: ${bodyText.slice(0, 200)}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('响应缺少 choices[0].message.content');
    }
    return {
      content,
      usage: body.usage ?? null,
      elapsedMs: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 对外接口 --------------------------------- */

const cache = new Map(); // key -> 完整结果（只在进程内，不落盘）

function cacheKey(query, model, candidates) {
  return [
    model,
    query,
    candidates.length,
    candidates.map((c) => c.offset).join(','),
  ].join('\u0000');
}

function sortByScore(entries, positions) {
  // entries: 模型给出的 {i, score}；positions[i-1] 是打乱后的候选，带 baseRank。
  const scored = entries.map((e) => {
    const p = positions[e.i - 1];
    return { offset: p.rec.offset, score: e.score, baseRank: p.baseRank };
  });
  scored.sort((a, b) => b.score - a.score || a.baseRank - b.baseRank);
  return scored;
}

/**
 * 重排一条查询的候选。
 *
 * candidates 必须是融合后的原始顺序（baseRank = 1..N）。内部会按固定种子打乱后
 * 再编号交给模型；返回的 order 已按模型分数排好，同分回退到融合名次。
 *
 * 返回：
 *   { order: number[]|null, applied, fallback, error, elapsedMs, usage,
 *     reason, scores: Map<offset, score>, depth, model, fromCache, sent }
 * order 为 null 表示失败/被跳过，调用方应保持原顺序。
 */
export async function rerankCandidates({
  query,
  candidates,
  model = DEFAULT_RERANK_MODEL,
  seed = DEFAULT_SEED,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const started = performance.now();
  const depth = candidates.length;
  if (depth === 0) {
    return {
      order: null,
      applied: false,
      fallback: false,
      error: 'no-candidates',
      elapsedMs: 0,
      usage: null,
      reason: '',
      scores: new Map(),
      depth,
      model,
      fromCache: false,
      sent: 0,
    };
  }

  const key = cacheKey(query, model, candidates);
  const hit = cache.get(key);
  if (hit) {
    rerankStats.cacheHits++;
    return {
      ...hit,
      fromCache: true,
      elapsedMs: hit.elapsedMs,
      scores: new Map(hit.scores),
    };
  }

  let apiKey;
  try {
    apiKey = readApiKey();
  } catch (err) {
    rerankStats.failures++;
    rerankStats.fallbacks++;
    const out = {
      order: null,
      applied: false,
      fallback: true,
      error: err.message,
      elapsedMs: performance.now() - started,
      usage: null,
      reason: '',
      scores: new Map(),
      depth,
      model,
      fromCache: false,
      sent: depth,
    };
    rerankStats.callsLog.push({
      query,
      depth,
      model,
      cached: false,
      ok: false,
      fallback: true,
      error: err.message,
      elapsedMs: out.elapsedMs,
      usage: null,
      content: null,
    });
    return out;
  }

  const positions = shuffleWithSeed(
    candidates.map((rec, i) => ({ rec, baseRank: i + 1 })),
    seed,
  );

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await requestRerank({ apiKey, model, query, candidates: positions.map((p) => p.rec), timeoutMs });
      rerankStats.calls++;
      rerankStats.apiMs.push(res.elapsedMs);
      rerankStats.candidatesScored += depth;
      const usage = res.usage ?? {};
      const prompt = Number(usage.prompt_tokens ?? 0);
      const completion = Number(usage.completion_tokens ?? 0);
      rerankStats.promptTokens += prompt;
      rerankStats.completionTokens += completion;
      rerankStats.totalTokens += Number(usage.total_tokens ?? prompt + completion);
      rerankStats.costUsd +=
        prompt * PRICE_USD_PER_TOKEN.input + completion * PRICE_USD_PER_TOKEN.output;

      const parsed = parseRerankContent(res.content, depth);
      if (!parsed) {
        throw new Error(`模型输出解析不出 top: ${String(res.content).slice(0, 160)}`);
      }
      const scored = sortByScore(parsed.entries, positions);
      const seen = new Set(scored.map((s) => s.offset));
      // 模型漏掉的候选按融合名次补在末尾（分数记 0），保证候选不丢。
      const missing = candidates
        .map((rec, i) => ({ rec, baseRank: i + 1 }))
        .filter((p) => !seen.has(p.rec.offset))
        .sort((a, b) => a.baseRank - b.baseRank)
        .map((p) => ({ offset: p.rec.offset, score: 0, baseRank: p.baseRank }));
      const ordered = [...scored, ...missing];
      const scores = new Map(ordered.map((s) => [s.offset, s.score]));
      const out = {
        order: ordered.map((s) => s.offset),
        applied: true,
        fallback: false,
        error: null,
        elapsedMs: res.elapsedMs,
        usage: res.usage,
        reason: parsed.reason,
        scores,
        depth,
        model,
        fromCache: false,
        sent: depth,
        scored: scored.length,
      };
      cache.set(key, { ...out, scores: new Map(scores) });
      rerankStats.callsLog.push({
        query,
        depth,
        model,
        cached: false,
        ok: true,
        fallback: false,
        error: null,
        elapsedMs: res.elapsedMs,
        usage: res.usage,
        content: String(res.content).slice(0, 20000),
        reason: parsed.reason,
      });
      return out;
    } catch (err) {
      lastErr = err;
      const retryable = /HTTP (429|5\d\d)/.test(err.message) || err.timeout;
      if (!retryable || attempt === 1) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  rerankStats.failures++;
  rerankStats.fallbacks++;
  if (lastErr?.timeout) rerankStats.timeouts++;
  if (/解析不出/.test(lastErr?.message ?? '')) rerankStats.parseFailures++;
  const out = {
    order: null,
    applied: false,
    fallback: true,
    error: lastErr?.message ?? String(lastErr),
    elapsedMs: performance.now() - started,
    usage: null,
    reason: '',
    scores: new Map(),
    depth,
    model,
    fromCache: false,
    sent: depth,
  };
  rerankStats.callsLog.push({
    query,
    depth,
    model,
    cached: false,
    ok: false,
    fallback: true,
    error: out.error,
    elapsedMs: out.elapsedMs,
    usage: null,
    content: null,
  });
  return out;
}
