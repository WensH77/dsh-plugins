#!/usr/bin/env node
/**
 * thinking-voice 分析器
 *
 * 全库抽取 reasoning 块 → 块首语态分类 → 按会话/按日聚合。
 * 只输出聚合统计与块首片段，不输出对话正文原文。
 *
 * 用法:
 *   node tools/thinking-voice/analyze.mjs            # 全量分析
 *   node tools/thinking-voice/analyze.mjs --head 5   # 打印前 5 个 spec 开口的块首片段
 *   node tools/thinking-voice/analyze.mjs --root ~/.dsh/sessions
 *
 * 依赖: node >= 18, zstd CLI。会话日志为 zstd 压缩 JSONL。
 */
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.join(homedir(), '.dsh', 'sessions');
const HEAD = process.argv.includes('--head')
  ? Number(process.argv[process.argv.indexOf('--head') + 1])
  : 0;

/** 剥离话语标记后判块首语态 */
const FILLER = /^(?:now|ok|okay|so|alright|all right|good|great|right|well|hmm+|then|actually|first|next|finally|indeed|yes|no|wait|but|and|however|perfect|excellent|interesting|confirmed|done)\b[\s,.:;!—–-]*/i;
function classify(head) {
  let t = head.replace(/^[\s>*#`\-–—"'\u201c\u2018\u3010\u3001]+/, '').replace(/[\u2018\u2019]/g, "'");
  for (let i = 0; i < 4; i++) {
    const u = t.replace(FILLER, '');
    if (u === t) break;
    t = u;
  }
  if (/^we need\b/i.test(t)) return 'we-need';
  if (/^need to\b/i.test(t)) return 'need-to';
  if (/^let me\b/i.test(t)) return 'let-me';
  if (/^i (?:need|should|must|'ll|will)\b/i.test(t)) return 'i-need';
  return 'other';
}

const files = execSync(`find "${ROOT}" -name 'session.jsonl.zstd'`).toString().split('\n').filter(Boolean);
console.log(`扫描会话日志: ${ROOT} → ${files.length} 个文件\n`);

const days = {};
const specBlocks = [];
let N = 0;
for (const f of files) {
  let raw;
  try { raw = execSync(`zstd -dc "${f}" 2>/dev/null`, { maxBuffer: 1 << 30 }).toString(); }
  catch { continue; }
  let hdr = null;
  try { hdr = JSON.parse(raw.split('\n')[0]); } catch { continue; }
  const t0 = hdr.createdAt;
  const day = new Date(t0).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const d = days[day] ??= { n: 0, 'we-need': 0, 'need-to': 0, 'let-me': 0, other: 0, iNeed: 0, specBlocks: [] };

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant/message') continue;
    const c = o.data?.message?.content;
    if (!Array.isArray(c)) continue;
    const t = c.filter((x) => x?.type === 'reasoning' && typeof x.text === 'string').map((x) => x.text).join('\n');
    if (t.trim().length < 40) continue;
    N++;
    d.n++;
    const head = t.trim().slice(0, 90).replace(/\s+/g, ' ');
    const k = classify(head);
    d[k] = (d[k] ?? 0) + 1;
    if (k === 'we-need' || k === 'need-to') {
      d.specBlocks.push({ t: o.time, head, file: f.split('/').slice(-2, -1)[0] });
      specBlocks.push({ t: o.time, head, file: f.split('/').slice(-2, -1)[0] });
    }
  }
}

console.log(`思考块总数: ${N}\n`);
console.log('=== 块首语态总分布 ===');
const tot = {};
for (const d of Object.values(days)) for (const k of ['we-need', 'need-to', 'let-me', 'i-need', 'other']) tot[k] = (tot[k] ?? 0) + (d[k] ?? 0);
for (const k of ['we-need', 'need-to', 'let-me', 'i-need', 'other'])
  console.log(`  ${k.padEnd(8)} ${String(tot[k] ?? 0).padStart(6)}  ${(((tot[k] ?? 0) / N) * 100).toFixed(2)}%`);

console.log('\n=== 按日: spec 开口(we need + need to) vs let me ===');
for (const [day, d] of Object.entries(days).sort()) {
  const spec = (d['we-need'] ?? 0) + (d['need-to'] ?? 0);
  const lm = d['let-me'] ?? 0;
  const pct = d.n ? ((spec / d.n) * 100).toFixed(1) : '-';
  console.log(`  ${day}  spec=${String(spec).padStart(4)}  letme=${String(lm).padStart(5)}  spec占块=${pct.padStart(5)}%  (${d.n} 块)`);
}

if (HEAD > 0) {
  console.log(`\n=== 最早的 ${HEAD} 个 spec 开口块 ===`);
  specBlocks.sort((a, b) => a.t - b.t).slice(0, HEAD).forEach((b) => {
    const ts = new Date(b.t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
    console.log(`  [${ts}] ${b.head}`);
  });
}
