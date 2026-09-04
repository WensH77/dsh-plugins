// dsh-plugin-chat-rollback — 会话事件日志 域（纯读取与目标解析，无 IO）。
// 从原单文件 index.js 拆出：alpha.4 事件日志读取（sessionEvents）、预设 id
// 解析（resolvePresetId）、turn 归属（turnOf）、DOM 消息 key → 事件 seq 反查
// （resolveSeqByMessageKey）与回滚点解析（resolveRollbackTarget）。preflight /
// rollback / fork 继承共用这些判定，保证「回滚到哪」三处结论一致。
/** 会话事件日志读取。dsh-session 0.1.2-alpha.4 起 `Session.events` getter 被移除
 * （事件日志私有化，公开读取为 snapshotEvents()/ownEvents()）；旧宿主（rc 线/
 * alpha.3）仍暴露 `.events`。优先 alpha.4 面，回退 `.events`。 */
function sessionEvents(session) {
  if (session === null || typeof session !== 'object') return [];
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snapshot = session.snapshotEvents();
      return Array.isArray(snapshot) ? snapshot : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(session.events) ? session.events : [];
}

/** 源会话的 agent preset id。dsh-agent-presets 0.1.2-alpha.4 不再导出
 * resolveSessionPreset；预设 id 现在由会话自身携带——alpha.4 起持久化在
 * `SessionHeader.agentPreset`，历史上也以 `agent-preset/selected` 事件记录。
 * 优先取最近一次选择事件（与旧 resolveSessionPreset 语义一致），回退 header。 */
function resolvePresetId(session) {
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'agent-preset/selected') {
      const id = event.data?.agentPreset;
      if (typeof id === 'string' && id !== '') return id;
    }
  }
  return session?.header?.agentPreset;
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
    nextInput = messageText(targetEvent?.data?.content);
  } else {
    for (const event of events.slice(cut)) {
      if (event.type !== 'user/message') continue;
      nextInput = messageText(event.data?.content);
      break;
    }
  }
  return { beforeMessage, cut, seed, turn, nextInput };
}
/** Resolve a rollback seq from the client chat-node message key. The DOM
 * anchor key is "<turn>:input-message<uuid>"; the uuid equals the host
 * user/message event's data.id (messageDefinition.id in ui-chat), so the
 * returned index lands on the same event the pre-alpha.4 anchorSeq targeted.
 * Returns -1 when no event carries the id. seq 参数保留原语义（旧调用方/测试）。 */
function resolveSeqByMessageKey(events, rawKey) {
  let id = String(rawKey ?? '');
  const at = id.lastIndexOf(':');
  if (at !== -1) id = id.slice(at + 1);
  id = id.replace(/^input-message/i, '');
  if (id === '') return -1;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const data = event?.data;
    const evId = data?.id ?? data?.messageId ?? event?.id;
    if (evId !== undefined && String(evId) === id) return i;
  }
  return -1;
}


/** 拼接 user/message 事件 content 的文本段为预填输入串（回滚后 prefill）。 */
function messageText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export { sessionEvents, resolvePresetId, turnOf, resolveSeqByMessageKey, resolveRollbackTarget };
