// dsh-plugin-chat-rollback — node half
// A Cordis plugin for the dsh web profile. Injects the session store, the agent
// factory, the workspace registry, agent presets, and the default model service,
// then serves one endpoint for the browser half:
//
//   POST /chat-rollback/rollback?session=<id>&seq=<n>
//
// Rollback to message n: the session log is cut after seq n (inclusive), and a
// NEW top-level session (no parent lineage) is created with that history as its
// seed, inheriting the source session's cwd and agent preset, joining the source
// workspace, and returning the new session id. The original session is never
// mutated — dsh sessions are append-only, so rollback means continuing from
// this point in a fresh session.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import z from '@deepseek-ai/schemastery';

const name = 'chat-rollback';
// NOTE: agentPresets is deliberately NOT injected — in the web profile the
// AgentPresets service lives outside the host realm (sessions mount presets),
// and a hard inject would stall plugin activation forever (see
// dsh-host-apiproxy, which reads it via ctx.get() and degrades gracefully).
const inject = ['webServer', 'sessions', 'agents', 'workspaceRegistry', 'agentDefaultModel'];

// All fields are optional by default in schemastery (fields are optional
// unless marked .required()).
const Config = z.object({
  // Where per-turn workspace snapshots live (default ~/.dsh/chat-rollback-snapshots).
  snapshotDir: z.string(),
  // Paths excluded from snapshots (matched against tar --exclude semantics).
  excludes: z.array(z.string()),
  // Set false to disable turn-level snapshotting entirely.
  snapshotEnabled: z.boolean(),
  // Periodic cleanup interval in ms (default 1h; 0 disables the timer). Reclaims
  // snapshots of archived sessions, non-standard sessions (arena/legacy ids that
  // no longer write snapshots), and orphaned dirs. The manual endpoint
  // POST /chat-rollback/prune-archived always works regardless.
  pruneIntervalMs: z.number()
});

const DEFAULT_EXCLUDES = ['.git', 'node_modules'];

function defaultSnapshotRoot() {
  return join(os.homedir(), '.dsh', 'chat-rollback-snapshots');
}

