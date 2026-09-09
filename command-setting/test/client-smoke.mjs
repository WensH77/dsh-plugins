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
  btoa,
  setTimeout,
  clearTimeout,
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
  const { hashTokenAt, hashEntries, hashWorkspaceNames, buildHashRows, formatSessionMention, installHashTrigger, HASH_SOURCE } = loaded;

  check("hash exports present", typeof hashTokenAt === "function" && typeof hashEntries === "function" && typeof hashWorkspaceNames === "function" && typeof buildHashRows === "function" && typeof formatSessionMention === "function" && typeof installHashTrigger === "function" && HASH_SOURCE === "command-setting-sessions");

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

  // mention 编码与宿主 encodeSessionReferenceUri 同构：base64url(JSON.stringify(id))
  const uri = (id) => "dsh-session:" + Buffer.from(JSON.stringify(id), "utf8").toString("base64url");
  check("hash mention: canonical URI payload", formatSessionMention("Alpha", "abc") === "@[Alpha](" + uri("abc") + ")", formatSessionMention("Alpha", "abc"));
  check("hash mention: label escaping", formatSessionMention("a]b\\c", "x") === "@[a\\]b\\\\c](" + uri("x") + ")", formatSessionMention("a]b\\c", "x"));
  check("hash mention: empty label falls back to id", formatSessionMention("", "abc") === "@[abc](" + uri("abc") + ")");

  // 客户端列表 → 候选：排除自身/subagent/空/归档，query 命中标题/会话 id/工作目录
  const t = (key, params) => params?.n === void 0 ? "L:" + key : "L:" + key + ":" + params.n;
  const now = 1_000_000_000;
  const hour = 3_600_000;
  const list = {
    ids: ["me", "s1", "s2", "s3", "s4", "s5", "s6", "s7"],
    byId: {
      me: { id: "me", displayTitle: "Self", cwd: "/w/a", updatedAt: now },
      s1: { id: "s1", displayTitle: "Alpha", cwd: "/w/a", updatedAt: now - 2 * hour },
      s2: { id: "s2", displayTitle: "Beta", cwd: "/w/b", updatedAt: now - 3 * hour },
      s3: { id: "s3", displayTitle: "Archived", cwd: "/w/c", updatedAt: now - hour },
      s4: { id: "s4", displayTitle: "Child", cwd: "/w/d", updatedAt: now - hour, origin: "subagent" },
      s5: { id: "s5", displayTitle: "Blank", cwd: "/w/e", updatedAt: now, blank: true },
      s6: { id: "s6", displayTitle: "NoCwd", updatedAt: now },
      s7: { id: "s7", displayTitle: "HomeProj", cwd: "/Users/me/proj", updatedAt: now - 30 * 60_000 }
    }
  };
  const session = { sessionId: "me" };
  const archived = new Set(["s3"]);
  const picked = hashEntries(session, "", list, archived);
  check("hashEntries: self/subagent/blank/archived dropped", picked.entries.map((e) => e.id).join(",") === "s1,s2,s6,s7", picked.entries.map((e) => e.id).join(","));
  check("hashEntries: current cwd resolved", picked.currentCwd === "/w/a", picked.currentCwd);
  check("hashEntries: same flag set per workspace", picked.entries.find((e) => e.id === "s1")?.same === true && picked.entries.find((e) => e.id === "s2")?.same === false);
  check("hashEntries: query matches title", hashEntries(session, "beta", list, archived).entries.map((e) => e.id).join(",") === "s2");
  check("hashEntries: query matches cwd", hashEntries(session, "w/b", list, archived).entries.map((e) => e.id).join(",") === "s2");
  check("hashEntries: query matches session id", hashEntries(session, "s7", list, archived).entries.map((e) => e.id).join(",") === "s7");
  check("hashEntries: filtered-out rows never match", hashEntries(session, "archived", list, archived).entries.length === 0 && hashEntries(session, "child", list, archived).entries.length === 0);
  check("hashEntries: missing list tolerated", hashEntries(session, "", {}, archived).entries.length === 0);

  // 行投影：其他工作区分组在前、当前工作区在后，各按最近活动排序
  const rows = buildHashRows(t, picked.entries, picked.currentCwd, "/Users/me", now);
  check("hash rows: other-workspace section first", rows.slice(0, 3).every((r) => r.section === "L:hashOtherWorkspaces"), JSON.stringify(rows.map((r) => r.section)));
  check("hash rows: current-workspace section last", rows.at(-1).section === "L:hashCurrentWorkspace" && rows.at(-1).name === "Alpha", JSON.stringify(rows.at(-1)));
  check("hash rows: buckets sorted by recency", rows.map((r) => r.name).join(",") === "NoCwd,HomeProj,Beta,Alpha", rows.map((r) => r.name).join(","));
  check("hash rows: cross-workspace shows cwd", rows[2].description.startsWith("/w/b · "), rows[2].description);
  check("hash rows: home abbreviated", rows[1].description.startsWith("~/proj · "), rows[1].description);
  check("hash rows: missing cwd labelled", rows[0].description.startsWith("L:hashNoCwd · "), rows[0].description);
  check("hash rows: same-workspace hides cwd", rows[3].description === "L:hashHours:2", rows[3].description);
  check("hash rows: session icon + canonical mention", rows[3].icon === "session" && JSON.parse(rows[3].value).mention === formatSessionMention("Alpha", "s1"), rows[3].value);
  const flat = buildHashRows(t, picked.entries, void 0, "/Users/me", now);
  check("hash rows: no current cwd → single section", flat.length === 4 && flat.every((r) => r.section === "L:hashSection"), JSON.stringify(flat.map((r) => r.section)));
  const many = Array.from({ length: 40 }, (_, index) => ({ id: "m" + index, label: "M" + index, cwd: "/w/b", updatedAt: now - index, same: false }));
  check("hash rows: per-bucket cap", buildHashRows(t, many, "/w/a", "/Users/me", now).length === 25);
  check("hash rows: empty/odd input tolerated", buildHashRows(t, null, void 0, void 0, now).length === 0 && buildHashRows(t, "nope", "/w/a", void 0, now).length === 0);
  check("hashEntries: non-ASCII id skipped", hashEntries(session, "", { ids: ["bad id"], byId: { "bad id": { id: "bad id", displayTitle: "Bad", updatedAt: now } } }, archived).entries.length === 0);

  // 工作区名字映射：跨工作区行显示工作区名，未注册目录退回路径
  const workspaceNames = hashWorkspaceNames({ items: [
    { path: "/w/b", title: "Beta 项目" },
    { path: "/w/a", title: "当前项目" },
    { path: "/w/c", title: "" },
    { path: "", title: "空路径" },
    null
  ] });
  check("hashWorkspaceNames: path → title map", workspaceNames.get("/w/b") === "Beta 项目" && workspaceNames.size === 2, String(workspaceNames.size));
  const named = hashEntries(session, "", list, archived, workspaceNames);
  check("hashEntries: workspace title attached", named.entries.find((e) => e.id === "s2")?.workspace === "Beta 项目" && named.entries.find((e) => e.id === "s7")?.workspace === void 0);
  const namedRows = buildHashRows(t, named.entries, named.currentCwd, "/Users/me", now);
  check("hash rows: cross-workspace row shows the workspace name", namedRows[2].description.startsWith("Beta 项目 · "), namedRows[2].description);
  check("hash rows: unregistered cwd still falls back to path", namedRows[1].description.startsWith("~/proj · "), namedRows[1].description);
  check("hash rows: same-workspace row still hides any location", namedRows[3].description === "L:hashHours:2", namedRows[3].description);

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

