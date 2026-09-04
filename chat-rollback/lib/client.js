window.__ModuleLoader__.load({
	id: 'dsh-plugin-chat-rollback',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		// NOTE: no platform requires here — the plugin mounts itself under each
		// user bubble through DOM injection (the platform exposes no user-message
		// action slot), reads node data from the session snapshot, and draws all
		// glyphs locally in the same 16px outline language as the built-in icons.

		// ── styles (injected once, tagged like the built bundles) ──────────────
		const css = [
			// fallback strip when the platform action row cannot be located
			'.crb-user-wrap{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:2px;padding-right:6px;min-height:20px}',
			'.crb-action{flex:none;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;justify-content:center;align-items:center}',
			'.crb-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.crb-action.confirm{color:var(--dsw-alias-state-error-primary)}',
			'.crb-action.confirm:hover{color:var(--dsw-alias-state-error-primary)}',
			'.crb-action.conflict{color:var(--dsw-alias-state-warning-primary,#e3a008)}',
			'.crb-action.conflict:hover{color:var(--dsw-alias-state-warning-primary,#e3a008)}',
			'.crb-action:disabled{opacity:.5;cursor:default}',
			// Native title tooltips are inert in this platform, so the hover label
			// is drawn locally from the button's aria-label — styled exactly like
			// the platform bubble (tooltip-bg, 13/20, 3x7/8px, 50vw).
			'.crb-action{position:relative}',
			'.crb-action::after{content:attr(aria-label);position:absolute;top:calc(100% + 8px);right:0;z-index:100;width:max-content;max-width:50vw;padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;opacity:0;transition:opacity .15s var(--ds-ease-in-out)}',
			'.crb-action:hover::after,.crb-action:focus-visible::after{opacity:1}',
			'.crb-action:disabled::after{display:none}',
			'@media (prefers-reduced-motion:reduce){.crb-action::after{transition:none}}',
			'@keyframes crb-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
			'.crb-action .crb-spin{animation:crb-spin 1s linear infinite}',
			'.crb-note{display:flex;justify-content:flex-end;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.crb-note.ok{color:var(--dsw-alias-state-success-primary)}',
			'.crb-note.err{color:var(--dsw-alias-state-error-primary)}'
		].join('');
		const tagId = 'dsh-plugin-chat-rollback/rollback.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-plugin-chat-rollback';
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── locales ────────────────────────────────────────────────────────────
		const NS = 'chat-rollback';
		const zh = {
			'rollback.here': '回滚到这条消息之前',
			'rollback.confirm': '确认回滚？',
			'rollback.busy': '回滚中…',
			'rollback.created': '已创建新会话并打开',
			'rollback.archived': '原会话已自动归档',
			'rollback.snapshots': '已继承历史快照，可继续回滚',
			'rollback.openFailed': '新会话已创建，但打开失败',
			'rollback.error': '回滚失败',
			'rollback.codeRestored': '已恢复工作区到回滚点',
			'rollback.codeSkipped': '无工作区快照，仅回滚对话（代码修改保留）',
			'rollback.codeFailed': '代码恢复失败',
			'rollback.conflict': '存在版本冲突，文件 {files} 在其他会话中也存在改动，本次回滚会将以上改动覆盖',
			'rollback.conflictRecheck': '文件被其他会话改动，需再次确认',
			'rollback.emptyWarn': '快照为空，回滚将清空工作区——再次点击确认执行',
			'rollback.rolledBack': '恢复失败，已自动还原工作区',
			'rollback.stage.backup': '正在备份当前工作区…',
			'rollback.stage.restore': '正在恢复文件…',
			'rollback.stage.inherit': '正在继承历史快照…',
			'rollback.stage.archive': '正在归档原会话…',
			'rollback.tip': '在目标消息处截断历史，创建新会话继续对话（原会话自动归档）'
		};
		const en = {
			'rollback.here': 'Roll back to before this message',
			'rollback.confirm': 'Confirm?',
			'rollback.busy': 'Rolling back…',
			'rollback.created': 'New session created and opened',
			'rollback.archived': 'Original session archived',
			'rollback.snapshots': 'History snapshots inherited — rollback stays available',
			'rollback.openFailed': 'Session created, but opening failed',
			'rollback.error': 'Rollback failed',
			'rollback.codeRestored': 'Workspace restored to the rollback point',
			'rollback.codeSkipped': 'No workspace snapshot — conversation only (code changes kept)',
			'rollback.codeFailed': 'Workspace restore failed',
			'rollback.conflict': 'Version conflict: {files} also changed in other sessions — this rollback will overwrite those changes',
			'rollback.conflictRecheck': 'Files changed by other sessions — confirm again',
			'rollback.emptyWarn': 'Snapshot is empty — rollback will wipe the workspace. Click again to confirm',
			'rollback.rolledBack': 'Restore failed; workspace auto-rolled-back',
			'rollback.stage.backup': 'Backing up workspace…',
			'rollback.stage.restore': 'Restoring files…',
			'rollback.stage.inherit': 'Inheriting snapshots…',
			'rollback.stage.archive': 'Archiving source session…',
			'rollback.tip': 'Cut history before this message and continue in a new session (the original is archived)'
		};

		// ── glyphs (local, same 16px outline language as sibling icons) ────────
		// Rewind glyph: counter-clockwise history loop with an L-shaped head
		// (48-viewBox source kept verbatim; stroke rides currentColor so the
		// button's theme/state colors apply). aria-hidden: decorative (the
		// button itself carries the localized label).
		const ICON_ROLLBACK = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2721 36.7279C14.5294 39.9853 19.0294 42 24 42C33.9411 42 42 33.9411 42 24C42 14.0589 33.9411 6 24 6C19.0294 6 14.5294 8.01472 11.2721 11.2721C9.61407 12.9301 6 17 6 17"></path><path d="M6 9V17H14"></path></svg>';
		const ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.4 L6.4 11.6 L12.8 4.4"></path></svg>';
		const ICON_CONFLICT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 5.6a2.3 2.3 0 1 1 3.6 1.9c-.7.6-1.3 1.2-1.3 2.1"/><path d="M8 12.7v.1"/></svg>';
		const ICON_LOADING = '<svg class="crb-spin" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6 A5.4 5.4 0 0 1 13.4 8"></path></svg>';

		/** One under-bubble control: icon button + transient note. */
		function createControl(t) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'crb-action';
			button.innerHTML = ICON_ROLLBACK;
			button.setAttribute('aria-label', t('rollback.here'));
			button.setAttribute('title', t('rollback.here'));
			const note = document.createElement('span');
			note.className = 'crb-note';
			note.hidden = true;
			let noteTimer = null;
			const control = {
				button,
				note,
				confirm: false,
				conflict: false,
				conflictFiles: [],
				// 仅在 409（冲突/空快照）之后为 true：下一次确认点击才携带 force=1。
				// 正常 preflight 通过后的确认**不带** force——服务端执行前会再校验
				// 一次（TOCTOU 收窄），若此时有新冲突会 409 回来走确认流程。
				forcePending: false,
				busy: false,
				showNote(text, ok) {
					note.textContent = text;
					note.className = 'crb-note' + (ok ? ' ok' : ' err');
					note.hidden = text === '';
					clearTimeout(noteTimer);
					if (text !== '') noteTimer = setTimeout(() => { note.textContent = ''; note.hidden = true; }, 6000);
				},
				paint() {
					let label, icon, extra = '';
					if (control.busy) {
						label = t('rollback.busy');
						icon = ICON_LOADING;
					} else if (control.confirm) {
						label = t('rollback.confirm');
						icon = ICON_CHECK;
						extra = ' confirm';
					} else if (control.conflict) {
						label = control.conflictLabel();
						icon = ICON_CONFLICT;
						extra = ' conflict';
					} else {
						label = t('rollback.here');
						icon = ICON_ROLLBACK;
					}
					button.setAttribute('aria-label', label);
					button.setAttribute('title', label);
					button.className = 'crb-action' + extra;
					button.disabled = control.busy;
					button.innerHTML = icon;
				},
				conflictLabel() {
					const files = control.conflictFiles ?? [];
					const list = files.slice(0, 5).join('、') + (files.length > 5 ? '…' : '');
					return t('rollback.conflict').replace('{files}', list);
				}
			};
			button.addEventListener('click', () => {
				if (control.busy) return;
				if (control.confirm) {
					control.confirm = false;
					control.busy = true;
					const force = control.forcePending === true;
					control.forcePending = false;
					control.paint();
					// 仅 409（冲突/空快照）之后的确认携带 force=1；正常确认不带，
					// 让服务端执行前的二次校验仍然生效。
					runRollback(control, force);
					return;
				}
				if (control.conflict) {
					control.conflict = false;
					control.confirm = true;
					control.paint();
					return;
				}
				// idle: the first click runs the conflict preflight; the ✓ or ? gate
				// appears only after the server has compared per-file hashes.
				control.busy = true;
				control.paint();
				runPreflight(control);
			});
			// Two-step confirm safety: focus leaving the button (click elsewhere,
			// Tab away, Esc-adjacent moves) cancels the armed confirm state, so a
			// stray second click after a context switch never fires the rollback.
			button.addEventListener('blur', () => {
				if (control.busy || (!control.confirm && !control.conflict)) return;
				control.confirm = false;
				control.conflict = false;
				control.paint();
			});
			control.paint();
			return control;
		}

		// 点击流程中止与 ndjson 阶段文案的统一辅助（绑定缺失/请求失败/阶段行共用）。
		function failControl(control, message) {
			control.busy = false;
			control.paint?.();
			control.showNote?.(message, false);
		}
		const STAGE_KEYS = { backup: 'rollback.stage.backup', restore: 'rollback.stage.restore', inherit: 'rollback.stage.inherit', archive: 'rollback.stage.archive' };

		/** First-click preflight: compare per-file hashes server-side and gate the
		 * confirm (✓) behind a conflict (?) state when another session also changed
		 * files this rollback would overwrite. */
		async function runPreflight(control) {
			const { sessionId, msgId, t } = control.binding ?? {};
			if (sessionId === undefined || typeof msgId !== 'string' || msgId === '') {
				failControl(control, t?.('rollback.error') ?? 'rollback failed');
				return;
			}
			try {
				const res = await fetch('/chat-rollback/preflight?session=' + encodeURIComponent(sessionId) + '&key=' + encodeURIComponent(msgId), { method: 'POST', cache: 'no-store' });
				const data = await res.json();
				if (typeof data !== 'object' || data === null) throw new Error('invalid preflight response');
				if (!data.ok) {
					control.showNote(String(data.message ?? data.code ?? t?.('rollback.error') ?? 'preflight failed'), false);
					return;
				}
				if (data.conflict && Array.isArray(data.files) && data.files.length > 0) {
					control.conflictFiles = data.files;
					control.conflict = true;
				} else {
					control.confirm = true;
				}
			} catch (err) {
				control.showNote(err instanceof Error ? err.message : String(err), false);
			} finally {
				control.busy = false;
				control.paint();
			}
		}

		/** The rollback request; session/seq ride the control's current binding.
		 * force=true 时携带 force=1（409 冲突/空快照确认后的二次点击）；默认
		 * stream=1 走 ndjson 阶段流，busy 期间按阶段展示恢复进度文案。 */
		async function runRollback(control, force) {
			const { sessions, sessionId, msgId, t } = control.binding ?? {};
			if (sessions === undefined || typeof msgId !== 'string' || msgId === '' || sessionId === undefined) {
				failControl(control, t?.('rollback.error') ?? 'rollback failed');
				return;
			}
			try {
				const url = '/chat-rollback/rollback?session=' + encodeURIComponent(sessionId) + '&key=' + encodeURIComponent(msgId) + '&stream=1' + (force ? '&force=1' : '');
				const res = await fetch(url, { method: 'POST', cache: 'no-store' });
				// 409 拦截：TOCTOU 冲突或空快照清空 —— 不执行，回到确认态
				if (res.status === 409) {
					const data = await res.json().catch(() => ({}));
					if (data?.code === 'conflict') {
						control.conflictFiles = Array.isArray(data.files) ? data.files : [];
						control.conflict = true;
						control.confirm = false;
						control.forcePending = true;
						control.paint();
						control.showNote(t('rollback.conflictRecheck'), false);
						return;
					}
					if (data?.code === 'empty-snapshot') {
						control.conflict = false;
						control.confirm = true;
						control.forcePending = true;
						control.paint();
						control.showNote(t('rollback.emptyWarn'), false);
						return;
					}
					control.showNote(String(data?.message ?? t('rollback.error')), false);
					return;
				}
				if (!res.ok || !res.body) {
					const data = await res.json().catch(() => ({}));
					control.showNote(String(data?.message ?? t('rollback.error')), false);
					return;
				}
				// ndjson 阶段流：{phase} 行 + 最后 {phase:'done', ...body}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				let data = null;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let nl;
					while ((nl = buffer.indexOf('\n')) !== -1) {
						const line = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						if (line.trim() === '') continue;
						let msg;
						try { msg = JSON.parse(line); } catch { continue; }
						const stageKey = STAGE_KEYS[msg.phase];
						if (stageKey !== undefined) control.showNote(t(stageKey), false);
						if (msg.phase === 'done') data = msg;
					}
				}
				if (data === null || typeof data !== 'object' || data.ok !== true) {
					control.showNote(String(data?.message ?? data?.code ?? t('rollback.error')), false);
					return;
				}
				let note = t('rollback.created');
				if (data.archivedSource) note += ' · ' + t('rollback.archived');
				if (typeof data.inheritedSnapshots === 'number' && data.inheritedSnapshots > 0) note += ' · ' + t('rollback.snapshots');
				if (data.codeRollback !== undefined) {
					const cb = data.codeRollback;
					if (cb.restored) note += ' · ' + t('rollback.codeRestored');
					else if (cb.reason !== 'no-snapshot' && cb.reason !== 'no-cwd') {
						note += ' · ' + t('rollback.codeFailed') + (typeof cb.message === 'string' ? ': ' + cb.message : '');
						if (cb.rolledBack) note += ' · ' + t('rollback.rolledBack');
					}
				}
				control.showNote(note, true);
				await sessions.refresh();
				const next = data.nextInput;
				if (typeof next === 'string' && next !== '') {
					// Prefill the NEW session's composer with the rolled-back
					// message's text. The composer shell is created during
					// session materialization (its slash listeners are already
					// wired), and a fresh machine starts at draftRev 0 — so an
					// untouched draft accepts {start:0,end:0,draftRev:0}. If the
					// user already typed, the rev check fails silently.
					//
					// The dispatch MUST carry the session ctx as `thisArg`:
					// cordis' dispatch only context-filters listeners when a
					// subject is given (thisArg[Context.filter]); a bare
					// `ctx.emit(event, ...)` runs every listener on the hooks
					// table — which, with the shared session-ctx architecture,
					// prefilled EVERY mounted composer with the rolled-back
					// text. The dsh input-trigger uses the same shaped call
					// (actx.bail(actx, "slash/input-insert-text", ...)).
					const binding = sessions.binding(data.sessionId);
					binding?.ctx.emit(binding.ctx, 'slash/input-insert-text', {
						text: next,
						span: { start: 0, end: 0, draftRev: 0 }
					});
				}
				sessions.open(data.sessionId);
			} catch (err) {
				control.showNote(err instanceof Error ? err.message : String(err), false);
			} finally {
				control.busy = false;
				control.paint?.();
			}
		}

		// ── DOM injection: one control under each user bubble ─────────────────
		const USER_KINDS = new Set(['user', 'steering']);
		const inject = ['locale', 'sessions'];

		function apply(ctx) {
			const dbg = (...args) => { try { console.error('[chat-rollback]', ...args); } catch (e) {} };
			const dbgState = { phase: 'apply-started', scans: 0, rowsSeen: 0, mounted: 0, reasons: [] };
			const publish = () => { try { window.__crbDebug = dbgState; } catch (e) {} }; // 诊断外露（无声计数）
			publish();
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chat-rollback: dictionaries');
			} catch (error) {
				dbg('locale/effect setup failed:', error);
				dbgState.phase = "locale-effect-failed";
				publish();
				return;
			}
			let t;
			try {
				t = ctx.locale.bind(NS);
			} catch (error) {
				dbg('locale.bind failed:', error);
				dbgState.phase = "locale-bind-failed";
				publish();
				return;
			}
			// Map (not WeakMap): the locale-change repaint iterates mounted.values(),
			// which WeakMap does not support. Rows are removed on detach().
			const mounted = new Map(); // row -> { seq, kind, control }
			let timer = null;
			const schedule = () => {
				clearTimeout(timer);
				timer = setTimeout(scan, 120);
			};
			const detach = (row) => {
				const entry = mounted.get(row);
				if (entry === undefined) return;
				entry.control.button.remove();
				entry.control.note.remove();
				mounted.delete(row);
			};
			function scan() {
				// 清理已离开 DOM 的行：会话切换/渲染回收时这些行不会再出现在
				// 行循环里，detach 不会被触发——先统一清掉，防 mounted Map 与
				// DOM 引用泄漏。
				dbgState.scans += 1;
				for (const row of mounted.keys()) {
					if (!row.isConnected) detach(row);
				}
				let sessionId;
				try {
					const listCtx = ctx.sessions?.list;
					const list = typeof listCtx?.getSnapshot === 'function' ? listCtx.getSnapshot() : null;
					sessionId = list?.current;
					if (sessionId === undefined) {
						dbgState.reasons.push('no-current-session');
						publish();
						return;
					}
				} catch (error) {
					dbg('session list read failed:', error);
					dbgState.reasons.push('session-ex: ' + String(error?.message ?? error));
					publish();
					return;
				}
				for (const row of document.querySelectorAll('[data-chat-anchor-key]')) {
					dbgState.rowsSeen += 1;
					const kind = row.getAttribute('data-chat-flow-kind') ?? '';
					const key = row.getAttribute('data-chat-anchor-key') ?? '';
					const entry = mounted.get(row);
					if (!USER_KINDS.has(kind)) {
						if (entry !== undefined) detach(row);
						continue;
					}
					// alpha.4 行 key 形如 "13:input-message<uuid>"：uuid = 该 user/message
					// 事件在宿主日志里的 data.id。host 端按 key 反查 event seq（等价于旧版
					// anchorSeq），无需注入 uiConversation / 读 chat 快照。
					const msgMatch = key.match(/input-message([0-9A-Za-z-]+)$/);
					const msgId = (msgMatch !== null ? msgMatch[1] : key.split(':').pop() ?? '');
					if (msgId === '') {
						dbgState.reasons.push('no-msg-id-for:' + key);
						if (entry !== undefined) detach(row);
						continue;
					}
					if (entry !== undefined && entry.msgId === msgId && entry.kind === kind) continue;
					if (entry !== undefined) detach(row);
					const control = createControl(t);
					control.binding = { sessions: ctx.sessions, sessionId, msgId, t };
					// 操作条定位（与复制按钮同排）：老锚点 data-time-hover-root 在
					// dsh 0.1.2-alpha.4 已删除——依次尝试 ①老锚点 ②复制按钮父容器
					// （aria-label 复制/Copy/已复制/copied）③含 actions 的容器 ④气泡下兜底行。
					let actionsEl = null;
					const legacyRow = row.querySelector('[data-time-hover-root]');
					if (legacyRow !== null) actionsEl = legacyRow.lastElementChild;
					if (!(actionsEl instanceof HTMLElement && actionsEl.querySelector('button') !== null)) {
						actionsEl = null;
						const copyBtn = Array.prototype.find.call(
							row.querySelectorAll('button[aria-label]'),
							(btn) => /^(复制|Copy|copied|已复制)$/i.test((btn.getAttribute('aria-label') || '').trim())
						);
						if (copyBtn !== undefined && copyBtn.parentElement !== null) actionsEl = copyBtn.parentElement;
					}
					if (!(actionsEl instanceof HTMLElement && actionsEl.querySelector('button') !== null)) {
						actionsEl = row.querySelector('[class*="actions"]');
					}
					if (actionsEl instanceof HTMLElement && actionsEl.querySelector('button') !== null) {
						actionsEl.appendChild(control.button);
					} else {
						const wrapper = document.createElement('span');
						wrapper.className = 'crb-user-wrap';
						wrapper.appendChild(control.button);
						row.appendChild(wrapper);
					}
					row.appendChild(control.note);
					mounted.set(row, { msgId, kind, control });
					dbgState.mounted = mounted.size;
					publish();
				}
			}
			// Rows appear/update on chat re-renders and paging; the list feed
			// covers session switches; a locale switch repaints mounted controls.
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			const unsubscribe = ctx.sessions.list.subscribe(schedule);
			const unsubscribeLocale = ctx.locale.subscribe(() => {
				for (const entry of mounted.values()) entry.control.paint();
			});
			schedule();
			return () => {
				observer.disconnect();
				unsubscribe?.();
				unsubscribeLocale?.();
				clearTimeout(timer);
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
