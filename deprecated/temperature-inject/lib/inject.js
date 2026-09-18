// temperature-inject — 判定与改写域（纯函数，无副作用，便于 smoke 测试）。
//
// 只做一件事：给定「当前 LlmCallConfig + 目标 agent 的 session header + 插件配置
// + 该会话的实时设置」，决定要不要改写、改写成什么。日志/计数/端点留在 index.js。
//
// 背景（详见 README）：
//   - temperature 不在 AgentOptions 里（只有 provider/model/reasoningEffort/maxTokens），
//     唯一生效点是 agent/request waterfall 的返回值 LlmCallConfig；
//   - DeepSeek 的 thinking 模式不支持 temperature，所以要让温度生效必须同时把
//     reasoningEffort 置为 'off'（'thinking' 字段在 AgentOptions/LlmCallConfig 里都不存在）；
//   - LlmCallConfig.temperature 没有任何范围校验，0~2 由本模块自己夹；
//   - 但**多步 agentic 任务的实测可用区间是 0~1**（1.5 起输出退化成 token soup，见 README §7），
//     所以用户侧可写的范围被夹到 0~1。

/** 配置默认值。 */
export const DEFAULTS = {
  /** 插件总开关；false 时监听器原样放行。 */
  enabled: true,
  /** 目标 provider；空串 = 不改 provider（同 provider 下换 model 更稳）。 */
  provider: '',
  /** 目标模型；空串 = 不改 model。 */
  model: 'deepseek-flash',
  /** 目标 reasoning effort；'off' 是关闭 thinking 的唯一表达。空串 = 不改。 */
  effort: 'off',
  /** 目标温度。默认 1，与主代理的服务端默认值一致（也是实测可用区间的上界）。 */
  temperature: 1,
  /** 只对这些「主会话 id」生效；空数组 = 不按会话白名单放行。 */
  sessions: [],
  /** 无 UI 场景的兜底：true 时所有会话默认开启（不需要会话页开关）。 */
  autoEnable: false,
  /** 是否也作用于主代理（仅供调试，正常保持 false）。 */
  includeMain: false,
  /** 端点最多回放多少条注入记录。 */
  maxLogged: 20
};

/** API 合法下界。 */
export const TEMPERATURE_MIN = 0;
/** API 合法上界（文档：temperature ≤ 2）。 */
export const TEMPERATURE_MAX = 2;
/** 用户侧可写上界 = 多步 agentic 任务的实测可用区间上界（见 README §7）。 */
export const TESTED_MAX = 1;
/** 客户端滑杆步长（用户定的规格）。 */
export const TEMPERATURE_STEP = 0.2;

/** 把一个温度值夹到 [min, max]；非数字返回 fallback。 */
export function clampTemperature(value, fallback = DEFAULTS.temperature, min = TEMPERATURE_MIN, max = TEMPERATURE_MAX) {
  const t = Number(value);
  if (!Number.isFinite(t)) return fallback;
  if (t < min) return min;
  if (t > max) return max;
  return t;
}

/**
 * 合并默认值并做类型/范围收敛。超范围的温度会被夹到 0~2，并把原值记在
 * `clampedFrom`（端点与启动日志会暴露），避免静默吞掉配置错误。
 * @param raw - 插件 config（可能来自 cordis.patch.yml）。
 */
export function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) };
  const cfg = {
    enabled: merged.enabled !== false,
    provider: typeof merged.provider === 'string' ? merged.provider.trim() : '',
    model: typeof merged.model === 'string' ? merged.model.trim() : '',
    effort: typeof merged.effort === 'string' ? merged.effort.trim() : '',
    sessions: Array.isArray(merged.sessions) ? merged.sessions.map((s) => String(s)) : [],
    autoEnable: merged.autoEnable === true,
    includeMain: merged.includeMain === true,
    maxLogged: Number.isFinite(Number(merged.maxLogged)) && Number(merged.maxLogged) > 0
      ? Math.floor(Number(merged.maxLogged))
      : DEFAULTS.maxLogged,
    temperature: DEFAULTS.temperature,
    clampedFrom: null
  };
  const t = Number(merged.temperature);
  if (Number.isFinite(t)) cfg.temperature = t;
  if (cfg.temperature < TEMPERATURE_MIN) {
    cfg.clampedFrom = cfg.temperature;
    cfg.temperature = TEMPERATURE_MIN;
  } else if (cfg.temperature > TEMPERATURE_MAX) {
    cfg.clampedFrom = cfg.temperature;
    cfg.temperature = TEMPERATURE_MAX;
  }
  return cfg;
}

