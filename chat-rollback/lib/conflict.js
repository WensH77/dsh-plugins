// dsh-plugin-chat-rollback — 回滚冲突 域（读侧清单比对）。
// 从原单文件 index.js 拆出：manifest 读侧工具（loadManifest / manifestState /
// latestManifestFile / END_MANIFEST）、双 manifest 差异判定（computeConflicts）
// 与一次回滚的冲突状态（rollbackConflictState）。preflight 与 rollback 共用
// 同一判定，保证「该回滚是否会覆盖其他会话的写入」两处结论一致（并收窄
// preflight→执行之间的 TOCTOU 窗口）。写侧清单生成在 workspace.js。
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isExcluded } from './excludes.js';
import { hashWorkspace } from './workspace.js';

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

export { rollbackConflictState };
