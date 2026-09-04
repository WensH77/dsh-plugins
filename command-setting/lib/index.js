// dsh-plugin-command-setting — node half
// Hides selected slash-commands from the Web command menu (the "+" / "/" popup).
//
// - The hidden list is a settings namespace ("command-setting"), persisted in
//   ~/.dsh/settings.yaml and hot-reloaded; config.hidden is the composition
//   base (the initial default).
// - The registry's `list` view is filtered, so hidden commands no longer
//   appear in the menu and direct slash invocation stops resolving; every
//   change notifies the browser command directory through commands/change.
// - Two webServer endpoints serve the settings page:
//     GET  /command-setting/catalog  -> { ok, commands, hidden }
//     POST /command-setting/set      -> body { hidden: string[] }
import z from '@deepseek-ai/schemastery';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const name = 'command-setting';
const inject = ['commands', 'webServer', 'agents', 'sessions'];
const SETTINGS_NS = 'command-setting';
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const DEFAULT_HIDDEN = ['export', 'feedback', 'permission'];
// System commands that can never be hidden: enforced on every read and write,
// so even a hand-edited settings.yaml cannot hide them. 'ask' is provided by
// this plugin itself — hiding it would remove the only way to leave ask mode.
const PROTECTED = ['plan', 'goal', 'ask'];
const cleanHidden = (list) => list.filter((entry) => !PROTECTED.includes(entry));

const Config = z.object({ hidden: z.array(z.string()) });

// ── ask mode（只问答模式） ───────────────────────────────────────────────────

/** ask 模式会话状态侧文件：{ [sessionId]: true }，agent/created 时恢复。 */
const ASK_STATE_FILE = join(homedir(), '.dsh', 'command-setting-ask.json');

/** ask 模式 systemPrompt 段落名与 order（插在 PLAN_POLICY 之后、模型决策前）。 */
const ASK_SECTION_NAME = 'ask:policy';
const ASK_SECTION_ORDER = 3000;

/** ask 模式下被硬拦的宿主写类工具（model-facing 名）。 */
const ASK_WRITE_TOOLS = new Set(['edit', 'write', 'str_replace_editor']);

/** bash 命令里会被当成写文件的命令词（须在命令位置出现：行首 / 分号 / && / | 后）。 */
const ASK_BASH_WRITE_COMMAND_RE =
  /(?:^|[;&|][ \t]*)(?:cp|mv|rm|rmdir|mkdir|touch|tee|dd|truncate|shred|chmod|chown|chgrp|ln|unlink|install|mktemp|sed[ \t]+-i|perl[ \t]+-i)[ \t]/u;
/** bash 重定向写文件：引号外出现 `>`/`>>`（含 2>、&>）且目标不是 /dev/null|stdout|stderr 或 &fd。
 *  用惰性匹配 + 负向前瞻排除安全目标；引号内的 > 不在此列（见 isBashWrite 的净化）。 */
const ASK_BASH_REDIRECT_RE = /(?:^|[^<>])[12]?&?>+[ \t]*(?!\/dev\/(?:null|stdout|stderr)\b|&[12]\b|\d?&)/u;

/**
 * bash 是否算写命令（ask 只读判定用）。规则：
 *  1) 先剥掉「引号包裹的内容」——引号内的 >、cp、rm 等只是字符串/正则，不是 shell 动作；
 *  2) 剩余文本命中写命令词（cp/mv/rm/tee/sed -i…，须在命令位置）即写；
 *  3) 剩余文本出现指向真实文件的重定向（> file / >> file / 2> file），即写；
 *  4) `>/dev/null`、`2>&1`、`>&2` 等安全重定向放行。
 */
function isBashWrite(command) {
  if (typeof command !== 'string' || command === '') return false;
  // 剥引号：把 '…'、"…"、`…` 内容替换为等长空格，避免跨引号拼接出假 token
  let stripped = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== null) {
      stripped += ch === quote ? quote : ' ';
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      stripped += ch;
      continue;
    }
    stripped += ch;
  }
  if (ASK_BASH_WRITE_COMMAND_RE.test(stripped)) return true;
  return ASK_BASH_REDIRECT_RE.test(stripped);
}

