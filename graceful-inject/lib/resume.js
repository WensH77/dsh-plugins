/**
 * 优雅注入 · 功能一：续跑（resume）。
 *
 * 崩溃、被强杀或关闭超时退出后，本轮被补记为 `interrupted` 的那个会话，在**恢复时**
 * 自动接着跑：宿主投递一条带来源标记的「继续」。
 *
 * 两个触发面：
 *
 *   1. 会话被打开/恢复时（`agent/created`）：读该会话在内存里的事件（`ownEvents()`），
 *      看最后一条 `turn/end` 的 reason。`interrupted` 只会在恢复未闭合轮次时出现——
 *      运行中的 Agent 循环从不现场发它——所以这个判断天然幂等：续跑本身会开出新的
 *      一轮，把「最后一条 turn/end」推进到 completed，下次恢复就不会再触发。
 *
 *   2. 宿主启动时：上次进程崩溃/被强杀时正在跑的那一轮会留在磁盘上（有 `turn/start`
 *      没有 `turn/end`）。插件在每一轮开始/结束时维护一份运行标记
 *      （`<DSH_HOME>/graceful-inject/running/<sessionId>`），启动后扫描这些标记，
 *      读磁盘日志确认确实停在一轮中间，再交给 `sessionController.resolveAgent`
 *      把会话后台接管起来——用户不需要先点开那个会话。
 *
 * 为什么不在 `session/event` 里判断中断：崩溃遗留轮次的收尾是 agent-loop 在 resume 时
 * 直接追加到持久化文件、并以 seed 形式建进 Session 的（见 dsh-agent-loop 的 resume 流程），
 * 既不经过 `Session.append`，seed 也不发 `session/event`。所以在事件流上永远看不到它。
 *
 * 投递走 `agent.followup(...)`：这是一轮新的、普通的工作，不是对当前步骤的干预。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SOURCE_KIND } from './source.js';
import { NOTICE_PREFIX } from './supervise.js';

/** 自动投递的正文（模型看得到的那半句）。模型两种都懂，这里跟 UI 默认语言走中文。 */
const TEXT = '继续';
/**
 * 注入正文：和监工共用同一句来源说明，再接「继续」。
 *
 * `source` 只影响 Chat 的渲染；模型只看到正文。不写来源说明，模型会把插件注入当成
 * 用户手打的要求——和监工的理由一样。
 */
const BODY = NOTICE_PREFIX + TEXT;
/** 等 Agent 就绪的轮询间隔与上限（约 10 秒）。 */
const RETRY_MS = 250;
const RETRY_LIMIT = 40;
/** 启动扫描的延迟：等宿主把 sessionController / sessionPersistence 装配完。 */
const BOOT_SCAN_DELAY_MS = 2500;
/** 运行标记目录（相对 DSH_HOME）：本轮正在运行的会话，每个会话一个文件。 */
const MARKER_DIR = 'graceful-inject/running';
/** 标记文件名就是会话 id：宿主其它端点也用这个形状。 */
const MARKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 解析 DSH 家目录，与宿主 `dsh-home-paths` 的 `resolveDshHome` 同口径：
 * `DSH_HOME`（空白视为未设置）优先，其次 `~/.dsh`；`~` 前缀展开，最终转成绝对路径。
 * 标记必须落在宿主实际使用的 `$DSH_HOME` 下，所以这里不能自己另立一套路径规则。
 *
 * @param env - 环境变量表（测试注入）。
 * @param home - 用户家目录（测试注入）。
 * @returns 绝对路径。
 */
function dshHomePath(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const root = configured === '' ? join(home, '.dsh') : configured;
  return resolve(expandHomePath(root, home));
}

