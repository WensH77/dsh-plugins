#!/usr/bin/env node
// v2 seed 对照 — 用固定 seed 分离"忽略温度"与"无 seed 非贪心"两种解释（v1 §9 修正清单第 1 条）。
//
// 裸 API（真实链路不发送 seed, dsh-llm-deepseek 无该字段），带 thinking enabled +
// reasoning_effort（与主探针一致的 high/max）。
//
// 逻辑:
//   - 若 temperature 生效且 seed 被尊重: 同 seed 下 T0 应逐字一致（dupRate≈1），T2 应发散（dupRate≈0）;
//   - 若 temperature 被忽略: T0 固定 seed 仍发散（dupRate≈0），且 t0s42 / t2s42 / t0svar 三组多样性水平相当;
//   - 若 seed 被尊重但 temperature 被忽略: t0s42 一致、t2s42 也一致（seed 决定一切）——可区分。
//
// 用法: node seed-v2.mjs [--models flash,pro] [--efforts high,max] [--k 6] [--concurrency 4] [--out seed-v2.json]
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const MODELS = (opt('--models', opt('--model', 'deepseek-v4-flash,deepseek-v4-pro')) || 'deepseek-v4-flash,deepseek-v4-pro').split(',').map((s) => s.trim());
const EFFORTS = (opt('--efforts', 'high,max') || 'high,max').split(',').map((s) => s.trim());
const K = Number(opt('--k', '6') || 6);
const CONCURRENCY = Number(opt('--concurrency', '4') || 4);
const MAX_TOKENS = 1024;
const OUT = opt('--out', 'seed-v2.json');
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

// 与主探针一致的 open prompt
const PROMPT = `请用不超过 120 字，描述一个好的软件架构应该具备哪些关键特质，并给出一个具体例子。`;

async function getKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const content = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const m = content.match(/DEEPSEEK_API_KEY\s*:\s*(.+)/);
  if (!m) throw new Error('未找到 DEEPSEEK_API_KEY');
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const key = await getKey();

async function call(model, effort, temperature, seed) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature,
        ...(seed !== undefined ? { seed } : {}),
        max_tokens: MAX_TOKENS,
        stream: false,
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
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
      latency: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, detail: String(e.message ?? e).slice(0, 200), latency: Date.now() - t0 };
  }
}

// ── 指标（与主探针一致）────────────────────────────────────────────────────
function normText(t) { return String(t ?? '').replace(/\s+/g, '').toLowerCase(); }
const gramCache = new Map();
function jaccard(a, b) {
  const keyA = a + '\u0000' + b;
  let v = gramCache.get(keyA);
  if (v !== undefined) return v;
  const s = normText(a);
  const t = normText(b);
  const A = new Set();
  for (let i = 0; i + 4 <= s.length; i++) A.add(s.slice(i, i + 4));
  const B = new Set();
  for (let i = 0; i + 4 <= t.length; i++) B.add(t.slice(i, i + 4));
  if (A.size === 0 || B.size === 0) v = 0;
  else {
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    v = inter / (A.size + B.size - inter);
  }
  gramCache.set(keyA, v);
  return v;
}
function editSim(a, b) {
  const s = normText(a);
  const t = normText(b);
  if (!s.length && !t.length) return 1;
  const maxLen = Math.max(s.length, t.length);
  if (!maxLen) return 0;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
  }
  return 1 - prev[t.length] / maxLen;
}
function pairStats(texts, simFn) {
  const n = texts.length;
  let sum = 0;
  let dup = 0;
  let count = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const sim = simFn(texts[i], texts[j]);
    sum += sim;
    if (sim === 1) dup++;
    count++;
  }
  return { mean: count ? sum / count : NaN, dupRate: count ? dup / count : 0, pairs: count };
}

// ── cells: model × effort × {t0s42, t2s42, t0svar} ─────────────────────────
const CELLS = ['t0s42', 't2s42', 't0svar'];
const tasks = [];
for (const model of MODELS) for (const effort of EFFORTS) for (const cell of CELLS) {
  for (let i = 0; i < K; i++) {
    const seed = cell === 't0svar' ? 1000 + i : 42;
    tasks.push({ model, effort, cell, temp: cell.startsWith('t0') ? 0 : 2, seed });
  }
}
console.log(`v2 seed 对照: 裸 API  models=[${MODELS}]  efforts=[${EFFORTS}]  cells=[${CELLS}]  k=${K}  maxTokens=${MAX_TOKENS}  baseURL=${BASE_URL}`);
console.log(`总请求 = ${tasks.length}（concurrency=${CONCURRENCY}）`);

