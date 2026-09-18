#!/usr/bin/env node
// plot-curve — 把 probe-nothink.mjs 的多次运行结果合并成一条温度曲线，输出 SVG + HTML
//
// 用法:
//   node tools/temperature-nothink/plot-curve.mjs                      # 默认合并 results-nothink.json + results-nothink-0515.json
//   node tools/temperature-nothink/plot-curve.mjs a.json b.json        # 指定输入（按 temperature 去重合并）
//   node tools/temperature-nothink/plot-curve.mjs --out curve          # 输出文件前缀（默认 curve）
//
// 输出: <prefix>.svg（矢量图）+ <prefix>.html（内嵌图 + 数据表 + 回答分布）
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = import.meta.dirname;
const args = process.argv.slice(2);
const optVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT_PREFIX = optVal('--out', 'curve');
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const INPUTS = files.length ? files : ['results-nothink.json', 'results-nothink-0515.json'];

// ── 读入并合并（同一温度后出现的覆盖先前）─────────────────────────────────
const merged = new Map();
const sources = [];
for (const f of INPUTS) {
  const p = f.startsWith('/') ? f : join(DIR, f);
  let data;
  try { data = JSON.parse(await readFile(p, 'utf8')); }
  catch (e) { console.warn(`跳过 ${f}: ${e.message}`); continue; }
  for (const s of data.summary) merged.set(Number(s.temperature), s);
  sources.push({ file: f, config: data.config });
}
const pts = [...merged.values()].sort((a, b) => a.temperature - b.temperature);
if (pts.length < 2) { console.error('可用数据点少于 2 个，无法画曲线'); process.exit(1); }

// ── 图表面板定义 ──────────────────────────────────────────────────────────
const PANELS = [
  { key: 'unique', title: '不同回答数', unit: '种', value: (s) => s.unique, fmt: (v) => v.toFixed(0), yMax: null, yTicks: 4 },
  { key: 'entropy', title: 'Shannon 熵', unit: 'bit', value: (s) => s.entropy, fmt: (v) => v.toFixed(2), yMax: null, yTicks: 4 },
  { key: 'modeShare', title: '众数占比', unit: '%', value: (s) => s.modeShare * 100, fmt: (v) => v.toFixed(0) + '%', yMax: 100, yTicks: 4 },
  { key: 'dupRate', title: '逐字重复对占比', unit: '%', value: (s) => s.dupRate * 100, fmt: (v) => v.toFixed(1) + '%', yMax: 100, yTicks: 4 },
];

// 布局：HEAD(顶部标题) + 两行面板，每行 = 面板高 PH + 56 的 x 轴区，行间留 GAPY
const W = 900, PAD = 56, GAPX = 56;
const HEAD = 92, PH = 250, GAPY = 92;
const H = HEAD + PH * 2 + GAPY + 40;
const PW = (W - PAD * 2 - GAPX) / 2;
const X0 = PAD, Y0 = HEAD;
const PADX = 30, PADY = 18;   // 面板内边距：端点不贴轴，标签不压标题/刻度
const tempMin = Math.min(...pts.map((p) => p.temperature));
const tempMax = Math.max(...pts.map((p) => p.temperature));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif">`);
svg.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
const cfg0 = sources[0]?.config ?? {};
svg.push(`<text x="${PAD}" y="36" font-size="20" font-weight="600" fill="#111">deepseek-flash 温度曲线（thinking: disabled）</text>`);
svg.push(`<text x="${PAD}" y="60" font-size="13" fill="#666">model=${esc(cfg0.MODEL ?? 'deepseek-flash')} · thinking=${esc(cfg0.thinking ?? 'disabled')} · 每档 n=${esc(String(cfg0.N ?? 50))} 次 · 同题同 prompt · 点为实测值</text>`);

const ticks = pts.map((p) => p.temperature);
const xr = (t) => PADX + ((t - tempMin) / (tempMax - tempMin || 1)) * (PW - PADX * 2); // 面板内相对 x

