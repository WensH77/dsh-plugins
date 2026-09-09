window.__ModuleLoader__.load({
	id: "dsh-plugin-arena-v2",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region ArenaChip.module.css
		// 样式对齐 command-setting 的 plan 开关（hc-planbtn）：带边框胶囊，
		// 开启态用 business tertiary 填充 + primary 文字。
		// 另含空白页 hero 开关样式（竞技场 pill + 场景分段控件，模仿 model-arena
		// v1 的 hero toggle / scene seg——去掉模型选择与 skill）。
		const css = ".rArena_wrap{align-items:center;gap:6px;display:inline-flex;position:relative}.rArena_chip{align-items:center;gap:4px;min-width:34px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-selector);border-radius:999px;padding:0 10px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.rArena_chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.rArena_chip[data-active=true]{background:var(--dsw-alias-state-business-tertiary);border-color:transparent;color:var(--dsw-alias-state-business-primary)}.rArena_chip[data-active=true]:hover{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}.rArena_chip:disabled{opacity:.6;cursor:default}.rArena_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.ra2-hero{flex:none;align-items:center;gap:8px;min-width:0;display:inline-flex}.ra2-toggle{flex:none;min-height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 10px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.ra2-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.ra2-toggle[aria-pressed=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}.ra2-toggle[aria-pressed=true]:hover{color:var(--dsw-alias-state-business-primary)}.ra2-toggle:disabled{opacity:.6;cursor:default}.ra2-sceneSeg{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex:none;padding:3px;display:inline-flex;gap:3px;position:relative}.ra2-sceneBtn{min-height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:7px;padding:0 14px;font-size:13px;line-height:20px;white-space:nowrap;position:relative;z-index:1}.ra2-sceneBtn:hover{color:var(--dsw-alias-label-primary)}.ra2-sceneBtn[aria-pressed=true]{color:var(--dsw-alias-state-business-primary);font-weight:500}.ra2-thumb{position:absolute;top:3px;left:0;bottom:3px;border-radius:7px;background:var(--dsw-alias-state-business-tertiary);transition:transform .18s var(--ds-ease-in-out,ease),width .18s var(--ds-ease-in-out,ease);pointer-events:none;z-index:0}@media (prefers-reduced-motion:reduce){.ra2-thumb{transition:none}}.ra2-heroError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.ra2-chipScenes{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);border-radius:10px;align-items:center;gap:2px;padding:4px;display:inline-flex;animation:ra2-pop-in .14s var(--ds-ease-in-out)}.ra2-chipScenes::before{content:\"\";position:absolute;top:100%;left:0;right:0;height:8px}.ra2-chipScenes .ra2-sceneBtn[aria-pressed=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}@keyframes ra2-pop-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){.ra2-chipScenes{animation:none}}.ra2-settingsCard{flex-direction:column;gap:14px;max-width:760px;display:flex}.ra2-settingsHead{margin:0;font-size:18px;font-weight:600;line-height:26px}.ra2-settingsDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}.ra2-settingsTabs{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:4px;display:flex}.ra2-settingsTab{min-height:34px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:1px solid transparent;border-bottom:none;border-radius:9px 9px 0 0;padding:0 16px;font-size:13px;font-weight:500;line-height:20px;position:relative;top:1px}.ra2-settingsTab:hover:not(.ra2-settingsTabActive){color:var(--dsw-alias-label-primary)}.ra2-settingsTabActive{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);border-color:var(--dsw-alias-border-l2);border-bottom-color:transparent;font-weight:600}.ra2-settingsScene{border:1px solid var(--dsw-alias-border-l2);border-radius:0 12px 12px 12px;flex-direction:column;gap:6px;padding:12px 14px;display:flex}.ra2-settingsSceneTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}.ra2-settingsShared{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}.ra2-settingsPromptLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px;margin-top:4px}.ra2-settingsPrompt{margin:0;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-markdown-code-block);border-radius:8px;padding:8px 10px;font:400 12px/18px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-word}.ra2-settingsError{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}";
		const tagId = "dsh-plugin-arena-v2/ArenaChip.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-arena-v2";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ArenaChip_module_css_default = {
			"chip": "rArena_chip",
			"error": "rArena_error",
			"wrap": "rArena_wrap"
		};
		//#endregion
		// 双入口（输入栏 chip + 空白页 hero 开关）共用同一份宿主侧状态（侧文件）：
		// 任一切换开关 / 保存场景成功后 emit，两个入口都重新拉取 /arena-v2/state。
		const arenaBus = {
			listeners: new Set(),
			subscribe(fn) {
				arenaBus.listeners.add(fn);
				return () => {
					arenaBus.listeners.delete(fn);
				};
			},
			emit() {
				for (const fn of [...arenaBus.listeners]) {
					try {
						fn();
					} catch (_listenerFailure) {
						// 单个监听器崩溃不得影响其它入口
					}
				}
			}
		};
		//#region ArenaChip.js
		/**
		* 竞技场开关 chip：样式与 command-setting 的 plan 开关一致（带边框胶囊，
		* 开启态 business 高亮）。
		* - 会话**已有挑战者**（hasChallenger）：场景锁定——chip 是普通开关（点击
		*   /arena 用原场景开启、/arena off 关闭），不显示场景选择。
		* - 会话**无挑战者**：hover / 键盘聚焦展开场景分段控件（同空对话态控件），
		*   点场景即以该场景开启（/arena <scene>）；点 chip 本体以默认场景（business）
		*   开启。首条消息后宿主创建该场景挑战者，此后场景锁定。
		* 开关态在挂载 / 切换会话时从宿主侧文件恢复（/arena-v2/state 路由），
		* 刷新页面不丢；点击切换成功后本地同步并通知空白页 hero 开关同步。
		*/
		function ArenaChip({ toggleArena, enableScene, t, sessionId }) {
			const [active, setActive] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			// 宿主状态：场景 + 挑战者存在性（决定是否显示场景选择）。
			const [meta, setMeta] = (0, react.useState)(null);
			// hover / 聚焦是否展开场景分段控件（仅无挑战者的会话展示）。
			const [expanded, setExpanded] = (0, react.useState)(false);
			// 场景保存防重入（纯逻辑守卫，不写 disabled、不进视觉）。
			const [sceneBusy, setSceneBusy] = (0, react.useState)(false);
			const wrapRef = (0, react.useRef)(null);
			const aliveRef = (0, react.useRef)(true);
			// 恢复令牌：会话切换时旧 fetch 的结果不得覆盖新会话（原实现的 cancelled
			// 语义；restore 现在同时被挂载 effect 与 arenaBus 订阅调用，用令牌守卫）。
			const restoreTokenRef = (0, react.useRef)(0);
			const restore = (0, react.useCallback)(async () => {
				if (sessionId === void 0 || sessionId === "") return;
				const token = ++restoreTokenRef.current;
				try {
					const res = await fetch("/arena-v2/state?session=" + encodeURIComponent(sessionId), { cache: "no-store" });
					const data = await res.json();
					if (restoreTokenRef.current !== token || !aliveRef.current) return;
					if (data !== null && typeof data === "object" && data.ok === true) {
						setActive(data.active === true);
						setMeta({
							scene: typeof data.scene === "string" ? data.scene : "business",
							hasChallenger: data.hasChallenger === true,
							challengerScene: typeof data.challengerScene === "string" ? data.challengerScene : null,
							allowedScenes: Array.isArray(data.allowedScenes) ? data.allowedScenes : null
						});
					}
				} catch (_restoreFailure) {
					// 保持当前本地状态（默认关闭），不阻塞 UI
				}
			}, [sessionId]);
			(0, react.useEffect)(() => {
				aliveRef.current = true;
				void restore();
				return () => {
					aliveRef.current = false;
				};
			}, [restore]);
			// 与空白页 hero 开关保持同步：任一切换/改场景后（arenaBus 通知）重新拉取宿主状态。
			(0, react.useEffect)(() => arenaBus.subscribe(() => {
				if (aliveRef.current) void restore();
			}), [restore]);
			// 场景浮层打开时，点击外部关闭（wrap 内点击不关——场景按钮/本体点击走各自 handler）。
			(0, react.useEffect)(() => {
				if (!expanded) return;
				const close = (event) => {
					if (wrapRef.current !== null && wrapRef.current.contains(event.target)) return;
					setExpanded(false);
				};
				document.addEventListener("mousedown", close);
				return () => document.removeEventListener("mousedown", close);
			}, [expanded]);
			// 开启期间轮询宿主状态：一轮完整对抗（终评结束）后宿主自动关闭竞技场，
			// chip 据此恢复未选中（无需手动点击关闭）；同时刷新 meta——首条消息后
			// 宿主创建挑战者（hasChallenger 变 true），场景段随之隐藏、场景锁定。
			(0, react.useEffect)(() => {
				if (!active || sessionId === void 0 || sessionId === "") return;
				const timer = setInterval(() => {
					if (!aliveRef.current) return;
					fetch("/arena-v2/state?session=" + encodeURIComponent(sessionId), { cache: "no-store" })
						.then((res) => res.json())
						.then((data) => {
							if (!aliveRef.current || data === null || typeof data !== "object" || data.ok !== true) return;
							if (data.active === false) {
								setActive(false);
								arenaBus.emit();
							}
							if (typeof data.scene === "string" || typeof data.hasChallenger === "boolean") {
								setMeta((m) => ({
									scene: typeof data.scene === "string" ? data.scene : (m?.scene ?? "business"),
									hasChallenger: typeof data.hasChallenger === "boolean" ? data.hasChallenger : (m?.hasChallenger ?? false),
									challengerScene: typeof data.challengerScene === "string" ? data.challengerScene : (m?.challengerScene ?? null),
									allowedScenes: Array.isArray(data.allowedScenes) ? data.allowedScenes : (m?.allowedScenes ?? null)
								}));
							}
						})
						.catch(() => {});
				}, 3000);
				return () => clearInterval(timer);
			}, [active, sessionId]);
			const click = () => {
				setBusy(true);
				setError(null);
				toggleArena(active).then((failure) => {
					if (!aliveRef.current) return;
					setBusy(false);
					setError(failure);
					if (failure === null) {
						const nowActive = !active;
						setActive(nowActive);
						// 开启后自动弹出场景浮层（鼠标此刻已在 chip 上，无需移开再 hover）；
						// 关闭则收起。仅当可选场景多于一个时弹（单场景直接开，无需选择）。
						if (nowActive && sceneKeys.length > 1) setExpanded(true);
						else setExpanded(false);
						arenaBus.emit();
					}
				}, (reason) => {
					if (!aliveRef.current) return;
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const pickScene = (scene) => {
				if (sceneBusy) return;
				setSceneBusy(true);
				setError(null);
				// 命令成功后收起浮层并点亮开关；期间浮层保持打开（场景按钮即选中反馈），
				// 命令失败显示错误、可重新 hover。
				enableScene(scene).then((failure) => {
					if (!aliveRef.current) return;
					setSceneBusy(false);
					setError(failure);
					if (failure === null) {
						setActive(true);
						setExpanded(false);
						setMeta((m) => (m === null ? null : { ...m, scene }));
						arenaBus.emit();
					}
				}, (reason) => {
					if (!aliveRef.current) return;
					setSceneBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			// 当前工作区可选场景（宿主 allowedScenes 过滤；null = 旧宿主/全量）。
			const sceneKeys = meta !== null && Array.isArray(meta.allowedScenes) && meta.allowedScenes.length > 0
				? meta.allowedScenes
				: ["business", "knowledge", "qa"];
			// 场景浮层只在**竞技场已开启**、会话尚无挑战者、且**可选场景多于一个**时展示——
			// 未开启时 hover 不反应；已有挑战者场景锁定；只剩一个场景时点击即开、无需选择。
			const showScenePick = active === true && meta !== null && meta.hasChallenger !== true && sceneKeys.length > 1;
			return (0, react_jsx_runtime.jsxs)("span", {
				ref: wrapRef,
				className: ArenaChip_module_css_default.wrap,
				onMouseEnter: () => setExpanded(true),
				onMouseLeave: () => setExpanded(false),
				onFocus: () => setExpanded(true),
				onBlur: () => setExpanded(false),
				children: [(0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: ArenaChip_module_css_default.chip,
					"data-active": active ? "true" : "false",
					"aria-label": active ? t("chip.on.aria") : t("chip.off.aria"),
					title: active ? t("chip.on.title") : t("chip.off.title"),
					disabled: busy,
					onClick: click,
					children: "Arena"
				}), showScenePick && expanded && (0, react_jsx_runtime.jsx)("span", {
					className: "ra2-chipScenes",
					"data-arena-chip-scenes": "",
					children: sceneKeys.map((key) => (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "ra2-sceneBtn",
						"aria-pressed": (meta?.scene ?? "business") === key ? "true" : "false",
						"aria-label": t("scene.aria") + "：" + t("scene." + key),
						onClick: () => pickScene(key),
						children: t("scene." + key)
					}, key))
				}), error !== null && (0, react_jsx_runtime.jsx)("span", {
					className: ArenaChip_module_css_default.error,
					role: "status",
					title: error,
					children: "竞技场切换失败"
				})]
			});
		}
		//#endregion
		//#region locales.js
		/** `arena` namespace dictionaries（chip + 空白页 hero 开关文案）。 */
		const zh = {
			"chip.on.aria": "竞技场已开启，按下关闭",
			"chip.on.title": "竞技场已开启 — 点击关闭（/arena off）",
			"chip.off.aria": "竞技场已关闭，按下开启",
			"chip.off.title": "竞技场已关闭 — 点击开启（/arena）",
			"toggle.label": "Arena",
			"toggle.aria.on": "模型竞技场已启用，点击关闭",
			"toggle.aria.off": "启用模型竞技场",
			"toggle.title.on": "竞技场已开启 — 点击关闭（/arena off）",
			"toggle.title.off": "竞技场已关闭 — 点击开启（/arena）",
			"scene.business": "业务探索",
			"scene.knowledge": "知识沉淀",
			"scene.qa": "测试用例",
			"scene.aria": "选择竞技场场景",
			"error.scene": "场景保存失败",
			"settings.title": "竞技场",
			"settings.desc": "三种场景的完整 persona 与回合模板（场景默认 > 顶层 business 默认，`scenePersonas` 配置可覆盖）：",
			"settings.main": "主代理 persona",
			"settings.challenger": "挑战者 persona",
			"settings.challenge": "质疑轮模板",
			"settings.verdict": "终评轮模板",
			"settings.explorer": "探索者 persona",
			"settings.explore": "explore 委派模板",
			"settings.propose": "propose 委派模板",
			"settings.review": "review 委派模板",
			"settings.readiness": "readiness 委派模板",
			"settings.report": "report 委派模板",
			"settings.shared": "（与 business 共用默认）",
			"settings.loading": "加载中…",
			"settings.error": "persona 加载失败"
		};
		const en = {
			"chip.on.aria": "Arena on, press to turn off",
			"chip.on.title": "Arena on — click to turn off (/arena off)",
			"chip.off.aria": "Arena off, press to turn on",
			"chip.off.title": "Arena off — click to turn on (/arena)",
			"toggle.label": "Arena",
			"toggle.aria.on": "Model arena enabled, click to disable",
			"toggle.aria.off": "Enable model arena",
			"toggle.title.on": "Arena on — click to turn off (/arena off)",
			"toggle.title.off": "Arena off — click to turn on (/arena)",
			"scene.business": "Business Exploration",
			"scene.knowledge": "Knowledge base",
			"scene.qa": "Test cases",
			"scene.aria": "Choose arena scene",
			"error.scene": "Failed to save scene",
			"settings.title": "Arena",
			"settings.desc": "Full personas and round templates for the three scenes (scene defaults > top-level business defaults, overridable via `scenePersonas`):",
			"settings.main": "Main agent persona",
			"settings.challenger": "Challenger persona",
			"settings.challenge": "Challenge round template",
			"settings.verdict": "Verdict round template",
			"settings.explorer": "Explorer persona",
			"settings.explore": "Explore delegation template",
			"settings.propose": "Propose delegation template",
			"settings.review": "Review delegation template",
			"settings.readiness": "Readiness delegation template",
			"settings.report": "Report delegation template",
			"settings.shared": "(shared with business default)",
			"settings.loading": "Loading…",
			"settings.error": "Failed to load personas"
		};
		//#endregion
		//#region index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "arena";
		/** Required client services: slot registry, commands Remote, locale registry, sessions（hero 开关取当前会话）。 */
		const inject = [
			"slots",
			"remote",
			"remote.commands",
			"locale",
			"sessions"
		];
		/**
		* Client plugin body:
		* 1) 输入栏 chip（conversation.input.left 列表槽，与其它入口共存）；
		* 2) 空白页 hero 开关（新对话空白页 hero workspace row 内，模仿 model-arena v1
		*    的 hero toggle）——开启后其右侧显示场景分段控件（业务探索/知识沉淀/测试
		*    用例），不做模型选择、不做 skill；开关/场景经 /arena-v2/state 路由读写
		*    宿主侧文件，与 chip 状态互通（arenaBus）。
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "arena-v2: dictionaries");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "arena",
				order: 10,
				locale: NS,
				inject: (sessionId) => ({
					toggleArena: async (currentlyActive) => {
						const command = currentlyActive ? "/arena off" : "/arena";
						const result = await ctx.remote.commands.execute(sessionId, command, []);
						if (!result.ok) return `${result.error.message} (${result.error.code})`;
						if (result.value === void 0) return `unknown command: ${command}`;
						return null;
					},
					enableScene: async (scene) => {
						const command = "/arena " + scene;
						const result = await ctx.remote.commands.execute(sessionId, command, []);
						if (!result.ok) return `${result.error.message} (${result.error.code})`;
						if (result.value === void 0) return `unknown command: ${command}`;
						return null;
					}
				})
			}, ArenaChip));

			// ── 空白页 hero 开关（新对话空白页，模仿 model-arena v1 的 hero toggle）──
			// 竞技场 pill 挂到 hero workspace row（DOM 注入，锚点与 v1 同款）；开启后
			// 其右侧显示场景分段控件（业务探索/知识沉淀/测试用例）。不做模型选择、不
			// 做 skill。开关/场景均经 /arena-v2/state 路由读写宿主侧文件，与输入栏
			// chip 状态互通（arenaBus 通知双方重新拉取）。
			const HERO_ANCHORS = {
				heroRow: '[data-phase="hero"] .wSkVaW_heroWorkspaceRow',
				heroChip: '[data-phase="hero"] button[aria-label*="工作区"], [data-phase="hero"] button[aria-label*="workspace"]'
			};
			const HERO_SCENES = ["business", "knowledge", "qa"];
			const heroT = ctx.locale.bind(NS);

			const currentSessionId = () => {
				try {
					return ctx.sessions?.list?.getSnapshot?.()?.current;
				} catch (_sessionReadFailure) {
					return void 0;
				}
			};

			const findHeroRow = () => {
				try {
					const row = document.querySelector(HERO_ANCHORS.heroRow);
					if (row instanceof HTMLElement) return row;
					const chip = document.querySelector(HERO_ANCHORS.heroChip);
					if (chip instanceof HTMLElement && chip.parentElement instanceof HTMLElement) return chip.parentElement;
					return null;
				} catch (_heroLookupFailure) {
					return null;
				}
			};

			const fetchArenaState = async (sessionId) => {
				try {
					const res = await fetch("/arena-v2/state?session=" + encodeURIComponent(sessionId), { cache: "no-store" });
					const data = await res.json();
					if (data !== null && typeof data === "object" && data.ok === true) return data;
					return null;
				} catch (_stateFetchFailure) {
					return null;
				}
			};

			const saveHeroScene = async (sessionId, scene) => {
				try {
					const res = await fetch("/arena-v2/state?session=" + encodeURIComponent(sessionId) + "&scene=" + encodeURIComponent(scene), { cache: "no-store" });
					const data = await res.json();
					return data !== null && typeof data === "object" && data.ok === true;
				} catch (_sceneSaveFailure) {
					return false;
				}
			};

			const toggleArenaCommand = async (sessionId, currentlyActive) => {
				const command = currentlyActive ? "/arena off" : "/arena";
				const result = await ctx.remote.commands.execute(sessionId, command, []);
				if (!result.ok) return `${result.error.message} (${result.error.code})`;
				if (result.value === void 0) return `unknown command: ${command}`;
				return null;
			};

			let heroMount = null;

			// 滑动高亮：thumb 块定位到当前场景按钮（transform/width 过渡 → 平滑移动）。
			// 布局值（offsetLeft/offsetWidth）需在可见且排版完成后读取——repaint 后
			// rAF 定位一次；ResizeObserver 兜底（显示/窗口缩放/字号变化重定位）。
			const positionThumb = (m) => {
				if (m === null) return;
				if (m.sceneSeg.offsetWidth === 0) return; // 不可见（竞技场关闭）时不定位
				const btn = m.buttons[m.scene];
				if (!btn) return;
				m.thumb.style.width = btn.offsetWidth + "px";
				m.thumb.style.transform = "translateX(" + btn.offsetLeft + "px)";
			};

			// 签名检查：repaint 只在可见状态变化时写 DOM，避免 observer -> sync ->
			// repaint 死循环（与 v1 的 renderSignature 同款）。
			// busy 拆成 toggleBusy / sceneBusy：只有 pill 自身的切换才短暂禁用 pill；
			// 切场景的 sceneBusy 只是防重入的逻辑守卫，**不进签名、不写 disabled**——
			// 否则场景保存期间按钮被禁用（opacity 变暗）会闪一下。
			const repaintHero = (m) => {
				if (m === null) return;
				const sig = JSON.stringify({ active: m.active, scene: m.scene, toggleBusy: m.toggleBusy, error: m.error });
				if (sig === m.lastSig) return;
				m.lastSig = sig;
				m.toggle.textContent = heroT("toggle.label");
				m.toggle.setAttribute("aria-pressed", m.active ? "true" : "false");
				m.toggle.setAttribute("aria-label", heroT(m.active ? "toggle.aria.on" : "toggle.aria.off"));
				m.toggle.setAttribute("title", heroT(m.active ? "toggle.title.on" : "toggle.title.off"));
				m.toggle.disabled = m.toggleBusy;
				m.sceneSeg.style.display = m.hideScenes === true ? "none" : (m.active ? "" : "none");
				for (const key of HERO_SCENES) {
					const btn = m.buttons[key];
					btn.setAttribute("aria-pressed", m.scene === key ? "true" : "false");
					btn.setAttribute("aria-label", heroT("scene.aria") + "：" + heroT("scene." + key));
					btn.textContent = heroT("scene." + key);
				}
				m.errorEl.textContent = m.error === null ? "" : m.error;
				// 排版完成后定位滑动高亮（display 从 none 切回时需要下一帧的布局值）
				requestAnimationFrame(() => {
					if (heroMount === m) positionThumb(m);
				});
			};

			// 从宿主侧文件恢复开关态与场景（刷新 / 切会话不丢；bus 通知时保持同步）。
			// 会话 id 尚未解析（应用启动首帧）时跳过——pill 先随页面出现，id 就绪后再水合。
			const restoreHero = async (m) => {
				if (m === null || !m.sessionId) return;
				const data = await fetchArenaState(m.sessionId);
				if (heroMount !== m) return;
				if (data !== null) {
					m.active = data.active === true;
					m.allowedScenes = Array.isArray(data.allowedScenes) ? data.allowedScenes : null;
					if (HERO_SCENES.includes(data.scene)) m.scene = data.scene;
					applySceneVisibility(m);
				}
				repaintHero(m);
			};

			// 按宿主返回的 allowedScenes 应用场景按钮可见性（null = 全部可见/旧宿主）。
			// 被隐藏的场景若恰好是当前场景 → 回落 business（工作区门控不允许）。
			// 可选场景 <=1 时整个场景段隐藏（无需选择，开启即默认场景）。
			const applySceneVisibility = (m) => {
				if (m === null) return;
				if (m.allowedScenes === null) return;
				m.hideScenes = m.allowedScenes.length <= 1;
				for (const key of HERO_SCENES) {
					const btn = m.buttons[key];
					if (!btn) continue;
					btn.style.display = m.hideScenes || !m.allowedScenes.includes(key) ? "none" : "";
				}
				if (!m.allowedScenes.includes(m.scene)) m.scene = "business";
				requestAnimationFrame(() => {
					if (heroMount === m) positionThumb(m);
				});
			};

			const cleanupHero = () => {
				if (heroMount === null) return;
				try {
					heroMount.thumbObserver?.disconnect?.();
				} catch {}
				heroMount.wrap.remove();
				heroMount = null;
			};

			const mountHero = (row, sessionId) => {
				const wrap = document.createElement("span");
				wrap.className = "ra2-hero";
				wrap.dataset.arenaHero = "";

				const toggle = document.createElement("button");
				toggle.type = "button";
				toggle.className = "ra2-toggle";
				toggle.dataset.arenaHeroToggle = "";
				toggle.addEventListener("click", () => {
					const m = heroMount;
					if (m === null || m.toggleBusy || !m.sessionId) return;
					m.toggleBusy = true;
					m.error = null;
					repaintHero(m);
					toggleArenaCommand(m.sessionId, m.active).then((failure) => {
						if (heroMount !== m) return;
						m.toggleBusy = false;
						m.error = failure;
						if (failure === null) m.active = !m.active;
						repaintHero(m);
						arenaBus.emit();
					}, (reason) => {
						if (heroMount !== m) return;
						m.toggleBusy = false;
						m.error = reason instanceof Error ? reason.message : String(reason);
						repaintHero(m);
					});
				});
				wrap.appendChild(toggle);

				const sceneSeg = document.createElement("span");
				sceneSeg.className = "ra2-sceneSeg";
				sceneSeg.dataset.arenaHeroSceneSeg = "";
				// 滑动高亮块：先于按钮插入（absolute + z-index 0，按钮 z-index 1 在上）
				const thumb = document.createElement("span");
				thumb.className = "ra2-thumb";
				thumb.dataset.arenaHeroThumb = "";
				sceneSeg.appendChild(thumb);
				const buttons = {};
				for (const key of HERO_SCENES) {
					const btn = document.createElement("button");
					btn.type = "button";
					btn.className = "ra2-sceneBtn";
					btn.dataset.arenaHeroScene = key;
					btn.addEventListener("click", () => {
						const m = heroMount;
						if (m === null || m.sceneBusy || !m.sessionId || m.scene === key) return;
						m.sceneBusy = true;
						m.error = null;
						repaintHero(m);
						saveHeroScene(m.sessionId, key).then((ok) => {
							if (heroMount !== m) return;
							m.sceneBusy = false;
							if (ok) m.scene = key;
							else m.error = heroT("error.scene");
							repaintHero(m);
							if (ok) arenaBus.emit();
						});
					});
					buttons[key] = btn;
					sceneSeg.appendChild(btn);
				}
				wrap.appendChild(sceneSeg);

				const errorEl = document.createElement("span");
				errorEl.className = "ra2-heroError";
				errorEl.setAttribute("role", "status");
				wrap.appendChild(errorEl);

				row.appendChild(wrap);

				// 场景段尺寸变化（显示/窗口缩放/字号）时重定位滑动高亮
				let thumbObserver = null;
				try {
					thumbObserver = new ResizeObserver(() => {
						if (heroMount !== null) positionThumb(heroMount);
					});
					thumbObserver.observe(sceneSeg);
				} catch (_thumbObserverFailure) {
					thumbObserver = null;
				}

				heroMount = { row, sessionId, wrap, toggle, sceneSeg, thumb, buttons, errorEl, thumbObserver, active: false, scene: "business", toggleBusy: false, sceneBusy: false, error: null, lastSig: null, allowedScenes: null, hideScenes: false };
				repaintHero(heroMount);
				void restoreHero(heroMount);
			};

			// 挂载由「hero 行是否存在」驱动，**不等会话快照**——hero 行与页面同步
			// 渲染，行一出现就挂 pill，避免页面画完后才「弹出来」（与 composer 里
			// 的 chip 同帧出现）。行元素被 React 重建时只把 wrap 挪到新行（不重建、
			// 不闪）；会话 id 解析/变化时更新并重新拉取状态。
			const syncHero = () => {
				try {
					const sessionId = currentSessionId();
					const row = findHeroRow();
					if (row === null) {
						cleanupHero();
						return;
					}
					if (heroMount === null) {
						mountHero(row, sessionId);
						return;
					}
					if (heroMount.sessionId !== sessionId) {
						heroMount.sessionId = sessionId;
						void restoreHero(heroMount);
					}
					if (heroMount.row !== row) {
						heroMount.row = row;
						row.appendChild(heroMount.wrap);
					}
				} catch (_heroSyncFailure) {
					// hero 结构变化时下次 tick 重试
				}
			};

			// 节流调度（30ms 合并触发）：观察器/会话订阅共用一个排程，避免长尾
			// DOM 变化把挂载不断推迟。
			let heroTimer = null;
			const heroSchedule = () => {
				if (heroTimer !== null) return;
				heroTimer = setTimeout(() => {
					heroTimer = null;
					syncHero();
				}, 30);
			};
			const heroObserver = new MutationObserver(heroSchedule);
			heroObserver.observe(document.body, { childList: true, subtree: true });
			const offHeroBus = arenaBus.subscribe(() => {
				if (heroMount !== null) void restoreHero(heroMount);
			});
			let offHeroSessions = null;
			try {
				offHeroSessions = ctx.sessions?.list?.subscribe?.(heroSchedule) ?? null;
			} catch (_sessionsSubscribeFailure) {
				offHeroSessions = null;
			}
			const offHeroLocale = ctx.locale.subscribe(() => {
				if (heroMount !== null) repaintHero(heroMount);
			});
			syncHero();

			// ── 设置弹窗：竞技场卡片（展示三场景全部 persona）──
			// 注册进 settings.section 列表槽（设置页导航出现「竞技场」条目）；
			// 卡片从 /arena-v2/personas 拉取每场景的有效 persona 集（场景默认 >
			// 顶层 business 默认 > scenePersonas 配置覆盖），只读展示。
			const ArenaSettingsCard = () => {
				const [scenes, setScenes] = (0, react.useState)(null);
				const [failed, setFailed] = (0, react.useState)(false);
				// 当前选中的场景页签（浏览器 tab 风格，默认 business）。
				const [tab, setTab] = (0, react.useState)("business");
				(0, react.useEffect)(() => {
					let cancelled = false;
					fetch("/arena-v2/personas", { cache: "no-store" })
						.then((res) => res.json())
						.then((data) => {
							if (!cancelled && data !== null && typeof data === "object" && data.ok === true && data.scenes !== null && typeof data.scenes === "object") {
								setScenes(data.scenes);
							} else if (!cancelled) {
								setFailed(true);
							}
						})
						.catch(() => {
							if (!cancelled) setFailed(true);
						});
					return () => {
						cancelled = true;
					};
				}, []);
				const blocks = (scene, tabKey) => tabKey === "knowledge"
					? [
						["settings.main", scene?.mainPersona],
						["settings.explorer", scene?.explorerPrompt],
						["settings.challenger", scene?.challengerPrompt],
						["settings.explore", scene?.explorePrompt],
						["settings.propose", scene?.proposePrompt],
						["settings.review", scene?.reviewPrompt],
						["settings.readiness", scene?.readinessPrompt],
						["settings.report", scene?.reportPrompt]
					]
					: [
						["settings.main", scene?.mainPersona],
						["settings.challenger", scene?.challengerPrompt],
						["settings.challenge", scene?.challengePrompt],
						["settings.verdict", scene?.verdictPrompt]
					];
				const nodes = [];
				nodes.push((0, react_jsx_runtime.jsx)("h2", { className: "ra2-settingsHead", children: heroT("settings.title") }, "head"));
				nodes.push((0, react_jsx_runtime.jsx)("p", { className: "ra2-settingsDesc", children: heroT("settings.desc") }, "desc"));
				if (failed) {
					nodes.push((0, react_jsx_runtime.jsx)("p", { className: "ra2-settingsError", children: heroT("settings.error") }, "err"));
					return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: nodes });
				}
				if (scenes === null) {
					nodes.push((0, react_jsx_runtime.jsx)("p", { className: "ra2-settingsDesc", children: heroT("settings.loading") }, "load"));
					return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: nodes });
				}
				// 页签栏（浏览器 tab 风格）
				nodes.push((0, react_jsx_runtime.jsx)("div", {
					className: "ra2-settingsTabs",
					role: "tablist",
					children: ["business", "knowledge", "qa"].map((key) => (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "tab",
						"aria-selected": tab === key ? "true" : "false",
						className: "ra2-settingsTab" + (tab === key ? " ra2-settingsTabActive" : ""),
						onClick: () => setTab(key),
						children: heroT("scene." + key)
					}, key))
				}, "tabs"));
				// 当前场景内容（只展示选中页签的场景）
				const sc = scenes[tab] ?? {};
				const sceneNodes = [
					(0, react_jsx_runtime.jsx)("h3", { className: "ra2-settingsSceneTitle", children: heroT("scene." + tab) }, "title")
				];
				if (tab !== "business") {
					const sharedSig = JSON.stringify({ main: scenes.business?.mainPersona, challenger: scenes.business?.challengerPrompt, challenge: scenes.business?.challengePrompt, verdict: scenes.business?.verdictPrompt });
					const sig = JSON.stringify({ main: sc.mainPersona, challenger: sc.challengerPrompt, challenge: sc.challengePrompt, verdict: sc.verdictPrompt });
					if (sig === sharedSig) {
						sceneNodes.push((0, react_jsx_runtime.jsx)("p", { className: "ra2-settingsShared", children: heroT("settings.shared") }, "shared"));
					}
				}
				for (const [labelKey, value] of blocks(sc, tab)) {
					sceneNodes.push((0, react_jsx_runtime.jsx)("span", { className: "ra2-settingsPromptLabel", children: heroT(labelKey) }, labelKey + "-label"));
					sceneNodes.push((0, react_jsx_runtime.jsx)("pre", { className: "ra2-settingsPrompt", children: typeof value === "string" ? value : "" }, labelKey));
				}
				nodes.push((0, react_jsx_runtime.jsx)("section", { className: "ra2-settingsScene", "data-arena-scene": tab, children: sceneNodes }, tab));
				return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: nodes });
			};
			try {
				const settingsSlots = typeof ctx.get === "function" ? ctx.get("slots") : void 0;
				if (settingsSlots !== void 0 && typeof settingsSlots.inject === "function" && typeof settingsSlots.register === "function") {
					settingsSlots.inject("settings.section", () => settingsSlots.register({
						name: "settings.section",
						id: "arena-v2",
						order: 30,
						label: () => heroT("settings.title"),
						locale: NS
					}, ArenaSettingsCard));
				}
			} catch (_settingsSlotFailure) {
				// 设置页槽未就绪时忽略（下次页面加载重试）
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
