window.__ModuleLoader__.load({
	id: "dsh-plugin-command-setting",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect } = react;
		const h = react.createElement;

		// ── styles (injected once, tagged like the built bundles) ──────────────
		const css = [
			".hc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
			".hc-title{margin:0;font-size:18px;font-weight:600}",
			".hc-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
			".hc-list{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}",
			".hc-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:12px;padding:14px 0;display:flex}",
			".hc-rowText{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}",
			".hc-name{font:13px/1.5 var(--dsw-font-mono);color:var(--dsw-alias-label-primary)}",
			".hc-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".hc-badge{flex:none;font-size:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;line-height:17px}",
			".hc-badge.hidden{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".hc-badge.visible{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".hc-btn{flex:none;padding:3px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
			".hc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".hc-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".hc-btn:disabled{opacity:.5;cursor:default}",
			".hc-badge.protected{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}",
			".hc-locked{flex:none;font-size:12px;color:var(--dsw-alias-label-caption)}",
			".hc-hint{color:var(--dsw-alias-label-caption);margin:0;font-size:12px}",
			".hc-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px}",
			".hc-empty{color:var(--dsw-alias-label-caption);margin:0;font-size:13px}",
			// Externalized plan-mode toggle in the composer tools row. Flex order
			// places it directly LEFT of the permission selector ("full access"):
			// the .uV2eYG_modes hash is pinned to this dsh bundle; if it ever
			// changes, the button simply falls back to the leftItems position.
			".uV2eYG_tools > .uV2eYG_modes{order:1}",
			".hc-planbtn{align-items:center;gap:4px;min-width:34px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-selector);border-radius:999px;padding:0 10px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}",
			".hc-planbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".hc-planbtn[data-active=true]{background:var(--dsw-alias-state-business-tertiary);border-color:transparent;color:var(--dsw-alias-state-business-primary)}",
			".hc-planbtn[data-active=true]:hover{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}",
			".hc-planbtn:disabled{opacity:.6;cursor:default}",
			// The built-in yellow "Plan ✕" chip is replaced by this toggle: hide it.
			// .rS3zOq_wrap is ui-plan's hashed chip wrapper, pinned to this bundle.
			".rS3zOq_wrap{display:none!important}"
		];
		const tagId = "dsh-plugin-command-setting/settings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css.join("\n");
			document.head.appendChild(tag);
		}

		// ── dictionaries ──────────────────────────────────────────────────────
		const NS = "command-setting";
		const zh = {
			nav: "命令设置",
			title: "命令设置",
			intro: "管理命令菜单（输入框 “+” / “/” 弹出的列表）中显示哪些命令。修改立即生效并写入 settings.yaml。",
			loading: "加载中…",
			retry: "重试",
			hidden: "已隐藏",
			visible: "显示中",
			show: "显示",
			hide: "隐藏",
			hint: "“隐藏”把命令从菜单移除：不再出现在菜单，直接输入也不再作为命令执行；“显示”恢复。plan/goal 为系统命令，不可隐藏。命令是否在当前会话可用，由 dsh 的会话模式（agent preset）决定：极简模式下会话不包含的命令不会显示，即使设为显示。",
			system: "系统",
			locked: "不可隐藏",
			empty: "没有已注册的命令。",
			planLabel: "Plan",
			planEnter: "plan mode 已关闭 — 点击开启（/plan）",
			planExit: "plan mode 已开启 — 点击关闭（/plan off）",
			planError: "plan 命令执行失败"
		};
		const en = {
			nav: "Command Settings",
			title: "Command Settings",
			intro: "Manage which slash-commands appear in the command menu (the \"+\" / \"/\" popup). Changes apply immediately and are saved to settings.yaml.",
			loading: "Loading…",
			retry: "Retry",
			hidden: "Hidden",
			visible: "Visible",
			show: "Show",
			hide: "Hide",
			hint: "\"Hide\" removes a command from the menu: it disappears from the menu and direct slash input stops resolving; \"Show\" restores it. plan/goal are system commands and cannot be hidden. Whether a command is available in the current session is decided by dsh's session mode (agent preset): commands the session does not include never show, even when set to show.",
			system: "System",
			locked: "Locked",
			empty: "No registered commands.",
			planLabel: "Plan",
			planEnter: "Plan mode off — click to turn on (/plan)",
			planExit: "Plan mode on — click to turn off (/plan off)",
			planError: "failed to run the plan command"
		};

		// ── minimal snapshot store (no external deps) ─────────────────────────
		function createStore(initial) {
			let state = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set(patch) {
					state = { ...state, ...patch };
					for (const listener of listeners) listener();
				}
			};
		}

		const INITIAL = { status: "loading", commands: [], hidden: [], protected: [], error: null, saving: false };

		/** 拼接 catalog URL：带 session（可选）与 contributions（浏览器贡献命令
		 * 名，逗号分隔）。服务端归档清理据此把 /model 这类贡献命令并入已知命令
		 * 面——不带上它们，贡献命令的 hidden 会被当成幽灵清掉。空贡献面也带
		 * 空参数，表示「贡献面已知为空」，命令面仍可信。 */
		function catalogUrl(commandUi, sessionId) {
			const contributions = commandUi?.live?.contributions instanceof Map ? [...commandUi.live.contributions.keys()] : [];
			const params = new URLSearchParams();
			if (sessionId !== void 0 && sessionId !== "") params.set("session", sessionId);
			params.set("contributions", contributions.join(","));
			const qs = params.toString();
			return "/command-setting/catalog" + (qs === "" ? "" : "?" + qs);
		}

		class CommandsSettingController {
			constructor(commandUi, sessions, onHiddenChanged) {
				// Capture the UNPATCHED candidates before apply() shadows the
				// instance: the settings list must still show hidden commands
				// (including browser-side contributions like /model), so it reads
				// the raw surface while the live menu reads the filtered one.
				this.originalCandidates = typeof commandUi.candidates === "function" ? commandUi.candidates.bind(commandUi) : null;
				this.commandUi = commandUi;
				this.sessions = sessions;
				this.onHiddenChanged = onHiddenChanged;
				this.store = createStore(INITIAL);
			}
			set(patch) {
				this.store.set(patch);
			}
			/**
			* Rows the command menu actually shows for the current session: host
			* commands (global + agent-preset scoped) plus browser-side contributions
			* like /model. Returns { rows, complete }: complete is false when no
			* session exists or the fetch failed, so pruning never runs on a partial
			* picture.
			*/
			async sessionRows() {
				const snap = this.sessions.list.getSnapshot();
				const id = snap.current ?? (Array.isArray(snap.items) && snap.items.length > 0 ? snap.items[0].sessionId : void 0);
				if (id === void 0 || this.originalCandidates === null) return { rows: [], complete: false, id };
				try {
					const rows = await this.originalCandidates({ sessionId: id }, {
						query: "",
						position: "leading",
						signal: new AbortController().signal
					});
					return { rows: Array.isArray(rows) ? rows : [], complete: true, id };
				} catch (_sessionRowsFailure) {
					return { rows: [], complete: false, id };
				}
			}
			async load() {
				try {
					const sessionInfo = await this.sessionRows();
					const [data] = await Promise.all([
						fetch(catalogUrl(this.commandUi, sessionInfo.id), { cache: "no-store" }).then((response) => response.json())
					]);
					if (!data.ok) throw new Error(data.message ?? "catalog failed");
					const contributions = this.commandUi?.live?.contributions instanceof Map ? this.commandUi.live.contributions : null;
					const byName = new Map();
					for (const command of Array.isArray(data.commands) ? data.commands : []) {
						byName.set(command.name, {
							name: command.name,
							description: command.description,
							scope: "global",
							...(command.hint === void 0 ? {} : { hint: command.hint })
						});
					}
					// Agent-scoped host commands of the current session (per-agent variants)
					// plus browser-side contributions (e.g. /model) join the directory so
					// the settings page can manage them too. No stale-name pruning: the
					// hidden list is a GLOBAL setting and must never be rewritten from a
					// single session's narrower command surface (a minimal-mode session
					// would otherwise silently drop entries for commands it cannot see).
					for (const row of sessionInfo.rows) {
						if (byName.has(row.name)) continue;
						byName.set(row.name, {
							name: row.name,
							description: row.description,
							scope: contributions !== null && contributions.has(row.name) ? "contribution" : "agent"
						});
					}
					this.set({
						status: "ready",
						commands: [...byName.values()],
						hidden: Array.isArray(data.hidden) ? data.hidden : [],
						protected: Array.isArray(data.protected) && data.protected.length > 0 ? data.protected : ["plan", "goal"],
						error: null
					});
				} catch (error) {
					this.set({ status: "error", error: String(error?.message ?? error) });
				}
			}
			async setHidden(next) {
				const before = this.store.getSnapshot();
				this.set({ saving: true, hidden: next, error: null });
				try {
					const res = await fetch("/command-setting/set", {
						method: "POST",
						cache: "no-store",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ hidden: next })
					});
					const data = await res.json();
					if (!data.ok) throw new Error(data.message ?? "write failed");
					this.set({ saving: false, hidden: Array.isArray(data.hidden) ? data.hidden : next });
					if (typeof this.onHiddenChanged === "function") this.onHiddenChanged();
					return true;
				} catch (error) {
					this.set({ saving: false, hidden: before.hidden, error: String(error?.message ?? error) });
					return false;
				}
			}
			toggle(name, hidden) {
				const current = new Set(this.store.getSnapshot().hidden);
				if (hidden) current.add(name);
				else current.delete(name);
				return this.setHidden([...current]);
			}
		}

		// ── settings section ──────────────────────────────────────────────────
		function CommandsSettingSection(props) {
			const { useCommandsSetting, t, load, toggle } = props;
			const state = useCommandsSetting((snapshot) => snapshot);
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				load();
			}, []);

			const registered = [...state.commands]
				.map((command) => ({
					...command,
					hidden: state.hidden.includes(command.name),
					protected: state.protected.includes(command.name)
				}))
				.sort((a, b) => a.name < b.name ? -1 : 1);
			const runToggle = async (name, hidden) => {
				setBusy(true);
				await toggle(name, hidden);
				setBusy(false);
			};
			const rows = (entries) => entries.map((entry) => h("li", { className: "hc-row", key: entry.name },
				h("div", { className: "hc-rowText" },
					h("div", { className: "hc-name" }, "/" + entry.name),
					h("div", { className: "hc-desc" }, entry.description)
				),
				entry.protected ? [
					h("span", { className: "hc-badge protected", key: "sys" }, t("system")),
					h("span", { className: "hc-badge visible", key: "vis" }, t("visible")),
					h("span", { className: "hc-locked", key: "lock" }, t("locked"))
				] : [
					h("span", { className: "hc-badge " + (entry.hidden ? "hidden" : "visible"), key: "badge" }, entry.hidden ? t("hidden") : t("visible")),
					h("button", {
						className: "hc-btn" + (entry.hidden ? "" : " danger"),
						key: "btn",
						disabled: state.saving || busy,
						onClick: () => runToggle(entry.name, !entry.hidden)
					}, entry.hidden ? t("show") : t("hide"))
				]
			));

			return h("div", { className: "hc-section" },
				h("h2", { className: "hc-title" }, t("title")),
				h("p", { className: "hc-intro" }, t("intro")),
				state.status === "loading" ? h("p", { className: "hc-hint" }, t("loading")) :
				state.status === "error" ? h("div", null,
					h("p", { className: "hc-error" }, String(state.error ?? t("loading"))),
					h("button", { className: "hc-btn", onClick: () => load() }, t("retry"))
				) :
				h(react.Fragment, null,
					registered.length === 0 ? h("p", { className: "hc-empty" }, t("empty")) : null,
					registered.length === 0 ? null : h("ul", { className: "hc-list" },
						rows(registered)
					),
					state.error === null ? null : h("p", { className: "hc-error", role: "alert" }, state.error),
					h("p", { className: "hc-hint" }, t("hint"))
				)
			);
		}

		// ── externalized plan-mode toggle ───────────────────────────────────
		// Always-visible standalone button in the composer tools row (left of the
		// permission selector via CSS order). Clicking runs /plan (enter) or
		// /plan off (leave) — the same command the built-in plan chip uses.
		function PlanModeToggle(props) {
			const { useProjection, t, sessionId, execute } = props;
			const planActive = useProjection("plan", (plan) => plan !== void 0 && (plan.pending ? !plan.active : plan.active));
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const onToggle = async () => {
				if (busy || sessionId === void 0) return;
				setBusy(true);
				setError(null);
				try {
					const failure = await execute(sessionId, planActive ? "/plan off" : "/plan");
					if (failure !== null) setError(failure);
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				}
				setBusy(false);
			};
			return h("button", {
				type: "button",
				className: "hc-planbtn",
				"data-active": planActive ? "true" : "false",
				"aria-label": t(planActive ? "planExit" : "planEnter"),
				title: error === null ? t(planActive ? "planExit" : "planEnter") : t("planError") + ": " + error,
				disabled: busy,
				onClick: onToggle
			}, t("planLabel"));
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		// "remote.commands" is a separately mounted namespace service (remote.<ns>);
		// property access only resolves once it is injected, like ui-plan does.
		const inject = ["slots", "locale", "commandUi", "sessions", "remote", "remote.commands"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "command-setting: dictionaries");
			const t = ctx.locale.bind(NS);

			// Shared live hidden set for the menu-side filter; refreshed from the
			// host on startup, on every settings write, and on change events.
			let hiddenSet = new Set();
			const syncHidden = async () => {
				try {
					const res = await fetch(catalogUrl(ctx.commandUi, void 0), { cache: "no-store" });
					const data = await res.json();
					if (data.ok) {
						hiddenSet = new Set(Array.isArray(data.hidden) ? data.hidden : []);
						controller.set({ hidden: [...hiddenSet] });
					}
				} catch (_syncHiddenFailure) {
					// keep the last known set
				}
			};

			// Browser-side menu filter: host commands are filtered host-side, but
			// client-side contribution commands (/model etc.) only exist in the
			// browser, so the command surface itself must be shadowed here.
			// The settings controller must be constructed FIRST: its constructor
			// captures the unpatched candidates for the full (unfiltered) list.
			const commandUi = ctx.commandUi;
			const controller = new CommandsSettingController(commandUi, ctx.sessions, () => syncHidden());
			const originalCandidates = commandUi.candidates.bind(commandUi);
			const originalMatchEnter = commandUi.matchEnter.bind(commandUi);
			const originalMatchSpace = commandUi.matchSpace.bind(commandUi);
			commandUi.candidates = async (session, req) => {
				const rows = await originalCandidates(session, req);
				// 防御：host 异常路径返回非数组时不崩菜单（与 controller.sessionRows
				// 的 Array.isArray 防御一致）。
				if (hiddenSet.size === 0 || !Array.isArray(rows)) return rows;
				return rows.filter((row) => !hiddenSet.has(row.name));
			};
			commandUi.matchEnter = async (session, line, signal) => {
				const trimmed = line.trim();
				const ws = trimmed.search(/\s/);
				const name = trimmed.startsWith("/") ? (ws === -1 ? trimmed.slice(1) : trimmed.slice(1, ws)) : "";
				if (hiddenSet.has(name)) return void 0;
				return originalMatchEnter(session, line, signal);
			};
			commandUi.matchSpace = (session, token) => {
				const name = token.startsWith("/") ? token.slice(1) : "";
				if (hiddenSet.has(name)) return void 0;
				return originalMatchSpace(session, token);
			};

			const sectionInjected = () => ({
				hooks: { commandsSetting: controller.store },
				load: () => controller.load(),
				toggle: (name, hidden) => controller.toggle(name, hidden)
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "command-setting",
				order: 21,
				label: () => t("nav"),
				locale: NS,
				inject: sectionInjected
			}, CommandsSettingSection));

			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "plan-mode-toggle",
				order: 0,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					execute: async (sid, line) => {
						// images must be passed explicitly: the wire contract for
						// commands/execute is (agentId, line, images) and images is a
						// required strict-array parameter — omitting it fails the call.
						const result = await ctx.remote.commands.execute(sid, line, []);
						if (!result.ok) return result.error.message + " (" + result.error.code + ")";
						if (result.value === void 0) return "unknown command: " + line;
						return null;
					}
				})
			}, PlanModeToggle));

			ctx.effect(() => {
				const disposers = [
					ctx.remote.$on("commands/change", () => {
						syncHidden();
					}),
					ctx.remote.$on("settings/document-updated", (ns) => {
						if (ns === "command-setting") syncHidden();
					}),
					ctx.on("connection/reset", () => {
						syncHidden();
					})
				];
				syncHidden();
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "command-setting: menu filter sync");

			// Restore the shadowed command surface on dispose so a stop/start cycle
			// never stacks the browser-side filter and a stopped plugin leaves the
			// command menu exactly as it found it.
			return () => {
				commandUi.candidates = originalCandidates;
				commandUi.matchEnter = originalMatchEnter;
				commandUi.matchSpace = originalMatchSpace;
			};
		}

		exports.CommandsSettingController = CommandsSettingController;
		exports.CommandsSettingSection = CommandsSettingSection;
		exports.PlanModeToggle = PlanModeToggle;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
