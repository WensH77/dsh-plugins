// Smoke test for command-setting node half: mock ctx (commands + webServer) and
// verify the /ask (Q&A-only) domain — tool deny rules, prompt section, ask-state
// route, mode-switch notice and guard install/uninstall — plus a source guard on
// the removed command-hiding feature.
// Run: node test/smoke.mjs
import { existsSync, readFileSync } from "node:fs";

const { apply } = await import("../lib/index.js");

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  ok  " + label);
  } else {
    failed += 1;
    console.log(" FAIL " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}

function makeCtx(routes) {
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    // cordis ctx.effect: runs the callback now, returns its disposer (lib binds
    // webServer routes to the plugin lifecycle through it)
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    commands: {
      register: (definition) => {
        const registered = (ctx.__registeredCommands ??= []);
        registered.push(definition.name);
        return () => {
          const idx = registered.indexOf(definition.name);
          if (idx >= 0) registered.splice(idx, 1);
        };
      }
    },
    on: (event, listener) => {
      const listeners = (ctx.__events ??= {});
      const bucket = (listeners[event] ??= []);
      bucket.push(listener);
      return () => {
        const idx = bucket.indexOf(listener);
        if (idx >= 0) bucket.splice(idx, 1);
      };
    },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      }
    }
  };
  apply(ctx);
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

// ── context 1: ask 判定函数 askToolDenyReason ───────────────────────────────
// 只读放行、写类硬拦、bash 写命令拦、bash 只读放行
{
  const { askToolDenyReason } = await import("../lib/index.js");
  check("ask: edit denied", askToolDenyReason("edit", { file_path: "a.txt" }) !== void 0);
  check("ask: write denied", askToolDenyReason("write", { file_path: "a.txt" }) !== void 0);
  check("ask: str_replace_editor denied", askToolDenyReason("str_replace_editor", { command: "str_replace" }) !== void 0);
  check("ask: read allowed", askToolDenyReason("read", { file_path: "a.txt" }) === void 0);
  check("ask: grep allowed", askToolDenyReason("grep", {}) === void 0);
  check("ask: glob allowed", askToolDenyReason("glob", {}) === void 0);
  check("ask: run_code allowed", askToolDenyReason("run_code", {}) === void 0);
  check("ask: bash readonly allowed", askToolDenyReason("bash", { command: "node -e 'console.log(1)'" }) === void 0);
  check("ask: bash cp denied", askToolDenyReason("bash", { command: "cp a b" }) !== void 0);
  check("ask: bash redirect denied", askToolDenyReason("bash", { command: "echo hi > f.txt" }) !== void 0);
  check("ask: bash sed -i denied", askToolDenyReason("bash", { command: "sed -i s/a/b/ f" }) !== void 0);
  // 只读探测命令（for/管道/2>/dev/null/引号内 >）不得误伤（回归：2>/dev/null 曾误判为写重定向）
  check("ask: bash readonly loop allowed", askToolDenyReason("bash", { command: "for d in a b; do ls -la ~/.dsh/sessions/x/$d/ 2>/dev/null | grep -v \"^total\"; done" }) === void 0);
  check("ask: bash 2>&1 allowed", askToolDenyReason("bash", { command: "ls -la /tmp 2>&1 | head" }) === void 0);
  check("ask: bash quoted > allowed", askToolDenyReason("bash", { command: "echo \"a>b\" && grep -n \">\" f.txt" }) === void 0);
  check("ask: bash append redirect denied", askToolDenyReason("bash", { command: "cat a.txt >> log.txt" }) !== void 0);
  check("ask: bash tee denied", askToolDenyReason("bash", { command: "tee out.txt" }) !== void 0);
  check("ask: bash devnull redirect allowed", askToolDenyReason("bash", { command: "echo hi >/dev/null" }) === void 0);
  check("ask: other tool untouched", askToolDenyReason("subagent", {}) === void 0);
  // 包装成 heredoc/python 写源码的改动也要拦（open(...,'w').write 落盘现有代码）
  check("ask: bash heredoc python edit denied", askToolDenyReason("bash", {
    command: "python3 - <<'EOF'\np='src/messages.ts'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF\npnpm run typecheck > /tmp/etx45.log 2>&1; echo tc=$?"
  }) !== void 0);
  // heredoc 内只有只读 python（不落盘）且无写重定向 → 放行
  check("ask: bash heredoc python readonly allowed", askToolDenyReason("bash", {
    command: "python3 - <<'EOF'\np='src/messages.ts'\nprint(open(p).read()[:100])\nEOF"
  }) === void 0);
}

