#!/usr/bin/env node
// L3 正式版探针 — 经 dsh 真实 adapter 链路验证 temperature（不是裸 curl）。
//
// 与 L2 的区别: 本脚本直接实例化 dsh-llm-deepseek 的 DeepSeekAdapter（与 harness
// 生产同款），走 adapter.prepareCall → stream 的真实序列化路径:
//   - stream: true + stream_options（真实流式请求）
//   - reasoningEffort: 'high'（profile 实际配置: settings.yaml agent-default-model
//     reasoningEffort=high, 所有 arena 链接 reasoningEffort=high）
//   - 与真实调用一致的 message 序列化 / SSE 解析
// 验证问题: 真实链路（带 reasoning_effort）下 temperature 是否行为不同。
//
// 用法: node probe-l3.mjs [--model ...] [--temps 0,1,2] [--n 10] [--prompts structured,open]
import { readFile } from 'node:fs/promises';
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
const MODELS = (opt('--model', 'deepseek-v4-flash') || 'deepseek-v4-flash').split(',').map((s) => s.trim());
const TEMPS = (opt('--temps', '0,2') || '0,2').split(',').map((s) => Number(s.trim()));
const N = Number(opt('--n', '10') || 10);
const PROMPT_MODES = (opt('--prompts', opt('--prompt', 'structured')) || 'structured').split(',').map((s) => s.trim());
const REASONING_EFFORT = opt('--effort', 'high'); // profile 实际值
const MAX_TOKENS = Number(opt('--max-tokens', '1024')); // reasoning 模式需更大预算
const BOOT_R = 1000;
const EQUIV_BOUND = 0.05;
const ALPHA = 0.0125; // 2 模型 × 2 prompt = 4 比较

const PROMPTS = {
  structured: `你是一位资深技术评审。请审阅以下方案，并严格按以下两行格式输出：
**Overall Verdict**: READY 或 NEEDS_REVISION（二选一）
**理由**: 一句话说明。

方案：用 Node.js 重写现有 Python 数据处理管线，使用 worker_threads 并行处理，目标是吞吐提升 3 倍。`,
  open: `请用不超过 120 字，描述一个好的软件架构应该具备哪些关键特质，并给出一个具体例子。`,
};

// ── 构造真实 adapter（镜像 dsh-llm-deepseek apply() 的装配）──────────────
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
const resolveApiKey = async () => getKey();
const adapter = new DeepSeekAdapter({
  options: optionsThunk,
  resolveApiKey,
  resolveUserId: () => 'p0-l3',
});

// ── 经真实链路调用一次 ────────────────────────────────────────────────────
async function harnessCall(model, temperature, prompt) {
  const requestOptions = {
    provider: 'deepseek-official',
    model,
    messages: [{
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'p0-l3' },
    }],
    temperature,
    maxTokens: MAX_TOKENS,
    reasoningEffort: REASONING_EFFORT,
  };
  const t0 = Date.now();
  let text = '';
  let finishReason = null;
  try {
    const adapterCall = await adapter.prepareCall('deepseek-official', model, undefined);
    for await (const chunk of adapterCall.stream(requestOptions)) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish') {
        finishReason = chunk.reason?.kind ?? null;
        if (chunk.reason?.kind === 'error') throw new Error('finish error: ' + (chunk.reason.failure?.message ?? ''));
      }
    }
    return { temperature, ok: true, text, finish: finishReason, latency: Date.now() - t0 };
  } catch (error) {
    return { temperature, ok: false, status: 'error', detail: String(error.message ?? error).slice(0, 300), latency: Date.now() - t0 };
  }
}

