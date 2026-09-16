// dsh-plugin-todo-tab — 浏览器端。
//
// 在右侧栏注册一个页签类型（kind = "todo"）：引导页多一个「Todo」胶囊，点开就是
// 当前工作区的 TODO.md 内容，只读——没有编辑入口，也不调用任何写端点。
//
// 内容走宿主端点 GET /todo-tab/data?session=<id>（见 lib/index.js），页签本体只
// 负责取数与渲染。会话 id 由会话级插槽的标准属性给出。
window.__ModuleLoader__.load({
	id: "dsh-plugin-todo-tab",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useCallback, useEffect, useMemo, useState } = react;
		const h = react.createElement;

		// ── styles（注入一次，重复加载不叠加） ────────────────────────────────
		const css = [
			".tt-root{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px}",
			".tt-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}",
			".tt-title{font-weight:600;font-size:13px;letter-spacing:.01em}",
			".tt-workspace{font-family:var(--dsw-font-mono);font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:14em}",
			".tt-badge{flex:none;font-size:11px;line-height:17px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption)}",
			".tt-btn{margin-left:auto;flex:none;padding:3px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
			".tt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".tt-btn:disabled{opacity:.5;cursor:default}",
			".tt-path{padding:6px 12px 0;font-family:var(--dsw-font-mono);font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);word-break:break-all;flex:none}",
			".tt-body{flex:1;min-height:0;overflow:auto;padding:8px 12px 16px}",
			".tt-pre{margin:0;font:12px/1.7 var(--dsw-font-mono);white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}",
			".tt-state{padding:14px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}",
			".tt-state[data-error=true]{color:var(--dsw-alias-state-error-primary)}",
			".tt-state code{font-family:var(--dsw-font-mono);font-size:11px;word-break:break-all}",
			".tt-headBtn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}",
			".tt-headBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".tt-headBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".tt-headWrap{display:inline-flex;align-items:center;gap:6px;min-width:0}",
			".tt-headError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;max-width:22em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tt-modes{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;overflow:hidden;flex:none}",
			".tt-mode{border:none;background:0 0;color:var(--dsw-alias-label-caption);font:inherit;font-size:11px;line-height:18px;padding:2px 9px;cursor:pointer}",
			".tt-mode[data-active=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}",
			".tt-mode:hover:not([data-active=true]){color:var(--dsw-alias-label-primary)}",
			// Markdown 子集渲染（.tt-md 下的排版）
			".tt-md{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.75;word-break:break-word}",
			".tt-md>*:first-child{margin-top:0}",
			".tt-mdH1,.tt-mdH2,.tt-mdH3,.tt-mdH4,.tt-mdH5,.tt-mdH6{color:var(--dsw-alias-label-primary);font-weight:600;margin:16px 0 6px;line-height:1.4}",
			".tt-mdH1{font-size:17px}",
			".tt-mdH2{font-size:15px}",
			".tt-mdH3{font-size:14px}",
			".tt-mdH4,.tt-mdH5,.tt-mdH6{font-size:13px}",
			".tt-mdP{margin:6px 0}",
			".tt-mdList{margin:4px 0;padding-left:18px;list-style:none}",
			".tt-mdLi{position:relative;margin:3px 0;padding-left:2px}",
			".tt-mdLi::before{content:'';position:absolute;left:-12px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-caption)}",
			".tt-mdTask::before{content:none}",
			".tt-mdBox{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;margin-right:6px;border:1px solid var(--dsw-alias-border-l3);border-radius:3px;font-size:10px;line-height:1;color:var(--dsw-alias-state-success-primary);vertical-align:-1px}",
			".tt-mdTask[data-checked=true]>.tt-mdText{color:var(--dsw-alias-label-caption);text-decoration:line-through}",
			".tt-mdCode{font-family:var(--dsw-font-mono);font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px}",
			".tt-mdPre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;overflow:auto}",
			".tt-mdPre code{font-family:var(--dsw-font-mono);font-size:12px;line-height:1.6}",
			".tt-mdQuote{margin:6px 0;padding:2px 0 2px 10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
			".tt-mdHr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0}",
			".tt-md a{color:var(--dsw-alias-state-business-primary)}"
		];
		const tagId = "dsh-plugin-todo-tab/todo-tab.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css.join("");
			document.head.appendChild(tag);
		}

		// ── 文案 ──────────────────────────────────────────────────────────────
		const NS = "todoTab";
		const ID = "dsh-plugin-todo-tab";
		const KIND = "todo";
		const ENDPOINT = "/todo-tab/data";

		const zh = {
			"title": "Todo",
			"guide.title": "Todo",
			"guide.description": "只读查看当前工作区的 ~/.dsh/memory/<工作区>/TODO.md",
			"readonly": "只读",
			"refresh": "刷新",
			"mode.rendered": "渲染",
			"mode.raw": "原文",
			"header.hint": "在右侧栏打开工作区 TODO.md",
			"loading": "读取中…",
			"empty": "这个工作区还没有 TODO.md。",
			"noSession": "没有选中会话，无法确定工作区。",
			"error": "读取失败："
		};
		const en = {
			"title": "Todo",
			"guide.title": "Todo",
			"guide.description": "Read-only view of the current workspace's ~/.dsh/memory/<workspace>/TODO.md",
			"readonly": "read-only",
			"refresh": "Refresh",
			"mode.rendered": "Rendered",
			"mode.raw": "Raw",
			"header.hint": "Open the workspace TODO.md in the right sidebar",
			"loading": "Loading…",
			"empty": "This workspace has no TODO.md yet.",
			"noSession": "No session selected, so the workspace is unknown.",
			"error": "Read failed: "
		};

		/** 端点地址（会话 id 走 query，与宿主 handler 对应）。 */
		function todoDataUrl(sessionId) {
			return ENDPOINT + "?session=" + encodeURIComponent(sessionId);
		}

		/**
		 * 把 TODO.md 的绝对路径编成 DSH 的文件资源地址，交给原生文件预览（按扩展名选
		 * Markdown 实现）打开。session 作用域里 path 段以空段开头即可还原绝对路径：
		 * `["", "Users", "x", "TODO.md"]` → `/Users/x/TODO.md`；宿主读文件本就允许
		 * 工作区之外的绝对路径（见 dsh-api-workspace-files 的 read）。
		 */
		function todoResourceAddress(sessionId, absolutePath) {
			const segments = String(absolutePath).split("/").map(encodeURIComponent).join("/");
			return "dsh-resource://file/session/" + encodeURIComponent(sessionId) + "/" + segments;
		}

		/** 引导页胶囊图标：清单三行。 */
		function TodoGlyph({ size = 16, className }) {
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", className, "aria-hidden": "true" },
				h("path", { d: "M6 4h8M6 8h8M6 12h8", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
				h("path", { d: "M2.4 4l.9.9 1.6-1.8M2.4 8l.9.9 1.6-1.8M2.4 12l.9.9 1.6-1.8", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" })
			);
		}

		/** 页签类型：页面型（无地址 glob），经引导页胶囊以 kind 打开。 */
		function todoDefinition(t) {
			return {
				id: ID,
				kind: KIND,
				title: () => t("title"),
				guide: [{
					order: 30,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: TodoGlyph
				}]
			};
		}

		// ── 极简 Markdown 渲染（够 TODO.md 用即可） ─────────────────────────────
		// 为什么不复用聊天那套渲染器：它由 DSH 在构建期内联进各自的 client bundle
		// （@deepseek-ai/dsh-client-ui-primitives 没有独立的 client 行），插件在运行时
		// require 不到，所以这里自带一个子集解析器。支持：标题、段落、无序/有序列表、
		// 任务清单（含两级缩进）、引用、分隔线、围栏代码、行内 `code` / **粗** / *斜* / 链接。
		const RE_FENCE = /^\s*```(.*)$/;
		const RE_HEADING = /^(#{1,6})\s+(.*)$/;
		const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
		const RE_QUOTE = /^\s*>\s?(.*)$/;
		const RE_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
		const RE_TASK = /^\[([ xX])\]\s+(.*)$/;
		const RE_INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

		/** 行内片段 → 纯数据节点（不碰 React，便于单测）。 */
		function parseInline(text) {
			const nodes = [];
			const source = String(text ?? "");
			// 每次调用用独立的 regex 实例：粗体内部递归调用 parseInline，
			// 共享的 global regex 会被内层重置 lastIndex，导致外层死循环。
			const re = new RegExp(RE_INLINE.source, "g");
			let last = 0;
			let match;
			while ((match = re.exec(source)) !== null) {
				if (match.index > last) nodes.push({ kind: "text", text: source.slice(last, match.index) });
				const raw = match[0];
				if (raw.charAt(0) === "`") nodes.push({ kind: "code", text: raw.slice(1, -1) });
				else if (raw.startsWith("**") || raw.startsWith("__")) {
					// 粗体里可能还有 `code`，递归解析内层（内层不含 `**`，不会无限递归）。
					nodes.push({ kind: "strong", nodes: parseInline(raw.slice(2, -2)) });
				} else if (raw.charAt(0) === "[") {
					const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
					if (link === null) nodes.push({ kind: "text", text: raw });
					else nodes.push({ kind: "link", text: link[1], href: link[2] });
				} else nodes.push({ kind: "em", text: raw.slice(1, -1) });
				last = match.index + raw.length;
			}
			if (last < source.length) nodes.push({ kind: "text", text: source.slice(last) });
			return nodes;
		}

		/** 收集一段连续列表项，按缩进挂成两级以上的树。 */
		function parseItems(lines, start) {
			const items = [];
			const stack = [{ indent: -1, item: null }];
			let i = start;
			while (i < lines.length) {
				const match = RE_ITEM.exec(lines[i]);
				if (match === null) {
					// 列表项的续行（缩进文本）并进当前项，而不是新起一段。
					if (items.length > 0 && /^\s+\S/.test(lines[i])) {
						const current = stack[stack.length - 1].item;
						current.text = (current.text + " " + lines[i].trim()).trim();
						i += 1;
						continue;
					}
					break;
				}
				const indent = match[1].replace(/\t/g, "  ").length;
				let text = match[2];
				let checked = null;
				const task = RE_TASK.exec(text);
				if (task !== null) {
					checked = task[1].toLowerCase() === "x";
					text = task[2];
				}
				while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
				const item = { indent, checked, text, children: [] };
				const parent = stack[stack.length - 1].item;
				if (parent === null) items.push(item);
				else parent.children.push(item);
				stack.push({ indent, item });
				i += 1;
			}
			return { items, next: i };
		}

		/** Markdown 源码 → 块级数据树。 */
		function parseMarkdown(src) {
			const lines = String(src ?? "").split(/\r?\n/);
			const blocks = [];
			let i = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (/^\s*$/.test(line)) {
					i += 1;
					continue;
				}
				const fence = RE_FENCE.exec(line);
				if (fence !== null) {
					const lang = fence[1].trim();
					const body = [];
					i += 1;
					while (i < lines.length && !RE_FENCE.test(lines[i])) {
						body.push(lines[i]);
						i += 1;
					}
					i += 1;
					blocks.push({ type: "code", lang, text: body.join("\n") });
					continue;
				}
				const heading = RE_HEADING.exec(line);
				if (heading !== null) {
					blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
					i += 1;
					continue;
				}
				if (RE_HR.test(line)) {
					blocks.push({ type: "hr" });
					i += 1;
					continue;
				}
				if (RE_QUOTE.test(line)) {
					const quoted = [];
					while (i < lines.length && RE_QUOTE.test(lines[i])) {
						quoted.push(RE_QUOTE.exec(lines[i])[1]);
						i += 1;
					}
					blocks.push({ type: "quote", text: quoted.join("\n").trim() });
					continue;
				}
				if (RE_ITEM.test(line)) {
					const parsed = parseItems(lines, i);
					blocks.push({ type: "list", items: parsed.items });
					i = parsed.next;
					continue;
				}
				const paragraph = [];
				while (i < lines.length && !/^\s*$/.test(lines[i]) && !RE_HEADING.test(lines[i]) && !RE_ITEM.test(lines[i]) && !RE_QUOTE.test(lines[i]) && !RE_HR.test(lines[i]) && !RE_FENCE.test(lines[i])) {
					paragraph.push(lines[i].trim());
					i += 1;
				}
				blocks.push({ type: "paragraph", text: paragraph.join(" ") });
			}
			return blocks;
		}

		/** 行内数据节点 → React 节点。 */
		function renderInline(nodes) {
			return nodes.map((node, index) => {
				if (node.kind === "code") return h("code", { key: index, className: "tt-mdCode" }, node.text);
				if (node.kind === "strong") return h("strong", { key: index }, renderInline(node.nodes));
				if (node.kind === "em") return h("em", { key: index }, node.text);
				if (node.kind === "link") return h("a", { key: index, href: node.href, target: "_blank", rel: "noreferrer noopener" }, node.text);
				return node.text;
			});
		}

		/** 列表项 → React 节点；任务项画一个只读方框（不是 input，保持「无编辑控件」）。 */
		function renderItems(items) {
			return items.map((item, index) => h("li", {
				key: index,
				className: item.checked === null ? "tt-mdLi" : "tt-mdLi tt-mdTask",
				"data-checked": item.checked === null ? undefined : String(item.checked)
			},
				item.checked === null ? null : h("span", { className: "tt-mdBox", "aria-hidden": "true" }, item.checked ? "✓" : ""),
				h("span", { className: "tt-mdText" }, renderInline(parseInline(item.text))),
				item.children.length === 0 ? null : h("ul", { className: "tt-mdList" }, renderItems(item.children))
			));
		}

		/** 块级数据树 → React 节点。 */
		function renderBlocks(blocks) {
			return blocks.map((block, index) => {
				if (block.type === "heading") {
					const level = Math.min(Math.max(block.level, 1), 6);
					return h("h" + level, { key: index, className: "tt-mdH" + level }, renderInline(parseInline(block.text)));
				}
				if (block.type === "hr") return h("hr", { key: index, className: "tt-mdHr" });
				if (block.type === "code") return h("pre", { key: index, className: "tt-mdPre" }, h("code", null, block.text));
				if (block.type === "quote") return h("blockquote", { key: index, className: "tt-mdQuote" }, renderInline(parseInline(block.text)));
				if (block.type === "list") return h("ul", { key: index, className: "tt-mdList" }, renderItems(block.items));
				return h("p", { key: index, className: "tt-mdP" }, renderInline(parseInline(block.text)));
			});
		}

		/** 页签本体：取数 + 只读渲染。 */
		function TodoBody({ sessionId, t }) {
			const [state, setState] = useState({ status: "loading" });
			const [mode, setMode] = useState("rendered");
			const load = useCallback(async () => {
				if (typeof sessionId !== "string" || sessionId === "") {
					setState({ status: "no-session" });
					return;
				}
				setState({ status: "loading" });
				try {
					const res = await fetch(todoDataUrl(sessionId), { cache: "no-store" });
					const body = await res.json().catch(() => null);
					if (body === null || body.ok !== true) {
						setState({ status: "error", message: (body && body.message) || "HTTP " + res.status });
						return;
					}
					setState(body.exists === true ? { status: "ready", body } : { status: "empty", body });
				} catch (error) {
					setState({ status: "error", message: String((error && error.message) || error) });
				}
			}, [sessionId]);
			useEffect(() => {
				load();
			}, [load]);

			const info = state.body;
			const blocks = useMemo(() => (info !== undefined && info.exists === true ? parseMarkdown(info.content) : []), [info]);
			const head = h("div", { className: "tt-head" },
				h("span", { className: "tt-title" }, t("title")),
				info ? h("span", { className: "tt-workspace", title: info.workspace }, info.workspace) : null,
				h("span", { className: "tt-badge" }, t("readonly")),
				state.status === "ready" ? h("div", { className: "tt-modes" },
					h("button", { type: "button", className: "tt-mode", "data-active": String(mode === "rendered"), onClick: () => setMode("rendered") }, t("mode.rendered")),
					h("button", { type: "button", className: "tt-mode", "data-active": String(mode === "raw"), onClick: () => setMode("raw") }, t("mode.raw"))
				) : null,
				h("button", { className: "tt-btn", type: "button", onClick: load, disabled: state.status === "loading" }, t("refresh"))
			);

			let body = null;
			if (state.status === "loading") body = h("p", { className: "tt-state" }, t("loading"));
			else if (state.status === "no-session") body = h("p", { className: "tt-state" }, t("noSession"));
			else if (state.status === "error") body = h("p", { className: "tt-state", "data-error": true }, t("error") + state.message);
			else if (state.status === "empty") body = h("div", { className: "tt-state" },
				h("p", { style: { margin: "0 0 6px" } }, t("empty")),
				h("code", null, info ? info.path : "")
			);
			else if (mode === "raw") body = h("pre", { className: "tt-pre", "data-todo-tab-content": true }, info.content === "" ? t("empty") : info.content);
			else if (String(info.content).trim() === "") body = h("p", { className: "tt-state" }, t("empty"));
			else body = h("div", { className: "tt-md", "data-todo-tab-content": true }, renderBlocks(blocks));

			const pathLine = info && state.status === "ready"
				? h("div", { className: "tt-path" }, info.path + " · " + info.bytes + " B · " + new Date(info.mtimeMs).toLocaleString())
				: null;

			return h("div", { className: "tt-root", "data-todo-tab": state.status }, head, pathLine, h("div", { className: "tt-body" }, body));
		}

		/**
		 * 会话标题栏的入口按钮：点一下优先用 DSH 自己的文件预览打开 TODO.md
		 * （那边由产品按扩展名选 Markdown 实现渲染，能力比本插件自带的子集全），
		 * 文件不存在或端点异常时退回插件自己的 Todo 页签（它会把应放路径说清楚）。
		 * 打开失败时把原因显示在按钮旁边（只写 console 的话点了没反应，没法排查）。
		 */
		function TodoHeaderAction({ openTodo, t }) {
			const [failure, setFailure] = useState("");
			const [pending, setPending] = useState(false);
			return h("span", { className: "tt-headWrap" },
				h("button", {
					type: "button",
					className: "tt-headBtn",
					title: t("header.hint"),
					"aria-label": t("header.hint"),
					"data-todo-tab-open": true,
					disabled: pending,
					onClick: () => {
						setPending(true);
						Promise.resolve(openTodo()).then((message) => {
							setFailure(message);
							setPending(false);
						}, (error) => {
							setFailure(t("error") + String((error && error.message) || error));
							setPending(false);
						});
					}
				}, h(TodoGlyph, { size: 14 }), h("span", null, t("title"))),
				failure === "" ? null : h("span", { className: "tt-headError", "data-todo-tab-error": true }, failure)
			);
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		// sidebarRight 必须声明：cordis 只允许插件访问自己 inject 里列出的服务，
		// 少写一个就会在 ctx.sidebarRight 取值时抛 "without inject"（表现为点了没反应）。
		const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			// 打开入口：先问宿主要绝对路径，有文件就交给原生预览（dsh-resource://file/…），
			// 否则开插件自己的页签。失败时返回原因文本交给按钮显示，同时记一条 console 警告。
			const openTodo = async (sessionId) => {
				try {
					const res = await fetch(todoDataUrl(sessionId), { cache: "no-store" });
					const body = await res.json().catch(() => null);
					if (body !== null && body.ok === true && body.exists === true) {
						ctx.sidebarRight.openResource(todoResourceAddress(sessionId, body.path));
						return "";
					}
					ctx.sidebarRight.openTab(KIND);
					if (body !== null && body.ok === true) return "";
					return t("error") + ((body && body.message) || "HTTP " + res.status);
				} catch (error) {
					const message = String((error && error.message) || error);
					console.warn("todo-tab: open failed: " + message);
					return t("error") + message;
				}
			};
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "todo-tab: dictionaries");
			ctx.effect(() => ctx.sidebarRightTabs.register(todoDefinition(t)), "todo-tab: page type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: ID,
				locale: NS
			}, TodoBody)), "todo-tab: tab body");
			ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: ID,
				order: 40,
				locale: NS,
				inject: (sessionId) => ({ openTodo: () => openTodo(sessionId) })
			}, TodoHeaderAction)), "todo-tab: header action");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.todoDefinition = todoDefinition;
		exports.todoDataUrl = todoDataUrl;
		exports.todoResourceAddress = todoResourceAddress;
		exports.parseMarkdown = parseMarkdown;
		exports.parseInline = parseInline;
		exports.TodoBody = TodoBody;
		exports.TodoHeaderAction = TodoHeaderAction;
		exports.TodoGlyph = TodoGlyph;
		return module.exports;
	}
});