PANELS.forEach((panel, pi) => {
  const col = pi % 2, row = Math.floor(pi / 2);
  const ox = col === 0 ? X0 : X0 + PW + GAPX;
  const oy = Y0 + row * (PH + GAPY);
  const vals = pts.map((p) => panel.value(p));
  const rawMax = panel.yMax ?? Math.max(...vals);
  const yMax = panel.yMax ?? Math.max(rawMax * 1.18, 1e-9);
  const ix = (t) => ox + xr(t);
  const iy = (v) => oy + PADY + (PH - PADY * 2) * (1 - v / yMax);

  // 面板背景与横向网格
  svg.push(`<rect x="${ox}" y="${oy}" width="${PW}" height="${PH}" fill="#fcfcfd" stroke="#e5e7eb"/>`);
  for (let g = 0; g <= panel.yTicks; g++) {
    const v = yMax * (1 - g / panel.yTicks);
    const y = iy(v);
    svg.push(`<line x1="${ox}" y1="${y.toFixed(1)}" x2="${ox + PW}" y2="${y.toFixed(1)}" stroke="#eef0f3"/>`);
    svg.push(`<text x="${ox - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#9ca3af" text-anchor="end">${panel.fmt(v)}</text>`);
  }
  // 面板标题（面板上方，与上一行 x 轴标题留足间距）
  svg.push(`<text x="${ox}" y="${oy - 16}" font-size="13" font-weight="600" fill="#111">${panel.title}${panel.unit ? ` (${panel.unit})` : ''}</text>`);
  // x 轴刻度与轴标题
  for (const t of ticks) {
    const x = ix(t);
    svg.push(`<line x1="${x.toFixed(1)}" y1="${oy + PH}" x2="${x.toFixed(1)}" y2="${oy + PH + 5}" stroke="#cbd5e1"/>`);
    svg.push(`<text x="${x.toFixed(1)}" y="${oy + PH + 19}" font-size="11" fill="#6b7280" text-anchor="middle">${t}</text>`);
  }
  svg.push(`<text x="${ox + PW / 2}" y="${oy + PH + 38}" font-size="13" fill="#374151" text-anchor="middle">temperature</text>`);
  // 折线
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${ix(p.temperature).toFixed(1)},${iy(panel.value(p)).toFixed(1)}`).join(' ');
  svg.push(`<path d="${path}" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linejoin="round"/>`);
  // 数据点 + 数值标签（相邻点 y 太近、或点太靠上沿时，把标签挪到点下方）
  const yList = vals.map((v) => iy(v));
  pts.forEach((p, i) => {
    const x = ix(p.temperature), y = yList[i];
    const above = (i === 0 || Math.abs(y - yList[i - 1]) >= 18) && (y - 11 > oy + 2);
    const ty = above ? y - 11 : y + 19;
    svg.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.6" fill="#fff" stroke="#1d4ed8" stroke-width="2.2"/>`);
    svg.push(`<text x="${x.toFixed(1)}" y="${ty.toFixed(1)}" font-size="11.5" fill="#1e3a8a" text-anchor="middle" font-weight="600">${panel.fmt(vals[i])}</text>`);
  });
});
svg.push(`<text x="${PAD}" y="${H - 14}" font-size="11.5" fill="#9ca3af">数据来源: ${esc(sources.map((s) => s.file).join(', '))} · 生成: plot-curve.mjs</text>`);
svg.push('</svg>');
const svgText = svg.join('\n');

// ── HTML 数据表与分布 ─────────────────────────────────────────────────────
const head = ['温度', 'n', '不同回答', '占比', '众数', '众数占比', '熵(bit)', 'TTR', '两两相似', '逐字重复对', '平均延迟(ms)'];
const rows = pts.map((s) => [
  s.temperature, s.n, s.unique, (s.uniqueRate * 100).toFixed(1) + '%',
  s.mode, (s.modeShare * 100).toFixed(1) + '%', s.entropy.toFixed(2),
  s.ttr.toFixed(3), s.pairMean.toFixed(3), s.dupRate.toFixed(3), (s.latency ?? 0).toFixed(0),
]);
const table = `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
  rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
}</tbody></table>`;

const dist = pts.map((s) => `<div class="dist"><b>T${s.temperature}</b>（${s.unique} 种）：${
  s.counts.map(([w, c]) => `<span class="chip">${esc(w)}<i>×${c}</i></span>`).join('')
}</div>`).join('');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>deepseek-flash 温度曲线（thinking disabled）</title>
<style>
 body{margin:0;padding:28px 32px 48px;background:#f6f7f9;color:#111;
      font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
 h1{font-size:20px;margin:0 0 6px}
 .sub{color:#666;font-size:13px;margin-bottom:18px}
 .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:18px;overflow-x:auto}
 table{border-collapse:collapse;font-size:13px;width:100%}
 th,td{border-bottom:1px solid #eef0f3;padding:7px 10px;text-align:right;white-space:nowrap}
 th:first-child,td:first-child,th:nth-child(5),td:nth-child(5){text-align:left}
 th{background:#fafbfc;color:#374151;font-weight:600}
 .dist{font-size:13px;line-height:2.1;border-bottom:1px dashed #eef0f3;padding:6px 0}
 .dist:last-child{border-bottom:none}
 .chip{display:inline-block;background:#eef2ff;color:#1e3a8a;border-radius:6px;padding:1px 7px;margin:2px 4px 2px 0}
 .chip i{font-style:normal;color:#6366f1;margin-left:4px}
 svg{max-width:100%;height:auto}
</style></head><body>
<h1>deepseek-flash 温度曲线（thinking: disabled）</h1>
<div class="sub">model=${esc(cfg0.MODEL ?? 'deepseek-flash')} · thinking=${esc(cfg0.thinking ?? 'disabled')} · 每档 n=${esc(String(cfg0.N ?? 50))} · 同题同 prompt · 数据: ${esc(sources.map((s) => s.file).join(', '))}</div>
<div class="card">${svgText}</div>
<div class="card">${table}</div>
<div class="card">${dist}</div>
</body></html>`;

await writeFile(join(DIR, `${OUT_PREFIX}.svg`), svgText);
await writeFile(join(DIR, `${OUT_PREFIX}.html`), html);
console.log(`曲线点: ${pts.map((p) => p.temperature).join(', ')}  （${pts.length} 档）`);
console.log(`已写入 ${OUT_PREFIX}.svg（矢量图）与 ${OUT_PREFIX}.html（图 + 数据表）`);
