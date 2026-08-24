#!/usr/bin/env node
// P0 / L2 正式版探针 — 验证 deepseek-v4 系列是否响应 temperature（统计级 A/B）。
//
// 用法:
//   node probe.mjs --model deepseek-v4-flash,deepseek-v4-pro --temps 0,1,2 --n 20
//     [--prompts structured,open] [--prompt structured|open] [--base-url URL]
//
// 设计（对应 tools/temperature-p0/README.md 的 L2）:
//   - 交错执行: 每轮 i 交替温度顺序（0,1,2 / 2,1,0），抗时间漂移；
//   - 每 arm n 次; 固定 prompt / max_tokens / stream:false；
//   - 指标: 组内两两相似度（字符 4-gram Jaccard）均值 + bootstrap 95% CI +
//     bootstrap 均值差检验（T2 − T0）；结构化题另报 verdict 解析率/多样性；
//   - 按验收标准自动分类（PASS / WEAK / IGNORED / REJECTED / INCONCLUSIVE）。
//
// 凭据: $DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml（与 dsh web 同源）。
// 端点: $DEEPSEEK_BASE_URL 或 https://api.deepseek.com。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── CLI 配置 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const MODELS = (opt('--model', 'deepseek-v4-flash') || 'deepseek-v4-flash').split(',').map((s) => s.trim());
const TEMPS = (opt('--temps', '0,2') || '0,2').split(',').map((s) => Number(s.trim()));
const N = Number(opt('--n', '20') || 20);
const PROMPT_MODES = (opt('--prompts', opt('--prompt', 'structured')) || 'structured').split(',').map((s) => s.trim());
const BASE_URL = process.env.DEEPSEEK_BASE_URL || opt('--base-url', '') || 'https://api.deepseek.com';
const BOOT_R = 1000;
const EQUIV_BOUND = 0.05; // 相似度差的等价界: |Δ| 落在此内视为"与忽略一致"
const ALPHA = 0.0125; // Bonferroni: 2 模型 × 2 prompt = 4 次比较, 0.05/4

const PROMPTS = {
  structured: `你是一位资深技术评审。请审阅以下方案，并严格按以下两行格式输出：
**Overall Verdict**: READY 或 NEEDS_REVISION（二选一）
**理由**: 一句话说明。

方案：用 Node.js 重写现有 Python 数据处理管线，使用 worker_threads 并行处理，目标是吞吐提升 3 倍。`,
  open: `请用不超过 120 字，描述一个好的软件架构应该具备哪些关键特质，并给出一个具体例子。`,
};

// ── 凭据 ─────────────────────────────────────────────────────────────────
async function getKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const content = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const m = content.match(/DEEPSEEK_API_KEY\s*:\s*(.+)/);
  if (!m) throw new Error('未找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

// ── 单次调用 ──────────────────────────────────────────────────────────────
async function call(key, model, temperature, prompt) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: 512,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (error) {
    return { temperature, ok: false, status: 'network', detail: String(error.message ?? error).slice(0, 300), latency: Date.now() - t0 };
  }
  const latency = Date.now() - t0;
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch { /* ignore */ }
    return { temperature, ok: false, status: res.status, detail, latency };
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { temperature, ok: true, text, finish: data.choices?.[0]?.finish_reason, latency, model: data.model };
}

// ── 指标 ──────────────────────────────────────────────────────────────────
function verdict(text) {
  const m = String(text ?? '').match(/\*\*Overall Verdict\*\*\s*:\s*(READY|NEEDS_REVISION)/i);
  return m ? m[1].toUpperCase() : null;
}
function grams(text, n = 4) {
  const s = String(text ?? '').replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}
