#!/usr/bin/env node
/**
 * 查询扩展：用 deepseek-flash 把自然语言查询改写成 3-5 条中文检索短语。
 *
 * - key 从 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY 读，绝不打印。
 * - 结果写 ~/.dsh/memory-export/expand-cache.json，同一 query 重复评测不重复调 API。
 * - 任何失败（无 key、网络、超时、HTTP 错误、解析不出）都只返回 variants: []，
 *   由调用方用原查询继续检索，不让整条检索失败。
 * - 每次真实 API 调用的 token 用量与往返耗时记在 expansionStats 里，供评测汇总。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const HOME = os.homedir();
const API_URL = 'https://api.deepseek.com/chat/completions';
const CREDENTIALS_FILE = path.join(HOME, '.dsh', '.credentials.yaml');
export const CACHE_FILE = path.join(HOME, '.dsh', 'memory-export', 'expand-cache.json');
export const CACHE_SCHEMA = 'memory-expand-cache/1';
export const PROMPT_VERSION = 1;
export const DEFAULT_EXPAND_MODEL = 'deepseek-flash';
export const DEFAULT_TIMEOUT_MS = 20000;

// 与 distill.mjs 的单价保持一致（美元 / 百万 token）。
const PRICE_USD_PER_TOKEN = { input: 0.30 / 1e6, output: 1.20 / 1e6 };

const SYSTEM_PROMPT = `你是记忆检索的查询改写器。把用户的问题改写成 3-5 条适合关键词检索的中文短语。

要求：
1. 每行一条，行首写序号（如 1.），只输出这些行；不要解释、不要空行、不要复述原问题。
2. 每条是能直接拿去检索的关键词短语，覆盖问题里的核心概念、可能的同义说法和专有名词。
3. 专有名词、代码标识符、文件名、命令保持原样，不要翻译、不要改大小写。
4. 不要输出问句，不要输出整句口语；除序号和关键词外不要输出任何内容。`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readApiKey() {
  let text;
  try {
    text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 ${CREDENTIALS_FILE}: ${err.message}`);
  }
  const m = /^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/m.exec(text);
  if (!m) throw new Error(`${CREDENTIALS_FILE} 中未找到 DEEPSEEK_API_KEY`);
  let key = m[1].trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  if (!key) throw new Error('DEEPSEEK_API_KEY 为空');
  return key;
}

/* ------------------------------- 缓存 ------------------------------------ */

let cache = null;
let cacheDirty = false;

function emptyCache() {
  return { schema: CACHE_SCHEMA, promptVersion: PROMPT_VERSION, entries: {} };
}

function loadCache() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && raw.schema === CACHE_SCHEMA && raw.promptVersion === PROMPT_VERSION) {
      cache = { ...emptyCache(), ...raw, entries: raw.entries ?? {} };
    } else {
      cache = emptyCache();
    }
  } catch {
    cache = emptyCache();
  }
  return cache;
}

