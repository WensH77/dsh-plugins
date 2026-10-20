#!/usr/bin/env node
// 历史会话导出层：把 ~/.dsh/sessions 下的会话日志导出成只含真人提问和 assistant 正文的 JSON。
// 只依赖 Node 内置模块和系统的 zstd 命令。
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const FILE_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/;
// v4 把 eventCount 改成日志里所有合法事件的条数（v3 是消息数），并补 messageCount。
// schema 变更会让旧 state.json 整体失效，从而全量重导一次（否则旧导出文件会一直沿用旧口径）。
const SCHEMA = 'dsh-session-export/4';
// 只认 shell 类工具结果尾部的 exit code 标记；非零才算错。刻意不做 error 关键词匹配。
const EXIT_CODE_ERROR_RE = /\[status: [^\]]*exit code: [1-9]\d*\]/;

const USAGE = `用法: node export-sessions.mjs [选项]

  --root <dir>              会话日志根目录，默认 $DSH_HOME/sessions 或 ~/.dsh/sessions
  --out <dir>               输出目录，默认 ~/.dsh/memory-export（不允许位于 --root 内）
  --since <ISO日期|N天>      只导出 session.createdAt 不早于该时间的会话，例如 2026-09-01 或 30d
  --session <id或前缀>       只导出匹配的一个会话
  --limit <N>               最多处理 N 个文件（按文件 mtime 从新到旧）
  --jobs <N>                并发数，默认 6
  --include-subagents       包含子代理会话（默认跳过）；子代理会话里所有 user 消息
                            都是上游代理写的（任务书/中继/多轮指令），统一导出为
                            role: "task-brief"
  --include-unknown-source  把没有 source 字段的 user/message 也当真人输入（默认排除并计数）
  --include-tool-errors     收集错误类 tool/result 为 role: "tool-error"（默认开启）
  --no-tool-errors          不收集 tool/result，回到旧行为
  --tool-error-max-chars <N> 单条 tool-error 文本上限，默认 1500
  --force                   忽略增量状态，全部重导
  --dry-run                 只解析统计，不写任何文件
  -h, --help                显示本帮助
`;

function fail(msg, code = 2) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    root: null,
    out: join(homedir(), '.dsh', 'memory-export'),
    since: null,
    session: null,
    limit: Infinity,
    jobs: 6,
    includeSubagents: false,
    includeUnknownSource: false,
    includeToolErrors: true,
    toolErrorMaxChars: 1500,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (name) => {
      const v = argv[++i];
      if (v === undefined) fail(`${name} 缺少参数值`);
      return v;
    };
    switch (arg) {
      case '--root': opts.root = value(arg); break;
      case '--out': opts.out = value(arg); break;
      case '--since': opts.since = value(arg); break;
      case '--session': opts.session = value(arg); break;
      case '--limit': {
        const n = Number(value(arg));
        if (!Number.isInteger(n) || n < 0) fail('--limit 需为非负整数');
        opts.limit = n;
        break;
      }
      case '--jobs': {
        const n = Number(value(arg));
        if (!Number.isInteger(n) || n < 1 || n > 64) fail('--jobs 需为 1..64 的整数');
        opts.jobs = n;
        break;
      }
      case '--include-subagents': opts.includeSubagents = true; break;
      case '--include-unknown-source': opts.includeUnknownSource = true; break;
      case '--include-tool-errors': opts.includeToolErrors = true; break;
      case '--no-tool-errors': opts.includeToolErrors = false; break;
      case '--tool-error-max-chars': {
        const n = Number(value(arg));
        if (!Number.isInteger(n) || n < 1 || n > 1000000) fail('--tool-error-max-chars 需为 1..1000000 的整数');
        opts.toolErrorMaxChars = n;
        break;
      }
      case '--force': opts.force = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': process.stdout.write(USAGE); process.exit(0); break;
      default: fail(`未知选项: ${arg}`);
    }
  }
  return opts;
}

