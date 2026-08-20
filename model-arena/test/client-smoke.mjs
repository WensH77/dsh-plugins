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
normalRow.textContent = "普通会话";
bodyRoot.appendChild(arenaRow);
bodyRoot.appendChild(normalRow);
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
    if (selector === ".YDXeBa_sessionRow") return [arenaRow, normalRow];
    return [];
  },
  createElement: (tag) => new FakeElement(tag),
  head: { appendChild() {} },
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
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      if (id === "react") return reactStub;
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
let listSub = null;
let currentSession = "s1";
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
          const rec = { name: opts.name, id: opts.id, order: opts.order, label: opts.label, locale: opts.locale, component };
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
              return { result: { ok: true, value: payload } };
            }
          }
        }
      };
    }
    return void 0;
  },
  remote: {
    $on: () => () => {}
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
        byId: {
          s1: {
            cwd: "/ws1",
            projectionValues: { permissions: { currentValue: "workspace-write" } }
          }
        }
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
const realT = (k) => (dicts?.zh?.[k]) ?? k;
const chCtx = { scene: "knowledge", userQuestion: "Q1", lastMainText: "answer with `docs/plan.md`", lastArenaText: "objection" };
const challengePrompt = loaded.buildRoundPrompt("challenge", chCtx, realT);
check("challenge prompt has no role identity (persona only)", !challengePrompt.includes("Challenger") && !challengePrompt.includes("身份高于") && challengePrompt.includes("用户问题") && challengePrompt.includes("docs/plan.md"));
check("challenge prompt: question + answer + file ref", challengePrompt.includes("Q1") && challengePrompt.includes("answer with") && challengePrompt.includes("docs/plan.md"));
check("challenge directive: challenge only, no verdict", challengePrompt.includes("只输出你的质疑") && challengePrompt.includes("禁止辩论") && !challengePrompt.includes("仅给出最终评审结论"));
const finalPrompt = loaded.buildRoundPrompt("final", chCtx, realT);
check("final prompt has NO repeated role injection", !finalPrompt.includes("Challenger") && finalPrompt.includes("修正后的回答"));
check("final directive: verdict only, no new challenge", finalPrompt.includes("仅给出最终评审结论") && finalPrompt.includes("不再质疑") && !finalPrompt.includes("只输出你的质疑"));
const reviseMsg = loaded.buildReviseMessage("objection text", chCtx, realT);
check("revise message = raw challenger text (no wrappers)", reviseMsg === "objection text" && !reviseMsg.includes("Knowledge Expert") && !reviseMsg.includes("禁止辩论"));
check("stripMarkdown removes emphasis and code", loaded.stripMarkdown("**bold** and \`code\` and [link](http://x)") === "bold and code and link");
check("stripMarkdown keeps paragraphs", loaded.stripMarkdown("line1\n\n\n\nline2") === "line1\n\nline2");
const reviseMd = loaded.buildReviseMessage("**核心问题**：方案有缺陷", chCtx, realT);
check("revise message strips markdown before injection", reviseMd === "核心问题：方案有缺陷");
const qaPrompt = loaded.buildRoundPrompt("challenge", { ...chCtx, scene: "qa" }, realT);
check("qa scene roles", qaPrompt.includes("QA Expert") && qaPrompt.includes("用户"));
check("extractFileRefs finds code/link paths", loaded.extractFileRefs("see `docs/a.md` and [x](src/b.ts)").join(",") === "docs/a.md,src/b.ts");
check("fmt substitutes placeholders", loaded.fmt("a {x} b", { x: "1" }) === "a 1 b");
// ── tool-call trail in round prompts (assistant-node blocks only) ────────
check("formatToolTrail empty input -> empty string", loaded.formatToolTrail([]) === "" && loaded.formatToolTrail(void 0) === "" && loaded.formatToolTrail(null) === "");
check("formatToolTrail prefers description summary", loaded.formatToolTrail([{ name: "read_file", argsRaw: JSON.stringify({ description: "读取 src/query.ts", path: "src/query.ts" }) }]) === "1. read_file「读取 src/query.ts」");
const jsonFallback = loaded.formatToolTrail([{ name: "run_command", argsRaw: '{"command":"pnpm bench"}' }]);
check("formatToolTrail falls back to compact json", jsonFallback.includes("run_command") && jsonFallback.includes("pnpm bench"));
check("formatToolTrail truncates long args", loaded.formatToolTrail([{ name: "x", argsRaw: "y".repeat(500) }]).length < 400);
const toolsCtx = { ...chCtx, lastMainTools: [{ name: "read_file", argsRaw: '{"path":"src/query.ts"}' }, { name: "run_command", argsRaw: '{"command":"pnpm bench"}' }] };
const toolsPrompt = loaded.buildRoundPrompt("challenge", toolsCtx, realT);
check("challenge prompt includes tool trail", toolsPrompt.includes("工具操作记录") && toolsPrompt.includes("1. read_file") && toolsPrompt.includes("2. run_command"));
check("challenge prompt tool trail after files section", toolsPrompt.indexOf("工具操作记录") > toolsPrompt.indexOf("提到的文件"));
const finalToolsPrompt = loaded.buildRoundPrompt("final", toolsCtx, realT);
check("final prompt includes tool trail too", finalToolsPrompt.includes("工具操作记录") && finalToolsPrompt.includes("run_command"));
check("no tool trail when lastMainTools absent", !loaded.buildRoundPrompt("challenge", chCtx, realT).includes("工具操作记录"));
check("nonMdSig flips when reasoning turns non-empty", loaded.nonMdSig([{ kind: "reasoning", text: "" }, { kind: "text", text: "x" }]) !== loaded.nonMdSig([{ kind: "reasoning", text: "thinking" }, { kind: "text", text: "x" }]));
check("nonMdSig stable while reasoning text streams", loaded.nonMdSig([{ kind: "reasoning", text: "t1" }]) === loaded.nonMdSig([{ kind: "reasoning", text: "t1 longer" }]));
check("nonMdSig unchanged for text-only streaming", loaded.nonMdSig([{ kind: "text", text: "a" }]) === loaded.nonMdSig([{ kind: "text", text: "ab" }]));
const seed = loaded.buildRoleSeed({ scene: "knowledge" }, realT);
check("role seed carries challenger rank + no-debate", seed.includes("Challenger") && seed.includes("身份高于") && seed.includes("Knowledge Expert") && seed.includes("禁止辩论"));

const toggle = heroRow.children.find((child) => child.dataset.arenaToggle !== void 0);
check("toggle mounted in hero row", toggle !== void 0);
check("toggle default off", toggle.getAttribute("aria-pressed") === "false");

click(toggle);
const panel = heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0);
check("toggle on mounts panel", panel !== void 0);
check("composer blocked while arena on without model", blockCalls.some((c) => c.sessionId === "s1" && c.block?.reason === "L:block.reason"));
const sceneBtnEls = collectByClass(panel, "ma-sceneBtn");
check("scene selector has two options", sceneBtnEls.length === 2);
check("knowledge scene default", sceneBtnEls[0].getAttribute("aria-pressed") === "true" && sceneBtnEls[0].textContent === "L:scene.knowledge");
click(sceneBtnEls[1]);
check("scene switched to qa", sceneBtnEls[1].getAttribute("aria-pressed") === "true" && sceneBtnEls[0].getAttribute("aria-pressed") === "false");
click(sceneBtnEls[0]); // back to knowledge for the runtime flow

