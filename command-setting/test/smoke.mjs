// Smoke test for command-setting node half: mock ctx (commands + webServer +
// settings inject) and verify catalog aggregation and the hidden filter.
// Run: node test/smoke.mjs
import { apply } from "../lib/index.js";

const DESCRIPTORS = [
  { name: "export", description: "Export" },
  { name: "feedback", description: "Feedback" },
  { name: "permission", description: "Permission" },
  { name: "plan", description: "Plan mode" },
  { name: "goal", description: "Goal" },
  { name: "theseus", description: "Theseus CLI" },
  { name: "rollback", description: "Rollback" }
];

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  ok  " + label);
  } else {
    failed += 1;
    console.log(" FAIL " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}

const AGENT_DESCRIPTORS = [
  { name: "compact", description: "Compact context" },
  { name: "rollback", description: "Rollback" }
];

function makeCtx(routes, extraConfig) {
  const settingsCtx = {
    settings: {
      register: (ns, schema, options) => ({
        get: () => ({ hidden: ["export", "feedback", "permission", "compact"] }),
        watch: () => () => {}
      })
    },
    effect: (fn) => fn()
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    // cordis ctx.effect: runs the callback now, returns its disposer (lib binds
    // webServer routes to the plugin lifecycle through it)
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    commands: {
      list: (agent) => {
        if (agent === void 0) return DESCRIPTORS.slice();
        if (typeof agent === "string") return []; // wrong key type: no agent layer
        return AGENT_DESCRIPTORS.slice();
      },
      notifyChange: () => {}
    },
    agents: {
      get: (id) => (id === "s1" ? { id: "s1", agent: true } : void 0)
    },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      }
    },
    inject: (names, cb) => cb(settingsCtx)
  };
  apply(ctx, extraConfig);
  return ctx;
}

function request(routes, path, params) {
  const qs = params === undefined ? "" : "?" + new URLSearchParams(params).toString();
  const handler = routes.get(path);
  if (handler === undefined) throw new Error("no route: " + path);
  return new Promise((done) => {
    const res = {
      writeHead: (status, headers) => { res.status = status; res.headers = headers; },
      end: (body) => { res._body = String(body); done(res); }
    };
    handler({ url: "http://x" + path + qs }, res);
  });
}

// ── context 1: default config ───────────────────────────────────────────────
const routes = new Map();
const ctx = makeCtx(routes, {});

let r = await request(routes, "/command-setting/catalog");
let body = JSON.parse(r._body);
check("catalog ok", r.status === 200 && body.ok === true);
check("catalog lists all global commands", Array.isArray(body.commands) && body.commands.length === DESCRIPTORS.length);
check("catalog returns protected", Array.isArray(body.protected) && body.protected.includes("plan"));
check("catalog hidden from settings scope", Array.isArray(body.hidden) && body.hidden.includes("export"));

const filtered = ctx.commands.list(void 0);
check("list shadow filters hidden", filtered.every((d) => !["export", "feedback", "permission"].includes(d.name)));
check("list keeps others", filtered.some((d) => d.name === "theseus"));
check("list keeps protected", filtered.some((d) => d.name === "plan"));

// ── context 2: session-scoped catalog unions agent commands (e.g. /compact) ─
r = await request(routes, "/command-setting/catalog", { session: "s1" });
body = JSON.parse(r._body);
check("session catalog ok", body.ok === true);
check("session catalog includes global", body.commands.some((c) => c.name === "export"));
check("session catalog includes agent-scoped compact", body.commands.some((c) => c.name === "compact"));
check("session catalog includes agent-scoped rollback", body.commands.some((c) => c.name === "rollback"));
// raw-string session ids must NOT resolve an agent layer (the old bug)
r = await request(routes, "/command-setting/catalog", { session: "no-such-session" });
body = JSON.parse(r._body);
check("unknown session falls back to global only", body.ok && !body.commands.some((c) => c.name === "compact"));

// ── context 3: per-agent menu list still applies the global hidden filter ──
const agentView = ctx.commands.list({ id: "s1" });
check("per-agent menu list hides compact", agentView.every((d) => d.name !== "compact"));
check("per-agent menu list keeps rollback", agentView.some((d) => d.name === "rollback"));

// ── context 3: config.hidden is the composition base ───────────────────────
const routes2 = new Map();
makeCtx(routes2, { hidden: ["export"] });
r = await request(routes2, "/command-setting/catalog");
body = JSON.parse(r._body);
check("config hidden merges", body.ok && body.hidden.includes("export"));
check("settings scope wins over config base", body.ok && body.hidden.includes("feedback"));

// ── context 4: stop → start (settings registration leaks across stop; re-apply must not throw) ──
function makeLeakySettings() {
  const registrations = new Map(); // leaks: mimic dsh-settings tying the namespace to the provider's fiber
  return {
    register(ns, schema, opts) {
      if (registrations.has(ns)) throw new Error('settings namespace "' + ns + '" is already registered');
      const reg = { value: { hidden: ['export', 'feedback', 'permission'] }, watchers: [] };
      registrations.set(ns, reg);
      return {
        get: () => reg.value,
        watch: (cb) => { reg.watchers.push(cb); return () => {}; },
        update: async (patch) => { reg.value = { ...reg.value, ...patch }; }
      };
    },
    get: (ns) => registrations.get(ns)?.value,
    update: (ns, patch) => { const reg = registrations.get(ns); reg.value = { ...reg.value, ...patch }; return Promise.resolve(); }
  };
}

function makeRestartCtx(routes) {
  const settings = makeLeakySettings();
  const commands = {
    list: () => DESCRIPTORS.slice(),
    notifyChange: () => {}
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    // cordis ctx.effect shim (see makeCtx): run now, hand back the disposer so
    // dispose() still unregisters the routes
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    commands,
    agents: { get: () => void 0 },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      }
    },
    inject: (names, cb) => { cb({ settings }); return { dispose: () => {} }; }
  };
  return ctx;
}

{
  const routes = new Map();
  const ctx = makeRestartCtx(routes);
  const dispose1 = apply(ctx, {});
  let r = await request(routes, "/command-setting/catalog");
  check("restart: first apply catalog ok", r.status === 200 && JSON.parse(r._body).ok === true);
  check("restart: first apply filters list", ctx.commands.list().every((d) => !["export", "feedback", "permission"].includes(d.name)));

  dispose1(); // stop

  // After stop the list shadow must be restored (menu unfiltered again).
  check("restart: list restored after stop", ctx.commands.list().some((d) => d.name === "export"));

  // start again: must NOT throw "already registered"
  let threw = false;
  try {
    apply(ctx, {});
  } catch (_reapplyFailure) {
    threw = true;
  }
  check("restart: re-apply does not throw", !threw);
  r = await request(routes, "/command-setting/catalog");
  check("restart: second apply catalog ok", r.status === 200 && JSON.parse(r._body).ok === true);
  check("restart: second apply filters list", ctx.commands.list().every((d) => !["export", "feedback", "permission"].includes(d.name)));
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