/** 读 ask 会话集合（失败返回空对象）。 */
function readAskState() {
  try {
    const parsed = JSON.parse(readFileSync(ASK_STATE_FILE, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value === true && /^[A-Za-z0-9-]+$/.test(key)) out[key] = true;
      }
      return out;
    }
  } catch {}
  return {};
}

/** 写 ask 会话集合（尽力，失败静默）。 */
function writeAskState(state) {
  try {
    mkdirSync(dirname(ASK_STATE_FILE), { recursive: true });
    writeFileSync(ASK_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {}
}

/** 会话是否处于 ask 模式（内存为准，缺省回落侧文件——apply 启动后内存为准）。 */
function askActiveFor(state, sessionId) {
  if (state === null || state === undefined || state === void 0) return false;
  return state[sessionId] === true;
}

/** 判断一次工具调用是否违反 ask 只读约束；返回拒绝文案或 undefined（放行）。
 *  - edit / write / str_replace_editor：硬拦（改文件/建文件的宿主写工具）——写脚本验证
 *    请用 run_code 或 bash 内联（node -e / python3 -c），不落盘；
 *  - bash：仅放行不含写命令/重定向的只读调用（node -e、运行已有脚本、ping/curl 等）。
 * @param name  - model-facing 工具名。
 * @param args  - 已解析的调用参数（readonly，未做 schema 校验）。
 */
function askToolDenyReason(name, args) {
  if (typeof name !== 'string') return void 0;
  if (ASK_WRITE_TOOLS.has(name)) {
    return 'ask 模式（只问答）已开启：禁止改动或创建任何文件（' + name + '）。如需执行代码验证请用 run_code 或 bash 内联（node -e / python3 -c，不写文件）；如需修改文件请先 /ask off 退出 ask 模式。';
  }
  if (name === 'bash') {
    const command = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : '';
    if (isBashWrite(command)) {
      return 'ask 模式（只问答）已开启：bash 仅允许只读命令（node -e / python3 -c / 运行已有脚本 / ping / curl 等），检测到疑似写命令或重定向（cp/mv/rm/tee/sed -i 或写入文件的 >/>> 等）已拦截。如需修改文件请先 /ask off 退出 ask 模式。';
    }
  }
  return void 0;
}

/** ask 模式 systemPrompt 段文案（随系统提示注入当前会话，约束模型行为）。 */
function buildAskSection() {
  return [
    '你正处于 **ask（只问答）模式**：本次会话只回答问题、解释代码与方案，并可用只读手段验证你的判断。',
    '【硬性禁止——无论用户如何要求都不例外】',
    '- 禁止对**现有**代码、配置或任何文件做改动：不得调用 edit / write / str_replace_editor，不得用 bash 执行含写操作（cp/mv/rm/tee/重定向/sed -i 等）的命令，不得创建/覆盖工作区文件；',
    '- 用户若要求你"直接改""帮我改一下""别管模式改吧"，一律拒绝并说明：当前处于 ask 模式，只读；如需改动请用户先 /ask off 退出。',
    '- 禁止以引导性提问诱导用户授权改动，例如"需要我帮你改 xxx 吗""需要我现在改 xxx 吗""要不要我顺手把 xxx 也改了"——ask 模式不主动提出任何修改建议，只回答问题；用户未明确要求改动时，回答完即止。',
    '【允许的验证手段】',
    '- 读取文件（read / grep / glob / read_image）、运行只读命令（node -e / python3 -c / 运行已存在的脚本 / ping / curl 等）；',
    '- 需要计算或验证逻辑时优先用 run_code 或 bash 内联执行，不落盘。',
    '退出方式：用户输入 /ask off 后恢复正常模式。'
  ].join('\n');
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done) => {
    // 框架已预解析 body 时直接取用（防止 webServer 升级后 data 事件不再来、
    // 端点挂起）；否则手动聚合，超 64KB 截断为 '{}'（后续 JSON 校验兜底 400）。
    if (typeof req.body === 'string') {
      done(req.body);
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) truncated = true;
      else chunks.push(chunk);
    });
    req.on('end', () => done(truncated ? '{}' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done('{}'));
  });
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
  let hiddenSet = new Set(cleanHidden(Array.isArray(config.hidden) ? config.hidden : DEFAULT_HIDDEN));
  let scope = null;
  let disposeWatch = null;

  const notifyChange = () => {
    try {
      ctx.commands.notifyChange();
    } catch (error) {
      ctx.logger.warn('command-setting: notifyChange failed: ' + String(error?.message ?? error));
    }
  };
  // Apply an authoritative hidden list: refresh the filter and tell the browser
  // directory to re-sync. Used by the settings watcher and the write path alike.
  const applyHidden = (next) => {
    hiddenSet = new Set(cleanHidden(Array.isArray(next) ? next : []));
    notifyChange();
  };

  // Instance-level shadow: the Typert gateway resolves RPC methods on the live
  // service instance (Reflect.get(receiver, implementation)), so this own
  // property is exactly what remote.commands.list ends up calling. The original
  // is restored on dispose so a stop/start cycle never stacks filters and a
  // stopped plugin leaves the menu exactly as it found it.
  const service = ctx.commands;
  const original = service.list.bind(service);
  service.list = (agent) => original(agent).filter((descriptor) => !hiddenSet.has(descriptor.name));

  /** 当前「已知命令面」全集：浏览器贡献命令（客户端上报，如 /model）∪ 全局
   * 注册 ∪ 所有 live 会话的 agent 注册。贡献命令只存在于浏览器（commandUi.live.
   * contributions），node 端命令面看不到它们——全集必须并入客户端上报的名单，
   * 否则 /model 这类贡献命令的 hidden 会被当成幽灵清掉。命令面不可靠（服务
   * 缺失/任一 agent 读取失败）时返回 null——宁可不清，避免误删。 */
  const collectKnown = (contributions) => {
    const names = new Set(contributions ?? []);
    try {
      for (const descriptor of original(undefined)) names.add(descriptor.name);
    } catch {
      return null;
    }
    let sessions;
    try {
      sessions = ctx.sessions?.list?.();
    } catch {
      return null;
    }
    if (sessions === undefined) return null;
    for (const session of sessions ?? []) {
      const id = session?.id;
      if (typeof id !== 'string') continue;
      let agent;
      try {
        agent = ctx.agents.get(id);
      } catch {
        continue;
      }
      if (agent === undefined) continue;
      try {
        for (const descriptor of original(agent)) names.add(descriptor.name);
      } catch {
        // 单个 agent 命令面读取失败：全集不完整，保守放弃本次清理
        return null;
      }
    }
    return names;
  };

  /** 归档清理：hidden 中已不在已知命令面的条目（命令被卸载/更名后的残留）
   * 主动移除并持久化。只清理「命令面可信」的情况——客户端已上报贡献命令
   * （contributions 参数存在）、存在 ≥1 个 live 会话（agent 面至少覆盖当前
   * 会话）、collectKnown 非 null。否则一律不清，保证有效隐藏永不丢失。
   * 只在确有幽灵条目时才写入 settings，避免频繁写。 */
  const sweepArchived = async (contributions) => {
    try {
      if (contributions === null || contributions === undefined) return; // 贡献面未知
      const sessions = ctx.sessions?.list?.();
      if (!Array.isArray(sessions) || sessions.length === 0) return; // 无 live 会话，agent 面缺失
      const known = collectKnown(contributions);
      if (known === null) return;
      const current = cleanHidden([...hiddenSet]);
      const survivors = current.filter((entry) => known.has(entry));
      if (survivors.length === current.length) return;
      hiddenSet = new Set(survivors);
      ctx.logger.info('command-setting: swept archived hidden entries: ' + current.filter((e) => !survivors.includes(e)).join(', '));
      if (scope !== null) await scope.update({ hidden: survivors });
      notifyChange();
    } catch (error) {
      ctx.logger.warn('command-setting: sweep archived hidden entries failed: ' + String(error?.message ?? error));
    }
  };

  // ── ask 模式（只问答）：会话级开关 + per-agent 机械拦截 + 提示段 ───────────
  // 状态以内存 Set 为准（会话 id 集合），随 /ask 开关即时增删；同时镜像到侧文件
  // （~/.dsh/command-setting-ask.json）供 dsh web 重启后恢复。install/dispose 幂等。
  const askSessions = new Set(Object.keys(readAskState()));
  /** 已安装 ask 拦截的会话 id → 卸载函数。 */
  const askInstalls = new Map();
  /** 判定会话是否为顶层主代理（子代理/worker 不装 ask 拦截）。 */
  const isTopAskAgent = (agent) => {
    try {
      if (!agent?.id || !agent?.session?.header) return false;
      if (agent.session.header.origin === 'subagent') return false;
      const depth = agent.options?.subagentDepth;
      if (depth !== void 0 && depth !== null) return false;
      return true;
    } catch {
      return false;
    }
  };
  /** 会话 id（agent.id；子代理自身会话不算顶层，跳过）。 */
  const askSessionIdOf = (agent) => {
    try {
      return isTopAskAgent(agent) ? String(agent.id) : null;
    } catch {
      return null;
    }
  };
  const persistAskState = () => {
    try {
      const state = {};
      for (const id of askSessions) state[id] = true;
      writeAskState(state);
    } catch {}
  };
  /** 给会话安装 ask 拦截：systemPrompt 约束段 + tools.guard 机械硬拦（幂等）。 */
  const installAsk = (agent) => {
    try {
      const id = askSessionIdOf(agent);
      if (id === null || askInstalls.has(id)) return true;
      const disposers = [];
      const tools = agent.ctx?.tools;
      // systemPrompt 约束段：ask 模式规则随每个模型请求注入（专注解答、禁改文件、
      // 禁诱导提问、可读文件与 run_code 验证）。注册在该会话 agent.ctx，仅本会话渲染。
      const sectionDisposer = agent.ctx?.systemPrompt?.section?.({
        name: ASK_SECTION_NAME,
        order: ASK_SECTION_ORDER,
        text: buildAskSection()
      });
      if (typeof sectionDisposer === 'function') disposers.push(sectionDisposer);
      // tools.guard 执行级硬门：dispatch 前按工具名+参数拒绝写类调用，模型层面无法绕过
      //（arena-v2 同款机制；经 agent.ctx 注册只对该会话主代理生效，子代理 own 层不受影响）。
      try {
        const guardDisposer = tools?.guard?.((execution) => {
          return askToolDenyReason(execution?.name, execution?.arguments);
        });
        if (typeof guardDisposer === 'function') disposers.push(guardDisposer);
      } catch (error) {
        ctx.logger?.warn?.('command-setting: ask guard install failed: ' + String(error?.message ?? error));
      }
      if (disposers.length === 0) return false;
      askInstalls.set(id, () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {}
        }
      });
      return true;
    } catch {
      return false;
    }
  };
  /** 卸载会话的 ask 拦截（幂等）。 */
  const disposeAsk = (id) => {
    const dispose = askInstalls.get(id);
    if (typeof dispose === 'function') {
      try {
        dispose();
      } catch {}
    }
    askInstalls.delete(id);
  };
  /** 切换会话 ask 模式。返回 'on' | 'off' | 'noop'。 */
  const setAskMode = (agent, active) => {
    try {
      const id = askSessionIdOf(agent);
      if (id === null) return 'noop';
      const currently = askSessions.has(id);
      if (active === currently) return 'noop';
      if (active) {
        if (!installAsk(agent)) return 'noop';
        askSessions.add(id);
      } else {
        disposeAsk(id);
        askSessions.delete(id);
      }
      persistAskState();
      ctx.logger?.info?.('command-setting: session ' + id + ' ask mode -> ' + active);
      return active ? 'on' : 'off';
    } catch {
      return 'noop';
    }
  };

  // /ask 命令：全局注册（与 /plan 同级；handler 里拿当前 agent 会话切换）。
  // /ask           → 开启 ask（只问答）模式
  // /ask off       → 关闭，恢复正常模式
  // 附带消息时开启并 steer 给当前会话（与 /plan message 行为一致）。
  const askCommandDisposer = (() => {
    try {
      return ctx.commands.register({
        name: 'ask',
        description: '进入或退出 ask（只问答）模式：只回答、可只读验证，禁止改动文件；/ask off 退出',
        input: { hint: '[off]', images: false },
        handler: ({ agent, rawInput }) => {
          const message = String(rawInput ?? '').trim();
          if (message !== '' && message !== 'off') {
            return { kind: 'error', text: 'ask 命令仅接受 /ask（开启）或 /ask off（关闭），不支持附带消息。' };
          }
          if (message === 'off') {
            const outcome = setAskMode(agent, false);
            return { kind: 'success', text: outcome === 'noop' ? 'ask 模式已是关闭状态。' : 'ask 模式已关闭，恢复正常模式。' };
          }
          const outcome = setAskMode(agent, true);
          return {
            kind: 'success',
            text: outcome === 'noop'
              ? 'ask 模式已开启（只问答）。'
              : 'ask 模式已开启（只问答）：只回答问题、可只读验证，禁止改动文件；/ask off 退出。'
          };
        }
      });
    } catch (error) {
      ctx.logger?.warn?.('command-setting: /ask command register failed: ' + String(error?.message ?? error));
      return null;
    }
  })();

  const disposers = [
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/command-setting/catalog',
      handler: async (req, res) => {
        try {
          // 归档清理：仅在客户端上报了贡献命令面（contributions 参数存在）时
          // 执行——参数缺失意味着调用方不了解浏览器贡献命令（外部/旧客户端），
          // 清理会把 /model 这类贡献命令的 hidden 误删。参数存在即使为空串，
          // 也代表"贡献面已知为空"，命令面可信。
          const url = new URL(req.url ?? '/', 'http://x');
          const contributionsParam = url.searchParams.get('contributions');
          if (contributionsParam !== null) {
            const contributionSet = new Set(
              contributionsParam.split(',').filter((entry) => COMMAND_NAME.test(entry))
            );
            await sweepArchived(contributionSet);
          }
          // Unfiltered views: the settings page must still list hidden commands
          // so they can be shown again — global registrations always, plus the
          // UNFILTERED agent-scoped registrations of the requesting session
          // (?session=<id>). Hidden agent-scoped commands are filtered from the
          // live directory, so without this union the settings page could not
          // show (or un-hide) them and pruning would drop them from the list.
          // Client-side contribution commands are merged in by the browser half.
          const byName = new Map();
          for (const descriptor of original(undefined)) byName.set(descriptor.name, descriptor);
          const sessionId = url.searchParams.get('session') ?? '';
          if (sessionId !== '' && /^[A-Za-z0-9-]+$/.test(sessionId)) {
            try {
              // commands.list() scopes by the AGENT object (the scoped-layer key),
              // not by the wire sessionId — the Typert gateway resolves the id to
              // the agent before calling. Mirror that here so agent-scoped commands
              // (e.g. /compact, registered inside the code preset composition) show
              // up in the settings page and can be un-hidden.
              const agent = ctx.agents.get(sessionId);
              if (agent !== void 0) {
                for (const descriptor of original(agent)) byName.set(descriptor.name, descriptor);
              }
            } catch (error) {
              ctx.logger.warn('command-setting: per-session catalog failed: ' + String(error?.message ?? error));
            }
          }
          const commands = [...byName.values()].map((descriptor) => ({
            name: descriptor.name,
            description: descriptor.description,
            ...(descriptor.input === void 0 ? {} : { hint: descriptor.input.hint })
          }));
          sendJson(res, 200, { ok: true, commands, hidden: cleanHidden([...hiddenSet]), protected: PROTECTED });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/command-setting/set',
      handler: async (req, res) => {
        try {
          const payload = JSON.parse((await readBody(req)) || '{}');
          const raw = payload.hidden;
          if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
            sendJson(res, 400, { ok: false, code: 'bad-hidden', message: 'hidden must be an array of command names' });
            return;
          }
          for (const entry of raw) {
            if (!COMMAND_NAME.test(entry)) {
              sendJson(res, 400, { ok: false, code: 'bad-name', message: 'invalid command name "' + entry + '"' });
              return;
            }
          }
          if (scope === null) {
            sendJson(res, 503, { ok: false, code: 'settings-unavailable', message: 'settings service is not mounted' });
            return;
          }
          // Protected system commands are dropped before persisting; duplicates
          // collapse (the list is a set semantically).
          await scope.update({ hidden: [...new Set(cleanHidden(raw))] });
          // scope.update refreshes hiddenSet and notifies the browser (the real
          // registration does it via scope.watch; the leaked-reuse substitute
          // does it inside its own update).
          sendJson(res, 200, { ok: true, hidden: cleanHidden([...hiddenSet]) });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    () => {
      service.list = original;
    },
    // ask 模式状态端点：GET /command-setting/ask-state?session=<id> -> { ok, active }
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/command-setting/ask-state',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x');
          const sessionId = url.searchParams.get('session') ?? '';
          const active = sessionId !== '' && /^[A-Za-z0-9-]+$/.test(sessionId) && askSessions.has(sessionId);
          sendJson(res, 200, { ok: true, active });
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
        }
      }
    }),
    // /ask 命令清理（register 返回 disposer 时调用；注册失败时为 null）
    ...(typeof askCommandDisposer === 'function' ? [askCommandDisposer] : []),
    // dsh web 重启 / 会话重挂：从侧文件恢复 ask 模式（agent/created 时机安装拦截）
    (() => {
      try {
        const offCreated = ctx.on('agent/created', ({ agent }) => {
          try {
            const id = askSessionIdOf(agent);
            if (id === null) return;
            if (askSessions.has(id)) {
              // 会话重挂（重启/重建）：旧实例的拦截随 agent/disposed 已清理，
              // 此处兜底再清一次（幂等），然后对新 agent 重新安装。
              disposeAsk(id);
              installAsk(agent);
            }
          } catch {}
        });
        const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
          try {
            const id = askSessionIdOf(agent);
            if (id === null) return;
            // 会话销毁：卸载该会话的拦截；侧文件保留（下次创建会话若仍开启则恢复）
            disposeAsk(id);
          } catch {}
        });
        return () => {
          try {
            offCreated();
          } catch {}
          try {
            offDisposed();
          } catch {}
        };
      } catch (error) {
        ctx.logger?.warn?.('command-setting: ask agent lifecycle watch failed: ' + String(error?.message ?? error));
        return () => {};
      }
    })()
  ];

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    try {
      scope = settings.register(SETTINGS_NS, z.object({ hidden: z.array(z.string()) }), {
        base: { hidden: [...hiddenSet] }
      });
      disposeWatch = scope.watch(() => applyHidden(scope.get()?.hidden));
    } catch (error) {
      // settings.register ties the namespace to the SETTINGS PROVIDER's fiber,
      // not this plugin's — stopping this plugin leaks the registration, so a
      // later re-activation throws "already registered". Reuse the live
      // registration through the service's own read/write methods instead of
      // failing to start. (No watcher exists on this path; the write path still
      // refreshes through the substitute update below.)
      const message = String(error?.message ?? error)
      // 注册绑定在 settings 服务生命周期上，停用后会泄漏；重新启用时 register 抛
      // "already registered"（或相近措辞）属预期，直接复用现存注册。其余错误
      // （schema/校验问题）仍 fail loud，避免静默吞掉真问题。
      if (!/already registered|already exists|duplicate/i.test(message)) throw error;
      scope = {
        get: () => settings.get(SETTINGS_NS),
        update: async (patch) => {
          await settings.update(SETTINGS_NS, patch);
          applyHidden(patch?.hidden ?? []);
        }
      };
    }
    hiddenSet = new Set(cleanHidden(scope.get()?.hidden ?? []));
    // 注意：启动时不做归档清理——此刻通常没有 live 会话、也拿不到浏览器贡献
    // 命令面，命令面不完整；清理只在 catalog 读取（客户端已上报贡献面）时惰性
    // 进行，保证有效隐藏（贡献命令/agent 命令）永不被误删。
  });

  ctx.logger.info('command-setting: hiding /' + [...hiddenSet].join(', /') + ' from the command menu (settings namespace ' + SETTINGS_NS + ')');

  return () => {
    for (const dispose of disposers) dispose();
    if (disposeWatch) disposeWatch();
  };
}

export { Config, apply, inject, name, askToolDenyReason, buildAskSection };
export default { Config, apply, inject, name, askToolDenyReason, buildAskSection };
