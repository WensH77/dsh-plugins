// dsh-plugin-command-setting — ask 模式（只问答）域。
// 从原单文件 index.js 拆出：只读/写判定（isBashWrite / askToolDenyReason）、
// systemPrompt 约束段（buildAskSection）、会话状态侧文件读写（readAskState /
// writeAskState）与会话级开关控制器（createAskController——安装/卸载 per-agent
// 拦截、/ask 命令注册与 agent/created|disposed 生命周期恢复）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

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
/** 会话 ask 状态与 per-agent 拦截的控制器。状态以内存 Set 为准，随 /ask 开关即时
 * 增删；镜像到侧文件（~/.dsh/command-setting-ask.json）供 dsh web 重启后恢复。
 * install/dispose 幂等；子代理（subagent origin / subagentDepth）不装拦截。 */
function createAskController(ctx) {
  // 会话级状态：内存 Set 为准，随 /ask 即时增删；镜像到侧文件供重启恢复。
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

  /** /ask 命令注册（与 /plan 同级；handler 里拿当前 agent 会话切换）。 */
  const registerAskCommand = () => {
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
  };

  /** agent 生命周期监听：dsh web 重启 / 会话重挂时从侧文件恢复 ask 模式
   * （agent/created 时机安装拦截），agent 销毁时卸载拦截。 */
  const watchLifecycle = () => {
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
  };

  return {
    /** 会话是否处于 ask 模式（供 ask-state 端点回显按钮激活态）。 */
    active: (sessionId) => askSessions.has(sessionId),
    setAskMode,
    registerAskCommand,
    watchLifecycle
  };
}

export { askToolDenyReason, buildAskSection, createAskController };
