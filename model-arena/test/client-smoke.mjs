// Client smoke test: loads the browser bundle in a vm sandbox with a minimal
// DOM stub. Covers the module surface, dictionary parity, the pure helpers
// (exclusion rule; effort choices come from the MODEL's own reasoning, never a
// hardcoded list), the hero mount path, and the two-level menu flow
// (trigger -> root cells -> model/effort lists -> pick -> trigger updates +
// menu closes).
// Run: node test/client-smoke.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ── minimal DOM stub (FakeElement) ──────────────────────────────────────────
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this._attrs = {};
    this._handlers = {};
    this._text = "";
    this.style = {};
    this.className = "";
    this.disabled = false;
    this.type = "";
    this.value = "";
    this.label = "";
  }
  get nextSibling() {
    if (this.parentElement === null) return null;
    const i = this.parentElement.children.indexOf(this);
    return i >= 0 && i + 1 < this.parentElement.children.length ? this.parentElement.children[i + 1] : null;
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
    if (this._text === "") this.children = [];
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
    return this;
  }
  remove() {
    if (this.parentElement === null) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  insertBefore(node, ref) {
    node.parentElement = this;
    const i = ref === null || ref === void 0 ? -1 : this.children.indexOf(ref);
    if (i >= 0) this.children.splice(i, 0, node);
    else this.children.push(node);
    return node;
  }
  setAttribute(key, value) {
    this._attrs[key] = String(value);
  }
  getAttribute(key) {
    return this._attrs[key] ?? null;
  }
  hasAttribute(key) {
    return this._attrs[key] !== undefined;
  }
  querySelector(sel) {
    if (sel === ".YDXeBa_title") return this.children.find((c) => c.className === "YDXeBa_title") ?? null;
    // the plugin injects the sidebar loading dot as a direct child of the row
    // (the status-slot query falls back to the row in the sandbox), so a
    // querySelector on it must resolve like the real DOM does.
    if (sel === ".ma-sidebarLoading") return this.children.find((c) => c.className === "ma-sidebarLoading") ?? null;
    return null;
  }
  addEventListener(type, fn) {
    (this._handlers[type] ??= []).push(fn);
  }
  removeEventListener() {}
  contains() {
    return false;
  }
}
function collectByClass(node, cls) {
  const out = [];
  const walk = (n) => {
    if (n.className === cls) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}
function collectByClassContains(node, cls) {
  const out = [];
  const walk = (n) => {
    if (typeof n.className === "string" && n.className.split(/\s+/).includes(cls)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}
function click(el) {
  const fn = el?._handlers?.click?.[0];
  if (typeof fn !== "function") throw new Error("no click handler on element");
  fn();
}
function hasDescendant(node, cls, text) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (n.className === cls && n.textContent === text) {
      found = true;
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return found;
}
function optionNamed(options, text) {
  return options.find((o) => hasDescendant(o, "ma-optionName", text));
}
function cellNamed(cells, label) {
  return cells.find((c) => hasDescendant(c, "ma-cellLabel", label));
}

const heroRow = new FakeElement("div");
const heroRoot = new FakeElement("div");
heroRoot.appendChild(heroRow);

// conversation tree for the arena split surgery
const arenaChat = new FakeElement("div");
arenaChat.setAttribute("data-slot", "conversation.session");
const composerSeat = new FakeElement("div");
composerSeat.setAttribute("data-composer-seat", "");
const scrollBody = new FakeElement("div");
scrollBody.setAttribute("data-conversation-scroll", "");
scrollBody.append(arenaChat, composerSeat);
const bodyRoot = new FakeElement("body");
const arenaRow = new FakeElement("div");
arenaRow.className = "YDXeBa_sessionRow";
const arenaTitle = new FakeElement("span");
arenaTitle.className = "YDXeBa_title";
arenaTitle.textContent = "竞技场";
arenaRow.appendChild(arenaTitle);
const normalRow = new FakeElement("div");
normalRow.className = "YDXeBa_sessionRow";
const normalTitle = new FakeElement("span");
normalTitle.className = "YDXeBa_title";
normalTitle.textContent = "普通会话";
normalRow.appendChild(normalTitle);
// A second MAIN session row (a previously-finished arena duel) so the
// sidebar-dot regression can prove the indicator lands on the RUNNING
// challenger's row and never on an already-ended duel's row.
const endedRow = new FakeElement("div");
endedRow.className = "YDXeBa_sessionRow";
const endedTitle = new FakeElement("span");
endedTitle.className = "YDXeBa_title";
endedTitle.textContent = "已结束会话";
endedRow.appendChild(endedTitle);
bodyRoot.appendChild(arenaRow);
bodyRoot.appendChild(normalRow);
bodyRoot.appendChild(endedRow);
bodyRoot.appendChild(scrollBody);

function findInTree(node, pred) {
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = findInTree(child, pred);
    if (hit !== null) return hit;
  }
  return null;
}
const byClass = (cls) => (el) => el.className === cls;
const byData = (key) => (el) => el.dataset[key] !== void 0;
const headStyles = [];

const documentStub = {
  querySelector: (selector) => {
    if (selector === '[data-phase="hero"] .wSkVaW_heroWorkspaceRow') return heroRow;
    if (selector === '[data-phase="hero"]') return heroRoot;
    if (selector === "[data-conversation-scroll]") return scrollBody;
    if (selector === ".ma-split") return findInTree(bodyRoot, byClass("ma-split"));
    if (selector === ".ma-splitLeft") return findInTree(bodyRoot, byClass("ma-splitPane ma-splitLeft"));
    if (selector === ".ma-paneFloat") return findInTree(bodyRoot, byClass("ma-paneFloat"));
    if (selector === "[data-arena-pane-body]") return findInTree(bodyRoot, byData("arenaPaneBody"));
    return null;
  },
  querySelectorAll: (selector) => {
    if (selector === ".YDXeBa_sessionRow") return [arenaRow, normalRow, endedRow];
    return [];
  },
  createElement: (tag) => new FakeElement(tag),
  head: {
    appendChild(el) {
      // Capture injected <style> tags so the CSS regression checks can assert
      // on the plugin's own stylesheet (e.g. the .ma-questionOpt base rule).
      headStyles.push(el);
    }
  },
  body: bodyRoot,
  addEventListener() {},
  removeEventListener() {}
};

let loaded = null;
let dicts = null;
const sandbox = {
  window: {},
  document: documentStub,
  HTMLElement: FakeElement,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URLSearchParams,
  encodeURIComponent,
  AbortController
};
// Minimal React stub: the ArenaView view-ring component is registered but
// never rendered in the sandbox (no React DOM), so only the surface needs to
// exist — plus enough createElement for a direct component call.
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length > 0 ? children : undefined } }),
  Fragment: Symbol("Fragment"),
  useRef: (init) => ({ current: init }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useSyncExternalStore: () => 0
};
// Native primitives + react-dom/client stubs: `loadMd` resolves these as seed
// modules through the factory `require`, so the arena pane takes the NATIVE
// render path (MarkdownText / DisclosureRow / native copy button) instead of
// the plain-text fallback. createRoot records the rendered vnode on the host
// element so the tests can assert which native component was used.
const primitivesStub = {
  MarkdownText: () => null,
  DisclosureRow: () => null,
  IconThinkOutline16: () => null,
  IconThinkOutline14: () => null,
  IconBrowseOutline16: () => null,
  IconCodeOutline16: () => null,
  IconCopyOutline16: () => null,
  IconCheckOutline16: () => null,
  writeClipboard: async () => true,
  Tooltip: () => null
};
const reactDomClientStub = {
  createRoot: (el) => ({
    render(vnode) { el._react = vnode; },
    unmount() {}
  })
};
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      if (id === "react") return reactStub;
      if (id === "react-dom/client") return reactDomClientStub;
      if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
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
check("inject exported", Array.isArray(loaded.inject) && loaded.inject.join(",") === "locale,sessions,modelDirectories,remote,slots");
check("helpers exported", ["buildModelOptions", "buildEffortChoices", "conflictsWithInput", "findArenaModel"].every((k) => typeof loaded[k] === "function"));
check("arena stylesheet injected", headStyles.length === 1 && headStyles[0].dataset.pluginCss === "dsh-plugin-model-arena/arena.css");
check("question option base rule present (regression guard)", headStyles.length === 1 && headStyles[0].textContent.includes(".ma-questionOpt{"));

