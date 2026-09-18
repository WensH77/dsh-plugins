#!/usr/bin/env node
// temperature-probe — 固定题目的 temperature 效应探针，支持 thinking 开/关对照
//
// 背景：tools/temperature-p0 两轮（v1/v2）都在 thinking 模式下跑，结论是「temperature 空转」。
// 但官方文档只声明 thinking 模式不支持 temperature；非 thinking 模式未涉及。
// 本 tool 用同一道题、同一套指标把两种模式放在一起测：
//   - thinking disabled        → 实测 temperature 生效（T0 贪心、T2 发散）
//   - thinking enabled (high)  → 对照，验证参数被屏蔽
//
// 固定方法（不要随意改动，改了就不是同一实验）：
//   - 模型 deepseek-flash；stream:false；max_tokens 默认 64（thinking 模式下需调大，如 2048）
//   - 固定 prompt（PROMPT 常量），单轮 user 消息，要求只填空白、不解释
//   - 温度 0/1/2，每档重复 N 次（默认 50），交错执行（每轮温度顺序交替）抗时间漂移
//   - 指标：unique 填空数 / 众数占比 / 字级 TTR / 逐字重复对占比 dup / Shannon 熵
//   - 输出: 终端汇总 + JSON 落盘（含全部原始回答，可复算）
//
// 用法:
//   node tools/temperature-nothink/probe-nothink.mjs                                  # 默认 thinking:disabled, 0/1/2 × 50
//   node tools/temperature-nothink/probe-nothink.mjs --thinking enabled --effort high --temps 0 --n 50 --max-tokens 2048
//   node tools/temperature-nothink/probe-nothink.mjs --temps 0,0.5,1,1.5,2 --n 30
//
// 凭据: $DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml 中的 DEEPSEEK_API_KEY
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── CLI ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const MODEL = opt('--model', 'deepseek-flash');
const TEMPS = (opt('--temps', '0,1,2')).split(',').map((s) => Number(s.trim()));
const N = Number(opt('--n', '50'));
const CONCURRENCY = Number(opt('--concurrency', '6'));
const MAX_TOKENS = Number(opt('--max-tokens', '64'));
const THINKING = opt('--thinking', 'disabled');   // disabled | enabled
const EFFORT = opt('--effort', '');               // 仅 thinking=enabled 时生效: low | high | max
const OUT = opt('--out', 'results-nothink.json');
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

// 固定题目（与本次方法绑定，勿改）
const PROMPT = `请完成下面的句子。

“今天下班以后，我决定去____。”

只填写空白部分。
不要解释。`;

// ── 凭据 ──────────────────────────────────────────────────────────────────
async function getKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const content = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const m = content.match(/DEEPSEEK_API_KEY\s*:\s*(.+)/);
  if (!m) throw new Error('未找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

// ── 单次调用 ──────────────────────────────────────────────────────────────
async function call(key, temperature) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        max_tokens: MAX_TOKENS,
        stream: false,
        thinking: { type: THINKING },
        ...(THINKING === 'enabled' && EFFORT ? { reasoning_effort: EFFORT } : {}),
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, status: res.status, detail: JSON.stringify(data).slice(0, 200), latency: Date.now() - t0 };
    const msg = data.choices?.[0]?.message ?? {};
    return {
      ok: true,
      text: msg.content ?? '',
      think: msg.reasoning_content ?? '',
      finish: data.choices?.[0]?.finish_reason,
      completionTokens: data.usage?.completion_tokens,
      latency: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, detail: String(e.message ?? e).slice(0, 200), latency: Date.now() - t0 };
  }
}