const results = new Array(tasks.length);
let next = 0;
let done = 0;
const tStart = Date.now();
async function worker() {
  while (next < tasks.length) {
    const idx = next++;
    const task = tasks[idx];
    results[idx] = { ...task, ...(await call(task.model, task.effort, task.temp, task.seed)) };
    done++;
    if (done % 12 === 0) console.log(`进度 ${done}/${tasks.length}  (${((Date.now() - tStart) / 1000).toFixed(0)}s)`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
console.log(`完成, 用时 ${((Date.now() - tStart) / 1000 / 60).toFixed(1)}min`);

// ── 汇总 ──────────────────────────────────────────────────────────────────
const summary = [];
for (const model of MODELS) {
  for (const effort of EFFORTS) {
    console.log(`\n═══════ seed 对照: model=${model}  effort=${effort} ═══════`);
    const cellStats = {};
    for (const cell of CELLS) {
      const out = results.filter((r) => r.model === model && r.effort === effort && r.cell === cell);
      const errs = out.filter((r) => !r.ok);
      const ok = out.filter((r) => r.ok);
      const truncated = ok.filter((r) => r.finish === 'length');
      const texts = ok.filter((r) => r.text.trim() && r.finish !== 'length').map((r) => r.text);
      const thinks = ok.filter((r) => r.think.trim() && r.finish !== 'length').map((r) => r.think);
      const jc = pairStats(texts, jaccard);
      const ed = pairStats(texts, editSim);
      const jcT = pairStats(thinks, jaccard);
      cellStats[cell] = { errs: errs.length, truncated: truncated.length, n: ok.length, texts, thinks, jacc: jc.mean, edit: ed.mean, dupRate: jc.dupRate, thinkJacc: jcT.mean, thinkDup: jcT.dupRate };
      console.log(`${cell} (temp=${cell.startsWith('t0') ? 0 : 2}): 成功=${ok.length}/${out.length} 失败=${errs.length} 截断=${truncated.length}`);
      console.log(`  content: jacc4=${jc.mean.toFixed(3)}  editSim=${ed.mean.toFixed(3)}  dupRate=${jc.dupRate.toFixed(2)}  |  thinking: jacc4=${jcT.mean.toFixed(3)}  dupRate=${jcT.dupRate.toFixed(2)}`);
    }
    const t0s = cellStats.t0s42;
    const t2s = cellStats.t2s42;
    const t0v = cellStats.t0svar;
    let interp = '';
    if (t0s.dupRate > 0.5 && t2s.dupRate < 0.5) {
      interp = '→ 同 seed 下 T0 逐字一致、T2 发散: temperature 生效且 seed 被尊重（PASS 方向）';
    } else if (t0s.dupRate > 0.5 && t2s.dupRate > 0.5) {
      interp = '→ 同 seed 下 T0 与 T2 都一致: seed 被尊重但 temperature 被忽略（seed 决定输出）';
    } else if (t0s.dupRate === 0 && t2s.dupRate === 0 && Math.abs(t0s.jacc - t2s.jacc) < 0.05 && Math.abs(t0s.jacc - t0v.jacc) < 0.05) {
      interp = '→ T0 固定 seed 仍发散, 且三组多样性水平相当: temperature 被忽略（模型内部采样策略覆盖）';
    } else if (t0s.dupRate === 0 && t2s.dupRate === 0 && t0s.jacc > t2s.jacc + 0.05) {
      interp = '→ T0/T2 都不逐字一致（无贪心/无 seed 生效）但 T0 更相似: 弱温度效应（非贪心采样, 温度仍调制多样性）';
    } else {
      interp = '→ 模式不清晰, 见原始数据';
    }
    console.log(`  解读: ${interp}`);
    summary.push({ model, effort, cells: Object.fromEntries(Object.entries(cellStats).map(([k, v]) => [k, { errs: v.errs, truncated: v.truncated, n: v.n, jacc: v.jacc, edit: v.edit, dupRate: v.dupRate, thinkJacc: v.thinkJacc, thinkDup: v.thinkDup, texts: v.texts, thinks: v.thinks }])), interp });
  }
}
const OUT_PATH = OUT.startsWith('/') ? OUT : join(import.meta.dirname, OUT);
await writeFile(OUT_PATH, JSON.stringify({ config: { MODELS, EFFORTS, CELLS, K, MAX_TOKENS, PROMPT }, results: summary }, null, 2));
console.log(`\n原始数据已写入 ${OUT}。`);