// ── pure helpers ────────────────────────────────────────────────────────────
const t = (key) => "T:" + key;
const reasoningA = { defaultEffort: void 0, efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High", description: "Deep" }] };
const reasoningB = { defaultEffort: "fast", efforts: [{ id: "fast", name: "Fast" }] };
const directory = {
  current: { provider: "p1", model: "m1", reasoningEffort: "low" },
  groups: [
    { id: "p1", name: "P1", models: [{ id: "m1", name: "M1", reasoning: reasoningA }, { id: "m2", name: "M2", reasoning: reasoningA }] },
    { id: "p2", name: "P2", models: [{ id: "m3", name: "M3", reasoning: reasoningB }] }
  ]
};

const groups = loaded.buildModelOptions(directory, null);
check("exclusion: input model m1 absent", groups.flatMap((g) => g.models).every((m) => m.model !== "m1"));
check("p1 keeps m2", groups.find((g) => g.id === "p1")?.models.some((m) => m.model === "m2"));
check("p2 keeps m3", groups.find((g) => g.id === "p2")?.models.some((m) => m.model === "m3"));

// EFFORT IS MODEL-LINKED: the same builder returns different lists per model
const effortsA = loaded.buildEffortChoices(reasoningA, t);
check("model A efforts (no default) -> Default first", effortsA.length === 3 && effortsA[0].effort === void 0 && effortsA[0].label === "T:effort.default");
check("model A efforts follow", effortsA.slice(1).map((c) => c.label).join(",") === "Low,High");
const effortsB = loaded.buildEffortChoices(reasoningB, t);
check("model B efforts (different model) differ", effortsB.length === 1 && effortsB[0].effort === "fast" && effortsB[0].label === "Fast");
check("no reasoning -> empty", loaded.buildEffortChoices(void 0, t).length === 0);

check("conflict true", loaded.conflictsWithInput({ provider: "p1", model: "m1" }, directory) === true);
check("conflict false", loaded.conflictsWithInput({ provider: "p1", model: "m2" }, directory) === false);
check("findArenaModel resolves", loaded.findArenaModel(directory, { provider: "p1", model: "m2" })?.name === "M2");
check("findArenaModel missing", loaded.findArenaModel(directory, { provider: "p9", model: "x" }) === void 0);

// ── temperature input validation (0..2, at most 2 decimal places) ──────────
const nt = loaded.normalizeTemperatureInput;
check("temp: empty = dsh default", nt("")?.ok === true && nt("").value === void 0);
check("temp: 0.15 accepted", nt("0.15")?.ok === true && nt("0.15").value === 0.15);
check("temp: 0.155 rejected (3 decimals)", nt("0.155")?.ok === false);
check("temp: 2 accepted", nt("2")?.ok === true && nt("2").value === 2);
check("temp: 2.01 rejected (above cap)", nt("2.01")?.ok === false);
check("temp: -1 rejected", nt("-1")?.ok === false);
check("temp: non-numeric rejected", nt("abc")?.ok === false && nt("1e2")?.ok === false);
check("temp: trailing dot intermediate accepted as 0", nt("0.")?.ok === true && nt("0.").value === 0);

// ── two-model auto arena model (pure helpers) ───────────────────────────────
const twoModelDir = {
  current: { provider: "p1", model: "m1", reasoningEffort: "low" },
  groups: [
    { id: "p1", name: "P1", models: [{ id: "m1", name: "M1", reasoning: reasoningA }, { id: "m2", name: "M2", reasoning: reasoningB }] }
  ]
};
const autoOf = (dir) => loaded.autoArenaModel(dir);
check("autoArenaModel exported", typeof loaded.autoArenaModel === "function" && typeof loaded.totalModelsOf === "function");
check("totalModelsOf counts across groups", loaded.totalModelsOf(directory) === 3 && loaded.totalModelsOf(twoModelDir) === 2 && loaded.totalModelsOf({ groups: [] }) === 0);
check("two models -> complement of the input model", autoOf(twoModelDir)?.provider === "p1" && autoOf(twoModelDir)?.model === "m2" && autoOf(twoModelDir)?.name === "M2");
check("complement carries the model's default effort", autoOf(twoModelDir)?.reasoningEffort === "fast");
check("composer switch flips the complement", autoOf({ ...twoModelDir, current: { provider: "p1", model: "m2" } })?.model === "m1");
check("three models -> null (manual picking applies)", autoOf(directory) === null);
check("no current model -> null", autoOf({ groups: twoModelDir.groups }) === null);
check("empty/missing directory -> null", autoOf(null) === null && autoOf({ groups: [] }) === null);

// arena mirror/pane pure helpers
check("textOfContent extracts text", loaded.textOfContent([{ type: "text", text: "hi" }, { type: "image", attachment: {} }]) === "hi");
check("textOfContent skips non-text", loaded.textOfContent([{ type: "image" }]) === "");
const arenaRows = loaded.assistantRows([
  { kind: "text", text: "answer" },
  { kind: "reasoning", text: "thinking" },
  { kind: "tool-call", callId: "1", name: "bash", argsRaw: "{}" },
  { kind: "text", text: "   " }
]);
check("assistantRows maps blocks", arenaRows.length === 3 && arenaRows[0].kind === "assistant" && arenaRows[0].text === "answer");
check("assistantRows reasoning/tool", arenaRows[1].kind === "reasoning" && arenaRows[2].kind === "tool" && arenaRows[2].name === "bash");
check("assistantRows skips blank text", loaded.assistantRows([{ kind: "text", text: "  " }]).length === 0);


// ── mount + two-level menu flow ─────────────────────────────────────────────
let snapSub = null;
let snap = {
  current: { provider: "p1", model: "m1", reasoningEffort: "low" },
  routable: true,
  groups: [
    { id: "p1", name: "P1", models: [{ id: "m1", name: "M1", reasoning: reasoningA }, { id: "m2", name: "M2", reasoning: reasoningA }] },
    { id: "p2", name: "P2", models: [{ id: "m3", name: "M3", reasoning: reasoningB }] }
  ],
  failures: [],
  status: "ready",
  error: null
};
const fakeDirectory = {
  load: async () => {},
  store: {
    getSnapshot: () => snap,
    subscribe: (fn) => {
      snapSub = fn;
      return () => {};
    }
  }
};
const blockCalls = [];
const fakeConversation = {
  blocks: {
    set: (sessionId, block) => {
      blockCalls.push({ sessionId, block });
    }
  }
};
// ── arena-capable sessions mock ─────────────────────────────────────────
const emptyChat = { order: [], nodes: { get: () => void 0, values: () => [] } };
const sessionStores = new Map();
const promptCalls = [];
const commandCalls = [];
const archiveCalls = [];
let archivedIds = [];
let workspaceListSub = null;
const createCalls = [];
const selectCalls = [];
const renameCalls = [];
const openCalls = [];
const cancelCalls = [];
const settingsMutateCalls = [];
const slotRegisterCalls = [];
let settingsNamespaces = [];
let settingsUpdatedHandler = null;
let listSub = null;
let currentSession = "s1";
// sessions-list byId summary mock (displayTitle is used to locate the arena
// main session's sidebar row by title)
const byIdMock = {
  s1: {
    cwd: "/ws1",
    projectionValues: { permissions: { currentValue: "workspace-write" } }
  }
};
const makeSessionStore = (id, initial) => {
  const store = {
    snapshot: initial,
    subs: [],
    getSnapshot() {
      return this.snapshot;
    },
    subscribe(fn) {
      this.subs.push(fn);
      return () => {
        this.subs = this.subs.filter((s) => s !== fn);
      };
    },
    prompt: async (content, mode) => {
      promptCalls.push({ sessionId: id, content, mode });
    },
    command: async (line) => {
      commandCalls.push({ sessionId: id, line });
      return { ok: true, value: { matched: true } };
    },
    open: async () => {
      openCalls.push(id);
    },
    cancel: async () => {
      cancelCalls.push(id);
    },
    _set(snapshot) {
      this.snapshot = snapshot;
      for (const fn of [...this.subs]) fn();
    }
  };
  sessionStores.set(id, store);
  return store;
};
makeSessionStore("s1", { chat: emptyChat });
const mockCtx = {
  effect: (fn) => fn(),
  get: (name) => {
    if (name === "slots") {
      return {
        register: (opts, component) => {
          const rec = { name: opts.name, id: opts.id, key: opts.key, order: opts.order, label: opts.label, locale: opts.locale, component };
          slotRegisterCalls.push(rec);
          return () => {
            const at = slotRegisterCalls.indexOf(rec);
            if (at >= 0) slotRegisterCalls.splice(at, 1);
          };
        },
        spec: () => ({ kind: "list", scope: "session" }),
        inject: (name, cb) => {
          const disposer = cb();
          return () => { try { disposer?.(); } catch {} };
        }
      };
    }
    if (name === "conversation") return fakeConversation;
    if (name === "workspaces") {
      return {
        list: {
          getSnapshot: () => ({
            items: [{ workspaceId: "w1", path: "/ws1", sessionIds: ["s1"] }],
            archivedSessionIds: archivedIds
          }),
          subscribe: (fn) => {
            workspaceListSub = fn;
            return () => { workspaceListSub = null; };
          }
        },
        archiveSession: async (sessionId) => {
          archiveCalls.push(sessionId);
          archivedIds = [...archivedIds, sessionId];
        }
      };
    }
    if (name === "connection") {
      return {
        api: {
  sessions: {
    open: (id) => {
      openCalls.push(id);
      currentSession = id;
    },
            selectModel: async (payload) => {
              selectCalls.push(payload);
            },
            rename: async (payload) => {
              renameCalls.push(payload);
            }
          },
          settings: {
            describe: async () => ({
              result: { ok: true, value: { namespaces: settingsNamespaces, writable: [] } }
            }),
            mutate: async (payload) => {
              settingsMutateCalls.push(payload);
              // Reflect the mutation into the describe view so loadLinks (and the
              // settings/document-updated handler) sees persisted state, matching
              // the real settings backend where mutate and describe are consistent.
              let ns = settingsNamespaces.find((n) => n.ns === payload.ns);
              if (ns === void 0) {
                ns = { ns: payload.ns, value: {} };
                settingsNamespaces.push(ns);
              }
              for (const op of payload.ops ?? []) {
                if (op.op !== "set" || !Array.isArray(op.path)) continue;
                let target = ns.value;
                for (let i = 0; i < op.path.length - 1; i++) {
                  const k = op.path[i];
                  if (k === void 0 || k === null) break;
                  if (target[k] === void 0 || target[k] === null || typeof target[k] !== "object" || Array.isArray(target[k])) target[k] = {};
                  target = target[k];
                }
                const last = op.path[op.path.length - 1];
                if (last !== void 0 && last !== null) target[last] = op.value;
              }
              return { result: { ok: true, value: payload } };
            }
          }
        }
      };
    }
    return void 0;
  },
  remote: {
    $on: (event, fn) => {
      if (event === "settings/document-updated") settingsUpdatedHandler = fn;
      return () => { if (settingsUpdatedHandler === fn) settingsUpdatedHandler = null; };
    }
  },
  locale: {
    register: (ns, d) => {
      dicts = d;
      return () => {};
    },
    bind: () => (key) => "L:" + key,
    subscribe: () => () => {}
  },
  sessions: {
    list: {
      getSnapshot: () => ({
        current: currentSession,
        byId: byIdMock
      }),
      subscribe: (fn) => {
        listSub = fn;
        return () => {};
      }
    },
    binding: (id) => {
      if (!sessionStores.has(id)) makeSessionStore(id, { chat: emptyChat });
      return { session: sessionStores.get(id) };
    },
    create: async (opts) => {
      createCalls.push(opts);
      return "arena-1";
    },
    open: (id) => {
      openCalls.push(id);
      currentSession = id;
    },
    selectModel: async (payload) => {
      selectCalls.push(payload);
    },
    rename: async (payload) => {
      renameCalls.push(payload);
    }
  },
  inject: (names, cb) => {
    cb({ modelDirectories: { directoryFor: () => fakeDirectory } });
  }
};

loaded.apply(mockCtx);

check("dictionaries registered", dicts !== null);
check("zh/en parity", dicts !== null && Object.keys(dicts.zh).length === Object.keys(dicts.en).length);
const zhOnly = Object.keys(dicts.zh).filter((k) => !(k in dicts.en));
const enOnly = Object.keys(dicts.en).filter((k) => !(k in dicts.zh));
check("no key drift", zhOnly.length === 0 && enOnly.length === 0, zhOnly.concat(enOnly).join(","));
// ── challenge-mode pure helpers (dicts available now) ───────────────────
check("SCENES exported", loaded.SCENES !== void 0 && loaded.SCENES.knowledge !== void 0 && loaded.SCENES.qa !== void 0);
check("SCENES has business/knowledge/qa", loaded.SCENES.business !== void 0 && loaded.SCENES.knowledge !== void 0 && loaded.SCENES.qa !== void 0);
check("knowledge is the review scene", loaded.SCENES.knowledge.review === true);
check("business/qa keep the original challenge flow", loaded.SCENES.business.review === false && loaded.SCENES.qa.review === false);
check("MAX_REJECTS exported = 3", loaded.MAX_REJECTS === 3);
check("header predicate + STALL_MS exported", typeof loaded.shouldShowChallengeHeader === "function" && typeof loaded.STALL_MS === "number");
check("header hidden for null / fresh / terminal states", loaded.shouldShowChallengeHeader(null) === false && loaded.shouldShowChallengeHeader({ active: false, phase: "idle" }) === false && loaded.shouldShowChallengeHeader({ active: true, phase: "done" }) === false && loaded.shouldShowChallengeHeader({ active: true, phase: "aborted" }) === false && loaded.shouldShowChallengeHeader({ active: false, phase: "answer" }) === false);
check("header shown only for in-flight phases", ["answer", "challenge", "revise", "final", "propose", "review"].every((p) => loaded.shouldShowChallengeHeader({ active: true, phase: p }) === true));
check("re-arm predicate exported", typeof loaded.shouldReArmChallenge === "function" && typeof loaded.isPastReviewStage === "function");
check("re-arm: fresh / aborted / null re-arm", loaded.shouldReArmChallenge(null) === true && loaded.shouldReArmChallenge({ phase: "idle", scene: "knowledge" }) === true && loaded.shouldReArmChallenge({ phase: "aborted", scene: "knowledge" }) === true);
check("re-arm: done review scene is one-shot (blocked)", loaded.shouldReArmChallenge({ phase: "done", scene: "knowledge" }) === false);
check("re-arm: done business/qa still re-arm", loaded.shouldReArmChallenge({ phase: "done", scene: "business" }) === true && loaded.shouldReArmChallenge({ phase: "done", scene: "qa" }) === true);
check("re-arm: persisted link.done blocks after reload (phase reset to idle)", loaded.shouldReArmChallenge({ phase: "idle", scene: "knowledge" }, { done: true }) === false);
check("re-arm: link without done still re-arms", loaded.shouldReArmChallenge({ phase: "idle", scene: "knowledge" }, {}) === true);
check("re-arm: link.done ignored for non-review scene", loaded.shouldReArmChallenge({ phase: "idle", scene: "business" }, { done: true }) === true);
check("isPastReviewStage recognizes apply/archive/done", loaded.isPastReviewStage("apply") === true && loaded.isPastReviewStage("archive") === true && loaded.isPastReviewStage("done") === true && loaded.isPastReviewStage("user-readiness-review") === true);
check("isPastReviewStage rejects pre-review stages", loaded.isPastReviewStage("review") === false && loaded.isPastReviewStage("propose") === false && loaded.isPastReviewStage("explore") === false && loaded.isPastReviewStage("") === false);
check("re-arm: watch.stage past review blocks (reload of a completed loop)", loaded.shouldReArmChallenge({ phase: "idle", scene: "knowledge" }, null, { stage: "apply" }) === false);
check("re-arm: watch.stage pre-review still re-arms", loaded.shouldReArmChallenge({ phase: "idle", scene: "knowledge" }, null, { stage: "review" }) === true);
const realT = (k) => (dicts?.zh?.[k]) ?? k;
const chCtx = { scene: "knowledge", userQuestion: "Q1", lastMainText: "answer with `docs/plan.md`", lastArenaText: "objection" };
const reviewPrompt = loaded.buildRoundPrompt("review", chCtx, realT);
check("review prompt has no role identity (persona only)", !reviewPrompt.includes("Challenger") && !reviewPrompt.includes("身份高于") && reviewPrompt.includes("用户问题") && reviewPrompt.includes("docs/plan.md"));
check("review prompt: question + structured proposal + file ref", reviewPrompt.includes("Q1") && reviewPrompt.includes("结构化方案") && reviewPrompt.includes("answer with") && reviewPrompt.includes("docs/plan.md"));
check("review directive: single verdict + action items", reviewPrompt.includes("**Overall Verdict**") && reviewPrompt.includes("READY") && reviewPrompt.includes("NEEDS_REVISION") && reviewPrompt.includes("Action Items") && reviewPrompt.includes("禁止辩论"));
check("parseReviewVerdict READY", loaded.parseReviewVerdict("**Overall Verdict**: READY") === "READY");
check("parseReviewVerdict NEEDS REVISION (space)", loaded.parseReviewVerdict("**Overall Verdict**: NEEDS REVISION") === "NEEDS_REVISION");
check("parseReviewVerdict NOT READY", loaded.parseReviewVerdict("**Overall Verdict**: NOT READY") === "NOT_READY");
check("parseReviewVerdict unparseable -> empty", loaded.parseReviewVerdict("no verdict here") === "");
check("roundLabelOf exported", typeof loaded.roundLabelOf === "function");
check("roundLabelOf challenge", loaded.roundLabelOf("请用中文对上述回答逐条质疑", realT) === "质疑轮");
check("roundLabelOf final", loaded.roundLabelOf("请不再质疑，仅给出最终评审结论", realT) === "终评轮");
check("roundLabelOf review (逐条审查)", loaded.roundLabelOf("请作为审查者用中文逐条审查", realT) === "审查轮");
check("roundLabelOf review (Overall Verdict)", loaded.roundLabelOf("**Overall Verdict**: READY", realT) === "审查轮");
check("roundLabelOf default", loaded.roundLabelOf("随便一句话", realT) === "回合");
check("roundLabelOf empty -> empty", loaded.roundLabelOf("") === "" && loaded.roundLabelOf(void 0) === "");
const reviseMsg = loaded.buildReviseMessage("objection text", chCtx, realT);
check("revise message = directive + review.md path (no inline action items)", reviseMsg.includes("不认可") && reviseMsg.includes("review.md") && reviseMsg.includes("Action Items") && !reviseMsg.includes("objection text"));
check("revise message records the review->propose transition", reviseMsg.includes("record review.completed NEEDS_REVISION") && reviseMsg.includes("record propose.completed"));
check("stripMarkdown removes emphasis and code", loaded.stripMarkdown("**bold** and `code` and [link](http://x)") === "bold and code and link");
check("stripMarkdown keeps paragraphs", loaded.stripMarkdown("line1\n\n\n\nline2") === "line1\n\nline2");
const reviseMd = loaded.buildReviseMessage("**核心问题**：方案有缺陷", { ...chCtx, scene: "business" }, realT);
check("revise message strips markdown before injection", reviseMd.includes("核心问题：方案有缺陷") && !reviseMd.includes("**"));
const qaPrompt = loaded.buildRoundPrompt("review", { ...chCtx, scene: "qa" }, realT);
check("qa scene role", qaPrompt.includes("QA Expert"));
const challengePrompt = loaded.buildRoundPrompt("challenge", chCtx, realT);
check("challenge prompt (original flow): question + answer", challengePrompt.includes("用户问题") && challengePrompt.includes("质疑") && challengePrompt.includes("docs/plan.md"));
check("challenge prompt has no review verdict", !challengePrompt.includes("Overall Verdict") && !challengePrompt.includes("结构化方案"));
const finalPrompt = loaded.buildRoundPrompt("final", chCtx, realT);
check("final prompt (original flow): verdict directive", finalPrompt.includes("修正后的回答") && finalPrompt.includes("最终评审结论") && !finalPrompt.includes("Overall Verdict"));
check("final prompt (P0-2): 逐条核对上一轮质疑是否被回应", finalPrompt.includes("逐条核对") && finalPrompt.includes("上一轮提出的质疑") && finalPrompt.includes("被逐一回应") && finalPrompt.includes("仍未解决的项"));
check("final prompt (P0-2): 仍禁止提出新质疑", finalPrompt.includes("不要提出新的质疑"));
// P1-2 质量断言（纯函数）：首问里的文件引用必须进入「提到的文件」结构化清单
// （而非仅以字面量出现在用户问题原文里——那挑战者可能不主动读）。
const qRefCtx = { scene: "business", userQuestion: "请审查 docs/plan.md 的方案", lastMainText: "回答正文", lastArenaText: "" };
check("P1-2(纯函数): challenge prompt 提到的文件含首问引用", loaded.buildRoundPrompt("challenge", qRefCtx, realT).includes("提到的文件：docs/plan.md"));
check("P1-2(纯函数): final prompt 提到的文件含首问引用", loaded.buildRoundPrompt("final", qRefCtx, realT).includes("提到的文件：docs/plan.md"));
check("P1-2(纯函数): review prompt 提到的文件含首问引用", loaded.buildRoundPrompt("review", { ...qRefCtx, scene: "knowledge" }, realT).includes("提到的文件：docs/plan.md"));
// knowledge 质量断言（纯函数）：审查维度完整性 + 产物分支路径
const kReviewPrompt = loaded.buildRoundPrompt("review", { scene: "knowledge", userQuestion: "Q", lastMainText: "方案", proposalPath: "/p.md", designPath: "/d.md", tasksPath: "/t.md", reviewPath: "/r.md" }, realT);
check("知识沉淀: review prompt 含全部审查维度", ["需求清晰度", "设计合理性", "风险", "任务拆解", "相关规格"].every((d) => kReviewPrompt.includes(d)), "missing=" + ["需求清晰度", "设计合理性", "风险", "任务拆解", "相关规格"].filter((d) => !kReviewPrompt.includes(d)).join(","));
check("知识沉淀: 产物分支含四个文件路径（含 review.md 输出路径）", kReviewPrompt.includes("proposal.md: /p.md") && kReviewPrompt.includes("design.md: /d.md") && kReviewPrompt.includes("tasks.md: /t.md") && kReviewPrompt.includes("review.md 输出路径: /r.md"));
check("extractFileRefs finds code/link paths", loaded.extractFileRefs("see `docs/a.md` and [x](src/b.ts)").join(",") === "docs/a.md,src/b.ts");
check("fmt substitutes placeholders", loaded.fmt("a {x} b", { x: "1" }) === "a 1 b");
check("pathBasename strips dirs to the last segment", loaded.pathBasename("/ws/skills/knowledge/skill.md") === "skill.md");
check("pathBasename returns the folder name for a dir path", loaded.pathBasename("/ws/skills/knowledge") === "knowledge");
check("pathBasename trims a trailing slash", loaded.pathBasename("/ws/skills/knowledge/") === "knowledge");
check("pathBasename handles a bare name / empty", loaded.pathBasename("skill.md") === "skill.md" && loaded.pathBasename("") === "" && loaded.pathBasename(void 0) === "");
// ── tool-call trail in round prompts (assistant-node blocks only) ────────
check("formatToolTrail empty input -> empty string", loaded.formatToolTrail([]) === "" && loaded.formatToolTrail(void 0) === "" && loaded.formatToolTrail(null) === "");
check("formatToolTrail prefers description summary", loaded.formatToolTrail([{ name: "read_file", argsRaw: JSON.stringify({ description: "读取 src/query.ts", path: "src/query.ts" }) }]) === "1. read_file「读取 src/query.ts」");
const jsonFallback = loaded.formatToolTrail([{ name: "run_command", argsRaw: '{"command":"pnpm bench"}' }]);
check("formatToolTrail falls back to compact json", jsonFallback.includes("run_command") && jsonFallback.includes("pnpm bench"));
check("formatToolTrail truncates long args", loaded.formatToolTrail([{ name: "x", argsRaw: "y".repeat(500) }]).length < 400);
const toolsCtx = { ...chCtx, lastMainTools: [{ name: "read_file", argsRaw: '{"path":"src/query.ts"}' }, { name: "run_command", argsRaw: '{"command":"pnpm bench"}' }] };
const toolsPrompt = loaded.buildRoundPrompt("review", toolsCtx, realT);
check("review prompt includes tool trail", toolsPrompt.includes("工具操作记录") && toolsPrompt.includes("1. read_file") && toolsPrompt.includes("2. run_command"));
check("review prompt tool trail after files section", toolsPrompt.indexOf("工具操作记录") > toolsPrompt.indexOf("提到的文件"));
check("no tool trail when lastMainTools absent", !loaded.buildRoundPrompt("review", chCtx, realT).includes("工具操作记录"));
check("nonMdSig flips when reasoning turns non-empty", loaded.nonMdSig([{ kind: "reasoning", text: "" }, { kind: "text", text: "x" }]) !== loaded.nonMdSig([{ kind: "reasoning", text: "thinking" }, { kind: "text", text: "x" }]));
check("nonMdSig stable while reasoning text streams", loaded.nonMdSig([{ kind: "reasoning", text: "t1" }]) === loaded.nonMdSig([{ kind: "reasoning", text: "t1 longer" }]));
check("nonMdSig unchanged for text-only streaming", loaded.nonMdSig([{ kind: "text", text: "a" }]) === loaded.nonMdSig([{ kind: "text", text: "ab" }]));
const seed = loaded.buildRoleSeed({ scene: "knowledge" }, realT);
check("role seed carries reviewer rank + no-debate", seed.includes("Challenger") && seed.includes("身份高于") && seed.includes("审查者") && seed.includes("Knowledge Expert") && seed.includes("禁止辩论") && seed.includes("Overall Verdict"));
const mainSeed = loaded.buildMainRoleSeed({ scene: "knowledge" }, realT);
check("knowledge main seed places workflow trigger after the role setting", mainSeed.includes("Knowledge Expert") && mainSeed.includes("进行知识沉淀") && mainSeed.indexOf("你是") !== -1 && mainSeed.indexOf("你是") < mainSeed.indexOf("启动workflow") && mainSeed.endsWith("启动workflow，进行知识沉淀。"));

const toggle = heroRow.children.find((child) => child.dataset.arenaToggle !== void 0);
check("toggle mounted in hero row", toggle !== void 0);
check("toggle default off", toggle.getAttribute("aria-pressed") === "false");

click(toggle);
const panel = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
check("toggle on mounts panel", panel !== void 0);
check("composer blocked while arena on without model", blockCalls.some((c) => c.sessionId === "s1" && c.block?.reason === "L:block.reason"));
const sceneBtnEls = collectByClass(panel, "ma-sceneBtn");
check("scene selector has three options", sceneBtnEls.length === 3);
check("business scene listed", sceneBtnEls[0].textContent === "L:scene.business");
check("business scene default", sceneBtnEls[0].getAttribute("aria-pressed") === "true" && sceneBtnEls[0].textContent === "L:scene.business");
click(sceneBtnEls[2]); // switch to qa
check("scene switched to qa", sceneBtnEls[2].getAttribute("aria-pressed") === "true" && sceneBtnEls[1].getAttribute("aria-pressed") === "false");
click(sceneBtnEls[1]); // back to knowledge for the review-loop flow

const selector = panel.children[1];
const trigger = selector.children[0];
const menuHost = selector.children[1];
const note = panel.children.find((c) => /^ma-(hint|conflict|error)/.test(c.className));
const triggerLabel = collectByClass(trigger, "ma-triggerLabel")[0];
const triggerEffort = collectByClass(trigger, "ma-triggerEffort")[0];
check("trigger placeholder", triggerLabel.textContent === "L:model.placeholder" && triggerEffort.textContent === "");

// open -> root pane with two cells
click(trigger);
let cells = collectByClass(menuHost, "ma-cell");
check("root pane: two cells", cells.length === 2);
check("model cell value placeholder", cellNamed(cells, "L:menu.model") !== void 0);
const effortCell = cellNamed(cells, "L:menu.effort");
check("effort cell disabled before model", effortCell !== void 0 && effortCell.disabled === true);

// drill into the model list
click(cellNamed(cells, "L:menu.model"));
const modelOptions = collectByClass(menuHost, "ma-option");
check("model list offers m2/m3", optionNamed(modelOptions, "M2") !== void 0 && optionNamed(modelOptions, "M3") !== void 0);
check("input model m1 excluded", optionNamed(modelOptions, "M1") === void 0);

// pick M2 -> popup STAYS OPEN, advancing to the effort pane (M2's own efforts)
click(optionNamed(modelOptions, "M2"));
let effortOptions = collectByClass(menuHost, "ma-option");
check("composer unblocked after model pick", blockCalls[blockCalls.length - 1].block === void 0);
check("popup stays open after model pick (effort pane)", menuHost.children.length === 1 && effortOptions.length === 3);
check("effort list = model A's own efforts", optionNamed(effortOptions, "Low") !== void 0 && optionNamed(effortOptions, "High") !== void 0);
check("default effort checked", effortOptions.find((o) => o.getAttribute("aria-checked") === "true") !== void 0);
check("trigger shows M2 (label live)", triggerLabel.textContent === "M2");

// pick High in the same interaction -> menu closes, trigger updates
click(optionNamed(effortOptions, "High"));
check("menu closed after effort pick", menuHost.children.length === 0);
check("trigger shows M2 · High", triggerLabel.textContent === "M2" && triggerEffort.textContent === "High");

// MODEL LINKAGE IN THE UI: pick M3 (different reasoning) -> its OWN effort list
click(trigger);
cells = collectByClass(menuHost, "ma-cell");
click(cellNamed(cells, "L:menu.model"));
click(optionNamed(collectByClass(menuHost, "ma-option"), "M3"));
check("popup advances to model B's effort pane", menuHost.children.length === 1);
effortOptions = collectByClass(menuHost, "ma-option");
check("effort list switched to model B (Fast only)", effortOptions.length === 1 && hasDescendant(effortOptions[0], "ma-optionName", "Fast"));
click(optionNamed(effortOptions, "Fast"));
check("menu closed after model B effort pick", menuHost.children.length === 0);
check("trigger shows M3 · Fast (auto default)", triggerLabel.textContent === "M3" && triggerEffort.textContent === "Fast");

// conflict: input box moves onto the arena pick -> cleared + note + block re-armed
snap.current = { provider: "p2", model: "m3" };
snapSub();
check("conflict clears arena model", triggerLabel.textContent === "L:model.placeholder" && triggerEffort.textContent === "");
check("composer re-blocked after conflict (arena on, no model)", blockCalls[blockCalls.length - 1].block?.reason === "L:block.reason");
check("conflict note shown", note.className === "ma-conflict" && note.textContent === "L:conflict");

// ── challenger skill picker (workspace-persisted) ─────────────────────────
const skillRow = panel.children.find((c) => c.dataset.arenaSkillRow !== void 0);
const skillTrigger = skillRow === void 0 ? void 0 : skillRow.children[1].children[0];
const skillHost = skillRow === void 0 ? void 0 : skillRow.children[1].children[1];
check("skill row mounted after scene row", skillTrigger !== void 0 && skillHost !== void 0);
check("skill placeholder initially", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "L:skill.placeholder");
// open the popover, type a manual path, confirm -> applied + persisted per workspace
click(skillTrigger);
const skillPopover = skillHost.children[0];
check("skill popover opened", skillPopover !== void 0 && skillPopover.dataset.arenaSkillPopover !== void 0);
const skillInput = collectByClass(skillPopover, "ma-questionInput")[0];
skillInput.value = "/ws/.github/skills/theseus-review-spec";
const skillConfirm = collectByClassContains(skillPopover, "ma-questionBtn").find((b) => b.textContent === "L:skill.confirm");
click(skillConfirm);
check("skill applied to trigger label (basename)", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "theseus-review-spec");
check("skill persisted per workspace + scene", settingsMutateCalls.some((m) => m.ns === "model-arena" && m.ops?.[0]?.path?.[0] === "workspaceSkills" && m.ops[0].path[1] === "/ws1" && m.ops[0].value?.knowledge === "/ws/.github/skills/theseus-review-spec"));
check("skill row hidden popover after apply", skillHost.children.length === 0);
// clear -> back to empty + persisted empty
click(skillTrigger);
const clearBtn = collectByClassContains(skillHost.children[0], "ma-questionBtn").find((b) => b.textContent === "L:skill.clear");
click(clearBtn);
check("skill cleared", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "L:skill.placeholder" && settingsMutateCalls.some((m) => m.ns === "model-arena" && m.ops?.[0]?.path?.[0] === "workspaceSkills" && m.ops[0].path[1] === "/ws1" && m.ops[0].value?.knowledge === ""));
// skill is bound to the scene: each scene remembers its own skill (current = knowledge)
click(skillTrigger);
let skPop = skillHost.children[0];
let skIn = collectByClass(skPop, "ma-questionInput")[0];
skIn.value = "/ws/skills/knowledge";
click(collectByClassContains(skPop, "ma-questionBtn").find((b) => b.textContent === "L:skill.confirm"));
check("knowledge scene remembers its own skill", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "knowledge");
// business has no remembered skill yet -> switching there empties the pick
click(sceneBtnEls[0]);
check("switching to business loads its (empty) skill", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "L:skill.placeholder");
// set a different business-scoped skill
click(skillTrigger);
skPop = skillHost.children[0];
skIn = collectByClass(skPop, "ma-questionInput")[0];
skIn.value = "/ws/skills/business";
click(collectByClassContains(skPop, "ma-questionBtn").find((b) => b.textContent === "L:skill.confirm"));
check("business scene remembers its own skill", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "business");
// switching back to knowledge restores its remembered skill
click(sceneBtnEls[1]);
check("switching back to knowledge restores its skill", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "knowledge");
// and business restores its own again
click(sceneBtnEls[0]);
check("switching back to business restores its skill", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "business");
// clean up: clear both scene skills and return to knowledge (empty) for the next section
click(skillTrigger);
skPop = skillHost.children[0];
click(collectByClassContains(skPop, "ma-questionBtn").find((b) => b.textContent === "L:skill.clear"));
check("business skill cleared (scene-scoped)", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "L:skill.placeholder");
click(sceneBtnEls[1]); // back to knowledge
click(skillTrigger);
skPop = skillHost.children[0];
click(collectByClassContains(skPop, "ma-questionBtn").find((b) => b.textContent === "L:skill.clear"));
check("knowledge skill cleared (scene-scoped)", collectByClassContains(skillTrigger, "ma-triggerLabel")[0].textContent === "L:skill.placeholder");
// role seed carries the skill instruction when set; unchanged when empty
check("role seed with skill carries the instruction", loaded.buildRoleSeed({ scene: "knowledge", skill: "/x/skill" }, realT).includes("挑战者技能：/x/skill") && loaded.buildRoleSeed({ scene: "knowledge", skill: "/x/skill" }, realT).includes("SKILL.md"));
check("role seed without skill unchanged", !loaded.buildRoleSeed({ scene: "knowledge" }, realT).includes("挑战者技能"));

// toggle off removes the panel
click(toggle);
check("toggle off removes panel", heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0) === void 0);
check("toggle aria-pressed off", toggle.getAttribute("aria-pressed") === "false");

