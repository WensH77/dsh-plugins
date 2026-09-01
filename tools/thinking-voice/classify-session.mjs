#!/usr/bin/env node
/**
 * 单会话块首语态判定（现场分析用）
 *
 * 用法:
 *   node tools/thinking-voice/classify-session.mjs <session-id 或 会话目录路径>
 *
 * 例:
 *   node tools/thinking-voice/classify-session.mjs session-44eb6ec2
 *   node tools/thinking-voice/classify-session.mjs ~/.dsh/sessions/--Users-...--/session-xxx/
 *
 * 输出: 每个思考块的序号 + 语态分类 + 块首片段; 以及会话级汇总。
 * 分类口径与 analyze.mjs 一致: 剥离话语标记(now/ok/so...)后判前缀
 *   we need / need to → spec; let me → react; i need/i'll → 第一人称规划; 其余 other
 */
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node classify-session.mjs <session-id 或 目录>');
  process.exit(1);
}
const ROOT = path.join(homedir(), '.dsh', 'sessions');
let file;
if (arg.includes('/')) {
  file = path.join(arg, 'session.jsonl.zstd');
} else {
  file = execSync(`find "${ROOT}" -type d -path "*${arg}*" | head -1`).toString().trim();
  if (!file) { console.error(`未找到会话: ${arg}`); process.exit(1); }
  file = path.join(file, 'session.jsonl.zstd');
}
if (!file || !file.endsWith('.zstd')) { console.error(`不是 zstd 会话文件: ${file}`); process.exit(1); }

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

const raw = execSync(`zstd -dc "${file}" 2>/dev/null`, { maxBuffer: 1 << 30 }).toString();
const L = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 19);
const cnt = { 'we-need': 0, 'need-to': 0, 'let-me': 0, 'i-need': 0, other: 0 };
let i = 0;
console.log(`会话: ${file.split('/').slice(-2, -1)[0]}\n`);
for (const line of raw.split('\n')) {
  if (!line) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'assistant/message') {
    const c = o.data?.message?.content;
    if (!Array.isArray(c)) continue;
    const t = c.filter((x) => x?.type === 'reasoning' && typeof x.text === 'string').map((x) => x.text).join('\n');
    if (t.trim().length < 40) continue;
    i++;
    const head = t.trim().slice(0, 110).replace(/\s+/g, ' ');
    const k = classify(head);
    cnt[k]++;
    console.log(`[${String(i).padStart(3)}|${k.padEnd(8)}|${L(o.time)}] ${head}`);
  }
}
const spec = cnt['we-need'] + cnt['need-to'];
const lm = cnt['let-me'];
console.log(`\n=== 汇总: 思考块 ${i} | spec 开口 ${spec} (${i ? ((spec / i) * 100).toFixed(0) : 0}%) | let me ${lm} | i-need ${cnt['i-need']} | other ${cnt.other} ===`);