// ── context 2: ask 提示段：禁改文件 / 禁诱导提问 / 可只读验证 / 退出方式 ──────
{
  const { buildAskSection } = await import("../lib/index.js");
  const section = buildAskSection();
  check("ask: section mentions no file edits", section.includes("edit") || section.includes("改动"));
  check("ask: section forbids luring questions", section.includes("需要我帮你改") && section.includes("诱导"));
  check("ask: section allows readonly verify", section.includes("run_code") || section.includes("只读"));
  check("ask: section mentions exit", section.includes("/ask off"));
}

// ── context 3: /ask 命令注册 + ask-state 端点 ───────────────────────────────
// mock ctx 下：命令注册成功、端点可查、事件监听就绪
{
  const routes3 = new Map();
  const ctx3 = makeCtx(routes3);
  check("ask: /ask command registered", Array.isArray(ctx3.__registeredCommands) && ctx3.__registeredCommands.includes("ask"));
  check("ask: agent/created listener attached", Array.isArray(ctx3.__events?.["agent/created"]) && ctx3.__events["agent/created"].length >= 1);
  check("ask: agent/disposed listener attached", Array.isArray(ctx3.__events?.["agent/disposed"]) && ctx3.__events["agent/disposed"].length >= 1);
  let r3 = await request(routes3, "/command-setting/ask-state", { session: "s1" });
  let body3 = JSON.parse(r3._body);
  check("ask: state endpoint ok (off)", r3.status === 200 && body3.ok === true && body3.active === false);
  r3 = await request(routes3, "/command-setting/ask-state", { session: "nope;rm" });
  body3 = JSON.parse(r3._body);
  check("ask: state endpoint rejects malformed session", r3.status === 200 && body3.ok === true && body3.active === false);
  r3 = await request(routes3, "/command-setting/ask-state");
  body3 = JSON.parse(r3._body);
  check("ask: state endpoint without session", r3.status === 200 && body3.ok === true && body3.active === false);
  check("ask: only the ask-state route is registered", [...routes3.keys()].join(",") === "/command-setting/ask-state", [...routes3.keys()].join(","));
}