// ── two-model auto arena model (hero flow) ────────────────────────────────
// With exactly TWO models in the directory, enabling the arena auto-selects
// the complement of the input box's current model (no manual pick) and the
// composer is never blocked; switching the composer model flips the arena
// model to the new complement.
const prevSnap = snap;
const blockCountBeforeAuto = blockCalls.length;
snap = twoModelDir;
snapSub();
click(toggle); // arena on
const autoPanel = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
const autoTrigger = autoPanel?.children[1]?.children[0];
check("two-model auto: toggle on auto-selects the complement (no placeholder)", collectByClass(autoTrigger, "ma-triggerLabel")[0]?.textContent === "M2");
check("two-model auto: effort shows the complement's default", collectByClass(autoTrigger, "ma-triggerEffort")[0]?.textContent === "Fast");
check("two-model auto: composer NOT blocked (arena ready without a pick)", blockCalls.length > blockCountBeforeAuto && blockCalls[blockCalls.length - 1].block === void 0);
// composer switch: m1 -> m2 flips the arena model to m1 (complement follows)
snap = { ...twoModelDir, current: { provider: "p1", model: "m2", reasoningEffort: void 0 } };
snapSub();
check("two-model auto: composer switch flips the arena model", (() => {
  const p = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
  const lbl = collectByClass(p?.children[1]?.children[0], "ma-triggerLabel")[0];
  return lbl?.textContent === "M1";
})());
check("two-model auto: flipped model shows its own effort default", (() => {
  const p = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
  const eff = collectByClass(p?.children[1]?.children[0], "ma-triggerEffort")[0];
  return eff?.textContent === "L:effort.default";
})());
// composer back to m1 -> arena returns to m2
snap = twoModelDir;
snapSub();
check("two-model auto: arena follows back when the composer returns", (() => {
  const p = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
  const lbl = collectByClass(p?.children[1]?.children[0], "ma-triggerLabel")[0];
  return lbl?.textContent === "M2";
})());
click(toggle); // arena off again
snap = prevSnap;
snapSub();
check("two-model auto: toggle off removes the panel", heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0) === void 0);

// ── arena runtime: first message spawns the arena session + split ───────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
click(toggle); // arena on again
click(trigger);
cells = collectByClass(menuHost, "ma-cell");
click(cellNamed(cells, "L:menu.model"));
click(optionNamed(collectByClass(menuHost, "ma-option"), "M2"));
await sleep(0);

// trigger a sync so the arena runtime mounts for the current session
listSub();
await sleep(80);

