#!/usr/bin/env node
// v2 主探针 — deepseek-v4 flash/pro 在 high/max 两种 reasoning effort 下是否响应 temperature。
//
// 与 v1 的差异（针对 v1 README §9 方法修正清单）:
//   - 新增 effort 维度: 2 模型 × {high, max} × 3 温度 × 2 prompt，全交叉；
//   - 指标升级: 保留 4-gram Jaccard（连续性），新增归一化编辑距离相似度（短文本更灵敏）、
//     字级 TTR、逐字重复对占比 dup（T0 确定性直接度量）；同时捕获 thinking 文本并测其多样性；
//   - 排除截断输出（finish=length）参与多样性指标，并单列截断率；
//   - 原始数据落盘 results-v2.json（可复算）。
//
// 经 dsh 真实 adapter 链路（DeepSeekAdapter, stream:true, thinking enabled），非裸 curl。
// 注意: 真实链路不发送 seed（dsh-llm-deepseek 无此字段）——seed 对照见同目录 seed-v2.mjs。
//
// 用法: node probe-v2.mjs [--models flash,pro] [--efforts high,max] [--temps 0,1,2]
//       [--n 15] [--prompts structured,open] [--concurrency 6] [--max-tokens 1024] [--out results-v2.json]
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeepSeekAdapter, resolveAdapterOptions } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js';

// ── CLI 配置 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const MODELS = (opt('--models', opt('--model', 'deepseek-v4-flash,deepseek-v4-pro')) || 'deepseek-v4-flash,deepseek-v4-pro').split(',').map((s) => s.trim());
const EFFORTS = (opt('--efforts', 'high,max') || 'high,max').split(',').map((s) => s.trim());
const TEMPS = (opt('--temps', '0,1,2') || '0,1,2').split(',').map((s) => Number(s.trim()));
const N = Number(opt('--n', '15') || 15);
const PROMPT_MODES = (opt('--prompts', opt('--prompt', 'structured,open')) || 'structured,open').split(',').map((s) => s.trim());
const CONCURRENCY = Number(opt('--concurrency', '6') || 6);
const MAX_TOKENS = Number(opt('--max-tokens', '1024') || 1024);
const OUT = opt('--out', 'results-v2.json');
const BOOT_R = 2000;
const EQUIV_BOUND = 0.05; // 相似度差的等价界（与 v1 相同，预注册）
const ALPHA = 0.05; // 每个 cell 单独报 p 值；全局判定用方向一致性而非单一 p

const PROMPTS = {
  structured: `你是一位资深技术评审。请审阅以下方案，并严格按以下两行格式输出：
**Overall Verdict**: READY 或 NEEDS_REVISION（二选一）
**理由**: 一句话说明。

方案：用 Node.js 重写现有 Python 数据处理管线，使用 worker_threads 并行处理，目标是吞吐提升 3 倍。`,
  open: `请用不超过 120 字，描述一个好的软件架构应该具备哪些关键特质，并给出一个具体例子。`,
};

// ── 凭据与 adapter（镜像 v1/probe-l3.mjs 的装配）──────────────────────────
async function getKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const content = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const m = content.match(/DEEPSEEK_API_KEY\s*:\s*(.+)/);
  if (!m) throw new Error('未找到 DEEPSEEK_API_KEY');
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const environment = {
  get: (key) => {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : { value };
  },
};
const config = {}; // 空配置 → adapter 默认（与 profile 默认一致）
const optionsThunk = () => resolveAdapterOptions(config, environment);
optionsThunk();
const adapter = new DeepSeekAdapter({
  options: optionsThunk,
  resolveApiKey: async () => getKey(),
  resolveUserId: () => 'p0-v2',
  // dsh 升级后 adapter 必需; 探针无扩展 → 空实现（与 harness 无扩展时的回退一致, lib/index.js:2030）
  prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
});

// ── 经真实链路调用一次（捕获 thinking + content + finish）─────────────────
async function harnessCall(model, effort, temperature, prompt) {
  const requestOptions = {
    provider: 'deepseek-official',
    model,
    messages: [{
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'p0-v2' },
    }],
    temperature,
    maxTokens: MAX_TOKENS,
    reasoningEffort: effort,
  };
  const t0 = Date.now();
  let text = '';
  let think = '';
  let finishKind = null;
  try {
    const adapterCall = await adapter.prepareCall('deepseek-official', model, undefined);
    for await (const chunk of adapterCall.stream(requestOptions)) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'reasoning-delta') think += chunk.text ?? '';
      else if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind ?? null;
        if (chunk.reason?.kind === 'error') throw new Error('finish error: ' + (chunk.reason.failure?.message ?? ''));
      }
    }
    return { ok: true, text, think, finish: finishKind, latency: Date.now() - t0 };
  } catch (error) {
    return { ok: false, detail: String(error.message ?? error).slice(0, 300), latency: Date.now() - t0, text: '', think: '' };
  }
}

