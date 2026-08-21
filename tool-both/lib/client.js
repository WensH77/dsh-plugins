window.__ModuleLoader__.load({
	id: "dsh-plugin-tool-both",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback } = react;
		const h = react.createElement;

		// ── styles (injected once, tagged like the built bundles) ──────────────
		const css = [
			".tb-card{max-width:720px;flex-direction:column;gap:12px;display:flex}",
			".tb-title{margin:0;font-size:18px;font-weight:600}",
			".tb-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
			".tb-row{flex-direction:column;gap:4px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex}",
			".tb-rowLabel{color:var(--dsw-alias-label-caption);margin:0;font-size:12px}",
			".tb-rowValue{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-family:var(--dsw-font-mono)}",
			".tb-badge{flex:none;font-size:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;line-height:17px;width:max-content}",
			".tb-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".tb-badge.warn{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".tb-btn{flex:none;padding:3px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
			".tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tb-btn:disabled{opacity:.5;cursor:default}",
			".tb-hint{color:var(--dsw-alias-label-caption);margin:0;font-size:12px;line-height:18px}",
			".tb-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px}",
			".tb-pre{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;margin:0;font-family:var(--dsw-font-mono);font-size:12px;line-height:18px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}"
		];
		const tagId = "dsh-plugin-tool-both/settings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css.join("\n");
			document.head.appendChild(tag);
		}

		// ── dictionaries ──────────────────────────────────────────────────────
		const NS = "tool-both";
		const zh = {
			nav: "工具呈现模式",
			title: "工具呈现模式（both）",
			intro: "一键开启 dsh「both」模式：原生工具直调与 run_code 并存、无 code-only 限制。插件激活时会自动把「BOTH模式」预设安装到 ~/.dsh/.agent-presets/both，预设选择器里即可选用。",
			"row.default": "当前默认预设",
			"row.default.none": "（未设置，取部署配置）",
			"row.installed": "both 预设",
			"row.installed.yes": "已安装",
			"row.installed.no": "未安装",
			"row.path": "预设路径",
			"btn.install": "重新安装（补缺失文件）",
			"btn.done": "已是最新",
			howto: "使用方式：在会话预设选择器里选「BOTH模式」，或在 ~/.dsh/settings.yaml 设置 agent-presets.default: both。切换后新会话生效，旧会话保持原预设。",
			error: "状态获取失败：",
			note: "提示：安装是幂等的，不会覆盖已存在的文件（手改内容会保留）。预设发现是实时重读的，安装后无需重启即可在预设选择器看到。"
		};
		const en = {
			nav: "Tool Presentation",
			title: "Tool Presentation (both)",
			intro: "One-click \"both\" tool presentation: native tool calls and run_code coexist without a code-only rule. On activation this plugin installs the \"BOTH模式\" preset into ~/.dsh/.agent-presets/both, ready to pick in the preset selector.",
			"row.default": "Current default preset",
			"row.default.none": "(unset, deployment default applies)",
			"row.installed": "\"both\" preset",
			"row.installed.yes": "installed",
			"row.installed.no": "missing",
			"row.path": "Preset path",
			"btn.install": "Re-install (fill missing files)",
			"btn.done": "Up to date",
			howto: "Usage: pick \"BOTH模式\" in the session preset selector, or set agent-presets.default: both in ~/.dsh/settings.yaml. New sessions pick it up; running sessions keep their preset.",
			error: "Status failed: ",
			note: "Note: install is idempotent and never overwrites existing files (manual edits survive). Preset discovery re-reads on every call, so the picker sees the result without a restart."
		};

		// ── settings section ──────────────────────────────────────────────────
		function BothModeSection(props) {
			const t = props.t;
			const [status, setStatus] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);

			const load = useCallback(() => {
				fetch("/tool-both/status", { cache: "no-store" })
					.then((response) => response.json())
					.then((data) => {
						if (data.ok) setStatus(data);
						else setError(String(data.message ?? "status failed"));
					})
					.catch((err) => setError(String(err?.message ?? err)));
			}, []);

			useEffect(() => {
				load();
			}, [load]);

			const install = () => {
				setBusy(true);
				fetch("/tool-both/install", { method: "POST", cache: "no-store" })
					.then((response) => response.json())
					.then((data) => {
						if (!data.ok) setError(String(data.message ?? "install failed"));
						else load();
					})
					.catch((err) => setError(String(err?.message ?? err)))
					.finally(() => setBusy(false));
			};

			const installed = status === null ? null : status.installed;
			const missing = status === null ? [] : status.missing;
			return h("div", { className: "tb-card" },
				h("h2", { className: "tb-title" }, t("title")),
				h("p", { className: "tb-intro" }, t("intro")),
				error !== null && h("p", { className: "tb-error" }, t("error") + error),
				status !== null && h("div", { key: "rows" },
					h("div", { className: "tb-row" },
						h("p", { className: "tb-rowLabel" }, t("row.default")),
						h("p", { className: "tb-rowValue" }, status.defaultPreset === null ? t("row.default.none") : status.defaultPreset)
					),
					h("div", { className: "tb-row" },
						h("p", { className: "tb-rowLabel" }, t("row.installed")),
						h("span", { className: "tb-badge " + (installed ? "ok" : "warn") }, installed ? t("row.installed.yes") : t("row.installed.no") + (missing.length > 0 ? " (" + missing.join(", ") + ")" : ""))
					),
					h("div", { className: "tb-row" },
						h("p", { className: "tb-rowLabel" }, t("row.path")),
						h("p", { className: "tb-rowValue" }, status.path)
					),
					h("div", { className: "tb-row" },
						h("button", { className: "tb-btn", disabled: busy || installed, onClick: install }, busy ? "…" : (installed ? t("btn.done") : t("btn.install")))
					)
				),
				h("p", { className: "tb-hint" }, t("howto")),
				h("p", { className: "tb-hint" }, t("note"))
			);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tool-both: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "tool-both",
				order: 30,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t })
			}, BothModeSection));
		}

		const inject = ["locale", "slots"];
		exports.BothModeSection = BothModeSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