/** 展开路径开头的 `~` / `~/` / `~\`（与宿主 `expandHomePath` 一致）。 */
function expandHomePath(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

/** 运行标记目录的绝对路径。测试用临时 DSH_HOME 隔离。 */
function markerDirectory(env = process.env, home = homedir()) {
  return join(dshHomePath(env, home), MARKER_DIR);
}

/**
 * 运行标记存储：`<DSH_HOME>/graceful-inject/running/<sessionId>`。
 *
 * 文件内容是 `{ pid, at }`：pid 用来判断写标记的进程是否还活着（同一份 DSH_HOME 可能被
 * 多个 dsh 进程共用）；at 用来和本进程启动时间对比，区分「插件热重载时本进程写的」和
 * 「pid 被复用成新进程的旧标记」。写标记用「临时文件 + rename」，崩溃时不会留下
 * 半个 JSON。
 *
 * @param ctx - 宿主上下文（只用 logger）。
 * @param directory - 标记目录，缺省按 DSH_HOME 现算。
 * @returns `{ directory, pathOf, mark, unmark, unmarkIfUnchanged, list }`。
 */
function createMarkerStore(ctx, directory = markerDirectory()) {
  const warn = (text) => ctx.logger.warn('graceful-inject: ' + text);
  const pathOf = (sessionId) => {
    if (typeof sessionId !== 'string' || !MARKER_NAME.test(sessionId)) return undefined;
    return join(directory, sessionId);
  };
  /**
   * 删除一个会话的标记。这一轮正常收尾（completed / aborted / error）时用。
   * @param sessionId - 会话 id。
   * @returns 是否删掉了一个标记。
   */
  const unmark = (sessionId) => {
    const path = pathOf(sessionId);
    if (path === undefined) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      warn('运行标记删除失败（下次启动会再校验一遍）: ' + String(error?.message ?? error));
      return false;
    }
  };
  return {
    directory,
    pathOf,
    /**
     * 记下「这个会话正在跑一轮」。写失败只记 warn：标记是附加信息，不能影响轮次。
     * @param sessionId - 会话 id。
     * @returns 是否写入成功。
     */
    mark(sessionId) {
      const path = pathOf(sessionId);
      if (path === undefined) return false;
      // 点开头，避免 list() 把临时文件当成会话标记。
      const temporary = join(directory, '.tmp-' + process.pid + '-' + sessionId);
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporary, JSON.stringify({ pid: process.pid, at: Date.now() }));
        renameSync(temporary, path);
        return true;
      } catch (error) {
        // rename 失败时临时文件可能还在；顺手清掉，别让失败重试越积越多。
        try {
          unlinkSync(temporary);
        } catch {
          // 已不存在就算了。
        }
        warn('运行标记写入失败（不影响当前轮次）: ' + String(error?.message ?? error));
        return false;
      }
    },
    unmark,
    /**
     * 只在标记仍是 caller 读到的那个时才删（比对 pid + at）。
     *
     * 启动扫描读标记后要 `await` 读磁盘日志，这期间用户可能刚好点开同一个会话：
     * resume 会把 closers 写进磁盘、新轮 `turn/start` 又把标记改写成本进程的。此时不能按
     * 「旧标记」（已收尾 / 应删除）把刚写的新标记删掉，否则这次运行再崩就没人记得它了。
     *
     * @param entry - `list()` 返回的条目。
     * @returns 是否删掉了标记。
     */
    unmarkIfUnchanged(entry) {
      const path = pathOf(entry?.sessionId);
      if (path === undefined) return false;
      let record;
      try {
        record = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return false;
      }
      if (record?.pid !== entry.pid || record?.at !== entry.at) return false;
      return unmark(entry.sessionId);
    },
    /**
     * 读全部标记。坏文件按「pid 未知、时间未知」返回，让启动扫描去校验磁盘日志。
     * @returns `[{ sessionId, pid, at }]`。
     */
    list() {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        warn('运行标记目录读不了: ' + String(error?.message ?? error));
        return [];
      }
      const out = [];
      for (const entry of entries) {
        if (!entry.isFile() || !MARKER_NAME.test(entry.name)) continue;
        let record;
        try {
          record = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
        } catch {
          record = undefined;
        }
        out.push({
          sessionId: entry.name,
          pid: Number.isInteger(record?.pid) && record.pid > 0 ? record.pid : 0,
          at: Number.isFinite(record?.at) ? record.at : 0
        });
      }
      return out;
    }
  };
}

/** 组装那条「继续」消息。导出一份便于测试直接断言。 */
function continueMessage(text = BODY) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    // 自定义来源：Chat 据此渲染成触发条目，而不是用户气泡。
    source: { kind: SOURCE_KIND, form: 'notice', summary: boundContextSummary(text) }
  });
}

/**
 * 读一个会话最后一条 `turn/end` 的 reason。
 *
 * 按顺序扫一遍事件，跟踪未闭合的 turn。最后一条 turn 还没结束时返回 undefined——那是
 * 运行中或刚中断尚未收尾，不该自动续跑。
 *
 * @param session - 会话对象（需要 `ownEvents()`）。
 * @returns reason.kind（`interrupted` / `completed` / …），或 undefined。
 */