function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const dir = path.dirname(CACHE_FILE);
  const tmp = `${CACHE_FILE}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    process.stderr.write(`[expand] warn: 写缓存失败 ${CACHE_FILE}: ${err.message}\n`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function cacheKey(query, model) {
  return `${model}\u0000${query}`;
}

/* ------------------------------- 统计 ------------------------------------ */

export const expansionStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  apiMs: [],
  costUsd: 0,
  // 缓存命中/跳过的调用不计入 apiMs；failures 也只统计真实请求。
};

export function resetExpansionStats() {
  expansionStats.calls = 0;
  expansionStats.cacheHits = 0;
  expansionStats.failures = 0;
  expansionStats.promptTokens = 0;
  expansionStats.completionTokens = 0;
  expansionStats.totalTokens = 0;
  expansionStats.apiMs = [];
  expansionStats.costUsd = 0;
}

function recordUsage(usage) {
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const completion = Number(usage?.completion_tokens ?? 0);
  expansionStats.promptTokens += prompt;
  expansionStats.completionTokens += completion;
  expansionStats.totalTokens += Number(usage?.total_tokens ?? prompt + completion);
  expansionStats.costUsd +=
    prompt * PRICE_USD_PER_TOKEN.input + completion * PRICE_USD_PER_TOKEN.output;
}

/* ------------------------------ 请求/解析 -------------------------------- */

function parseVariants(content, originalQuery) {
  const originalKey = String(originalQuery).replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Set([originalKey]);
  const out = [];
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    // 去掉编号 / 列表符；模型有时会写成 "1. xxx"、"1) xxx"、"- xxx"
    line = line.replace(/^\s*(?:\d+\s*[.)、:：]|[-*•])\s*/, '').trim();
    line = line.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
    if (!line) continue;
    const key = line.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 5) break;
  }
  return out;
}

async function requestOnce({ apiKey, model, query, timeoutMs }) {
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
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: query },
          ],
          max_tokens: 256,
          temperature: 0.3,
          stream: false,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeoutErr = new Error(`请求超时（${timeoutMs}ms）`);
        timeoutErr.retryable = true;
        throw timeoutErr;
      }
      err.retryable = true;
      throw err;
    }
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(`响应不是 JSON: ${bodyText.slice(0, 200)}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`响应缺少 choices[0].message.content`);
    }
    return {
      variants: parseVariants(content, query),
      usage: body.usage ?? null,
      elapsedMs: performance.now() - started,
      content,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 对外接口 --------------------------------- */

const negativeCache = new Map(); // key -> error message（仅本进程内，避免重复评测反复打 API）

/**
 * 取查询扩展。缓存命中不产生 API 往返。
 * 返回 { variants, fromCache, elapsedMs, usage, error }；失败时 variants 为空数组。
 */
export async function getExpansion(query, options = {}) {
  const model = options.model ?? DEFAULT_EXPAND_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = cacheKey(query, model);

  const store = loadCache();
  const hit = store.entries[key];
  if (hit && Array.isArray(hit.variants) && hit.model === model) {
    expansionStats.cacheHits++;
    return {
      variants: hit.variants,
      fromCache: true,
      elapsedMs: 0,
      usage: hit.usage ?? null,
      error: null,
    };
  }
  if (negativeCache.has(key)) {
    expansionStats.cacheHits++;
    return { variants: [], fromCache: true, elapsedMs: 0, usage: null, error: negativeCache.get(key) };
  }

  let apiKey;
  try {
    apiKey = readApiKey();
  } catch (err) {
    negativeCache.set(key, err.message);
    expansionStats.failures++;
    process.stderr.write(`[expand] warn: ${err.message}；降级为只用原查询\n`);
    return { variants: [], fromCache: false, elapsedMs: 0, usage: null, error: err.message };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await requestOnce({ apiKey, model, query, timeoutMs });
      expansionStats.calls++;
      expansionStats.apiMs.push(out.elapsedMs);
      if (out.usage) recordUsage(out.usage);
      if (out.variants.length === 0) {
        throw new Error(`模型输出解析不出关键词: ${String(out.content).slice(0, 120)}`);
      }
      store.entries[key] = {
        model,
        promptVersion: PROMPT_VERSION,
        query,
        variants: out.variants,
        usage: out.usage ?? null,
        elapsedMs: out.elapsedMs,
        createdAt: new Date().toISOString(),
      };
      cacheDirty = true;
      saveCache();
      return {
        variants: out.variants,
        fromCache: false,
        elapsedMs: out.elapsedMs,
        usage: out.usage ?? null,
        error: null,
      };
    } catch (err) {
      lastErr = err;
      // 只有一次重试，且仅对限流/5xx/网络/超时重试。
      if (!err.retryable || attempt === 1) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  expansionStats.failures++;
  const message = lastErr?.message ?? String(lastErr);
  negativeCache.set(key, message);
  process.stderr.write(`[expand] warn: 查询扩展失败（${message}）；降级为只用原查询\n`);
  return { variants: [], fromCache: false, elapsedMs: 0, usage: null, error: message };
}

export function estimateExpansionCostUsd() {
  return expansionStats.costUsd;
}

/**
 * 汇总缓存里记录的原始 API 调用（token 用量、往返耗时）。
 * 用于「本次评测命中缓存、但想知道当初真实调用成本」的场景；只统计传入的 query。
 */
export function getCachedCallStats(queries, model = DEFAULT_EXPAND_MODEL) {
  const store = loadCache();
  const out = {
    count: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    apiMs: [],
    costUsd: 0,
    entries: [],
  };
  for (const query of queries) {
    const entry = store.entries[cacheKey(query, model)];
    if (!entry || !Array.isArray(entry.variants)) continue;
    const usage = entry.usage ?? {};
    const prompt = Number(usage.prompt_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? 0);
    out.count++;
    out.promptTokens += prompt;
    out.completionTokens += completion;
    out.totalTokens += Number(usage.total_tokens ?? prompt + completion);
    out.apiMs.push(Number(entry.elapsedMs ?? 0));
    out.costUsd += prompt * PRICE_USD_PER_TOKEN.input + completion * PRICE_USD_PER_TOKEN.output;
    out.entries.push({
      query,
      variants: entry.variants,
      usage,
      elapsedMs: Number(entry.elapsedMs ?? 0),
      createdAt: entry.createdAt ?? null,
    });
  }
  return out;
}