// ── apply 装配 '#' 源：ctx.get 服务读取 + candidates 端到端 ────────────────
{
  const registered = [];
  const fakeInputTriggers = {
    live: { controllers: new Map(), sources: [] },
    registerSource(src) {
      registered.push(src);
      fakeInputTriggers.live.sources.push(src);
      return () => {};
    },
    sessionOf: () => ({})
  };
  const listSnapshot = {
    ids: ["me", "x1", "x2", "x3"],
    byId: {
      me: { id: "me", displayTitle: "Self", cwd: "/w/a", updatedAt: 9 },
      x1: { id: "x1", displayTitle: "Local", cwd: "/w/a", updatedAt: 3 },
      x2: { id: "x2", displayTitle: "Other", cwd: "/w/b", updatedAt: 2 },
      x3: { id: "x3", displayTitle: "Gone", cwd: "/w/c", updatedAt: 1 }
    }
  };
  const services = {
    inputTriggers: fakeInputTriggers,
    sessions: { list: { getSnapshot: () => listSnapshot } },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ["x3"], items: [{ path: "/w/b", title: "Beta 项目" }] }) } },
    remote: { $host: { home: "/Users/me" } }
  };
  loaded.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key, params) => params?.n === void 0 ? "L:" + key : "L:" + key + ":" + params.n },
    slots: { inject: () => {} },
    inject: (deps, callback) => callback({ inputTriggers: services.inputTriggers }),
    get: (name) => services[name],
    commandUi: { candidates: async () => [], matchEnter: async () => void 0, matchSpace: () => void 0, live: { contributions: new Map() } },
    sessions: services.sessions,
    remote: { $on: () => () => {}, $host: services.remote.$host },
    on: () => () => {}
  });
  const source = registered.find((s) => s.name === loaded.HASH_SOURCE);
  check("apply: # source registered through ctx.inject", source !== undefined && source.trigger === "#");
  const rows = await source.candidates({ sessionId: "me" }, { query: "", signal: new AbortController().signal });
  check("apply: # candidates read client services end-to-end", rows.length === 2 && rows.map((r) => r.name).join(",") === "Other,Local", JSON.stringify(rows.map((r) => r.name)));
  check("apply: # candidates drop archived + self, mention canonical", rows[0].section === "L:hashOtherWorkspaces" && JSON.parse(rows[0].value).mention === loaded.formatSessionMention("Other", "x2"), JSON.stringify(rows[0]));
  check("apply: # candidates label the workspace by name", rows[0].description.startsWith("Beta 项目 · "), rows[0].description);
  const filtered = await source.candidates({ sessionId: "me" }, { query: "local", signal: new AbortController().signal });
  check("apply: # candidates honour the live query", filtered.length === 1 && filtered[0].name === "Local", JSON.stringify(filtered.map((r) => r.name)));
}