function runSh(cmd) {
  return new Promise((done) => {
    execFile('sh', ['-c', cmd], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: error === null, error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** shell 单引号转义（runSh 的命令体是 sh -c 字符串，排除模式必须引起来防通配符被 shell 展开）。 */
function shq(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'";
}

// ── tar --exclude 语义的忠实移植（libarchive __archive_pathmatch）────────
// bsdtar/gtar 的排除匹配（exclusion flag = PATHMATCH_NO_ANCHOR_START |
// PATHMATCH_NO_ANCHOR_END，见 libarchive archive_match.c）：
//   - 未锚定：模式在路径每个元素（/ 分隔处）逐一尝试，'^' 可锚定开头
//   - 未锚定结尾：'$' 可锚定结尾；模式耗尽时剩余 / 段被忽略（dir 匹配 dir/）
//   - '*' 跨 / 匹配任意串（尾随 '*' 恒成功），'?' 单字符，[...] 字符类
//     （'^'/'!' 取反、支持范围、'\]' 转义），'\\' 转义下一个字符
//   - 模式与路径两侧的前导 './' 都会被跳过
// 移植到 JS 是为了让 hash 清单、恢复剪枝与 tar 自身对「哪些路径被排除」的
// 判定完全一致——三者不一致时（旧实现的字面匹配 vs tar 通配），恢复剪枝会把
// tar 排除过但 JS 判定未排除的文件删掉。

const MATCH_MAX_RECURSION = 30;

/** pm_slashskip：跳过 '/', './', 结尾的 '.'（对应 C 的 pm_slashskip）。 */
function matchSlashskip(str, i) {
  while (i < str.length && (str[i] === '/' || (str[i] === '.' && (str[i + 1] === '/' || str[i + 1] === undefined)))) i += 1;
  return i;
}

/** pm_list：[...] 字符类匹配（对应 C 的 pm_list）。 */
function matchClass(p, start, end, c) {
  let i = start;
  let match = true;
  let nomatch = false;
  if (p[i] === '!' || p[i] === '^') { match = false; nomatch = true; i += 1; }
  let rangeStart = null;
  while (i < end) {
    let nextRangeStart = null;
    const ch = p[i];
    if (ch === '-') {
      if (rangeStart === null || i === end - 1) {
        if (ch === c) return match;
      } else {
        let rangeEnd = p[++i];
        if (rangeEnd === '\\') rangeEnd = p[++i];
        if (rangeStart <= c && c <= rangeEnd) return match;
      }
    } else if (ch === '\\') {
      i += 1;
      if (p[i] === c) return match;
      nextRangeStart = p[i];
    } else {
      if (ch === c) return match;
      nextRangeStart = ch;
    }
    rangeStart = nextRangeStart;
    i += 1;
  }
  return nomatch;
}

/** pm：核心 glob 匹配（对应 C 的 pm；si 为字符串起始下标，piStart 为模式
 * 起始下标——'*' 回溯递归必须从消费后的位置继续，否则同一 '*' 被反复重入）。 */
function matchPmAt(p, s, si, flags, depth, piStart = 0) {
  if (depth > MATCH_MAX_RECURSION) return -1;
  let pi = piStart;
  if (s[si] === '.' && s[si + 1] === '/') si = matchSlashskip(s, si + 1);
  if (p[pi] === '.' && p[pi + 1] === '/') pi = matchSlashskip(p, pi + 1);
  for (;;) {
    if (pi >= p.length) {
      if (s[si] === '/') {
        if (flags.noAnchorEnd) return 1;
        si = matchSlashskip(s, si);
      }
      return si >= s.length;
    }
    const ch = p[pi];
    if (ch === '?') {
      if (si >= s.length) return 0;
    } else if (ch === '*') {
      while (p[pi] === '*') pi += 1;
      if (pi >= p.length) return 1; // 尾随 '*' 恒成功
      let s2 = si;
      while (s2 < s.length) {
        const r = matchPmAt(p, s, s2, flags, depth + 1, pi);
        if (r) return r;
        s2 += 1;
      }
      return 0;
    } else if (ch === '[') {
      let end = pi + 1;
      while (end < p.length && p[end] !== ']') {
        if (p[end] === '\\' && end + 1 < p.length) end += 1;
        end += 1;
      }
      if (end < p.length && p[end] === ']') {
        // 注意：不守卫 si >= s.length——macOS 系统 libarchive（Apple 分支）
        // 在字符串耗尽时仍执行字符类判定，否定类 [!a] 因而匹配已耗尽的串
        // （实测 `log[!a]` 排除 `log`）；保持一致才能三侧判定统一。
        if (!matchClass(p, pi + 1, end, s[si])) return 0;
        pi = end; // 由循环尾部的 ++ 越过 ']'
      } else {
        // 无闭合 ']'：按字面 '['
        if (p[pi] !== s[si]) return 0;
      }
    } else if (ch === '\\') {
      if (pi + 1 >= p.length) {
        if (s[si] !== '\\') return 0; // 尾随反斜杠匹配自身
      } else {
        pi += 1;
        if (p[pi] !== s[si]) return 0;
      }
    } else if (ch === '/') {
      if (s[si] !== '/' && si < s.length) return 0;
      pi = matchSlashskip(p, pi);
      si = matchSlashskip(s, si);
      if (pi >= p.length && flags.noAnchorEnd) return 1;
      pi -= 1; // 抵消循环尾部的 ++
      si -= 1;
    } else if (ch === '$') {
      if (pi + 1 >= p.length && flags.noAnchorEnd) {
        return matchSlashskip(s, si) >= s.length;
      }
      if (p[pi] !== s[si]) return 0;
    } else {
      if (p[pi] !== s[si]) return 0;
    }
    pi += 1;
    si += 1;
  }
}

/** __archive_pathmatch：未锚定模式下模式在每个路径元素起点逐一尝试。 */
function matchPath(pattern, str, flags) {
  if (pattern === null || pattern === undefined || pattern.length === 0) return str === null || str === undefined || str.length === 0;
  if (str === null || str === undefined) return false;
  if (flags.noAnchorStart && pattern[0] === '^') {
    pattern = pattern.slice(1);
    flags = { noAnchorStart: false, noAnchorEnd: flags.noAnchorEnd };
  }
  if (pattern[0] === '/' && str[0] !== '/') return false;
  if (pattern[0] === '*' || pattern[0] === '/') {
    let pi = 0;
    let si = 0;
    while (pattern[pi] === '/') pi += 1;
    while (str[si] === '/') si += 1;
    return matchPmAt(pattern, str, si, flags, 0, pi);
  }
  if (flags.noAnchorStart) {
    let si = 0;
    for (;;) {
      if (str[si] === '/') si += 1;
      const r = matchPmAt(pattern, str, si, flags, 0);
      if (r) return r;
      const idx = str.indexOf('/', si);
      if (idx === -1) break;
      si = idx;
    }
    return 0;
  }
  return matchPmAt(pattern, str, 0, flags, 0);
}

/** 排除匹配的 flags（与 libarchive 排除侧一致：两头都不锚定）。 */
const EXCLUDE_FLAGS = { noAnchorStart: true, noAnchorEnd: true };

/** 判断相对路径是否命中任一排除项：语义与 tar --exclude 完全一致（见 matchPath）。
 * hash、tar 快照、恢复剪枝共用同一判定，保证三者对"哪些文件属于工作目录"一致。 */
function isExcluded(rel, excludes) {
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (name === '') continue;
    // 无元字符**且无斜杠**的裸模式（默认的 .git / node_modules 即此类）：
    // 未锚定语义等价于「任一路径段 === name」。先 includes 粗筛再 split 精确
    // 比对，避免为每个文件做 pm 回溯；命中即排除。含 / 或元字符（* ? [ ] \ ^ $）
    // 的模式必须走完整 matchPath——快路径的 split 会把 'build/output' 拆成两段，
    // 无法匹配跨段模式。
    if (!/[/*?\[\]\\^$]/.test(name)) {
      if (rel.includes(name) && rel.split('/').includes(name)) return true;
      continue;
    }
    if (matchPath(name, rel, EXCLUDE_FLAGS)) return true;
  }
  return false;
}

/** find 剪枝表达式：仅对 find -name 能安全处理的模式（不含 /、^、$、\）做
 * 目录剪枝以加速遍历；其余模式交给 isExcluded（matchPath）后置过滤，二者
 * 最终判定一致。快照清单与哈希清单共用同一表达式。 */
function findPruneExpr(excludes) {
  const args = [];
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    // find -name 的字符类语义与 libarchive 的 pm 存在细微分歧（无闭合 ']'、
    // 类内转义等），剪枝过头 = 快照/hash 漏文件。含 '[' 的模式一律不剪枝，
    // 交给 isExcluded（matchPath）后置过滤兜底，最终判定仍与 tar 一致。
    if (name === '' || /[/^$\\\[]/.test(name)) continue;
    args.push('-name ' + shq(name) + ' -prune');
  }
  return args.length > 0 ? args.join(' -o ') + ' -o ' : '';
}

/** 由排除项生成 tar --exclude 参数：只传裸模式。tar 的排除匹配本身就是
 * 未锚定、按路径元素尝试的 glob（见 matchPath 移植说明），「星号斜杠 P」、
 * 「点斜杠 P」等旧式变体在 libarchive 语义下既多余又会引入歧义（如 "./.*"
 * 被归一化后等价于裸 ".*"）。全部单引号包裹防 shell 展开。 */
function tarExcludeArgs(excludes) {
  const args = [];
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (name === '') continue;
    args.push('--exclude=' + shq(name));
  }
  return args.join(' ');
}

/** Full-tree snapshot of cwd into a tar.zst file (best-effort, excludes applied).
 * 用 find 生成条目清单经 -T 喂给 tar：归档里没有起始点 "." 条目，因此
 * `.*`/`*` 这类模式不会匹配到起始点把整包排除（裸模式安全）；--null/-print0
 * 支持含换行等任意字符的文件名；--no-recursion 让 find 列出的每个条目只入档
 * 一次（目录与文件都由清单显式给出，空目录也保留）。清单与哈希侧共用同一
 * find 剪枝表达式。路径一律 shq 单引号包裹：双引号内的 $/反引号会被 shell
 * 展开，路径含这些字符的工作区会被快照到错误的目标甚至执行命令。 */
async function snapshotWorkspace(cwd, targetFile, excludes) {
  await fs.mkdir(dirname(targetFile), { recursive: true });
  const excl = tarExcludeArgs(excludes);
  const prune = findPruneExpr(excludes);
  // 原子写：先落 .tmp 再 rename，杜绝「zstd 中途失败留下 size>0 的半截文件」
  // 被 turn/start 的 size>0 守卫误判为完整快照（此前会永久使用损坏快照）；
  // -T0 让 zstd 用多线程压缩（GNU/Linux 与 macOS homebrew zstd 均支持）。
  const tmp = targetFile + '.tmp';
  const result = await runSh(
    'cd ' + shq(cwd) + ' && find . ' + prune +
    '-mindepth 1 -print0 | tar --null --no-recursion -C ' + shq(cwd) + ' -T - ' + excl +
    ' -cf - | zstd -q -T0 -o ' + shq(tmp)
  );
  if (!result.ok) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return result;
  }
  try {
    await fs.rename(tmp, targetFile);
    return { ok: true };
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, stderr: String(error?.message ?? error) };
  }
}

/** Restore cwd from a tar.zst snapshot: overwrite existing files, then prune
 * files created after the snapshot (so the restore fully undoes later work).
 * Excludes stay untouched (they are not part of the snapshot): the unpack
 * side re-applies them, because a snapshot from an older plugin build (or a
 * foreign archive) may still contain excluded paths — restoring .git would
 * silently rewind the repository, and node_modules must never be clobbered.
 * The prune side applies the same rule twice: file removal skips excluded
 * paths, and the empty-dir cleanup skips both excluded directories and
 * directories present in the snapshot (the latter are restored by the unpack
 * and must survive — a bare `find -type d -empty -delete` deletes both).
 * Destructive. */
async function restoreWorkspace(cwd, snapshotFile, excludes) {
  const excl = tarExcludeArgs(excludes);
  const unpack = await runSh('zstd -dc ' + shq(snapshotFile) + ' | tar ' + excl + ' -C ' + shq(cwd) + ' -xf -');
  if (!unpack.ok) return unpack;
  const listing = await runSh('tar -tf ' + shq(snapshotFile));
  if (!listing.ok) return listing;
  const keptFiles = new Set();
  const keptDirs = new Set();
  for (const line of listing.stdout.split('\n')) {
    const rel = line.replace(/^\.\//, '');
    if (rel === '') continue;
    if (rel.endsWith('/')) keptDirs.add(rel.slice(0, -1));
    else keptFiles.add(rel);
  }
  const files = await runSh('find ' + shq(cwd) + ' -type f');
  if (!files.ok) return files;
  let removed = 0;
  for (const line of files.stdout.split('\n')) {
    const abs = line.trim();
    if (abs === '') continue;
    const rel = abs.slice(cwd.length).replace(/^\//, '');
    if (keptFiles.has(rel)) continue;
    // 排除项（.git/node_modules 任意层级）不在快照里、也绝不剪枝删除
    if (isExcluded(rel, excludes)) continue;
    try {
      await fs.rm(abs, { force: true });
      removed += 1;
    } catch {}
  }
  // 剪枝后留下的空目录：只清「快照里没有、也不命中排除项」的空目录。
  // 快照内本就有（解包已重建）的空目录必须保留——旧实现用
  // `find -type d -empty -delete`，会把它们连同排除项的空目录（如尚未
  // 安装任何包的空 node_modules/）一起删掉，违背"恢复绝不动排除项"。
  // -depth 保证子目录先于父目录被删。
  let removedDirs = 0;
  const dirs = await runSh('find ' + shq(cwd) + ' -depth -type d -empty -print');
  if (dirs.ok) {
    for (const line of dirs.stdout.split('\n')) {
      const abs = line.trim();
      if (abs === '') continue;
      const rel = abs.slice(cwd.length).replace(/^\//, '');
      if (rel === '') continue;
      if (keptDirs.has(rel)) continue;
      if (isExcluded(rel, excludes)) continue;
      try {
        await fs.rmdir(abs);
        removedDirs += 1;
      } catch {}
    }
  }
  return { ok: true, removed, removedDirs };
}

/** Backup the current cwd state before a destructive restore, for manual undo.
 * Excludes mirror the restore's own protection: unpack + file prune + dir
 * cleanup all re-apply excludes, so excluded paths (.git/node_modules at any
 * depth) are never touched by a restore — backing them up would only add
 * gigabytes to the snapshot dir and slow every rollback down. */
async function backupWorkspace(cwd, targetFile, excludes = []) {
  const result = await snapshotWorkspace(cwd, targetFile, excludes);
  return result.ok;
}

/** Stream one file through SHA-256 without buffering it whole — a multi-GB
 * single file (model weights, datasets) must not be loaded into memory on
 * every manifest write / preflight. */
async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

/** Per-file SHA-256 manifest of the tracked (non-excluded) files under cwd:
 * { <relpath>: <hex> }, or null when the walk fails. Exclude semantics mirror
 * restoreWorkspace's prune side (isExcluded), so hashing and pruning agree on
 * which files are "in" the workspace. The find walk prunes excluded directories
 * (.git / node_modules at any depth) so huge metadata trees are neither walked
 * nor hashed. */
async function hashWorkspace(cwd, excludes) {
  // 无括号写法（find 的 -prune 按项短路，等价于括号分组；也避开 JS 字符串里
  // 反斜杠转义被吞的坑）：-name X -prune -o -name Y -prune -o -type f -print。
  // 剪枝表达式与快照清单共用（findPruneExpr）；含 /、^、$、\、[ 的模式不被
  // find 剪枝，由下方 isExcluded 后置过滤兜底，最终判定与 tar 一致。
  const pruneExpr = findPruneExpr(excludes);
  const files = await runSh('find ' + shq(cwd) + ' ' + pruneExpr + '-type f -print');
  if (!files.ok) return null;
  const map = {};
  // 小并发池做 sha256（流式已不占内存，并发只提升吞吐）；map 按键写入，
  // 完成顺序无关。注：不做 mtime+size 缓存——preflight 冲突判定依赖当前
  // 哈希的精确性，缓存可能漏检「外部原地改写但 mtime 不变」的冲突。
  const pending = [];
  const CONCURRENCY = 8;
  for (const line of files.stdout.split('\n')) {
    const abs = line.trim();
    if (abs === '') continue;
    const rel = abs.slice(cwd.length).replace(/^\//, '');
    if (rel === '' || rel.endsWith('/')) continue;
    if (isExcluded(rel, excludes)) continue;
    pending.push(sha256File(abs).then((hash) => { map[rel] = hash; }).catch(() => {}));
    if (pending.length >= CONCURRENCY) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
  return map;
}

/** Write a per-file hash manifest atomically (tmp + rename); best-effort. */
async function writeManifest(cwd, manifestFile, excludes) {
  const map = await hashWorkspace(cwd, excludes);
  if (map === null) return { ok: false };
  await fs.mkdir(dirname(manifestFile), { recursive: true });
  const tmp = manifestFile + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(map), 'utf8');
  await fs.rename(tmp, manifestFile);
  return { ok: true };
}

/** Read a manifest into { relpath: hash }, or null when missing/corrupt.
 * 传入 excludes 时剔除被排除的条目：升级前旧快照/清单可能记录了 .git 等路径，
 * 与修复后的新清单对比会产生假冲突，统一在载入时过滤掉。 */
async function loadManifest(file, excludes = []) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (excludes.length > 0) {
      for (const key of Object.keys(parsed)) {
        if (isExcluded(key, excludes)) delete parsed[key];
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function fsTargetExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Link the source session's turn snapshots up to maxTurn into the child
 * session's snapshot dir, so a further rollback inside the child to a seeded
 * message (turn T <= maxTurn-1) still finds turn-(T+1). Hardlinks share blocks
 * (zero-copy); falls back to copyFile across filesystems. Idempotent: a
 * missing source dir or an already-present target is a no-op. */
async function inheritSnapshots(env, sourceId, childId, maxTurn) {
  const sourceDir = join(env.snapRoot, sourceId);
  const childDir = join(env.snapRoot, childId);
  let entries;
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return { inherited: 0 };
  }
  let inherited = 0;
  try {
    await fs.mkdir(childDir, { recursive: true });
    for (const entry of entries) {
      // Inherit the full-tree snapshot and its start manifest (state AFTER the
      // previous turn). End manifests (turn-N.end.files.json) are session-local
      // "last write" records regenerated by each session's own turn/end, so they
      // are deliberately excluded here.
      const m = /^turn-(\d+)\.(?:tar\.zst|files\.json)$/.exec(entry);
      if (m === null) continue;
      const num = Number(m[1]);
      if (!Number.isInteger(num) || num < 1 || num > maxTurn) continue;
      const dst = join(childDir, entry);
      if (await fsTargetExists(dst)) continue;
      const src = join(sourceDir, entry);
      try {
        await fs.link(src, dst);
      } catch {
        await fs.copyFile(src, dst);
      }
      inherited += 1;
    }
    return { inherited };
  } catch (error) {
    return { inherited, error: String(error?.message ?? error) };
  }
}

/** 孤儿回收缓冲：session- 前缀但 registry 无记录的目录，需停止活动超过该时长
 * 才回收——给「会话刚创建、workspace attach 尚未完成」的竞态留缓冲，避免误删
 * 活跃会话的快照。 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** 快照根下的顶层目录（跳过符号链接与文件）。 */
async function listSnapshotDirs(snapRoot) {
  let entries;
  try {
    entries = await fs.readdir(snapRoot);
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    try {
      const st = await fs.lstat(join(snapRoot, entry));
      if (st.isDirectory() && !st.isSymbolicLink()) dirs.push(entry);
    } catch {}
  }
  return dirs;
}

/** 目录内容是否像本插件的快照目录（含 turn-N.tar.zst / files.json / recovery-*）。
 * 回收非标准前缀目录前用此守卫：即使 snapshotDir 被指向别的目录树，也只回收
 * 确实由本插件产出的子目录，绝不碰无关用户数据。 */
async function looksLikeSnapshotDir(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.some((entry) => /^turn-\d+\.(?:tar\.zst|files\.json)$/.test(entry) || entry.startsWith('recovery-'));
  } catch {
    return false;
  }
}

/** 当前"活着"的会话 id：sessions registry（所有 live 会话）+ workspace 记账的
 * sessionIds（含归档后保留席位但 sessions 里已下线的）。孤儿判定基于该集合。 */
function liveSessionIds(env) {
  const ids = new Set();
  try {
    for (const session of env.ctx.sessions?.list?.() ?? []) {
      if (session && typeof session.id === 'string') ids.add(session.id);
    }
  } catch {}
  try {
    for (const workspace of env.ctx.workspaceRegistry?.list?.() ?? []) {
      for (const id of workspace?.sessionIds ?? []) ids.add(id);
    }
  } catch {}
  return ids;
}

/** 统一快照清理。回收三类目录：
 *  - archived：已归档会话（回滚或手动归档）——清理即回收（后代硬链接除外，
 *    空间随链路末端清理释放，属硬链接的正常语义）；
 *  - non-standard：非 session- 前缀的目录（arena 对局会话、旧格式 UUID）——
 *    写侧已停（见 onSessionEvent），无 rollback 语义，存量一次性回收；
 *  - orphan：session- 前缀但 sessions/workspace 均无记录、且停止活动超过
 *    ORPHAN_GRACE_MS（会话已删除或从未注册）——避免 attach 竞态误删。
 * 非 archived 目录回收前都过 looksLikeSnapshotDir 守卫，防 snapshotDir 被指向
 * 无关目录树时误删用户数据。
 * Runs lazily from handleRollback, on a periodic timer (apply), and via
 * POST /chat-rollback/prune-archived. */
async function pruneSnapshots(env, sessionIdHint, skipId) {
  try {
    const archived = new Set(env.ctx.workspaceRegistry?.archivedSessionIds ?? []);
    if (sessionIdHint !== undefined && !archived.has(sessionIdHint)) return { ok: true, pruned: [], orphaned: [] };
    const live = liveSessionIds(env);
    const dirs = await listSnapshotDirs(env.snapRoot);
    const pruned = [];
    const orphaned = [];
    const now = Date.now();
    for (const entry of dirs) {
      if (sessionIdHint !== undefined && entry !== sessionIdHint) continue;
      // skipId：回滚中正被继承的源会话目录不在此次清理范围（见 handleRollback
      // 的惰性清理调用——它异步执行，可能与快照硬链接继承并发）。
      if (skipId !== undefined && entry === skipId) continue;
      let reason = null;
      if (archived.has(entry)) {
        reason = 'archived';
      } else if (!entry.startsWith('session-')) {
        // 非标准前缀目录：确认是本插件产物（防误删），且写侧已停不再增长
        if (await looksLikeSnapshotDir(join(env.snapRoot, entry))) reason = 'non-standard';
      } else if (!live.has(entry)) {
        // session- 前缀孤儿：registry 无记录，且停止活动超过缓冲期
        try {
          const st = await fs.stat(join(env.snapRoot, entry));
          if (now - st.mtimeMs > ORPHAN_GRACE_MS && (await looksLikeSnapshotDir(join(env.snapRoot, entry)))) reason = 'orphan';
        } catch {}
      }
      if (reason === null) continue;
      try {
        await fs.rm(join(env.snapRoot, entry), { recursive: true, force: true });
        (reason === 'orphan' ? orphaned : pruned).push(entry);
      } catch (error) {
        env.ctx.logger?.warn?.('chat-rollback: prune failed for ' + entry + ': ' + String(error));
      }
    }
    return { ok: true, pruned, orphaned };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/** Turn number owning seq: the nearest preceding turn/start event's data.turn. */
function turnOf(events, seq) {
  let turn = 0;
  for (const event of events) {
    if (event.seq > seq) break;
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn;
  }
  return turn;
}

/** Resolve a rollback request to its target: the cut point, the turn whose
 * completion state the rollback continues from (the restore snapshot is
 * turn-(turn+1)), and the next-input prefill. Shared by the preflight conflict
 * check and the real rollback so the two can never disagree on the point.
 *
 * Two semantics, picked by the target event type:
 *  - user/message target: "roll back to BEFORE this message". The seed ends at
 *    the last completed turn (or queued message) before it, and the message's
 *    own text becomes the new session's draft prefill. A still-open turn (the
 *    user steered mid-run) is trimmed away so the seed never carries a partial
 *    turn.
 *  - assistant-message target (legacy): cut right after the target, then fold
 *    in the target turn's closing events (step/end, turn/end) when they
 *    immediately follow — a rollback onto the turn's LAST assistant message
 *    must not leave that turn unclosed in the new session.
 */
function resolveRollbackTarget(events, seq) {
  const targetEvent = events[seq];
  const beforeMessage = targetEvent?.type === 'user/message';
  let cut;
  if (beforeMessage) {
    cut = seq;
    while (cut > 0 && events[cut - 1].type !== 'turn/end' && events[cut - 1].type !== 'user/message') cut -= 1;
  } else {
    cut = seq + 1;
    const targetTurn = turnOf(events, seq);
    while (
      cut < events.length &&
      (events[cut].type === 'step/end' || events[cut].type === 'turn/end') &&
      events[cut].data?.turn === targetTurn
    ) {
      cut += 1;
    }
  }
  // Keep the session header event when the cut lands before every event
  // (rollback before the very first user message = a fresh start).
  const seed = cut === 0 && events.length > 0 ? events.slice(0, 1) : events.slice(0, cut);
  let turn;
  if (beforeMessage) {
    turn = 0;
    for (const ev of seed) {
      if (ev.type === 'turn/end' && typeof ev.data?.turn === 'number' && ev.data.turn > turn) turn = ev.data.turn;
    }
  } else {
    turn = turnOf(events, seq);
  }
  let nextInput = '';
  if (beforeMessage) {
    const blocks = targetEvent?.data?.content;
    if (Array.isArray(blocks)) {
      nextInput = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
    }
  } else {
    for (const event of events.slice(cut)) {
      if (event.type !== 'user/message') continue;
      const blocks = event.data?.content;
      if (Array.isArray(blocks)) {
        nextInput = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');
      }
      break;
    }
  }
  return { beforeMessage, cut, seed, turn, nextInput };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

const ABSENT = Symbol('absent');

/** State of a path in a manifest: its hash, ABSENT (missing), or null (manifest
 * unknown). */
function manifestState(map, rel) {
  if (map === null || map === undefined) return null;
  if (Object.prototype.hasOwnProperty.call(map, rel)) return map[rel];
  return ABSENT;
}

/** Highest-numbered manifest matching the given matcher. The matcher returns the
 * turn number for a matching entry, or null. */
async function latestManifestFile(snapDir, matcher) {
  let entries;
  try {
    entries = await fs.readdir(snapDir);
  } catch {
    return null;
  }
  let best = null;
  let bestNum = 0;
  for (const entry of entries) {
    const num = matcher(entry);
    if (num === null || num <= bestNum) continue;
    bestNum = num;
    best = join(snapDir, entry);
  }
  return best;
}

const END_MANIFEST = (entry) => {
  const m = /^turn-(\d+)\.end\.files\.json$/.exec(entry);
  return m === null ? null : Number(m[1]);
};

/** Compare the live tree against the restore target. A file is a conflict when
 * (a) this rollback would revert it (current != target) and (b) it is no longer
 * at the value this session last wrote (current != last-write) — i.e. another
 * session changed it after our last completed turn. */
function computeConflicts(targetMap, lastWriteMap, currentMap) {
  if (targetMap === null || currentMap === null) return { conflict: false, files: [] };
  const paths = new Set([...Object.keys(targetMap), ...Object.keys(currentMap)]);
  if (lastWriteMap !== null && lastWriteMap !== undefined) {
    for (const p of Object.keys(lastWriteMap)) paths.add(p);
  }
  const files = [];
  for (const rel of paths) {
    const t = manifestState(targetMap, rel);
    const c = manifestState(currentMap, rel);
    if (t === c) continue; // unchanged since the restore point -> not reverted
    const l = manifestState(lastWriteMap, rel);
    if (l !== null && l === c) continue; // still at our last write -> ours, safe
    files.push(rel);
  }
  files.sort();
  return { conflict: files.length > 0, files };
}

/** 计算一次回滚的冲突状态（只读）。preflight 与 rollback 共用同一判定，保证
 * 「该回滚是否会覆盖其他会话的写入」两处结论一致（也用于 rollback 的二次
 * 校验收窄 preflight→执行之间的 TOCTOU 窗口）。返回 { conflict, files, reason }。
 * reason 说明降级路径：no-snapshot / source-running / no-manifest /
 * no-end-manifest（无 last-write 参照，按无冲突放行）/ clean / conflict。 */
async function rollbackConflictState(env, source, turn) {
  const cwd = source.header?.cwd;
  if (!env.snapshotsEnabled || typeof cwd !== 'string' || cwd === '') {
    return { conflict: false, files: [], reason: 'no-snapshot' };
  }
  let running = false;
  try {
    const agent = env.ctx.agents.get(source.id);
    running = agent !== undefined && agent.status === 'running';
  } catch {}
  if (running) return { conflict: false, files: [], reason: 'source-running' };
  const snapDir = join(env.snapRoot, source.id);
  const targetMap = await loadManifest(join(snapDir, 'turn-' + (turn + 1) + '.files.json'), env.excludes);
  if (targetMap === null) return { conflict: false, files: [], reason: 'no-manifest' };
  let lastWriteMap = null;
  let lastWriteProvenance = 'end';
  const endFile = await latestManifestFile(snapDir, END_MANIFEST);
  if (endFile !== null) {
    lastWriteMap = await loadManifest(endFile, env.excludes);
  } else {
    const startFile = await latestManifestFile(snapDir, (entry) => {
      const m = /^turn-(\d+)\.files\.json$/.exec(entry);
      return m === null ? null : (Number(m[1]) > turn + 1 ? Number(m[1]) : null);
    });
    if (startFile !== null) {
      lastWriteMap = await loadManifest(startFile, env.excludes);
      lastWriteProvenance = 'start';
    } else {
      lastWriteProvenance = 'unknown';
    }
  }
  const currentMap = await hashWorkspace(cwd, env.excludes);
  if (lastWriteMap === null) {
    // 无任何恢复点之后的 last-write 参照：当前状态无法归因（典型：单轮会话
    // 且该轮未正常 turn/end）。恢复仍先生成 recovery 备份，按无冲突放行。
    return { conflict: false, files: [], reason: lastWriteProvenance === 'unknown' ? 'no-end-manifest' : 'clean' };
  }
  const conflict = computeConflicts(targetMap, lastWriteMap, currentMap);
  return {
    conflict: conflict.conflict,
    files: conflict.files,
    reason: conflict.conflict ? 'conflict' : (lastWriteProvenance === 'unknown' ? 'no-end-manifest' : 'clean')
  };
}

/** Read-only conflict preflight for a rollback target. Runs BEFORE any restore
 * so the client can gate the confirm (✓) behind a "?" when another session has
 * also changed files this rollback would overwrite. */
async function handlePreflight(req, res, env) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const sessionId = url.searchParams.get('session') ?? '';
    const seqParam = url.searchParams.get('seq') ?? '';
    if (sessionId === '' || !/^\d+$/.test(seqParam)) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'session id and a numeric seq are required' });
      return;
    }
    const source = env.ctx.sessions.get(sessionId);
    if (source === undefined) {
      sendJson(res, 404, { ok: false, code: 'session-not-found', message: 'no live session ' + sessionId });
      return;
    }
    const seq = Number(seqParam);
    if (seq >= source.events.length) {
      sendJson(res, 400, { ok: false, code: 'bad-seq', message: 'seq ' + seq + ' is beyond the session log (' + source.events.length + ' events)' });
      return;
    }
    const target = resolveRollbackTarget(source.events, seq);
    const state = await rollbackConflictState(env, source, target.turn);
    sendJson(res, 200, {
      ok: true,
      conflict: state.conflict,
      files: state.files,
      reason: state.reason,
      sourceSessionId: sessionId,
      sourceTurn: target.turn
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
  }
}

async function handleRollback(req, res, env) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const sessionId = url.searchParams.get('session') ?? '';
    const seqParam = url.searchParams.get('seq') ?? '';
    if (sessionId === '' || !/^\d+$/.test(seqParam)) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'session id and a numeric seq are required' });
      return;
    }
    // Lazy cleanup: snapshots of archived sessions (and orphaned/non-standard
    // dirs) are reclaimed on rollback. skipId = 本次源会话：该目录马上要被
    // inheritSnapshots 硬链接继承，惰性清理若与其并发（尤其跨文件系统
    // copyFile 降级路径）可能先删源快照。
    pruneSnapshots(env, undefined, sessionId).catch(() => {});
    const source = env.ctx.sessions.get(sessionId);
    if (source === undefined) {
      sendJson(res, 404, { ok: false, code: 'session-not-found', message: 'no live session ' + sessionId });
      return;
    }
    const events = source.events;
    const seq = Number(seqParam);
    if (seq >= events.length) {
      sendJson(res, 400, {
        ok: false,
        code: 'bad-seq',
        message: 'seq ' + seq + ' is beyond the session log (' + events.length + ' events)'
      });
      return;
    }
    const { cut, seed, turn, nextInput } = resolveRollbackTarget(events, seq);
    const force = url.searchParams.get('force') === '1';
    const stream = url.searchParams.get('stream') === '1';
    // TOCTOU 收窄：preflight 与真正执行之间其他会话的写入，在这里再验一次；
    // 有冲突且未 force → 409，客户端回到「?" 确认态，确认后带 force=1 重发。
    const state = await rollbackConflictState(env, source, turn);
    if (state.conflict && !force) {
      sendJson(res, 409, { ok: false, code: 'conflict', files: state.files, sourceSessionId: sessionId, sourceTurn: turn, message: 'files changed by other sessions; confirm to overwrite' });
      return;
    }
    // 空快照安全网：恢复点快照为空（如 excludes 配成 '*'、或快照损坏/回归）
    // 且工作区非空时，恢复会清空整个工作区——需用户确认（force）才执行。
    let emptySnapshotGuard = false;
    if (env.snapshotsEnabled && !force) {
      const cwd = source.header?.cwd;
      const snapDir = join(env.snapRoot, sessionId);
      const snapshotFile = join(snapDir, 'turn-' + (turn + 1) + '.tar.zst');
      if (typeof cwd === 'string' && cwd !== '' && await fsTargetExists(snapshotFile)) {
        const listing = await runSh('tar -tf ' + shq(snapshotFile));
        if (listing.ok && listing.stdout.trim() === '') {
          // 只统计非排除内容：工作区仅有被排除文件（如只有 .git）时恢复不会
          // 触碰它们，不应误报 409。
          const ws = await runSh('find ' + shq(cwd) + ' ' + findPruneExpr(env.excludes) + '-mindepth 1');
          if (ws.ok && ws.stdout.trim() !== '') emptySnapshotGuard = true;
        }
      }
    }
    if (emptySnapshotGuard) {
      sendJson(res, 409, { ok: false, code: 'empty-snapshot', files: [], sourceSessionId: sessionId, sourceTurn: turn, message: 'snapshot is empty; rollback would wipe the workspace — confirm to proceed' });
      return;
    }
    // stream=1 的 ndjson 进度流：先写响应头（409 校验已全部通过），此后每个
    // 阶段即时写一行，客户端可实时展示进度；非流式保持单次 JSON。
    if (stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    }
    const emitPhase = (p) => {
      if (stream) res.write(JSON.stringify(p) + '\n');
    };
    let agentPreset;
    let setup;
    try {
      const presetId = resolveSessionPreset(source);
      const presets = env.ctx.get('agentPresets');
      if (presets !== undefined) {
        const resolvedId = (await presets.resolve(presetId)).id;
        agentPreset = resolvedId;
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, resolvedId);
        };
      }
    } catch (error) {
      env.ctx.logger.warn('chat-rollback: preset composition failed: ' + String(error));
    }
    let selection;
    try {
      selection = env.ctx.agentDefaultModel.currentSelection();
    } catch {
      selection = undefined;
    }
    const childId = 'session-' + randomUUID();
    await env.ctx.agents.create({
      sessionId: childId,
      seed,
      meta: {
        ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
        seedLength: cut,
        ...(agentPreset === undefined ? {} : { agentPreset })
      },
      agentOptions: selection === undefined ? {} : { provider: selection.provider, model: selection.model },
      setup
    });
    emitPhase({ phase: 'session', sessionId: childId });
    let workspaceNote;
    try {
      const workspace = env.ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(source.id));
      if (workspace !== undefined) {
        await workspace.attachSession(childId);
        workspaceNote = workspace.id;
      }
    } catch (error) {
      workspaceNote = 'workspace attach failed: ' + String(error);
    }
    // The source session is superseded: cancel its agent when it is still
    // running (rollback onto a mid-turn message), so it cannot keep mutating
    // the workspace we are about to restore. Mirrors host session.cancel
    // semantics (keepInbox preserves queued input; idle agents are untouched).
    let sourceCancelled = false;
    try {
      const agent = env.ctx.agents.get(source.id);
      if (agent !== undefined && agent.status === 'running') {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        sourceCancelled = true;
      }
    } catch (error) {
      env.ctx.logger.warn('chat-rollback: source agent cancel failed: ' + String(error));
    }
    emitPhase({ phase: 'cancel', sourceCancelled });
    // Code rollback: restore the workspace to the state right AFTER the turn
    // that contains the rollback target message, undoing every file change the
    // target turn and later turns made. Snapshot "turn-N" is taken at turn-N
    // start, so the state after turn-K is snapshot turn-(K+1), when it exists.
    // Without a snapshot (fresh sessions, disabled snapshotting, non-cwd
    // workspaces) the conversation still rolls back — the workspace is simply
    // left as-is, which is the pre-snapshot "branch" behaviour. The pre-restore
    // backup lives in the CHILD's snapshot dir: the source dir is pruned on
    // archive below, so a backup stored there would die with it.
    let codeRollback = { restored: false, reason: 'no-snapshot' };
    if (env.snapshotsEnabled) {
      const snapDir = join(env.snapRoot, sessionId);
      const snapshotFile = join(snapDir, 'turn-' + (turn + 1) + '.tar.zst');
      const cwd = source.header?.cwd;
      if (typeof cwd !== 'string' || cwd === '') {
        codeRollback = { restored: false, reason: 'no-cwd' };
      } else if (await fsTargetExists(snapshotFile)) {
        const stamp = Date.now();
        const backupFile = join(env.snapRoot, childId, 'recovery-' + stamp + '.tar.zst');
        emitPhase({ phase: 'backup' });
        try {
          const backupOk = await backupWorkspace(cwd, backupFile, env.excludes);
          if (!backupOk) env.ctx.logger.warn('chat-rollback: pre-restore backup failed for ' + childId + ' (auto-rollback on restore failure unavailable)');
          const restore = await restoreWorkspace(cwd, snapshotFile, env.excludes);
          if (restore.ok) {
            codeRollback = { restored: true, snapshot: 'turn-' + (turn + 1) + '.tar.zst', backup: 'recovery-' + stamp + '.tar.zst' };
          } else {
            // 恢复失败：自动用 recovery 备份把工作区还原到恢复前状态（尽力而
            // 为），避免停在半恢复状态；rolledBack 供客户端提示。
            let rolledBack = false;
            try {
              const undo = await restoreWorkspace(cwd, backupFile, env.excludes);
              rolledBack = undo.ok;
            } catch {}
            codeRollback = { restored: false, reason: 'restore-failed', message: restore.stderr.slice(0, 500), ...(rolledBack ? { rolledBack: true } : {}) };
          }
        } catch (error) {
          codeRollback = { restored: false, reason: 'restore-failed', message: String(error?.message ?? error).slice(0, 500) };
        }
      }
    }
    emitPhase({ phase: 'restore', codeRollback });
    // Snapshot inheritance: the new session's seed carries turns 1..turn, so a
    // further rollback inside it to a seeded message needs the source's
    // snapshots turn-1..turn-(turn+1) — and the source dir is pruned right
    // below, so those snapshots must be linked into the child dir first.
    let inheritedSnapshots = 0;
    let inheritNote;
    try {
      const outcome = await inheritSnapshots(env, sessionId, childId, turn + 1);
      inheritedSnapshots = outcome.inherited;
      if (outcome.error !== undefined) inheritNote = 'snapshot inherit failed: ' + outcome.error;
    } catch (error) {
      inheritNote = 'snapshot inherit failed: ' + String(error);
    }
    emitPhase({ phase: 'inherit', inheritedSnapshots });
    // The source session is superseded: archive it so it leaves the sidebar
    // and cannot be resumed alongside the new branch (its later turns' file
    // changes were already undone by the code rollback). Archiving is durable
    // and keeps workspace accounting. NOTE: the current dsh exposes no
    // unarchive API and every surface hides archived sessions, so an archived
    // session stays out of the UI until a future restore path exists — the
    // rollback itself is the only archiver today.
    // Its turn snapshots are no longer reachable — prune them right away.
    // Exception: a FAILED workspace restore keeps the source live with its
    // snapshots intact, so the user can retry the rollback.
    let archivedSource = false;
    let archiveNote;
    const canArchive = codeRollback.reason !== 'restore-failed';
    try {
      if (env.ctx.workspaceRegistry !== undefined && canArchive) {
        await env.ctx.workspaceRegistry.archiveSession(source.id);
        archivedSource = true;
        await pruneSnapshots(env, source.id);
      } else if (!canArchive) {
        archiveNote = 'archive deferred: workspace restore failed, source kept for retry';
      }
    } catch (error) {
      archiveNote = 'archive failed: ' + String(error);
    }
    emitPhase({ phase: 'archive', archivedSource });
    const body = {
      ok: true,
      sessionId: childId,
      // The source session this branch was cut from and the turn whose
      // completion state the rollback continues from (1-based, maps 1:1 onto
      // the snapshot naming; 0 = before the first turn).
      sourceSessionId: sessionId,
      sourceTurn: turn,
      codeRollback,
      inheritedSnapshots,
      ...(inheritNote === undefined ? {} : { inheritNote }),
      archivedSource,
      sourceCancelled,
      ...(archiveNote === undefined ? {} : { archiveNote }),
      ...(workspaceNote === undefined ? {} : { workspaceNote }),
      ...(nextInput === '' ? {} : { nextInput })
    };
    if (stream) {
      // 阶段行已在执行过程中即时写出（见 emitPhase），这里只发终态。
      res.write(JSON.stringify({ phase: 'done', ...body }) + '\n');
      res.end();
    } else {
      sendJson(res, 200, body);
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
  }
}

/**
 * 注册 webServer 路由并容忍 re-init 时残留的同路径旧路由（停用/重载后旧 handler
 * 已随旧 ctx 失效，probe 会报 inactive context）：命中 duplicate 先清掉旧路由
 * 再重新注册，保证「停用后重新启用」幂等。
 */
function registerWebRoute(ctx, route) {
  // 把路由绑定到插件 ctx 生命周期：停用（ctx dispose）时 cordis 自动执行清理
  // 注销路由，重新启用再注册不会撞 duplicate route（实测停用后旧路由会残留，
  // 旧 handler 已随旧 ctx 失效）。兜底：命中 duplicate 时清掉残留路由后重注册。
  return ctx.effect(() => {
    try {
      return ctx.webServer.register(route);
    } catch (error) {
      if (!/duplicate/.test(String(error?.message ?? error))) throw error;
      const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes;
      if (table && typeof table.delete === 'function') table.delete(route.path);
      return ctx.webServer.register(route);
    }
  });
}

function apply(ctx, config = {}) {
  const snapRoot = config.snapshotDir ?? defaultSnapshotRoot();
  const excludes = config.excludes ?? DEFAULT_EXCLUDES;
  const snapshotsEnabled = config.snapshotEnabled ?? true;
  const env = { ctx, snapRoot, excludes, snapshotsEnabled };
  const disposers = [];
  // 快照任务按 session 串行：同一会话的 turn-N 快照 + manifest 原子成组完成
  // 后才开始 turn-N+1 的，避免快速连续 turn（steer）下 tar 与 hash 交错读取
  // 正在被 agent 修改的工作区，造成快照/清单不一致。
  const snapshotQueues = new Map();
  const enqueueSnapshot = (sessionId, task) => {
    const prev = snapshotQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(task);
    snapshotQueues.set(sessionId, run.catch(() => {}));
    return run;
  };

  if (snapshotsEnabled) {
    // Turn-level workspace snapshots: at every turn/start we capture the cwd
    // state (which is exactly the state after the previous turn finished), so
    // rollback can restore "after turn K" from snapshot turn K+1.
    const onSessionEvent = (session, event) => {
      const turn = event.data?.turn;
      const cwd = session?.header?.cwd;
      if (typeof turn !== 'number' || typeof cwd !== 'string' || cwd === '') return;
      // 只给标准 dsh 会话（session-<uuid>）写快照：arena 对局会话、旧格式 id
      // 不是回滚目标，快照只会白占磁盘，且清理侧也只认 session- 前缀——写侧
      // 与清理侧保持同一前缀，杜绝"写了清不掉"的不对称（arena 曾累积 400MB+）。
      if (!session.id.startsWith('session-')) return;
      // Archived sessions are hidden and their snapshot dirs are pruned on
      // archive — skip, so a still-running archived session does not keep
      // re-creating snapshot files.
      const archived = env.ctx.workspaceRegistry?.archivedSessionIds;
      if (archived !== undefined && archived.includes(session.id)) return;
      const dir = join(snapRoot, session.id);
      if (event.type === 'turn/start') {
        // Full-tree snapshot + per-file hash manifest = state AFTER the previous
        // turn (rollback restores this via the turn-(turn+1) naming).
        const target = join(dir, 'turn-' + turn + '.tar.zst');
        const manifest = join(dir, 'turn-' + turn + '.files.json');
        // The target can pre-exist only through inheritance (rollback/fork
        // children). Keep the inherited file: it holds the accurate ancestor
        // state, while the shared cwd may have moved on by the child's first
        // turn. Turns never repeat within a session, so nothing legitimate is
        // ever skipped; size>0 guards against partial files（原子写后目标文件
        // 只会在 rename 完成后出现）。
        enqueueSnapshot(session.id, async () => {
          const complete = await fs.stat(target).then((st) => st.size > 0).catch(() => false);
          if (complete) return { ok: true, skipped: true };
          const snap = await snapshotWorkspace(cwd, target, excludes);
          if (!snap.ok) return snap;
          await writeManifest(cwd, manifest, excludes); // best-effort, ignored on failure
          return snap;
        }).then((result) => {
          if (result?.ok) ctx.logger.info('chat-rollback: snapshot turn ' + turn + ' of ' + session.id + (result.skipped ? ' (inherited, kept)' : ''));
          else ctx.logger.warn('chat-rollback: snapshot failed for turn ' + turn + ': ' + String(result?.stderr ?? '').slice(0, 200));
        }).catch((error) => {
          ctx.logger.warn('chat-rollback: snapshot error: ' + String(error));
        });
      } else if (event.type === 'turn/end') {
        // Post-turn hash manifest = state AFTER this turn = this session's last
        // write, the reference the conflict preflight compares against. Never
        // inherited (a child's own turns regenerate it), so the skip guard only
        // prevents a duplicate turn/end from overwriting a fresh manifest.
        const endManifest = join(dir, 'turn-' + turn + '.end.files.json');
        enqueueSnapshot(session.id, async () => {
          const complete = await fs.stat(endManifest).then((st) => st.size > 0).catch(() => false);
          if (complete) return { ok: true, skipped: true };
          const result = await writeManifest(cwd, endManifest, excludes);
          return result.ok ? { ok: true } : result;
        }).then((result) => {
          if (result?.ok) ctx.logger.info('chat-rollback: end-manifest turn ' + turn + ' of ' + session.id + (result.skipped ? ' (kept)' : ''));
          else ctx.logger.warn('chat-rollback: end-manifest failed for turn ' + turn + ': ' + String(result?.message ?? '').slice(0, 200));
        }).catch((error) => {
          ctx.logger.warn('chat-rollback: end-manifest error: ' + String(error));
        });
      }
    };
    disposers.push(ctx.on('session/event', onSessionEvent));
  }

  // Fork snapshot inheritance: a forked session (host session.fork) carries
  // parentSession WITHOUT origin/delegationDepth — subagent children carry
  // origin:"subagent" and are excluded, and rollback children (no
  // parentSession) inherit inside handleRollback. The fork's seed covers the
  // parent's turns 1..K, so link the parent's turn-1..turn-(K+1) snapshots
  // into the fork's dir; a rollback inside the fork to a seeded message then
  // still finds its code snapshot. NOTE: this callback must never throw
  // synchronously — a throwing session/created listener rolls the session
  // attach back (dsh-session announce) — the body is async and
  // rejection-contained.
  const onSessionCreated = async (session) => {
    try {
      const header = session?.header;
      if (header?.parentSession === undefined || header.origin !== undefined || header.delegationDepth !== undefined) return;
      if (typeof header.cwd !== 'string' || header.cwd === '') return;
      if (typeof header.seedLength !== 'number') return;
      const maxTurn = turnOf(session.events, header.seedLength - 1) + 1;
      const outcome = await inheritSnapshots(env, header.parentSession, session.id, maxTurn);
      if (outcome.error !== undefined) {
        ctx.logger.warn('chat-rollback: fork snapshot inherit failed for ' + session.id + ': ' + outcome.error);
      } else if (outcome.inherited > 0) {
        ctx.logger.info('chat-rollback: fork ' + session.id + ' inherited ' + outcome.inherited + ' snapshots from ' + header.parentSession);
      }
    } catch (error) {
      ctx.logger.warn('chat-rollback: fork snapshot inherit error: ' + String(error));
    }
  };
  disposers.push(ctx.on('session/created', onSessionCreated));

  disposers.push(registerWebRoute(ctx, {
    kind: 'exact',
    path: '/chat-rollback/rollback',
    handler: (req, res) => handleRollback(req, res, env)
  }));
  disposers.push(registerWebRoute(ctx, {
    kind: 'exact',
    path: '/chat-rollback/preflight',
    handler: (req, res) => handlePreflight(req, res, env)
  }));
  disposers.push(registerWebRoute(ctx, {
    kind: 'exact',
    path: '/chat-rollback/prune-archived',
    handler: async (req, res) => {
      // 手动存量清理入口：回收已归档 + 非标准前缀 + 孤儿快照目录。
      // 响应含 pruned（已归档/非标准）与 orphaned（registry 无记录的孤儿）。
      const result = await pruneSnapshots(env);
      sendJson(res, result.ok ? 200 : 500, result);
    }
  }));

  // 定时兜底清理：workspaceRegistry 无归档事件可监听（只有 setState），手动
  // 归档的会话快照此前只能等下次 rollback 才被惰性清理——加周期扫描，让
  // 磁盘占用只涨不落的情况自动收敛。pruneIntervalMs 为 0 时禁用（仍可手动
  // 调端点）。清理失败仅告警，不阻断对话。
  if (config.pruneIntervalMs !== 0) {
    const interval = config.pruneIntervalMs ?? 60 * 60 * 1000;
    const timer = setInterval(() => {
      pruneSnapshots(env)
        .then((result) => {
          const reclaimed = (result?.pruned?.length ?? 0) + (result?.orphaned?.length ?? 0);
          if (reclaimed > 0) {
            ctx.logger.info('chat-rollback: periodic prune reclaimed ' + reclaimed + ' snapshot dir(s)');
          }
        })
        .catch((error) => ctx.logger.warn('chat-rollback: periodic prune failed: ' + String(error)));
    }, interval);
    timer.unref?.();
    disposers.push(() => clearInterval(timer));
  }

  return () => {
    snapshotQueues.clear();
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
