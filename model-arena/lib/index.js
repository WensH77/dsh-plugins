// dsh-plugin-model-arena — node half
// 1) Persists arena linkages (main -> arena) and the per-session persona map.
// 2) Injects the challenge roles (Knowledge Expert / Challenger) into the
//    SYSTEM PROMPT of the arena-enabled sessions via the
//    system-prompt/assemble waterfall — no extra messages in the conversation,
//    roles apply from the very first turn.
import z from '@deepseek-ai/schemastery';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
// workspaceSkills: workspace path -> (scene -> challenger skill path). Each
// workspace × scene pair remembers its own skill (file or folder); a new
// session in the same workspace defaults to its scene's entry (empty = none).
// The union accepts the legacy workspace-level string value so pre-v14 settings
// do not fail registration — the browser half migrates a string entry to the
// default `business` scene on read.
const Config = z.object({
  links: z.dict(Link).default({}),
  enabled: z.boolean(),
  persona: z.dict(z.string()).default({}),
  workspaceSkills: z.dict(z.union([z.string(), z.dict(z.string())])).default({}),
  // arena: review-loop bridge. The browser half writes mainSessionId + cwd when
  // a knowledge-scene challenge starts; the node half polls the session's
  // Theseus workflow state and writes back `reviewRequest` once it observes a
  // `propose.completed` transition (currentStage -> review), so the browser can
  // hand the proposal over to the challenger for review.
  arena: z.object({
    mainSessionId: z.string(),
    cwd: z.string(),
    reviewRequest: z.object({
      workflowId: z.string(),
      seq: z.number(),
      proposalPath: z.string(),
      designPath: z.string(),
      tasksPath: z.string(),
      reviewPath: z.string()
    }),
    // Browser half writes this when the review loop exhausts its reject budget:
    // the node half observes it and writes the Theseus state machine back from
    // `review` to `propose` (recording review.completed NEEDS_REVISION) WITHOUT
    // messaging the main model — so the main model stays parked for the human.
    returnToPropose: z.object({
      seq: z.number()
    }),
    // Progress heartbeat: the node half rewrites this whenever the Theseus
    // state's history length or current stage changes, so the browser half can
    // tell "still working" from "genuinely stuck" instead of guessing from the
    // main session's idle time alone.
    watch: z.object({
      seq: z.number(),
      stage: z.string(),
      at: z.number()
    })
  }).default({})
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

    // ── review-loop bridge: detect the main session's `propose.completed` ──
    // The browser half writes `arena.mainSessionId` + `arena.cwd` when a
    // knowledge-scene challenge starts. This node half then polls the session's
    // Theseus workflow state (openspec/.runtime/sessions + openspec/states) and,
    // when it observes `currentStage === 'review'` with a fresh
    // `propose.completed` history entry, writes `arena.reviewRequest` back so the
    // browser half can hand the proposal over to the challenger. Reads are
    // best-effort: any filesystem/schema hiccup is swallowed and retried next tick.
    const safeFileName = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, '__');
    const readOptionalJson = async (path) => {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    };

    let pollTimer = null;
    let watchedSessionId = null;
    let lastSeq = -1;
    let lastReturnSeq = -1;
    let lastWatchSeq = -1;
    let lastWatchStage = null;

    const stopPoll = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // Write the Theseus state machine back from `review` to `propose` (recording
    // review.completed NEEDS_REVISION), so the workflow does not stay parked at
    // `review` after the review loop ends on rejections. Equivalent to Theseus'
    // `recordStageCompletion('review.completed', 'NEEDS_REVISION')`.
    const returnToPropose = async (cwd, sessionId) => {
      try {
        const focus = await readOptionalJson(join(cwd, 'openspec', '.runtime', 'sessions', safeFileName('dsh:' + sessionId) + '.json'));
        const workflowId = focus?.activeWorkflowId;
        if (typeof workflowId !== 'string' || workflowId === '') return;
        const statePath = join(cwd, 'openspec', 'states', workflowId + '.json');
        const state = await readOptionalJson(statePath);
        if (state === null || typeof state !== 'object') return;
        if (state.currentStage !== 'review') return;
        const now = new Date().toISOString();
        state.currentStage = 'propose';
        state.history = [...(Array.isArray(state.history) ? state.history : []), {
          event: 'review.completed',
          result: 'NEEDS_REVISION',
          fromStage: 'review',
          toStage: 'propose',
          recordedAt: now
        }];
        state.stageResults = [...(Array.isArray(state.stageResults) ? state.stageResults : []), {
          stage: 'review',
          result: 'NEEDS_REVISION',
          recordedAt: now
        }];
        await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
      } catch {
        // non-fatal: retry on the next poll
      }
    };

    const detectPropose = async () => {
      const arena = scope?.get()?.arena;
      const sessionId = typeof arena?.mainSessionId === 'string' ? arena.mainSessionId : '';
      const cwd = typeof arena?.cwd === 'string' ? arena.cwd : '';
      // Reject budget exhausted: the browser half asks to return Theseus to
      // propose WITHOUT messaging the main model. Handle this first, then stop
      // the poll by clearing mainSessionId.
      const ret = arena?.returnToPropose;
      if (ret !== null && typeof ret === 'object' && typeof ret.seq === 'number' && ret.seq !== lastReturnSeq && sessionId !== '' && cwd !== '') {
        lastReturnSeq = ret.seq;
        await returnToPropose(cwd, sessionId);
        await scope?.update?.({
          arena: {
            ...arena,
            returnToPropose: null,
            mainSessionId: '',
            reviewRequest: null
          }
        });
        return;
      }
      if (sessionId === '' || cwd === '') return;
      try {
        const focus = await readOptionalJson(join(cwd, 'openspec', '.runtime', 'sessions', safeFileName('dsh:' + sessionId) + '.json'));
        const workflowId = focus?.activeWorkflowId;
        if (typeof workflowId !== 'string' || workflowId === '') return;
        const state = await readOptionalJson(join(cwd, 'openspec', 'states', workflowId + '.json'));
        if (state === null || typeof state !== 'object') return;
        const history = Array.isArray(state.history) ? state.history : [];
        const seq = history.length;
        const stage = typeof state.currentStage === 'string' ? state.currentStage : '';
        // Progress heartbeat: report any seq/stage change so the browser half
        // can tell "Theseus still advancing" from "genuinely stuck" (rather than
        // guessing from the main session's idle time). Merge preserves the other
        // arena fields (reviewRequest/returnToPropose) between updates.
        if (seq !== lastWatchSeq || stage !== lastWatchStage) {
          lastWatchSeq = seq;
          lastWatchStage = stage;
          await scope?.update?.({
            arena: { ...arena, watch: { seq, stage, at: Date.now() } }
          });
        }
        if (stage !== 'review' || seq <= lastSeq) return;
        const last = history[seq - 1];
        if (last?.event !== 'propose.completed') return;
        lastSeq = seq;
        const artifacts = state.artifacts ?? {};
        await scope?.update?.({
          arena: {
            ...arena,
            reviewRequest: {
              workflowId,
              seq,
              proposalPath: artifacts.proposal ?? '',
              designPath: artifacts.design ?? '',
              tasksPath: artifacts.tasks ?? '',
              reviewPath: artifacts.review ?? ''
            }
          }
        });
      } catch {
        // non-fatal: retry on the next poll
      }
    };

    const syncPoll = () => {
      const arena = scope?.get()?.arena;
      const sessionId = typeof arena?.mainSessionId === 'string' ? arena.mainSessionId : '';
      if (sessionId === '') {
        stopPoll();
        watchedSessionId = null;
        lastSeq = -1;
        lastWatchSeq = -1;
        lastWatchStage = null;
        return;
      }
      if (sessionId !== watchedSessionId) {
        watchedSessionId = sessionId;
        lastSeq = -1;
        lastWatchSeq = -1;
        lastWatchStage = null;
      }
      if (pollTimer === null) {
        pollTimer = setInterval(detectPropose, 1000);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
      }
    };
    const unwatchArena = scope?.watch?.(() => syncPoll());
    syncPoll();

    // Inject the challenge role as a HIGH-PRIORITY system-prompt section (order
    // 1000, near the end of the assembled prompt) instead of the weak
    // `deployment:persona` section. The Theseus workflow's own stage skills
    // ("hand off to review") would otherwise override a soft persona and
    // auto-advance the main model into review. A dynamic `text` fn resolves the
    // role per session from the live persona map, so arena-enabled sessions get
    // the stop-after-propose directive while every other session gets nothing.
    const disposeRoleSection = settingsCtx.systemPrompt?.section?.({
      name: 'model-arena:arena-role',
      order: 1000,
      text: (context) => {
        const sessionId = context?.agent?.session?.id;
        if (sessionId === void 0 || sessionId === null) return '';
        const role = personaMap[sessionId];
        return typeof role === 'string' && role !== '' ? role : '';
      }
    });

    return () => {
      try {
        stopPoll();
      } catch {}
      try {
        unwatchArena?.();
      } catch {}
      try {
        unwatch?.();
      } catch {}
      try {
        disposeRoleSection?.();
      } catch {}
    };
  });
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