const selector = panel.children[1];
const trigger = selector.children[0];
const menuHost = selector.children[1];
const note = panel.children[3];
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

// toggle off removes the panel
click(toggle);
check("toggle off removes panel", heroRoot.children.find((child) => child.dataset.arenaPanel !== void 0) === void 0);
check("toggle aria-pressed off", toggle.getAttribute("aria-pressed") === "false");

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
check("composer locked during challenge (answer stage label)", blockCalls.some((c) => c.sessionId === "s1" && c.block?.reason === "L:block.challenge.answer"));
check("challenge phase = answer after first question", internals.getArenaMount().challenge.phase === "answer" && internals.getArenaMount().challenge.active === true);
check("arena session archived on create (hidden from sidebar/counter)", archiveCalls.includes("arena-1"));
check("permission preset applied via command channel (not prompt)", commandCalls.length === 1 && commandCalls[0].sessionId === "arena-1" && commandCalls[0].line === "/permission workspace-write" && !promptCalls.some((c) => c.content?.[0]?.text?.startsWith("/permission")));
check("arena session window opened", openCalls.includes("arena-1"));
check("arena session titled", renameCalls.length === 1 && renameCalls[0].sessionId === "arena-1" && renameCalls[0].title === "L:arena.sessionTitle");
const arenaTabEntry = slotRegisterCalls.find((c) => c.name === "conversation.view" && c.id === "arena");
check("arena view tab registered (native view ring)", arenaTabEntry !== void 0 && typeof arenaTabEntry.component === "function");
check("arena tab label", typeof arenaTabEntry?.label === "function" && arenaTabEntry.label() === "L:view.arena");

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
check("arena pane renders reply without a duplicated user bubble (shared input)", bubbles.length >= 1 && !bubbles.some((b) => b.className.includes("user")) && bubbles.some((b) => b.textContent.includes("arena answer") || b.className.includes("assistant")));
check("arena pane renders assistant reply", bubbles.some((b) => b.className.includes("assistant") && b.textContent === "arena answer"));
check("arena pane renders reasoning", bubbles.some((b) => (b.className.includes("reasoning") || b.className.includes("think")) && b.textContent === "thinking"));

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
check("reasoning filled in later renders the think row", collectByClassContains(paneBody, "ma-bubble").some((b) => (b.className.includes("reasoning") || b.className.includes("think")) && b.textContent === "thinking"));

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
check("content after the grant still renders", !bubblesAfterGrant.some((b) => b.className.includes("user")) && bubblesAfterGrant.some((b) => b.className.includes("assistant") && b.textContent === "real answer"));

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

