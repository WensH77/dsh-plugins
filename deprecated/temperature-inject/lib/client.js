// dsh-plugin-temperature-inject — 浏览器端。
//
// 两个挂载点，共享同一个会话级 store：
//   conversation.input.left  → 「温度调节」开关按钮（常驻，紧凑）
//   conversation.input.dock  → 0~1、step 0.2 的温度滑杆（**仅在开关打开时渲染**）
//
// 状态读写走宿主端点 /temperature-inject/session（会话级、内存态；不用 settings 命名空间，
// 因为它是 per-session 的，而 settings 是全局文档）。
window.__ModuleLoader__.load({
	id: 'dsh-plugin-temperature-inject',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');
		const { useState, useEffect, useRef } = react;
		const h = react.createElement;

		const NS = 'temperature-inject';
		const ENDPOINT = '/temperature-inject/session';
		// 用户定的规格：范围 0~1、step 0.2。上界 1 是「多步 agentic 任务的实测可用区间」
		// 上界（1.5 起子代理输出会退化成 token soup，见 README §7）——不要用文档的 0~2。
		const MIN = 0;
		const MAX = 1;
		const STEP = 0.2;

		// ── styles（注入一次，按插件名打标，与内置 bundle 同款做法）─────────────
		const css = [
			'.ti-toggle{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:14px;background:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:26px;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}',
			'.ti-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.ti-toggle[data-active="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
			'.ti-toggle:disabled{opacity:.5;cursor:default}',
			'.ti-bar{display:flex;align-items:center;gap:10px;width:100%;padding:2px 2px 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.ti-bar .ti-label{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.ti-bar .ti-range{flex:1;min-width:120px;height:18px;accent-color:var(--dsw-alias-state-business-primary)}',
			'.ti-bar .ti-value{flex:none;min-width:26px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
			'.ti-bar .ti-hint{flex:none;color:var(--dsw-alias-label-tertiary)}'
		];
		const tagId = 'dsh-plugin-temperature-inject';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
			const tag = document.createElement('style');
			tag.setAttribute('data-plugin-css', tagId);
			tag.textContent = css.join('\n');
			document.head.appendChild(tag);
		}

		// ── i18n（双语，宿主强制两套齐全）────────────────────────────────────
		const zh = {
			on: '温度',
			off: '温度 关',
			title: '温度调节：打开后，本会话派出的子代理会用「deepseek-flash + 关闭思考 + 指定温度」运行（0~1）',
			sliderLabel: '子代理温度',
			hint: '仅本会话 · 关闭思考'
		};
		const en = {
			on: 'Temp',
			off: 'Temp off',
			title: 'Temperature: when on, subagents delegated from this session run with deepseek-flash + thinking off + this temperature (0~1)',
			sliderLabel: 'Subagent temperature',
			hint: 'this session only · thinking off'
		};

		// ── 会话级 store（两个 slot 共享同一份缓存与订阅）────────────────────
		const store = {
			cache: new Map(),
			listeners: new Set(),
			get(key) {
				const value = this.cache.get(key);
				return value === undefined ? null : value;
			},
			emit(key, value) {
				this.cache.set(key, value);
				for (const fn of [...this.listeners]) {
					try {
						fn(key, value);
					} catch {
						/* 单个订阅者出错不影响其它 */
					}
				}
			},
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			},
			async load(key) {
				if (key === '') return;
				try {
					const res = await fetch(ENDPOINT + '?session=' + encodeURIComponent(key), { cache: 'no-store' });
					if (res.ok) this.emit(key, await res.json());
				} catch {
					/* 宿主端点不可用时保持本地状态 */
				}
			},
			async write(key, patch) {
				if (key === '') return null;
				try {
					const res = await fetch(ENDPOINT, {
						method: 'POST',
						cache: 'no-store',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ session: key, ...patch })
					});
					if (res.ok) {
						const value = await res.json();
						this.emit(key, value);
						return value;
					}
				} catch {
					/* 写失败时保留旧值，下一次 load 会校正 */
				}
				return null;
			}
		};

		/** 订阅某会话的设置；返回 [value, sessionKey]。 */
		function useSessionSetting(sessionId) {
			const key = sessionId === undefined || sessionId === null ? '' : String(sessionId);
			const [value, setValue] = useState(() => store.get(key));
			useEffect(() => {
				setValue(store.get(key));
				const off = store.subscribe((id, next) => {
					if (id === key) setValue(next);
				});
				store.load(key);
				return off;
			}, [key]);
			return [value, key];
		}

		const temperatureOf = (value) => (value !== null && typeof value.temperature === 'number' ? value.temperature : 1);
		const enabledOf = (value) => value !== null && value.enabled === true;

		// ── 开关：conversation.input.left ───────────────────────────────────
		function TemperatureToggle(props) {
			const { t, sessionId } = props;
			const [value, key] = useSessionSetting(sessionId);
			const enabled = enabledOf(value);
			const temperature = temperatureOf(value);
			const [busy, setBusy] = useState(false);
			const onToggle = async () => {
				if (busy || key === '') return;
				setBusy(true);
				try {
					await store.write(key, { enabled: !enabled });
				} finally {
					setBusy(false);
				}
			};
			return h(
				'button',
				{
					type: 'button',
					className: 'ti-toggle',
					'data-active': enabled ? 'true' : 'false',
					'aria-pressed': enabled ? 'true' : 'false',
					'aria-label': t('title'),
					title: t('title'),
					disabled: busy || key === '',
					onClick: onToggle
				},
				enabled ? t('on') + ' ' + temperature.toFixed(1) : t('off')
			);
		}

		// ── 滑杆：conversation.input.dock（仅开启时渲染）─────────────────────
		function TemperatureSlider(props) {
			const { t, sessionId } = props;
			const [value, key] = useSessionSetting(sessionId);
			const enabled = enabledOf(value);
			const temperature = temperatureOf(value);
			const [local, setLocal] = useState(temperature);
			const timerRef = useRef(null);
			useEffect(() => {
				if (enabled) setLocal(temperature);
			}, [enabled, temperature]);
			useEffect(
				() => () => {
					if (timerRef.current !== null) clearTimeout(timerRef.current);
				},
				[]
			);
			const onChange = (event) => {
				const next = Number(event.target.value);
				setLocal(next);
				// 拖动时先本地反馈，停手 180ms 再落盘，避免每格一次请求。
				if (timerRef.current !== null) clearTimeout(timerRef.current);
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					store.write(key, { temperature: next });
				}, 180);
			};
			if (!enabled || key === '') return null;
			return h(
				'div',
				{ className: 'ti-bar', 'data-ti-bar': 'true' },
				h('span', { className: 'ti-label' }, t('sliderLabel')),
				h('input', {
					type: 'range',
					className: 'ti-range',
					min: String(MIN),
					max: String(MAX),
					step: String(STEP),
					value: String(local),
					onChange,
					'aria-label': t('sliderLabel')
				}),
				h('span', { className: 'ti-value' }, local.toFixed(1)),
				h('span', { className: 'ti-hint' }, t('hint'))
			);
		}

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'temperature-inject: dictionaries');
			const t = ctx.locale.bind(NS);

			ctx.slots.inject('conversation.input.left', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.left',
						id: 'temperature-toggle',
						order: 2,
						locale: NS,
						inject: (sessionId) => ({ sessionId })
					},
					TemperatureToggle
				)
			);

			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: 'temperature-slider',
						order: 0,
						locale: NS,
						inject: (sessionId) => ({ sessionId })
					},
					TemperatureSlider
				)
			);

			void t;
		}

		exports.TemperatureToggle = TemperatureToggle;
		exports.TemperatureSlider = TemperatureSlider;
		exports.apply = apply;
		exports.inject = inject;
		exports.ENDPOINT = ENDPOINT;
		exports.RANGE = { min: MIN, max: MAX, step: STEP };
		exports.__store = store;
		return module.exports;
	}
});
