// dsh-plugin-tool-both/presentation — agent-plane presentation row.
//
// Mirrors @deepseek-ai/dsh-agent-tool-presentation but defaults the mode to
// `both` (configurable), so a single row turns on both-mode for every agent
// joined to the preset that carries it:
//
//   - id: tool-both-presentation
//     name: dsh-plugin-tool-both/presentation
//
// `both` means the model sees every native tool schema AND the reserved
// `run_code` transport plus its generated SDK section, with no code-only
// rule: direct tool calls execute normally, and the model may also write a
// `run_code` program to batch several steps into one round trip.
//
// MUST be mounted in an agent-plane composition (an agent preset's
// agent.cordis.yml), never the host profile patch: ctx.tools.presentAs()
// requires a scoped context and throws from a plain one.
import z from '@deepseek-ai/schemastery';

const name = 'tool-both-presentation';
const inject = ['tools'];

// mode defaults to `both`; `native` / `code` remain available for
// compositions that want to reuse this row as a plain selector.
const Config = z.object({
  mode: z.union(['native', 'code', 'both']).default('both')
});

function apply(ctx, config) {
  const mode = config.mode;
  if (mode === 'native') {
    ctx.tools.presentAs('native');
    return;
  }
  // Non-native modes need the host code runtime. Wait for it instead of
  // assuming it, so a deployment that composes no runtime fails at mount
  // (named in the preset's activation audit) rather than at the first prompt.
  ctx.inject(['codeRuntime'], (runtimeCtx) => {
    runtimeCtx.tools.presentAs(mode);
  });
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