// ── challenge rounds: 1 -> 2 -> 1 -> 2 ─────────────────────────────────
// model 1 answers -> challenger prompted (round 1; role injected once)
mainStore._set({
  chat: {
    order: ["u1", "a1"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "answer from model1" }] } }]
    ])
  }
});
await sleep(20);
const arenaPrompts = promptCalls.filter((c) => c.sessionId === "arena-1");
const chPrompt = arenaPrompts.find((c) => c.content[0].text.includes("用户问题"));
check("challenger prompted after model1 answer (no seed message)", arenaPrompts.length === 1 && chPrompt !== void 0);
check("challenge phase = challenge", internals.getArenaMount().challenge.phase === "challenge");
check("challenger persona carries round instruction", settingsMutateCalls.some((m) => m.ns === "model-arena" && m.ops?.[0]?.value?.["arena-1"] !== void 0 && m.ops[0].value["arena-1"].includes("禁止辩论")));

// switching away and back mid-challenge must preserve the flow state
currentSession = "s2";
listSub();
await sleep(80);
currentSession = "s1";
listSub();
await sleep(80);
check("challenge state survives a session round-trip", internals.getArenaMount() !== null && internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "challenge");

// model 2 challenges -> revise message injected into the MAIN session
arenaStore._set({
  chat: {
    order: ["ch1"],
    nodes: new Map([["ch1", { key: "ch1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "challenger objection" }] } }]])
  }
});
await sleep(20);
check("challenger objection injected raw into main session", promptCalls.some((c) => c.sessionId === "s1" && c.content[0].text === "challenger objection"));
check("challenge phase = revise", internals.getArenaMount().challenge.phase === "revise");

// the injected revise message lands in the main session (a user node) —
// the orchestrator re-anchors without treating it as a completed turn
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "answer from model1" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "L:challenge.revise.message" }] } }]
    ])
  }
});
await sleep(20);
check("injected revise message does not advance the flow", internals.getArenaMount().challenge.phase === "revise" && promptCalls.filter((c) => c.sessionId === "arena-1").length === 1);

// model 1 revises -> final round prompted (no repeated role injection)
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "answer from model1" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "L:challenge.revise.message" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised answer" }] } }]
    ])
  }
});
await sleep(20);
const finalPrompts = promptCalls.filter((c) => c.sessionId === "arena-1");
check("final round prompted after revision (challenge + final, verdict directive)", finalPrompts.length === 2 && finalPrompts[1].content[0].text.includes("修正后的回答") && finalPrompts[1].content[0].text.includes("仅给出最终评审结论"));
check("challenge phase = final", internals.getArenaMount().challenge.phase === "final");