function lastTurnEndReason(session) {
  if (typeof session?.ownEvents !== 'function') return undefined;
  let openTurn;
  let lastReason;
  for (const event of session.ownEvents()) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn;
    } else if (event.type === 'turn/end') {
      lastReason = event.data?.reason?.kind;
      if (openTurn === event.data.turn) openTurn = undefined;
    }
  }
  return openTurn === undefined ? lastReason : undefined;
}

/**
 * 事件序列是否停在一轮中间（有 turn/start 没有配对的 turn/end）。
 *
 * 和 {@link lastTurnEndReason} 的区别：那个读内存 Session 的最后 reason，这个只看
 * 「有没有未闭合的 turn」，用于判断磁盘日志是不是崩溃遗留。
 *
 * @param events - 事件数组（磁盘日志或 `ownEvents()`）。
 * @returns 是否有一轮没有收尾。
 */
function hasOpenTurn(events) {
  if (!Array.isArray(events)) return false;
  let open = false;
  for (const event of events) {
    if (event?.type === 'turn/start') open = true;
    else if (event?.type === 'turn/end') open = false;
  }
  return open;
}

/** pid 是否还活着。拿不到权限（EPERM）也算活着；0/非整数当死进程。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 本进程的启动时间（Unix 毫秒）。
 *
 * 标记里的 pid 可能是热重载时本进程自己写的，也可能是上一次进程写的。光比 pid 不够：
 * pid 被复用成新进程的 pid 时，旧标记会被误当成「本进程的」。用标记时间与启动时间
 * 区分：本轮写的一定晚于启动时间。
 */
function processStartedAt() {
  return Date.now() - process.uptime() * 1000;
}

/**
 * 创建续跑控制器。导出以便测试用假 ctx 驱动，不必起宿主进程。
 *
 * @param ctx - 携带 agents / sessions / timer 的宿主上下文。
 * @returns `{ arm, onCreated, armed, fired }`；`onCreated(agent)` 在 Agent 就绪时判断是否续跑。
 */
function createResumeController(ctx) {
  /** 本进程里登记过的会话（同一进程只处理一次）。 */
  const armed = new Set();
  /** 已经投递过的会话，防重复。 */
  const fired = new Set();

  const deliver = async (sessionId, agent) => {
    fired.add(sessionId);
    try {
      agent.followup(continueMessage());
      await ctx.sessions.flush(agent.session);
      ctx.logger.info('graceful-inject: 已为中断的会话 ' + sessionId + ' 自动续跑');
    } catch (error) {
      // 保持 fired：一次失败不重试，避免和崩溃循环互相喂饭。
      ctx.logger.warn('graceful-inject: 自动续跑失败 ' + sessionId + ': ' + String(error?.message ?? error));
    }
  };

  /** 等目标会话的 Agent 就绪后投递；Agent 已在跑就不打扰。 */
  const waitAndDeliver = (sessionId) => {
    let attempts = 0;
    const tick = () => {
      if (fired.has(sessionId)) return;
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) {
        attempts += 1;
        if (attempts > RETRY_LIMIT) {
          ctx.logger.warn('graceful-inject: 会话 ' + sessionId + ' 的 Agent 迟迟没有就绪，放弃自动续跑');
          return;
        }
        ctx.timeout(tick, RETRY_MS);
        return;
      }
      if (agent.status === 'running') {
        // 恢复后已经在跑（例如用户同时手动发了消息），不重复投递。
        fired.add(sessionId);
        return;
      }
      void deliver(sessionId, agent);
    };
    tick();
  };

  /**
   * 登记一个会话。
   * @param sessionId - 会话 id。
   */
  const arm = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '' || armed.has(sessionId)) return;
    armed.add(sessionId);
    waitAndDeliver(sessionId);
  };

  /**
   * Agent 就绪时判断：这个会话是否因崩溃停在了半路。
   * @param agent - 新建或恢复的 Agent。
   */
  const onCreated = (agent) => {
    const session = agent?.session;
    if (session === undefined) return;
    // 子代理会话由父代理驱动，不掺和。
    if (session.header?.origin === 'subagent') return;
    if (lastTurnEndReason(session) !== 'interrupted') return;
    arm(agent.id);
  };

  return { arm, onCreated, armed, fired };
}

/** 磁盘日志读不了的错误里，这些是确定性的失败：重试多少次都一样，删标记。 */
const TERMINAL_READ_ERRORS = new Set([
  'SessionPersistenceNotFoundError',
  'SessionFormatUnsupportedError',
  'SessionPersistenceCorruptionError'
]);

/**
 * `resolveAgent` 的失败里，这些是确定性的：会话真的不存在就不用再托了。其它错误
 * （`gateway/internal`、`agent-busy`、`writer-held` 等）都当瞬态，保留标记下次启动重试。
 */
