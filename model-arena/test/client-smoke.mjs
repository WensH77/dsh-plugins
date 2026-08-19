// Client smoke test: loads the browser bundle in a vm sandbox and verifies the
// module surface, the /arena contribution registration, dictionary parity, and
// the popupSelect options/onSelect wiring.
// Run: node test/client-smoke.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let loaded = null;
let registered = null;
let dicts = null;
const noticeCalls = [];
const fetchCalls = [];

const sandbox = {
  window: {},
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, appendChild() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} }
  },
  console,
  URLSearchParams,
  encodeURIComponent,
  AbortController,
  fetch: async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (typeof url === "string" && url.startsWith("/model-arena/state")) {
      return { json: async () => ({ ok: true, enabled: false }) };
    }
    if (opts?.method === "POST") {
      return { json: async () => ({ ok: true, enabled: true }) };
    }
    return { json: async () => ({ ok: true, enabled: false }) };
  }
};
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      throw new Error("unexpected require: " + id);
    });
  }
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  ok  " + label);
  } else {
    failed += 1;
    console.log(" FAIL " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}

check("apply exported", typeof loaded.apply === "function");
check("inject exported as locale+commandUi", Array.isArray(loaded.inject) && loaded.inject.join(",") === "locale,commandUi");

// apply() registers dictionaries + the /arena contribution through late binding
loaded.apply({
  effect: (fn) => fn(),
  locale: {
    register: (ns, d) => {
      dicts = d;
      return () => {};
    },
    bind: () => (key) => "L:" + key
  },
  inject: (names, cb) => {
    cb({
      get: () => ({
        register: (contribution) => {
          registered = contribution;
          return () => {};
        },
        noticeFor: (id, level, text) => {
          noticeCalls.push({ id, level, text });
        }
      }),
      effect: (fn) => fn()
    });
  }
});

check("dictionaries registered", dicts !== null);
check("zh/en parity", dicts !== null && Object.keys(dicts.zh).length === Object.keys(dicts.en).length);
const zhOnly = Object.keys(dicts.zh).filter((k) => !(k in dicts.en));
const enOnly = Object.keys(dicts.en).filter((k) => !(k in dicts.zh));
check("no key drift", zhOnly.length === 0 && enOnly.length === 0, zhOnly.concat(enOnly).join(","));

check("arena contribution registered", registered !== null && registered.name === "arena");
check("popupSelect kind", registered !== null && registered.ui?.kind === "popupSelect");
check("available is a function", typeof registered.available === "function");
check("available accepts any session", registered.available({ sessionId: "s1" }) === true);

// options() reads the state endpoint and marks the current state active
const rows = await registered.ui.options({ sessionId: "s1" }, new AbortController().signal);
check("options returns two rows", Array.isArray(rows) && rows.length === 2);
check("options GET state", fetchCalls.some((c) => c.url === "/model-arena/state"));
const on = rows.find((r) => r.id === "on");
const off = rows.find((r) => r.id === "off");
check("disabled -> off row active", off !== undefined && off.active === true);
check("disabled -> on row not active", on !== undefined && on.active === false);

// onSelect() POSTs the target state and raises a success notice
await registered.ui.onSelect({ id: "on" }, { sessionId: "s1" });
const post = fetchCalls.find((c) => c.opts?.method === "POST");
check("onSelect POSTs /model-arena/set", post !== undefined && post.url === "/model-arena/set");
check("onSelect body enabled:true", post !== undefined && post.opts.body === JSON.stringify({ enabled: true }));
check("success notice raised", noticeCalls.length === 1 && noticeCalls[0].level === "success" && noticeCalls[0].id === "s1");

console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);
