// dsh-plugin-context-xray — 离线入口。
//
// 直接读会话 jsonl（zstd 压缩），跑提及归因，打印与 context_xray 工具相同的
// markdown 报告。用于上下文_xray 工具够不着的场景：扫历史会话、批量对比。
//
// 用法：
//   node tools/xray.mjs                      # 最近一个会话
//   node tools/xray.mjs <会话id前缀>          # 指定会话
//   node tools/xray.mjs <文件.jsonl.zstd>     # 直接给文件
//   node tools/xray.mjs --workspace dsh-plugins
//   node tools/xray.mjs --json               # 原始 JSON（喂给别的程序）

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeMentions } from '../lib/mention.js';
import { renderReport } from '../lib/render.js';

const SESSIONS = join(homedir(), '.dsh', 'sessions');

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { target: '', workspace: '', json: false, matrix: 10, limit: 12, minTerms: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') out.json = true;
    else if (arg === '--workspace') out.workspace = argv[++index] ?? '';
    else if (arg === '--matrix') out.matrix = Number(argv[++index] ?? 10);
    else if (arg === '--limit') out.limit = Number(argv[++index] ?? 12);
    else if (arg === '--min-terms') out.minTerms = Number(argv[++index] ?? 20);
    else if (out.target === '') out.target = arg;
  }
  return out;
}

/** 定位要分析的会话文件：显式路径优先，否则在会话目录里按修改时间取最近一个。 */
function locate(args) {
  if (args.target.endsWith('.jsonl') || args.target.endsWith('.zstd')) return { path: args.target, id: args.target };
  const candidates = [];
  for (const workspace of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    if (args.workspace !== '' && !workspace.name.includes(args.workspace)) continue;
    const base = join(SESSIONS, workspace.name);
    for (const session of readdirSync(base, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      if (args.target !== '' && !session.name.includes(args.target)) continue;
      const file = join(base, session.name, 'session.v3.jsonl.zstd');
      try {
        candidates.push({ path: file, id: session.name, mtime: statSync(file).mtimeMs });
      } catch {
        // 没有日志的会话目录跳过。
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error('没有匹配的会话日志');
  return candidates[0];
}

/** 读事件流，兼容压缩与明文。 */
function readEvents(path) {
  const raw = path.endsWith('.zstd') ? execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString() : readFileSync(path, 'utf8');
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const args = parseArgs(process.argv.slice(2));
const file = locate(args);
const events = readEvents(file.path);
const report = analyzeMentions(events, { matrixTerms: args.matrix });

if (args.json) console.log(JSON.stringify({ session: file, report }, null, 2));
else console.log(renderReport(report, { limit: args.limit, matrix: args.matrix, minTerms: args.minTerms, title: file.id }));
