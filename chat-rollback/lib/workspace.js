// dsh-plugin-chat-rollback — 工作区快照 / 哈希清单 域（生成侧）。
// 从原单文件 index.js 拆出：turn 级全量快照（find 清单 + tar -T + zstd，
// 原子写）、逐文件 SHA-256 清单（hashWorkspace / writeManifest）与破坏性恢复
// 三件套（restoreWorkspace / backupWorkspace）。底层 shell 原语 runSh/shq
// 保持模块私有；对外的两个守卫辅助（snapshotHasEntries / workspaceHasEntries）
// 供 rollback 端点做空快照判定，路由层不再直接拼 shell 命令。
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { isExcluded, findPruneExpr, tarExcludeArgs, shq } from './excludes.js';
function runSh(cmd) {
  return new Promise((done) => {
    execFile('sh', ['-c', cmd], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: error === null, error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
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
async function fsTargetExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** tar -tf 列出的内容是否非空（供空快照守卫）；列出失败返回 null，调用方按
 * 「不判定」处理（与原实现 listing.ok 失败即跳过守卫一致）。 */
async function snapshotHasEntries(snapshotFile) {
  const listing = await runSh('tar -tf ' + shq(snapshotFile));
  if (!listing.ok) return null;
  return listing.stdout.trim() !== '';
}

/** 工作区是否存在任一未被排除的条目（find 剪枝同快照清单）；失败返回 null。 */
async function workspaceHasEntries(cwd, excludes) {
  const ws = await runSh('find ' + shq(cwd) + ' ' + findPruneExpr(excludes) + '-mindepth 1');
  if (!ws.ok) return null;
  return ws.stdout.trim() !== '';
}

export { fsTargetExists, snapshotWorkspace, restoreWorkspace, backupWorkspace, hashWorkspace, writeManifest, snapshotHasEntries, workspaceHasEntries };