const gramCache = new Map();
function gramsCached(text) {
  let g = gramCache.get(text);
  if (!g) { g = grams(text); gramCache.set(text, g); }
  return g;
}
function jaccard(a, b) {
  const A = gramsCached(a);
  const B = gramsCached(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
function pairwiseMean(texts) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) { sum += jaccard(texts[i], texts[j]); count++; }
  }
  return count ? sum / count : NaN;
}
function bootstrapCIOfMean(sims) {
  const boots = [];
  for (let r = 0; r < BOOT_R; r++) {
    let sum = 0;
    for (let i = 0; i < sims.length; i++) sum += sims[Math.floor(Math.random() * sims.length)];
    boots.push(sum / sims.length);
  }
  boots.sort((a, b) => a - b);
  return [boots[Math.floor(BOOT_R * 0.025)], boots[Math.floor(BOOT_R * 0.975)]];
}
// bootstrap 均值差检验: H0 = T2 与 T0 相似度均值相等（温度无效果）
function bootstrapDiffTest(textsA, textsB) {
  const observed = pairwiseMean(textsB) - pairwiseMean(textsA);
  const diffs = [];
  for (let r = 0; r < BOOT_R; r++) {
    const a = [];
    const b = [];
    for (let i = 0; i < textsA.length; i++) a.push(textsA[Math.floor(Math.random() * textsA.length)]);
    for (let i = 0; i < textsB.length; i++) b.push(textsB[Math.floor(Math.random() * textsB.length)]);
    diffs.push(pairwiseMean(b) - pairwiseMean(a) - observed); // 中心化 → 以 H0 为原点
  }
  let far = 0;
  for (const d of diffs) if (Math.abs(d) >= Math.abs(observed)) far++;
  diffs.sort((a, b) => a - b);
  const ci = [observed + diffs[Math.floor(BOOT_R * 0.025)], observed + diffs[Math.floor(BOOT_R * 0.975)]];
  return { observed, p: far / BOOT_R, ci };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ── 分类（按验收标准）──────────────────────────────────────────────────────
function classify(observed, ci) {
  // 温度语义: 生效时 T2 应比 T0 更分散 → 相似度差(observed = T2−T0) < 0 且幅度显著
  if (ci[0] > EQUIV_BOUND) return { verdict: 'REVERSED(反相)', note: `CI=[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] 全部 > +${EQUIV_BOUND}: T2 更收敛, 与温度语义相反` };
  if (ci[1] < -EQUIV_BOUND) return { verdict: 'PASS(方向正确)', note: `CI=[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] 全部 < -${EQUIV_BOUND}: T2 显著更分散` };
  if (ci[0] > -EQUIV_BOUND && ci[1] < EQUIV_BOUND) return { verdict: 'IGNORED(与忽略一致)', note: `CI=[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] 落在 ±${EQUIV_BOUND} 等效界内` };
  return { verdict: 'INCONCLUSIVE(CI 过宽)', note: `CI=[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] 跨过等效界, 样本不足或效应为弱` };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const key = await getKey();
console.log(`L2 正式版: baseURL=${BASE_URL}  models=[${MODELS}]  temps=[${TEMPS}]  n=${N}  prompts=[${PROMPT_MODES}]  bootR=${BOOT_R}  α=${ALPHA}`);
for (const promptMode of PROMPT_MODES) {
  const prompt = PROMPTS[promptMode];
  const isStructured = promptMode === 'structured';
  for (const model of MODELS) {
    console.log(`\n═══════ prompt=${promptMode}  model=${model} ═══════`);
    // 交错执行: 每轮交替温度顺序
    const byTemp = Object.fromEntries(TEMPS.map((t) => [t, []]));
    for (let i = 0; i < N; i++) {
      const order = i % 2 === 0 ? TEMPS : [...TEMPS].reverse();
      for (const temp of order) {
        const r = await call(key, model, temp, prompt);
        byTemp[temp].push(r);
      }
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
      const [lo, hi] = sims.length ? bootstrapCIOfMean(sims) : [NaN, NaN];
      perArm[temp] = { texts, sims, vs, errs, ok };
      console.log(`temp=${temp}  成功=${ok.length}/${out.length}  失败=${errs.length}${errs.length ? '  e.g. ' + JSON.stringify(errs[0].detail).slice(0, 140) : ''}`);
      console.log(`  相似度 mean=${mean(sims).toFixed(3)}  95%CI=[${lo.toFixed(3)}, ${hi.toFixed(3)}]${isStructured ? `  verdict=${vs.filter(Boolean).length}/${vs.length} (${[...new Set(vs)].join(',')})` : ''}`);
      if (ok.length) console.log(`  延迟 mean=${mean(ok.map((r) => r.latency)).toFixed(0)}ms`);
    }
    // 统计: T0 vs T2
    if (perArm[TEMPS[0]]?.ok.length >= 2 && perArm[TEMPS[TEMPS.length - 1]]?.ok.length >= 2) {
      const t0 = perArm[TEMPS[0]];
      const t2 = perArm[TEMPS[TEMPS.length - 1]];
      const { observed, p, ci } = bootstrapDiffTest(t0.texts, t2.texts);
      const cls = classify(observed, ci);
      console.log(`── 统计 (T${TEMPS[TEMPS.length - 1]} − T${TEMPS[0]} 相似度均值差) ──`);
      console.log(`  Δ=${observed.toFixed(3)}  p=${p.toFixed(4)}${p < ALPHA ? '  <α' : '  ≥α'}  95%CI=[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`);
      console.log(`  判定: ${cls.verdict}  — ${cls.note}`);
      if (isStructured) {
        const v0 = [...new Set(t0.vs)].join(',');
        const v2 = [...new Set(t2.vs)].join(',');
        console.log(`  verdict 恒定性: T${TEMPS[0]}=(${v0})  T${TEMPS[TEMPS.length - 1]}=(${v2})  ${v0 === v2 ? '两温度判定行为一致' : '两温度判定行为不同'}`);
      }
    }
  }
}
console.log(`\n完成。α=${ALPHA}（Bonferroni: 2 模型 × 2 prompt = 4 次比较）。判定仅基于相似度差; 需结合 verdict 恒定性、L3 链路复现综合定案。`);