const TERMINAL_RESUME_ERRORS = new Set(['session/not-found']);

/**
 * 读一条磁盘日志（只读句柄，不拿写所有权）。
 * @param persistence - `ctx.sessionPersistence`。
 * @param sessionId - 会话 id。
 * @returns `{ header, events }`。
 */
async function readStoredLog(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read');
  try {
    return { header: handle.header, events: (await handle.read(0)).events };
  } finally {
    await handle.close();
  }
}

/**
 * 启动扫描：处理上次进程留下的运行标记。
 *
 * 每个标记都要过一遍磁盘日志：只有确实停在 `turn/start` 之后（没有 `turn/end`）的会话才
 * 交给宿主接管。已经收尾的标记直接删掉，避免每次启动都重新检查。
 *
 * 跳过的情况：
 *   - 本进程已经有同名 Agent（可能是客户端刚把它打开，或插件热重载）；
 *   - 标记是本进程本轮写的（插件热重载；pid 相同但时间早于本进程启动的，按 pid 复用处理）；
 *   - 写标记的 pid 还活着（同一份 DSH_HOME 下另一个 dsh 进程正在跑它）；
 *   - 会话已归档（用户明确收进归档，不该被叫醒）。
 *
 * @param ctx - 宿主上下文。
 * @param controller - 续跑控制器（这里不直接用；投递仍由 `agent/created` 触发）。
 * @param markers - {@link createMarkerStore} 的返回值。
 * @returns `{ scanned, resumed }`：扫描了几个标记、接管了几个会话。
 */
async function scanLeftoverMarkers(ctx, controller, markers) {
  const entries = markers.list();
  if (entries.length === 0) return { scanned: 0, resumed: [] };
  const sessionController = ctx.get('sessionController');
  const persistence = ctx.get('sessionPersistence');
  if (typeof sessionController?.resolveAgent !== 'function' || persistence === undefined) {
    ctx.logger.info('graceful-inject: 启动扫描跳过（没有 sessionController / sessionPersistence）');
    return { scanned: entries.length, resumed: [] };
  }
  const archived = ctx.get('workspaceRegistry')?.archivedSessionIds;
  const resumed = [];
  for (const entry of entries) {
    const sessionId = entry.sessionId;
    if (ctx.agents.get(sessionId) !== undefined) continue;
    // 本进程本轮写的标记（热重载）跳过；同一个 pid 但早于本进程启动的，是 pid 复用，按上次进程处理。
    const writtenByThisRun = entry.pid === process.pid && (entry.at === 0 || entry.at >= processStartedAt());
    if (writtenByThisRun) continue;
    // 别的还活着的进程正在跑它——pid 复用（pid 等于本进程）不算「别人活着」。
    if (entry.pid !== process.pid && isProcessAlive(entry.pid)) continue;
    if (Array.isArray(archived) && archived.includes(sessionId)) {
      markers.unmarkIfUnchanged(entry);
      continue;
    }
    let stored;
    try {
      stored = await readStoredLog(persistence, sessionId);
    } catch (error) {
      if (TERMINAL_READ_ERRORS.has(error?.name)) {
        // 会话被删了 / 格式迁移需要 / 日志损坏：重试没有意义，删标记别每次启动都刷 warn。
        ctx.logger.warn('graceful-inject: 启动扫描放弃会话 ' + sessionId + '（' + String(error?.name) + '），删掉标记');
        markers.unmarkIfUnchanged(entry);
        continue;
      }
      // 其它读失败（I/O 等）保留标记：下次启动再试，不把一次失败当成「已经收尾」。
      ctx.logger.warn('graceful-inject: 启动扫描读不到会话 ' + sessionId + ' 的日志（保留标记）: ' + String(error?.message ?? error));
      continue;
    }
    if (stored.header?.origin === 'subagent' || stored.header?.cwd === undefined || !hasOpenTurn(stored.events)) {
      markers.unmarkIfUnchanged(entry);
      continue;
    }
    try {
      const result = await sessionController.resolveAgent(sessionId);
      if (result?.error !== undefined) {
        // 只有「会话真的不存在」才删标记；gateway/internal、agent-busy、writer-held 等
        // 都是瞬态失败，删了就等于这次运行再崩也不会后台接管——保留，下次启动重试。
        const terminal = TERMINAL_RESUME_ERRORS.has(result.error?.code);
        ctx.logger.warn('graceful-inject: 启动扫描接管会话 ' + sessionId + ' 失败（' + String(result.error?.code ?? 'unknown') + (terminal ? '，删掉标记' : '，保留标记') + '）: ' + String(result.error?.message ?? result.error));
        if (terminal) markers.unmarkIfUnchanged(entry);
        continue;
      }
      // 标记先留着：续跑会开新的一轮，等它的 turn/end 再删；万一这中间又崩了，
      // 下一次启动还能凭这个标记接着接管。
      resumed.push(sessionId);
      ctx.logger.info('graceful-inject: 启动扫描已接管上次运行中的会话 ' + sessionId + '，等待自动续跑');
    } catch (error) {
      // 抛错同样按瞬态处理：保留标记，下次启动再试。
      ctx.logger.warn('graceful-inject: 启动扫描接管会话 ' + sessionId + ' 抛错（保留标记）: ' + String(error?.message ?? error));
    }
  }
  return { scanned: entries.length, resumed };
}

