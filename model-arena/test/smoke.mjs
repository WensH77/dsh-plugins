// Smoke test for model-arena node half: mock ctx (webServer + settings inject)
// and verify the state/set endpoints, validation, and the settings fallback.
// Run: node test/smoke.mjs
import { apply } from "../lib/index.js";

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  ok  " + label);
  } else {
    failed += 1;
    console.log(" FAIL " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}

/** A settings scope mock: state initialized from the register base, update() merges. */
function makeSettingsScope() {
  let state = {};
  return {
    get: () => ({ ...state }),
    update: async (patch) => {
      state = { ...state, ...patch };
    },
    watch: () => () => {}
  };
}

/**
* Build a ctx and run apply() against it.
* @param routes - Map the webServer registrations land in.
* @param extraConfig - plugin config passed to apply().
* @param withSettings - whether ctx.inject(['settings']) fires (settings service mounted).
* @returns the created settings scope (or null when not mounted).
*/
function makeCtx(routes, extraConfig, withSettings = true) {
  const scope = withSettings ? makeSettingsScope() : null;
  const settingsCtx = {
    settings: {
      register: (ns, schema, options) => {
        if (options?.base !== void 0) scope.update(options.base);
        return scope;
      }
    },
    effect: (fn) => fn()
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      }
    },
    inject: (names, cb) => {
      if (withSettings) cb(settingsCtx);
    }
  };
  apply(ctx, extraConfig);
  return scope;
}

function request(routes, path, method, body) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error("no route: " + path);
  return new Promise((done) => {
    const res = {
      writeHead: (status, headers) => {
        res.status = status;
        res.headers = headers;
      },
      end: (bodyText) => {
        res._body = String(bodyText);
        done(res);
      }
    };
    const req = { url: "http://x" + path };
    if (method === "POST") {
      const payload = JSON.stringify(body);
      req.emit = (event, chunk) => {
        if (event === "data") req._chunks = (req._chunks ?? []).concat(Buffer.from(chunk));
        if (event === "end") req._ended = true;
      };
      req.on = (event, cb) => {
        if (event === "data") cb(Buffer.from(payload));
        if (event === "end") cb();
      };
    }
    handler(req, res);
  });
}

// ── context 1: default config, settings mounted ─────────────────────────────
const routes = new Map();
const scope = makeCtx(routes, {});

let r = await request(routes, "/model-arena/state", "GET");
let body = JSON.parse(r._body);
check("state ok", r.status === 200 && body.ok === true);
check("state defaults to disabled", body.enabled === false);

r = await request(routes, "/model-arena/set", "POST", { enabled: true });
body = JSON.parse(r._body);
check("set ok", r.status === 200 && body.ok === true);
check("set returns enabled", body.enabled === true);
check("scope.update persisted", scope.get().enabled === true);

r = await request(routes, "/model-arena/state", "GET");
body = JSON.parse(r._body);
check("state reflects update", body.enabled === true);

r = await request(routes, "/model-arena/set", "POST", { enabled: false });
body = JSON.parse(r._body);
check("set off ok", r.status === 200 && body.ok === true && body.enabled === false);
check("scope.update persisted off", scope.get().enabled === false);

// ── context 2: validation ───────────────────────────────────────────────────
r = await request(routes, "/model-arena/set", "POST", { enabled: "yes" });
body = JSON.parse(r._body);
check("non-boolean rejected", r.status === 400 && body.ok === false && body.code === "bad-enabled");

r = await request(routes, "/model-arena/set", "POST", {});
body = JSON.parse(r._body);
check("missing enabled rejected", r.status === 400 && body.code === "bad-enabled");

// ── context 3: settings service not mounted ─────────────────────────────────
const routes3 = new Map();
const scope3 = makeCtx(routes3, {}, false);

r = await request(routes3, "/model-arena/state", "GET");
body = JSON.parse(r._body);
check("unmounted state falls back to default", r.status === 200 && body.ok === true && body.enabled === false);

r = await request(routes3, "/model-arena/set", "POST", { enabled: true });
body = JSON.parse(r._body);
check("unmounted set -> 503", r.status === 503 && body.ok === false && body.code === "settings-unavailable");
check("unmounted scope stays null", scope3 === null);

// ── context 4: config base ──────────────────────────────────────────────────
const routes4 = new Map();
makeCtx(routes4, { enabled: true }, false);
r = await request(routes4, "/model-arena/state", "GET");
body = JSON.parse(r._body);
check("config base enabled", r.status === 200 && body.ok === true && body.enabled === true);

// mounted + config base: the register base seeds the scope, so GET resolves true
const routes5 = new Map();
const scope5 = makeCtx(routes5, { enabled: true }, true);
r = await request(routes5, "/model-arena/state", "GET");
body = JSON.parse(r._body);
check("mounted config base enabled", body.ok === true && body.enabled === true);
check("mounted scope seeded from base", scope5.get().enabled === true);

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
