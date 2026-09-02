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
// Challenge orchestration state, persisted per main session so an interrupted
// duel (page reload / dsh restart / network drop) resumes from its last
// phase/anchors instead of restarting a fresh round. Written by the browser
// half on every phase transition (debounced); the browser half restores the
// baseline on reload and re-aligns it against the LIVE session snapshots
// (running / turn completed / genuinely stalled) — the backend sessions do not
// die on a browser refresh, so a turn may well have finished server-side.
// Run-time-only fields (mainWasRunning/arenaWasRunning/stallSince, and the
// lastMainText/lastArenaText bodies) are NOT persisted — they are rebuilt or
// re-extracted from the snapshots on restore.
const PersistedChallenge = z.object({
  active: z.boolean(),
  phase: z.string(),
  scene: z.string(),
  skill: z.string(),
  userQuestion: z.string(),
  // chat node keys; "" = none (the older schemastery build has no null type)
  mainAnchor: z.string(),
  arenaAnchor: z.string(),
  rejectCount: z.number(),
  verdict: z.string(),
  round: z.number(),
  pendingAnchor: z.boolean(),
  lastInjectedText: z.string(),
  lastReviewSeq: z.number(),
  proposalPath: z.string(),
  designPath: z.string(),
  tasksPath: z.string(),
  reviewPath: z.string(),
  updatedAt: z.number()
});

const Config = z.object({
  links: z.dict(Link).default({}),
  enabled: z.boolean(),
  persona: z.dict(z.string()).default({}),
  workspaceSkills: z.dict(z.union([z.string(), z.dict(z.string())])).default({}),
  challenges: z.dict(PersistedChallenge).default({}),
  // Background-advance switch (default OFF): when enabled, an arena duel whose
  // MAIN session is not the currently selected one still advances in the
  // background — the challenger's finished reply is injected into the main
  // session and a finished main turn prompts the challenger — driven by the
  // persisted challenge baseline (challenges) + live session snapshots. When
  // OFF (default), background duels only advance on return to the main session
  // (the v7 catch-up path).
  backgroundAdvance: z.boolean().default(false),
  // Per-scene × per-role sampling temperature for the arena-enabled sessions.
  // UI-only for now (settings page): the agent/request injection that actually
  // applies these values is a follow-up task and NOT implemented yet. When
  // enabled is false (default) nothing is injected and dsh/provider defaults
  // apply. Each scene (business/knowledge/qa) holds an optional main
  // (main-model sessions) and challenger (arena sessions) value in 0..2;
  // an absent value means "use dsh default" for that scene × role.
  temperature: z.object({
    enabled: z.boolean().default(false),
    business: z.object({
      main: z.number().min(0).max(2),
      challenger: z.number().min(0).max(2)
    }),
    knowledge: z.object({
      main: z.number().min(0).max(2),
      challenger: z.number().min(0).max(2)
    }),
    qa: z.object({
      main: z.number().min(0).max(2),
      challenger: z.number().min(0).max(2)
    })
  }).default({}),
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

    // Theseus workflow stages that are PAST `review`: once the watched workflow
    // reaches any of these the review loop has concluded and the challenger must
    // stay dormant. The node half watches ONLY `arena.mainSessionId`, so a stale
    // id whose workflow is `done` would keep occupying the poll forever and
    // swallow reviewRequest detection for a NEWER knowledge session (the 8/24
    // incident: the bridge was stuck on an old archived session while the active
    // workflow sat at `review` with nobody watching). The node half therefore
    // disarms the bridge (clears `mainSessionId`) once the watched workflow
    // moves past review — after writing the watch heartbeat so a reload still
    // sees the past-review stage and the browser blocks re-arming.
    const PAST_REVIEW_STAGES = new Set(['user-readiness-review', 'apply', 'archive', 'done']);

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
        const watch = { seq, stage, at: Date.now() };
        if (seq !== lastWatchSeq || stage !== lastWatchStage) {
          lastWatchSeq = seq;
          lastWatchStage = stage;
          await scope?.update?.({
            arena: { ...arena, watch }
          });
        }
        // Workflow already PAST review (user-readiness-review / apply / archive /
        // done): the review loop concluded — the challenger stays dormant and the
        // bridge must not keep occupying `mainSessionId`. Disarm it here (watch
        // is written above first, so a reload still blocks re-arming via the
        // browser's isPastReviewStage guard). Idempotent: after the first disarm
        // the poll stops (syncPoll sees the empty mainSessionId); a re-arm that
        // races in afterwards is disarmed again on the next tick.
        if (PAST_REVIEW_STAGES.has(stage)) {
          await scope?.update?.({
            arena: { ...arena, watch, mainSessionId: '', reviewRequest: null }
          });
          return;
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

export { Config, PersistedChallenge, apply, inject, name };
export default { Config, apply, inject, name };
