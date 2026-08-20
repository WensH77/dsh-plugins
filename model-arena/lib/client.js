window.__ModuleLoader__.load({
	id: "dsh-plugin-model-arena",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// NOTE: no platform requires — /arena is a headless popupSelect
		// contribution (same mechanism as /model); the popup shell itself is
		// platform UI, this plugin only supplies options/onSelect plus the
		// locale dictionaries.

		// ── dictionaries ──────────────────────────────────────────────────────
		const NS = "model-arena";
		const zh = {
			"menu.description": "模型竞技场开关（功能开发中）",
			"option.on": "开启模型竞技场",
			"option.onDetail": "功能开发中 · 开启后暂不影响对话",
			"option.off": "关闭模型竞技场",
			"option.offDetail": "关闭竞技场开关，恢复默认对话",
			"notice.on": "模型竞技场已开启（功能开发中，暂不影响对话）",
			"notice.off": "模型竞技场已关闭"
		};
		const en = {
			"menu.description": "Model arena toggle (in development)",
			"option.on": "Enable model arena",
			"option.onDetail": "In development — enabling won't affect conversations yet",
			"option.off": "Disable model arena",
			"option.offDetail": "Turn the arena switch off",
			"notice.on": "Model arena enabled (in development — no effect yet)",
			"notice.off": "Model arena disabled"
		};

		// ── plugin entry ──────────────────────────────────────────────────────
		// "commandUi" is a separately mounted service; property access only
		// resolves once it is injected, so the contribution registers through the
		// explicit ctx.inject() late-binding (same pattern as ui-model-selection).
		const inject = ["locale", "commandUi"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "model-arena: dictionaries");
			const t = ctx.locale.bind(NS);

			ctx.inject(["commandUi"], (scope) => {
				const command = scope.get("commandUi");
				scope.effect(() => command.register({
					name: "arena",
					description: t("menu.description"),
					available: () => true,
					ui: {
						kind: "popupSelect",
						// Fresh read every open: the popup always reflects the
						// persisted state. Failure throws -> the popup shell shows
						// its built-in error + retry.
						options: async (session, signal) => {
							const res = await fetch("/model-arena/state", { cache: "no-store", signal });
							const data = await res.json();
							if (typeof data !== "object" || data === null || !data.ok) {
								throw new Error(String(data?.message ?? "model-arena state failed"));
							}
							const enabled = data.enabled === true;
							return [
								{ id: "on", label: t("option.on"), detail: t("option.onDetail"), active: enabled },
								{ id: "off", label: t("option.off"), detail: t("option.offDetail"), active: !enabled }
							];
						},
						// Persist the switch. Success closes the shell and shows a
						// composer notice; failure throws so the shell stays open
						// with the error surfaced (built-in), never a false success.
						onSelect: async (option, session) => {
							const enabled = option.id === "on";
							const res = await fetch("/model-arena/set", {
								method: "POST",
								cache: "no-store",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ enabled })
							});
							const data = await res.json();
							if (typeof data !== "object" || data === null || !data.ok) {
								throw new Error(String(data?.message ?? "model-arena set failed"));
							}
							command.noticeFor(session.sessionId, "success", t(enabled ? "notice.on" : "notice.off"));
						}
					}
				}), "model-arena: /arena contribution");
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
