// Smoke test for command-setting node half: mock ctx (commands + webServer +
// settings inject) and verify catalog aggregation and the hidden filter.
// Run: node test/smoke.mjs
import { EventEmitter } from "node:events";
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

function makeCtx(routes, extraConfig, options = {}) {
  // 可变 settings 存储：sweep 的 scope.update 写入这里，updateCalls 记录每次
  // 持久化结果供断言。
  const value = { hidden: options.initialHidden ?? ["export", "feedback", "permission", "compact"] };
  const updateCalls = [];
  const watchers = [];
  const settingsCtx = {
    settings: {
      register: (ns, schema, opts) => ({
        get: () => ({ hidden: [...value.hidden] }),
        watch: (cb) => { watchers.push(cb); return () => {}; },
        update: async (patch) => {
          value.hidden = [...(patch?.hidden ?? [])];
          updateCalls.push([...value.hidden]);
          for (const cb of watchers) cb();
        }
      }),
      get: (ns) => ({ hidden: [...value.hidden] }),
      update: async (ns, patch) => {
        value.hidden = [...(patch?.hidden ?? [])];
      }
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
    // sessions 供归档清理的全集收集；缺省给一个 live 会话 s1；显式 undefined
    // 可模拟服务缺失（清理应放弃）。
    sessions: options.sessions === undefined ? { list: () => [{ id: "s1" }] } : options.sessions,
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      }
    },
    inject: (names, cb) => cb(settingsCtx)
  };
  apply(ctx, extraConfig);
  ctx.__value = value;
  ctx.__updateCalls = updateCalls;
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

function postRequest(routes, path, payload) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error("no route: " + path);
  return new Promise((done) => {
    const req = new EventEmitter();
    req.url = "http://x" + path;
    const res = {
      writeHead: (status, headers) => { res.status = status; res.headers = headers; },
      end: (body) => { res._body = String(body); done(res); }
    };
    handler(req, res);
    req.emit("data", Buffer.from(JSON.stringify(payload)));
    req.emit("end");
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

// ── context 5: archived (ghost) hidden entries are swept ───────────────────
// hidden 里的条目已不在命令面（命令被卸载/更名）时，catalog 读取会主动清理并
// 持久化；agent-scoped 命令（compact 在 s1 的 agent 层）不被误删。
{
  const routes5 = new Map();
  const ctx5 = makeCtx(routes5, {}, { initialHidden: ["export", "ghostcmd", "compact"] });
  // 客户端上报贡献面（空即可——此处没有贡献命令），命令面可信才清理
  const r5 = await request(routes5, "/command-setting/catalog", { contributions: "" });
  const body5 = JSON.parse(r5._body);
  check("sweep: ghost entry removed from hidden", !body5.hidden.includes("ghostcmd"), JSON.stringify(body5.hidden));
  check("sweep: global hidden kept", body5.hidden.includes("export"));
  check("sweep: agent-scoped hidden kept", body5.hidden.includes("compact"));
  check("sweep: persisted via scope.update", ctx5.__updateCalls.length >= 1 && !ctx5.__updateCalls[ctx5.__updateCalls.length - 1].includes("ghostcmd"), JSON.stringify(ctx5.__updateCalls));
}

// ── context 6: sessions 服务缺失时清理放弃（防误删） ─────────────────────────
{
  const routes6 = new Map();
  const ctx6 = makeCtx(routes6, {}, { initialHidden: ["export", "ghostcmd", "compact"], sessions: null });
  const r6 = await request(routes6, "/command-setting/catalog", { contributions: "" });
  const body6 = JSON.parse(r6._body);
  check("no-sessions: sweep skipped, ghost kept", body6.hidden.includes("ghostcmd"), JSON.stringify(body6.hidden));
  check("no-sessions: update never called", ctx6.__updateCalls.length === 0, JSON.stringify(ctx6.__updateCalls));
}

// ── context 6b: 贡献命令（/model，浏览器端）的 hidden 受保护 ─────────────────
// /model 只存在于客户端贡献面，node 端命令面看不到——客户端上报 contributions
// 后必须保留；全局幽灵仍被清。
{
  const routes6b = new Map();
  const ctx6b = makeCtx(routes6b, {}, { initialHidden: ["export", "model", "ghostcmd"] });
  const r6b = await request(routes6b, "/command-setting/catalog", { contributions: "model" });
  const body6b = JSON.parse(r6b._body);
  check("contrib: contribution hidden kept", body6b.hidden.includes("model"), JSON.stringify(body6b.hidden));
  check("contrib: global hidden kept", body6b.hidden.includes("export"));
  check("contrib: ghost still swept", !body6b.hidden.includes("ghostcmd"), JSON.stringify(body6b.hidden));
}

// ── context 6c: 无 contributions 参数时清理放弃（外部/旧客户端，贡献面未知） ─
{
  const routes6c = new Map();
  const ctx6c = makeCtx(routes6c, {}, { initialHidden: ["export", "ghostcmd"] });
  const r6c = await request(routes6c, "/command-setting/catalog");
  const body6c = JSON.parse(r6c._body);
  check("no-contrib: sweep skipped, ghost kept", body6c.hidden.includes("ghostcmd"), JSON.stringify(body6c.hidden));
  check("no-contrib: update never called", ctx6c.__updateCalls.length === 0, JSON.stringify(ctx6c.__updateCalls));
}

// ── context 6d: 有效隐藏全部保留——命令面含所有 hidden 名时不删不写 ──────────
{
  const routes6d = new Map();
  const ctx6d = makeCtx(routes6d, {}, { initialHidden: ["export", "feedback", "permission", "compact", "rollback"] });
  const r6d = await request(routes6d, "/command-setting/catalog", { contributions: "" });
  const body6d = JSON.parse(r6d._body);
  check("all-known: no hidden dropped", ["export", "feedback", "permission", "compact", "rollback"].every((n) => body6d.hidden.includes(n)), JSON.stringify(body6d.hidden));
  check("all-known: no settings write", ctx6d.__updateCalls.length === 0, JSON.stringify(ctx6d.__updateCalls));
}

// ── context 7: set endpoint validation and dedupe ────────────────────────────
{
  const routes7 = new Map();
  const ctx7 = makeCtx(routes7, {}, { initialHidden: [] });

  let r7 = await postRequest(routes7, "/command-setting/set", { hidden: "not-an-array" });
  check("set: bad-hidden 400", r7.status === 400 && JSON.parse(r7._body).code === "bad-hidden");

  r7 = await postRequest(routes7, "/command-setting/set", { hidden: ["export", "BAD Name"] });
  check("set: bad-name 400", r7.status === 400 && JSON.parse(r7._body).code === "bad-name");

  r7 = await postRequest(routes7, "/command-setting/set", { hidden: ["export", "export", "feedback", "plan"] });
  const body7 = JSON.parse(r7._body);
  check("set: ok", r7.status === 200 && body7.ok === true);
  check("set: duplicates collapsed", JSON.stringify(body7.hidden) === JSON.stringify(["export", "feedback"]), JSON.stringify(body7.hidden));
  check("set: protected dropped on write", !body7.hidden.includes("plan"));
  check("set: persisted", JSON.stringify(ctx7.__value.hidden) === JSON.stringify(["export", "feedback"]), JSON.stringify(ctx7.__value.hidden));

  r7 = await postRequest(routes7, "/command-setting/set", { hidden: ["a".repeat(100000)] });
  check("set: oversized body rejected (not 200)", r7.status !== 200, "status=" + r7.status);
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