/** 对外暴露的配置视图（端点用；clampedFrom 非 null 表示配置被夹过）。 */
export function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model,
    effort: cfg.effort,
    temperature: cfg.temperature,
    clampedFrom: cfg.clampedFrom,
    sessions: [...cfg.sessions],
    autoEnable: cfg.autoEnable,
    includeMain: cfg.includeMain,
    testedRange: [TEMPERATURE_MIN, TESTED_MAX],
    step: TEMPERATURE_STEP
  };
}

/**
 * 校验客户端写来的会话设置。
 * enabled 必须是布尔；temperature 夹到 **0~1**（用户侧可写范围即实测可用区间）。
 * @returns 只含合法字段的对象（可能为空对象）。
 */
export function sanitizeSessionPatch(patch) {
  const out = {};
  if (patch !== null && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
    if (patch.temperature !== undefined) {
      const t = Number(patch.temperature);
      if (Number.isFinite(t)) out.temperature = clampTemperature(t, DEFAULTS.temperature, TEMPERATURE_MIN, TESTED_MAX);
    }
  }
  return out;
}

/** 会话设置的对外视图。 */
export function publicSessionSetting(sessionId, live, fallbackTemperature) {
  const temperature = live && Number.isFinite(Number(live.temperature))
    ? Number(live.temperature)
    : fallbackTemperature;
  return {
    session: String(sessionId ?? ''),
    enabled: live ? live.enabled === true : false,
    temperature,
    effective: live ? live.enabled === true : false,
    testedRange: [TEMPERATURE_MIN, TESTED_MAX],
    step: TEMPERATURE_STEP
  };
}

/**
 * 解析某会话当前是否该注入、用哪个温度。优先级：
 *   1. 插件总开关关闭 → null
 *   2. 会话页开关已打开（实时状态）→ 用实时温度
 *   3. config.sessions 白名单命中 → 用 config.temperature
 *   4. config.autoEnable → 用 config.temperature
 *   5. 否则 null（不注入）
 *
 * @param cfg - normalizeConfig 的结果。
 * @param sessionId - 子代理的父会话 id（`header.parentSession`）。
 * @param live - 该会话的实时设置 `{enabled, temperature}`，没有则 undefined。
 * @returns `null` 或 `{temperature, source}`。
 */
export function resolveSessionSetting(cfg, sessionId, live) {
  if (!cfg.enabled) return null;
  const id = sessionId === undefined || sessionId === null ? '' : String(sessionId);
  // 会话级设置一旦存在即为权威：用户在会话页关掉就是关掉，不再回落到
  // config.sessions / autoEnable（否则「关了还生效」会让人无法理解）。
  if (live !== undefined && live !== null) {
    if (live.enabled !== true) return null;
    return {
      temperature: clampTemperature(live.temperature, cfg.temperature, TEMPERATURE_MIN, TESTED_MAX),
      source: 'session'
    };
  }
  if (id !== '' && cfg.sessions.includes(id)) return { temperature: cfg.temperature, source: 'config' };
  if (cfg.autoEnable === true && id !== '') return { temperature: cfg.temperature, source: 'auto' };
  return null;
}

/**
 * 判定一次 agent/request 是否注入。
 *
 * @param resolved - waterfall 里 `await next()` 拿到的当前配置。
 * @param header - `payload.agent.session.header`（子代理有 origin/parentSession）。
 * @param cfg - normalizeConfig 的结果。
 * @param setting - resolveSessionSetting 的结果（null = 该会话未开启）。
 * @returns `{apply:false, reason}` 或 `{apply:true, reason, next, patch}`。
 *   reason 取值：disabled / not-subagent / session-off / already-applied / injected。
 */
export function decideInjection(resolved, header, cfg, setting) {
  if (!cfg.enabled) return { apply: false, reason: 'disabled' };

  const isSubagent = header?.origin === 'subagent';
  if (!isSubagent && !cfg.includeMain) return { apply: false, reason: 'not-subagent' };

  // 会话页没有打开「温度调节」→ 不注入（这是默认状态）。
  if (setting === null || setting === undefined) return { apply: false, reason: 'session-off' };

  const patch = {};
  if (cfg.provider !== '' && cfg.provider !== resolved.provider) patch.provider = cfg.provider;
  if (cfg.model !== '' && cfg.model !== resolved.model) patch.model = cfg.model;
  if (cfg.effort !== '' && cfg.effort !== resolved.reasoningEffort) patch.reasoningEffort = cfg.effort;
  if (resolved.temperature !== setting.temperature) patch.temperature = setting.temperature;

  // 值已一致：说明前面某次请求已经注入过（同一 agent 的后续 step）。
  // 返回原对象，保持引用不变——callConfigEquals 会判定为「无变化」，不写 header 事件。
  if (Object.keys(patch).length === 0) return { apply: false, reason: 'already-applied' };

  return { apply: true, reason: 'injected', patch, next: { ...resolved, ...patch } };
}