function parseSince(raw) {
  const s = String(raw).trim();
  const days = /^(\d+)d$/.exec(s);
  if (days) return Date.now() - Number(days[1]) * 86400000;
  if (/^\d+$/.test(s)) return Date.now() - Number(s) * 86400000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`--since 无法解析: ${raw}`);
  return t;
}

function relPosix(root, file) {
  return relative(root, file).split(sep).join('/');
}

function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`无法读取目录 ${dir}: ${err.message}`);
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile() && FILE_RE.test(ent.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// 以流的方式打开一个会话日志（zstd 压缩或纯 JSONL）。
function openStream(file) {
  if (file.endsWith('.zstd')) {
    return spawn('zstd', ['-dc', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return spawn('cat', ['--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// 只读到 session 头就结束，用于去重和子代理判定。
function readHeader(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = openStream(file);
    } catch (err) {
      rejectPromise(new Error(`无法启动解压: ${err.message}`));
      return;
    }
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      fn(val);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev && ev.type === 'session') {
          finish(resolvePromise, ev);
          return;
        }
      }
      if (buf.length > 8 * 1024 * 1024) {
        finish(rejectPromise, new Error('前 8MB 内没有 session 头'));
      }
    });
    child.stdout.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(rejectPromise, new Error(`启动 zstd 失败: ${err.message}`)));
    child.on('close', (code) => {
      if (done) return;
      if (buf.trim()) {
        try {
          const ev = JSON.parse(buf);
          if (ev && ev.type === 'session') {
            finish(resolvePromise, ev);
            return;
          }
        } catch { /* 忽略残缺的末行 */ }
      }
      const hint = stderr.trim().split('\n')[0];
      finish(rejectPromise, new Error(`没有 session 头（zstd exit ${code}）${hint ? ': ' + hint : ''}`));
    });
  });
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// 全量解析一个会话文件，只提取真人提问、assistant 正文，以及错误类的工具结果。
function parseSession(file, options) {
  const { includeUnknownSource, includeToolErrors, toolErrorMaxChars, markTaskBrief } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = openStream(file);
    } catch (err) {
      rejectPromise(new Error(`无法启动解压: ${err.message}`));
      return;
    }
    let buf = '';
    let stderr = '';
    let settled = false;
    let header = null;
    let lines = 0;
    let badLines = 0;
    let unknownSource = 0;
    let seqFallback = 0;
    let lastTime = null;
    let lastEventTime = null;
    let lastEventType = null;
    let eventCount = 0;
    let toolErrorMessages = 0;
    let toolErrorChars = 0;
    const messages = [];
    // tool/call 的 callId → 工具名，供后面的 tool/result 反查。
    const toolNames = new Map();

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const stamp = (ev) => {
      const seq = Number.isFinite(ev.seq) ? ev.seq : seqFallback++;
      const time = Number.isFinite(ev.time)
        ? ev.time
        : (lastTime != null ? lastTime : (Number.isFinite(header?.createdAt) ? header.createdAt : 0));
      lastTime = time;
      return { seq, time };
    };

    const push = (role, text, ev) => {
      const t = text.trim();
      if (!t) return;
      const { seq, time } = stamp(ev);
      messages.push({ seq, time, role, text: t });
    };

    // 三条判据任一成立即为错误类结果；不匹配泛化的 error 关键词。
    // 老格式把 isError 放在外层的 tool-result 块里，这里一并认。
    const isErrorResult = (data, wrapped, text) => {
      if (data.error != null) return true;
      if (data.message?.isError === true) return true;
      if (wrapped?.isError === true) return true;
      return EXIT_CODE_ERROR_RE.test(text);
    };

    const pushToolError = (rawText, callId, error, ev) => {
      const raw = rawText.trim();
      if (!raw) return;
      const { seq, time } = stamp(ev);
      const truncated = raw.length > toolErrorMaxChars;
      const msg = { seq, time, role: 'tool-error', tool: null, text: truncated ? raw.slice(0, toolErrorMaxChars) : raw };
      if (callId && toolNames.has(callId)) msg.tool = toolNames.get(callId);
      if (truncated) msg.truncated = true;
      if (error != null) {
        msg.error = {
          name: error && typeof error === 'object' && error.name != null ? error.name : null,
          code: error && typeof error === 'object' && error.code != null ? error.code : null,
        };
      }
      messages.push(msg);
      toolErrorMessages++;
      toolErrorChars += msg.text.length;
    };

    // 日志每行顶层形如 {"type":...,"seq":...,"time":...}，data 里也可能出现同名字段，
    // 所以只在 "data" 之前（顶层）找 time / type。这里扫所有事件，不受下面的抽取过滤影响。
    // eventCount 数同时带顶层 type 和 time 的行，包含所有事件类型；成功 tool/result、
    // step/start、session-log-* 等虽然不会进 messages，但都会让 eventCount 增长。
    const observeTopLevelEvent = (line) => {
      const dataAt = line.indexOf('"data"');
      const head = dataAt === -1 ? line : line.slice(0, dataAt);
      const tm = /"time":\s*(-?\d+(?:\.\d+)?)/.exec(head);
      if (!tm) return;
      const time = Number(tm[1]);
      if (!Number.isFinite(time)) return;
      const ty = /"type":"([^"\\]*)"/.exec(head);
      if (ty) eventCount++;
      if (lastEventTime == null || time >= lastEventTime) {
        lastEventTime = time;
        lastEventType = ty ? ty[1] : null;
      }
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      observeTopLevelEvent(line);
      lines++;
      // 绝大多数行是 tool/result、chunk 等无关事件，先用子串跳过，避免解析大行。
      if (!line.includes('"type":"session"')
        && !line.includes('"user/message"')
        && !line.includes('"assistant/message"')
        && !(includeToolErrors
          && (line.includes('"tool/result"') || line.includes('"tool/call"')))) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        badLines++;
        return;
      }
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'session') {
        if (!header) header = ev;
        return;
      }
      if (ev.type === 'user/message') {
        const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
        const kind = data.source && typeof data.source === 'object' ? data.source.kind : undefined;
        if (kind === 'user') {
          push('user', blockText(data.content), ev);
        } else if (kind === undefined) {
          unknownSource++;
          if (includeUnknownSource) push('user', blockText(data.content), ev);
        }
        return;
      }
      if (ev.type === 'assistant/message') {
        const content = ev.data?.message?.content;
        push('assistant', blockText(content), ev);
        return;
      }
      if (includeToolErrors && ev.type === 'tool/call') {
        const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
        if (typeof d.callId === 'string') {
          toolNames.set(d.callId, typeof d.name === 'string' ? d.name : null);
        }
        return;
      }
      if (includeToolErrors && ev.type === 'tool/result') {
        const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
        const content = d.message?.content;
        // 新格式：content 直接是 text 块；老格式：外面再包一层 {type:'tool-result', content:[...]}。
        const wrapped = Array.isArray(content)
          ? content.find((b) => b && b.type === 'tool-result')
          : null;
        const top = blockText(content);
        const text = top.trim() ? top : blockText(wrapped?.content);
        const callId = typeof d.message?.toolCallId === 'string'
          ? d.message.toolCallId
          : (typeof wrapped?.toolCallId === 'string'
            ? wrapped.toolCallId
            : (typeof d.message?.source?.callId === 'string' ? d.message.source.callId : null));
        if (isErrorResult(d, wrapped, text)) pushToolError(text, callId, d.error, ev);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stdout.on('error', (err) => settle(rejectPromise, new Error(`读取失败: ${err.message}`)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => settle(rejectPromise, new Error(`启动 zstd 失败: ${err.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (buf.length) handleLine(buf);
      if (!header) {
        const hint = stderr.trim().split('\n')[0];
        settle(rejectPromise, new Error(`没有 session 头（zstd exit ${code}）${hint ? ': ' + hint : ''}`));
        return;
      }
      // 子代理会话里没有真人用户：所有 user 消息（任务书、[中继答案]、多轮指令）都是上游代理写的，
      // 日志里 source.kind 仍是 'user'。开启 --include-subagents 导出时全部标成 task-brief，
      // 蒸馏就不会把它们当成用户需求。只动这一类会话，普通会话的消息角色完全不变。
      if (markTaskBrief && isSubagent(header)) {
        for (const brief of messages) {
          if (brief.role === 'user') brief.role = 'task-brief';
        }
      }
      let userChars = 0;
      let assistantChars = 0;
      for (const m of messages) {
        // task-brief 是用户侧输入，字符量仍计入 userChars，避免子代理会话的转录密度统计失真。
        if (m.role === 'user' || m.role === 'task-brief') userChars += m.text.length;
        else if (m.role === 'assistant') assistantChars += m.text.length;
      }
      settle(resolvePromise, {
        header,
        messages,
        userChars,
        assistantChars,
        toolErrorMessages,
        toolErrorChars,
        events: lines,
        eventCount,
        badLines,
        unknownSource,
        zstdExit: code,
        stderr: stderr.trim(),
        lastEventTime,
        lastEventType,
      });
    });
  });
}

async function pool(items, limit, worker) {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function sessionFileName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
}

function isSubagent(header) {
  return header.origin === 'subagent'
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0);
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += dirSize(p);
    else {
      try { total += statSync(p).size; } catch { /* 忽略 */ }
    }
  }
  return total;
}

async function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(opts.root ?? (process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'sessions')
    : join(homedir(), '.dsh', 'sessions')));
  const outDir = resolve(opts.out);
  const sinceMs = opts.since != null ? parseSince(opts.since) : null;

  if (!existsSync(root)) fail(`会话目录不存在: ${root}`);
  if (!opts.dryRun && isInside(root, outDir)) {
    fail(`拒绝写入会话目录内部: ${outDir} 位于 ${root} 之内`);
  }
  if (opts.session && !opts.session.trim()) fail('--session 不能为空');

  const sessionsOut = join(outDir, 'sessions');
  const manifestPath = join(outDir, 'manifest.jsonl');
  const statePath = join(outDir, 'state.json');

  let files = collectFiles(root);
  if (opts.session) files = files.filter((f) => relPosix(root, f).includes(opts.session));
  if (!files.length) {
    process.stderr.write(`没有匹配的会话文件（root=${root}${opts.session ? `, session=${opts.session}` : ''}）\n`);
    process.exitCode = 1;
    return;
  }
  const stats = new Map();
  for (const f of files) {
    try { stats.set(f, statSync(f)); } catch { /* 忽略，后面会失败 */ }
  }
  files = files.filter((f) => stats.has(f));
  files.sort((a, b) => {
    const ma = stats.get(a).mtimeMs;
    const mb = stats.get(b).mtimeMs;
    if (mb !== ma) return mb - ma;
    return relPosix(root, a) < relPosix(root, b) ? -1 : 1;
  });
  if (opts.limit < files.length) files = files.slice(0, opts.limit);

  const needsZstd = files.some((f) => f.endsWith('.zstd'));
  if (needsZstd) {
    const probe = spawnSync('zstd', ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) fail('找不到可用的 zstd 命令');
  }

  let state = { schema: SCHEMA, updatedAt: null, byFile: {} };
  if (!opts.force && existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.byFile && typeof parsed.byFile === 'object') {
        if (parsed.schema === SCHEMA) {
          state = { schema: SCHEMA, updatedAt: parsed.updatedAt ?? null, byFile: parsed.byFile };
        } else {
          // 抽取逻辑改了但 mtime 没变，旧状态会一直命中 unchanged，所以整份忽略、全部重导。
          process.stderr.write(`[warn] state.json schema=${parsed.schema ?? '(缺失)'} 与当前 ${SCHEMA} 不符，忽略增量状态并全量重导\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[warn] state.json 无法解析，按空状态处理: ${err.message}\n`);
    }
  }

  if (!opts.dryRun) {
    mkdirSync(sessionsOut, { recursive: true });
    mkdirSync(outDir, { recursive: true });
  }

  const records = files.map((file) => ({
    file,
    rel: relPosix(root, file),
    st: stats.get(file),
    id: null,
    header: null,
    fromState: false,
    isWinner: true,
    status: null,
    messages: 0,
    userChars: 0,
    assistantChars: 0,
    toolErrorMessages: 0,
    toolErrorChars: 0,
    unknownSource: 0,
    error: null,
    note: null,
  }));

  process.stderr.write(`[export] files=${records.length} jobs=${opts.jobs} root=${root} out=${outDir}${opts.dryRun ? ' (dry-run)' : ''}\n`);

  // 第一遍：读 session 头，判定增量、子代理与重名文件。
  let scanned = 0;
  await pool(records, opts.jobs, async (rec) => {
    const entry = state.byFile?.[rec.rel];
    const outFile = entry?.sessionId ? join(sessionsOut, sessionFileName(entry.sessionId)) : null;
    // --since 需要看 createdAt，--include-subagents 需要重看之前被跳过的子代理，这两种情况不信任增量状态。
    const stateAllowed = sinceMs == null && !(opts.includeSubagents && entry?.status === 'skipped_subagent');
    // 只有 exported 才算有产物文件；skipped_* 本来就不写文件，不能用"目标文件存在"拦掉。
    const hasOutput = entry?.status === 'exported' ? Boolean(outFile && existsSync(outFile)) : true;
    const fresh = stateAllowed
      && !opts.force
      && entry
      && entry.status !== 'failed'
      && entry.sessionId
      && entry.bytes === rec.st.size
      && entry.mtimeMs === Math.floor(rec.st.mtimeMs)
      && hasOutput;
    if (fresh) {
      rec.fromState = true;
      rec.id = entry.sessionId;
      rec.status = 'unchanged';
    } else {
      try {
        rec.header = await readHeader(rec.file);
        rec.id = typeof rec.header.id === 'string' && rec.header.id ? rec.header.id : basename(dirname(rec.file));
      } catch (err) {
        rec.status = 'failed';
        rec.error = err.message;
        process.stderr.write(`[failed] ${rec.rel}: ${err.message}\n`);
      }
    }
    scanned++;
    if (scanned % 100 === 0 || scanned === records.length) {
      process.stderr.write(`[scan] ${scanned}/${records.length}\n`);
    }
  });

  // --session 可能只是路径碰巧匹配，按真实 session id 再过滤一次。
  if (opts.session) {
    const needle = opts.session;
    for (const rec of records) {
      if (rec.id && !String(rec.id).startsWith(needle)) {
        rec.status = 'dropped';
      }
    }
    const kept = records.filter((r) => r.status !== 'dropped');
    if (!kept.length) {
      process.stderr.write(`没有匹配的会话（session=${needle}）\n`);
      process.exitCode = 1;
      return;
    }
    records.length = 0;
    records.push(...kept);
  }

  // 同一 session id 出现在多个格式文件里时，只导出 mtime 最新的那份。
  const byId = new Map();
  for (const rec of records) {
    if (!rec.id) continue;
    if (!byId.has(rec.id)) byId.set(rec.id, []);
    byId.get(rec.id).push(rec);
  }
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const ma = a.st.mtimeMs;
      const mb = b.st.mtimeMs;
      if (mb !== ma) return mb - ma;
      const va = Number(a.header?.version ?? -1);
      const vb = Number(b.header?.version ?? -1);
      if (vb !== va) return vb - va;
      return a.rel < b.rel ? -1 : 1;
    });
    for (let i = 1; i < group.length; i++) group[i].isWinner = false;
  }

  const manifestLines = [];
  const recordResult = (rec, status, extra = {}) => {
    rec.status = status;
    const line = {
      id: rec.id ?? null,
      status,
      sourceFile: rec.rel,
      sourceBytes: rec.st.size,
      sourceMtimeMs: Math.floor(rec.st.mtimeMs),
      messages: rec.messages,
      userChars: rec.userChars,
      assistantChars: rec.assistantChars,
      exportedAt: new Date().toISOString(),
    };
    if (rec.unknownSource) line.unknownSource = rec.unknownSource;
    if (rec.error) line.error = rec.error;
    if (extra.note) line.note = extra.note;
    manifestLines.push(JSON.stringify(line));
    if (!opts.dryRun && rec.id && status !== 'failed') {
      state.byFile[rec.rel] = {
        bytes: rec.st.size,
        mtimeMs: Math.floor(rec.st.mtimeMs),
        sessionId: rec.id,
        status,
      };
    }
  };

  // 第二遍：导出胜出的文件。
  let processed = 0;
  await pool(records, opts.jobs, async (rec) => {
    if (rec.status === 'failed') {
      recordResult(rec, 'failed');
      processed++;
      return;
    }
    if (rec.fromState) {
      rec.status = 'unchanged';
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }
    if (!rec.isWinner) {
      recordResult(rec, 'unchanged', { note: 'duplicate session id, newer file exported' });
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }
    if (rec.header && isSubagent(rec.header) && !opts.includeSubagents) {
      recordResult(rec, 'skipped_subagent');
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }
    if (sinceMs != null) {
      const created = rec.header?.createdAt ?? rec.header?.created_at;
      if (Number.isFinite(created) && created < sinceMs) {
        recordResult(rec, 'skipped_old');
        processed++;
        if (processed % 100 === 0 || processed === records.length) {
          process.stderr.write(`[export] ${processed}/${records.length}\n`);
        }
        return;
      }
    }

    let parsed;
    try {
      parsed = await parseSession(rec.file, {
        includeUnknownSource: opts.includeUnknownSource,
        includeToolErrors: opts.includeToolErrors,
        toolErrorMaxChars: opts.toolErrorMaxChars,
        markTaskBrief: opts.includeSubagents,
      });
    } catch (err) {
      rec.error = err.message;
      recordResult(rec, 'failed');
      process.stderr.write(`[failed] ${rec.rel}: ${err.message}\n`);
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }

    const header = parsed.header;
    rec.id = typeof header.id === 'string' && header.id ? header.id : rec.id;
    rec.messages = parsed.messages.length;
    rec.userChars = parsed.userChars;
    rec.assistantChars = parsed.assistantChars;
    rec.toolErrorMessages = parsed.toolErrorMessages;
    rec.toolErrorChars = parsed.toolErrorChars;
    rec.unknownSource = parsed.unknownSource;
    if (parsed.zstdExit !== 0 && parsed.messages.length === 0) {
      rec.note = `zstd exit ${parsed.zstdExit}${parsed.stderr ? ': ' + parsed.stderr.split('\n')[0] : ''}`;
    }

    if (isSubagent(header) && !opts.includeSubagents) {
      recordResult(rec, 'skipped_subagent');
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }
    if (sinceMs != null && Number.isFinite(header.createdAt) && header.createdAt < sinceMs) {
      recordResult(rec, 'skipped_old');
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }
    // 子代理会话只有 task-brief、没有真人 user 消息也算有效导出。
    if (!parsed.messages.some((m) => m.role === 'user' || m.role === 'task-brief')) {
      recordResult(rec, 'skipped_no_user');
      processed++;
      if (processed % 100 === 0 || processed === records.length) {
        process.stderr.write(`[export] ${processed}/${records.length}\n`);
      }
      return;
    }

    const doc = {
      schema: SCHEMA,
      session: {
        id: rec.id,
        cwd: header.cwd ?? null,
        createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
        // 归档判定用：日志里所有事件 time 的最大值。没有任何事件带 time 时退回 createdAt。
        lastEventTime: parsed.lastEventTime
          ?? (Number.isFinite(header.createdAt) ? header.createdAt : null),
        // 版本口径：日志里所有带顶层 type + time 的事件行（含 tool/result、step/start 等）。
        eventCount: parsed.eventCount,
        // 消息口径：导出的 user/assistant/tool-error 条数，与 stats.messages 相同。
        messageCount: parsed.messages.length,
        lastEventType: parsed.lastEventType ?? null,
        parentSession: header.parentSession ?? null,
        origin: header.origin ?? null,
        delegationDepth: Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0,
        agentPreset: header.agentPreset ?? null,
        formatVersion: Number.isFinite(header.version) ? header.version : null,
        sourceFile: rec.rel,
        sourceBytes: rec.st.size,
        sourceMtimeMs: Math.floor(rec.st.mtimeMs),
      },
      stats: {
        events: parsed.events,
        messages: parsed.messages.length,
        userChars: parsed.userChars,
        assistantChars: parsed.assistantChars,
        toolErrorMessages: parsed.toolErrorMessages,
        toolErrorChars: parsed.toolErrorChars,
      },
      messages: parsed.messages,
    };
    if (!opts.dryRun) {
      atomicWrite(join(sessionsOut, sessionFileName(rec.id)), JSON.stringify(doc));
    }
    recordResult(rec, 'exported');
    processed++;
    if (processed % 100 === 0 || processed === records.length) {
      process.stderr.write(`[export] ${processed}/${records.length}\n`);
    }
  });

  if (!opts.dryRun && manifestLines.length) {
    appendFileSync(manifestPath, manifestLines.map((l) => l + '\n').join(''));
  }
  if (!opts.dryRun) {
    state.schema = SCHEMA;
    state.updatedAt = Date.now();
    atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n');
  }

  const summary = {
    files: records.length,
    exported: 0,
    skippedSubagent: 0,
    skippedNoUser: 0,
    failed: 0,
    unchanged: 0,
    messages: 0,
    userChars: 0,
    assistantChars: 0,
    outputBytes: 0,
    elapsedMs: 0,
    outDir,
  };
  let skippedOld = 0;
  let toolErrorMessages = 0;
  let toolErrorChars = 0;
  for (const rec of records) {
    if (rec.status === 'exported') {
      summary.exported++;
      summary.messages += rec.messages;
      summary.userChars += rec.userChars;
      summary.assistantChars += rec.assistantChars;
      toolErrorMessages += rec.toolErrorMessages;
      toolErrorChars += rec.toolErrorChars;
    } else if (rec.status === 'skipped_subagent') summary.skippedSubagent++;
    else if (rec.status === 'skipped_no_user') summary.skippedNoUser++;
    else if (rec.status === 'skipped_old') skippedOld++;
    else if (rec.status === 'unchanged') summary.unchanged++;
    else if (rec.status === 'failed') summary.failed++;
  }
  if (skippedOld) process.stderr.write(`[export] skipped_old=${skippedOld}\n`);
  // stdout 汇总保持原来 12 个字段，tool-error 计数走 stderr。
  if (opts.dryRun || !opts.includeToolErrors || toolErrorMessages > 0) {
    process.stderr.write(`[export] tool_errors=${toolErrorMessages} tool_error_chars=${toolErrorChars}`
      + ` (newly exported${opts.includeToolErrors ? '' : ', --no-tool-errors'})\n`);
  }
  if (!opts.dryRun) {
    // outDir 里只有 sessions/、manifest.jsonl、state.json，整目录就是产物体量。
    summary.outputBytes = dirSize(outDir);
  }
  summary.elapsedMs = Date.now() - t0;
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
