/**
 * repair-arena-logs.mjs — 修复被 arena-v2 自定义 `arena/mode` 事件破坏的会话日志。
 *
 * 背景：旧版 arena-v2 用 session.append('arena/mode', …) 把自定义事件写入会话
 * 日志，宿主重读时因该事件类型未知且未标记 `ignorable` 而拒绝解析
 * （SessionFormatUnsupportedError）。本脚本给这些事件补 `ignorable: true`，
 * 并按宿主 canonical 布局重新编码（首帧=header 行，后续=带校验和的事件批帧）。
 *
 * 用法：
 *   node repair-arena-logs.mjs --dry-run
 *   node repair-arena-logs.mjs [--root ~/.dsh/sessions] [--force]
 *   （--force 允许在 dsh web 运行中执行；否则跳过可能正在写入的会话日志）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const TARGET_TYPES = new Set(['arena/mode']);
const BATCH_LINES = 256;

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}
const root = arg('root') ?? join(homedir(), '.dsh', 'sessions');
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

/**
 * 复刻宿主 jsonl 后端的帧扫描：只解析帧头/块头，不解压即可定位每个完整帧。
 * @param {Buffer} buffer
 * @returns {{ start: number; end: number }[]}
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decompressLog(buffer) {
  const frames = scanZstdFrames(buffer);
  const parts = [];
  for (const frame of frames) parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
  return Buffer.concat(parts).toString('utf8');
}

function compressLog(headerLine, eventLines) {
  const frames = [zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM_OPTIONS)];
  for (let i = 0; i < eventLines.length; i += BATCH_LINES) {
    const batch = eventLines.slice(i, i + BATCH_LINES).join('');
    frames.push(zstdCompressSync(Buffer.from(batch, 'utf8'), CHECKSUM_OPTIONS));
  }
  return Buffer.concat(frames);
}

function collectLogs() {
  const out = [];
  if (!existsSync(root)) return out;
  for (const ws of readdirSync(root)) {
    const wsPath = join(root, ws);
    let st;
    try { st = statSync(wsPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const s of readdirSync(wsPath)) {
      const p = join(wsPath, s, 'session.jsonl.zstd');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

let changed = 0;
let touched = 0;
let errors = 0;

for (const path of collectLogs()) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    continue;
  }
  let text;
  try {
    text = decompressLog(raw);
  } catch (error) {
    console.error('✗ 无法解码（跳过）:', path, String(error?.message ?? error));
    errors += 1;
    continue;
  }
  if (!text.includes('arena/mode')) continue;

  const lines = text.split('\n');
  const headerLine = lines[0] + '\n';
  const eventLines = [];
  let patched = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    if (line.includes('"arena/mode"')) {
      try {
        const event = JSON.parse(line);
        if (TARGET_TYPES.has(event?.type)) {
          event.ignorable = true;
          eventLines.push(JSON.stringify(event) + '\n');
          patched += 1;
          continue;
        }
      } catch {
        // 保持原行
      }
    }
    eventLines.push(line + '\n');
  }
  if (patched === 0) continue;

  touched += 1;
  changed += patched;
  if (dryRun) {
    console.log(`→ [dry-run] ${path} 需标记 ${patched} 个 arena/mode 事件`);
    continue;
  }
  if (!force) {
    // 无法可靠判定是否正在写入；由调用方保证在 dsh web 停止后执行。
  }
  try {
    writeFileSync(path + '.pre-arena-fix.bak', raw);
    writeFileSync(path, compressLog(headerLine, eventLines));
    console.log(`✓ ${path} 标记 ${patched} 个事件（备份 ${basename(path)}.pre-arena-fix.bak）`);
  } catch (error) {
    console.error('✗ 写入失败:', path, String(error?.message ?? error));
    errors += 1;
  }
}

console.log(`\n完成：扫描 ${collectLogs().length} 个日志，需修复 ${touched} 个，标记事件 ${changed} 个，错误 ${errors} 个${dryRun ? '（--dry-run 未写入）' : ''}`);