// the first user message arrives in the main session
const mainStore = sessionStores.get("s1");
mainStore._set({
  chat: {
    order: ["u1"],
    nodes: new Map([["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }]])
  }
});
await sleep(30);

check("arena session attached to the main workspace", createCalls.length === 1 && createCalls[0].workspaceId === "w1");
check("arena model selected", selectCalls.length === 1 && selectCalls[0].sessionId === "arena-1" && selectCalls[0].provider === "p1" && selectCalls[0].model === "m2" && selectCalls[0].reasoningEffort === void 0);
check("no seed message (roles via system prompt)", promptCalls.length === 0);
check("persona map synced to settings", settingsMutateCalls.some((m) => m.ns === "model-arena" && m.ops?.[0]?.path?.[0] === "persona" && m.ops[0].value.s1 !== void 0 && m.ops[0].value.s1.includes("Knowledge Expert") && m.ops[0].value["arena-1"] !== void 0 && m.ops[0].value["arena-1"].includes("Challenger")));
const internals = loaded.__internals;
check("composer locked during review (propose stage label)", blockCalls.some((c) => c.sessionId === "s1" && c.block?.reason === "L:block.challenge.propose"));
check("challenge phase = propose after first question", internals.getArenaMount().challenge.phase === "propose" && internals.getArenaMount().challenge.active === true);
check("arena session archived on create (hidden from sidebar/counter)", archiveCalls.includes("arena-1"));
check("permission preset applied via command channel (not prompt)", commandCalls.length === 1 && commandCalls[0].sessionId === "arena-1" && commandCalls[0].line === "/permission workspace-write" && !promptCalls.some((c) => c.content?.[0]?.text?.startsWith("/permission")));
check("arena session window opened", openCalls.includes("arena-1"));
check("arena session titled", renameCalls.length === 1 && renameCalls[0].sessionId === "arena-1" && renameCalls[0].title === "L:arena.sessionTitle");
const arenaTabEntry = slotRegisterCalls.find((c) => c.name === "conversation.view" && c.id === "arena");
check("arena view tab registered (native view ring)", arenaTabEntry !== void 0 && typeof arenaTabEntry.component === "function");
check("arena tab label", typeof arenaTabEntry?.label === "function" && arenaTabEntry.label() === "L:view.arena");
check("arena settings section registered (settings.section)", slotRegisterCalls.some((c) => c.name === "settings.section" && c.id === "model-arena" && typeof c.label === "function" && c.label() === "L:settings.title" && typeof c.component === "function"));
// the card must render without throwing and carry scene docs + real prompts
const arenaSettingsEntry = slotRegisterCalls.find((c) => c.name === "settings.section" && c.id === "model-arena");
let arenaSettingsText = "";
try {
  arenaSettingsText = JSON.stringify(arenaSettingsEntry.component());
} catch (settingsRenderError) {
  arenaSettingsText = "RENDER ERROR: " + String(settingsRenderError?.message ?? settingsRenderError);
}
check("arena settings card renders scenes", arenaSettingsText.includes("Technical Expert") && arenaSettingsText.includes("Knowledge Expert") && arenaSettingsText.includes("QA Expert"));
check("arena settings card renders injected prompts", arenaSettingsText.includes("逐条质疑") && arenaSettingsText.includes("Overall Verdict") && arenaSettingsText.includes("评审"));

// the arena session replies -> the arena tab's container renders it
const tabRoot = new FakeElement("div");
internals.mountArenaTab(tabRoot, "s1");
const paneBody = findInTree(tabRoot, byData("arenaPaneBody"));
check("arena pane body mounted", paneBody !== null);
const arenaStore = sessionStores.get("arena-1");
arenaStore._set({
  chat: {
    order: ["au1", "aa1"],
    nodes: new Map([
      ["au1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["aa1", { key: "aa1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, time: 2, blocks: [{ kind: "reasoning", text: "thinking" }, { kind: "text", text: "arena answer" }] } }]
    ])
  }
});
await sleep(10);
const bubbles = collectByClassContains(paneBody, "ma-bubble");
check("arena pane renders no duplicated user bubble (shared input)", !bubbles.some((b) => b.className.includes("user")));
const asstHost = findInTree(paneBody, (el) => el.className === "ma-assistantMd");
check("arena pane renders assistant reply via native MarkdownText", asstHost !== null && asstHost._react?.type === primitivesStub.MarkdownText && asstHost._react?.props?.text === "arena answer");
const thinkEl = bubbles.find((b) => b.className.includes("think"));
check("arena pane renders reasoning via native DisclosureRow", thinkEl !== void 0 && thinkEl._react?.type === primitivesStub.DisclosureRow);
const roundEl = findInTree(paneBody, (el) => el.dataset?.arenaRound !== void 0);
check("arena pane renders a labeled round divider for the round prompt", roundEl !== null && roundEl.className === "ma-arenaRound" && roundEl.children.some((c) => c.className === "ma-arenaRoundLabel"));

// streaming: an empty reasoning placeholder block arrives first, content
// later — the non-md signature must still flip when reasoning turns
// non-empty, or the Think row never appears
arenaStore._set({
  chat: {
    order: ["au1", "aa1"],
    nodes: new Map([
      ["au1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["aa1", { key: "aa1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "reasoning", text: "" }, { kind: "text", text: "arena answer" }] } }]
    ])
  }
});
await sleep(10);
check("empty reasoning placeholder renders no think row", !collectByClassContains(paneBody, "ma-bubble").some((b) => b.className.includes("think")));
arenaStore._set({
  chat: {
    order: ["au1", "aa1"],
    nodes: new Map([
      ["au1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["aa1", { key: "aa1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "reasoning", text: "thinking" }, { kind: "text", text: "arena answer" }] } }]
    ])
  }
});
await sleep(10);
check("reasoning filled in later renders the think row (DisclosureRow)", collectByClassContains(paneBody, "ma-bubble").some((b) => b.className.includes("think") && b._react?.type === primitivesStub.DisclosureRow));

// a legacy prompt-based permission grant (user node + assistant reply) is
// hidden from the pane: the grant + its whole reply turn vanish
arenaStore._set({
  chat: {
    order: ["p0", "pa0", "au2", "aa2"],
    nodes: new Map([
      ["p0", { key: "p0", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "/permission workspace-write" }] } }],
      ["pa0", { key: "pa0", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "permission granted" }] } }],
      ["au2", { key: "au2", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "real question" }] } }],
      ["aa2", { key: "aa2", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "real answer" }] } }]
    ])
  }
});
await sleep(10);
const bubblesAfterGrant = collectByClassContains(paneBody, "ma-bubble");
check("permission grant node hidden from the pane", !bubblesAfterGrant.some((b) => b.textContent.includes("/permission")));
check("permission grant reply hidden from the pane", !bubblesAfterGrant.some((b) => b.textContent.includes("permission granted")));
check("content after the grant still renders", !bubblesAfterGrant.some((b) => b.className.includes("user")) && findInTree(paneBody, (el) => el.className === "ma-assistantMd" && el._react?.props?.text === "real answer") !== null);

// ── arena question answering ──────────────────────────────────────────────
const questionResults = [];
arenaStore._set({
  chat: arenaStore.snapshot.chat,
  pending: [
    {
      kind: "question",
      key: "q:1",
      sessionId: "arena-1",
      payload: { questions: [{ id: "qa1", question: "Is it OK?", options: [{ label: "Yes" }, { label: "No" }] }] },
      respond: async (result) => {
        questionResults.push(result);
      }
    }
  ]
});
await sleep(10);
let qCard = findInTree(tabRoot, byData("arenaQuestion"));
check("question card rendered in the arena pane", qCard !== null);
const yesBtn = collectByClassContains(qCard, "ma-questionOpt").find((b) => b.textContent === "Yes");
click(yesBtn);
await sleep(10);
check("single-select submits the answer", questionResults.length === 1 && questionResults[0].ok === true && questionResults[0].value.sessionId === "arena-1" && questionResults[0].value.answer.answers[0].id === "qa1" && questionResults[0].value.answer.answers[0].selected.join(",") === "Yes");

// free-text question: input + submit with custom
const textResults = [];
arenaStore._set({
  chat: arenaStore.snapshot.chat,
  pending: [
    {
      kind: "question",
      key: "q:2",
      sessionId: "arena-1",
      payload: { questions: [{ id: "qa2", question: "Any details?" }] },
      respond: async (result) => {
        textResults.push(result);
      }
    }
  ]
});
await sleep(10);
qCard = findInTree(tabRoot, byData("arenaQuestion"));
const textInput = collectByClassContains(qCard, "ma-questionInput")[0];
textInput.value = "my custom answer";
textInput._handlers.input[0]();
const submitBtn = collectByClassContains(qCard, "ma-questionBtn").find((b) => b.textContent === "L:arena.question.submit");
click(submitBtn);
await sleep(10);
check("free-text answer submits custom", textResults.length === 1 && textResults[0].value.answer.answers[0].custom === "my custom answer");

// approval wait: allow button responds allowed-once
const approvalResults = [];
arenaStore._set({
  chat: arenaStore.snapshot.chat,
  pending: [
    {
      kind: "approval",
      key: "a:1",
      sessionId: "arena-1",
      payload: { approvalId: "ap1", toolName: "bash", reason: "run a command" },
      respond: async (result) => {
        approvalResults.push(result);
      }
    }
  ]
});
await sleep(10);
qCard = findInTree(tabRoot, byData("arenaQuestion"));
check("approval card rendered", qCard !== null);
const allowBtn = collectByClassContains(qCard, "ma-questionBtn").find((b) => b.textContent === "L:arena.question.allow");
click(allowBtn);
await sleep(10);
check("approval allow responds allowed-once", approvalResults.length === 1 && approvalResults[0].ok === true && approvalResults[0].value.approvalId === "ap1" && approvalResults[0].value.outcome === "allowed-once");

// The arena session chat is EMPTY when a challenge starts (the first round
// prompt is the first node — the rendering fixtures above were artificial).
// Reset it so the review-loop orchestration sees production reality; the
// poll-based catch-up would otherwise treat the last fixture node as a
// completed challenger turn.
arenaStore._set({ chat: { order: [], nodes: new Map() } });
await sleep(10);

// Simulate the node half writing `arena.reviewRequest` after it observes the
// main model's `propose.completed`: patch the settings namespace value and fire
// the settings/document-updated handler so the browser half reloads settings
// and advances propose/revise -> review.
const fireReviewRequest = (reviewRequest) => {
  let ns = settingsNamespaces.find((n) => n.ns === "model-arena");
  if (ns === void 0) {
    ns = { ns: "model-arena", value: {} };
    settingsNamespaces.push(ns);
  }
  ns.value = { ...(ns.value ?? {}), arena: { ...(ns.value?.arena ?? {}), reviewRequest } };
  settingsUpdatedHandler?.("model-arena");
};

// ── review loop: propose → review → (revise → review)* ─────────────────
// The node half observes `propose.completed` and writes arena.reviewRequest;
// the browser half consumes it and prompts the challenger to review the
// proposal artifacts (file paths, not chat text).
fireReviewRequest({ workflowId: "wf1", seq: 1, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
await sleep(20);
const arenaPrompts = promptCalls.filter((c) => c.sessionId === "arena-1");
check("challenger prompted to review after proposal", arenaPrompts.length === 1 && arenaPrompts[0].content[0].text.includes("proposal.md"));
check("review prompt carries artifact paths", arenaPrompts[0].content[0].text.includes("proposal.md") && arenaPrompts[0].content[0].text.includes("design.md") && arenaPrompts[0].content[0].text.includes("tasks.md") && arenaPrompts[0].content[0].text.includes("review.md 输出路径"));
check("review phase = review", internals.getArenaMount().challenge.phase === "review");
check("challenger persona carries review instruction", settingsMutateCalls.some((m) => m.ns === "model-arena" && m.ops?.[0]?.value?.["arena-1"] !== void 0 && m.ops[0].value["arena-1"].includes("审查者")));

// switching away and back mid-review must preserve the flow state
currentSession = "s2";
listSub();
await sleep(80);
currentSession = "s1";
listSub();
await sleep(80);
check("review state survives a session round-trip", internals.getArenaMount() !== null && internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "review");

// challenger rejects (NEEDS_REVISION) → revision instruction injected into main
arenaStore._set({
  chat: {
    order: ["rv1"],
    nodes: new Map([["rv1", { key: "rv1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION\nAction Items: fix A" }] } }]])
  }
});
await sleep(20);
check("reject verdict injects revision instruction into main", promptCalls.some((c) => c.sessionId === "s1" && c.content[0].text.includes("不认可") && c.content[0].text.includes("review.md") && !c.content[0].text.includes("fix A")));
check("review phase = revise after rejection", internals.getArenaMount().challenge.phase === "revise");
check("reject count = 1", internals.getArenaMount().challenge.rejectCount === 1);

// the main model revises the files and records propose.completed again → the
// node half writes a fresh reviewRequest → challenger re-reviews (终审)
fireReviewRequest({ workflowId: "wf1", seq: 2, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
await sleep(20);
const reviewPrompts = promptCalls.filter((c) => c.sessionId === "arena-1");
check("re-review prompted after revision", reviewPrompts.length === 2);
check("review phase = review again", internals.getArenaMount().challenge.phase === "review");

// challenger approves (READY) → verdict injected + flow done + composer unlocked
arenaStore._set({
  chat: {
    order: ["rv1", "rv2"],
    nodes: new Map([
      ["rv1", { key: "rv1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION\nAction Items: fix A" }] } }],
      ["rv2", { key: "rv2", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 2, step: 1, blocks: [{ kind: "text", text: "**Overall Verdict**: READY" }] } }]
    ])
  },
  running: false
});
await sleep(20);
check("approval verdict injected into main", promptCalls.some((c) => c.sessionId === "s1" && c.content[0].text.includes("READY")));
check("review done after approval", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "done");
check("composer unlocked after approval", blockCalls[blockCalls.length - 1].block === void 0);
check("composer stage label advances with phase", (() => {
  const reasons = blockCalls.filter((c) => c.sessionId === "s1").map((c) => c.block?.reason);
  return reasons.includes("L:block.challenge.propose") && reasons.includes("L:block.challenge.review") && reasons.includes("L:block.challenge.revise");
})());
const promptsAfterDone = promptCalls.length;
arenaStore._set({ chat: arenaStore.snapshot.chat });
await sleep(20);
check("no re-trigger after flow done (phase guard)", promptCalls.length === promptsAfterDone);
// Consume the historical user nodes (inj1/v1 placeholders) so the first-user-
// message detector does not treat them as a fresh round — its anchor scan now
// only sees the genuinely new "u2" question in the stop test below.
internals.getArenaMount().lastSeenSeq = 5;
// after approval, a late main-session reply must NEVER reach the challenger
const promptsBeforeLateReply = promptCalls.length;
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1", "v1", "late"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "proposal" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "review feedback placeholder" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised" }] } }],
      ["v1", { key: "v1", kind: "user", anchorSeq: 5, data: { content: [{ type: "text", text: "Overall Verdict: READY" }] } }],
      ["late", { key: "late", kind: "assistant-step", anchorSeq: 99, data: { status: "settled", blocks: [{ kind: "text", text: "model1 reacts to approval" }] } }]
    ])
  }
});
await sleep(20);
check("late main reply never prompts the challenger again", promptCalls.length === promptsBeforeLateReply);
// ── review scene is one-shot: after done, a new user message must NOT ───────
// re-arm the challenge — the header stays hidden and the challenger stays
// dormant (no propose.completed will ever arrive again after apply).
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1", "v1", "u2"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "proposal" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "review feedback placeholder" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised" }] } }],
      ["v1", { key: "v1", kind: "user", anchorSeq: 5, data: { content: [{ type: "text", text: "Overall Verdict: READY" }] } }],
      ["u2", { key: "u2", kind: "user", anchorSeq: 6, data: { content: [{ type: "text", text: "second question" }] } }]
    ])
  },
  running: true
});
await sleep(20);
check("done review challenge not re-armed by a new message", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "done");
check("done review challenge header stays hidden", loaded.shouldShowChallengeHeader(internals.getArenaMount().challenge) === false);

// Reset the in-memory challenge to a fresh idle state (simulating a brand-new
// session) so the stop watchdog test below can re-arm a new review round. Also
// clear the persisted link.done flag — a real brand-new session has no terminal
// marker, and the stop/reject tests need the re-arm to go through.
const resetChallengeForTest = (lastSeenSeq) => {
  const m = internals.getArenaMount();
  if (m === null) return;
  Object.assign(m.challenge, {
    active: false, phase: "idle", rejectCount: 0, verdict: "", round: 0,
    stallSince: 0, lastReviewSeq: -1, mainAnchor: null, arenaAnchor: null,
    pendingAnchor: false, lastInjectedText: "", mainWasRunning: false, arenaWasRunning: false
  });
  m.lastSeenSeq = lastSeenSeq;
  try {
    internals.clearReviewDone?.("s1");
  } catch {}
};
resetChallengeForTest(6); // "u2" (anchorSeq 6) already consumed above

// ── user stop: stopping the main session cancels the challenger ─────────────
// start a fresh round
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1", "v1", "u2", "u3"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "answer" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "review feedback placeholder" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised" }] } }],
      ["v1", { key: "v1", kind: "user", anchorSeq: 5, data: { content: [{ type: "text", text: "Overall Verdict: READY" }] } }],
      ["u2", { key: "u2", kind: "user", anchorSeq: 6, data: { content: [{ type: "text", text: "second question" }] } }],
      ["u3", { key: "u3", kind: "user", anchorSeq: 7, data: { content: [{ type: "text", text: "third question" }] } }]
    ])
  },
  running: true
});
await sleep(20);
check("new round started after reset", internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "propose");

