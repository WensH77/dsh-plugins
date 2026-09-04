// Client smoke test: loads the browser bundle in a vm sandbox and verifies the
// module surface loads without reference errors.
// Run: node test/client-smoke.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

// resolved against this file so the suite runs from any cwd (npm test uses the
// plugin dir)
const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
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
  AbortController,
  fetch: async () => ({ json: async () => ({ ok: true }) }),
  react: { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: () => ({ current: null }) },
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
check("ask toggle exported", typeof loaded.AskModeToggle === "function");

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

// ── 交互测试：controller 的 load/toggle/回滚 + apply 的菜单面 shadow ────────
// （0.3.2 审查：此前 client 测试只有模块表面加载，无交互流程覆盖）
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchLog = [];
let catalogData = { ok: true, commands: [{ name: "export", description: "Export" }], hidden: ["export"], protected: ["plan", "goal"] };
let setBehavior = { ok: true, hidden: [] };
sandbox.fetch = async (url, init) => {
  fetchLog.push({ url, init });
  if (url.includes("/command-setting/catalog")) return { json: async () => catalogData };
  if (url.includes("/command-setting/set")) return { json: async () => setBehavior };
  throw new Error("unexpected fetch " + url);
};

// ── CommandsSettingController：聚合 + toggle 成功 + 失败回滚 ──────────────
{
  const commandUi = {
    candidates: async () => [{ name: "model", description: "Model switch" }],
    live: { contributions: new Map([["model", {}]]) }
  };
  const sessions = { list: { getSnapshot: () => ({ current: "s1" }) } };
  let hiddenChanged = 0;
  const ctl = new loaded.CommandsSettingController(commandUi, sessions, () => { hiddenChanged += 1; });
  await ctl.load();
  check("ctl: catalog url carries contributions", fetchLog.at(-1)?.url.includes("contributions="), fetchLog.at(-1)?.url);
  const snap1 = ctl.store.getSnapshot();
  check("ctl: aggregates host + contribution commands", snap1.commands.some((c) => c.name === "export") && snap1.commands.some((c) => c.name === "model"), JSON.stringify(snap1.commands.map((c) => c.name)));
  check("ctl: hidden loaded", snap1.hidden.includes("export"));

  setBehavior = { ok: true, hidden: ["export", "model"] };
  check("ctl: toggle success", (await ctl.toggle("model", true)) === true);
  const lastCall = fetchLog[fetchLog.length - 1];
  check("ctl: set body payload", lastCall?.init?.body === JSON.stringify({ hidden: ["export", "model"] }), lastCall?.init?.body);
  check("ctl: onHiddenChanged fired", hiddenChanged >= 1);
  check("ctl: hidden updated after toggle", ctl.store.getSnapshot().hidden.includes("model"));

  setBehavior = { ok: false, message: "boom" };
  check("ctl: toggle failure returns false", (await ctl.toggle("export", false)) === false);
  const rolled = ctl.store.getSnapshot();
  check("ctl: hidden rolled back on failure", rolled.hidden.includes("export") && rolled.hidden.includes("model"), JSON.stringify(rolled.hidden));
  check("ctl: error surfaced", rolled.error !== null, String(rolled.error));
}

// ── apply：candidates/matchEnter/matchSpace shadow + 事件刷新 + dispose 恢复 ─
{
  const ui = {
    candidates: async () => [{ name: "export", description: "x" }, { name: "model", description: "m" }],
    matchEnter: async (session, line) => "resolved:" + line,
    matchSpace: (session, token) => "space:" + token,
    live: { contributions: new Map([["model", {}]]) }
  };
  const events = new Map();
  const remote = {
    $on: (name, cb) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(cb);
      return () => {};
    }
  };
  catalogData = { ok: true, commands: [{ name: "export", description: "Export" }], hidden: ["export"], protected: ["plan", "goal"] };
  const dispose = loaded.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => "L:" + key },
    slots: { inject: () => {} },
    commandUi: ui,
    sessions: { list: { getSnapshot: () => ({ current: "s1" }) } },
    remote,
    on: () => () => {}
  });
  await sleep(30); // 等 syncHidden 的 catalog fetch

  check("apply: syncHidden catalog url carries contributions", fetchLog.some((c) => c.url.includes("/command-setting/catalog") && c.url.includes("contributions=")), fetchLog.map((c) => c.url).join(" | "));
  check("apply: candidates filters hidden contribution", (await ui.candidates({}, {})).every((r) => r.name !== "export"));
  check("apply: candidates keeps visible", (await ui.candidates({}, {})).some((r) => r.name === "model"));
  check("apply: matchEnter blocks hidden", (await ui.matchEnter(null, "/export", null)) === void 0);
  check("apply: matchEnter passes others", (await ui.matchEnter(null, "/model", null)) === "resolved:/model");
  check("apply: matchSpace blocks hidden", ui.matchSpace(null, "/export") === void 0);
  check("apply: matchSpace passes others", ui.matchSpace(null, "/model") === "space:/model");

  // commands/change 事件 → 重新拉取 hidden → 过滤面刷新
  catalogData = { ok: true, commands: [{ name: "export", description: "Export" }], hidden: [], protected: ["plan", "goal"] };
  for (const cb of events.get("commands/change") ?? []) cb();
  await sleep(30);
  check("apply: commands/change refreshes the filter", (await ui.candidates({}, {})).some((r) => r.name === "export"));

  dispose();
  check("apply: dispose restores candidates", (await ui.candidates({}, {})).some((r) => r.name === "export"));
  check("apply: dispose restores matchEnter", (await ui.matchEnter(null, "/export", null)) === "resolved:/export");
  check("apply: dispose restores matchSpace", ui.matchSpace(null, "/export") === "space:/export");
}

console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);
