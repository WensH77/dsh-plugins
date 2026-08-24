// dsh-plugin-session-export — node half
// A Cordis plugin for the dsh web profile. Serves the export transcript for the
// browser half:
//
//   GET /session-export/data?session=<id>
//
// The transcript is the session's append-only human transcript: user messages
// the human actually typed (`user/message` with `source.kind === 'user'`) and
// assistant messages, in log order, from the very first event to the last.
// Only visible `text` content blocks survive — reasoning (Think) blocks,
// tool-call blocks, and replacement (compaction/edit) copies are counted and
// dropped, so the exported conversation shows exactly "user input, model
// output, user input, model output, …" with no process internals.
import z from '@deepseek-ai/schemastery';

const name = 'session-export';
const inject = ['webServer', 'sessions'];

// All fields optional by default in schemastery (fields are optional unless
// marked .required()); defaults applied in apply().
const Config = z.object({
  // Hard cap on exported messages (user + assistant) — a safety valve for
  // pathological sessions; a truncated flag rides the response.
  maxMessages: z.number(),
  // Export image width in CSS px (clamped client-side to 480..1400).
  width: z.number(),
  // Raster scale (device pixels per CSS px; clamped client-side to 1..3).
  scale: z.number(),
  // Max canvas height per output part in CSS px (long sessions split into
  // <name>-1.png, <name>-2.png …).
  partHeight: z.number(),
  // Segment rasterization height in CSS px (each segment is drawn separately
  // then stitched onto the part canvas).
  segmentHeight: z.number()
});

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/**
 * Build the export transcript from a session event log.
 *
 * Selection rules (mirror the surface layer's own guidance: append-origin
 * events are the durable human transcript, replacement copies stay model-only):
 *  - only events whose `surfaceOp === 'append'` enter the export (a landed
 *    replacement would erase conversation the user already saw);
 *  - `user/message` only when `source.kind === 'user'` (plugin/agent-injected
 *    context is not user input);
 *  - `assistant/message` contributes its `text` blocks only; `reasoning`
 *    (Think) and `tool-call` blocks are skipped and counted.
 * @param {readonly {type: string, surfaceOp?: unknown, time?: number, data?: any}[]} events
 * @param {{maxMessages?: number}} [options]
 * @returns {{messages: {role: 'user'|'assistant', text: string, time?: number, imageCount: number}[], skipped: {reasoning: number, toolCalls: number, images: number, pluginUser: number, replaced: number}, truncated: boolean}}
 */
export function buildTranscript(events, { maxMessages = 4000 } = {}) {
  const messages = [];
  const skipped = { reasoning: 0, toolCalls: 0, images: 0, pluginUser: 0, replaced: 0 };
  let truncated = false;
  const log = Array.isArray(events) ? events : [];
  for (const event of log) {
    if (messages.length >= maxMessages) {
      truncated = true;
      break;
    }
    if (event.surfaceOp !== 'append') {
      skipped.replaced += 1;
      continue;
    }
    if (event.type === 'user/message') {
      const data = event.data;
      if (data?.source?.kind !== 'user') {
        skipped.pluginUser += 1;
        continue;
      }
      const content = Array.isArray(data.content) ? data.content : [];
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n')
        .trim();
      const imageCount = content.filter((block) => block?.type === 'image').length;
      if (text === '' && imageCount === 0) continue;
      messages.push({ role: 'user', text, time: event.time, imageCount });
      continue;
    }
    if (event.type === 'assistant/message') {
      const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      // An empty-content assistant/message exists only to host usage — nothing
      // visible, nothing to export.
      if (content.length === 0) continue;
      const textBlocks = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textBlocks.push(block.text);
        } else if (block?.type === 'reasoning') {
          skipped.reasoning += 1;
        } else if (block?.type === 'tool-call') {
          skipped.toolCalls += 1;
        } else if (block?.type === 'image') {
          skipped.images += 1;
        }
      }
      const text = textBlocks.join('\n\n').trim();
      // A pure tool-call step renders no visible assistant text.
      if (text === '') continue;
      messages.push({ role: 'assistant', text, time: event.time, imageCount: 0 });
    }
  }
  return { messages, skipped, truncated };
}

/**
 * Derive the export image title: the latest logged `session/title` wins;
 * otherwise the first human user message's first line (≤ 60 chars).
 * @param {readonly any[]} events
 * @param {{role: string, text: string}[]} messages
 * @returns {string}
 */
export function deriveTitle(events, messages) {
  const log = Array.isArray(events) ? events : [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
      return event.data.title.trim();
    }
  }
  for (const message of messages) {
    if (message?.role !== 'user' || typeof message.text !== 'string') continue;
    const line = message.text.split('\n')[0].trim();
    if (line === '') continue;
    return line.length > 60 ? line.slice(0, 60) + '…' : line;
  }
  return '';
}

/**
 * Build the `/session-export/data` request handler bound to an env.
 * @param {{ctx: any, config: {maxMessages: number, width: number, scale: number, partHeight: number, segmentHeight: number}}} env
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function buildDataHandler(env) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const sessionId = url.searchParams.get('session') ?? '';
      if (sessionId === '') {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'session id is required' });
        return;
      }
      const session = env.ctx.sessions.get(sessionId);
      if (session === undefined) {
        sendJson(res, 404, { ok: false, code: 'session-not-found', message: 'no live session ' + sessionId });
        return;
      }
      const { messages, skipped, truncated } = buildTranscript(session.events, { maxMessages: env.config.maxMessages });
      const title = deriveTitle(session.events, messages);
      sendJson(res, 200, {
        ok: true,
        sessionId,
        title,
        messages,
        skipped,
        truncated,
        config: {
          width: env.config.width,
          scale: env.config.scale,
          partHeight: env.config.partHeight,
          segmentHeight: env.config.segmentHeight
        }
      });
    } catch (error) {
      env.ctx.logger?.warn?.('session-export: ' + String(error?.message ?? error));
      sendJson(res, 500, { ok: false, code: 'export-failed', message: String(error?.message ?? error) });
    }
  };
}

/** Register a web route bound to the plugin ctx lifecycle (dispose-safe). */
function registerWebRoute(ctx, route) {
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
  const env = {
    ctx,
    config: {
      maxMessages: config.maxMessages ?? 4000,
      width: config.width ?? 860,
      scale: config.scale ?? 2,
      partHeight: config.partHeight ?? 10000,
      segmentHeight: config.segmentHeight ?? 8000
    }
  };
  const disposers = [
    registerWebRoute(ctx, {
      kind: 'exact',
      path: '/session-export/data',
      handler: buildDataHandler(env)
    })
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