// ── 指标（与 L2 相同）────────────────────────────────────────────────────
function verdict(text) {
  const m = String(text ?? '').match(/\*\*Overall Verdict\*\*\s*:\s*(READY|NEEDS_REVISION)/i);
  return m ? m[1].toUpperCase() : null;
}
const gramCache = new Map();
function grams(text, n = 4) {
  const s = String(text ?? '').replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
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
function pairwiseMean(texts) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) { sum += jaccard(texts[i], texts[j]); count++; }
  return count ? sum / count : NaN;
}
function bootstrapDiffTest(textsA, textsB) {
  const observed = pairwiseMean(textsB) - pairwiseMean(textsA);
  const diffs = [];
  for (let r = 0; r < BOOT_R; r++) {
    const a = [];
    const b = [];
    for (let i = 0; i < textsA.length; i++) a.push(textsA[Math.floor(Math.random() * textsA.length)]);
    for (let i = 0; i < textsB.length; i++) b.push(textsB[Math.floor(Math.random() * textsB.length)]);
    diffs.push(pairwiseMean(b) - pairwiseMean(a) - observed);
  }
  let far = 0;
  for (const d of diffs) if (Math.abs(d) >= Math.abs(observed)) far++;
  diffs.sort((a, b) => a - b);
  const ci = [observed + diffs[Math.floor(BOOT_R * 0.025)], observed + diffs[Math.floor(BOOT_R * 0.975)]];
  return { observed, p: far / BOOT_R, ci };
}
function bootstrapCI(sims) {
  const boots = [];
  for (let r = 0; r < BOOT_R; r++) {
    let sum = 0;
    for (let i = 0; i < sims.length; i++) sum += sims[Math.floor(Math.random() * sims.length)];
    boots.push(sum / sims.length);
  }
  boots.sort((a, b) => a - b);
  return [boots[Math.floor(BOOT_R * 0.025)], boots[Math.floor(BOOT_R * 0.975)]];
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function classify(observed, ci) {
  if (ci[0] > EQUIV_BOUND) return { verdict: 'REVERSED(反相)', note: `CI 全部 > +${EQUIV_BOUND}: T2 更收敛, 与温度语义相反` };
  if (ci[1] < -EQUIV_BOUND) return { verdict: 'PASS(方向正确)', note: `CI 全部 < -${EQUIV_BOUND}: T2 显著更分散` };
  if (ci[0] > -EQUIV_BOUND && ci[1] < EQUIV_BOUND) return { verdict: 'IGNORED(与忽略一致)', note: `CI 落在 ±${EQUIV_BOUND} 等效界内` };
  return { verdict: 'INCONCLUSIVE(CI 过宽)', note: 'CI 跨过等效界, 样本不足或效应为弱' };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
console.log(`L3 真实链路: adapter=DeepSeekAdapter  stream:true  reasoningEffort=${REASONING_EFFORT}  models=[${MODELS}]  temps=[${TEMPS}]  n=${N}  α=${ALPHA}`);
for (const promptMode of PROMPT_MODES) {
  const prompt = PROMPTS[promptMode];
  const isStructured = promptMode === 'structured';
  for (const model of MODELS) {
    console.log(`\n═══════ prompt=${promptMode}  model=${model} ═══════`);
    const byTemp = Object.fromEntries(TEMPS.map((t) => [t, []]));
    for (let i = 0; i < N; i++) {
      const order = i % 2 === 0 ? TEMPS : [...TEMPS].reverse();
      for (const temp of order) byTemp[temp].push(await harnessCall(model, temp, prompt));
    }
    const perArm = {};
    for (const temp of TEMPS) {
      const out = byTemp[temp];
      const errs = out.filter((r) => !r.ok);
      const ok = out.filter((r) => r.ok);
      const texts = ok.map((r) => r.text);
      const vs = ok.map((r) => verdict(r.text));
      const sims = [];
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) sims.push(jaccard(texts[i], texts[j]));
      const [lo, hi] = sims.length ? bootstrapCI(sims) : [NaN, NaN];
      perArm[temp] = { texts, vs };
      console.log(`temp=${temp}  成功=${ok.length}/${out.length}  失败=${errs.length}${errs.length ? '  e.g. ' + JSON.stringify(errs[0].detail).slice(0, 140) : ''}`);
      console.log(`  相似度 mean=${mean(sims).toFixed(3)}  95%CI=[${lo.toFixed(3)}, ${hi.toFixed(3)}]${isStructured ? `  verdict=${vs.filter(Boolean).length}/${vs.length} (${[...new Set(vs)].join(',')})` : ''}`);
      if (ok.length) console.log(`  延迟 mean=${mean(ok.map((r) => r.latency)).toFixed(0)}ms`);
    }
    if (perArm[TEMPS[0]]?.texts.length >= 2 && perArm[TEMPS[TEMPS.length - 1]]?.texts.length >= 2) {
      const { observed, p, ci } = bootstrapDiffTest(perArm[TEMPS[0]].texts, perArm[TEMPS[TEMPS.length - 1]].texts);
      const cls = classify(observed, ci);
      console.log(`── 统计 (T${TEMPS[TEMPS.length - 1]} − T${TEMPS[0]} 相似度均值差) ──`);
      console.log(`  Δ=${observed.toFixed(3)}  p=${p.toFixed(4)}${p < ALPHA ? '  <α' : '  ≥α'}  95%CI=[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`);
      console.log(`  判定: ${cls.verdict}  — ${cls.note}`);
      if (isStructured) {
        const v0 = [...new Set(perArm[TEMPS[0]].vs)].join(',');
        const v2 = [...new Set(perArm[TEMPS[TEMPS.length - 1]].vs)].join(',');
        console.log(`  verdict 恒定性: T${TEMPS[0]}=(${v0})  T${TEMPS[TEMPS.length - 1]}=(${v2})  ${v0 === v2 ? '两温度判定行为一致' : '两温度判定行为不同'}`);
      }
    }
  }
}
console.log(`\n完成。真实链路（reasoningEffort=${REASONING_EFFORT}, stream:true）结果与 L2 对照即定案。`);