// ── context 4: ask 模式切换把「模式变了」注入会话（agent.inject），并装卸拦截 ─
//     （HOME 先指向临时目录：ask.js 的侧文件路径由 homedir() 在模块加载时决定，
//     用查询串换一个模块实例，避免污染真实的 ~/.dsh/command-setting-ask.json）
{
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pm = await import("node:path");
  const realAskFile = pm.join(osm.homedir(), ".dsh", "command-setting-ask.json");
  const realBefore = fsm.existsSync(realAskFile) ? fsm.readFileSync(realAskFile, "utf8") : null;
  const fakeHome = fsm.mkdtempSync(pm.join(osm.tmpdir(), "command-setting-ask-"));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const { createAskController } = await import("../lib/ask.js?fake-home=" + encodeURIComponent(fakeHome));
  process.env.HOME = prevHome;

  let sectionCalls = 0;
  let sectionDisposed = 0;
  let guardDisposed = 0;
  let definition = null;
  const ctx4 = {
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    commands: { register: (def) => { definition = def; return () => {}; } }
  };
  const controller4 = createAskController(ctx4);
  controller4.registerAskCommand();
  const injected = [];
  const agent4 = {
    id: "session-ask-test",
    options: {},
    session: { header: { origin: "main" } },
    inject: (message) => injected.push(message),
    ctx: {
      systemPrompt: { section: () => { sectionCalls += 1; return () => { sectionDisposed += 1; }; } },
      tools: { guard: () => () => { guardDisposed += 1; } }
    }
  };

  const onResult4 = definition.handler({ agent: agent4, rawInput: "" });
  check("ask notice: /ask succeeds", onResult4.kind === "success");
  check("ask notice: entry injects one user message", injected.length === 1 && injected[0].role === "user");
  check("ask notice: entry message is a plugin notice",
    injected[0]?.source?.kind === "plugin:dsh-plugin-command-setting" && injected[0]?.source?.form === "notice"
      && !Object.hasOwn(injected[0]?.source ?? {}, "plugin") && typeof injected[0]?.source?.summary === "string");
  check("ask notice: entry text names ask mode", String(injected[0]?.content?.[0]?.text ?? "").includes("只问答"));
  check("ask notice: entry installs prompt section",
    sectionCalls === 1 && controller4.active("session-ask-test") === true);

  const offResult4 = definition.handler({ agent: agent4, rawInput: "off" });
  check("ask notice: /ask off succeeds", offResult4.kind === "success");
  check("ask notice: exit injects a second notice", injected.length === 2);
  check("ask notice: exit text says default mode",
    String(injected[1]?.content?.[0]?.text ?? "").includes("普通模式"));
  check("ask notice: exit summary differs from entry",
    injected[1]?.source?.summary !== injected[0]?.source?.summary);
  check("ask notice: exit removes section and guard",
    sectionDisposed === 1 && guardDisposed === 1 && controller4.active("session-ask-test") === false);

  // 准入回归护栏：v4 会话对 message.source.kind 的准入规则（宿主
  // dsh-session-format-v3-to-v4 的 source()）要求非空字符串且**不允许裸 "plugin"**
  // ——那是 v3 的包装写法，只有升级器才会把它映射成 plugin:<名>。写成裸 "plugin" 时
  // 带这条 notice 的 agent/inbox/spliced 会在落盘编码那一站被整条拒绝，notice 静默
  // 丢失（0.8.3 的真实缺陷）。这里不依赖宿主包，直接把该规则钉在两条 notice 上。
  check("ask notice: sources pass v4 producer-owned admission",
    injected.length === 2 && injected.every((message) => {
      const sourceValue = message?.source;
      return typeof sourceValue?.kind === "string" && sourceValue.kind.length > 0
        && sourceValue.kind !== "plugin" && !Object.hasOwn(sourceValue, "plugin");
    }));

  const noopResult4 = definition.handler({ agent: agent4, rawInput: "off" });
  check("ask notice: repeated off injects nothing",
    noopResult4.kind === "success" && injected.length === 2);

  // 隔离自证：状态写进临时 HOME，真实侧文件逐字节不变
  check("ask notice: side file written under fake HOME",
    fsm.existsSync(pm.join(fakeHome, ".dsh", "command-setting-ask.json")));
  const realAfter = fsm.existsSync(realAskFile) ? fsm.readFileSync(realAskFile, "utf8") : null;
  check("ask notice: real side file untouched", realAfter === realBefore);
  fsm.rmSync(fakeHome, { recursive: true, force: true });
}

// ── guard: 命令隐藏已整体移除，不得回潮 ─────────────────────────────────────
// 0.9.0 删掉了「从命令菜单隐藏命令」这一功能（原因见 CHANGELOG）：node 半边不再
// shadow commands.list，也不再提供 catalog/set 端点。逐字节钉住这三点，避免以后
// 又把隐藏域写回来；同时旧域文件（commands.js / hidden.js）不得复活。
{
  const srcDir = new URL("../lib/", import.meta.url);
  const files = ["index.js", "routes.js", "ask.js"];
  const banned = /settings\s*\.\s*(register|watch)\s*\(|shadowCommandList|sweepArchived|hiddenSet/;
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, srcDir), "utf8");
    if (banned.test(text)) offenders.push(file);
  }
  check("guard: no hiding code left in the node half", offenders.length === 0, offenders.join(", "));
  check("guard: hiding domain files removed",
    !existsSync(new URL("commands.js", srcDir)) && !existsSync(new URL("hidden.js", srcDir)));
}

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