// ── 指标 ──────────────────────────────────────────────────────────────────
function verdict(text) {
  const m = String(text ?? '').match(/\*\*Overall Verdict\*\*\s*:\s*(READY|NEEDS_REVISION)/i);
  return m ? m[1].toUpperCase() : null;
}
function normText(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}
// 字符 4-gram Jaccard（与 v1 相同）
const gramCache = new Map();
function grams(text) {
  const s = normText(text);
  const out = new Set();
  for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4));
  return out;
}
function jaccard(a, b) {
  let A = gramCache.get(a);
  let B = gramCache.get(b);
  if (!A) { A = grams(a); gramCache.set(a, A); }
  if (!B) { B = grams(b); gramCache.set(b, B); }
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
// 归一化编辑距离相似度 = 1 − lev/max(len)（字符级，对短中文文本更灵敏）
function editSim(a, b) {
  const s = normText(a);
  const t = normText(b);
  if (s.length === 0 && t.length === 0) return 1;
  const maxLen = Math.max(s.length, t.length);
  if (maxLen === 0) return 0;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
  }
  return 1 - prev[t.length] / maxLen;
}
// 字级 TTR（单文本: 去空白后去重字符占比）
function ttr(text) {
  const s = normText(text);
  if (!s.length) return 0;
  return new Set([...s]).size / s.length;
}
// 配对指标: 两两重复率 / 平均相似度
function pairStats(texts, simFn) {
  const n = texts.length;
  let sum = 0;
  let dup = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = simFn(texts[i], texts[j]);
      sum += sim;
      if (sim === 1) dup++;
      count++;
    }
  }
  return { mean: count ? sum / count : NaN, dupRate: count ? dup / count : 0, pairs: count };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
// bootstrap 均值差检验（中心化）: H0 = 两臂均值相等
function bootstrapDiffTest(xsA, xsB, simFn) {
  const observed = pairStats(xsB, simFn).mean - pairStats(xsA, simFn).mean;
  const diffs = [];
  for (let r = 0; r < BOOT_R; r++) {
    const a = [];
    const b = [];
    for (let i = 0; i < xsA.length; i++) a.push(xsA[Math.floor(Math.random() * xsA.length)]);
    for (let i = 0; i < xsB.length; i++) b.push(xsB[Math.floor(Math.random() * xsB.length)]);
    diffs.push(pairStats(b, simFn).mean - pairStats(a, simFn).mean - observed);
  }
  let far = 0;
  for (const d of diffs) if (Math.abs(d) >= Math.abs(observed)) far++;
  diffs.sort((a, b) => a - b);
  return { observed, p: far / BOOT_R, ci: [observed + diffs[Math.floor(BOOT_R * 0.025)], observed + diffs[Math.floor(BOOT_R * 0.975)]] };
}
// 预注册分类（与 v1 相同的等价界逻辑）: Δ = T2 − T0
function classify(observed, ci) {
  if (ci[0] > EQUIV_BOUND) return { verdict: 'REVERSED(反向)', note: `CI 全部 > +${EQUIV_BOUND}: T2 更相似, 与温度语义相反` };
  if (ci[1] < -EQUIV_BOUND) return { verdict: 'PASS(方向正确)', note: `CI 全部 < -${EQUIV_BOUND}: T2 显著更分散` };
  if (ci[0] > -EQUIV_BOUND && ci[1] < EQUIV_BOUND) return { verdict: 'IGNORED(与忽略一致)', note: `CI 落在 ±${EQUIV_BOUND} 等效界内` };
  return { verdict: 'INCONCLUSIVE(CI 过宽)', note: 'CI 跨过等效界, 样本不足或效应为弱' };
}

