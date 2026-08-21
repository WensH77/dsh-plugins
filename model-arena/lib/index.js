// dsh-plugin-model-arena — node half
// 1) Persists arena linkages (main -> arena) and the per-session persona map.
// 2) Injects the challenge roles (Knowledge Expert / Challenger) into the
//    SYSTEM PROMPT of the arena-enabled sessions via the
//    system-prompt/assemble waterfall — no extra messages in the conversation,
//    roles apply from the very first turn.
import z from '@deepseek-ai/schemastery';
import { PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt';

const name = 'model-arena';
const inject = ['settings', 'systemPrompt'];

// schemastery fields are optional by default.
const Link = z.object({
  sessionId: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  name: z.string()
});

// persona: sessionId -> role prompt text (main session gets the expert role,
// the arena session gets the challenger role). Written by the browser half.
// workspaceSkills: workspace path -> challenger skill path (file or folder),
// persisted per workspace so new sessions in the same workspace reuse it.
const Config = z.object({
  links: z.dict(Link).default({}),
  enabled: z.boolean(),
  persona: z.dict(z.string()).default({}),
  workspaceSkills: z.dict(z.string()).default({})
});

function apply(ctx) {
  ctx.inject(['settings', 'systemPrompt'], (settingsCtx) => {
    let scope = null;
    try {
      scope = settingsCtx.settings.register(name, Config, { base: { links: {}, persona: {} } });
    } catch (error) {
      ctx.logger?.warn?.('model-arena: settings register failed: ' + String(error?.message ?? error));
    }
    // Live persona map (sessionId -> role text), refreshed from settings.
    let personaMap = {};
    const readPersona = () => {
      try {
        personaMap = scope?.get()?.persona ?? {};
      } catch {
        personaMap = {};
      }
    };
    readPersona();
    const unwatch = scope?.watch?.(() => readPersona());

    // Inject the challenge role into the assembled system prompt for the
    // arena-enabled sessions only. The global untagged listener is released by
    // scopeTarget for every agent scope; we resolve the session from
    // context.agent and skip everything that is not in the persona map.
    const disposeAssembly = settingsCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next();
      const sessionId = context?.agent?.session?.id;
      if (sessionId === void 0 || sessionId === null) return assembled;
      const role = personaMap[sessionId];
      if (role === void 0 || role === '') return assembled;
      for (const section of assembled.sections) {
        if (section.name !== PERSONA_SECTION) continue;
        const current = typeof section.text === 'string' && section.text.length > 0 ? section.text : '';
        section.text = current ? current + '\n\n' + role : role;
      }
      return assembled;
    });

    return () => {
      try {
        unwatch?.();
      } catch {}
      try {
        disposeAssembly?.();
      } catch {}
    };
  });
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