/**
 * 注册续跑监听。绑在插件 ctx 生命周期上，停用即回收。
 * @param ctx - 宿主上下文（携带 agents / sessions / timer）。
 * @returns 释放函数。
 */
function mountResume(ctx) {
  const controller = createResumeController(ctx);
  const markers = createMarkerStore(ctx);

  // 这个事件是 serial 且被 await 的：监听器抛错会让会话创建失败（宿主文档：
  // "A throw or rejection fails creation"）。续跑只是附加行为，判定出错也必须
  // 让会话照常打开，所以这里自己吞掉异常并记一条 warn。
  const offCreated = ctx.on('agent/created', ({ agent }) => {
    try {
      controller.onCreated(agent);
    } catch (error) {
      ctx.logger.warn('graceful-inject: 续跑判定失败（会话照常打开）: ' + String(error?.message ?? error));
    }
  });

  // 每一轮开始/结束维护运行标记；进程正常退出也不清（留下来是有意的：崩溃时就靠它）。
  // 异常同样只记 warn，不能影响轮次本身。
  const offEvents = ctx.on('session/event', (session, event) => {
    try {
      if (session?.header?.origin === 'subagent') return;
      if (event?.type === 'turn/start') markers.mark(session.id);
      else if (event?.type === 'turn/end') markers.unmark(session.id);
    } catch (error) {
      ctx.logger.warn('graceful-inject: 运行标记更新失败（不影响当前轮次）: ' + String(error?.message ?? error));
    }
  });

  // 插件在会话运行中被加载/热重载：此时不会有新的 turn/start 事件，把正在跑的会话补记一遍。
  try {
    const live = typeof ctx.agents.list === 'function' ? ctx.agents.list() : [];
    for (const agent of live) {
      try {
        if (agent?.session?.header?.origin === 'subagent') continue;
        if (hasOpenTurn(agent?.session?.ownEvents?.() ?? [])) markers.mark(agent.id);
      } catch {
        // 单个会话读不了不影响其它会话。
      }
    }
  } catch (error) {
    ctx.logger.warn('graceful-inject: 补记正在运行的会话失败: ' + String(error?.message ?? error));
  }

  // 启动扫描：上次进程留下的标记 = 崩溃/重启时正在跑的会话。等 sessionController /
  // sessionPersistence 就绪（冷启动时它们可能比插件晚）再延迟一小段，避免和启动流程抢会话。
  // 两个服务都缺席的部署（例如纯 headless）不会跑这个回调，标记就留到下次有能力的启动。
  // `ctx.inject` 返回的是子 Fiber（随插件 fiber 一起卸载），不是 disposer，这里不手动释放。
  ctx.inject(['sessionController', 'sessionPersistence'], (scanCtx) => {
    scanCtx.timeout(() => {
      void scanLeftoverMarkers(scanCtx, controller, markers).catch((error) => {
        scanCtx.logger.warn('graceful-inject: 启动扫描失败: ' + String(error?.message ?? error));
      });
    }, BOOT_SCAN_DELAY_MS);
  });

  ctx.logger.info('graceful-inject: 功能一 resume 已启用（恢复中断轮次后自动续跑「' + TEXT + '」；启动时接管上次运行中的会话）');
  return () => {
    offCreated();
    offEvents();
  };
}

export {
  BODY,
  BOOT_SCAN_DELAY_MS,
  continueMessage,
  createMarkerStore,
  createResumeController,
  dshHomePath,
  hasOpenTurn,
  isProcessAlive,
  lastTurnEndReason,
  MARKER_DIR,
  markerDirectory,
  mountResume,
  processStartedAt,
  scanLeftoverMarkers,
  TEXT
};
