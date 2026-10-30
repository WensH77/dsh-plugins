// dsh-plugin-graceful-inject — 浏览器端。
//
// 「优雅注入」的功能二「监工」的按钮：会话标题栏 actions 区里一个秒表图标，点一下
// 让宿主往当前会话注入「不要停止你现在手头的事情，汇报当前任务进度」。
//
// 按钮是否出现由宿主开关决定：每次挂载 GET /graceful-inject/state，`supervise: true`
// 才画。开关写在 profile 的 cordis.patch.yml（见 README「配置」），浏览器端不重复
// 实现一套；不缓存结果，运行期关掉之后下一次挂载就不再画。
//
// 点击走 POST /graceful-inject/supervise?session=<id>。反馈分两层：
//   - 图标短暂变色（成功绿、失败红）——不依赖布局，标题栏裁不掉；
//   - 失败原因写 aria-label（读屏可读）与控制台。不画浮层提示：这个槽位在标题栏
//     titleCluster 内，overflow:clip + mask，绝对定位的浮层会被裁掉。
window.__ModuleLoader__.load({
	id: "dsh-plugin-graceful-inject",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useCallback, useEffect, useRef, useState } = react;
		const h = react.createElement;

		// ── styles（注入一次，重复加载不叠加） ────────────────────────────────
		const css = [
			".gi-wrap{display:inline-flex}",
			".gi-action{flex:none;width:28px;height:28px;padding:5px;border:none;border-radius:28px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;justify-content:center;align-items:center}",
			".gi-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".gi-action:disabled{opacity:.5;cursor:default}",
			".gi-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			// 标题栏会裁掉溢出内容，反馈只能放在按钮自身：注入成功/失败时图标短暂变色。
			".gi-action[data-state=ok]{color:var(--dsw-alias-state-success-primary)}",
			".gi-action[data-state=err]{color:var(--dsw-alias-state-error-primary)}"
		].join("");
		const tagId = "dsh-plugin-graceful-inject/supervise.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-graceful-inject";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── 文案 ──────────────────────────────────────────────────────────────
		const NS = "gracefulInject";
		const ID = "dsh-plugin-graceful-inject";
		const STATE_URL = "/graceful-inject/state";
		const SUPERVISE_URL = "/graceful-inject/supervise";

		const zh = {
			"supervise": "监工：不要停止手头的事，汇报当前任务进度",
			"disabled": "监工已在配置中关闭（cordis.patch.yml 的 supervise: false）",
			"remote": "监工只接受来自本部署页面的请求（dsh web 绑定在非 loopback 地址时不可用）",
			"noAgent": "这个会话没有活跃的 Agent，无法注入",
			"throttled": "10 秒内只能催一次，{seconds} 秒后再试",
			"error": "监工注入失败：{message}"
		};
		const en = {
			"supervise": "Supervise: keep going and report the current progress",
			"disabled": "Supervise is disabled in this profile (cordis.patch.yml, supervise: false)",
			"remote": "Supervise only accepts requests from this deployment's own pages",
			"noAgent": "This session has no live agent, so nothing can be injected",
			"throttled": "One press every 10 seconds — retry in {seconds}s",
			"error": "Supervise injection failed: {message}"
		};

		// ── glyph：秒表（18px outline，与标题栏其它图标同一套线） ─────────────
		const ICON_STOPWATCH = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="9.8" r="5.4" stroke-width="1.6"/><path d="M9.5 9.8V6.4M9.5 9.8l2.6 1.6" stroke-width="1.4"/><path d="M7.5 2.6h4" stroke-width="1.5"/></svg>';

		/**
		 * 读宿主开关与监工文本。请求失败按「关闭」处理：宁可不画按钮，也不要画一个点了报错的按钮。
		 * 每次挂载都问一次（不缓存）：这样运行期把 supervise 关掉后，重新挂载就不再画；
		 * 文本同理，改配置后重新挂载即同步。
		 * @returns Promise<{ enabled: boolean, text: string | null }>
		 */
		function readSuperviseState() {
			return fetch(STATE_URL, { cache: "no-store" })
				.then((response) => response.json())
				.then((body) => {
					if (body === null || typeof body !== "object" || body.ok !== true) return { enabled: false, text: null };
					return {
						enabled: body.supervise === true,
						text: typeof body.superviseText === "string" && body.superviseText !== "" ? body.superviseText : null
					};
				})
				.catch((error) => {
					console.warn("graceful-inject: 读取开关失败，监工按钮不显示: " + String((error && error.message) || error));
					return { enabled: false, text: null };
				});
		}

		/**
		 * 端点地址（会话 id 走 query，与宿主 handler 对应）。
		 * @param sessionId - 当前会话 id。
		 * @returns 监工端点 URL。
		 */
		function superviseUrl(sessionId) {
			return SUPERVISE_URL + "?session=" + encodeURIComponent(sessionId);
		}

		/**
		 * 宿主失败响应 → 展示文案。
		 * @param t - 本地化函数。
		 * @param body - 宿主返回的 JSON（可能为 null）。
		 * @param status - HTTP 状态。
		 * @returns 给 aria-label 与 console 的文本。
		 */
		function failureText(t, body, status) {
			if (body !== null && body !== undefined) {
				if (body.code === "disabled") return t("disabled");
				if (body.code === "remote") return t("remote");
				if (body.code === "no-agent") return t("noAgent");
				if (body.code === "throttled") return t("throttled", { seconds: body.retryAfter === undefined ? 10 : body.retryAfter });
				if (typeof body.message === "string" && body.message !== "") return t("error", { message: body.message });
			}
			return t("error", { message: "HTTP " + status });
		}

		// ── 标题栏按钮 ────────────────────────────────────────────────────────
		/**
		 * 会话标题栏的秒表按钮。
		 * @param props - 插槽注入的 sessionId 与本地化函数 t。
		 * @returns React 元素（开关关闭时渲染空）。
		 */
		function SuperviseAction({ sessionId, t }) {
			const [enabled, setEnabled] = useState(false);
			const [text, setText] = useState(null);
			const [busy, setBusy] = useState(false);
			const [state, setState] = useState(null);
			const [failure, setFailure] = useState(null);
			const alive = useRef(true);
			const stateTimer = useRef(null);

			useEffect(() => {
				alive.current = true;
				readSuperviseState().then((remote) => {
					if (!alive.current) return;
					setEnabled(remote.enabled);
					setText(remote.text);
				});
				return () => {
					alive.current = false;
					clearTimeout(stateTimer.current);
				};
			}, []);

			/** 图标短暂变色；失败时把原因留在 aria-label 上，视觉恢复后读屏仍能拿到。 */
			const flash = useCallback((kind, reason) => {
				setState(kind);
				setFailure(reason === undefined ? null : reason);
				clearTimeout(stateTimer.current);
				stateTimer.current = setTimeout(() => {
					setState(null);
					setFailure(null);
				}, kind === "err" ? 3000 : 1600);
			}, []);

			const run = useCallback(async () => {
				if (busy || typeof sessionId !== "string" || sessionId === "") return;
				setBusy(true);
				try {
					const response = await fetch(superviseUrl(sessionId), { method: "POST", cache: "no-store" });
					const body = await response.json().catch(() => null);
					if (body !== null && body.ok === true) {
						flash("ok");
					} else {
						const reason = failureText(t, body, response.status);
						console.warn("graceful-inject: 监工注入失败: " + reason);
						flash("err", reason);
					}
				} catch (error) {
					const reason = t("error", { message: String((error && error.message) || error) });
					console.warn("graceful-inject: 监工请求失败: " + reason);
					flash("err", reason);
				} finally {
					setBusy(false);
				}
			}, [busy, sessionId, t, flash]);

			if (!enabled || typeof sessionId !== "string" || sessionId === "") return null;

			const label = failure === null ? (text === null ? t("supervise") : text) : failure;
			const icon = h("span", { "aria-hidden": "true", dangerouslySetInnerHTML: { __html: ICON_STOPWATCH } });
			return h("span", { className: "gi-wrap" },
				h("button", {
					type: "button",
					className: "gi-action",
					"aria-label": label,
					title: label,
					disabled: busy,
					"data-state": state === null ? undefined : state,
					"data-graceful-inject-supervise": true,
					onClick: run
				}, icon)
			);
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "graceful-inject: dictionaries");
			ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: ID,
				order: 60,
				locale: NS,
				inject: (sessionId) => ({ sessionId })
			}, SuperviseAction)), "graceful-inject: supervise button");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.failureText = failureText;
		exports.readSuperviseState = readSuperviseState;
		exports.superviseUrl = superviseUrl;
		exports.ICON_STOPWATCH = ICON_STOPWATCH;
		exports.SuperviseAction = SuperviseAction;
		return module.exports;
	}
});
