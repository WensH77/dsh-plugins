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
  inject: () => {},
  get: () => void 0,
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
    inject: () => {},
    get: () => void 0,
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

// ── '#' 会话引用：token 检测 / 候选过滤 / controller 包装与还原 ─────────────
{
  const { hashTokenAt, buildHashRows, installHashTrigger, HASH_SOURCE } = loaded;

  check("hash exports present", typeof hashTokenAt === "function" && typeof buildHashRows === "function" && typeof installHashTrigger === "function" && HASH_SOURCE === "command-setting-sessions");

  // token 检测：词边界 + token 到 caret
  const at = (draft, caret) => JSON.stringify(hashTokenAt(draft, caret));
  check("hashTokenAt: bare # at start", at("#", 1) === JSON.stringify({ start: 0, end: 1, query: "" }));
  check("hashTokenAt: after whitespace", at("hi #ab", 6) === JSON.stringify({ start: 3, end: 6, query: "ab" }));
  check("hashTokenAt: after @token", at("hi @x #ab", 9) === JSON.stringify({ start: 6, end: 9, query: "ab" }));
  check("hashTokenAt: caret inside token", at("#ab", 1) === JSON.stringify({ start: 0, end: 1, query: "" }));
  check("hashTokenAt: mid-word # is not a trigger", hashTokenAt("a#b", 3) === null);
  check("hashTokenAt: whitespace closes the token", hashTokenAt("#ab cd", 6) === null);
  check("hashTokenAt: empty draft", hashTokenAt("", 0) === null);
  check("hashTokenAt: invalid input", hashTokenAt(null, 0) === null && hashTokenAt("#a", 9) === null);

  // 候选过滤：未归档 + 主代理 + 跨工作区（cwd 仅在不同工作区时显示）
  const t = (key, params) => params?.n === void 0 ? "L:" + key : "L:" + key + ":" + params.n;
  const now = 1_000_000_000;
  const hour = 3_600_000;
  const candidates = [
    { sessionId: "s1", label: "Alpha", mention: "M:Alpha", cwd: "/w/a", sameWorkspace: true, createdAt: now - hour },
    { sessionId: "s2", label: "Beta", mention: "M:Beta", cwd: "/w/b", sameWorkspace: false, createdAt: now - hour },
    { sessionId: "s3", label: "Archived", mention: "M:Archived", cwd: "/w/c", sameWorkspace: false, createdAt: now - hour },
    { sessionId: "s4", label: "Child", mention: "M:Child", cwd: "/w/d", sameWorkspace: false, createdAt: now - hour },
    { sessionId: "s5", label: "NoMention", cwd: "/w/e", sameWorkspace: false, createdAt: now - hour },
    { sessionId: "s6", label: "NoCwd", mention: "M:NoCwd", sameWorkspace: false, createdAt: now - hour },
    { sessionId: "s7", label: "HomeProj", mention: "M:HomeProj", cwd: "/Users/me/proj", sameWorkspace: false, createdAt: now - hour }
  ];
  const summaries = {
    s1: { updatedAt: now - 2 * hour },
    s2: { updatedAt: now - 3 * hour },
    s3: { updatedAt: now - hour },
    s4: { updatedAt: now - hour, origin: "subagent" },
    s6: { updatedAt: now },
    s7: { updatedAt: now - 30 * 60_000 }
  };
  const rows = buildHashRows(t, candidates, new Set(["s3"]), summaries, "/Users/me", now);
  check("hash rows: archived + subagent + mention-less dropped", rows.length === 4 && !rows.some((r) => ["Archived", "Child", "NoMention"].includes(r.name)), JSON.stringify(rows.map((r) => r.name)));
  check("hash rows: same-workspace hides cwd", rows[0].description === "L:hashHours:2", rows[0].description);
  check("hash rows: cross-workspace shows cwd", rows[1].description.startsWith("/w/b · "), rows[1].description);
  check("hash rows: home abbreviated", rows[3].description.startsWith("~/proj · "), rows[3].description);
  check("hash rows: missing cwd labelled", rows[2].description.startsWith("L:hashNoCwd · "), rows[2].description);
  check("hash rows: session icon + section + pick payload", rows[0].icon === "session" && rows[0].section === "L:hashSection" && JSON.parse(rows[0].value).mention === "M:Alpha");
  check("hash rows: empty/odd input tolerated", buildHashRows(t, null, null, null, void 0, now).length === 0 && buildHashRows(t, [{ sessionId: "" }], new Set(), {}, void 0, now).length === 0);

  // controller 包装：'#' → '@' 改写 + roster 拦截 + 还原
  const trackCalls = [];
  const live = { controllers: new Map(), sources: [{ trigger: "@", name: "reference" }] };
  class FakeController {
    constructor(id) {
      this.deps = { sessionId: id, roster: { sources: (trigger) => live.sources.filter((s) => s.trigger === trigger) } };
      this.hit = null;
      this.menuEvents = [];
    }
    stopFetch() {
      this.menuEvents.push("stopFetch");
    }
    reduce(ev) {
      this.menuEvents.push("reduce:" + ev.type);
      if (ev.type === "close") this.hit = null;
    }
    // 宿主 detectTrigger 的最小替身：只识别 @ 与 /
    track(draft, caret, guard, draftRev) {
      const before = draft.slice(0, caret);
      const atToken = /(?:^|\s)@([^\s]*)$/u.exec(before);
      let trigger = null;
      let query = "";
      let start = -1;
      if (atToken !== null) {
        trigger = "@";
        query = atToken[1];
        start = caret - atToken[0].trimStart().length;
      } else {
        const slash = before.lastIndexOf("/");
        if (slash >= 0 && !/\s/u.test(before.slice(slash))) {
          trigger = "/";
          query = before.slice(slash + 1);
          start = slash;
        }
      }
      // 宿主先写 hit，再按 hit.trigger 取 roster（顺序决定 roster 拦截是否可见）。
      this.hit = trigger === null ? null : { trigger, query, span: { start, end: caret, draftRev } };
      trackCalls.push({ draft, trigger, sources: trigger === null ? [] : this.deps.roster.sources(trigger).map((s) => s.name) });
    }
  }
  const preExisting = new FakeController("s0");
  live.controllers.set("s0", preExisting);
  class FakeInputTriggers {
    constructor() {
      this.live = live;
    }
    registerSource(src) {
      live.sources.push(src);
      return () => {
        const index = live.sources.indexOf(src);
        if (index >= 0) live.sources.splice(index, 1);
      };
    }
    sessionOf(actx) {
      const controller = new FakeController(actx.id);
      live.controllers.set(actx.id, controller);
      return controller;
    }
  }
  const fakeInputTriggers = new FakeInputTriggers();
  const hashSource = { trigger: "#", name: HASH_SOURCE, candidates: async () => [], onPick: () => void 0, codec: { clipboardText: (r) => r, serialize: async (r) => r } };
  const disposeHash = installHashTrigger(fakeInputTriggers, hashSource);

  check("hash: source registered", live.sources.includes(hashSource));
  preExisting.track("hi #ab", 6, { tier: "plain" }, 1);
  check("hash: pre-existing controller wrapped (draft rewritten for host detector)", trackCalls.at(-1).draft === "hi @ab", trackCalls.at(-1).draft);
  check("hash: hit resolves to the # source only", trackCalls.at(-1).sources.includes(HASH_SOURCE) && !trackCalls.at(-1).sources.includes("reference"), JSON.stringify(trackCalls.at(-1).sources));
  check("hash: hit trigger is @ with the # span start", preExisting.hit.trigger === "@" && preExisting.hit.span.start === 3, JSON.stringify(preExisting.hit));

  const ctl = fakeInputTriggers.sessionOf({ id: "s1" });
  check("hash: sessionOf wraps late controllers", Object.prototype.hasOwnProperty.call(ctl, "track"));
  ctl.track("hi @ab", 6, { tier: "plain" }, 2);
  check("hash: plain @ still routes to @ sources", trackCalls.at(-1).draft === "hi @ab" && trackCalls.at(-1).sources.includes("reference"), JSON.stringify(trackCalls.at(-1)));
  ctl.track("hi #ab", 6, { tier: "frozen" }, 3);
  check("hash: frozen tier leaves the draft untouched", trackCalls.at(-1).draft === "hi #ab" && trackCalls.at(-1).trigger === null, JSON.stringify(trackCalls.at(-1)));
  ctl.track("hi #ab", 6, { tier: "claimed" }, 4);
  check("hash: claimed tier still opens #", trackCalls.at(-1).draft === "hi @ab" && trackCalls.at(-1).sources.includes(HASH_SOURCE), JSON.stringify(trackCalls.at(-1)));

  // 哈希性质切换必须重置菜单：'#ab' 与 '@ab' 的 hit 字段相同，宿主 track 的
  // same 短路会保留旧 source 的菜单，因此 wrapper 在切换时 close + 清 hit。
  ctl.menuEvents.length = 0;
  ctl.track("hi #ac", 6, { tier: "plain" }, 5);
  check("hash: #→# keeps the menu (no reset)", ctl.menuEvents.length === 0, JSON.stringify(ctl.menuEvents));
  ctl.track("hi @ac", 6, { tier: "plain" }, 6);
  check("hash: #→@ resets the menu before delegating", ctl.menuEvents.includes("reduce:close") && trackCalls.at(-1).sources.includes("reference"), JSON.stringify({ menuEvents: ctl.menuEvents, sources: trackCalls.at(-1).sources }));
  ctl.menuEvents.length = 0;
  ctl.track("hi @ad", 6, { tier: "plain" }, 7);
  check("hash: @→@ does not reset the menu", ctl.menuEvents.length === 0, JSON.stringify(ctl.menuEvents));
  ctl.track("hi #ad", 6, { tier: "plain" }, 8);
  check("hash: @→# resets the menu before delegating", ctl.menuEvents.includes("reduce:close") && trackCalls.at(-1).sources.includes(HASH_SOURCE), JSON.stringify({ menuEvents: ctl.menuEvents, sources: trackCalls.at(-1).sources }));

  disposeHash();
  check("hash: dispose unregisters the source", !live.sources.includes(hashSource));
  check("hash: dispose restores sessionOf", !Object.prototype.hasOwnProperty.call(fakeInputTriggers, "sessionOf"));
  check("hash: dispose restores the wrapped controller", !Object.prototype.hasOwnProperty.call(ctl, "track"));
  ctl.track("hi #ab", 6, { tier: "plain" }, 5);
  check("hash: after dispose # is no longer a trigger", trackCalls.at(-1).draft === "hi #ab" && trackCalls.at(-1).trigger === null, JSON.stringify(trackCalls.at(-1)));
}

console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);