// ── 划词引用：纯函数 + 伪 DOM 交互 ─────────────────────────────────────────
{
  const { quoteSelectionText, appendQuoteToDraft, quoteAnchor, insertQuote } = loaded;

  check("quote text: blockquote per line", quoteSelectionText("a\nb") === "> a\n> b", quoteSelectionText("a\nb"));
  check("quote text: blank line kept as bare >", quoteSelectionText("a\n\nb") === "> a\n>\n> b", quoteSelectionText("a\n\nb"));
  check("quote text: trims + CRLF", quoteSelectionText("  a\r\nb  ") === "> a\n> b", JSON.stringify(quoteSelectionText("  a\r\nb  ")));
  check("quote text: empty input", quoteSelectionText("   ") === "" && quoteSelectionText(null) === "");
  check("quote draft: empty draft", appendQuoteToDraft("", "> a") === "> a\n\n", JSON.stringify(appendQuoteToDraft("", "> a")));
  check("quote draft: appends after existing", appendQuoteToDraft("hi\n", "> a") === "hi\n\n> a\n\n", JSON.stringify(appendQuoteToDraft("hi\n", "> a")));
  check("quote draft: empty quote keeps draft", appendQuoteToDraft("hi", "") === "hi");

  // quoteAnchor：伪选区（closest 按选择器回答）
  const fakeElement = ({ composer = false, inScroll = true, control = false } = {}) => ({
    nodeType: 1,
    closest: (selector) => {
      if (selector === "[data-composer-seat], input, textarea, [contenteditable=\"true\"]") return composer || control ? {} : null;
      if (selector === "[data-conversation-scroll]") return inScroll ? {} : null;
      return null;
    }
  });
  const fakeSelection = ({ text = "hello", collapsed = false, element = fakeElement(), rect = { left: 10, top: 20, width: 100, height: 10 } } = {}) => ({
    isCollapsed: collapsed,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({ commonAncestorContainer: element, getBoundingClientRect: () => rect })
  });
  check("quoteAnchor: message selection", JSON.stringify(quoteAnchor(fakeSelection())?.text) === JSON.stringify("hello") && quoteAnchor(fakeSelection()).rect.left === 10);
  check("quoteAnchor: collapsed / empty text rejected", quoteAnchor(fakeSelection({ collapsed: true })) === null && quoteAnchor(fakeSelection({ text: "   " })) === null);
  check("quoteAnchor: composer selection rejected", quoteAnchor(fakeSelection({ element: fakeElement({ composer: true }) })) === null);
  check("quoteAnchor: outside the message scroller rejected", quoteAnchor(fakeSelection({ element: fakeElement({ inScroll: false }) })) === null);
  check("quoteAnchor: input controls rejected", quoteAnchor(fakeSelection({ element: fakeElement({ control: true }) })) === null);
  check("quoteAnchor: zero rect rejected", quoteAnchor(fakeSelection({ rect: { left: 0, top: 0, width: 0, height: 0 } })) === null);
  check("quoteAnchor: null selection rejected", quoteAnchor(null) === null && quoteAnchor({ isCollapsed: false, rangeCount: 0 }) === null);

  // insertQuote：setDraft（无 chip）/ paste（有 chip）/ 缺会话或 shell
  const drafts = [];
  const pasted = [];
  const makeCtx = (snapshot, shellExtras = {}) => ({
    get: (name) => {
      if (name === "sessions") return { list: { getSnapshot: () => ({ current: "s1" }) } };
      if (name === "conversation") return { input: { shell: () => ({ state: { getSnapshot: () => snapshot }, setDraft: (value) => drafts.push(value), ...shellExtras }) } };
      return void 0;
    }
  });
  check("insertQuote: setDraft appends the quote", insertQuote(makeCtx({ draft: "hi", occurrences: [] }), "a\nb") === true && drafts[0] === "hi\n\n> a\n> b\n\n", JSON.stringify(drafts));
  check("insertQuote: empty selection is a no-op", insertQuote(makeCtx({ draft: "hi", occurrences: [] }), "   ") === false);
  check("insertQuote: existing chips go through paste", insertQuote(makeCtx({ draft: "@file", occurrences: [{}] }, { paste: (value) => pasted.push(value) }), "a") === true && pasted[0] === "\n\n> a\n\n", JSON.stringify(pasted));
  check("insertQuote: no current session", insertQuote({ get: (name) => name === "sessions" ? { list: { getSnapshot: () => ({ current: void 0 }) } } : void 0 }, "a") === false);
  check("insertQuote: no shell", insertQuote({ get: (name) => name === "sessions" ? { list: { getSnapshot: () => ({ current: "s1" }) } } : { input: { shell: () => void 0 } } }, "a") === false);

  // installQuoteSelection：伪 DOM 下浮标显示/点击/卸载
  const originalDocument = sandbox.document;
  const originalWindow = sandbox.window;
  const listeners = [];
  const buttonHandlers = new Map();
  const button = {
    dataset: {},
    style: {},
    hidden: true,
    textContent: "",
    addEventListener: (type, fn) => buttonHandlers.set(type, fn),
    removeEventListener: (type) => buttonHandlers.delete(type),
    remove: () => { button.removed = true; }
  };
  const fakeTarget = (kind) => ({
    addEventListener: (type, fn, capture) => listeners.push({ kind, type, fn, capture }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((entry) => entry.kind === kind && entry.type === type && entry.fn === fn);
      if (at >= 0) listeners.splice(at, 1);
    }
  });
  sandbox.document = {
    ...originalDocument,
    ...fakeTarget("doc"),
    body: { appendChild: (element) => { element.parent = "body"; } },
    createElement: () => button,
    querySelector: () => null
  };
  let currentSelection = null;
  sandbox.window = { ...fakeTarget("win"), innerWidth: 1000, getSelection: () => currentSelection };

  const disposeQuote = loaded.installQuoteSelection(makeCtx({ draft: "hi", occurrences: [] }), (key) => "L:" + key);
  check("quote: button appended to body", typeof disposeQuote === "function" && button.parent === "body" && button.hidden === true);
  check("quote: listeners installed", listeners.some((l) => l.kind === "doc" && l.type === "pointerup" && l.capture === true) && listeners.some((l) => l.kind === "doc" && l.type === "selectionchange") && listeners.some((l) => l.kind === "win" && l.type === "scroll"));
  currentSelection = fakeSelection();
  listeners.find((l) => l.kind === "doc" && l.type === "pointerup").fn({ target: {} });
  await sleep(5);
  check("quote: button shown and labelled", button.hidden === false && button.textContent === "L:quote", JSON.stringify({ hidden: button.hidden, text: button.textContent }));
  check("quote: positioned above the selection", button.style.left === "60px" && button.style.top === "12px", JSON.stringify(button.style));
  drafts.length = 0;
  buttonHandlers.get("pointerdown")({ preventDefault: () => {} });
  buttonHandlers.get("click")();
  check("quote: click writes the quote into the draft", drafts[0] === "hi\n\n> hello\n\n", JSON.stringify(drafts));
  check("quote: button hidden after click", button.hidden === true);
  currentSelection = fakeSelection({ collapsed: true });
  listeners.find((l) => l.kind === "doc" && l.type === "pointerup").fn({ target: {} });
  await sleep(5);
  check("quote: collapsed selection keeps it hidden", button.hidden === true);
  disposeQuote();
  check("quote: dispose removes listeners and button", button.removed === true && listeners.length === 0, JSON.stringify(listeners.map((l) => l.type)));
  sandbox.document = originalDocument;
  sandbox.window = originalWindow;
}

console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);
