window.__ModuleLoader__.load({
	id: 'dsh-plugin-session-export',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		// NOTE: pure helpers (markdown → XHTML, message markup, segment packing,
		// filename sanitizing) are DOM-free and exported for node-side tests; only
		// the button component, theme sampling, and the SVG-foreignObject
		// rasterizer touch the browser. The export image shows exactly user input
		// and model output — Think/reasoning and tool calls are already stripped
		// by the node half before this file ever sees the data.

		let react = require('react');
		const { useState, useRef, useCallback } = react;
		const h = react.createElement;

		// ── page styles (button + transient note) ─────────────────────────────
		const css = [
			'.dse-wrap{position:relative;display:inline-flex}',
			'.dse-action{flex:none;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;justify-content:center;align-items:center}',
			'.dse-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.dse-action:disabled{opacity:.5;cursor:default}',
			// Tooltip drawn locally from aria-label (native title tooltips are
			// inert in this platform), styled like the platform bubble.
			'.dse-action{position:relative}',
			'.dse-action::after{content:attr(aria-label);position:absolute;top:calc(100% + 8px);right:0;z-index:100;width:max-content;max-width:50vw;padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;opacity:0;transition:opacity .15s var(--ds-ease-in-out)}',
			'.dse-action:hover::after,.dse-action:focus-visible::after{opacity:1}',
			'.dse-action:disabled::after{display:none}',
			'@keyframes dse-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
			'.dse-action .dse-spin{animation:dse-spin 1s linear infinite}',
			'.dse-note{position:absolute;top:calc(100% + 8px);right:0;z-index:120;width:max-content;max-width:60vw;padding:3px 8px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:12px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none}',
			'.dse-note.ok{color:var(--dsw-alias-state-success-primary)}',
			'.dse-note.err{color:var(--dsw-alias-state-error-primary)}',
			'@media (prefers-reduced-motion:reduce){.dse-action::after{transition:none}}'
		].join('');
		const tagId = 'dsh-plugin-session-export/export.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-plugin-session-export';
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── locales ────────────────────────────────────────────────────────────
		const NS = 'session-export';
		const zh = {
			'export': '导出当前会话为长图',
			'exporting': '导出中…',
			'done': '已导出长图 {name}',
			'doneParts': '会话较长，已导出 {n} 张长图',
			'doneSkipped': '（已隐藏 {n} 条思考）',
			'empty': '会话暂无消息可导出',
			'error': '导出失败：{message}',
			'roleUser': '你',
			'roleAssistant': '助手',
			'imagePlaceholder': '图片附件（导出不含图片）',
			'meta': '{count} 条消息',
			'truncated': '超长会话，仅导出前部消息',
			'footer': '由 dsh 会话导出'
		};
		const en = {
			'export': 'Export this session as a long image',
			'exporting': 'Exporting…',
			'done': 'Exported long image {name}',
			'doneParts': 'Long session — exported {n} images',
			'doneSkipped': '（{n} thinking blocks hidden）',
			'empty': 'Nothing to export in this session',
			'error': 'Export failed: {message}',
			'roleUser': 'You',
			'roleAssistant': 'Assistant',
			'imagePlaceholder': 'Image attachment (not included in export)',
			'meta': '{count} messages',
			'truncated': 'Very long session — only the earlier messages exported',
			'footer': 'Exported from dsh'
		};

		// ── glyphs (16px outline, same language as sibling icons) ─────────────
		const ICON_EXPORT = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1.8" width="12" height="8.6" rx="1.6"></rect><circle cx="5" cy="4.8" r="0.9"></circle><path d="M2.9 9.2 5.9 6.3l2.4 2.3 1.5-1.4 3.3 3"></path><path d="M8 10.4v3.4"></path><path d="M6.6 12.4 8 13.8l1.4-1.4"></path></svg>';
		const ICON_LOADING = '<svg class="dse-spin" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6 A5.4 5.4 0 0 1 13.4 8"></path></svg>';

		// ── pure helpers (DOM-free, exported for tests) ───────────────────────
		/** Escape text for XML/HTML attribute & text contexts (XHTML-safe). */
		function escapeXml(value) {
			return String(value)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');
		}

		/** Escape raw source text before inline markdown (raw HTML shows as text). */
		function escapeMarkdownSource(value) {
			return String(value)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
		}

		/** Format an epoch-ms timestamp as YYYY-MM-DD HH:MM (local time). */
		function formatTime(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
			const date = new Date(ms);
			const pad = (v) => String(v).padStart(2, '0');
			return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
		}

		/**
		 * Inline markdown over ALREADY-ESCAPED text → XHTML. Inline code spans are
		 * split out first so their content is never re-processed.
		 */
		function renderInline(text) {
			const parts = String(text).split(/(`[^`\n]+`)/g);
			let out = '';
			for (const part of parts) {
				if (part.length > 2 && part.startsWith('`') && part.endsWith('`') && !part.includes('\n')) {
					out += '<code>' + part.slice(1, -1) + '</code>';
					continue;
				}
				out += part
					.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
					.replace(/~~([^~]+)~~/g, '<s>$1</s>')
					.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
					// inline images first (the generic link rule below would grab
					// their `[alt](url)` tail); the file never loads in the SVG,
					// so the alt text is shown in a plain bracket instead.
					.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt) => {
						const label = alt.trim() === '' ? '' : ': ' + alt.trim();
						return '[图片' + label + ']';
					})
					.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
						// url already passed escapeMarkdownSource (so & < > are
						// entities); only quotes still need escaping for the
						// attribute context.
						const safe = /^(https?:|mailto:|#)/i.test(url) ? url.replace(/"/g, '&quot;') : '';
						return safe === '' ? label : '<a href="' + safe + '">' + label + '</a>';
					});
			}
			return out;
		}

		/** Parse one list item line: { indent, ordered, content } or null. */
		function parseListItem(line) {
			const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
			if (match === null) return null;
			const indent = match[1].replace(/\t/g, '  ').length;
			return { indent, ordered: /^\d/.test(match[2]), content: match[3], checked: null };
		}

		/** Task-list checkbox `- [ ]` / `- [x]` → XHTML checkbox span. */
		function renderTaskPrefix(content) {
			const match = /^\[([ xX])\]\s+(.*)$/.exec(content);
			if (match === null) return { prefix: '', rest: content };
			return {
				prefix: '<span class="dse-check' + (match[1] === ' ' ? '' : ' on') + '"></span>',
				rest: match[2]
			};
		}

		/** Render a collected list block (possibly nested) → XHTML. */
		function renderListBlock(items) {
			const root = [];
			const stack = [{ children: root, indent: -1 }];
			for (const item of items) {
				while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop();
				const parent = stack[stack.length - 1];
				let list = parent.children.length === 0 ? undefined : parent.children[parent.children.length - 1];
				if (list === undefined || list.ordered !== item.ordered) {
					list = { ordered: item.ordered, items: [] };
					parent.children.push(list);
				}
				const li = { content: item.content, children: [] };
				list.items.push(li);
				stack.push({ children: li.children, indent: item.indent });
			}
			const renderList = (list) => {
				const tag = list.ordered ? 'ol' : 'ul';
				const items = list.items.map((li) => {
					const task = renderTaskPrefix(li.content);
					const childrenHtml = li.children.length > 0 ? li.children.map(renderList).join('') : '';
					const cls = task.prefix === '' ? '' : ' class="dse-task"';
					// content MUST pass escapeMarkdownSource like every other block
					// path — a raw `<tag>` inside a list item would break the SVG
					// foreignObject XML and make the segment image fail to load.
					return '<li' + cls + '>' + task.prefix + renderInline(escapeMarkdownSource(task.rest)) + childrenHtml + '</li>';
				}).join('');
				return '<' + tag + '>' + items + '</' + tag + '>';
			};
			return root.map(renderList).join('');
		}

		/** Render a GFM table block → XHTML. */
		function renderTable(lines) {
			const split = (line) => {
				const cells = line.trim().replace(/^\||\|$/g, '').split('|');
				return cells.map((cell) => cell.trim());
			};
			const header = split(lines[0]);
			const separator = split(lines[1]);
			if (header.length === 0 || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
			const headRow = '<tr>' + header.map((cell) => '<th>' + renderInline(escapeMarkdownSource(cell)) + '</th>').join('') + '</tr>';
			const bodyRows = lines.slice(2).map((line) => {
				const cells = split(line);
				return '<tr>' + cells.map((cell) => '<td>' + renderInline(escapeMarkdownSource(cell)) + '</td>').join('') + '</tr>';
			}).join('');
			return '<table><thead>' + headRow + '</thead><tbody>' + bodyRows + '</tbody></table>';
		}

		/**
		 * Markdown (GFM subset) → XHTML. Output is deliberately XHTML-safe so it
		 * can be embedded in SVG foreignObject: all tags well-formed, void
		 * elements self-closed, text escaped, attributes double-quoted.
		 */
		function renderMarkdownHtml(text) {
			const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
			const out = [];
			let i = 0;
			while (i < lines.length) {
				// blank lines are block separators, never content
				while (i < lines.length && lines[i].trim() === '') i += 1;
				if (i >= lines.length) break;
				const line = lines[i];
				const trimmed = line.trim();

				// fenced code block
				const fence = /^```(\S*)\s*$/.exec(trimmed);
				if (fence !== null) {
					const lang = fence[1];
					const code = [];
					i += 1;
					while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
						code.push(lines[i]);
						i += 1;
					}
					i += 1; // closing fence
					const langLabel = lang === '' ? '' : '<div class="dse-code-lang">' + escapeXml(lang) + '</div>';
					out.push('<pre>' + langLabel + '<code>' + escapeXml(code.join('\n')) + '</code></pre>');
					continue;
				}

				// heading
				const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
				if (heading !== null) {
					const level = heading[1].length;
					out.push('<h' + level + '>' + renderInline(escapeMarkdownSource(heading[2])) + '</h' + level + '>');
					i += 1;
					continue;
				}

				// horizontal rule
				if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
					out.push('<hr/>');
					i += 1;
					continue;
				}

				// blockquote
				if (trimmed.startsWith('>')) {
					const quote = [];
					while (i < lines.length && lines[i].trim().startsWith('>')) {
						quote.push(lines[i].trim().replace(/^>\s?/, ''));
						i += 1;
					}
					out.push('<blockquote>' + renderInline(escapeMarkdownSource(quote.join(' '))) + '</blockquote>');
					continue;
				}

				// list
				const firstItem = parseListItem(line);
				if (firstItem !== null) {
					const items = [firstItem];
					i += 1;
					while (i < lines.length) {
						const next = parseListItem(lines[i]);
						if (next === null) break;
						items.push(next);
						i += 1;
					}
					out.push(renderListBlock(items));
					continue;
				}

				// table
				if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
					const rows = [lines[i], lines[i + 1]];
					i += 2;
					while (i < lines.length && lines[i].trim() !== '' && lines[i].trim().includes('|')) {
						rows.push(lines[i]);
						i += 1;
					}
					const table = renderTable(rows);
					out.push(table === null ? '<p>' + renderInline(escapeMarkdownSource(lines[i - 2] ?? '')) + '</p>' : table);
					continue;
				}

				// paragraph: collect until blank line
				const paragraph = [];
				while (i < lines.length && lines[i].trim() !== '') {
					paragraph.push(lines[i]);
					i += 1;
				}
				out.push('<p>' + renderInline(escapeMarkdownSource(paragraph.join(' '))) + '</p>');
				while (i < lines.length && lines[i].trim() === '') i += 1;
			}
			return out.join('');
		}

		/** One message → export markup (role label + bubble/body). */
		function buildMessageHtml(message, labels) {
			const isUser = message.role === 'user';
			const time = formatTime(message.time);
			const roleHtml = escapeXml(isUser ? labels.user : labels.assistant) + (time === '' ? '' : ' · <span class="dse-time">' + time + '</span>');
			let body;
			if (isUser) {
				let content = renderMarkdownHtml(message.text);
				if (message.imageCount > 0) {
					content += '<div class="dse-imgnote">' + escapeXml(labels.image) + ' × ' + message.imageCount + '</div>';
				}
				body = '<div class="dse-bubble">' + content + '</div>';
			} else {
				body = '<div class="dse-body">' + renderMarkdownHtml(message.text) + '</div>';
			}
			return '<section class="dse-msg ' + (isUser ? 'dse-user' : 'dse-assistant') + '">' +
				'<div class="dse-role">' + roleHtml + '</div>' + body + '</section>';
		}

		/**
		 * The self-contained export stylesheet (embedded in every segment, since
		 * a foreignObject image renders in an isolated document).
		 */
		function buildExportCss(colors, opts) {
			const width = opts.width;
			return [
				'.dse-export{box-sizing:border-box;width:' + width + 'px;background:' + colors.bg + ';color:' + colors.text + ';font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.75;padding:28px 32px}',
				'.dse-export-head{padding-bottom:14px;border-bottom:1px solid ' + colors.border + '}',
				'.dse-title{font-size:20px;font-weight:700;margin:0;color:' + colors.text + ';word-break:break-word}',
				'.dse-meta{font-size:12px;color:' + colors.caption + ';margin:6px 0 0}',
				'.dse-msg{padding-top:22px}',
				'.dse-role{font-size:12px;color:' + colors.caption + ';margin-bottom:6px}',
				'.dse-time{opacity:.75}',
				'.dse-bubble{background:' + colors.bubble + ';color:' + colors.text + ';border-radius:18px;padding:10px 16px;max-width:82%;margin-left:auto}',
				'.dse-bubble p{margin:0 0 10px}.dse-bubble p:last-child{margin-bottom:0}',
				'.dse-imgnote{margin-top:8px;font-size:12px;color:' + colors.caption + ';border:1px dashed ' + colors.border + ';border-radius:8px;padding:6px 10px}',
				'.dse-msg h1,.dse-msg h2,.dse-msg h3,.dse-msg h4,.dse-msg h5,.dse-msg h6{margin:18px 0 10px;line-height:1.4;font-weight:650}',
				'.dse-msg h1{font-size:22px}.dse-msg h2{font-size:19px}.dse-msg h3{font-size:17px}.dse-msg h4{font-size:16px}.dse-msg h5{font-size:15px}.dse-msg h6{font-size:14px}',
				'.dse-msg p{margin:0 0 10px}.dse-msg p:last-child{margin-bottom:0}',
				'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;background:' + colors.codeBg + ';border-radius:5px;padding:2px 5px}',
				'pre{background:' + colors.codeBg + ';border-radius:10px;padding:12px 14px;margin:10px 0;overflow:hidden}',
				'pre code{background:none;padding:0;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;display:block}',
				'.dse-code-lang{font-size:11px;color:' + colors.caption + ';margin-bottom:6px}',
				'blockquote{margin:10px 0;padding:2px 0 2px 14px;border-left:3px solid ' + colors.border + ';color:' + colors.secondary + '}',
				'a{color:' + colors.business + ';text-decoration:none}',
				'ul,ol{margin:10px 0;padding-left:26px}',
				'li{margin:4px 0}',
				'.dse-task{list-style:none}',
				'.dse-check{display:inline-block;width:14px;height:14px;border:1.5px solid ' + colors.border + ';border-radius:4px;margin-right:8px;vertical-align:-2px}',
				'.dse-check.on{background:' + colors.business + ';border-color:' + colors.business + '}',
				'table{border-collapse:collapse;margin:10px 0;width:100%;font-size:14px}',
				'th,td{border:1px solid ' + colors.border + ';padding:6px 10px;text-align:left}',
				'th{background:' + colors.codeBg + ';font-weight:600}',
				'hr{border:none;border-top:1px solid ' + colors.border + ';margin:18px 0}',
				'.dse-footer{margin-top:30px;padding-top:14px;border-top:1px solid ' + colors.border + ';font-size:11px;color:' + colors.caption + ';text-align:center}'
			].join('');
		}

		/**
		 * Pack messages into segments and produce each segment's standalone HTML.
		 * Pure: heights come from a browser measure pass, everything else is
		 * string assembly.
		 * @param {{css: string, headerHtml: string, footerHtml: string, messageHtmls: string[], messageHeights: number[], headerH?: number, footerH?: number, opts: {segmentHeight: number}}} input
		 * @returns {{html: string, height: number}[]}
		 */
		function buildSegmentsHtml(input) {
			const { css, headerHtml, footerHtml, messageHtmls, messageHeights, headerH = 0, footerH = 0, opts } = input;
			const segMax = opts.segmentHeight;
			const segments = [];
			let current = [];
			let currentH = 0;
			for (let i = 0; i < messageHtmls.length; i += 1) {
				const height = messageHeights[i];
				if (current.length > 0 && currentH + height > segMax) {
					segments.push({ idx: current, contentH: currentH });
					current = [];
					currentH = 0;
				}
				current.push(i);
				currentH += height;
			}
			if (current.length > 0) segments.push({ idx: current, contentH: currentH });
			return segments.map((segment, index) => {
				const first = index === 0;
				const last = index === segments.length - 1;
				const body = segment.idx.map((i) => messageHtmls[i]).join('');
				const head = first ? headerHtml : '';
				const foot = last ? footerHtml : '';
				// .dse-export padding (28 top + 28 bottom) plus the footer's
				// margin-top (30); header bottom padding is inside headerH.
				const height = Math.round((first ? headerH : 0) + segment.contentH + (last ? footerH + 30 : 0) + 56);
				const html = '<style>' + css + '</style><div class="dse-export">' + head + body + foot + '</div>';
				return { html, height };
			});
		}

		/** Make a filesystem- and download-friendly file base name. */
		function sanitizeFileName(title) {
			const cleaned = String(title)
				.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
				.replace(/\s+/g, ' ')
				.trim()
				.replace(/[.\s]+$/g, '');
			if (cleaned === '' || !/[A-Za-z0-9\u4e00-\u9fff]/.test(cleaned)) return 'session';
			return cleaned.slice(0, 80);
		}

		// ── browser-only: theme sampling + rasterizer ─────────────────────────
		function cssVar(name, fallback) {
			try {
				const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
				return value === '' ? fallback : value;
			} catch {
				return fallback;
			}
		}

		/** Sample the live theme so the export matches what the user sees. */
		function sampleThemeColors() {
			return {
				bg: cssVar('--dsw-alias-bg-base', '#ffffff'),
				text: cssVar('--dsw-alias-label-primary', '#1f2329'),
				secondary: cssVar('--dsw-alias-label-secondary', '#4e5969'),
				caption: cssVar('--dsw-alias-label-caption', '#86909c'),
				bubble: cssVar('--dsw-specific-bubble', '#eaf1ff'),
				codeBg: cssVar('--dsw-alias-markdown-code-block', '#f2f3f5'),
				border: cssVar('--dsw-alias-border-l1', '#e5e6eb'),
				business: cssVar('--dsw-alias-state-business-primary', '#2563eb')
			};
		}

		/** Build the SVG foreignObject document for one segment. */
		function svgForSegment(html, width, height) {
			return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
				'<foreignObject width="100%" height="100%">' +
				'<div xmlns="http://www.w3.org/1999/xhtml">' + html + '</div>' +
				'</foreignObject></svg>';
		}

		function loadImage(src) {
			return new Promise((resolve, reject) => {
				const image = new Image();
				image.onload = () => resolve(image);
				image.onerror = () => reject(new Error('rasterize failed'));
				image.src = src;
			});
		}

		/** Rasterize one segment to a scaled canvas. */
		async function rasterizeSegment(segment, opts) {
			const scale = segment.height > opts.guardHeight ? 1 : opts.scale;
			const svg = svgForSegment(segment.html, opts.width, segment.height);
			// data: URL, NOT a blob URL: Chrome treats an SVG image with
			// <foreignObject> loaded from a blob: URL as tainting the canvas
			// (toBlob/toDataURL then throw), while the identical data: URL stays
			// clean (verified in headless Chrome 151).
			const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
			const image = await loadImage(src);
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(opts.width * scale);
			canvas.height = Math.round(segment.height * scale);
			const context = canvas.getContext('2d');
			context.scale(scale, scale);
			context.drawImage(image, 0, 0, opts.width, segment.height);
			return { canvas, cssHeight: segment.height };
		}

		/** Stitch segment canvases into one part canvas (height ≤ partHeight). */
		function composePart(segmentCanvases, partScale, width) {
			const totalPx = segmentCanvases.reduce((sum, item) => sum + Math.round(item.cssHeight * partScale), 0);
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(width * partScale);
			canvas.height = totalPx;
			const context = canvas.getContext('2d');
			let y = 0;
			for (const item of segmentCanvases) {
				const heightPx = Math.round(item.cssHeight * partScale);
				context.drawImage(item.canvas, 0, y, canvas.width, heightPx);
				y += heightPx;
			}
			return canvas;
		}

		/** Rasterize all segments, grouped into downloadable parts. */
		async function rasterizeParts(segments, opts) {
			const partMaxPx = opts.partHeight * opts.scale;
			const parts = [];
			let current = [];
			let currentPx = 0;
			for (const segment of segments) {
				const segmentPx = segment.height * opts.scale;
				if (current.length > 0 && currentPx + segmentPx > partMaxPx) {
					parts.push(current);
					current = [];
					currentPx = 0;
				}
				current.push(segment);
				currentPx += segmentPx;
			}
			if (current.length > 0) parts.push(current);
			const canvases = [];
			for (const part of parts) {
				const rendered = [];
				for (const segment of part) rendered.push(await rasterizeSegment(segment, opts));
				const anyGuard = rendered.some((item) => item.canvas.height !== Math.round(item.cssHeight * opts.scale));
				const partScale = anyGuard ? 1 : opts.scale;
				canvases.push(composePart(rendered, partScale, opts.width));
			}
			return canvases;
		}

		function canvasToBlob(canvas) {
			return new Promise((resolve, reject) => {
				canvas.toBlob((blob) => {
					if (blob !== null) resolve(blob);
					else reject(new Error('canvas.toBlob failed'));
				}, 'image/png');
			});
		}

		function downloadBlob(blob, filename) {
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10000);
		}

		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		/**
		 * Full export pipeline: fetch transcript → build markup → measure →
		 * segment → rasterize → download (one image, or parts for long chats).
		 * @param {any} data - /session-export/data response.
		 * @param {{t: (key: string, vars?: object) => string}} helpers
		 * @returns {Promise<{parts: number, name: string}>}
		 */
		async function exportToLongImage(data, { t }) {
			const cfg = Object.assign(
				{ width: 860, scale: 2, partHeight: 10000, segmentHeight: 8000 },
				typeof data.config === 'object' && data.config !== null ? data.config : {}
			);
			const width = clamp(cfg.width, 480, 1400);
			const scale = clamp(cfg.scale, 1, 3);
			const partHeight = clamp(cfg.partHeight, 2000, 20000);
			const segMax = clamp(cfg.segmentHeight, 1000, 12000);
			const colors = sampleThemeColors();
			const css = buildExportCss(colors, { width });
			const labels = {
				user: t('roleUser'),
				assistant: t('roleAssistant'),
				image: t('imagePlaceholder')
			};
			const title = (data.title ?? '').trim() === '' ? 'dsh session' : data.title.trim();
			const meta = t('meta', { count: data.messages.length }) + (data.truncated ? ' · ' + t('truncated') : '');
			const headerHtml = '<header class="dse-export-head"><h1 class="dse-title">' + escapeXml(title) + '</h1><p class="dse-meta">' + escapeXml(meta) + '</p></header>';
			const footerHtml = '<footer class="dse-footer">' + escapeXml(t('footer')) + '</footer>';
			const messageHtmls = data.messages.map((message) => buildMessageHtml(message, labels));

			// Measure pass: a fixed off-screen container at the export width.
			const root = document.createElement('div');
			root.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + width + 'px;pointer-events:none;z-index:-1';
			root.innerHTML = '<style>' + css + '</style>' + headerHtml + messageHtmls.join('') + footerHtml;
			document.body.appendChild(root);
			try {
				try {
					await document.fonts.ready;
				} catch {}
				const headerNode = root.querySelector('.dse-export-head');
				const footerNode = root.querySelector('.dse-footer');
				const headerH = headerNode === null ? 0 : headerNode.offsetHeight;
				const footerH = footerNode === null ? 0 : footerNode.offsetHeight;
				const messageHeights = [...root.querySelectorAll('.dse-msg')].map((el) => el.offsetHeight);
				const segments = buildSegmentsHtml({
					css,
					headerHtml,
					footerHtml,
					messageHtmls,
					messageHeights,
					headerH,
					footerH,
					opts: { segmentHeight: segMax }
				});
				const partCanvases = await rasterizeParts(segments, { width, scale, partHeight, guardHeight: segMax });
				const baseName = sanitizeFileName(title);
				const blobs = [];
				for (const canvas of partCanvases) blobs.push(await canvasToBlob(canvas));
				blobs.forEach((blob, index) => {
					const filename = blobs.length > 1 ? baseName + '-' + (index + 1) + '.png' : baseName + '.png';
					downloadBlob(blob, filename);
				});
				return { parts: blobs.length, name: baseName + (blobs.length > 1 ? '-1.png' : '.png') };
			} finally {
				root.remove();
			}
		}

		// ── header action button ──────────────────────────────────────────────
		function ExportAction({ sessionId, t }) {
			const [busy, setBusy] = useState(false);
			const [note, setNote] = useState(null);
			const noteTimer = useRef(null);
			const showNote = useCallback((text, ok) => {
				setNote(text === '' ? null : { text, ok });
				clearTimeout(noteTimer.current);
				if (text !== '') {
					noteTimer.current = setTimeout(() => setNote(null), 6000);
				}
			}, []);
			const run = async () => {
				if (busy || sessionId === undefined) return;
				setBusy(true);
				setNote(null);
				try {
					const response = await fetch('/session-export/data?session=' + encodeURIComponent(sessionId), { cache: 'no-store' });
					const data = await response.json();
					if (typeof data !== 'object' || data === null || data.ok !== true) {
						throw new Error(data?.message ?? 'export data failed');
					}
					if (!Array.isArray(data.messages) || data.messages.length === 0) {
						showNote(t('empty'), false);
						return;
					}
					const result = await exportToLongImage(data, { t });
					let message = result.parts > 1
						? t('doneParts', { n: result.parts })
						: t('done', { name: result.name });
					if (typeof data.skipped?.reasoning === 'number' && data.skipped.reasoning > 0) {
						message += ' ' + t('doneSkipped', { n: data.skipped.reasoning });
					}
					showNote(message, true);
				} catch (error) {
					showNote(t('error', { message: error instanceof Error ? error.message : String(error) }), false);
				} finally {
					setBusy(false);
				}
			};
			const label = t(busy ? 'exporting' : 'export');
			return h('span', { className: 'dse-wrap' },
				h('button', {
					type: 'button',
					className: 'dse-action',
					'aria-label': label,
					title: label,
					disabled: busy,
					onClick: run
				}, busy ? ICON_LOADING : ICON_EXPORT),
				note === null ? null : h('span', { className: 'dse-note ' + (note.ok ? 'ok' : 'err'), role: 'status' }, note.text)
			);
		}

		// ── plugin entry ───────────────────────────────────────────────────────
		const inject = ['slots', 'locale', 'sessions'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-export: dictionaries');
			ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
				name: 'conversation.session.header.actions',
				id: 'session-export',
				order: 30,
				locale: NS
			}, ExportAction));
		}

		exports.ExportAction = ExportAction;
		exports.escapeXml = escapeXml;
		exports.renderMarkdownHtml = renderMarkdownHtml;
		exports.buildMessageHtml = buildMessageHtml;
		exports.buildExportCss = buildExportCss;
		exports.buildSegmentsHtml = buildSegmentsHtml;
		exports.sanitizeFileName = sanitizeFileName;
		exports.sampleThemeColors = sampleThemeColors;
		exports.exportToLongImage = exportToLongImage;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
