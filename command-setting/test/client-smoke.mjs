// Client smoke test: loads the browser bundle in a vm sandbox and verifies the
// module surface loads without reference errors.
// Run: node test/client-smoke.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync("command-setting/lib/client.js", "utf8");
let loaded = null;
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
  fetch: async () => ({ json: async () => ({ ok: true }) }),
  react: { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f },
  "react/jsx-runtime": {},
  "react-dom": { createPortal: (n) => n }
};
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      if (id in sandbox) return sandbox[id];
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
check("controller exported", typeof loaded.CommandsSettingController === "function");
check("section exported", typeof loaded.CommandsSettingSection === "function");
check("plan toggle exported", typeof loaded.PlanModeToggle === "function");

// locale dictionaries remain in sync
let dicts = null;
loaded.apply({
  effect: (fn) => fn(),
  locale: { register: (ns, d) => { dicts = d; return () => {}; }, bind: () => (key) => "L:" + key },
  slots: { inject: () => {} },
  commandUi: {
    candidates: async () => [],
    matchEnter: async () => void 0,
    matchSpace: () => void 0,
    live: { contributions: new Map() }
  },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  remote: { $on: () => () => {} },
  on: () => () => {}
});
check("zh/en parity", dicts !== null && Object.keys(dicts.zh).length === Object.keys(dicts.en).length);
const zhOnly = Object.keys(dicts.zh).filter((k) => !(k in dicts.en));
const enOnly = Object.keys(dicts.en).filter((k) => !(k in dicts.zh));
check("no key drift", zhOnly.length === 0 && enOnly.length === 0, zhOnly.concat(enOnly).join(","));

console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);
