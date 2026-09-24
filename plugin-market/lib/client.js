window.__ModuleLoader__.load({
	id: "dsh-plugin-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ── styles (injected once) ───────────────────────────────────────────
		// 只服务侧边栏 dsh 版本状态灯及其判定弹窗（DOM 注入）。
		const css = [
			".pm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font:inherit;cursor:pointer;border-radius:7px;padding:4px 11px;font-size:12px;line-height:18px;flex:none;transition:border-color .15s ease,color .15s ease,background .15s ease,transform .12s ease}",
			".pm-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
			".pm-btn:active:not(:disabled){transform:scale(.97)}",
			".pm-btn:disabled{opacity:.45;cursor:default}",
			".pm-btn.primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}",
			".pm-btn.primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-label-primary))}",
			".pm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".pm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(2px)}",
			".pm-modal{width:100%;max-width:420px;max-height:calc(100vh - 48px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);padding:18px 20px;flex-direction:column;gap:12px;display:flex;overflow:hidden}",
			".pm-modalBody{overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:12px}",
			".pm-modalTitle{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}",
			".pm-modalTitle.danger{color:var(--dsw-alias-state-error-primary)}",
			".pm-modalText{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}",
			".pm-modalRow{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
			".pm-reviewRisks{margin:0;padding:0 0 0 18px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;gap:4px;display:flex;flex-direction:column;list-style:disc}",
			// 报告里「本地插件契约扫描」：一个插件一个可折叠组（默认收起，含 high 时展开）
			".pm-scanInfo{margin:2px 0}",
			".pm-scanInfo>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px}",
			".pm-scanInfo>summary:hover{color:var(--dsw-alias-label-primary)}",
			".pm-scanInfo[open]>summary{font-weight:600}",
			".pm-scanDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption)}",
			".pm-scanDot[data-severity=high]{background:var(--dsw-alias-state-error-primary)}",
			".pm-scanDot[data-severity=medium]{background:var(--dsw-alias-state-warn-primary)}",
			".pm-scanPluginName{font-family:var(--dsw-font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".pm-scanTag{font-family:var(--dsw-font-mono);font-size:11px;line-height:17px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;margin-right:6px;flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap;vertical-align:middle}",
			".pm-scanTag[data-severity=high]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".pm-scanTag[data-severity=medium]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			// 升级命令行：命令可整体选中复制，右侧「复制」按钮走 Clipboard API
			".pm-cmdRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}",
			".pm-cmdText{font-family:var(--dsw-font-mono);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 10px;user-select:all;word-break:break-all;min-width:0}",
			"@keyframes pmPulse{0%,100%{opacity:1}50%{opacity:.35}}",
			// 侧边栏 dsh 版本状态灯（品牌名下方）：圆点 + 版本号。
			// 侧边栏根为 flex 列、默认 cross-axis stretch，故本行为全宽；左 padding 对齐 logoRow 的品牌 mark。
			".pm-dshself{display:flex;align-items:center;gap:6px;padding:1px 0 1px 12px;margin:-10px 0 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);cursor:pointer;font-family:var(--dsw-font-mono);user-select:none;transition:color .15s ease}",
			".pm-dshself:hover{color:var(--dsw-alias-label-secondary)}",
			".pm-dshselfDot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption);transition:background .2s ease,box-shadow .2s ease}",
			".pm-dshself[data-state=ok] .pm-dshselfDot{background:var(--dsw-alias-state-success-primary)}",
			".pm-dshself[data-state=update] .pm-dshselfDot{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-warn-tertiary)}",
			".pm-dshself[data-state=breaking] .pm-dshselfDot{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-warn-tertiary)}",
			".pm-dshself[data-state=analyzing] .pm-dshselfDot{background:var(--dsw-alias-state-warn-primary);animation:pmPulse 1s ease-in-out infinite}",
			".pm-dshself[data-state=update],.pm-dshself[data-state=breaking]{color:var(--dsw-alias-label-secondary)}",
			".pm-dshselfVersion{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".pm-dshself[data-collapsed=true]{justify-content:center;padding:2px 0}",
			".pm-dshself[data-collapsed=true] .pm-dshselfVersion{display:none}",
		];

		const tagId = "dsh-plugin-market/dsh-version-light.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css.join("\n");
			document.head.appendChild(tag);
		}

		// ── dictionaries ──────────────────────────────────────────────────────
		const NS = "settings.pluginMarket";
		const zh = {
			ok: "知道了",
			dshHasUpdate: "有新版本 v{version}",
			dshBreaking: "有新版本 v{version}，可能影响已装插件的兼容性",
			dshUnknown: "无法检查更新",
			dshAnalyzing: "正在分析新版本…",
			dshHasUpdateShort: "有新版本",
			dshBreakingShort: "兼容性问题",
			dshReportChanges: "变更要点",
			dshReportAffected: "可能受影响的插件",
			dshReportAffectedNone: "（未发现可能受影响的插件）",
			dshReportDetails: "详情",
			dshReportVersions: "版本变更明细（当前 → 最新，共 {count} 个版本，不跳版本）",
			dshReportVersionBreaking: "破坏性变更",
			dshReportVersionMissing: "（该版本变更未能分析）",
			dshReportVersionEmpty: "（该版本无变更说明）",
			dshReportScan: "本地插件契约扫描（机器判定）",
			dshReportScanIntro: "用「本地插件使用指纹 × 目标版本宿主模块闭包」做的确定性核对，先于 LLM 分析。",
			dshReportScanClean: "{count} 个插件机器判定未命中",
			dshReportScanLocalOnly: "（registry 不可达，仅指纹、无闭包核对）",
			dshReportScanCleanNone: "（机器判定未发现受影响插件）",
			dshReportScanPluginCount: "{count} 条机器结论（点击展开）",
			dshReportScanKindRemoved: "宿主模块消失",
			dshReportScanKindDeps: "dependencies 越界",
			dshReportScanKindDevDeps: "devDependencies 越界",
			dshReportScanKindPeer: "peer 声明失真",
			dshReportScanKindHigh: "高",
			dshReportScanKindMedium: "中",
			dshReportScanKindInfo: "提示",
			dshReportInstallHint: "升级命令",
			copy: "复制",
			copied: "已复制",
		};
		const en = {
			ok: "OK",
			dshHasUpdate: "New version available: v{version}",
			dshBreaking: "New version v{version} — may affect installed plugin compatibility",
			dshUnknown: "Unable to check for updates",
			dshAnalyzing: "Analyzing the new version…",
			dshHasUpdateShort: "update available",
			dshBreakingShort: "compatibility issue",
			dshReportChanges: "Changes",
			dshReportAffected: "Possibly affected plugins",
			dshReportAffectedNone: "(no possibly affected plugins found)",
			dshReportDetails: "Details",
			dshReportVersions: "Version-by-version changes (current → latest, {count} versions, no version skipped)",
			dshReportVersionBreaking: "breaking change",
			dshReportVersionMissing: "(changes for this version could not be analyzed)",
			dshReportVersionEmpty: "(no change notes for this version)",
			dshReportScan: "Local plugin contract scan (machine)",
			dshReportScanIntro: "Deterministic check of local plugin usage fingerprints against the target version's host module closure, run before the LLM analysis.",
			dshReportScanClean: "{count} plugin(s) machine-clean",
			dshReportScanLocalOnly: "(registry unreachable — fingerprints only, no closure check)",
			dshReportScanCleanNone: "(no machine findings)",
			dshReportScanPluginCount: "{count} machine finding(s) — click to expand",
			dshReportScanKindRemoved: "host module gone",
			dshReportScanKindDeps: "dependencies out of range",
			dshReportScanKindDevDeps: "devDependencies out of range",
			dshReportScanKindPeer: "peer declaration only",
			dshReportScanKindHigh: "high",
			dshReportScanKindMedium: "medium",
			dshReportScanKindInfo: "info",
			dshReportInstallHint: "Upgrade",
			copy: "Copy",
			copied: "Copied",
		};

		// ── helpers ──────────────────────────────────────────────────────────
		function tpl(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (_, key) => (params[key] !== undefined ? String(params[key]) : ""));
		}
		// 目标版本的全局安装命令：预发布走 npm dist-tag（rc/beta → @next），alpha 线没有 dist-tag
		// 指向它，按精确版本装（`@0.1.5-alpha.2`）；正式版 → @latest。
		function dshInstallCommand(version) {
			const v = String(version ?? "").trim();
			if (v === "") return "npm install -g @deepseek-ai/dsh@latest";
			if (/-alpha\./u.test(v)) return "npm install -g @deepseek-ai/dsh@" + v;
			if (/-rc\.|-(?:beta|next)\./u.test(v)) return "npm install -g @deepseek-ai/dsh@next";
			return "npm install -g @deepseek-ai/dsh@latest";
		}
		// finding 展示文案：裁掉旧缓存（≤0.14.3）range-break message 末尾那句逐条重复的括号解释；
		// removed-module 的括号在句中（是信息量所在），按句型只处理「声明的 …」这类。
		function findingMessage(f) {
			const text = String((f && f.message) ?? "");
			return text.startsWith("声明的 ") ? text.replace(/（[^（）]*）\s*$/u, "") : text;
		}
		// 复制到剪贴板：优先异步 Clipboard API（非安全上下文不可用），失败回退 execCommand。
		function copyText(text, done) {
			const fallback = () => {
				try {
					const area = document.createElement("textarea");
					area.value = text;
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					document.execCommand("copy");
					document.body.removeChild(area);
					done();
				} catch {}
			};
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(text).then(done, fallback);
					return;
				}
			} catch {}
			fallback();
		}
		async function call(path, body) {
			const response = await fetch(path, body === undefined
				? {}
				: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			let data = null;
			try {
				data = await response.json();
			} catch {}
			if (!response.ok || (data !== null && data.ok === false)) {
				throw new Error(data !== null && typeof data.error === "string" ? data.error : "HTTP " + response.status);
			}
			return data;
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		const inject = ["locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-market: dictionaries");
			const t = ctx.locale.bind(NS);

			// ── 侧边栏 dsh 版本状态灯（品牌名下方，DOM 注入） ────────────────
			ctx.effect(() => {
				if (typeof document === "undefined") return;
				// 折叠开关按钮（唯一且中英双语文案都匹配），其父元素即 logoRow；
				// 状态灯注入 logoRow 之后。dsh 升级若改文案，仅需在此处更新选择器。
				const TOGGLE_SEL = 'button[aria-label="收起侧边栏"], button[aria-label="打开侧边栏"], button[aria-label="Collapse sidebar"], button[aria-label="Open sidebar"]';
				const NORMAL_POLL_MS = 60000;
				const FAST_POLL_MS = 1000;
				// 「正在分析」守卫上限：见 analyzeUntil 注释
				const ANALYZE_GUARD_MS = 120000;

				let statusEl = null;
				let observer = null;
				let attrObserver = null;
				let pollTimer = null;
				let scanTimer = null;
				let fast = false;
				let analyzeBusy = false;
				let lastState = null;
				// 点击分析后，服务端要等「拉版本材料 + L1 契约扫描」跑完才会把 status 翻成 analyzing
				// （这几步是网络 + registry 闭包核对，可能几秒到几十秒）。守卫期内忽略仍是 idle 的陈旧响应：
				// 既不让「正在分析…」被陈旧状态打回去，也不让它把 1s 快轮询退回 60s——否则整个 analyzing
				// 窗口会被跳过，只能等下一次轮询才看到结果。带上限，避免请求卡死时把灯钉在「正在分析」。
				let analyzeUntil = 0;

				const paint = (d) => {
					lastState = d;
					if (!statusEl) return;
					let state;
					let text = "";
					if (!d || d.ok === false) {
						state = "unknown"; text = d && d.installed ? "v" + d.installed : "";
					} else if (d.status === "analyzing") {
						state = "analyzing"; text = (d.installed ? "v" + d.installed + " · " : "") + t("dshAnalyzing");
					} else if (d.hasUpdate === true && d.verdict === "breaking") {
						// 简约拼接：版本号 + 状态标记（判定详情点击弹窗查看）
						state = "breaking"; text = (d.installed ? "v" + d.installed + " · " : "") + t("dshBreakingShort");
					} else if (d.hasUpdate === true) {
						state = "update"; text = (d.installed ? "v" + d.installed + " · " : "") + t("dshHasUpdateShort");
					} else if (d.checked === false) {
						state = "unknown"; text = d.installed ? "v" + d.installed : "";
					} else {
						state = "ok"; text = d.installed ? "v" + d.installed : "";
					}
					statusEl.dataset.state = state;
					statusEl.title = ""; // 不显示 hover 文案
					const ver = statusEl.querySelector(".pm-dshselfVersion");
					if (ver) ver.textContent = text;
				};

				let dshReportOverlay = null;
				const closeDshReport = () => {
					if (dshReportOverlay && dshReportOverlay.parentElement) dshReportOverlay.parentElement.removeChild(dshReportOverlay);
					dshReportOverlay = null;
				};
				// 判定弹窗：已分析（红/黄）点击时展示 verdict/summary/变更/受影响插件/详情
				const showDshReport = (d) => {
					closeDshReport();
					const overlay = document.createElement("div");
					overlay.className = "pm-overlay";
					overlay.style.zIndex = "1001";
					overlay.addEventListener("click", closeDshReport);
					const modal = document.createElement("div");
					modal.className = "pm-modal";
					modal.style.maxWidth = "560px";
					modal.addEventListener("click", (e) => e.stopPropagation());
					const title = document.createElement("p");
					title.className = "pm-modalTitle";
					const body = document.createElement("div");
					body.className = "pm-modalBody";
					if (d && (d.verdict === "safe" || d.verdict === "breaking")) {
						title.textContent = d.verdict === "breaking" ? tpl(t("dshBreaking"), { version: d.latest ?? "?" }) : tpl(t("dshHasUpdate"), { version: d.latest ?? "?" });
						if (d.verdict === "breaking") title.classList.add("danger");
						const sum = document.createElement("p");
						sum.className = "pm-modalText";
						sum.textContent = d.summary ?? "";
						body.appendChild(sum);
						// 标题 + 概览之下紧跟一行升级命令：整条可选中，右侧按钮一键复制
						{
							const cmdText = dshInstallCommand(d.latest);
							const row = document.createElement("div");
							row.className = "pm-cmdRow";
							const label = document.createElement("span");
							label.className = "pm-modalText";
							label.style.fontWeight = "600";
							label.textContent = t("dshReportInstallHint") + "：";
							const code = document.createElement("code");
							code.className = "pm-cmdText";
							code.textContent = cmdText;
							const btn = document.createElement("button");
							btn.className = "pm-btn";
							btn.textContent = t("copy");
							btn.addEventListener("click", () => copyText(cmdText, () => {
								btn.textContent = t("copied");
								setTimeout(() => { btn.textContent = t("copy"); }, 1500);
							}));
							row.appendChild(label);
							row.appendChild(code);
							row.appendChild(btn);
							body.appendChild(row);
						}
						if (Array.isArray(d.versions) && d.versions.length > 0) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = tpl(t("dshReportVersions"), { count: String(d.versions.length) });
							body.appendChild(h);
							const ol = document.createElement("ol");
							ol.className = "pm-reviewRisks";
							ol.style.listStyle = "decimal";
							d.versions.forEach((v) => {
								const li = document.createElement("li");
								const head = document.createElement("span");
								head.style.fontWeight = "600";
								head.textContent = "v" + v.version + (v.breaking === true ? "（" + t("dshReportVersionBreaking") + "）" : "");
								li.appendChild(head);
								if (Array.isArray(v.changes) && v.changes.length > 0) {
									const ul = document.createElement("ul");
									ul.className = "pm-reviewRisks";
									v.changes.forEach((c) => { const sub = document.createElement("li"); sub.textContent = c; ul.appendChild(sub); });
									li.appendChild(ul);
								} else {
									const note = document.createElement("div");
									note.className = "pm-modalText";
									note.style.opacity = "0.7";
									note.textContent = v.missing === true ? t("dshReportVersionMissing") : t("dshReportVersionEmpty");
									li.appendChild(note);
								}
								ol.appendChild(li);
							});
							body.appendChild(ol);
						}
						if (Array.isArray(d.changes) && d.changes.length > 0) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportChanges") + "：";
							body.appendChild(h);
							const ul = document.createElement("ul");
							ul.className = "pm-reviewRisks";
							d.changes.forEach((c) => { const li = document.createElement("li"); li.textContent = c; ul.appendChild(li); });
							body.appendChild(ul);
						}
						if (Array.isArray(d.affectedPlugins) && d.affectedPlugins.length > 0) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportAffected") + "：";
							body.appendChild(h);
							const ul = document.createElement("ul");
							ul.className = "pm-reviewRisks";
							d.affectedPlugins.forEach((c) => { const li = document.createElement("li"); li.textContent = c; ul.appendChild(li); });
							body.appendChild(ul);
						} else {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportAffected") + "：";
							body.appendChild(h);
							const p = document.createElement("p");
							p.className = "pm-modalText";
							p.style.opacity = "0.7";
							p.textContent = t("dshReportAffectedNone");
							body.appendChild(p);
						}
						// L1 契约扫描（机器判定）证据区：展示机器结论与闭包核对结果
						if (d && d.scan && (Array.isArray(d.scan.plugins) || Array.isArray(d.scan.errors))) {
							const scan = d.scan;
							const scanH = document.createElement("p");
							scanH.className = "pm-modalText";
							scanH.style.fontWeight = "600";
							scanH.textContent = t("dshReportScan") + "：";
							body.appendChild(scanH);
							const scanIntro = document.createElement("p");
							scanIntro.className = "pm-modalText";
							scanIntro.style.opacity = "0.7";
							scanIntro.style.fontSize = "12px";
							scanIntro.textContent = t("dshReportScanIntro");
							body.appendChild(scanIntro);
							if (scan.method === "local-only") {
								const note = document.createElement("p");
								note.className = "pm-modalText";
								note.style.color = "var(--dsw-alias-state-warn-primary)";
								note.textContent = t("dshReportScanLocalOnly");
								body.appendChild(note);
							}
							if (Array.isArray(scan.errors) && scan.errors.length > 0) {
								const note = document.createElement("p");
								note.className = "pm-modalText";
								note.style.opacity = "0.8";
								note.textContent = scan.errors.join("；");
								body.appendChild(note);
							}
							// 按插件折叠：每个有机器结论的插件一个 <details>（默认收起；含 high 的默认展开，
							// 免得真正可能污染 profile 根的破坏点被折起来）。条目首列用短标签标出档位
							// （dependencies/devDependencies 越界、宿主模块消失、peer 声明失真），
							// 不再在每条 finding 里重复同一句括号解释。
							const scanPlugins = Array.isArray(scan.plugins) ? scan.plugins : [];
							const findingsOf = (p) => (p && Array.isArray(p.findings) ? p.findings : []);
							const groups = scanPlugins
								.map((p) => ({ plugin: p, items: findingsOf(p) }))
								.filter((g) => g.plugin && g.items.length > 0);
							const cleanCount = scanPlugins.length - groups.length;
							const sevOf = (f) => (f && (f.severity === "high" || f.severity === "medium") ? f.severity : "info");
							const tagKeyOf = (f) => {
								if (f === null || typeof f !== "object") return "dshReportScanKindInfo";
								if (f.kind === "removed-module") return "dshReportScanKindRemoved";
								if (f.kind === "range-break") return "dshReportScanKindDeps";
								if (f.kind === "range-break-dev") return "dshReportScanKindDevDeps";
								if (f.kind === "range-break-peer") return "dshReportScanKindPeer";
								return sevOf(f) === "high" ? "dshReportScanKindHigh" : sevOf(f) === "medium" ? "dshReportScanKindMedium" : "dshReportScanKindInfo";
							};
							if (groups.length === 0) {
								const p = document.createElement("p");
								p.className = "pm-modalText";
								p.style.opacity = "0.8";
								p.textContent = cleanCount > 0 ? tpl(t("dshReportScanClean"), { count: String(cleanCount) }) + " · " + t("dshReportScanCleanNone") : t("dshReportScanCleanNone");
								body.appendChild(p);
							} else {
								groups.forEach((g) => {
									const highest = g.items.some((f) => sevOf(f) === "high") ? "high" : (g.items.some((f) => sevOf(f) === "medium") ? "medium" : "info");
									const details = document.createElement("details");
									details.className = "pm-scanInfo";
									if (highest === "high") details.open = true;
									const summary = document.createElement("summary");
									const dot = document.createElement("span");
									dot.className = "pm-scanDot";
									dot.dataset.severity = highest;
									const nameEl = document.createElement("span");
									nameEl.className = "pm-scanPluginName";
									nameEl.textContent = g.plugin.moduleName + (g.plugin.version ? "@" + g.plugin.version : "");
									const countEl = document.createElement("span");
									countEl.textContent = " · " + tpl(t("dshReportScanPluginCount"), { count: String(g.items.length) });
									summary.appendChild(dot);
									summary.appendChild(nameEl);
									summary.appendChild(countEl);
									details.appendChild(summary);
									const ul = document.createElement("ul");
									ul.className = "pm-reviewRisks";
									g.items.forEach((f) => {
										const li = document.createElement("li");
										const tag = document.createElement("span");
										tag.className = "pm-scanTag";
										tag.dataset.severity = sevOf(f);
										tag.textContent = t(tagKeyOf(f));
										li.appendChild(tag);
										li.appendChild(document.createTextNode(findingMessage(f)));
										ul.appendChild(li);
									});
									details.appendChild(ul);
									body.appendChild(details);
								});
								if (cleanCount > 0) {
									const p = document.createElement("p");
									p.className = "pm-modalText";
									p.style.opacity = "0.8";
									p.textContent = tpl(t("dshReportScanClean"), { count: String(cleanCount) });
									body.appendChild(p);
								}
							}
						}
						if (d.details) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportDetails") + "：";
							body.appendChild(h);
							const p = document.createElement("p");
							p.className = "pm-modalText";
							p.textContent = d.details;
							body.appendChild(p);
						}
					} else {
						title.textContent = t("dshUnknown");
						const p = document.createElement("p");
						p.className = "pm-modalText";
						p.textContent = (d && typeof d.error === "string" && d.error !== "") ? d.error : t("dshUnknown");
						body.appendChild(p);
					}
					const row = document.createElement("div");
					row.className = "pm-modalRow";
					const ok = document.createElement("button");
					ok.className = "pm-btn primary";
					ok.textContent = t("ok");
					ok.addEventListener("click", closeDshReport);
					row.appendChild(ok);
					modal.appendChild(title);
					modal.appendChild(body);
					modal.appendChild(row);
					overlay.appendChild(modal);
					document.body.appendChild(overlay);
					dshReportOverlay = overlay;
				};

				const startPoll = (f) => {
					if (pollTimer !== null && fast === f) return;
					if (pollTimer !== null) clearInterval(pollTimer);
					fast = f;
					pollTimer = setInterval(fetchState, f ? FAST_POLL_MS : NORMAL_POLL_MS);
				};

				const fetchState = () => {
					call("/plugin-market/dsh-version")
						.then((d) => {
							// 分析守卫期内（材料拉取 + L1 扫描阶段，服务端 status 仍是 idle）：不画、不降速
							if (Date.now() < analyzeUntil && (!d || d.status !== "analyzing")) return;
							paint(d);
							const analyzing = !!(d && d.status === "analyzing");
							if (analyzing !== fast) startPoll(analyzing);
						})
						.catch(() => {});
				};

				const onClick = () => {
					if (!statusEl || analyzeBusy) return;
					const state = statusEl.dataset.state;
					if (state === "analyzing") return; // 分析进行中：忽略重复点击（服务端同样不并发起第二次分析）
					if (state === "update" || state === "breaking") {
						// 已有判定 → 弹判定弹窗；待分析 → 静默直连 LLM 分析（不弹窗），完成后点击再看弹窗
						call("/plugin-market/dsh-version")
							.then((d) => {
								if (d && d.hasUpdate === true && (d.verdict === "safe" || d.verdict === "breaking")) {
									showDshReport(d);
									return;
								}
								analyzeBusy = true;
								// 立刻切「正在分析…」文案（不再是只把圆点置橙）：服务端在材料拉取 + L1 扫描
								// 完成前仍是 idle，不主动画的话文案会一直停在「有新版本」。
								analyzeUntil = Date.now() + ANALYZE_GUARD_MS;
								paint({ ...(lastState ?? {}), ok: true, status: "analyzing" });
								startPoll(true);
								call("/plugin-market/dsh-version/analyze", {})
									.then((d2) => { analyzeUntil = 0; if (!d2 || d2.ok !== true) fetchState(); })
									.catch(() => { analyzeUntil = 0; fetchState(); })
									.finally(() => { analyzeBusy = false; });
							})
							.catch(() => fetchState());
					} else {
						// 绿/灰：手动重检
						call("/plugin-market/dsh-version/check", {})
							.then((d) => paint(d))
							.catch(() => fetchState());
					}
				};

				const syncCollapsed = (toggle) => {
					if (!statusEl) return;
					const label = toggle.getAttribute("aria-label") ?? "";
					statusEl.dataset.collapsed = /打开侧边栏|Open sidebar/.test(label) ? "true" : "false";
				};

				const mount = () => {
					const toggle = document.querySelector(TOGGLE_SEL);
					if (!toggle) return;
					const logoRow = toggle.parentElement;
					if (!logoRow) return;
					if (statusEl && statusEl.isConnected) { syncCollapsed(toggle); return; }
					statusEl = document.createElement("span");
					statusEl.className = "pm-dshself";
					statusEl.dataset.state = "unknown";
					statusEl.title = t("dshUnknown");
					const dot = document.createElement("span");
					dot.className = "pm-dshselfDot";
					const ver = document.createElement("span");
					ver.className = "pm-dshselfVersion";
					statusEl.appendChild(dot);
					statusEl.appendChild(ver);
					statusEl.addEventListener("click", onClick);
					logoRow.insertAdjacentElement("afterend", statusEl);
					syncCollapsed(toggle);
					if (attrObserver) attrObserver.disconnect();
					attrObserver = new MutationObserver(() => syncCollapsed(toggle));
					attrObserver.observe(toggle, { attributes: true, attributeFilter: ["aria-label"] });
					fetchState();
				};

				const schedule = () => {
					if (scanTimer !== null) clearTimeout(scanTimer);
					scanTimer = setTimeout(mount, 120);
				};

				observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				mount();
				startPoll(false);

				return () => {
					closeDshReport();
					if (observer) observer.disconnect();
					if (attrObserver) attrObserver.disconnect();
					if (pollTimer !== null) clearInterval(pollTimer);
					if (scanTimer !== null) clearTimeout(scanTimer);
					if (statusEl && statusEl.parentElement) statusEl.parentElement.removeChild(statusEl);
					statusEl = null;
				};
			}, "plugin-market: dsh version light");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