// model 1 is generating (running true) ...
mainStore._set({
  chat: mainStore.snapshot.chat,
  running: true
});
await sleep(10);
// ... then the user stops: running false, NO new node -> whole challenge aborts,
// the challenger session is cancelled, composer unlocks
mainStore._set({
  chat: mainStore.snapshot.chat,
  running: false
});
await sleep(20);
check("stop aborts the challenge", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "aborted");
check("stop cancels BOTH sessions (main like native stop + challenger)", cancelCalls.includes("s1") && cancelCalls.includes("arena-1"));
check("composer unlocked after stop", blockCalls[blockCalls.length - 1].block === void 0);

// ── 3 rejections end the loop without messaging the main model ──────────────
// start a fresh round (after the abort above, a new message re-arms), reject
// three times; on the 3rd the browser asks the node half (arena.returnToPropose)
// to write Theseus back to propose, and must NOT promptSession the main model
// (which would start a fresh turn).
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1", "v1", "u2", "u3", "u4"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "answer" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "review feedback placeholder" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised" }] } }],
      ["v1", { key: "v1", kind: "user", anchorSeq: 5, data: { content: [{ type: "text", text: "Overall Verdict: READY" }] } }],
      ["u2", { key: "u2", kind: "user", anchorSeq: 6, data: { content: [{ type: "text", text: "second question" }] } }],
      ["u3", { key: "u3", kind: "user", anchorSeq: 7, data: { content: [{ type: "text", text: "third question" }] } }],
      ["u4", { key: "u4", kind: "user", anchorSeq: 8, data: { content: [{ type: "text", text: "fourth question" }] } }]
    ])
  },
  running: true
});
await sleep(20);
fireReviewRequest({ workflowId: "wf1", seq: 200, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
await sleep(20);
// reject 1
arenaStore._set({ chat: { order: ["r1"], nodes: new Map([["r1", { key: "r1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION" }] } }]]) } });
await sleep(20);
fireReviewRequest({ workflowId: "wf1", seq: 201, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
await sleep(20);
// reject 2
arenaStore._set({ chat: { order: ["r1", "r2"], nodes: new Map([["r1", { key: "r1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION" }] } }], ["r2", { key: "r2", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 2, step: 1, blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION" }] } }]]) } });
await sleep(20);
fireReviewRequest({ workflowId: "wf1", seq: 202, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
await sleep(20);
const promptsBeforeReject3 = promptCalls.length;
// reject 3 → done + returnToPropose, no main-model message
arenaStore._set({ chat: { order: ["r1", "r2", "r3"], nodes: new Map([["r1", { key: "r1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION" }] } }], ["r2", { key: "r2", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION" }] } }], ["r3", { key: "r3", kind: "assistant-step", anchorSeq: 3, data: { status: "settled", turn: 3, step: 1, blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION" }] } }]]) } });
await sleep(20);
check("3 rejections end the loop", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "done");
check("3 rejections ask the node half to return to propose", settingsMutateCalls.some((m) => m.ns === "model-arena" && m.ops?.some((op) => op.path?.[0] === "arena" && op.path?.[1] === "returnToPropose")));
check("3rd rejection does NOT message the main model", promptCalls.length === promptsBeforeReject3);

// switching to a NEW session mid-challenge tears the runtime down cleanly
currentSession = "s2";
listSub();
await sleep(80);
check("switching away mid-challenge clears the arena runtime", internals.getArenaMount() === null);
currentSession = "s1";
listSub();
await sleep(80);
check("switching back restores the linkage (flow finished)", internals.getArenaMount() !== null && internals.getArenaMount().challenge.active === false);


// re-mount must NOT re-mirror history: navigate away (s2) and back (s1).
// The arena runtime tears down and re-mounts; already-mirrored messages
// must not be prompted into the arena session a second time.
const promptsBeforeRemount = promptCalls.length;
currentSession = "s2";
listSub();
await sleep(80);
currentSession = "s1";
listSub();
await sleep(80);
check("re-mount does not re-mirror history", promptCalls.length === promptsBeforeRemount, "prompts=" + promptCalls.length + " (expected " + promptsBeforeRemount + ")");
check("arena session not re-created on re-mount", createCalls.length === 1);

// Arena is permanent once linked (per the product decision: no exit after
// enabling). The persisted linkage restores the arena even if the hero toggle
// is flipped off (unreachable in the UI after the first message anyway).
click(toggle); // arena off attempt (no-op for a linked session)
listSub();
await sleep(80);
check("arena persists after toggle-off attempt (linkage restore)", slotRegisterCalls.some((c) => c.name === "conversation.view" && c.id === "arena"));


// ── archive coupling: the arena is archived on create; archiving the main
// session must NOT re-archive it (guard), and unlinked archives stay no-ops
archivedIds = ["s1", "arena-1"];
workspaceListSub?.();
await sleep(10);
check("main-session archive does NOT re-archive the already-archived arena", archiveCalls.filter((id) => id === "arena-1").length === 1);
// archiving an unrelated session (no link) archives nothing
archivedIds = ["s1", "arena-1", "other"];
workspaceListSub?.();
await sleep(10);
check("unlinked archive does not archive the arena session", archiveCalls.filter((id) => id === "arena-1").length === 1);

// ── competitor invisibility: arena session hidden from sidebar + selection guard ──
listSub?.();
await sleep(120);
check("arena session row hidden from the sidebar", arenaRow.style.display === "none");
check("normal session row stays visible", normalRow.style.display !== "none");
// simulate switching INTO the arena session — the guard bounces back to s1
await sleep(200);
listSub?.();
await sleep(30);
check("switching into the arena session bounces back to the main session", currentSession === "s1" || (openCalls.length >= 1 && openCalls.includes("s1")));

// ── business scenario: the ORIGINAL challenge flow (question -> verdict) ────
// Switch the hero panel scene to "business" (knowledge = review loop is the default).
const panelEl = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
const sceneBtns = collectByClass(panelEl, "ma-sceneBtn");
click(sceneBtns[0]); // business
// A fresh question in the main session must start the ORIGINAL challenge flow.
mainStore._set({
  chat: {
    order: [...mainStore.snapshot.chat.order, "bq1"],
    nodes: new Map([...mainStore.snapshot.chat.nodes, ["bq1", { key: "bq1", kind: "user", anchorSeq: 50, data: { content: [{ type: "text", text: "business question" }] } }]])
  },
  running: true
});
await sleep(20);
check("business scene starts the original challenge flow (answer phase)", internals.getArenaMount() !== null && internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "answer");

// ── catch-up after session switch: challenger finishes while away ────────
// main answers the business question -> the challenger is prompted
mainStore._set({
  chat: {
    order: [...mainStore.snapshot.chat.order, "ba1"],
    nodes: new Map([...mainStore.snapshot.chat.nodes, ["ba1", { key: "ba1", kind: "assistant-step", anchorSeq: 60, data: { status: "settled", blocks: [{ kind: "text", text: "business answer" }] } }]])
  },
  running: false
});
await sleep(20);
check("challenge prompt sent after main answer", internals.getArenaMount().challenge.phase === "challenge" && promptCalls.some((c) => c.sessionId === "arena-1" && c.content[0].text.includes("质疑")));
check("challenge prompt carries the main answer text", promptCalls.some((c) => c.sessionId === "arena-1" && c.content[0].text.includes("business answer")));
// switch away mid-challenge: the runtime tears down
currentSession = "s2";
listSub();
await sleep(80);
check("runtime torn down on switch away (catch-up test)", internals.getArenaMount() === null);
// the challenger finishes its challenge turn while the runtime is unmounted
const beforeCatchup = promptCalls.length;
arenaStore._set({
  chat: {
    order: [...arenaStore.snapshot.chat.order, "cv1"],
    nodes: new Map([...arenaStore.snapshot.chat.nodes, ["cv1", { key: "cv1", kind: "assistant-step", anchorSeq: 70, data: { status: "settled", turn: 9, step: 1, blocks: [{ kind: "text", text: "**质疑**：你的回答有漏洞 A" }] } }]])
  },
  running: false
});
await sleep(20);
check("no injection while the runtime is unmounted", promptCalls.length === beforeCatchup);
// return to the session: the poll catch-up must inject the conclusion
currentSession = "s1";
listSub();
await sleep(120);
check("catch-up injects the challenge conclusion on return", internals.getArenaMount() !== null && internals.getArenaMount().challenge.phase === "revise" && promptCalls.some((c) => c.sessionId === "s1" && c.content[0].text.includes("漏洞 A")));
// the injected conclusion lands -> main revises -> while away the revision
// finishes -> returning must advance to the FINAL round (injected-node anchor)
mainStore._set({
  chat: {
    order: [...mainStore.snapshot.chat.order, "inj-c", "br1"],
    nodes: new Map([...mainStore.snapshot.chat.nodes, ["inj-c", { key: "inj-c", kind: "user", anchorSeq: 80, data: { content: [{ type: "text", text: "质疑：你的回答有漏洞 A" }] } }], ["br1", { key: "br1", kind: "assistant-step", anchorSeq: 81, data: { status: "settled", blocks: [{ kind: "text", text: "修正后的回答" }] } }]])
  },
  running: false
});
await sleep(20);
currentSession = "s2";
listSub();
await sleep(80);
currentSession = "s1";
listSub();
await sleep(120);
check("catch-up advances to final after away-revision", internals.getArenaMount() !== null && internals.getArenaMount().challenge.phase === "final" && promptCalls.some((c) => c.sessionId === "arena-1" && c.content[0].text.includes("修正后")));

// ── main-model question mid-answer must NOT abort the challenge ───────────
// finish the pending final round first (challenger gives the verdict)
const beforeFinalPrompts = promptCalls.length;
arenaStore._set({
  chat: {
    order: [...arenaStore.snapshot.chat.order, "fv1"],
    nodes: new Map([...arenaStore.snapshot.chat.nodes, ["fv1", { key: "fv1", kind: "assistant-step", anchorSeq: 90, data: { status: "settled", turn: 11, step: 1, blocks: [{ kind: "text", text: "**质疑**：修正到位，结论成立" }] } }]])
  },
  running: false
});
await sleep(20);
check("final verdict injected (done)", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "done" && promptCalls.length > beforeFinalPrompts);

// ── re-entering a session whose arena round already ended: the progress
// header must stay hidden — the terminal challenge state survives the
// teardown/restore across a session switch and is never resurrected.
currentSession = "s2";
listSub();
await sleep(80);
currentSession = "s1";
listSub();
await sleep(120);
check("re-entering an ended arena session keeps the challenge done", internals.getArenaMount() !== null && internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "done");
check("re-entering an ended arena session hides the challenge header", loaded.shouldShowChallengeHeader(internals.getArenaMount()?.challenge) === false);

// ── clicking the COMPETITOR (arena) session: the selection guard bounces
// back to the main session, and an ended challenge never shows its header ──
currentSession = "arena-1";
listSub();
await sleep(120);
check("clicking the competitor session bounces back to the main session", currentSession === "s1");
check("clicking the competitor session restores the main runtime", internals.getArenaMount() !== null && internals.getArenaMount().sessionId === "s1");
check("ended challenge header stays hidden after the competitor click", internals.getArenaMount() !== null && loaded.shouldShowChallengeHeader(internals.getArenaMount().challenge) === false);
// a new question starts a fresh business round
mainStore._set({
  chat: {
    order: [...mainStore.snapshot.chat.order, "q3"],
    nodes: new Map([...mainStore.snapshot.chat.nodes, ["q3", { key: "q3", kind: "user", anchorSeq: 100, data: { content: [{ type: "text", text: "business question 2" }] } }]])
  },
  running: true
});
await sleep(20);
check("new round started (answer phase)", internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "answer");
// the main is answering (running) ...
mainStore._set({ chat: mainStore.snapshot.chat, running: true });
await sleep(10);
// ... then pauses to ask the user a question: running dips + a pending wait —
// this must NEVER count as "stopped without output" (answering would otherwise
// exit the arena mode and the challenger would never challenge)
mainStore._set({
  chat: mainStore.snapshot.chat,
  pending: [{ kind: "question", key: "q:3", sessionId: "s1", payload: { questions: [{ id: "qa3", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] }, respond: async () => {} }],
  running: false
});
await sleep(20);
check("question wait does not abort the challenge", internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "answer");
// user answers -> the main resumes -> completes the answer
mainStore._set({
  chat: mainStore.snapshot.chat,
  running: true
});
await sleep(10);
mainStore._set({
  chat: {
    order: [...mainStore.snapshot.chat.order, "ans3"],
    nodes: new Map([...mainStore.snapshot.chat.nodes, ["ans3", { key: "ans3", kind: "assistant-step", anchorSeq: 101, data: { status: "settled", turn: 2, step: 1, blocks: [{ kind: "text", text: "answer after the question" }] } }]])
  },
  running: false
});
await sleep(20);
check("challenger prompted to challenge after the question round", internals.getArenaMount().challenge.phase === "challenge" && promptCalls.some((c) => c.sessionId === "arena-1" && c.content[0].text.includes("逐条质疑")));
check("challenge prompt demands point-by-point review", promptCalls.some((c) => c.sessionId === "arena-1" && c.content[0].text.includes("逐点审查") && c.content[0].text.includes("每个观点")));

// ── stalled-start watchdog: the arena is prompted but never runs (a prompt
// that failed silently) — the round must end instead of leaving the header
// (and composer lock) up forever. Arm a stale stall timer and let the poll
// catch-up abort the challenge.
const stalledMount = internals.getArenaMount();
if (stalledMount !== null && stalledMount.challenge.active === true && stalledMount.challenge.phase === "challenge") {
  stalledMount.challenge.stallSince = Date.now() - (loaded.STALL_MS + 1000);
  listSub();
  await sleep(80);
  check("stalled arena round aborted by the watchdog", internals.getArenaMount() !== null && internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "aborted");
  check("stalled round hides the challenge header", loaded.shouldShowChallengeHeader(internals.getArenaMount()?.challenge) === false);
} else {
  check("stalled arena round aborted by the watchdog", false, "no in-flight arena-waiting challenge to stall");
}

// ── reload race: a full page reload drops the in-memory challenge state and
// the mount may scan an EMPTY snapshot (lastSeenSeq = 0) before the history
// loads. For a session that already has an arena link (a previous round ran),
// the late-arriving history must be consumed as pre-existing — never re-arm
// the finished round at the first step just because history finished loading.
{
  const m = internals.getArenaMount();
  const promptsBeforeReload = promptCalls.length;
  m.lastSeenSeq = 0;              // fresh mount scanned an empty snapshot
  m.challenge.active = false;     // the in-memory "done"/"aborted" was lost on reload
  m.challenge.phase = "idle";
  mainStore._set({
    chat: {
      order: ["h1", "h2"],
      nodes: new Map([
        ["h1", { key: "h1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "old question" }] } }],
        ["h2", { key: "h2", kind: "user", anchorSeq: 2, data: { content: [{ type: "text", text: "old followup" }] } }]
      ])
    },
    running: false
  });
  await sleep(20);
  check("reload race: late history not re-armed", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "idle");
  check("reload race: history never prompts the challenger", promptCalls.length === promptsBeforeReload);
  check("reload race: header stays hidden", loaded.shouldShowChallengeHeader(internals.getArenaMount().challenge) === false);
}

// ── cross-reload / restart survival: challenge persistence + restore ───────
// Pure projections first.
{
  const c = {
    active: true, phase: "challenge", scene: "business", skill: "/ws/s",
    userQuestion: "Q?", mainAnchor: "k1", arenaAnchor: "k2", rejectCount: 0,
    verdict: "", round: 2, pendingAnchor: true, lastPromptSent: "final",
    lastInjectedText: "x".repeat(5000),
    lastReviewSeq: -1, proposalPath: "/p.md", designPath: "/d.md", tasksPath: "/t.md",
    reviewPath: "/r.md", mainWasRunning: true, arenaWasRunning: true,
    stallSince: 12345, lastMainText: "LONG BODY", lastArenaText: "LONG BODY"
  };
  const p = loaded.toPersistedChallenge(c);
  check("toPersistedChallenge keeps the durable baseline fields", p.active === true && p.phase === "challenge" && p.scene === "business" && p.userQuestion === "Q?" && p.mainAnchor === "k1" && p.arenaAnchor === "k2" && p.round === 2 && p.pendingAnchor === false && p.lastReviewSeq === -1 && p.proposalPath === "/p.md");
  check("toPersistedChallenge persists the last-sent round prompt", p.lastPromptSent === "final");
  check("toPersistedChallenge truncates the injected text", p.lastInjectedText.length === 4000);
  check("toPersistedChallenge drops run-time bodies", !("lastMainText" in p) && !("lastArenaText" in p) && !("mainWasRunning" in p) && !("stallSince" in p));
  const back = loaded.fromPersistedChallenge(p);
  check("fromPersistedChallenge round-trips the baseline", back.phase === "challenge" && back.scene === "business" && back.mainAnchor === "k1" && back.arenaAnchor === "k2" && back.round === 2 && back.pendingAnchor === false && back.lastReviewSeq === -1 && back.proposalPath === "/p.md");
  check("fromPersistedChallenge round-trips the last-sent round prompt", back.lastPromptSent === "final");
  check("fromPersistedChallenge defaults lastPromptSent to empty", loaded.fromPersistedChallenge({ active: true, phase: "review", lastPromptSent: void 0 }).lastPromptSent === "");
  check("fromPersistedChallenge resets run-time fields + marks restored", back.mainWasRunning === false && back.arenaWasRunning === false && back.stallSince === 0 && back.restored === true && back.alignDone === false && back.challengerRePrompted === false);
  check("fromPersistedChallenge preserves terminal phases", loaded.fromPersistedChallenge({ active: false, phase: "aborted" }).phase === "aborted" && loaded.fromPersistedChallenge({ active: false, phase: "done" }).phase === "done");
  check("fromPersistedChallenge normalizes unknown phases", loaded.fromPersistedChallenge({ phase: "bogus" }).phase === "idle");
  check("isResumableChallenge: active in-flight only", loaded.isResumableChallenge({ active: true, phase: "review" }) === true && loaded.isResumableChallenge({ active: false, phase: "review" }) === false && loaded.isResumableChallenge({ active: true, phase: "done" }) === false && loaded.isResumableChallenge(null) === false);
  check("phase classifiers", loaded.isMainModelPhase("answer") === true && loaded.isMainModelPhase("revise") === true && loaded.isMainModelPhase("propose") === true && loaded.isMainModelPhase("challenge") === false && loaded.isChallengerPhase("challenge") === true && loaded.isChallengerPhase("final") === true && loaded.isChallengerPhase("review") === true && loaded.isTerminalPhase("done") === true && loaded.isTerminalPhase("aborted") === true);
  const idleSnap = { running: false, chat: { order: ["u1"], nodes: new Map([["u1", { kind: "user", data: {} }]]) } };
  const doneSnap = { running: false, chat: { order: ["u1", "a1"], nodes: new Map([["u1", { kind: "user", data: {} }], ["a1", { kind: "assistant", data: { blocks: [{ kind: "text", text: "x" }] } }]]) } };
  const runSnap = { running: true, chat: { order: ["u1"], nodes: new Map([["u1", { kind: "user", data: {} }]]) } };
  check("resolveMainResume three states", loaded.resolveMainResume(runSnap, { mainAnchor: null }) === "running" && loaded.resolveMainResume(doneSnap, { mainAnchor: null }) === "completed" && loaded.resolveMainResume(idleSnap, { mainAnchor: null }) === "waiting" && loaded.resolveMainResume(null, { mainAnchor: null }) === "waiting");
  check("resolveChallengerResume three states", loaded.resolveChallengerResume(runSnap, { arenaAnchor: null }) === "running" && loaded.resolveChallengerResume(doneSnap, { arenaAnchor: null }) === "completed" && loaded.resolveChallengerResume(idleSnap, { arenaAnchor: null }) === "stalled" && loaded.resolveChallengerResume(void 0, { arenaAnchor: null }) === "stalled");
}

// ── integration: a persisted mid-flight challenge restores and continues ──
// Simulates a page reload: the in-memory state is GONE (new session s3), the
// settings namespace holds the persisted challenge + link, and the arena
// runtime remounts from them.
{
  const ns = settingsNamespaces.find((n) => n.ns === "model-arena");
  const persistFor = (sessionId, challenge) => {
    ns.value = { ...(ns.value ?? {}), challenges: { ...(ns.value?.challenges ?? {}), [sessionId]: challenge } };
    settingsUpdatedHandler?.("model-arena");
  };
  const linkFor = (sessionId, scene, arenaId) => {
    ns.value = { ...(ns.value ?? {}), links: { ...(ns.value?.links ?? {}), [sessionId]: { sessionId: arenaId, provider: "p1", model: "m2", scene } } };
    settingsUpdatedHandler?.("model-arena");
  };
  const baseChallenge = (over) => ({
    active: true, phase: "answer", scene: "business", skill: "",
    userQuestion: "original question", mainAnchor: "", arenaAnchor: "",
    rejectCount: 0, verdict: "", round: 0, pendingAnchor: false,
    lastInjectedText: "", lastReviewSeq: -1,
    proposalPath: "", designPath: "", tasksPath: "", reviewPath: "",
    updatedAt: Date.now(), ...over
  });

  // 1) main-model phase restored while genuinely idle: composer UNLOCKED
  //    (the user must send "continue" to wake the main model up).
  linkFor("s3", "business", "arena-2");
  persistFor("s3", baseChallenge({ phase: "answer" }));
  currentSession = "s3";
  listSub();
  await sleep(120);
  const s3Mount = internals.getArenaMount();
  check("restored main-model phase keeps the baseline", s3Mount !== null && s3Mount.sessionId === "s3" && s3Mount.challenge.phase === "answer" && s3Mount.challenge.userQuestion === "original question" && s3Mount.challenge.restored === true && s3Mount.challenge.active === true);
  check("restored idle main-model phase does NOT lock the composer", blockCalls[blockCalls.length - 1].block === void 0);
  check("restored in-flight phase still shows the header", loaded.shouldShowChallengeHeader(s3Mount.challenge) === true);
  // user sends "continue" → the main model answers (platform) → the flow
  // advances to the challenger round; the original question is NOT replaced.
  const s3Store = sessionStores.get("s3");
  s3Store._set({ chat: { order: ["cu1"], nodes: new Map([["cu1", { key: "cu1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "继续" }] } }]]) } });
  await sleep(30);
  check("'continue' does not restart a fresh round", internals.getArenaMount().challenge.userQuestion === "original question" && internals.getArenaMount().challenge.round === 0);
  s3Store._set({ chat: { order: ["cu1", "ca1"], nodes: new Map([...s3Store.snapshot.chat.nodes, ["ca1", { key: "ca1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "resumed answer" }] } }]]) }, running: false });
  await sleep(20);
  const s3Dbg = internals.getArenaMount();
  check("resumed flow advances to the challenger after 'continue'", s3Dbg !== null && s3Dbg.challenge.phase === "challenge" && promptCalls.some((c) => c.sessionId === "arena-2" && c.content[0].text.includes("逐条质疑")), "phase=" + s3Dbg?.challenge?.phase + " prompts(arena-2)=" + promptCalls.filter((c) => c.sessionId === "arena-2").length);
  check("restored challenge persisted the advanced phase", ns.value?.challenges?.s3?.phase === "challenge", "persisted=" + ns.value?.challenges?.s3?.phase);

  // 2) challenger phase restored with the reply ALREADY landed: catch-up
  //    injects it — no duplicate round prompt. (arenaAnchor points at a node
  //    before the arena's existing assistant reply; arena-1 holds that history.)
  linkFor("s4", "business", "arena-1");
  persistFor("s4", baseChallenge({ phase: "challenge", scene: "business", arenaAnchor: "au1", round: 1, lastInjectedText: "" }));
  currentSession = "s4";
  listSub();
  await sleep(120);
  const s4Mount = internals.getArenaMount();
  const promptsBeforeS4 = promptCalls.filter((c) => c.sessionId === "arena-1").length;
  check("restored challenger phase with a landed reply catches up", s4Mount !== null && s4Mount.challenge.phase === "revise");
  check("no duplicate challenger prompt when the reply already landed", promptCalls.filter((c) => c.sessionId === "arena-1").length === promptsBeforeS4);
  check("caught-up challenge injects the revision instruction", promptCalls.some((c) => c.sessionId === "s4" && c.content[0].text.trim() !== ""));

  // 3) challenger phase restored with NO reply: the round prompt is
  //    re-injected immediately ("切到竞技场会话时立即 review/终审") — but
  //    only ONCE per restore (a fresh arena session stays empty, so every
  //    sync tick must not keep appending the instruction).
  linkFor("s5", "knowledge", "arena-3");
  persistFor("s5", baseChallenge({ phase: "review", scene: "knowledge", arenaAnchor: "", lastReviewSeq: -1 }));
  currentSession = "s5";
  listSub();
  await sleep(120);
  const s5Mount = internals.getArenaMount();
  const s5Prompts = promptCalls.filter((c) => c.sessionId === "arena-3" && c.content[0].text.includes("审查"));
  check("restored challenger phase re-injects the review prompt once", s5Mount !== null && s5Mount.challenge.active === true && s5Prompts.length === 1);
  listSub();
  await sleep(120);
  check("challenger prompt is NOT duplicated across sync ticks", promptCalls.filter((c) => c.sessionId === "arena-3" && c.content[0].text.includes("审查")).length === 1);

  // 3b) REGRESSION (duplicate-final / revise-final-revise-final): a FINAL
  //     round whose verdict prompt was ALREADY sent (persisted
  //     lastPromptSent="final") must NOT re-inject the verdict on reload —
  //     the arena session holds the prompt server-side, so a reload must wait
  //     for the challenger, not hand it a duplicate终评 instruction.
  linkFor("s14", "business", "arena-11");
  persistFor("s14", baseChallenge({ phase: "final", scene: "business", arenaAnchor: "", lastPromptSent: "final" }));
  currentSession = "s14";
  listSub();
  await sleep(120);
  const s14Mount = internals.getArenaMount();
  check("final round with prompt already sent: phase stays final on reload", s14Mount !== null && s14Mount.challenge.active === true && s14Mount.challenge.phase === "final", "phase=" + s14Mount?.challenge?.phase + " active=" + s14Mount?.challenge?.active);
  check("final round with prompt already sent: verdict NOT re-injected on reload", !promptCalls.some((c) => c.sessionId === "arena-11" && c.content[0].text.includes("最终评审结论")));

  // 4) terminal persisted challenge (aborted): no resurrection, and the
  //    Theseus bridge is NOT re-armed for it.
  const mutatesBeforeS6 = settingsMutateCalls.length;
  linkFor("s6", "knowledge", "arena-2");
  persistFor("s6", baseChallenge({ active: false, phase: "aborted", scene: "knowledge" }));
  currentSession = "s6";
  listSub();
  await sleep(120);
  const s6Mount = internals.getArenaMount();
  check("aborted persisted challenge stays terminal after reload", s6Mount !== null && s6Mount.challenge.active === false && s6Mount.challenge.phase === "aborted" && loaded.shouldShowChallengeHeader(s6Mount.challenge) === false);
  check("aborted challenge does NOT re-arm the Theseus bridge", !settingsMutateCalls.slice(mutatesBeforeS6).some((m) => m.ops?.some((o) => o.path?.[0] === "arena" && o.path?.[1] === "mainSessionId" && o.value === "s6")));

  // 5) REPRODUCTION: knowledge propose 阶段刷新——主模型生成中刷新页面，
  //    刷新后主模型继续生成（propose.completed），node 半段写 reviewRequest，
  //    浏览器端必须消费并推进到 review（挑战者审查）。这是用户报告的
  //    「刷新后继续生成，但不走 review 了」场景。
  linkFor("s7", "knowledge", "arena-4");
  persistFor("s7", baseChallenge({ phase: "propose", scene: "knowledge", lastReviewSeq: -1, mainAnchor: "", arenaAnchor: "" }));
  // 隔离：propose 阶段刷新时 settings 里不应有旧 reviewRequest（node 半段
  // 还没检测到 propose.completed）——清掉前面测试残留的全局 latestReviewRequest。
  ns.value = { ...(ns.value ?? {}), arena: { ...(ns.value?.arena ?? {}), reviewRequest: null } };
  settingsUpdatedHandler?.("model-arena");
  currentSession = "s7";
  listSub();
  await sleep(120);
  const s7Mount = internals.getArenaMount();
  check("propose 刷新恢复基线", s7Mount !== null && s7Mount.challenge.phase === "propose" && s7Mount.challenge.active === true && s7Mount.challenge.scene === "knowledge", "phase=" + s7Mount?.challenge?.phase + " active=" + s7Mount?.challenge?.active + " scene=" + s7Mount?.challenge?.scene);
  // 主模型在服务端继续生成：快照显示 running（回合在跑）
  const s7Store = sessionStores.get("s7");
  s7Store._set({ chat: { order: ["kq1"], nodes: new Map([["kq1", { key: "kq1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } }]]) }, running: true });
  await sleep(30);
  // node 半段观察到 propose.completed 后写 reviewRequest
  fireReviewRequest({ workflowId: "wf7", seq: 1, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
  await sleep(50);
  const s7After = internals.getArenaMount();
  check("propose 刷新后 reviewRequest 到达 → 推进 review", s7After !== null && s7After.challenge.phase === "review", "phase=" + s7After?.challenge?.phase + " active=" + s7After?.challenge?.active);
  check("review 推进后挑战者被 prompt 审查", promptCalls.some((c) => c.sessionId === "arena-4" && c.content[0].text.includes("审查") && c.content[0].text.includes("proposal.md")));

  // 6) REPRODUCTION: business answer 阶段刷新——主模型回答中刷新页面，
  //    后端会话不断、回合继续跑完；刷新后必须自动推进到挑战者质疑轮
  //    （"不走 review" 的业务探索对应版）。
  linkFor("s8", "business", "arena-5");
  persistFor("s8", baseChallenge({ phase: "answer", scene: "business", mainAnchor: "", arenaAnchor: "" }));
  currentSession = "s8";
  listSub();
  await sleep(120);
  const s8Mount = internals.getArenaMount();
  check("business answer 刷新恢复基线", s8Mount !== null && s8Mount.challenge.phase === "answer" && s8Mount.challenge.active === true, "phase=" + s8Mount?.challenge?.phase + " active=" + s8Mount?.challenge?.active);
  // 后端继续生成并完成回答（刷新时快照为空 → 恢复为 waiting；回答节点落地后
  // 订阅回调/对齐必须把流程推进到 challenge 轮）
  const s8Store = sessionStores.get("s8");
  s8Store._set({ chat: { order: ["bu1", "ba1"], nodes: new Map([
    ["bu1", { key: "bu1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } }],
    ["ba1", { key: "ba1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "回答" }] } }]
  ]) }, running: false });
  await sleep(50);
  const s8After = internals.getArenaMount();
  check("business answer 刷新后回答完成 → 推进质疑轮", s8After !== null && s8After.challenge.phase === "challenge", "phase=" + s8After?.challenge?.phase);
  check("推进后挑战者被 prompt 质疑", promptCalls.some((c) => c.sessionId === "arena-5" && c.content[0].text.includes("逐条质疑")));

  // 7) HYPOTHESIS CHECK → F2: persistChallenge 写失败/未触发（settings 无
  //    challenges 记录）但主会话已有首问 → 刷新后必须从快照推断恢复
  //    （propose/answer + active），否则流程静默（idle 兜底不消费
  //    reviewRequest → "不走 review"）。
  linkFor("s9", "knowledge", "arena-6");
  currentSession = "s9";
  listSub();
  await sleep(120);
  const s9Mount0 = internals.getArenaMount();
  check("无持久化且无首问 → 维持 idle 兜底", s9Mount0 !== null && s9Mount0.challenge.phase === "idle" && s9Mount0.challenge.active === false, "phase=" + s9Mount0?.challenge?.phase);
  // 主会话快照出现首问（历史异步加载完成 / 用户已发过话）
  const s9Store = sessionStores.get("s9");
  s9Store._set({ chat: { order: ["kq9"], nodes: new Map([["kq9", { key: "kq9", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "原始问题" }] } }]]) } });
  listSub();
  await sleep(60);
  const s9Mount1 = internals.getArenaMount();
  check("无持久化但有首问 → 推断恢复 propose（active）", s9Mount1 !== null && s9Mount1.challenge.phase === "propose" && s9Mount1.challenge.active === true && s9Mount1.challenge.userQuestion === "原始问题", "phase=" + s9Mount1?.challenge?.phase + " active=" + s9Mount1?.challenge?.active + " q=" + s9Mount1?.challenge?.userQuestion);
  // 主模型继续生成（后端 Theseus 继续）→ propose.completed → node 半段写 reviewRequest
  fireReviewRequest({ workflowId: "wf9", seq: 1, proposalPath: "/ws1/openspec/changes/x/proposal.md", designPath: "/ws1/openspec/changes/x/design.md", tasksPath: "/ws1/openspec/changes/x/tasks.md", reviewPath: "/ws1/openspec/changes/x/review.md" });
  await sleep(50);
  const s9After = internals.getArenaMount();
  check("推断恢复后 reviewRequest 到达 → 推进 review", s9After !== null && s9After.challenge.phase === "review", "phase=" + s9After?.challenge?.phase);
  check("推断恢复后挑战者被 prompt 审查", promptCalls.some((c) => c.sessionId === "arena-6" && c.content[0].text.includes("审查") && c.content[0].text.includes("proposal.md")));
  // F3: 消费 reviewRequest 后 settings 残留被清（防跨会话误消费）
  check("F3: 消费后 settings.arena.reviewRequest 被清", ns.value?.arena?.reviewRequest === null);

  // 8) COMPOSER STOP vs HEADER STOP: 主模型轮（answer）生成中，用户点击
  //    主会话 composer 的停止按钮（平台 cancel 只停主会话）→ 看门狗必须
  //    abortChallenge（同时 cancel 挑战者 + 结束流程），与 header 停止一致。
  linkFor("s10", "business", "arena-7");
  persistFor("s10", baseChallenge({ phase: "answer", scene: "business", mainAnchor: "", arenaAnchor: "" }));
  currentSession = "s10";
  listSub();
  await sleep(120);
  const s10Store = sessionStores.get("s10");
  // 主模型生成中（running）
  s10Store._set({ chat: { order: ["st1"], nodes: new Map([["st1", { key: "st1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } }]]) }, running: true });
  await sleep(30);
  const cancelBefore = cancelCalls.length;
  // 用户点击 composer 停止：主会话 cancel → 快照 running→idle 且无新节点
  s10Store._set({ chat: s10Store.snapshot.chat, running: false });
  await sleep(30);
  const afterStop = internals.getArenaMount();
  check("composer 停止主模型 → 看门狗触发 abortChallenge（停两者）", afterStop !== null && afterStop.challenge.active === false && afterStop.challenge.phase === "aborted", "phase=" + afterStop?.challenge?.phase + " active=" + afterStop?.challenge?.active);
  check("composer 停止后挑战者会话被 cancel", cancelCalls.includes("arena-7"), "cancelled=" + cancelCalls.slice(cancelBefore).join(","));

  // 9) the challenge-status header component stays registered (stage strip +
  //    stop button); the header challenger spinner was REMOVED per user feedback
  //    (the sidebar row dot is the only challenger loading indicator now).
  const headerEntry = slotRegisterCalls.find((c) => c.name === "conversation.session.header.actions" && c.id === "challenge-status");
  check("challenge-status header component registered", headerEntry !== void 0 && typeof headerEntry.component === "function");
  const findInVNode = (node, pred) => {
    if (node === null || node === void 0 || typeof node !== "object") return null;
    if (pred(node)) return node;
    const kids = Array.isArray(node.props?.children) ? node.props.children : (node.props?.children === void 0 ? [] : [node.props.children]);
    for (const kid of kids) {
      const hit = findInVNode(kid, pred);
      if (hit !== null) return hit;
    }
    return null;
  };
  // switch back to the restored review-phase session (s5: active, phase=review)
  currentSession = "s5";
  listSub();
  await sleep(120);
  const s5Now = internals.getArenaMount();
  check("header fixture: review-phase session active", s5Now !== null && s5Now.challenge.active === true && s5Now.challenge.phase === "review", "phase=" + s5Now?.challenge?.phase + " active=" + s5Now?.challenge?.active);
  const arena3Store = sessionStores.get("arena-3");
  // the header NEVER renders a challenger spinner now, whatever the arena state
  arena3Store._set({ chat: arena3Store.snapshot.chat, running: true });
  check("header has no challenger spinner (removed)", findInVNode(headerEntry.component({ sessionId: "s5" }), (n) => n.props?.["data-challenge-spinner"] !== void 0) === null);
  arena3Store._set({ chat: arena3Store.snapshot.chat, running: false });

  // 10) challenger loading dot in the SIDEBAR session row: the ARENA MAIN
  //     session's row shows the loading dot while a challenger round is active
  //     AND its arena session is running — like the main model's own running
  //     dot. The dot is located on the main session's row via the sessions-list
  //     displayTitle (falling back to the selected row) and STAYS there even
  //     when that session is not the current selection — a challenger running
  //     via the background advance keeps its indicator visible on switch-away.
  //     Mark the normal row as the selected/current row (the real workspace
  //     browser marks the current session with YDXeBa_selected). Use a FRESH
  //     review-phase session (s5 above ended aborted by the watchdog's
  //     running→idle-without-reply stop detection).
  normalRow.className = "YDXeBa_sessionRow YDXeBa_selected";
  linkFor("s11", "knowledge", "arena-8");
  persistFor("s11", baseChallenge({ phase: "review", scene: "knowledge", arenaAnchor: "", lastReviewSeq: 1 }));
  // 让 sessions-list 的 displayTitle 与 normalRow 的标题 span 一致，验证按标题定位主会话行
  byIdMock.s11 = { displayTitle: "普通会话" };
  currentSession = "s11";
  listSub();
  await sleep(120);
  const s11Mount = internals.getArenaMount();
  check("sidebar fixture: review-phase session active", s11Mount !== null && s11Mount.challenge.active === true && s11Mount.challenge.phase === "review", "phase=" + s11Mount?.challenge?.phase + " active=" + s11Mount?.challenge?.active);
  const arena8Store = sessionStores.get("arena-8");
  const sidebarDotIn = (node) => findInTree(node, byClass("ma-sidebarLoading")) !== null;
  // challenger idle → no sidebar loading dot
  arena8Store._set({ chat: arena8Store.snapshot.chat, running: false });
  listSub();
  await sleep(60);
  check("sidebar: challenger idle → no loading dot", !sidebarDotIn(normalRow));
  // challenger running → sidebar loading dot appears on the main session's row
  // (keep running — dropping it without a reply would abort the round)
  arena8Store._set({ chat: arena8Store.snapshot.chat, running: true });
  await sleep(60);
  check("sidebar: challenger running → loading dot on the main row", sidebarDotIn(normalRow));
  // switch-away: the main session is no longer the current one, but the dot
  // STAYS on its row — the challenger is still running (background advance)
  normalRow.className = "YDXeBa_sessionRow";
  listSub();
  await sleep(60);
  check("sidebar: dot stays on the main row when deselected (background challenger running)", sidebarDotIn(normalRow));
  // re-select the row while the challenger is still running → the dot remains
  normalRow.className = "YDXeBa_sessionRow YDXeBa_selected";
  listSub();
  await sleep(60);
  check("sidebar: dot remains when the row is reselected", sidebarDotIn(normalRow));
  // challenger replies (NEEDS_REVISION) → the round advances to revise and the
  // dot is removed (main-model phase — the platform's own dot covers it)
  arena8Store._set({
    chat: {
      order: ["rv-a"],
      nodes: new Map([["rv-a", { key: "rv-a", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "**Overall Verdict**: NEEDS_REVISION\nAction Items: fix" }] } }]])
    },
    running: false
  });
  await sleep(60);
  check("sidebar: challenger replied → dot removed (revise phase)", !sidebarDotIn(normalRow) && internals.getArenaMount().challenge.phase === "revise", "phase=" + internals.getArenaMount()?.challenge?.phase);
  normalRow.className = "YDXeBa_sessionRow";
  delete byIdMock.s11;

  // 10b) REGRESSION: the sidebar dot must land on the RUNNING challenger's
  //      main-session row, not on an earlier linked session whose duel already
  //      ended. linksCache holds one link per duel; the first key in iteration
  //      order used to win the displayTitle match and grab the dot even though
  //      its challenger was long done. Two links, the ended one FIRST, prove
  //      the indicator follows the running challenger — not key order.
  linkFor("sEnded", "business", "arena-ended");
  persistFor("sEnded", baseChallenge({ phase: "done", active: false }));
  byIdMock.sEnded = { displayTitle: "已结束会话" };
  linkFor("sRun", "knowledge", "arena-run");
  persistFor("sRun", baseChallenge({ phase: "review", scene: "knowledge", arenaAnchor: "", lastReviewSeq: 1 }));
  byIdMock.sRun = { displayTitle: "普通会话" };
  // current session stays s11 (its round already moved to a main-model phase),
  // so both sEnded and sRun read the persisted baseline; only sRun's challenger runs.
  const arenaRunStore = sessionStores.get("arena-run") ?? makeSessionStore("arena-run", { chat: emptyChat, running: false });
  arenaRunStore._set({ chat: emptyChat, running: true });
  listSub();
  await sleep(120);
  check("sidebar: dot on the RUNNING challenger's row, not the ended duel's row", sidebarDotIn(normalRow) && !sidebarDotIn(endedRow));
  // clean up: idle the challenger, drop the temp titles
  arenaRunStore._set({ chat: emptyChat, running: false });
  await sleep(60);
  delete byIdMock.sEnded;
  delete byIdMock.sRun;

  // 11) background advance (opt-in via settings.backgroundAdvance, default OFF):
  //     a duel whose MAIN session is not the current one advances from its
  //     persisted baseline — finished main turn prompts the challenger, finished
  //     challenger reply is injected into the main session. OFF → no-op.
  // switch OFF → advanceBackgroundDuels is a no-op
  const bgPromptsBefore = promptCalls.length;
  internals.advanceBackgroundDuels();
  check("background advance: switch off → no-op", promptCalls.length === bgPromptsBefore);
  // enable the switch via settings
  ns.value = { ...(ns.value ?? {}), backgroundAdvance: true };
  settingsUpdatedHandler?.("model-arena");
  await sleep(40);
  // fixture: s12 (business answer, active) linked to arena-9, NOT the current session
  linkFor("s12", "business", "arena-9");
  persistFor("s12", baseChallenge({ phase: "answer", scene: "business", mainAnchor: "", arenaAnchor: "" }));
  await sleep(40);
  const s12Store = sessionStores.get("s12") ?? makeSessionStore("s12", { chat: { order: [], nodes: new Map() } });
  s12Store._set({ chat: { order: ["bgq1", "bga1"], nodes: new Map([
    ["bgq1", { key: "bgq1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } }],
    ["bga1", { key: "bga1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "回答" }] } }]
  ]) }, running: false });
  internals.advanceBackgroundDuels();
  check("background: main finished → challenger prompted", promptCalls.some((c) => c.sessionId === "arena-9" && c.content[0].text.includes("逐条质疑")));
  check("background: persisted phase advanced to challenge", ns.value?.challenges?.s12?.phase === "challenge", "phase=" + ns.value?.challenges?.s12?.phase);
  // challenger replies → background injects into the main session
  const arena9Store = sessionStores.get("arena-9");
  arena9Store._set({ chat: { order: ["bgr1"], nodes: new Map([["bgr1", { key: "bgr1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "质疑：这里有问题" }] } }]]) }, running: false });
  internals.advanceBackgroundDuels();
  check("background: challenger reply → injected into main + revise", promptCalls.some((c) => c.sessionId === "s12" && c.content[0].text.includes("质疑")) && ns.value?.challenges?.s12?.phase === "revise", "phase=" + ns.value?.challenges?.s12?.phase);
  // PENDING-ANCHOR 残留回归：后台推进 challenge→revise 置 pendingAnchor=true；
  // 主模型修正完成后后台 revise→final 必须清掉（前台 advanceChallenge 在 revise
  // 分支重锚时清除，后台 main 分支此前直接改 phase 不清 → done 态残留 true，
  // 真实数据曾出现 pendingAnchor:true + phase:done）。
  check("background: revise→final 时 challenge 处于 pendingAnchor 状态", ns.value?.challenges?.s12?.pendingAnchor === true, "pendingAnchor=" + ns.value?.challenges?.s12?.pendingAnchor);
  s12Store._set({
    chat: {
      order: ["bgq1", "bga1", "bginj", "bgm2"],
      nodes: new Map([
        ["bgq1", { key: "bgq1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } }],
        ["bga1", { key: "bga1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "回答" }] } }],
        ["bginj", { key: "bginj", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "质疑：这里有问题" }] } }],
        ["bgm2", { key: "bgm2", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", turn: 2, step: 1, blocks: [{ kind: "text", text: "修正后回答" }] } }]
      ])
    },
    running: false
  });
  internals.advanceBackgroundDuels();
  check("background: 主模型修正完成 → revise→final 并清除 pendingAnchor", ns.value?.challenges?.s12?.phase === "final" && ns.value?.challenges?.s12?.pendingAnchor === false, "phase=" + ns.value?.challenges?.s12?.phase + " pendingAnchor=" + ns.value?.challenges?.s12?.pendingAnchor);
  // 写入归一化防御：即使内存态残留，非 answer/revise 阶段的持久化投影也强制为 false
  const normalizedP = loaded.toPersistedChallenge({ active: true, phase: "done", pendingAnchor: true });
  check("toPersistedChallenge 归一化：done 态 pendingAnchor 强制 false", normalizedP.pendingAnchor === false);
  check("toPersistedChallenge 保留：revise 态 pendingAnchor 为 true", loaded.toPersistedChallenge({ active: true, phase: "revise", pendingAnchor: true }).pendingAnchor === true);
  // current session is skipped (the runtime handles it)
  linkFor("s13", "business", "arena-10");
  persistFor("s13", baseChallenge({ phase: "answer", scene: "business" }));
  currentSession = "s13";
  listSub();
  await sleep(120);
  const s13Store = sessionStores.get("s13");
  s13Store._set({ chat: { order: ["cur1"], nodes: new Map([["cur1", { key: "cur1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "q" }] } }]]) }, running: false });
  const promptsBeforeCur = promptCalls.filter((c) => c.sessionId === "arena-10").length;
  internals.advanceBackgroundDuels();
  check("background: current session is skipped", promptCalls.filter((c) => c.sessionId === "arena-10").length === promptsBeforeCur);

  // 11b) REGRESSION (dual-write / duplicate-final): a duel that was MOUNTED
  //      (teardown stashed an in-memory answer-phase challenge), then advanced
  //      in the background (answer→challenge), must NOT re-advance on return.
  //      The background advance must sync the stashed in-memory challenge;
  //      otherwise returning re-mounts the stale phase and advanceChallenge
  //      re-prompts the challenger — the duplicate-final mechanism.
  linkFor("s15", "business", "arena-12");
  persistFor("s15", baseChallenge({ phase: "answer", scene: "business", mainAnchor: "", arenaAnchor: "" }));
  currentSession = "s15";
  listSub();
  await sleep(120); // mount: in-memory state.challenge = answer (empty snapshot → waiting)
  const s15Store = sessionStores.get("s15");
  // switch away WITHOUT the main turn finishing: teardown stashes the answer
  // phase; the main turn then completes while s15 is NOT the current session.
  currentSession = "s13";
  listSub();
  await sleep(120);
  s15Store._set({ chat: { order: ["d1", "d2"], nodes: new Map([
    ["d1", { key: "d1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } }],
    ["d2", { key: "d2", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "回答" }] } }]
  ]) }, running: false });
  internals.advanceBackgroundDuels();
  check("background advance syncs the stashed in-memory challenge", ns.value?.challenges?.s15?.phase === "challenge", "phase=" + ns.value?.challenges?.s15?.phase);
  // return: must resume the ADVANCED phase, not re-advance answer→challenge
  const bgPromptsArena12After = promptCalls.filter((c) => c.sessionId === "arena-12" && c.content[0].text.includes("逐条质疑")).length;
  currentSession = "s15";
  listSub();
  await sleep(150);
  const s15Mount = internals.getArenaMount();
  check("return after background advance resumes the advanced phase", s15Mount !== null && s15Mount.challenge.phase === "challenge", "phase=" + s15Mount?.challenge?.phase + " active=" + s15Mount?.challenge?.active);
  check("return after background advance does NOT re-prompt the challenger", promptCalls.filter((c) => c.sessionId === "arena-12" && c.content[0].text.includes("逐条质疑")).length === bgPromptsArena12After, "arena-12 prompts=" + promptCalls.filter((c) => c.sessionId === "arena-12" && c.content[0].text.includes("逐条质疑")).length);
  // cleanup: disable the switch
  ns.value = { ...(ns.value ?? {}), backgroundAdvance: false };
  settingsUpdatedHandler?.("model-arena");
  await sleep(40);
}

// ── REPRO: P1-1 首问后、竞技场会话创建完成前切走 → 挑战永久丢失 ──
// startChallenge 的 active/phase/mainAnchor/persistChallenge 全部在
// ensure.then()（创建竞技场会话之后）设置，then 开头守卫
// `if (arenaMount === null || arenaMount.sessionId !== sessionId) return;`。
// 若用户在创建窗口内切走：then 直接 return，active 永不置位；teardown stash
// 的是 idle 的 challenge，切回时 syncArena 恢复链 `state.challenge ?? …` 被
// 这个 idle 对象短路，inferRestoredChallenge 不执行；lastSeenSeq 已越过首问，
// detectUserMessages 不重触发 → 挑战永远不开始。
// 注意：以下为「已知缺陷复现」——当前代码下预期 FAIL（rcheck 不计数，
// 不影响主套件退出码）；修复后应转为 PASS。另：mock 的 MutationObserver 是
// 空实现，复现段须手动 listSub() 触发 sync（与现有测试同模式）。
const rcheck = (label, cond, detail) => {
  if (cond) console.log("  ok  [REPRO] " + label);
  else console.log(" KNOWN-FAIL [REPRO] " + label + (detail !== void 0 && detail !== "" ? "  -> " + detail : ""));
};
{
  const origSnap = snap;
  const origCreate = mockCtx.sessions.create;
  try {
    snap = twoModelDir; // 两模型 → auto 派生补集，省去手动选模型
    snapSub();
    currentSession = "s16";
    listSub();
    await sleep(150);
    // 启用竞技场（新会话默认关闭）
    const s16Toggle = heroRow.children.find((child) => child.dataset.arenaToggle !== void 0);
    click(s16Toggle);
    listSub(); // mock 的 MutationObserver 为空实现，须手动触发 sync
    await sleep(150);
    if (internals.getArenaMount() === null || internals.getArenaMount().sessionId !== "s16") {
      rcheck("REPRO P1-1: 前置条件——竞技场运行时已挂载 s16", false, "mount=" + internals.getArenaMount()?.sessionId + " error=" + internals.getArenaMount()?.error + " toggles=" + heroRow.children.filter((c) => c.dataset?.arenaToggle !== void 0).length);
    } else {
      // 挂起 create：模拟创建竞技场会话的耗时窗口。create 至多被调用一次
      // （修复后的 ensureArenaSession 幂等 + 在途复用）；若修复回退导致第二
      // 次 create，立即 resolve 一个不同的 id——断言会 fail 而不是挂起。
      let createCount = 0;
      let releaseCreate = null;
      mockCtx.sessions.create = async () => {
        createCount += 1;
        if (createCount === 1) return new Promise((res) => { releaseCreate = res; });
        return Promise.resolve("arena-repro-2");
      };
      const s16Store = sessionStores.get("s16") ?? makeSessionStore("s16", { chat: { order: [], nodes: new Map() } });
      // 首问落地
      s16Store._set({
        chat: { order: ["pq1"], nodes: new Map([["pq1", { key: "pq1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "首问" }] } }]]) },
        running: true
      });
      await sleep(30);
      // 窗口内切走（create 尚未完成）
      currentSession = "s13";
      listSub();
      await sleep(80);
      // 创建完成（但 arenaMount 已为 null——修复后 id 先记录、只跳过挂载）
      releaseCreate("arena-repro");
      await sleep(50);
      // 切回：应恢复/启动挑战
      currentSession = "s16";
      listSub();
      await sleep(150);
      const p1repro = internals.getArenaMount();
      rcheck("REPRO P1-1: 切回后挑战被启动（active）", p1repro !== null && p1repro.challenge.active === true && p1repro.challenge.phase === "answer", "active=" + p1repro?.challenge?.active + " phase=" + p1repro?.challenge?.phase);
      rcheck("REPRO P1-1: 竞技场会话复用第一次创建的 id（无孤儿）", p1repro !== null && p1repro.arenaSessionId === "arena-repro", "arenaId=" + p1repro?.arenaSessionId + " createCount=" + createCount);
      rcheck("REPRO P1-1: create 只发生一次（无重复创建）", createCount === 1, "createCount=" + createCount);
      rcheck("REPRO P1-1: 切回后主模型回答完成仍推进", (() => {
        if (internals.getArenaMount() === null || internals.getArenaMount().challenge.active !== true) return false;
        s16Store._set({
          chat: { order: ["pq1", "pa1"], nodes: new Map([...s16Store.snapshot.chat.nodes, ["pa1", { key: "pa1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "回答" }] } }]]) },
          running: false
        });
        return true;
      })());
      await sleep(40);
      rcheck("REPRO P1-1: 主模型回答后推进到质疑轮", internals.getArenaMount() !== null && internals.getArenaMount().challenge.phase === "challenge", "phase=" + internals.getArenaMount()?.challenge?.phase);
    }
  } finally {
    mockCtx.sessions.create = origCreate;
    snap = origSnap;
    currentSession = "s1";
    listSub();
    await sleep(80);
  }
}

// ── 质量断言：challenge prompt 的产出材料质量（不改业务代码，纯断言锁定）──
// 真实平台一次回合 = 单 assistant-step 节点多 block（P0-3 平台确认），此处
// 断言传入挑战者的材料质量：完整正文（多 text block 聚合）、思维链排除
// （settings.note 注入边界）、工具操作记录携带、首问文件引用入清单（P1-2）。
{
  const origSnap = snap;
  try {
    snap = twoModelDir;
    let ns = settingsNamespaces.find((n) => n.ns === "model-arena");
    if (ns === void 0) { ns = { ns: "model-arena", value: {} }; settingsNamespaces.push(ns); }
    ns.value = { ...(ns.value ?? {}),
      links: { ...(ns.value?.links ?? {}), s19: { sessionId: "arena-19", provider: "p1", model: "m2", scene: "business" } },
      challenges: { ...(ns.value?.challenges ?? {}), s19: { active: true, phase: "answer", scene: "business", skill: "", userQuestion: "请审查 docs/plan.md 的方案", mainAnchor: "", arenaAnchor: "", rejectCount: 0, verdict: "", round: 0, pendingAnchor: false, lastPromptSent: "", lastInjectedText: "", lastReviewSeq: -1, proposalPath: "", designPath: "", tasksPath: "", reviewPath: "", updatedAt: Date.now() } }
    };
    settingsUpdatedHandler?.("model-arena");
    currentSession = "s19";
    listSub();
    await sleep(120);
    const s19Store = sessionStores.get("s19") ?? makeSessionStore("s19", { chat: { order: [], nodes: new Map() } });
    sessionStores.get("arena-19") ?? makeSessionStore("arena-19", { chat: { order: [], nodes: new Map() } });
    // 主模型单节点多 block 回合：reasoning（思维链）+ text×2 + tool-call
    s19Store._set({
      chat: {
        order: ["uq1", "a1"],
        nodes: new Map([
          ["uq1", { key: "uq1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "请审查 docs/plan.md 的方案" }] } }],
          ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [
            { kind: "reasoning", text: "这是主模型的思维链，不应注入" },
            { kind: "text", text: "方案正文第一段" },
            { kind: "tool-call", callId: "c1", name: "read", argsRaw: JSON.stringify({ description: "读取方案文件", path: "docs/plan.md" }) },
            { kind: "text", text: "方案正文第二段" }
          ] } }]
        ])
      },
      running: false
    });
    await sleep(40);
    const s19Prompts = promptCalls.filter((c) => c.sessionId === "arena-19" && c.content[0].text.includes("质疑"));
    const s19Prompt = s19Prompts[0]?.content?.[0]?.text ?? "";
    check("质量: challenge prompt 携带完整正文（单节点多 text block 聚合）", s19Prompt.includes("方案正文第一段") && s19Prompt.includes("方案正文第二段"), "prompt=" + s19Prompt.slice(0, 80));
    check("质量: challenge prompt 不含思维链（reasoning 排除）", !s19Prompt.includes("思维链"));
    check("质量: challenge prompt 含工具操作记录（tool-call 携带）", s19Prompt.includes("工具操作记录") && s19Prompt.includes("read"));
    check("质量: challenge prompt 首问引用进提到的文件清单（P1-2）", s19Prompt.includes("提到的文件：docs/plan.md"));
  } finally {
    snap = origSnap;
    currentSession = "s1";
    listSub();
    await sleep(80);
  }
}

// ── knowledge 质量断言（流程级）：思维链不进 review prompt（settings.note 注入边界）──
// 主模型产出阶段（propose）回答含 reasoning + text 单节点多 block；node 半段写
// reviewRequest → 挑战者审查 prompt 应含方案正文、不含思维链。
{
  const origSnap = snap;
  try {
    snap = twoModelDir;
    let ns = settingsNamespaces.find((n) => n.ns === "model-arena");
    if (ns === void 0) { ns = { ns: "model-arena", value: {} }; settingsNamespaces.push(ns); }
    ns.value = { ...(ns.value ?? {}),
      links: { ...(ns.value?.links ?? {}), s20: { sessionId: "arena-20", provider: "p1", model: "m2", scene: "knowledge" } },
      challenges: { ...(ns.value?.challenges ?? {}), s20: { active: true, phase: "propose", scene: "knowledge", skill: "", userQuestion: "沉淀知识", mainAnchor: "", arenaAnchor: "", rejectCount: 0, verdict: "", round: 0, pendingAnchor: false, lastPromptSent: "", lastInjectedText: "", lastReviewSeq: -1, proposalPath: "", designPath: "", tasksPath: "", reviewPath: "", updatedAt: Date.now() } },
      arena: { ...(ns.value?.arena ?? {}), reviewRequest: null }
    };
    settingsUpdatedHandler?.("model-arena");
    currentSession = "s20";
    listSub();
    await sleep(120);
    const s20Store = sessionStores.get("s20") ?? makeSessionStore("s20", { chat: { order: [], nodes: new Map() } });
    sessionStores.get("arena-20") ?? makeSessionStore("arena-20", { chat: { order: [], nodes: new Map() } });
    // 主模型产出：reasoning（思维链）+ text（方案）单节点多 block
    s20Store._set({
      chat: {
        order: ["kq1", "ka1"],
        nodes: new Map([
          ["kq1", { key: "kq1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "沉淀知识" }] } }],
          ["ka1", { key: "ka1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [
            { kind: "reasoning", text: "思维链内容不应出现" },
            { kind: "text", text: "结构化方案正文" }
          ] } }]
        ])
      },
      running: false
    });
    await sleep(40);
    // node 半段写 reviewRequest（无产物路径 → 走文本分支）→ 挑战者审查
    ns.value = { ...(ns.value ?? {}), arena: { ...(ns.value?.arena ?? {}), reviewRequest: { workflowId: "wf20", seq: 1, proposalPath: "", designPath: "", tasksPath: "", reviewPath: "" } } };
    settingsUpdatedHandler?.("model-arena");
    await sleep(60);
    const s20Prompts = promptCalls.filter((c) => c.sessionId === "arena-20" && c.content[0].text.includes("审查"));
    const s20Prompt = s20Prompts[0]?.content?.[0]?.text ?? "";
    check("知识沉淀(流程): review prompt 含主模型方案正文", s20Prompt.includes("结构化方案正文"), "prompt=" + s20Prompt.slice(0, 80));
    check("知识沉淀(流程): review prompt 不含思维链（reasoning 排除）", !s20Prompt.includes("思维链内容"));
  } finally {
    snap = origSnap;
    currentSession = "s1";
    listSub();
    await sleep(80);
  }
}

// ── REPRO: F（v19 重新播种边界）——挂载空快照 + 历史与新首问同批到达 ──
// 已 link 的老会话刷新后，若挂载时快照为空（lastSeenSeq=0），随后「历史（旧轮）
// 与新首问」在同一次快照更新中到达，detectUserMessages 开头的 v19 重新播种会把
// scanUserAnchorSeq 扫到新首问的 seq、把新首问当「历史」吞掉（不 startChallenge）。
// 实测（mock，无 sync 介入）：challenge 保持 idle（active=false）——新首问既不
// 启动挑战、也不被记录；真实环境若 sync 在中间介入，inferRestoredChallenge 会
// 从快照**第一个** user 节点启动挑战，userQuestion 变成「旧轮问题」——两种结果
// 都确认新首问处理异常。预期 KNOWN-FAIL（rcheck 不计数）：边界确认，记录不修
// （真实平台历史加载与新消息通常是两次独立快照更新，同批到达概率极低）。
{
  const origSnap = snap;
  try {
    snap = twoModelDir;
    let ns = settingsNamespaces.find((n) => n.ns === "model-arena");
    if (ns === void 0) { ns = { ns: "model-arena", value: {} }; settingsNamespaces.push(ns); }
    ns.value = { ...(ns.value ?? {}), links: { ...(ns.value?.links ?? {}), s18: { sessionId: "arena-18", provider: "p1", model: "m2", scene: "business" } } };
    settingsUpdatedHandler?.("model-arena");
    currentSession = "s18";
    listSub();
    await sleep(120); // 挂载：快照为空 → lastSeenSeq = 0
    const s18Store = sessionStores.get("s18") ?? makeSessionStore("s18", { chat: { order: [], nodes: new Map() } });
    sessionStores.get("arena-18") ?? makeSessionStore("arena-18", { chat: { order: [], nodes: new Map() } });
    // 同批到达：旧轮历史 user 节点 + 新首问 user 节点
    s18Store._set({
      chat: {
        order: ["h1", "q2"],
        nodes: new Map([
          ["h1", { key: "h1", kind: "user", anchorSeq: 10, data: { content: [{ type: "text", text: "旧轮问题" }] } }],
          ["q2", { key: "q2", kind: "user", anchorSeq: 11, data: { content: [{ type: "text", text: "新首问" }] } }]
        ])
      },
      running: true
    });
    await sleep(60);
    const fMount = internals.getArenaMount();
    rcheck("REPRO F: 同批到达时新首问被正确记录（userQuestion=新首问）", fMount !== null && fMount.challenge.active === true && fMount.challenge.userQuestion === "新首问", "active=" + fMount?.challenge?.active + " q=" + fMount?.challenge?.userQuestion);
  } finally {
    snap = origSnap;
    currentSession = "s1";
    listSub();
    await sleep(80);
  }
}

console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);

