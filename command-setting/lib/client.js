window.__ModuleLoader__.load({
	id: "dsh-plugin-command-setting",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useRef, useCallback } = react;
		const h = react.createElement;

		// ── styles (injected once, tagged like the built bundles) ──────────────
		const css = [
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
			".rS3zOq_wrap{display:none!important}",
			// 划词引用浮标：选中消息文本后贴着选区上方浮出的小胶囊。
			// hover 用不透明底色（interactive-bg-hover 是半透明叠加色，会让按钮发灰发透）。
			".hc-quotebtn{position:fixed;z-index:2147483000;transform:translate(-50%,-100%);align-items:center;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;box-shadow:var(--dsw-elevation-prominent)}",
			".hc-quotebtn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1)));border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}"
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
			planLabel: "Plan",
			planEnter: "plan mode 已关闭 — 点击开启（/plan）",
			planExit: "plan mode 已开启 — 点击关闭（/plan off）",
			planError: "plan 命令执行失败",
			askLabel: "Ask",
			askEnter: "ask 模式（只问答）已关闭 — 点击开启（/ask）",
			askExit: "ask 模式（只问答）已开启 — 点击关闭（/ask off）",
			askError: "ask 命令执行失败",
			askLoading: "…",
			hashSection: "会话引用（#）",
			hashOtherWorkspaces: "其他工作区",
			hashCurrentWorkspace: "当前工作区",
			hashNow: "刚刚",
			hashMinutes: "{n}分钟",
			hashHours: "{n}小时",
			hashDays: "{n}天",
			hashMonths: "{n}个月",
			hashYears: "{n}年",
			hashNoCwd: "（无工作目录）",
			quote: "引用",
		};
		const en = {
			planLabel: "Plan",
			planEnter: "Plan mode off — click to turn on (/plan)",
			planExit: "Plan mode on — click to turn off (/plan off)",
			planError: "failed to run the plan command",
			askLabel: "Ask",
			askEnter: "Ask mode (Q&A only) off — click to turn on (/ask)",
			askExit: "Ask mode (Q&A only) on — click to turn off (/ask off)",
			askError: "failed to run the ask command",
			askLoading: "…",
			hashSection: "Sessions (#)",
			hashOtherWorkspaces: "Other workspaces",
			hashCurrentWorkspace: "Current workspace",
			hashNow: "now",
			hashMinutes: "{n}min",
			hashHours: "{n}h",
			hashDays: "{n}d",
			hashMonths: "{n}mo",
			hashYears: "{n}y",
			hashNoCwd: "(no cwd)",
			quote: "Quote",
		};

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

		// ── externalized ask-mode toggle ────────────────────────────────────
		// Always-visible button placed LEFT of the plan button (slot order -1).
		// Active state is fetched from the host (/command-setting/ask-state);
		// clicking runs /ask (enter) or /ask off (leave).
		function AskModeToggle(props) {
			const { t, sessionId, execute } = props;
			const [active, setActive] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const aliveRef = useRef(true);
			useEffect(() => {
				aliveRef.current = true;
				return () => { aliveRef.current = false; };
			}, []);
			const restore = useCallback(async () => {
				if (sessionId === void 0 || sessionId === "") return;
				try {
					const res = await fetch("/command-setting/ask-state?session=" + encodeURIComponent(sessionId), { cache: "no-store" });
					const data = await res.json();
					if (aliveRef.current) setActive(data !== null && typeof data === "object" && data.ok === true && data.active === true);
				} catch (_askStateFailure) {
					// keep local state
				}
			}, [sessionId]);
			useEffect(() => { void restore(); }, [restore]);
			const onToggle = async () => {
				if (busy || sessionId === void 0) return;
				setBusy(true);
				setError(null);
				try {
					const failure = await execute(sessionId, active ? "/ask off" : "/ask");
					if (failure !== null) setError(failure);
					else void restore();
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				}
				setBusy(false);
			};
			return h("button", {
				type: "button",
				className: "hc-planbtn", // 与 Plan 按钮共用同一套样式（外形/激活高亮一致）
				"data-active": active ? "true" : "false",
				"aria-label": t(active ? "askExit" : "askEnter"),
				title: error === null ? t(active ? "askExit" : "askEnter") : t("askError") + ": " + error,
				disabled: busy,
				onClick: onToggle
			}, t("askLabel"));
		}

		// ── '#' session reference (cross-workspace / unarchived / main-agent) ──
		// 宿主的 input-trigger 只识别 '/' 与 '@'（TriggerChar 是封闭联合），'#'
		// 无法直接注册。这里给每个会话 controller 包一层：把活跃的 `#token` 在
		// **同一 span** 上改写成等价的 `@token`，交给宿主自己的探测器产出 hit；
		// 再在 controller 的 source roster 上拦截——这个 hit 只解析到 '#' 源，
		// 不会混进 '@' 的文件/会话统一菜单。
		/** 注册进 inputTriggers 的 '#' 源名（也是 ReferenceInsert.source）。 */
		const HASH_SOURCE = "command-setting-sessions";
		/** 与 reference 的 time.* 同义，本命名空间自带一份时间档位键。 */
		const HASH_TIME_KEYS = { minutes: "hashMinutes", hours: "hashHours", days: "hashDays", months: "hashMonths", years: "hashYears" };

		/**
		 * 在 caret 处探测活跃的 `#` 引用 token。沿用宿主 '@' 的词边界规则：'#' 只在
		 * 草稿开头或空白之后开启，token 一路延伸到 caret 且不含空白。
		 * @returns `{ start, end, query }`，或 null（无活跃 '#' token）。
		 */
		function hashTokenAt(draft, caret) {
			if (typeof draft !== "string" || !Number.isInteger(caret) || caret < 0 || caret > draft.length) return null;
			let index = caret - 1;
			while (index >= 0 && !/\s/u.test(draft.charAt(index))) index -= 1;
			const start = index + 1;
			if (draft.charAt(start) !== "#") return null;
			return { start, end: caret, query: draft.slice(start + 1, caret) };
		}

		/** 相对时间档位（与宿主 relativeTime 同粒度，文案在本命名空间）。 */
		function hashAge(updatedAt, now) {
			const delta = Math.max(0, now - (typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : now));
			const minutes = Math.floor(delta / 60000);
			if (minutes < 1) return { unit: "now" };
			if (minutes < 60) return { unit: "minutes", n: minutes };
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return { unit: "hours", n: hours };
			const days = Math.floor(hours / 24);
			if (days < 30) return { unit: "days", n: days };
			const months = Math.floor(days / 30);
			if (months < 12) return { unit: "months", n: months };
			return { unit: "years", n: Math.floor(months / 12) };
		}

		/** POSIX home 缩写成 `~`（与宿主的显示口径一致；Windows 路径原样保留）。 */
		function shortenHomePath(path, home) {
			if (typeof path !== "string" || typeof home !== "string" || home === "") return path;
			if (/^[A-Za-z]:[/\\]/u.test(path) || path.startsWith("\\\\") || /^[A-Za-z]:[/\\]/u.test(home)) return path;
			const root = home.replace(/\/+$/u, "");
			if (root === "" || root === "/") return path;
			if (path.replace(/\/+$/u, "") === root) return "~";
			if (path.startsWith(root + "/")) return "~" + path.slice(root.length);
			return path;
		}

		/** '#' 菜单分组上限：其他工作区 / 当前工作区 各自最多展示的行数。 */
		const HASH_BUCKET_LIMIT = 25;

		/** base64url（无填充）。会话 id 为 ASCII（UUID），与宿主 encodeSessionReferenceUri 的载荷一致。 */
		function base64UrlEncode(text) {
			return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
		}

		/** 规范会话 mention：`@[label](dsh-session:<base64url(JSON id)>)`（与宿主同构，label 转义 \ 与 ]）。 */
		function formatSessionMention(label, sessionId) {
			const text = label === void 0 || label === "" ? sessionId : String(label);
			const escaped = text.replace(/[\\\]]/gu, (match) => "\\" + match);
			return "@[" + escaped + "](dsh-session:" + base64UrlEncode(JSON.stringify(sessionId)) + ")";
		}

		/** 工作区 path → 工作区名（title）映射，供跨工作区候选显示名字而非路径。 */
		function hashWorkspaceNames(workspaces) {
			const byPath = new Map();
			for (const item of Array.isArray(workspaces?.items) ? workspaces.items : []) {
				if (item === null || typeof item !== "object") continue;
				if (typeof item.path !== "string" || item.path === "" || typeof item.title !== "string" || item.title === "") continue;
				byPath.set(item.path, item.title);
			}
			return byPath;
		}

		/**
		 * 从客户端会话列表挑出 '#' 候选：排除自身、subagent 子会话、空会话与已归档，
		 * 再按 query（标题 / 会话 id / 工作目录，大小写不敏感）过滤。
		 *
		 * 直接读客户端列表，而不是宿主的 `sessionReferenceResolver.candidates`：
		 * 后者默认只取 `candidateLimit`（50）条、且**同 cwd 优先**排序后截断——
		 * 当前工作区会话一多（实测 300+），跨工作区候选会被整段挤掉，表现就是
		 * 「# 只能 attach 当前工作区会话」。客户端列表含全部工作区，且自带
		 * displayTitle，因此这里自行组装候选与规范 mention。
		 * @param workspaceNames - 工作区 path → 名字映射（未注册目录没有条目）。
		 */
		function hashEntries(session, query, list, archived, workspaceNames) {
			const needle = typeof query === "string" ? query.toLocaleLowerCase() : "";
			const byId = list.byId ?? {};
			const currentCwd = byId[session.sessionId]?.cwd;
			const entries = [];
			for (const id of Array.isArray(list.ids) ? list.ids : []) {
				if (id === session.sessionId) continue; // 自身不可引用（宿主同样拒绝）
				if (!/^[A-Za-z0-9_-]+$/u.test(id)) continue; // mention URI 只编码 ASCII id
				const summary = byId[id];
				if (summary === void 0) continue;
				if (summary.origin === "subagent") continue; // 仅主代理
				if (summary.blank === true) continue; // 空会话没有可引用的历史
				if (archived !== null && archived !== void 0 && typeof archived.has === "function" && archived.has(id)) continue;
				const label = summary.displayTitle || summary.title || id;
				const cwd = summary.cwd;
				if (needle !== "" && !id.toLocaleLowerCase().includes(needle) && !(cwd ?? "").toLocaleLowerCase().includes(needle) && !label.toLocaleLowerCase().includes(needle)) continue;
				entries.push({
					id,
					label,
					cwd,
					workspace: typeof cwd === "string" && typeof workspaceNames?.get === "function" ? workspaceNames.get(cwd) : void 0,
					updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
					same: currentCwd !== void 0 && cwd === currentCwd
				});
			}
			return { entries, currentCwd };
		}

		/**
		 * 把候选投影成 '#' 菜单行：**其他工作区分组在前、当前工作区在后**，各自按最近
		 * 活动排序并各限 25 行——跨工作区会话因此始终可见（不再被同 cwd 排序挤出）。
		 * 跨工作区行优先显示**工作区名字**（未注册目录退回缩写的目录路径）。
		 * 无法确定当前工作目录时不分组，退回单一按最近活动排序的列表。
		 * mention 用规范形式，选中后的引用与 '@' 会话引用完全等效。
		 */
		function buildHashRows(t, entries, currentCwd, home, now) {
			const sectioned = currentCwd !== void 0;
			const other = [];
			const same = [];
			for (const entry of Array.isArray(entries) ? entries : []) {
				if (sectioned && entry.same === true) same.push(entry);
				else other.push(entry);
			}
			const byRecency = (a, b) => b.updatedAt - a.updatedAt;
			other.sort(byRecency);
			same.sort(byRecency);
			const rows = [];
			const push = (bucket, section) => {
				for (const entry of bucket.slice(0, HASH_BUCKET_LIMIT)) {
					const age = hashAge(entry.updatedAt, now);
					const ageText = age.unit === "now" ? t("hashNow") : t(HASH_TIME_KEYS[age.unit], { n: age.n });
					const location = entry.same === true
						? void 0
						: entry.workspace !== void 0
							? entry.workspace
							: entry.cwd === void 0 || entry.cwd === ""
								? t("hashNoCwd")
								: shortenHomePath(entry.cwd, home);
					rows.push({
						name: entry.label,
						description: location === void 0 ? ageText : location + " · " + ageText,
						icon: "session",
						section,
						value: JSON.stringify({ kind: "session", label: entry.label, mention: formatSessionMention(entry.label, entry.id) })
					});
				}
			};
			if (sectioned) {
				push(other, t("hashOtherWorkspaces"));
				push(same, t("hashCurrentWorkspace"));
			} else {
				push(other, t("hashSection"));
			}
			return rows;
		}

		/** 构造 '#' 源：候选来自客户端会话列表（全工作区），插入与 '@' 会话引用同构。 */
		function createHashSource(ctx, t) {
			return {
				trigger: "#",
				name: HASH_SOURCE,
				order: 0,
				showGroupTitle: false,
				async candidates(session, req) {
					try {
						const list = ctx.get("sessions")?.list.getSnapshot();
						if (list === void 0 || !Array.isArray(list.ids)) return [];
						const workspaces = ctx.get("workspaces")?.list.getSnapshot();
						const archived = new Set(workspaces?.archivedSessionIds ?? []);
						const { entries, currentCwd } = hashEntries(session, req.query, list, archived, hashWorkspaceNames(workspaces));
						return buildHashRows(t, entries, currentCwd, ctx.get("remote")?.$host?.home, Date.now());
					} catch (_hashCandidatesFailure) {
						// 候选失败保持静默（与宿主 '@' 会话候选的失败语义一致）。
						return [];
					}
				},
				onPick(pick) {
					let value;
					try {
						value = JSON.parse(pick?.candidate?.value ?? "");
					} catch (_hashPickFailure) {
						value = void 0;
					}
					if (value === null || value === void 0 || value.kind !== "session") return void 0;
					return { insert: {
						source: HASH_SOURCE,
						ref: value.mention,
						label: value.label,
						appearance: "session",
						clipboardText: value.mention
					} };
				},
				codec: {
					clipboardText: (ref) => ref,
					serialize: (ref) => Promise.resolve(ref)
				}
			};
		}

		/**
		 * 安装 '#' 触发：注册 '#' 源 + 包装 input-trigger 的会话 controller。
		 *
		 * controller 包装把 `#token` 改写成 `@token`（span 不变）再交给宿主原
		 * `track`，同时拦截该 controller 的 roster：这一 hit 的 span.start 命中
		 * '#' token 时，'@' 查询只返回 '#' 源。返回的 disposer 还原所有改动
		 * （停用插件后命令菜单/输入触发器回到宿主原样）。
		 * @param inputTriggers - `ctx.inputTriggers` 服务实例。
		 * @param source - '#' 触发源。
		 * @returns disposer（源注册失败时返回 undefined）。
		 */
		function installHashTrigger(inputTriggers, source) {
			if (inputTriggers === null || inputTriggers === void 0 || typeof inputTriggers.registerSource !== "function" || typeof inputTriggers.sessionOf !== "function") return void 0;
			let unregisterSource;
			try {
				unregisterSource = inputTriggers.registerSource(source);
			} catch (error) {
				console.warn("[command-setting] '#' session source registration failed:", error);
				return void 0;
			}
			const wrapped = new Set();
			const wrap = (controller) => {
				if (controller === null || controller === void 0 || wrapped.has(controller)) return;
				const roster = controller.deps?.roster;
				if (roster === void 0 || typeof roster.sources !== "function" || typeof controller.track !== "function") return;
				wrapped.add(controller);
				const hadOwnTrack = Object.prototype.hasOwnProperty.call(controller, "track");
				const ownTrack = controller.track;
				const originalSources = roster.sources;
				const originalTrack = controller.track.bind(controller);
				roster.sources = (trigger) => {
					const marker = controller.__commandSettingHashToken;
					const hit = controller.hit;
					if (trigger === "@" && marker !== null && marker !== void 0 && hit !== null && hit.span.start === marker.start) {
						return originalSources("#");
					}
					return originalSources(trigger);
				};
				controller.track = (draft, caret, guard, draftRev) => {
					const token = guard?.tier === "frozen" ? null : hashTokenAt(draft, caret);
					const previous = controller.__commandSettingHashToken;
					controller.__commandSettingHashToken = token;
					// '#' 与 '@' 在同一位置同 query 时 hit 字段完全一致，宿主 track 的
					// `same` 短路会把旧 source 的菜单留在屏上（例如把已开的 `@ab` 改成
					// `#ab`）。哈希性质切换时先关菜单，让原 track 按新 roster 重新播种。
					if ((token === null) !== (previous === null || previous === void 0)) {
						controller.hit = null;
						if (typeof controller.stopFetch === "function") controller.stopFetch();
						if (typeof controller.reduce === "function") controller.reduce({ type: "close" });
					}
					if (token === null) return originalTrack(draft, caret, guard, draftRev);
					const rewritten = draft.slice(0, token.start) + "@" + draft.slice(token.start + 1);
					return originalTrack(rewritten, caret, guard, draftRev);
				};
				controller.__commandSettingHashRestore = () => {
					roster.sources = originalSources;
					if (hadOwnTrack) controller.track = ownTrack;
					else delete controller.track;
					delete controller.__commandSettingHashToken;
					delete controller.__commandSettingHashRestore;
				};
			};
			const controllers = inputTriggers.live?.controllers;
			if (controllers !== void 0 && typeof controllers.values === "function") {
				for (const controller of controllers.values()) wrap(controller);
			}
			// 晚建的会话 scope 走 sessionOf；包一层实例方法覆盖住后续 controller。
			const hadOwnSessionOf = Object.prototype.hasOwnProperty.call(inputTriggers, "sessionOf");
			const ownSessionOf = inputTriggers.sessionOf;
			const originalSessionOf = inputTriggers.sessionOf.bind(inputTriggers);
			inputTriggers.sessionOf = (actx) => {
				const controller = originalSessionOf(actx);
				wrap(controller);
				return controller;
			};
			return () => {
				if (hadOwnSessionOf) inputTriggers.sessionOf = ownSessionOf;
				else delete inputTriggers.sessionOf;
				for (const controller of wrapped) {
					if (typeof controller.__commandSettingHashRestore === "function") controller.__commandSettingHashRestore();
				}
				wrapped.clear();
				if (typeof unregisterSource === "function") unregisterSource();
			};
		}

		// ── 划词引用（选中消息文本 → 浮标「引用」→ 追加进 composer） ──────────
		// 纯 DOM 实现：宿主没有暴露"选中→引用"的插槽或服务，这里监听全局选区，
		// 选中落在消息滚动区内（排除 composer 自身）时在选区上方浮出按钮，点击
		// 把选中文本转成 Markdown 引用块（每行 `> `）追加到当前会话草稿末尾。
		/** 引用浮标的样式类（同一时刻只存在一个按钮实例）。 */
		const QUOTE_BUTTON_CLASS = "hc-quotebtn";
		/** 只对消息滚动区内的选区生效；composer / 输入控件内的选区不弹浮标。 */
		const QUOTE_SCOPE_SELECTOR = "[data-conversation-scroll]";
		const QUOTE_EXCLUDE_SELECTOR = "[data-composer-seat], input, textarea, [contenteditable=\"true\"]";

		/** 选中文本 → 引用块：逐行加 `> `（空行保留 `>`），首尾空白裁掉。 */
		function quoteSelectionText(text) {
			if (typeof text !== "string") return "";
			const trimmed = text.replace(/^\s+|\s+$/gu, "");
			if (trimmed === "") return "";
			return trimmed.split(/\r?\n/u).map((line) => (line.trim() === "" ? ">" : "> " + line)).join("\n");
		}

		/** 把引用块追加到草稿末尾：草稿非空时先空一行，引用块后也留一空行供继续输入。 */
		function appendQuoteToDraft(draft, quote) {
			const base = typeof draft === "string" ? draft.replace(/\s+$/u, "") : "";
			if (quote === "") return base;
			return (base === "" ? "" : base + "\n\n") + quote + "\n\n";
		}

		/**
		 * 判定当前选区是否可引用：非折叠、有文本、落在消息滚动区内且不在
		 * composer / 输入控件内，并给出浮标锚点矩形。
		 * @param selection - `window.getSelection()` 的返回值（测试可传等价对象）。
		 * @returns `{ text, rect }` 或 null。
		 */
		function quoteAnchor(selection) {
			if (selection === null || selection === void 0 || selection.isCollapsed !== false || selection.rangeCount < 1) return null;
			const text = selection.toString().replace(/^\s+|\s+$/gu, "");
			if (text === "") return null;
			const range = selection.getRangeAt(0);
			const node = range.commonAncestorContainer;
			const element = node !== null && node !== void 0 && node.nodeType === 1 ? node : node?.parentElement;
			if (element === null || element === void 0 || typeof element.closest !== "function") return null;
			if (element.closest(QUOTE_EXCLUDE_SELECTOR) !== null) return null;
			if (element.closest(QUOTE_SCOPE_SELECTOR) === null) return null;
			const rect = range.getBoundingClientRect();
			if (rect === null || rect === void 0 || (rect.width === 0 && rect.height === 0)) return null;
			return { text, rect };
		}

		/**
		 * 解析「当前会话」id：优先主视图保留的会话（`retainedBy.mainView > 0`，
		 * 与宿主 `mainSessionId` 同构），其次列表快照上遗留的 `current`，最后列表首个 id。
		 *
		 * 客户端的 `sessions.list` 快照只发 `ids` / `byId` / `phase` /
		 * `projectionsBySession`（`dsh-api-session-controller`），**没有 `current`**；
		 * 曾按 `snapshot.current` 取 id，结果恒为 undefined，划词引用静默 no-op。
		 * @param list - `sessions.list.getSnapshot()` 的返回值。
		 * @returns 会话 id，或 undefined（无可用会话）。
		 */
		function quoteSessionId(list) {
			if (list === null || list === void 0) return void 0;
			const byId = list.byId ?? {};
			for (const [id, row] of Object.entries(byId)) {
				if (((row ?? {}).retainedBy?.mainView ?? 0) > 0 && id !== "") return id;
			}
			const legacy = list.current;
			if (typeof legacy === "string" && legacy !== "") return legacy;
			return Array.isArray(list.ids) && typeof list.ids[0] === "string" ? list.ids[0] : void 0;
		}

		/**
		 * 把选中文本追加到当前会话 composer（草稿末尾，光标停在引用块下方）。
		 * 草稿里已有原子引用 chip 时走 `paste`（`setDraft` 会把 chip 压成纯文本）。
		 * @returns 是否写入成功。
		 */
		function insertQuote(ctx, text) {
			const quote = quoteSelectionText(text);
			if (quote === "") return false;
			const sessionId = quoteSessionId(ctx.get("sessions")?.list.getSnapshot());
			if (typeof sessionId !== "string" || sessionId === "") return false;
			let shell;
			try {
				shell = ctx.get("conversation")?.input?.shell?.(sessionId);
			} catch (_quoteShellFailure) {
				return false; // 会话还没有 composer shell（未 materialize）
			}
			if (shell === null || shell === void 0) return false;
			const snapshot = typeof shell.state?.getSnapshot === "function" ? shell.state.getSnapshot() : void 0;
			const draft = typeof snapshot?.draft === "string" ? snapshot.draft : "";
			const hasReferences = Array.isArray(snapshot?.occurrences) && snapshot.occurrences.length > 0;
			if (hasReferences && typeof shell.paste === "function") {
				shell.paste((draft.replace(/\s+$/u, "") === "" ? "" : "\n\n") + quote + "\n\n");
				return true;
			}
			if (typeof shell.setDraft !== "function") return false;
			shell.setDraft(appendQuoteToDraft(draft, quote));
			return true;
		}

		/**
		 * 安装划词引用浮标。返回 disposer（无 DOM 环境返回 undefined），随插件
		 * 停用移除按钮与全部监听。
		 * @param ctx - 插件 root ctx（读取 sessions / conversation 服务）。
		 * @param t - 本命名空间字典。
		 */
		function installQuoteSelection(ctx, t) {
			if (typeof document === "undefined" || typeof window === "undefined" || typeof document.addEventListener !== "function" || typeof window.getSelection !== "function") return void 0;
			const button = document.createElement("button");
			button.type = "button";
			button.className = QUOTE_BUTTON_CLASS;
			button.hidden = true;
			button.dataset.plugin = "command-setting";
			let text = "";
			let pressing = false;
			const hide = () => {
				text = "";
				button.hidden = true;
			};
			const show = (anchor) => {
				text = anchor.text;
				button.textContent = t("quote");
				const half = 44;
				button.style.left = Math.min(Math.max(anchor.rect.left + anchor.rect.width / 2, half), Math.max(half, window.innerWidth - half)) + "px";
				button.style.top = Math.max(anchor.rect.top - 8, 8) + "px";
				button.hidden = false;
			};
			const refresh = () => {
				const anchor = quoteAnchor(window.getSelection());
				if (anchor === null) hide();
				else show(anchor);
			};
			const onPointerUp = (event) => {
				pressing = false;
				if (event.target === button) return;
				// 等浏览器完成选区更新（pointerup 时 selection 可能还是旧的）。
				setTimeout(refresh, 0);
			};
			const onPointerDown = (event) => {
				if (event.target !== button) hide();
			};
			const onSelectionChange = () => {
				if (pressing) return; // 点浮标时保住选区
				const selection = window.getSelection();
				if (selection === null || selection.isCollapsed || selection.toString().replace(/^\s+|\s+$/gu, "") === "") hide();
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape") hide();
			};
			const onButtonDown = (event) => {
				pressing = true;
				event.preventDefault(); // mousedown 默认会清掉选区
			};
			const onButtonClick = () => {
				pressing = false;
				if (text !== "" && insertQuote(ctx, text)) {
					window.getSelection()?.removeAllRanges?.();
					const editor = document.querySelector("[data-composer-seat] [data-lexical-editor]");
					if (editor !== null && editor !== void 0 && typeof editor.focus === "function") editor.focus();
				}
				hide();
			};
			document.body.appendChild(button);
			button.addEventListener("pointerdown", onButtonDown);
			button.addEventListener("click", onButtonClick);
			document.addEventListener("pointerup", onPointerUp, true);
			document.addEventListener("pointerdown", onPointerDown, true);
			document.addEventListener("selectionchange", onSelectionChange);
			document.addEventListener("keydown", onKeyDown, true);
			window.addEventListener("scroll", hide, true);
			return () => {
				button.removeEventListener("pointerdown", onButtonDown);
				button.removeEventListener("click", onButtonClick);
				document.removeEventListener("pointerup", onPointerUp, true);
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("selectionchange", onSelectionChange);
				document.removeEventListener("keydown", onKeyDown, true);
				window.removeEventListener("scroll", hide, true);
				if (typeof button.remove === "function") button.remove();
			};
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		// "remote.commands" is a separately mounted namespace service (remote.<ns>);
		// property access only resolves once it is injected, like ui-plan does.
		// commandUi 已不需要：0.9.0 起不再过滤命令菜单（命令隐藏功能移除）。
		const inject = ["slots", "locale", "sessions", "remote", "remote.commands"];

		/** 执行一条 slash 命令并返回失败说明（成功返回 null）。Plan/Ask 两个外置
		 * 切换按钮共用。images 必须显式传：commands/execute 的 wire 契约为
		 * (agentId, line, images)，images 是必填严格数组参数——省略会校验失败。 */
		async function executeSlashCommand(ctx, sid, line) {
			const result = await ctx.remote.commands.execute(sid, line, []);
			if (!result.ok) return result.error.message + " (" + result.error.code + ")";
			if (result.value === void 0) return "unknown command: " + line;
			return null;
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "command-setting: dictionaries");
			const t = ctx.locale.bind(NS);

			// '#' 会话引用（跨工作区 / 未归档 / 主代理）：依赖 input-trigger 管线，
			// 该管线缺失时特性静默不启用（其余功能不受影响）。
			ctx.inject(["inputTriggers"], (inputCtx) => {
				const inputTriggers = inputCtx.inputTriggers;
				if (inputTriggers === void 0 || typeof inputTriggers.registerSource !== "function") return void 0;
				return installHashTrigger(inputTriggers, createHashSource(ctx, t));
			});

			// 划词引用：选中消息文本浮出「引用」按钮，点击追加到当前 composer。
			ctx.effect(() => installQuoteSelection(ctx, t), "command-setting: quote selection");

			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "plan-mode-toggle",
				order: 0,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					execute: (sid, line) => executeSlashCommand(ctx, sid, line)
				})
			}, PlanModeToggle));

			// Ask 按钮：注册到同一输入栏左槽，order -1 → 排在 plan（order 0）之前。
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "ask-mode-toggle",
				order: -1,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					execute: (sid, line) => executeSlashCommand(ctx, sid, line)
				})
			}, AskModeToggle));
		}

		exports.PlanModeToggle = PlanModeToggle;
		exports.AskModeToggle = AskModeToggle;
		exports.HASH_SOURCE = HASH_SOURCE;
		exports.buildHashRows = buildHashRows;
		exports.formatSessionMention = formatSessionMention;
		exports.hashEntries = hashEntries;
		exports.hashTokenAt = hashTokenAt;
		exports.hashWorkspaceNames = hashWorkspaceNames;
		exports.appendQuoteToDraft = appendQuoteToDraft;
		exports.installQuoteSelection = installQuoteSelection;
		exports.insertQuote = insertQuote;
		exports.quoteSessionId = quoteSessionId;
		exports.quoteAnchor = quoteAnchor;
		exports.quoteSelectionText = quoteSelectionText;
		exports.installHashTrigger = installHashTrigger;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
