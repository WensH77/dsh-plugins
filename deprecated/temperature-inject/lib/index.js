// dsh-plugin-temperature-inject — 入口。
//
// 目标：在会话页面打开「温度调节」后，让主代理委派的子代理稳定地跑在
// 指定模型 + 关闭 thinking + 指定温度（0~1）下。
//
// 为什么只能走 agent/request：
//   - AgentOptions 只有 provider/model/reasoningEffort/maxTokens，没有 temperature
//     （dsh-agent/lib/types/runtime-types.d.ts:21-30）；
//   - agent/request waterfall 的返回值 LlmCallConfig 有 temperature
//     （dsh-llm/lib/types/call-config.d.ts:16-23）；
//   - 子代理与主代理共用同一个 waterfall（dsh-agent-loop/lib/index.js:1143），
//     插件根 ctx 上注册的、不带 scope tag 的监听器覆盖全部 agent
//     （dsh-agent/lib/index.js:198 + dsh-scope/lib/index.js:316-330）。
//
// 判据不用 run.id 映射（那有时序竞态：subagent/start 在 provider.start 返回后才发，
// 而子代理的 prompt 在其内部就已投递），只用 agent 自身的持久属性 origin/parentSession。
//
// 状态模型：
//   - config（cordis.patch.yml）是全局默认；
//   - 会话页开关读写的是「会话级覆盖」（内存 Map，按父会话 id）——**默认关闭**，
//     用户在某会话打开后才对该会话派出的子代理生效；
//   - 无 UI 场景可用 config.sessions 白名单或 config.autoEnable 兜底。
import z from '@deepseek-ai/schemastery';
import {
  decideInjection,
  normalizeConfig,
  publicConfig,
  publicSessionSetting,
  resolveSessionSetting,
  sanitizeSessionPatch
} from './inject.js';

const name = 'temperature-inject';
const inject = ['webServer'];