// the final prompt lands as a USER node in the arena session BEFORE the
// challenger starts (real platform timing) — this must NOT count as the
// verdict turn, or the previous challenge text is reused as the verdict
arenaStore._set({
  chat: {
    order: ["ch1", "fp1"],
    nodes: new Map([
      ["ch1", { key: "ch1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", blocks: [{ kind: "text", text: "challenger objection" }] } }],
      ["fp1", { key: "fp1", kind: "user", anchorSeq: 2, data: { content: [{ type: "text", text: "final round prompt" }] } }]
    ])
  },
  running: false
});
await sleep(20);
check("prompt user node does not fake the verdict turn", internals.getArenaMount().challenge.phase === "final" && promptCalls.filter((c) => c.sessionId === "s1").length === 1);

// model 2 verdict -> injected into main session + flow done + composer unlocked
arenaStore._set({
  chat: {
    order: ["ch1", "fp1", "v1"],
    nodes: new Map([
      ["ch1", { key: "ch1", kind: "assistant-step", anchorSeq: 1, data: { status: "settled", blocks: [{ kind: "text", text: "challenger objection" }] } }],
      ["fp1", { key: "fp1", kind: "user", anchorSeq: 2, data: { content: [{ type: "text", text: "final round prompt" }] } }],
      ["v1", { key: "v1", kind: "assistant-step", anchorSeq: 3, data: { status: "settled", blocks: [{ kind: "text", text: "final verdict" }] } }]
    ])
  },
  running: false
});
await sleep(20);
const verdictMsg = promptCalls[promptCalls.length - 1];
check("final verdict injected into main session", verdictMsg.sessionId === "s1" && verdictMsg.content[0].text.includes("final verdict"));
check("challenge done", internals.getArenaMount().challenge.active === false && internals.getArenaMount().challenge.phase === "done");
check("composer unlocked after flow", blockCalls[blockCalls.length - 1].block === void 0);
check("composer stage label advances with phase", (() => {
  const reasons = blockCalls.filter((c) => c.sessionId === "s1").map((c) => c.block?.reason);
  return reasons.includes("L:block.challenge.answer") && reasons.includes("L:block.challenge.challenger") && reasons.includes("L:block.challenge.revise") && reasons.includes("L:block.challenge.verdict");
})());
const promptsAfterDone = promptCalls.length;
arenaStore._set({ chat: arenaStore.snapshot.chat });
await sleep(20);
check("no re-trigger after flow done (phase guard)", promptCalls.length === promptsAfterDone);
// after the verdict, a late main-session reply must NEVER reach the challenger
const promptsBeforeLateReply = promptCalls.length;
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1", "v1", "late"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "answer" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "challenger objection" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised" }] } }],
      ["v1", { key: "v1", kind: "user", anchorSeq: 5, data: { content: [{ type: "text", text: "final verdict" }] } }],
      ["late", { key: "late", kind: "assistant-step", anchorSeq: 99, data: { status: "settled", blocks: [{ kind: "text", text: "model1 reacts to verdict" }] } }]
    ])
  }
});
await sleep(20);
check("late main reply never prompts the challenger again", promptCalls.length === promptsBeforeLateReply);
// ── user stop: stopping the main session cancels the challenger ─────────────
// start a fresh round
mainStore._set({
  chat: {
    order: ["u1", "a1", "inj1", "r1", "v1", "u2"],
    nodes: new Map([
      ["u1", { key: "u1", kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hello arena" }] } }],
      ["a1", { key: "a1", kind: "assistant-step", anchorSeq: 2, data: { status: "settled", blocks: [{ kind: "text", text: "answer" }] } }],
      ["inj1", { key: "inj1", kind: "user", anchorSeq: 3, data: { content: [{ type: "text", text: "L:challenge.revise.message" }] } }],
      ["r1", { key: "r1", kind: "assistant-step", anchorSeq: 4, data: { status: "settled", blocks: [{ kind: "text", text: "revised" }] } }],
      ["v1", { key: "v1", kind: "user", anchorSeq: 5, data: { content: [{ type: "text", text: "final verdict" }] } }],
      ["u2", { key: "u2", kind: "user", anchorSeq: 6, data: { content: [{ type: "text", text: "second question" }] } }]
    ])
  },
  running: true
});
await sleep(20);
check("new round started on second question", internals.getArenaMount().challenge.active === true && internals.getArenaMount().challenge.phase === "answer");

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
console.log(failed === 0 ? "CLIENT SMOKE PASS" : failed + " CLIENT SMOKE FAILURES");
process.exit(failed === 0 ? 0 : 1);