// ── 指标 ──────────────────────────────────────────────────────────────────
// 归一化填空：去空白、去首尾引号、去句末标点；保留原文另存
function normalize(text) {
  return String(text ?? '')
    .trim()
    .replace(/^[“”"'「」『』【】]+|[“”"'「」『』【】]+$/g, '')
    .replace(/[。，、！？；：.,!?;:]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
}
const norm = (t) => String(t ?? '').replace(/\s+/g, '').toLowerCase();
function jaccard(a, b) {
  const s = norm(a), t = norm(b);
  const A = new Set(), B = new Set();
  for (let i = 0; i + 2 <= s.length; i++) A.add(s.slice(i, i + 2)); // 2-gram（短文本）
  for (let i = 0; i + 2 <= t.length; i++) B.add(t.slice(i, i + 2));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
function pairStats(texts) {
  let sum = 0, dup = 0, count = 0;
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const s = jaccard(texts[i], texts[j]); sum += s; if (s === 1) dup++; count++;
  }
  return { mean: count ? sum / count : NaN, dupRate: count ? dup / count : 0, pairs: count };
}
function ttr(texts) {
  const all = texts.join('');
  if (!all.length) return 0;
  return new Set([...all]).size / all.length;
}
function entropy(counts, total) {
  let h = 0;
  for (const c of counts) { const p = c / total; if (p > 0) h -= p * Math.log2(p); }
  return h;
}
function summarize(texts) {
  const counts = new Map();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const ps = pairStats(texts);
  const n = texts.length;
  return {
    n,
    unique: counts.size,
    uniqueRate: n ? counts.size / n : 0,
    mode: sorted[0]?.[0] ?? null,
    modeShare: n && sorted[0] ? sorted[0][1] / n : 0,
    entropy: n ? entropy(sorted.map(([, c]) => c), n) : 0,
    maxEntropy: n > 1 ? Math.log2(n) : 0,
    ttr: ttr(texts),
    pairMean: ps.mean,
    dupRate: ps.dupRate,
    pairs: ps.pairs,
    counts: sorted,
  };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ── 主流程：交错执行 ──────────────────────────────────────────────────────
const key = await getKey();
const tasks = [];
for (let i = 0; i < N; i++) {
  const order = i % 2 === 0 ? TEMPS : [...TEMPS].reverse();
  for (const t of order) tasks.push({ temp: t, round: i });
}
const modeLabel = `thinking=${THINKING}${THINKING === 'enabled' && EFFORT ? ` (effort=${EFFORT})` : ''}`;
console.log(`temperature-probe  model=${MODEL}  ${modeLabel}  temps=[${TEMPS}]  n=${N}/档  maxTokens=${MAX_TOKENS}  concurrency=${CONCURRENCY}`);
console.log(`总请求 = ${TEMPS.length}×${N} = ${tasks.length}`);
const tStart = Date.now();
const results = new Array(tasks.length);
let next = 0, done = 0;
async function worker() {
  while (next < tasks.length) {
    const idx = next++;
    const task = tasks[idx];
    results[idx] = { ...task, ...(await call(key, task.temp)) };
    done++;
    if (done % 25 === 0 || done === tasks.length) {
      const el = (Date.now() - tStart) / 1000;
      console.log(`进度 ${done}/${tasks.length}  (${el.toFixed(0)}s, 预计剩余 ${(el / done * (tasks.length - done) / 60).toFixed(1)}min)`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
const elapsed = (Date.now() - tStart) / 1000;
console.log(`全部完成, 用时 ${(elapsed / 60).toFixed(1)}min`);

// ── 汇总 ──────────────────────────────────────────────────────────────────
const summary = [];
const arms = {};
for (const temp of TEMPS) {
  const out = results.filter((r) => r.temp === temp);
  const errs = out.filter((r) => !r.ok);
  const ok = out.filter((r) => r.ok);
  const empty = ok.filter((r) => !normalize(r.text));
  const truncated = ok.filter((r) => r.finish === 'length');
  const texts = ok.map((r) => normalize(r.text)).filter(Boolean);
  const leaked = ok.filter((r) => String(r.text ?? '').length > 60 || /解释|抱歉|无法/.test(r.text ?? ''));
  const s = summarize(texts);
  arms[temp] = { ...s, errs: errs.length, empty: empty.length, truncated: truncated.length, leaked: leaked.length, latency: mean(ok.map((r) => r.latency)), texts };
  console.log(`\n═══════ temperature = ${temp} ═══════`);
  console.log(`调用 ${ok.length}/${out.length} 成功  失败=${errs.length}  截断=${truncated.length}  空=${empty.length}  疑似未按要求=${leaked.length}  平均延迟=${mean(ok.map((r) => r.latency)).toFixed(0)}ms`);
  if (errs.length) console.log(`  首个错误: ${JSON.stringify(errs[0].detail ?? errs[0]).slice(0, 160)}`);
  console.log(`有效回答 ${s.n} 条  不同回答=${s.unique} (${(s.uniqueRate * 100).toFixed(1)}%)  众数=${JSON.stringify(s.mode)} 占比=${(s.modeShare * 100).toFixed(1)}%`);
  console.log(`多样性: 熵=${s.entropy.toFixed(2)}/${s.maxEntropy.toFixed(2)} bit  字级TTR=${s.ttr.toFixed(3)}  两两相似度(2-gram)=${s.pairMean.toFixed(3)}  逐字重复对=${s.dupRate.toFixed(3)} (${s.pairs} 对)`);
  console.log(`  分布: ${s.counts.map(([w, c]) => `${w}×${c}`).join('  ')}`);
  summary.push({ temperature: temp, ...s, counts: s.counts, errs: errs.length, empty: empty.length, truncated: truncated.length, leaked: leaked.length, latency: arms[temp].latency });
}

// 横向对照
if (TEMPS.length > 1) {
  console.log(`\n═══════ 横向对照 ═══════`);
  console.log(`温度  n   不同  占比    众数占比  熵(bit)   TTR     两两相似  重复对`);
  for (const temp of TEMPS) {
    const a = arms[temp];
    console.log(`${String(temp).padEnd(5)} ${String(a.n).padEnd(3)} ${String(a.unique).padEnd(5)} ${(a.uniqueRate * 100).toFixed(1).padStart(5)}%  ${(a.modeShare * 100).toFixed(1).padStart(7)}%  ${a.entropy.toFixed(2).padStart(6)}  ${a.ttr.toFixed(3)}   ${a.pairMean.toFixed(3).padStart(7)}   ${a.dupRate.toFixed(3)}`);
  }
  const uniq = TEMPS.map((t) => arms[t].uniqueRate);
  const ent = TEMPS.map((t) => arms[t].entropy);
  const up = (xs) => xs.every((v, i) => i === 0 || v >= xs[i - 1]);
  const down = (xs) => xs.every((v, i) => i === 0 || v <= xs[i - 1]);
  console.log(`\n单调性: 不同回答占比=${up(uniq) ? '单调↑' : down(uniq) ? '单调↓' : '非单调'}  熵=${up(ent) ? '单调↑' : down(ent) ? '单调↓' : '非单调'}  （温度生效预期：多样性随温度↑）`);
}

const OUT_PATH = OUT.startsWith('/') ? OUT : join(import.meta.dirname, OUT);
await writeFile(OUT_PATH, JSON.stringify({
  config: { MODEL, TEMPS, N, MAX_TOKENS, CONCURRENCY, PROMPT, thinking: THINKING, effort: EFFORT || null, BASE_URL },
  summary,
  raw: results,
}, null, 2));
console.log(`\n原始数据已写入 ${OUT_PATH}（含全部原始回答, 可复算）。`);