const Config = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default('deepseek-flash'),
  effort: z.string().default('off'),
  temperature: z.number().default(1),
  sessions: z.array(z.string()).default([]),
  autoEnable: z.boolean().default(false),
  includeMain: z.boolean().default(false)
});

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/** 聚合请求体；框架已预解析时直接取用（照抄 command-setting 的兜底写法）。 */
function readBody(req) {
  return new Promise((done) => {
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
 * 注册端点。容忍 re-init 时残留的同路径旧路由（停用/重载后旧 handler
 * 已随旧 ctx 失效）：命中 duplicate 先清掉再重新注册。
 */
function registerRoute(ctx, path, handler) {
  return ctx.effect(() => {
    try {
      return ctx.webServer.register({ kind: 'exact', path, handler });
    } catch (error) {
      if (!/duplicate/.test(String(error?.message ?? error))) throw error;
      const table = ctx.webServer.exact;
      if (table && typeof table.delete === 'function') table.delete(path);
      return ctx.webServer.register({ kind: 'exact', path, handler });
    }
  });
}

function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  /** 会话级覆盖：父会话 id -> {enabled, temperature}。默认没有条目 = 关闭。 */
  const sessionSettings = new Map();
  const state = {
    startedAt: new Date().toISOString(),
    requests: 0,
    injected: 0,
    alreadyApplied: 0,
    sessionWrites: 0,
    skipped: {},
    errors: 0,
    recent: []
  };

  const offRequest = ctx.on('agent/request', async (payload, next) => {
    // 必须放在 try 之外：next() 抛错属于别的监听器/链路的失败，不能吞。
    const resolved = await next();
    state.requests += 1;
    try {
      const header = payload?.agent?.session?.header;
      const parentSession = header?.parentSession === undefined || header?.parentSession === null
        ? undefined
        : String(header.parentSession);
      const live = parentSession === undefined ? undefined : sessionSettings.get(parentSession);
      const setting = resolveSessionSetting(cfg, parentSession, live);
      const decision = decideInjection(resolved, header, cfg, setting);
      if (!decision.apply) {
        if (decision.reason === 'already-applied') state.alreadyApplied += 1;
        else state.skipped[decision.reason] = (state.skipped[decision.reason] ?? 0) + 1;
        return resolved;
      }
      state.injected += 1;
      const entry = {
        at: new Date().toISOString(),
        agentId: String(payload?.agent?.id ?? ''),
        parentSession: parentSession === undefined ? null : parentSession,
        source: setting.source,
        patch: decision.patch,
        before: {
          provider: resolved.provider,
          model: resolved.model,
          reasoningEffort: resolved.reasoningEffort ?? null,
          temperature: resolved.temperature ?? null
        }
      };
      state.recent.push(entry);
      while (state.recent.length > cfg.maxLogged) state.recent.shift();
      ctx.logger?.info?.(
        '[temperature-inject] inject child=' + entry.agentId
        + ' parent=' + entry.parentSession
        + ' source=' + entry.source
        + ' ' + JSON.stringify(decision.patch)
      );
      return decision.next;
    } catch (error) {
      // 注入失败绝不能让子代理的模型请求失败：原样放行，只记一条 warn。
      state.errors += 1;
      ctx.logger?.warn?.(
        '[temperature-inject] injection failed, config passed through: '
        + String(error?.message ?? error)
      );
      return resolved;
    }
  });

  // 实测边界提醒（见 README §7）：文档给的合法区间是 0~2，但多步 agentic 任务的实测可用区间是 0~1。
  // 这里不阻断——非 agentic 场景、或把长输出分块生成的场景仍可能用更高温度——只把风险写进日志。
  if (cfg.temperature > 1) {
    ctx.logger?.warn?.(
      'temperature-inject: temperature=' + cfg.temperature
      + ' 超出多步 agentic 任务的实测可用区间 0~1；1.5 及以上会让子代理的输出退化成 token soup（见 README §7）'
    );
  }

  const offState = registerRoute(ctx, '/temperature-inject/state', (req, res) => {
    sendJson(res, 200, {
      config: publicConfig(cfg),
      state,
      sessions: [...sessionSettings.entries()].map(([session, value]) => ({ session, ...value }))
    });
  });

  const offSession = registerRoute(ctx, '/temperature-inject/session', async (req, res) => {
    try {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        const url = new URL(String(req.url ?? '/'), 'http://localhost');
        const session = String(url.searchParams.get('session') ?? '');
        sendJson(res, 200, publicSessionSetting(session, sessionSettings.get(session), cfg.temperature));
        return;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        let parsed = null;
        try {
          parsed = JSON.parse(raw === '' ? '{}' : raw);
        } catch {
          sendJson(res, 400, { error: 'invalid-json' });
          return;
        }
        const session = parsed !== null && typeof parsed.session === 'string' ? parsed.session : '';
        if (session === '') {
          sendJson(res, 400, { error: 'session-required' });
          return;
        }
        const patch = sanitizeSessionPatch(parsed);
        const prev = sessionSettings.get(session) ?? { enabled: false, temperature: cfg.temperature };
        const nextSetting = {
          enabled: patch.enabled === undefined ? prev.enabled : patch.enabled,
          temperature: patch.temperature === undefined ? prev.temperature : patch.temperature
        };
        sessionSettings.set(session, nextSetting);
        state.sessionWrites += 1;
        ctx.logger?.info?.(
          '[temperature-inject] session=' + session + ' → ' + JSON.stringify(nextSetting)
        );
        sendJson(res, 200, publicSessionSetting(session, nextSetting, cfg.temperature));
        return;
      }
      sendJson(res, 405, { error: 'method-not-allowed' });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  });

  ctx.logger?.info?.(
    'temperature-inject: 已启用 → 子代理 model=' + (cfg.model || '(不变)')
    + ' effort=' + (cfg.effort || '(不变)')
    + ' temperature=' + cfg.temperature
    + (cfg.clampedFrom === null ? '' : '（配置值 ' + cfg.clampedFrom + ' 已夹到 0~2）')
    + '；会话级开关默认关闭，端点 GET/POST /temperature-inject/session'
  );

  return () => {
    offRequest?.();
    offState?.();
    offSession?.();
  };
}

export { Config, apply, inject, name };
// 便于测试与外部复用：透传纯函数域（smoke 测试从 index 取，避免两处 import 路径）。
export {
  clampTemperature,
  decideInjection,
  normalizeConfig,
  publicConfig,
  publicSessionSetting,
  resolveSessionSetting,
  sanitizeSessionPatch,
  TEMPERATURE_MIN,
  TEMPERATURE_MAX,
  TESTED_MAX,
  TEMPERATURE_STEP
} from './inject.js';
export default { Config, apply, inject, name };