// ── 任务队列: 交错执行抗时间漂移 ─────────────────────────────────────────
function buildTasks() {
  const cells = [];
  for (const model of MODELS) for (const effort of EFFORTS) for (const pm of PROMPT_MODES) cells.push({ model, effort, pm });
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const order = i % 2 === 0 ? TEMPS : [...TEMPS].reverse();
    for (const cell of cells) {
      for (const temp of order) tasks.push({ ...cell, temp, prompt: PROMPTS[cell.pm] });
    }
  }
  return tasks;
}
async function runPool(tasks, concurrency, onDone) {
  let next = 0;
  const results = new Array(tasks.length);
  let done = 0;
  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      const task = tasks[idx];
      const r = await harnessCall(task.model, task.effort, task.temp, task.prompt);
      results[idx] = { ...task, ...r };
      done++;
      onDone?.(done, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const tasks = buildTasks();
const total = tasks.length;
console.log(`v2 主探针: adapter=DeepSeekAdapter stream:true  models=[${MODELS}]  efforts=[${EFFORTS}]  temps=[${TEMPS}]  n=${N}  prompts=[${PROMPT_MODES}]  maxTokens=${MAX_TOKENS}  concurrency=${CONCURRENCY}`);
console.log(`总请求 = ${MODELS.length}×${EFFORTS.length}×${PROMPT_MODES.length}×${TEMPS.length}×${N} = ${total}`);
const t0 = Date.now();
const results = await runPool(tasks, CONCURRENCY, (done) => {
  if (done % 24 === 0 || done === total) {
    const el = (Date.now() - t0) / 1000;
    console.log(`进度 ${done}/${total}  (${el.toFixed(0)}s, 预计剩余 ${(el / done * (total - done) / 60).toFixed(1)}min)`);
  }
});
console.log(`全部完成, 用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)}min`);

// ── 汇总 ──────────────────────────────────────────────────────────────────
const summary = { cells: [] };
for (const model of MODELS) {
  for (const effort of EFFORTS) {
    for (const pm of PROMPT_MODES) {
      const isStructured = pm === 'structured';
      const cellResults = results.filter((r) => r.model === model && r.effort === effort && r.pm === pm);
      console.log(`\n═══════ model=${model}  effort=${effort}  prompt=${pm} ═══════`);
      const arms = {};
      for (const temp of TEMPS) {
        const out = cellResults.filter((r) => r.temp === temp);
        const errs = out.filter((r) => !r.ok);
        const ok = out.filter((r) => r.ok);
        const truncated = ok.filter((r) => r.finish === 'length');
        const empty = ok.filter((r) => !r.text.trim());
        // 多样性指标只用完整、非空输出
        const texts = ok.filter((r) => r.text.trim() && r.finish !== 'length').map((r) => r.text);
        const thinks = ok.filter((r) => r.think.trim() && r.finish !== 'length').map((r) => r.think);
        const vs = ok.map((r) => verdict(r.text));
        const jc = pairStats(texts, jaccard);
        const ed = pairStats(texts, editSim);
        const tt = mean(texts.map(ttr));
        const jcT = pairStats(thinks, jaccard);
        arms[temp] = { n: out.length, errs: errs.length, truncated: truncated.length, empty: empty.length, texts, thinks, vs, jc, ed, ttr: tt, jcT };
        console.log(`temp=${temp}  成功=${ok.length}/${out.length}  失败=${errs.length}  截断=${truncated.length}  空输出=${empty.length}  延迟=${mean(ok.map((r) => r.latency)).toFixed(0)}ms${errs.length ? `  e.g. ${JSON.stringify(errs[0].detail ?? errs[0]).slice(0, 140)}` : ''}`);
        console.log(`  content: jacc4=${jc.mean.toFixed(3)}  editSim=${ed.mean.toFixed(3)}  TTR=${tt.toFixed(3)}  dupRate=${jc.dupRate.toFixed(2)}  n=${texts.length}${thinks.length ? `  | thinking: jacc4=${jcT.mean.toFixed(3)}  dupRate=${jcT.dupRate.toFixed(2)}` : ''}${isStructured ? `  verdict解析=${vs.filter(Boolean).length}/${vs.length} (${[...new Set(vs.filter(Boolean))].join(',')})` : ''}`);
      }
      // T0 vs T2 差异检验（content jacc4 主指标 + editSim 次指标 + thinking jacc4）
      const stats = { jaccFinal: null, editFinal: null, jaccThink: null };
      if (arms[TEMPS[0]].texts.length >= 2 && arms[TEMPS[TEMPS.length - 1]].texts.length >= 2) {
        stats.jaccFinal = bootstrapDiffTest(arms[TEMPS[0]].texts, arms[TEMPS[TEMPS.length - 1]].texts, jaccard);
        stats.editFinal = bootstrapDiffTest(arms[TEMPS[0]].texts, arms[TEMPS[TEMPS.length - 1]].texts, editSim);
      }
      if (arms[TEMPS[0]].thinks.length >= 2 && arms[TEMPS[TEMPS.length - 1]].thinks.length >= 2) {
        stats.jaccThink = bootstrapDiffTest(arms[TEMPS[0]].thinks, arms[TEMPS[TEMPS.length - 1]].thinks, jaccard);
      }
      console.log(`── 统计 (Δ = T${TEMPS[TEMPS.length - 1]} − T${TEMPS[0]} 相似度均值差; 温度生效应 < 0) ──`);
      const row = { model, effort, prompt: pm, arms: {}, stats: {} };
      for (const [name, st] of Object.entries(stats)) {
        if (!st) continue;
        const cls = classify(st.observed, st.ci);
        row.stats[name] = { observed: st.observed, p: st.p, ci: st.ci, verdict: cls.verdict };
        console.log(`  ${name}: Δ=${st.observed.toFixed(3)}  p=${st.p.toFixed(4)}  95%CI=[${st.ci[0].toFixed(3)}, ${st.ci[1].toFixed(3)}]  → ${cls.verdict}`);
      }
      // T0 确定性直接证据
      const d0 = arms[TEMPS[0]].jc.dupRate;
      const d2 = arms[TEMPS[TEMPS.length - 1]].jc.dupRate;
      console.log(`  逐字重复对占比: T${TEMPS[0]}=${d0.toFixed(2)}  T${TEMPS[TEMPS.length - 1]}=${d2.toFixed(2)}  ${d0 > 0.5 ? '← T0 高度确定性（温度生效的强证据）' : 'T0 非确定性（与"忽略温度/非贪心"一致）'}`);
      for (const temp of TEMPS) row.arms[temp] = { n: arms[temp].n, errs: arms[temp].errs, truncated: arms[temp].truncated, empty: arms[temp].empty, texts: arms[temp].texts, thinks: arms[temp].thinks };
      summary.cells.push(row);
    }
  }
}
// 模型 × effort 汇总判定
console.log(`\n═══════ 按 model × effort 汇总 ═══════`);
for (const model of MODELS) {
  for (const effort of EFFORTS) {
    const rows = summary.cells.filter((c) => c.model === model && c.effort === effort);
    const verdicts = [];
    for (const r of rows) {
      if (r.stats.jaccFinal) verdicts.push({ prompt: r.prompt, metric: 'jaccFinal', v: r.stats.jaccFinal.verdict, d: r.stats.jaccFinal.observed });
      if (r.stats.editFinal) verdicts.push({ prompt: r.prompt, metric: 'editFinal', v: r.stats.editFinal.verdict, d: r.stats.editFinal.observed });
      if (r.stats.jaccThink) verdicts.push({ prompt: r.prompt, metric: 'jaccThink', v: r.stats.jaccThink.verdict, d: r.stats.jaccThink.observed });
    }
    const pass = verdicts.filter((x) => x.v.startsWith('PASS'));
    const rev = verdicts.filter((x) => x.v.startsWith('REVERSED'));
    const ign = verdicts.filter((x) => x.v.startsWith('IGNORED'));
    const inc = verdicts.filter((x) => x.v.startsWith('INCONCLUSIVE'));
    console.log(`${model} × ${effort}: PASS=${pass.length} REVERSED=${rev.length} IGNORED=${ign.length} INCONCLUSIVE=${inc.length} / ${verdicts.length} 比较`);
    for (const v of verdicts) console.log(`    ${v.prompt}·${v.metric}: ${v.v} (Δ=${v.d.toFixed(3)})`);
  }
}
const OUT_PATH = OUT.startsWith('/') ? OUT : join(import.meta.dirname, OUT);
await writeFile(OUT_PATH, JSON.stringify({ config: { MODELS, EFFORTS, TEMPS, N, PROMPT_MODES, MAX_TOKENS, BOOT_R, EQUIV_BOUND }, results: summary.cells }, null, 2));
console.log(`\n原始数据已写入 ${OUT}（texts/thinks 全量保留, 可复算）。`);
console.log(`判定口径见 v2/README.md §判定矩阵; seed 对照（决定"忽略 vs 非贪心"）另见 seed-v2.mjs。`);
