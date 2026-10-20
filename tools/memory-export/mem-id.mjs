#!/usr/bin/env node
/**
 * 稳定记忆 id（mem_id）的唯一定义处。
 *
 *   mem_id = sha256(session_id + '\0' + seq + '\0' + 归一化 evidence) 的前 16 个十六进制字符
 *   归一化 = trim + 连续空白折叠成单个空格（与 eval-set 里 statement_hash 的口径一致，
 *   但输入不同：statement_hash 用 statement，mem_id 用 evidence）。
 *
 * vec0 只接受整数 rowid，所以取 mem_id 的前 16 位十六进制转 int64，并清掉符号位
 * （SQLite 的 rowid 是有符号 64 位整数）。这一步有碰撞可能（两个 mem_id 只差最高位），
 * 调用方写入前必须用 assertRowidUnique() 检查并报错。
 *
 * 同一 session_id + seq + evidence 在蒸馏结果里可能抽出两条不同 statement 的记忆
 * （实测 9,044 条里有 2 组）。这属于「同一输入」而不是 sha256 前缀碰撞，不能丢掉其中
 * 一条，所以对这类记录用 base + 归一化 statement + kind 再哈希一次得到 16 位 id。
 * 该派生只影响冲突组内的记录：新增同 evidence 的第三条不会改变已有两条的 id。
 */

import crypto from 'node:crypto';

/** 空白折叠 + trim。 */
export function normalizeWs(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 记忆文本指纹：向量增量用它判断「文本没变，可以复用旧向量」。 */
export function textSha256(text) {
  return sha256Hex(text);
}

/** 基础 mem_id（未处理同 evidence 冲突）。 */
export function baseMemId(sessionId, seq, evidence) {
  const input = `${sessionId}\u0000${seq ?? ''}\u0000${normalizeWs(evidence)}`;
  return sha256Hex(input).slice(0, 16);
}

/** 同 evidence 冲突时的派生 id；只依赖记录自身字段。 */
export function derivedMemId(base, statement, kind) {
  const input = `dup\u0000${base}\u0000${kind ?? ''}\u0000${normalizeWs(statement)}`;
  return sha256Hex(input).slice(0, 16);
}

function dieOnDuplicateIds(ids, label) {
  const seen = new Map();
  for (const { memId, where } of ids) {
    const prev = seen.get(memId);
    if (prev) {
      const err = new Error(
        `${label}：mem_id ${memId} 同时对应两条记录\n  A: ${prev}\n  B: ${where}`,
      );
      err.code = 'MEM_ID_COLLISION';
      throw err;
    }
    seen.set(memId, where);
  }
}

/**
 * 给记录分配 mem_id（就地写 rec.mem_id），返回冲突信息。
 * @param {Array<{session_id:string, seq:number|null, evidence:string, statement:string, kind:string|null}>} records
 */
export function assignMemIds(records) {
  const groups = new Map();
  for (const rec of records) {
    const base = baseMemId(rec.session_id, rec.seq, rec.evidence);
    let group = groups.get(base);
    if (!group) {
      group = [];
      groups.set(base, group);
    }
    group.push(rec);
  }

  const duplicateGroups = [];
  for (const [base, group] of groups) {
    if (group.length === 1) {
      group[0].mem_id = base;
      continue;
    }
    duplicateGroups.push({
      base,
      records: group.map((r) => ({
        session_id: r.session_id,
        seq: r.seq,
        kind: r.kind,
        statement: r.statement,
      })),
    });
    for (const rec of group) rec.mem_id = derivedMemId(base, rec.statement, rec.kind);
  }

  dieOnDuplicateIds(
    records.map((r) => ({
      memId: r.mem_id,
      where: `session=${r.session_id} seq=${r.seq} statement=${String(r.statement).slice(0, 80)}`,
    })),
    'mem_id 冲突',
  );

  return { duplicateGroups };
}

/** mem_id -> vec0 的整数 rowid（清符号位，落在 0..2^63-1）。 */
export function memIdToRowid(memId) {
  if (!/^[0-9a-f]{16}$/i.test(memId)) {
    throw new Error(`mem_id 不是 16 位十六进制: ${memId}`);
  }
  return BigInt(`0x${memId}`) & 0x7fffffffffffffffn;
}

/** 写入前检查 rowid 碰撞（两个不同的 mem_id 只差最高位）。碰撞直接抛错并打印两个 id。 */
export function assertRowidUnique(records) {
  const seen = new Map();
  for (const rec of records) {
    const rowid = memIdToRowid(rec.mem_id).toString();
    const prev = seen.get(rowid);
    if (prev) {
      const err = new Error(
        `rowid 碰撞：mem_id ${prev} 与 ${rec.mem_id} 都映射到 rowid ${rowid}`,
      );
      err.code = 'MEM_ID_ROWID_COLLISION';
      throw err;
    }
    seen.set(rowid, rec.mem_id);
  }
}

/** 输出顺序：session_id → seq（null 在前）→ mem_id，保证每次生成的 meta 可复现。 */
export function compareRecords(a, b) {
  if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
  const as = a.seq == null ? -Infinity : Number(a.seq);
  const bs = b.seq == null ? -Infinity : Number(b.seq);
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.mem_id === b.mem_id) return 0;
  return a.mem_id < b.mem_id ? -1 : 1;
}
