// dsh-plugin-command-setting — 命令隐藏 域。
// 从原单文件 index.js 拆出：命令名规约与保护集（COMMAND_NAME / DEFAULT_HIDDEN /
// PROTECTED / cleanHidden）、菜单过滤安装（shadowCommandList）、已知命令面全集
// （collectKnown）与幽灵隐藏归档清理（sweepArchived）。全部经 env 读写共享状态
// （ctx / original 未过滤视图 / hiddenSet / scope / notifyChange），由 index 装配。

// System commands that can never be hidden: enforced on every read and write,
// so even a hand-edited settings.yaml cannot hide them. 'ask' is provided by
// this plugin itself — hiding it would remove the only way to leave ask mode.
const PROTECTED = ['plan', 'goal', 'ask'];
const cleanHidden = (list) => list.filter((entry) => !PROTECTED.includes(entry));
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const DEFAULT_HIDDEN = ['export', 'feedback', 'permission'];

/** 安装实例级命令面过滤（把 hidden 命令从 menu 的 list 视图里滤掉）。
 * 捕获未过滤的 original 供设置页/清理使用；返回的恢复函数在 dispose 时还原，
 * 保证停用后命令菜单与启用前一致（stop/start 循环不叠加过滤）。 */
function shadowCommandList(env) {
  const service = env.ctx.commands;
  // Instance-level shadow: the Typert gateway resolves RPC methods on the live
  // service instance (Reflect.get(receiver, implementation)), so this own
  // property is exactly what remote.commands.list ends up calling. The original
  // is restored on dispose so a stop/start cycle never stacks filters and a
  // stopped plugin leaves the menu exactly as it found it.
  const original = service.list.bind(service);
  env.original = original;
  service.list = (agent) => original(agent).filter((descriptor) => !env.hiddenSet.has(descriptor.name));
  return () => {
    service.list = original;
  };
}

/** 当前「已知命令面」全集：浏览器贡献命令（客户端上报，如 /model）∪ 全局
 * 注册 ∪ 所有 live 会话的 agent 注册。贡献命令只存在于浏览器（commandUi.live.
 * contributions），node 端命令面看不到它们——全集必须并入客户端上报的名单，
 * 否则 /model 这类贡献命令的 hidden 会被当成幽灵清掉。命令面不可靠（服务
 * 缺失/任一 agent 读取失败）时返回 null——宁可不清，避免误删。 */
function collectKnown(env, contributions) {
  const names = new Set(contributions ?? []);
  try {
    for (const descriptor of env.original(undefined)) names.add(descriptor.name);
  } catch {
    return null;
  }
  let sessions;
  try {
    sessions = env.ctx.sessions?.list?.();
  } catch {
    return null;
  }
  if (sessions === undefined) return null;
  for (const session of sessions ?? []) {
    const id = session?.id;
    if (typeof id !== 'string') continue;
    let agent;
    try {
      agent = env.ctx.agents.get(id);
    } catch {
      continue;
    }
    if (agent === undefined) continue;
    try {
      for (const descriptor of env.original(agent)) names.add(descriptor.name);
    } catch {
      // 单个 agent 命令面读取失败：全集不完整，保守放弃本次清理
      return null;
    }
  }
  return names;
}

/** 归档清理：hidden 中已不在已知命令面的条目（命令被卸载/更名后的残留）
 * 主动移除并持久化。只清理「命令面可信」的情况——客户端已上报贡献命令
 * （contributions 参数存在）、存在 ≥1 个 live 会话（agent 面至少覆盖当前
 * 会话）、collectKnown 非 null。否则一律不清，保证有效隐藏永不丢失。
 * 只在确有幽灵条目时才写入 settings，避免频繁写。 */
async function sweepArchived(env, contributions) {
  try {
    if (contributions === null || contributions === undefined) return; // 贡献面未知
    const sessions = env.ctx.sessions?.list?.();
    if (!Array.isArray(sessions) || sessions.length === 0) return; // 无 live 会话，agent 面缺失
    const known = collectKnown(env, contributions);
    if (known === null) return;
    const current = cleanHidden([...env.hiddenSet]);
    const survivors = current.filter((entry) => known.has(entry));
    if (survivors.length === current.length) return;
    env.hiddenSet = new Set(survivors);
    env.ctx.logger.info('command-setting: swept archived hidden entries: ' + current.filter((e) => !survivors.includes(e)).join(', '));
    if (env.scope !== null) await env.scope.update({ hidden: survivors });
    env.notifyChange();
  } catch (error) {
    env.ctx.logger.warn('command-setting: sweep archived hidden entries failed: ' + String(error?.message ?? error));
  }
}

export { PROTECTED, cleanHidden, COMMAND_NAME, DEFAULT_HIDDEN, shadowCommandList, collectKnown, sweepArchived };
