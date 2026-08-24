window.__ModuleLoader__.load({
	id: "dsh-plugin-model-arena",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// NOTE: no platform requires — the arena UI mounts itself into the empty
		// session (hero) view through DOM injection (the hero workspace row has no
		// list-kind slot; conversation.hero.workspace / agentPreset are single slots
		// already occupied). Model + reasoning-effort options come from the SAME
		// shared per-session directory (ctx.modelDirectories) the input box uses:
		// effort choices are the SELECTED MODEL's own reasoning metadata, never a
		// hardcoded list.
		//
		// The picker mirrors the input box ModelSelect: one trigger ("model ·
		// effort") opening a two-level menu (Model / Effort cells -> lists), with
		// a subtle open animation. A render-signature guard keeps repaint from
		// re-touching the DOM when nothing visible changed, so the injected
		// MutationObserver can never start a rebuild loop.

		// ── dictionaries ──────────────────────────────────────────────────────
		const NS = "model-arena";
		const React = require("react");
		const zh = {
			"toggle.label": "竞技场",
			"toggle.aria.on": "模型竞技场已启用，点击关闭",
			"toggle.aria.off": "启用模型竞技场",
			"toggle.title.on": "模型竞技场 · 已启用",
			"toggle.title.off": "模型竞技场 · 已关闭",
			"panel.label": "竞技场模型",
			"model.placeholder": "选择模型",
			"effort.placeholder": "推理等级",
			"effort.default": "Default",
			"effort.none": "当前模型未提供推理等级。",
			"menu.aria": "选择竞技场模型与推理等级",
			"menu.model": "模型",
			"menu.effort": "推理等级",
			"menu.empty": "没有可选的模型。",
			"menu.error": "模型目录加载失败",
			"menu.retry": "重试",
			"conflict": "与输入框已选模型相同，已清空竞技场选择",
			"block.reason": "竞技场已开启：请先选择竞技场模型（或关闭竞技场后发送）",
			"block.challenge": "流程进行中，请等待流程结束",
			"block.challenge.answer": "模型1 回答中…",
			"block.challenge.challenger": "挑战者正在质疑…",
			"block.challenge.revise": "主模型修正中…",
			"block.challenge.verdict": "挑战者正在终评…",
			"block.challenge.propose": "主模型产出方案中…",
			"block.challenge.review": "挑战者审查中…",
			"scene.label": "场景",
			"scene.business": "业务探索",
			"scene.knowledge": "知识沉淀",
			"scene.qa": "测试用例",
			"challenge.stop": "停止挑战",
			"challenge.loading": "挑战者生成中…",
			"view.arena": "竞技场",
			"arena.paneTitle": "竞技场",
			"arena.pane.empty": "发送消息后，竞技场模型将在此回复",
			"arena.sessionTitle": "竞技场",
			"arena.round.challenge": "质疑轮",
			"arena.round.final": "终评轮",
			"arena.round.review": "审查轮",
			"arena.round.default": "回合",
			"arena.question.header": "竞技场模型提问",
			"arena.question.submit": "提交回答",
			"arena.question.cancel": "跳过",
			"arena.question.placeholder": "输入回答…",
			"arena.question.approval": "竞技场模型请求权限",
			"arena.question.allow": "允许",
			"arena.question.reject": "拒绝",
			"arena.copy": "复制",
			"arena.copied": "已复制",
			"arena.ranFor": "用时 {duration}",
			"arena.ttft": "首 token {seconds}",
			"arena.tokensPerSecond": "{tps} tok/s",
			"arena.error.generic": "竞技场会话启动失败",
			"arena.error.retry": "重试",
			"settings.title": "模型竞技场",
			"settings.background.title": "允许后台推进",
			"settings.background.desc": "开启后，竞技场模式下非当前会话的对抗流程也会在后台推进（协作/对抗模型完成自动注入主模型、主模型完成自动进入下一轮）；关闭时需切回主会话才推进下一步。",
			"settings.temperature.title": "温度调节",
			"settings.temperature.desc": "开启后可为各场景的主模型与协作/对抗模型分别设置温度（0~2、最多两位小数，留空 = 使用 dsh 默认值）；关闭时全部使用 dsh 默认值。",
			"settings.temperature.main": "主模型",
			"settings.temperature.challenger": "协作/对抗模型",
			"settings.temperature.default": "dsh 默认",
			"settings.scenes": "场景",
			"settings.flow.review": "审查循环",
			"settings.flow.challenge": "挑战流程",
			"settings.scene.business.desc": "业务探索：主模型直接回答，协作/对抗模型逐条质疑，主模型修正后协作/对抗模型终评。适合需求梳理、方案探讨、影响面分析。",
			"settings.scene.knowledge.desc": "知识沉淀：主模型产出结构化方案，协作/对抗模型作为审查者给出 READY / NEEDS_REVISION 结论；不认可则主模型修正后终审，累计 3 次不认可结束。",
			"settings.scene.qa.desc": "测试用例：主模型产出测试用例，协作/对抗模型以用户视角逐条质疑，主模型修正后终评。",
			"settings.prompt.roles": "角色种子（system prompt persona 注入）",
			"settings.prompt.roleMain": "【主模型角色】",
			"settings.prompt.roleArena": "【协作/对抗模型角色】",
			"settings.prompt.rounds": "回合提示词（以 user 消息注入竞技场会话）",
			"settings.prompt.kind.challenge": "质疑轮",
			"settings.prompt.kind.review": "审查轮",
			"settings.prompt.kind.final": "终评轮",
			"settings.note": "注：注入内容不含主模型思维链；工具操作记录仅含工具名与参数摘要，不含工具结果。",
			"skill.label": "挑战者技能",
			"skill.placeholder": "选择技能…",
			"skill.browse": "浏览文件夹…",
			"skill.manual": "输入路径（文件或文件夹）",
			"skill.confirm": "确认",
			"skill.clear": "清除",
			"skill.empty": "（无）"
		};
		const en = {
			"toggle.label": "Arena",
			"toggle.aria.on": "Model arena enabled, click to disable",
			"toggle.aria.off": "Enable model arena",
			"toggle.title.on": "Model arena · on",
			"toggle.title.off": "Model arena · off",
			"panel.label": "Arena model",
			"model.placeholder": "Select model",
			"effort.placeholder": "Effort",
			"effort.default": "Default",
			"effort.none": "This model provides no reasoning effort levels.",
			"menu.aria": "Choose the arena model and reasoning effort",
			"menu.model": "Model",
			"menu.effort": "Effort",
			"menu.empty": "No selectable models.",
			"menu.error": "Failed to load the model catalog",
			"menu.retry": "Retry",
			"conflict": "Same as the model selected in the input box — arena selection cleared",
			"block.reason": "Arena is on: pick the arena model first (or turn the arena off)",
			"block.challenge": "Flow in progress — please wait for it to finish",
			"block.challenge.answer": "Model 1 is answering…",
			"block.challenge.challenger": "The challenger is questioning…",
			"block.challenge.revise": "Revising…",
			"block.challenge.verdict": "The challenger is giving the verdict…",
			"block.challenge.propose": "Drafting the proposal…",
			"block.challenge.review": "The reviewer is reviewing…",
			"scene.label": "Scenario",
			"scene.business": "Business Exploration",
			"scene.knowledge": "Knowledge base",
			"scene.qa": "Test cases",
			"challenge.stop": "Stop challenge",
			"challenge.loading": "Challenger generating…",
			"view.arena": "Arena",
			"arena.paneTitle": "Arena",
			"arena.pane.empty": "Send a message to start the arena duel",
			"arena.sessionTitle": "Arena",
			"arena.round.challenge": "Challenge round",
			"arena.round.final": "Final verdict",
			"arena.round.review": "Review round",
			"arena.round.default": "Round",
			"arena.question.header": "The arena model asks",
			"arena.question.submit": "Submit",
			"arena.question.cancel": "Skip",
			"arena.question.placeholder": "Type your answer…",
			"arena.question.approval": "The arena model requests permission",
			"arena.question.allow": "Allow",
			"arena.question.reject": "Reject",
			"arena.copy": "Copy",
			"arena.copied": "Copied",
			"arena.ranFor": "ran for {duration}",
			"arena.ttft": "first token {seconds}",
			"arena.tokensPerSecond": "{tps} tok/s",
			"arena.error.generic": "Arena session failed to start",
			"arena.error.retry": "Retry",
			"settings.title": "Model Arena",
			"settings.background.title": "Allow background advance",
			"settings.background.desc": "When on, an arena duel whose main session is not the current one still advances in the background (a finished collaborator/adversary reply is injected into the main model; a finished main turn prompts the collaborator/adversary). When off, advancing waits until you return to the main session.",
			"settings.temperature.title": "Temperature",
			"settings.temperature.desc": "When on, set the sampling temperature per scene and role (0–2, up to 2 decimal places; leave empty to use the dsh default). When off, all calls use the dsh default.",
			"settings.temperature.main": "Main model",
			"settings.temperature.challenger": "Collaborator/Adversary",
			"settings.temperature.default": "dsh default",
			"settings.scenes": "Scenes",
			"settings.flow.review": "Review loop",
			"settings.flow.challenge": "Challenge flow",
			"settings.scene.business.desc": "Business exploration: the main model answers directly, the collaborator/adversary model challenges point by point, the main model revises, then the collaborator/adversary model gives the final verdict. Good for requirement analysis, design discussion, and impact assessment.",
			"settings.scene.knowledge.desc": "Knowledge distillation: the main model produces a structured proposal, the collaborator/adversary model reviews with a READY / NEEDS_REVISION verdict; on rejection the main model revises and the collaborator/adversary model re-reviews, ending after 3 rejections.",
			"settings.scene.qa.desc": "Test cases: the main model produces test cases, the collaborator/adversary model challenges point by point from the user's perspective, the main model revises, then the final verdict.",
			"settings.prompt.roles": "Role seeds (injected via system-prompt persona)",
			"settings.prompt.roleMain": "[Main-model role]",
			"settings.prompt.roleArena": "[Collaborator/Adversary role]",
			"settings.prompt.rounds": "Round prompts (injected into the arena session as user messages)",
			"settings.prompt.kind.challenge": "Challenge round",
			"settings.prompt.kind.review": "Review round",
			"settings.prompt.kind.final": "Final-verdict round",
			"settings.note": "Note: the main model's thinking chain is never injected; the tool trail is tool name + args summary only, never tool results.",
			"skill.label": "Challenger skill",
			"skill.placeholder": "Pick a skill…",
			"skill.browse": "Browse folder…",
			"skill.manual": "Path (file or folder)",
			"skill.confirm": "OK",
			"skill.clear": "Clear",
			"skill.empty": "(none)"
		};

		// ── pure helpers (exported for the client smoke test) ─────────────────
		/**
		* Arena model options, provider-grouped, mirroring the input box seat:
		* every model of the shared directory EXCEPT the input box's current model
		* (provider+model). Each row keeps the raw model (for reasoning metadata).
		*/
		function buildModelOptions(directory, arenaModel) {
			const current = directory?.current ?? null;
			const groups = [];
			for (const group of Array.isArray(directory?.groups) ? directory.groups : []) {
				const models = [];
				for (const model of group.models) {
					if (current !== null && model.id === current.model && group.id === current.provider) continue;
					const selected = arenaModel !== null && arenaModel !== void 0 && arenaModel.provider === group.id && arenaModel.model === model.id;
					models.push({
						provider: group.id,
						model: model.id,
						name: model.name,
						...(model.description === void 0 ? {} : { description: model.description }),
						reasoning: model.reasoning,
						selected
					});
				}
				if (models.length > 0) groups.push({ id: group.id, name: group.name, models });
			}
			return groups;
		}

		/**
		* Reasoning-effort choices for ONE arena model — the model's own reasoning
		* metadata (same source the input box seat uses), never a fixed list:
		* "Default" first when the model declares no defaultEffort, then the
		* model's reasoning.efforts.
		*/
		function buildEffortChoices(reasoning, t) {
			if (reasoning === void 0 || reasoning === null) return [];
			return [
				...(reasoning.defaultEffort === void 0 ? [{ key: "provider-default", effort: void 0, label: t("effort.default") }] : []),
				...reasoning.efforts.map((effort) => ({
					key: "effort:" + effort.id,
					effort: effort.id,
					label: effort.name,
					...(effort.description === void 0 ? {} : { description: effort.description })
				}))
			];
		}

		/**
		* Validate one temperature input string for the settings page: empty
		* (dsh default), or a number in [0, 2] with at most 2 decimal places
		* (e.g. "0.15" ok, "0.155" rejected). Returns { ok: true, value } with
		* value undefined for empty input, or { ok: false } when rejected.
		*/
		function normalizeTemperatureInput(raw) {
			if (typeof raw !== "string") return { ok: false };
			if (raw === "") return { ok: true, value: void 0 };
			if (!/^\d*\.?\d{0,2}$/.test(raw)) return { ok: false };
			const num = Number(raw);
			if (!Number.isFinite(num) || num < 0 || num > 2) return { ok: false };
			return { ok: true, value: num };
		}

		/** The arena selection equals the input box's current model? */
		function conflictsWithInput(arenaModel, directory) {
			const current = directory?.current ?? null;
			return arenaModel !== null && arenaModel !== void 0 && current !== null && arenaModel.provider === current.provider && arenaModel.model === current.model;
		}

		/** Locate one model object in the directory snapshot (for effort metadata). */
		function findArenaModel(directory, arenaModel) {
			if (arenaModel === null || arenaModel === void 0) return void 0;
			for (const group of Array.isArray(directory?.groups) ? directory.groups : []) {
				if (group.id !== arenaModel.provider) continue;
				for (const model of group.models) {
					if (model.id === arenaModel.model) return model;
				}
			}
			return void 0;
		}

		/** Total model count across every provider group in the directory snapshot. */
		function totalModelsOf(directory) {
			return (Array.isArray(directory?.groups) ? directory.groups : [])
				.reduce((n, g) => n + (Array.isArray(g?.models) ? g.models.length : 0), 0);
		}

		/**
		* Auto arena model: with EXACTLY two models in the directory, the arena
		* model is DERIVED as the complement of the input box's current model —
		* the arena always duels the model the composer does NOT have, so enabling
		* the arena needs no manual pick and composer switches flip the arena
		* model to the new complement. Returns null when the directory is not in
		* the two-model shape (manual picking applies) or has no current model.
		*/
		function autoArenaModel(directory) {
			if (directory === null || directory === void 0) return null;
			const current = directory?.current ?? null;
			if (current === null || current === void 0) return null;
			let complement = null;
			let count = 0;
			for (const group of Array.isArray(directory?.groups) ? directory.groups : []) {
				for (const model of Array.isArray(group?.models) ? group.models : []) {
					count += 1;
					if (complement !== null) continue;
					if (group.id === current.provider && model.id === current.model) continue;
					complement = {
						provider: group.id,
						model: model.id,
						name: model.name,
						...(model.reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: model.reasoning.defaultEffort })
					};
				}
			}
			return count === 2 ? complement : null;
		}

		/** Plain text of a user message's content blocks. */
		function textOfContent(content) {
			return (Array.isArray(content) ? content : [])
				.filter((b) => b !== null && b !== void 0 && b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("");
		}

		/** Assistant message blocks -> simplified render rows (text / reasoning / tool / image). */
		function assistantRows(blocks) {
			const out = [];
			for (const b of Array.isArray(blocks) ? blocks : []) {
				if (b === null || b === void 0) continue;
				if (b.kind === "text" && typeof b.text === "string" && b.text.trim() !== "") {
					out.push({ kind: "assistant", text: b.text });
				} else if (b.kind === "reasoning" && typeof b.text === "string" && b.text.trim() !== "") {
					out.push({ kind: "reasoning", text: b.text });
				} else if (b.kind === "tool-call" && typeof b.name === "string") {
					out.push({ kind: "tool", name: b.name, argsRaw: b.argsRaw });
				} else if (b.kind === "image") {
					out.push({ kind: "image", attachment: b.attachment });
				}
			}
			return out;
		}

		// Non-markdown block structure of an assistant node — unchanged while
		// text tokens stream, so the md host/root can be reused across repaints.
		// A reasoning block's EMPTY->non-empty transition is a visible structure
		// change (the Think row appears), so it flips the signature too.
		const nonMdSig = (blocks) => (Array.isArray(blocks) ? blocks : [])
			.filter((b) => b !== null && b !== void 0 && b.kind !== "text")
			.map((b) => b.kind + ":" + (b.name ?? "") + ":" + (b.attachment?.attachmentId ?? "") + (b.kind === "reasoning" ? ":" + (typeof b.text === "string" && b.text.trim() !== "" ? "1" : "0") : ""))
			.join("|");

		/** Text blocks of a tool result's content. */
		// ── dsh snapshot contract (session-chat projection) ─────────────────
		// The orchestration and the arena-pane rendering are built on the session
		// chat projection shape (chat.order / chat.nodes / node.kind+anchorSeq /
		// data.content / data.blocks / running / pending). ALL reads funnel
		// through these helpers, so a dsh web upgrade that reshapes the
		// projection is fixed in exactly ONE place.
		const orderOf = (snap) => (Array.isArray(snap?.chat?.order) ? snap.chat.order : []);
		const nodesOf = (snap) => { try { return snap?.chat?.nodes; } catch { return void 0; } };
		const nodeOf = (snap, key) => { try { return nodesOf(snap)?.get?.(key); } catch { return void 0; } };
		const runningOf = (snap) => snap?.running === true;
		const pendingOf = (snap) => (Array.isArray(snap?.pending) ? snap.pending : []);
		const isUserNode = (node) => node !== null && node !== void 0 && (node.kind === "user" || node.kind === "steering");
		const isAssistantNode = (node) => node !== null && node !== void 0 && (node.kind === "assistant" || node.kind === "assistant-step");
		const isCommandNode = (node) => node !== null && node !== void 0 && node.kind === "command";
		const isTurnTailNode = (node) => node !== null && node !== void 0 && node.kind === "turn-tail";
		const isContextNode = (node) => node !== null && node !== void 0 && node.kind === "context";
		const isToolResultNode = (node) => node !== null && node !== void 0 && node.kind === "tool-result";
		const anchorSeqOf = (node) => (typeof node?.anchorSeq === "number" ? node.anchorSeq : -1);
		const contentOf = (node) => (node?.data?.content ?? node?.content);
		const blocksOf = (node) => (node?.data?.blocks ?? node?.blocks ?? []);
		const commandNameOf = (node) => (node?.data?.name ?? node?.data?.command);
		const isQuestionWait = (wait) => wait !== null && wait !== void 0 && wait.kind === "question";
		const isApprovalWait = (wait) => wait !== null && wait !== void 0 && wait.kind === "approval";
		const isWait = (wait) => isQuestionWait(wait) || isApprovalWait(wait);
		// ── challenge-mode pure helpers (exported for the client smoke test) ──
		// Scenario role table: each scene maps the main-session model (model 1)
		// to the arena model (model 2, higher-ranked challenger). The challenge
		// working language is Chinese; role names follow the user's definitions.
		const SCENES = {
			business: { main: "Technical Expert", arena: "Business Analyst", review: false },
			knowledge: { main: "Knowledge Expert", arena: "Challenger", review: true },
			qa: { main: "QA Expert", arena: "用户", review: false }
		};
		// The "knowledge" scene runs the review loop; the others keep the
		// original challenge (question -> revise -> verdict) flow.
		const isReviewScene = (challenge) => (SCENES[challenge?.scene] ?? SCENES.business).review === true;
		// {placeholder} substitution (the locale binder does not interpolate).
		const fmt = (template, vars) => typeof template === "string" ? template.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) : "";
		const looksLikeFile = (path) => typeof path === "string" && path.length > 1 && (/\.[a-z0-9]{1,8}$/i.test(path) || path.includes("/"));
		// Last path segment (file or folder name) for compact display — the
		// challenger-skill trigger shows just the basename instead of the full
		// (and ellipsized) path, which would otherwise hide the meaningful tail.
		const pathBasename = (path) => {
			if (typeof path !== "string") return "";
			const trimmed = path.replace(/[\\/]+$/, "");
			if (trimmed === "") return path;
			const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
		};
		// File references mentioned in a model reply (markdown links, inline
		// code paths, bare paths) — handed to the challenger as context so it can
		// read and review them with its workspace tools.
		const extractFileRefs = (text) => {
			const found = [];
			if (typeof text !== "string") return [];
			const push = (candidate, at) => { const cleaned = candidate.replace(/^[\"']+|[\"']+$/g, "").trim(); if (looksLikeFile(cleaned)) found.push([at, cleaned]); };
			for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) push(m[1], m.index);
			for (const m of text.matchAll(/\`([^\`]+)\`/g)) push(m[1], m.index);
			for (const m of text.matchAll(/(?:^|\s)([\w./-]+\.(?:md|ts|tsx|js|jsx|json|ya?ml|txt|py|go|rs|java|css|html?|sql|sh|toml|csv))(?=\s|$|[,.;:])/g)) push(m[1], m.index);
			found.sort((a, b) => a[0] - b[0]);
			return [...new Set(found.map(([, p]) => p))];
		};
		// Tool-call trail of one assistant turn: only the assistant node's own
		// tool-call blocks (name + raw args) — deliberately no tool-result
		// linkage. The summary prefers the human-readable `description` inside
		// argsRaw, falling back to compact JSON, truncated like the native row.
		const toolArgsSummary = (argsRaw) => {
			if (typeof argsRaw !== "string" || argsRaw === "") return "";
			try {
				const parsed = JSON.parse(argsRaw);
				if (parsed !== null && typeof parsed === "object" && typeof parsed.description === "string" && parsed.description !== "") return parsed.description;
				return JSON.stringify(parsed).replace(/\s+/g, " ").slice(0, 300);
			} catch {
				return argsRaw.replace(/\s+/g, " ").slice(0, 300);
			}
		};
		const formatToolTrail = (tools) => {
			const rows = Array.isArray(tools) ? tools.filter((x) => x !== null && x !== void 0 && typeof x.name === "string") : [];
			const lines = [];
			for (let i = 0; i < rows.length; i++) {
				const summary = toolArgsSummary(rows[i].argsRaw);
				lines.push(summary === "" ? (i + 1) + ". " + rows[i].name : (i + 1) + ". " + rows[i].name + "「" + summary + "」");
			}
			return lines.join("\n");
		};
		// Maximum number of "不认可" (NEEDS_REVISION) reviews before the loop ends.
		const MAX_REJECTS = 3;
		// A challenge phase waits on a session (main or arena) that stays idle
		// with zero progress — no running flag, no new output, no pending
		// interaction — for this long, the round can never advance (e.g. a prompt
		// that failed silently): end the challenge instead of leaving the header
		// (and composer lock) up forever. A real turn keeps the session running,
		// so sustained idle can only mean the round is stuck. (ms)
		const STALL_MS = 120000;
		// The ONLY phases that represent a genuinely in-flight challenge.
		// Everything else (idle / done / aborted) is terminal — the progress
		// strip must never render for it, so entering a session whose arena
		// round already ended never resurrects the header (or the composer
		// lock). Pure helper, exported for the client smoke test.
		const RUNNING_CHALLENGE_PHASES = new Set(["answer", "challenge", "revise", "final", "propose", "review"]);
		const shouldShowChallengeHeader = (challenge) => {
			if (challenge === null || challenge === void 0) return false;
			return challenge.active === true && RUNNING_CHALLENGE_PHASES.has(challenge.phase);
		};
		// ── challenge persistence (cross-reload / restart survival) ──────────
		// The in-memory `arenaMount.challenge` (phase/anchors/counters) dies with
		// the page; the backend sessions do NOT (a refresh only drops the client
		// subscription — a turn may still be running or already finished
		// server-side). To survive we persist a compact projection of the
		// challenge state per main session and, on restore, re-align it against
		// the LIVE snapshots: running → wait, turn completed → advance, genuinely
		// idle → main-model phase waits for a user message, challenger phase
		// re-prompts immediately. These helpers are pure and exported for tests.
		const MAIN_MODEL_PHASES = new Set(["answer", "revise", "propose"]);
		const CHALLENGER_PHASES = new Set(["challenge", "final", "review"]);
		const isMainModelPhase = (phase) => MAIN_MODEL_PHASES.has(phase);
		const isChallengerPhase = (phase) => CHALLENGER_PHASES.has(phase);
		// Persisted projection: run-time-only fields are dropped (mainWasRunning /
		// arenaWasRunning / stallSince / lastMainText / lastArenaText) and the
		// injected text is truncated — anchors/phase/counters are the durable part.
		const LAST_INJECTED_MAX = 4000;
		const toPersistedChallenge = (c) => {
			if (c === null || c === void 0) return null;
			return {
				active: c.active === true,
				phase: typeof c.phase === "string" ? c.phase : "idle",
				scene: typeof c.scene === "string" ? c.scene : "business",
				skill: typeof c.skill === "string" ? c.skill : "",
				userQuestion: typeof c.userQuestion === "string" ? c.userQuestion : "",
				mainAnchor: typeof c.mainAnchor === "string" ? c.mainAnchor : "",
				arenaAnchor: typeof c.arenaAnchor === "string" ? c.arenaAnchor : "",
				rejectCount: typeof c.rejectCount === "number" ? c.rejectCount : 0,
				verdict: typeof c.verdict === "string" ? c.verdict : "",
				round: typeof c.round === "number" ? c.round : 0,
				pendingAnchor: c.pendingAnchor === true,
				// Which challenger round prompt (challenge/final/review) was last
				// SENT to the arena session. Persisted so a reload/restore does not
				// re-inject a round prompt that is already queued server-side — the
				// duplicate-final defect (revise→final→revise→final). "" = none yet.
				lastPromptSent: typeof c.lastPromptSent === "string" ? c.lastPromptSent : "",
				lastInjectedText: typeof c.lastInjectedText === "string" ? c.lastInjectedText.slice(0, LAST_INJECTED_MAX) : "",
				lastReviewSeq: typeof c.lastReviewSeq === "number" ? c.lastReviewSeq : -1,
				proposalPath: typeof c.proposalPath === "string" ? c.proposalPath : "",
				designPath: typeof c.designPath === "string" ? c.designPath : "",
				tasksPath: typeof c.tasksPath === "string" ? c.tasksPath : "",
				reviewPath: typeof c.reviewPath === "string" ? c.reviewPath : "",
				updatedAt: Date.now()
			};
		};
		// Rebuild a challenge from the persisted projection: run-time fields reset
		// (watchdogs re-arm from scratch, reply bodies re-extracted on demand).
		// Terminal phases (done/aborted) are preserved so a concluded/rejected
		// duel never resurrects; unknown phases normalize to idle.
		const fromPersistedChallenge = (p) => {
			if (p === null || p === void 0 || typeof p !== "object") return null;
			const phase = typeof p.phase === "string" ? p.phase : "idle";
			return {
				active: p.active === true,
				phase: RUNNING_CHALLENGE_PHASES.has(phase) || isTerminalPhase(phase) ? phase : "idle",
				scene: typeof p.scene === "string" ? p.scene : "business",
				skill: typeof p.skill === "string" ? p.skill : "",
				userQuestion: typeof p.userQuestion === "string" ? p.userQuestion : "",
				mainAnchor: typeof p.mainAnchor === "string" && p.mainAnchor !== "" ? p.mainAnchor : null,
				arenaAnchor: typeof p.arenaAnchor === "string" && p.arenaAnchor !== "" ? p.arenaAnchor : null,
				rejectCount: typeof p.rejectCount === "number" ? p.rejectCount : 0,
				verdict: typeof p.verdict === "string" ? p.verdict : "",
				round: typeof p.round === "number" ? p.round : 0,
				pendingAnchor: p.pendingAnchor === true,
				lastPromptSent: typeof p.lastPromptSent === "string" ? p.lastPromptSent : "",
				lastInjectedText: typeof p.lastInjectedText === "string" ? p.lastInjectedText : "",
				lastReviewSeq: typeof p.lastReviewSeq === "number" ? p.lastReviewSeq : -1,
				proposalPath: typeof p.proposalPath === "string" ? p.proposalPath : "",
				designPath: typeof p.designPath === "string" ? p.designPath : "",
				tasksPath: typeof p.tasksPath === "string" ? p.tasksPath : "",
				reviewPath: typeof p.reviewPath === "string" ? p.reviewPath : "",
				// run-time fields reset on restore
				mainWasRunning: false,
				arenaWasRunning: false,
				stallSince: 0,
				challengerRePrompted: false,
				// run-time flags: this challenge came from persistence (restored) and
				// has not been re-aligned yet (alignDone) — alignChallengeAfterRestore
				// drives exactly one alignment pass for it.
				restored: true,
				alignDone: false
			};
		};
		// A persisted challenge is resumable when it was interrupted mid-flight
		// (active && a running phase). done/aborted/idle are terminal — a fresh
		// user message starts a new round instead (see shouldReArmChallenge).
		const isResumableChallenge = (p) => {
			if (p === null || p === void 0 || typeof p !== "object") return false;
			return p.active === true && RUNNING_CHALLENGE_PHASES.has(p.phase);
		};
		// Terminal persisted states — the Theseus bridge must NOT be re-armed and
		// the challenger must stay dormant after a reload (fixes the "aborted
		// review loop resurrects after reload" hole: abortChallenge never set
		// link.done, and a stale watch.stage="review" is not past-review).
		const isTerminalPhase = (phase) => phase === "done" || phase === "aborted";
		// Factory-level copy of the apply-internal turn check (same contract
		// reads) so the restore re-alignment helpers below stay pure/exportable.
		// A turn is complete when the session is idle and a NEW assistant node
		// landed after `sinceKey`; prompt user nodes land before the model starts
		// and must never count as a completed turn.
		const turnCompletedSince = (snap, sinceKey) => {
			if (snap === void 0 || snap === null) return false;
			if (runningOf(snap)) return false;
			const order = orderOf(snap);
			if (order.length === 0 || order[order.length - 1] === sinceKey) return false;
			for (let i = order.length - 1; i >= 0 && order[i] !== sinceKey; i--) {
				if (isAssistantNode(nodeOf(snap, order[i]))) return true;
			}
			return false;
		};
		// Re-alignment decision for the MAIN-model phases after a restore: the
		// backend session survives a refresh, so a turn may be running or already
		// finished — only a genuinely idle session (no run, no new node, no
		// pending interaction) needs the user to send a message to resume.
		const resolveMainResume = (snap, c) => {
			if (snap === void 0 || snap === null) return "waiting";
			if (runningOf(snap)) return "running";
			if (turnCompletedSince(snap, c.mainAnchor)) return "completed";
			return "waiting";
		};
		// Re-alignment decision for the CHALLENGER phases after a restore:
		// running → wait, turn completed → catch up (inject the conclusion),
		// otherwise → re-inject the round prompt so the challenger executes it.
		const resolveChallengerResume = (snap, c) => {
			if (snap === void 0 || snap === null) return "stalled";
			if (runningOf(snap)) return "running";
			if (turnCompletedSince(snap, c.arenaAnchor)) return "completed";
			return "stalled";
		};
		// Theseus workflow stages that are PAST `review`: once the workflow has
		// reached any of these, the review loop has concluded and the challenger
		// must stay dormant. `review` (and explore/propose) are still in-flight.
		const PAST_REVIEW_STAGES = new Set(["user-readiness-review", "apply", "archive", "done"]);
		const isPastReviewStage = (stage) => typeof stage === "string" && PAST_REVIEW_STAGES.has(stage);
		// Whether a fresh user message may re-arm (start) a new challenge round.
		// The review (knowledge) scene is one-shot: once the loop concludes
		// (done — READY hands off to Theseus apply/archive, or 3 rejections park
		// at propose), the challenger must stay dormant and a new message goes to
		// the main model normally. Re-arming here used to reset the phase to
		// "propose" and resurrect the header "step" even though no
		// propose.completed would ever arrive again to prompt the challenger.
		// The in-memory `phase === "done"` is lost on a page reload, so three
		// persistent signals cover the reload gap: the link's `done` flag
		// (markReviewDone), and the node half's `watch.stage` heartbeat once the
		// Theseus workflow has advanced past review.
		const shouldReArmChallenge = (challenge, link, watch) => {
			if (challenge === null || challenge === void 0) return true;
			const done = challenge.phase === "done"
				|| (link !== null && link !== void 0 && link.done === true)
				|| (watch !== null && watch !== void 0 && isPastReviewStage(watch.stage));
			return !(done && isReviewScene(challenge));
		};
		// Parse the challenger's review verdict from its `**Overall Verdict**` line.
		// Returns "READY" | "NEEDS_REVISION" | "NOT_READY" | "" (unparseable).
		const parseReviewVerdict = (text) => {
			if (typeof text !== "string") return "";
			const match = text.match(/\*\*Overall Verdict\*\*:\s*(READY|NEEDS\s*REVISION|NOT\s*READY)\b/i);
			if (!match) return "";
			const verdict = match[1].replace(/\s+/g, "_").toUpperCase();
			return verdict === "READY" || verdict === "NEEDS_REVISION" || verdict === "NOT_READY" ? verdict : "";
		};
		// Compact round label for one arena round prompt (a user node injected
		// into the arena session by the orchestrator). The prompts are authored
		// in Chinese regardless of locale, so keyword matching is stable; the
		// label itself comes from the locale binder. Empty for non-round text.
		const roundLabelOf = (text, t) => {
			if (typeof text !== "string" || text === "") return "";
			if (text.includes("逐条质疑")) return t("arena.round.challenge");
			if (text.includes("最终评审结论")) return t("arena.round.final");
			if (text.includes("逐条审查") || text.includes("Overall Verdict")) return t("arena.round.review");
			return t("arena.round.default");
		};
		// Round prompt assembly: context + a per-stage directive to the arena
		// session. "review" drives the review loop (knowledge scene);
		// "challenge" / "final" drive the original question -> revise -> verdict flow.
		const buildRoundPrompt = (kind, challenge, _t) => {
			const scene = SCENES[challenge?.scene] ?? SCENES.business;
			const mainRole = scene.main;
			const files = extractFileRefs(challenge?.lastMainText ?? "").join("\n") || "（无）";
			const trail = formatToolTrail(challenge?.lastMainTools);
			const toolsPart = trail === "" ? "" : "\n" + fmt("{mainRole} 的工具操作记录：\n{tools}", { mainRole, tools: trail });
			if (kind === "review") {
				const proposalPath = challenge?.proposalPath;
				const designPath = challenge?.designPath;
				const tasksPath = challenge?.tasksPath;
				const reviewPath = challenge?.reviewPath;
				const hasArtifacts = [proposalPath, designPath, tasksPath].some((p) => typeof p === "string" && p !== "");
				if (hasArtifacts) {
					return "请读取以下方案产物文件并审查：\n"
						+ "proposal.md: " + (typeof proposalPath === "string" && proposalPath !== "" ? proposalPath : "（无）") + "\n"
						+ "design.md: " + (typeof designPath === "string" && designPath !== "" ? designPath : "（无）") + "\n"
						+ "tasks.md: " + (typeof tasksPath === "string" && tasksPath !== "" ? tasksPath : "（无）") + "\n"
						+ "review.md 输出路径: " + (typeof reviewPath === "string" && reviewPath !== "" ? reviewPath : "（无）") + "\n"
						+ "用户问题：「" + (challenge?.userQuestion ?? "") + "」\n\n"
						+ "请按你 persona 中指定的挑战者技能审查这些文件（需求清晰度、设计合理性、风险、任务拆解、相关规格），先写出 review.md（含 Action Items）到上述输出路径，然后回复一行 **Overall Verdict**: READY（认可）或 **Overall Verdict**: NEEDS_REVISION（不认可，需修正），再附一句话说明。禁止辩论，不要自我称呼角色名。";
				}
				return fmt("用户问题：「{question}」\n{mainRole} 的结构化方案：「{mainText}」\n提到的文件：{files}", { question: challenge?.userQuestion ?? "", mainRole, mainText: challenge?.lastMainText ?? "", files }) + toolsPart
					+ "\n\n请作为审查者用中文**逐条审查**上述结构化方案：逐点核对需求清晰度、设计合理性、风险、任务拆解、相关规格，指出每处问题；只输出审查结论：先一行 **Overall Verdict**: READY（认可）或 **Overall Verdict**: NEEDS_REVISION（不认可，需修正），再列出 Action Items（需修正的具体点）。禁止辩论，不要自我称呼角色名。";
			}
			if (kind === "final") {
				return fmt("{mainRole}修正后的回答：「{mainText}」\n提到的文件：{files}", { mainRole, mainText: challenge?.lastMainText ?? "", files }) + toolsPart
					+ "\n\n修正已完成，请不再质疑，仅给出最终评审结论（认可或仍存疑）。禁止辩论，只输出你的结论，不要提出新的质疑。";
			}
			return fmt("用户问题：「{question}」\n{mainRole}的回答：「{mainText}」\n提到的文件：{files}", { question: challenge?.userQuestion ?? "", mainRole, mainText: challenge?.lastMainText ?? "", files }) + toolsPart
				+ "\n\n请用中文对上述回答**逐条质疑**：逐点审查回答中的每个观点、结论与依据，指出问题或漏洞；禁止辩论，只输出你的质疑（直接以质疑者口吻表达，不要自我称呼角色名）。";
		};
		// Markdown stripped to plain text for user-message injection: the native
		// user bubble is plain text (projectUserText, no markdown).
		const stripMarkdown = (text) => {
			if (typeof text !== "string") return "";
			return text
				.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").replace(/^[a-zA-Z]+\n/, ""))
				.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/\`([^\`]*)\`/g, "$1")
				.replace(/^#{1,6}\s+/gm, "")
				.replace(/^\s*>\s?/gm, "")
				.replace(/^\s*[-*+]\s+/gm, "")
				.replace(/^\s*\d+\.\s+/gm, "")
				.replace(/\*\*([^*]+)\*\*/g, "$1")
				.replace(/\*([^*]+)\*/g, "$1")
				.replace(/__([^_]+)__/g, "$1")
				.replace(/~~([^~]+)~~/g, "$1")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
		};
		// The challenger's feedback injected into the MAIN conversation as a plain
		// user message. Review mode: the main model revises per the action items;
		// challenge mode: the raw objection (the revise rule lives in the system prompt).
		const buildReviseMessage = (arenaText, challenge, _t) => {
			if (isReviewScene(challenge)) {
				const reviewPath = typeof challenge?.reviewPath === "string" && challenge.reviewPath !== "" ? challenge.reviewPath : "（未提供）";
				return "挑战者审查结论：不认可，需修正。请先 record review.completed NEEDS_REVISION（回到 propose），再读 review.md（" + reviewPath + "）的 Action Items 修改方案文件，最后 record propose.completed 重新送审。";
			}
			return stripMarkdown(arenaText ?? "");
		};
		// Challenger role seed: injected into the arena session's system prompt
		// via the persona map (syncPersona → settings → system-prompt waterfall),
		// not as a chat message — the arena chat stays empty until the first
		// round prompt.
		const buildRoleSeed = (challenge, _t) => {
			const scene = SCENES[challenge?.scene] ?? SCENES.business;
			const mainRole = scene.main;
			const arenaRole = scene.arena;
			const base = scene.review === true
				? fmt("你是{arenaRole}，身份高于{mainRole}。在审查流程中，你作为审查者负责审查{mainRole}产出的结构化方案，并给出 **Overall Verdict**: READY（认可）或 NEEDS_REVISION（不认可）的结论。禁止辩论，只按指示输出。", { arenaRole, mainRole })
				: fmt("你是{arenaRole}，身份高于{mainRole}。接下来的挑战流程中，你将负责用中文质疑并给出终评。禁止辩论，只按指示输出。", { arenaRole, mainRole });
			// Optional challenger skill (workspace-persisted, user-picked file or
			// folder): the challenger reads the skill (SKILL.md for a folder) before
			// every review/challenge round and follows it.
			if (typeof challenge?.skill === "string" && challenge.skill !== "") {
				return base + "\n\n挑战者技能：" + challenge.skill + "。审查/质疑前先读取该技能（目录读取其中的 SKILL.md，文件直接读取），并严格遵循技能要求执行。";
			}
			return base;
		};
		// Main-session role seed: same persona channel, active from the first
		// turn so model 1 carries its identity while producing the proposal.
		const buildMainRoleSeed = (challenge, _t) => {
			const scene = SCENES[challenge?.scene] ?? SCENES.business;
			const mainRole = scene.main;
			if (scene.review === true) {
				return fmt("【最高优先级强制约束】你是{mainRole}。在 Theseus workflow 中，你只负责 explore 和 propose 两个阶段。propose 阶段完成（record propose.completed）后本轮必须立即结束：绝对禁止 auto-advance 到 review、绝对禁止执行 theseus-review-spec、绝对禁止自己写 review.md / 给出 Overall Verdict / 自我审查或修正，也不要主动向用户询问是否继续。方案的 review 由模型竞技场的挑战者会话独立执行，你只能被动等待审查结论；收到结论后按注入指令继续（NEEDS_REVISION → 回 propose 修正重新送审；READY → record review.completed 并按 Theseus 继续后续阶段）。禁止辩论，请用中文回答。", { mainRole });
			}
			return fmt("你是{mainRole}。接下来你将作为{mainRole}参与竞技场挑战：先回答用户问题，再针对挑战者的质疑进行修正。请用中文回答。禁止辩论。", { mainRole });
		};

		function toolResultText(content) {
			return (Array.isArray(content) ? content : [])
				.filter((b) => b !== null && b !== void 0 && b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.slice(0, 400);
		}

		// ── dsh bundle anchors ───────────────────────────────────────────────
		// Native DOM selectors / class names the plugin depends on (hero row,
		// sidebar rows, session-header layout, disclosure separators). CSS
		// Modules re-hashes these on ANY dsh web style change — after an
		// upgrade, grep for "ANCHORS" and update the values in exactly ONE place.
		const ANCHORS = {
			heroRow: '[data-phase="hero"] .wSkVaW_heroWorkspaceRow',
			heroChip: '[data-phase="hero"] button[aria-label*="工作区"], [data-phase="hero"] button[aria-label*="workspace"]',
			sidebarRow: ".YDXeBa_sessionRow",
			sidebarTitle: ".YDXeBa_title",
			// The currently-selected session row (the workspace browser marks the
			// current session with this class). The arena MAIN session is always the
			// current session while the runtime is mounted (the selection guard
			// bounces any switch into the competitor session back), so the selected
			// row is where the challenger loading indicator is injected.
			sidebarSelected: "YDXeBa_selected",
			// Status slot inside a session row (StateDot seat, before the title).
			sidebarSlot: ".YDXeBa_slot",
			headerCluster: ".wSkVaW_titleCluster",
			headerActions: ".wSkVaW_headerActions",
			disclosureSeparator: "QWLzlG_separator"
		};
		// ── styles (injected once, tagged like the built bundles) ──────────────
		const css = [
			// toggle pill in the hero workspace row (mirrors the workspace chip)
			".ma-toggle{flex:none;min-height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 10px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}",
			".ma-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".ma-toggle[aria-pressed=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}",
			".ma-toggle[aria-pressed=true]:hover{color:var(--dsw-alias-state-business-primary)}",
			// arena panel row between the hero workspace row and the composer
			".ma-panel{align-items:center;gap:10px;min-width:0;padding-left:20px;display:flex}",
			".ma-panelLabel{flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".ma-selector{min-width:0;position:relative}",
			// trigger, mirroring the composer model seat
			".ma-trigger{max-width:240px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}",
			".ma-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".ma-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
			".ma-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".ma-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			".ma-triggerEffort{color:var(--dsw-alias-label-caption);flex:none}",
			".ma-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}",
			".ma-chevronOpen{transform:rotate(180deg)}",
			// the two-level menu (ModelSelect visual language) with a soft open
			".ma-menu{z-index:30;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(240px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;top:calc(100% + 6px);left:0;overflow:hidden;animation:ma-menu-in .14s var(--ds-ease-in-out)}",
			"@keyframes ma-menu-in{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}",
			"@media (prefers-reduced-motion:reduce){.ma-menu{animation:none}}",
			".ma-menuStatus,.ma-menuEmpty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}",
			".ma-menuError{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}",
			".ma-menuRetry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}",
			// root pane cells
			".ma-cell{width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}",
			".ma-cell:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".ma-cell:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".ma-cellLabel{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}",
			".ma-cellValue{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:0 auto;overflow:hidden}",
			".ma-cellChevron{color:var(--dsw-alias-label-tertiary);flex:none}",
			// list panes
			".ma-groups{min-height:0;overflow-y:auto}",
			".ma-group+.ma-group{margin-top:4px}",
			".ma-groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}",
			".ma-option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}",
			".ma-option:hover:not(:disabled),.ma-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}",
			".ma-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".ma-optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}",
			".ma-optionName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}",
			".ma-optionDesc{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}",
			".ma-check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}",
			".ma-hint{flex:none;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}",
			".ma-sceneRow{flex:none;align-items:center;gap:8px;min-width:0;display:flex}",
			".ma-sceneSeg{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex:none;padding:2px;display:flex;gap:2px}",
			".ma-sceneBtn{min-height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;padding:0 10px;font-size:12px;line-height:18px}",
			".ma-sceneBtn:hover{color:var(--dsw-alias-label-primary)}",
			".ma-sceneBtn[aria-pressed=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:500}",
			// main-session header progress strip
			".ma-challengeHeader{flex:none;align-items:center;gap:6px;row-gap:2px;min-width:0;max-width:100%;flex-wrap:wrap;display:flex}",
			// Make the header longer while a challenge is running: the challenge
			// stepper lives in the native header-actions area (inside the title
			// cluster, next to the breadcrumbs). Let that area grow to fill the
			// rest of the title row, so every step stays visible on one line
			// (crumbs keep their natural width and only shrink when space is
			// tight; the stepper wraps as a last resort instead of being clipped).
			"." + ANCHORS.headerCluster + ":has(.ma-challengeHeader) ." + ANCHORS.headerActions + "{flex:1 1 auto;min-width:0;justify-content:flex-end}",
			".ma-challengeStage{flex:none;color:var(--dsw-alias-label-caption);white-space:nowrap;font-size:12px;line-height:18px;transition:color .25s var(--ds-ease-in-out),opacity .25s var(--ds-ease-in-out);opacity:.55}",
			".ma-challengeStage.active{color:var(--dsw-alias-state-business-primary);font-weight:600;opacity:1;animation:ma-stage-pulse 1.6s ease-in-out infinite}",
			".ma-challengeStage.done{color:var(--dsw-alias-label-tertiary);opacity:.85}",
			".ma-challengeSep{flex:none;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;opacity:.6}",
			"@keyframes ma-stage-pulse{0%,100%{opacity:1}50%{opacity:.55}}",
			"@media (prefers-reduced-motion:reduce){.ma-challengeStage.active{animation:none}}",
			".ma-challengeStop{flex:none;width:18px;height:18px;color:var(--dsw-alias-state-error-primary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-state-error-primary);border-radius:4px;place-items:center;display:grid;padding:0;font-size:10px;line-height:1;transition:background .18s var(--ds-ease-in-out)}",
			".ma-challengeStop:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}",
			// shared rotation keyframes for the sidebar challenger loading dot
			// (the header spinner was removed per user feedback — the sidebar row
			// dot is the only challenger loading indicator now). The ring centers
			// itself with translate(-50%,-50%), so the rotation keyframes carry the
			// SAME translate to keep it centered while spinning.
			"@keyframes ma-spin{from{transform:translate(-50%,-50%) rotate(0deg)}to{transform:translate(-50%,-50%) rotate(360deg)}}",
			// Challenger loading indicator inside the SIDEBAR session row: a thin
			// spinning ring that wraps AROUND the native StateDot (10px). When the
			// main model is idle the ring shows alone (clear "challenger working");
			// when the main model is ALSO running (green/ongoing dot) the ring
			// encircles that dot instead of being hidden under it. The slot is made
			// the positioning context via an INLINE style at inject time (not a CSS
			// rule on the hashed .YDXeBa_* class, which is fragile across dsh web
			// upgrades), and the ring centers with translate so its containing block
			// is always the slot — never a larger ancestor (that was the "ring spins
			// in the middle of the title" bug).
			".ma-sidebarLoading{box-sizing:border-box;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:ma-spin .8s linear infinite}",
			"@media (prefers-reduced-motion:reduce){.ma-sidebarLoading{animation:none}}",
			".ma-conflict{flex:none;color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}",
			".ma-error{flex:none;color:var(--dsw-alias-state-error-primary);align-items:center;gap:6px;font-size:12px;line-height:18px;display:inline-flex}",
			".ma-errorRetry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;padding:0;font-weight:600}",
			// ── arena view tab (native view-ring seat) ───────────────────────
			".ma-arenaView{flex-direction:column;flex:1;min-height:0;background:var(--dsw-alias-bg-base);display:flex}",
			".ma-arenaViewHead{flex:none;min-height:36px;align-items:center;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);padding:0 28px 0 20px;font-size:13px;font-weight:500;line-height:20px;display:flex}",
			".ma-arenaNode{flex-direction:column;gap:16px;min-width:0;display:flex}",
			// round divider (质疑轮 / 终评轮 / 审查轮): a prominent horizontal
			// rule + centered label so the challenger's rounds read as separate
			// turns instead of one continuous block.
			".ma-arenaRound{flex:none;align-items:center;gap:10px;color:var(--dsw-alias-label-caption);font-size:12px;font-weight:500;line-height:18px;display:flex}",
			".ma-arenaRound:before,.ma-arenaRound:after{content:\"\";flex:1;height:1px;background:var(--dsw-alias-border-l2)}",
			".ma-arenaRoundLabel{flex:none;white-space:nowrap}",
			".ma-arenaInteractions{flex-direction:column;gap:16px;min-width:0;display:flex}",
			".ma-arenaFlow{flex-direction:column;gap:16px;min-width:0;display:flex}",
			".ma-paneBody{flex:1;min-height:0;width:100%;max-width:var(--dsh-chat-content-width);margin:0 auto;flex-direction:column;gap:16px;padding:16px;overflow-y:auto;display:flex}",
			".ma-copyWrap{display:inline-flex;flex:none}",
			".ma-asstBlock{flex-direction:column;gap:16px;min-width:0;display:flex}",
			".ma-assistantMd{color:var(--dsw-alias-label-primary);min-width:0;font-size:16px;line-height:24px}",
			".ma-bubble{min-width:0;max-width:100%;font-size:16px;line-height:24px;white-space:pre-wrap;overflow-wrap:break-word}",
			".ma-bubble.user{align-self:flex-end;max-width:min(525px,82%);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px}",
			".ma-bubble.assistant{align-self:stretch;color:var(--dsw-alias-label-primary)}",
			".ma-bubble.reasoning{align-self:stretch;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;padding:4px 0 4px 22px}",
			".ma-bubble.tool{align-self:stretch;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;flex-direction:column;gap:2px;display:flex}",
			".ma-paneStatus{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;padding:8px 0}",
			// arena question/approval cards
			".ma-question{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);border-radius:12px;flex-direction:column;gap:10px;padding:12px;display:flex}",
			".ma-questionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px}",
			".ma-questionText{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;white-space:pre-wrap}",
			".ma-questionDetail{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".ma-questionBlock{flex-direction:column;gap:6px;display:flex}",
			".ma-questionOpt{width:100%;min-height:34px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:13px;line-height:20px}",
			".ma-questionOpt:hover,.ma-questionOpt.selected{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}",
			".ma-questionInput{width:100%;min-height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;padding:6px 10px;font-size:13px;line-height:20px}",
			".ma-questionInput:focus{border-color:var(--dsw-alias-state-business-primary)}",
			".ma-questionActions{align-items:center;gap:8px;display:flex}",
			".ma-questionBtn{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;font-size:12px;line-height:18px}",
			".ma-questionBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".ma-questionBtn.primary{background:var(--dsw-alias-button-info-fill);border-color:transparent;color:#fff}",
			".ma-paneError{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;white-space:pre-wrap}",
			// tool + image rows (left-chat visual language)
			".ma-toolTitle{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}",
			".ma-toolArgs{margin:0;color:var(--dsw-alias-label-tertiary);font:12px/18px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all}",
			".ma-thinkBody{color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 0 4px 22px;font-size:14px;line-height:24px}",
			".ma-bubble.context,.ma-bubble.turnTail{align-self:stretch;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:nowrap}",
						
			".ma-contextBody{margin:0;color:var(--dsw-alias-label-tertiary);font:400 12px/18px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-word;max-height:141px;overflow:auto;background:var(--dsw-alias-markdown-code-block);border-radius:8px;margin:4px 0 0 22px;padding:10px 16px 12px 12px}",
			".ma-contextSource{color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px}",
			".ma-contextSep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}",
			".ma-contextSummary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}",
			".ma-disclosureSummary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}",
			".ma-copyBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".ma-actRow{align-items:center;gap:10px;margin-left:-6px;display:flex}",
			".ma-actRow .p-xYUq_timeEnd{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-left:12px;font-size:14px;line-height:24px}",
			".ma-actRow .p-xYUq_runTimeDot{color:var(--dsw-alias-label-tertiary);margin:0 10px}",
			".ma-userStack .ma-copyBtn{align-self:flex-end}",
			".ma-bubble.toolresult{align-self:stretch;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:pre-wrap}",
			".ma-bubble.toolresult.error{color:var(--dsw-alias-state-error-primary)}",
			".ma-bubble.image{align-self:flex-start;padding:0;background:0 0;border:none;font-size:14px;line-height:24px}",
			".ma-image{max-width:100%;max-height:320px;border-radius:10px;object-fit:contain}",
			// settings page: arena card (scene docs + injected prompts)
			".ma-settingsCard{flex-direction:column;gap:14px;max-width:760px;display:flex}",
			".ma-settingsHead{margin:0;font-size:18px;font-weight:600;line-height:26px}",
			".ma-settingsSection{flex-direction:column;gap:8px;display:flex}",
			".ma-settingsSectionTitle{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".ma-settingsScene{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:6px;padding:12px 14px;display:flex}",
			".ma-settingsSceneTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
			".ma-settingsSceneMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".ma-settingsSceneDesc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".ma-settingsPromptLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px;margin-top:4px}",
			".ma-settingsPrompt{margin:0;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-markdown-code-block);border-radius:8px;padding:8px 10px;font:400 12px/18px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-word}",
			".ma-settingsNote{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}",
			".ma-settingsTempScene{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding-top:8px;display:flex}",
			".ma-settingsTempRow{align-items:center;gap:10px;display:flex}",
			".ma-settingsTempLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;min-width:130px}",
			".ma-settingsTempInput{width:96px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 8px;font-size:13px;line-height:20px}",
			// hero panel: challenger skill picker (workspace-persisted)
			".ma-skillRow{align-items:center;gap:10px;min-width:0;padding-left:20px;display:flex}",
			".ma-skillValue{max-width:280px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".ma-skillPopover{z-index:30;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(320px,calc(100vw - 32px));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);border-radius:12px;flex-direction:column;gap:8px;padding:10px;display:flex;position:absolute;top:calc(100% + 6px);left:0;animation:ma-menu-in .14s var(--ds-ease-in-out)}",
			".ma-skillPath{color:var(--dsw-alias-label-tertiary);font:400 12px/18px var(--ds-font-family-code);word-break:break-all;margin:0}"
		].join("\n");
		const tagId = "dsh-plugin-model-arena/arena.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		// The model directory service is a separately mounted service; the whole
		// arena UI mounts inside its late-binding inject callback.
		const inject = ["locale", "sessions", "modelDirectories", "remote", "slots"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "model-arena: dictionaries");
			const t = ctx.locale.bind(NS);

			ctx.inject(["modelDirectories"], (scope) => {
				const models = scope.modelDirectories;

				// Per-session UI state (in-memory only; the feature is not
				// implemented, nothing persists and nothing drives behavior).
				const stateBySession = new Map();
				const stateFor = (sessionId) => {
					let state = stateBySession.get(sessionId);
					if (state === void 0) {
						// skill starts undefined = "not seeded from the workspace yet";
						// it becomes "" (explicitly none) or a path once resolved.
						state = { enabled: false, model: null, scene: "business", skill: void 0, challenge: null };
						stateBySession.set(sessionId, state);
					}
					return state;
				};

				// One live mount: the hero workspace row, the current session, the
				// injected toggle/panel, the session's directory, and the open menu
				// pane (null | "root" | "model" | "effort").
				let mounted = null;

				const currentSessionId = () => {
					try {
						return ctx.sessions.list.getSnapshot()?.current;
					} catch (_sessionReadFailure) {
						return void 0;
					}
				};

				const findHeroRow = () => {
					try {
						const row = document.querySelector(ANCHORS.heroRow);
						if (row instanceof HTMLElement) return row;
						const chip = document.querySelector(ANCHORS.heroChip);
						if (chip instanceof HTMLElement && chip.parentElement instanceof HTMLElement) return chip.parentElement;
						return null;
					} catch (_heroLookupFailure) {
						return null;
					}
				};

				// ── arena runtime (per current session) ───────────────────────
				// Mirrors every user message of the arena-enabled session into a
				// second session running the arena model, and hosts the arena
				// session's chat in the native view-ring "竞技场" tab (one shared
				// composer; mirroring stays session-driven).
				let arenaMount = null;

				// Lightweight subscription tick: bumps whenever the arena runtime
				// state changes shape (creation success, failure, teardown), so the
				// React view tab re-mounts its renderer.
				const arenaTick = (() => {
					const listeners = new Set();
					let version = 0;
					return {
						subscribe(fn) {
							listeners.add(fn);
							return () => {
								listeners.delete(fn);
							};
						},
						getSnapshot() {
							return version;
						},
						bump() {
							version += 1;
							for (const fn of [...listeners]) {
								try {
									fn();
								} catch (_tickFailure) {
									// a listener crash must never break the arena lifecycle
								}
							}
						}
					};
				})();

				const bubble = (kind, text) => {
					const el = document.createElement("div");
					el.className = "ma-bubble " + kind;
					el.textContent = text;
					return el;
				};

				const toolRow = (name, argsRaw) => {
					const el = document.createElement("div");
					el.className = "ma-bubble tool";
					const title = document.createElement("span");
					title.className = "ma-toolTitle";
					title.textContent = "🛠 " + (name ?? "tool");
					el.appendChild(title);
					if (typeof argsRaw === "string" && argsRaw !== "") {
						const args = document.createElement("pre");
						args.className = "ma-toolArgs";
						args.textContent = argsRaw.length > 300 ? argsRaw.slice(0, 300) + "…" : argsRaw;
						el.appendChild(args);
					}
					return el;
				};

				const toolResultRow = (name, text, isError) => {
					const el = document.createElement("div");
					el.className = "ma-bubble toolresult" + (isError ? " error" : "");
					el.textContent = (name !== "" ? name + " → " : "") + (text || "");
					return el;
				};

				// ── native-aligned node rows (context / turn-tail) ──
				// Replicates the left chat's rendering for context injections
				// (DisclosureRow with the same "上下文注入" chrome) and the turn-tail
				// stats line, straight from the snapshot node (context:
				// data.content/provenance; turn-tail: data.time/ttftMs/
				// tokensPerSecond/turn).
				const contextRow = (node) => {
					const el = document.createElement("div");
					el.className = "ma-bubble context";
					const data = node?.data ?? {};
					const content = Array.isArray(data.content) ? data.content : [];
					const text = content.filter((b) => b !== null && b !== void 0 && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
						|| (typeof data.content === "object" && data.content !== null && typeof data.content.text === "string" ? data.content.text : "")
						|| (typeof data.content === "string" ? data.content : "");
					if (mdApi === null) {
						el.textContent = text || "";
						return el;
					}
					const key = "ctx:" + (data.seq ?? "") + ":" + (node?.provenance?.label ?? data.source ?? text.slice(0, 40));
					const { DisclosureRow, React } = mdApi;
					const root = mdApi.createRoot(el);
					mdRoots.set(root, { root, host: el });
					const provenance = node?.provenance ?? {};
					const sourceLabel = typeof provenance.label === "string" ? provenance.label
						: (typeof provenance.source === "string" ? provenance.source
						: contextSourceLabel(data.source));
					const title = provenance.role === "recall" ? "召回上下文" : "上下文注入";
					const summary = typeof provenance.summary === "string" ? provenance.summary : "";
					const collapsed = React.createElement(React.Fragment, null,
						sourceLabel !== "" ? React.createElement("span", { className: "ma-contextSep", "aria-hidden": true }) : null,
						sourceLabel !== "" ? React.createElement("span", { className: "ma-contextSource", "data-context-source": true }, sourceLabel) : null,
						summary !== "" ? React.createElement("span", { className: "ma-contextSep", "aria-hidden": true }) : null,
						summary !== "" ? React.createElement("span", { className: "ma-contextSummary", "data-context-summary": true }, summary) : null
					);
					const body = React.createElement("div", { className: "ma-contextBody", "data-context-body": true }, text);
					const renderCtx = (open) => {
						disclosureOpen.set(key, open);
						root.render(React.createElement(DisclosureRow, {
							className: "ma-contextRoot",
							icon: React.createElement(mdApi.IconBrowseOutline16, { size: 14 }),
							title,
							open,
							expandable: text !== "",
							expandOnRowClick: text !== "",
							onToggle: () => renderCtx(!open),
							keepContentWhenOpen: true,
							collapsedContent: collapsed,
							children: body
						}));
					};
					renderCtx(disclosureOpen.get(key) === true);
					return el;
				};

				// Native tool display: run_code renders as "Code" (TOOL_VARIANTS +
				// title-case), matching the platform tool-call row.
				const TOOL_VARIANTS = {
					bash: "bash", pwsh: "bash", read: "read", web_fetch: "read",
					web_search: "search", grep: "search", glob: "search", write: "write",
					edit: "edit", run_code: "code", cordis_package_inspect: "read",
					cordis_runtime_inspect: "read", cordis_run: "others",
					cordis_stop: "others", cordis_undefine: "others"
				};
				const TOOL_TITLES = {
					cordis_package_inspect: "Inspect", cordis_runtime_inspect: "Inspect",
					cordis_run: "Run Cordis Plugin", cordis_stop: "Stop Cordis Plugin",
					cordis_undefine: "Remove Cordis Plugin", pwsh: "Pwsh"
				};
				const toolDisplayName = (name) => {
					if (typeof name !== "string" || name === "") return "tool";
					if (TOOL_TITLES[name] !== void 0) return TOOL_TITLES[name];
					const variant = TOOL_VARIANTS[name] ?? "others";
					return variant.charAt(0).toUpperCase() + variant.slice(1);
				};
				// Native context provenance: project the opaque source to {role,label}
				// (plugin id / skill name / instruction path), like contextProvenance().
				const contextSourceLabel = (source) => {
					if (source === null || source === void 0) return "";
					if (typeof source === "string") return source;
					const rec = typeof source === "object" ? source : {};
					const kind = typeof rec.kind === "string" ? rec.kind : "";
					if (kind === "plugin") return typeof rec.plugin === "string" ? rec.plugin : kind;
					if (kind === "skill-invocation") return typeof rec.name === "string" ? rec.name : kind;
					if (kind === "agent-instructions") {
						const changes = Array.isArray(rec.changes) ? rec.changes : [];
						const paths = changes.map((c) => c && typeof c.path === "string" ? c.path : null).filter(Boolean);
						return paths.length > 0 ? paths.join(", ") : kind;
					}
					if (kind === "session-reference") {
						const refs = Array.isArray(rec.references) ? rec.references : [];
						const labels = refs.map((r) => r && typeof r.label === "string" ? r.label : null).filter(Boolean);
						return labels.length > 0 ? labels.join(", ") : kind;
					}
					return kind || "";
				};

								const pad2 = (n) => String(n).padStart(2, "0");
				const timeOf = (ms) => {
					if (typeof ms !== "number" || !isFinite(ms)) return "";
					const d = new Date(ms);
					return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
				};
				const fmtDuration = (ms) => {
					if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
					const total = Math.max(0, Math.floor(ms / 1000));
					const minutes = Math.floor(total / 60);
					const seconds = total % 60;
					return minutes > 0 ? minutes + "分" + pad2(seconds) + "秒" : seconds + "秒";
				};
				const fmtSeconds = (ms) => {
					if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
					const s = ms / 1000;
					return s >= 10 ? Math.round(s) + "秒" : (Math.round(s * 10) / 10) + "秒";
				};
				// Copy button: mirrors the native MessageIconActions (writeClipboard +
				// IconCopyOutline16 -> IconCheckOutline16 swap, hover label via Tooltip).
				const copyButton = (text) => {
					const wrap = document.createElement("span");
					wrap.className = "ma-copyWrap";
					if (mdApi !== null && mdApi.IconCopyOutline16 !== void 0 && mdApi.IconCheckOutline16 !== void 0 && mdApi.writeClipboard !== void 0 && mdApi.Tooltip !== void 0) {
						const { React, IconCopyOutline16, IconCheckOutline16, writeClipboard, Tooltip } = mdApi;
						const root = mdApi.createRoot(wrap);
						mdRoots.set(root, { root, host: wrap });
						let pending = false;
						let timer = null;
						let copied = false;
						const paint = () => {
							root.render(React.createElement(Tooltip, {
								label: copied ? t("arena.copied") : t("arena.copy"),
								side: "bottom",
								children: React.createElement("button", {
									type: "button",
									className: "p-xYUq_action ma-copyBtn",
									"aria-label": copied ? t("arena.copied") : t("arena.copy"),
									onClick: () => {
										if (pending) return;
										pending = true;
										writeClipboard(text).then((ok) => {
											pending = false;
											if (!ok) return;
											copied = true;
											paint();
											if (timer !== null) clearTimeout(timer);
											timer = setTimeout(() => { timer = null; copied = false; paint(); }, 1000);
										});
									}
								}, React.createElement(copied ? IconCheckOutline16 : IconCopyOutline16, { size: 16 }))
							}));
						};
						paint();
					} else {
						const btn = document.createElement("button");
						btn.type = "button";
						btn.className = "p-xYUq_action ma-copyBtn";
						btn.setAttribute("aria-label", t("arena.copy"));
						btn.textContent = "⧉";
						btn.addEventListener("click", () => {
							const ta = document.createElement("textarea");
							ta.value = text;
							ta.style.position = "fixed";
							ta.style.opacity = "0";
							document.body.appendChild(ta);
							ta.select();
							document.execCommand("copy");
							ta.remove();
						});
						wrap.appendChild(btn);
					}
					return wrap;
				};

								const runTimeDot = () => {
					const dot = document.createElement("span");
					dot.className = "p-xYUq_runTimeDot";
					dot.setAttribute("aria-hidden", "true");
					dot.textContent = "·";
					return dot;
				};
				const turnTailRow = (node) => {
					const el = document.createElement("span");
					el.className = "p-xYUq_timeEnd";
					const data = node?.data ?? {};
					const time = timeOf(data.time);
					if (time !== "") el.append(time);
					const durationMs = typeof data.durationMs === "number" ? data.durationMs
						: (data.turn?.end?.time - data.turn?.start?.time);
					const dur = fmtDuration(durationMs);
					if (dur !== "") { el.append(" ", runTimeDot(), " ", t("arena.ranFor", { duration: dur })); }
					const ttft = fmtSeconds(data.ttftMs);
					if (ttft !== "") { el.append(" ", runTimeDot(), " ", t("arena.ttft", { seconds: ttft })); }
					if (typeof data.tokensPerSecond === "number" && isFinite(data.tokensPerSecond)) {
						el.append(" ", runTimeDot(), " ", t("arena.tokensPerSecond", { tps: String(Math.round(data.tokensPerSecond)) }));
					}
					if (el.textContent === "") el.style.display = "none";
					return el;
				};

				// Round divider: a labeled horizontal rule rendered for each round
				// prompt (user node) the orchestrator injects into the arena session.
				// Makes the challenger's rounds (质疑 / 终评 / 审查) read as clearly
				// separate turns instead of one continuous reply.
				const roundDivider = (node) => {
					const el = document.createElement("div");
					el.className = "ma-arenaRound";
					el.dataset.arenaRound = "";
					const label = roundLabelOf(textOfContent(contentOf(node)), t);
					if (label !== "") {
						const span = document.createElement("span");
						span.className = "ma-arenaRoundLabel";
						span.textContent = label;
						el.appendChild(span);
					}
					return el;
				};

				// React-rendered disclosure rows (think / tool-call), matching the
				// native left chat exactly: DisclosureRow = icon + title + summary,
				// click to expand. Used only when the native components are loaded;
				// the plain-text toolRow above remains the pre-load fallback.
				// Disclosure open-state survives repaints: the pane rebuilds on every
				// stream tick, so a toggle must persist across rebuilds (keyed by
				// the row's text content, which is stable for a given block).
				const disclosureOpen = new Map();
				const thinkRow = (text) => {
					const el = document.createElement("div");
					el.className = "ma-bubble think";
					if (mdApi === null) {
						el.textContent = text;
						return el;
					}
					const key = "think:" + text;
					const { DisclosureRow, React } = mdApi;
					const root = mdApi.createRoot(el);
					mdRoots.set(root, { root, host: el });
					const body = React.createElement("div", { className: "ma-thinkBody" }, text);
					// Collapsed row exposes a summary (native QWLzlG_summary behavior).
					const summary = text.trim().split(/\s+/).slice(0, 24).join(" ");
					const renderThink = (open) => {
						disclosureOpen.set(key, open);
						root.render(React.createElement(DisclosureRow, {
							icon: React.createElement(mdApi.IconThinkOutline14, { size: 14 }),
							title: "Think",
							open,
							expandable: true,
							expandOnRowClick: true,
							onToggle: () => renderThink(!open),
							keepContentWhenOpen: false,
							collapsedContent: React.createElement(React.Fragment, null,
								React.createElement("span", { className: ANCHORS.disclosureSeparator, "aria-hidden": true }),
								React.createElement("span", { className: "ma-disclosureSummary" }, summary)),
							children: body
						}));
					};
					renderThink(disclosureOpen.get(key) === true);
					return el;
				};

				const toolCallRow = (name, argsRaw) => {
					const el = document.createElement("div");
					el.className = "ma-bubble tool";
					if (mdApi === null) return toolRow(name, argsRaw);
					const key = "tool:" + (name ?? "") + ":" + (typeof argsRaw === "string" ? argsRaw.slice(0, 80) : "");
					const { DisclosureRow, React } = mdApi;
					const root = mdApi.createRoot(el);
					mdRoots.set(root, { root, host: el });
					// Expanded body mirrors the native deriveBody: the code variant shows
					// argsRaw.code (the actual code), every other variant shows formatted JSON.
					let argsText = "";
					try {
						const parsed = JSON.parse(argsRaw ?? "");
						if (typeof parsed === "object" && parsed !== null && typeof parsed.code === "string" && parsed.code !== "") {
							argsText = parsed.code;
						} else {
							argsText = JSON.stringify(parsed, null, 2);
						}
					} catch {
						argsText = typeof argsRaw === "string" ? argsRaw : "";
					}
					const bt = String.fromCharCode(96);
					const body = React.createElement(mdApi.MarkdownText, { text: bt + bt + bt + "js\n" + argsText + "\n" + bt + bt + bt });
					// Collapsed summary mirrors the native tool row: name + sep + summary
					// (the native tool-call disclosure shows a short human summary).
					let toolSummary = "";
					try {
						if (typeof argsRaw === "string" && argsRaw !== "") {
							const parsed = JSON.parse(argsRaw);
							if (parsed && typeof parsed.description === "string") toolSummary = parsed.description;
							else toolSummary = argsRaw.replace(/\s+/g, " ").slice(0, 60);
						}
					} catch {
						if (typeof argsRaw === "string") toolSummary = argsRaw.replace(/\s+/g, " ").slice(0, 60);
					}
					const renderTool = (open) => {
						disclosureOpen.set(key, open);
						root.render(React.createElement(DisclosureRow, {
							icon: React.createElement(mdApi.IconCodeOutline16, { size: 14 }),
							title: toolDisplayName(name),
							open,
							expandable: true,
							expandOnRowClick: true,
							onToggle: () => renderTool(!open),
							keepContentWhenOpen: false,
							collapsedContent: toolSummary === "" ? void 0 : React.createElement(React.Fragment, null,
								React.createElement("span", { className: ANCHORS.disclosureSeparator, "aria-hidden": true }),
								React.createElement("span", { className: "ma-disclosureSummary" }, toolSummary)),
							children: body
						}));
					};
					renderTool(disclosureOpen.get(key) === true);
					return el;
				};

				const bytesToBase64 = (bytes) => {
					let binary = "";
					const chunk = 0x8000;
					for (let i = 0; i < bytes.length; i += chunk) {
						binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
					}
					return btoa(binary);
				};

				const imageRow = (attachment) => {
					const wrap = document.createElement("div");
					wrap.className = "ma-bubble image";
					const img = document.createElement("img");
					img.className = "ma-image";
					img.alt = "";
					wrap.appendChild(img);
					if (attachment !== void 0 && attachment !== null && arenaMount !== null) {
						try {
							ctx.sessions.binding(arenaMount.arenaSessionId)?.session?.readAttachment?.(attachment.attachmentId).then((result) => {
								if (result === null || result === void 0 || !result.ok || result.value === void 0) return;
								const { attachment: meta, data } = result.value;
								let url;
								try {
									if (typeof URL.createObjectURL === "function" && data !== void 0 && data.buffer !== void 0) {
										url = URL.createObjectURL(new Blob([data.buffer], { type: meta?.mediaType ?? "image/png" }));
									} else if (data !== void 0) {
										url = "data:" + (meta?.mediaType ?? "image/png") + ";base64," + bytesToBase64(data);
									}
								} catch {
									url = void 0;
								}
								if (url !== void 0) img.src = url;
							}).catch(() => {});
						} catch {
							// attachment load unavailable — leave the placeholder
						}
					}
					return wrap;
				};

				// Native markdown renderer: the platform's MarkdownText (mdast →
				// React, byte-identical DOM to the left chat) is loaded lazily from
				// the shared module table. Until it resolves we render plain text.
				let mdApi = null;
				let mdLoading = false;
				const loadMd = async () => {
					if (mdApi !== null || mdLoading) return mdApi;
					mdLoading = true;
					try {
						// The native primitives are seed modules in the client module
						// system: the factory `require` resolves them synchronously
						// (same as `require("react")` above). There is no
						// `window.__DSH_MODULES__` global — the module system is
						// provided as `ctx.modules`, and the factory's `require` is
						// its `makeRequire` face.
						const prim = require("@deepseek-ai/dsh-client-ui-primitives");
						const rd = require("react-dom/client");
						if (prim !== null && prim !== void 0 && prim.MarkdownText !== void 0 && prim.DisclosureRow !== void 0 && rd !== null && rd !== void 0 && typeof rd.createRoot === "function") {
							mdApi = { MarkdownText: prim.MarkdownText, DisclosureRow: prim.DisclosureRow, IconThinkOutline16: prim.IconThinkOutline16, IconThinkOutline14: prim.IconThinkOutline14, IconBrowseOutline16: prim.IconBrowseOutline16, IconCodeOutline16: prim.IconCodeOutline16, IconCopyOutline16: prim.IconCopyOutline16, IconCheckOutline16: prim.IconCheckOutline16, writeClipboard: prim.writeClipboard, Tooltip: prim.Tooltip, React, createRoot: rd.createRoot };
						}
					} catch {
						// fall back to plain text
					}
					mdLoading = false;
					return mdApi;
				};
				// React roots of markdown hosts currently mounted in the pane;
				// unmounted on every repaint (the pane is fully rebuilt each time).
				const mdRoots = new Map();
				const unmountMdRoots = () => {
					for (const rec of mdRoots.values()) {
						try { rec.root.unmount(); } catch {}
					}
					mdRoots.clear();
				};
				// Unmount every md root whose host lives inside one node container
				// (the incremental renderer repaints a single node, not the whole body).
				const unmountContainerRoots = (container) => {
					for (const [key, rec] of [...mdRoots]) {
						const host = rec.host;
						if (host !== void 0 && host !== null && container.contains(host)) {
							try { rec.root.unmount(); } catch {}
							mdRoots.delete(key);
						}
					}
				};

				// Streamed snapshot updates are coalesced to one repaint per frame:
				// a full rebuild per token causes visible flicker (body cleared and
				// markdown roots remounted) and scroll jumps.
				let arenaRepaintQueued = false;
				const scheduleArenaRepaint = () => {
					if (arenaRepaintQueued) return;
					arenaRepaintQueued = true;
					const run = () => {
						arenaRepaintQueued = false;
						renderArenaPane();
					};
					if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
					else setTimeout(run, 0);
				};

				// Keyed node containers: chat node key -> { el, sig }. Repaints update
				// only the containers whose signature changed; everything else keeps
				// its DOM and markdown roots across streaming updates.
				const arenaNodeEls = new Map();

				// Per-node render signatures: only nodes whose visible content changed
				// are repainted; everything else keeps its DOM and md roots (streaming
				// tokens then update one node in place instead of flashing the pane).
				const nodeSig = (node, turnText) => {
					const data = node.data ?? {};
					switch (node.kind) {
						case "context": return "ctx:" + (data.seq ?? "") + ":" + JSON.stringify(data.content) + ":" + (node.provenance?.label ?? "") + ":" + (node.provenance?.summary ?? "");
						case "turn-tail": return "tail:" + (data.time ?? "") + ":" + (data.durationMs ?? "") + ":" + (data.ttftMs ?? "") + ":" + (turnText ?? "");
						case "assistant":
						case "assistant-step": return "asst:" + (node.turn ?? "") + ":" + (node.step ?? "") + ":" + JSON.stringify(data.blocks ?? node.blocks);
						case "tool-result": return "res:" + JSON.stringify(node.content ?? data.content) + ":" + (node.call?.name ?? data.call?.name ?? "") + ":" + (node.isError === true ? 1 : 0);
						default: return "other:" + node.kind;
					}
				};
				// Render one assistant node into its container. When the non-md block
				// structure is unchanged and a markdown host exists, ONLY the md text is
				// re-rendered through the SAME React root (in-place diff, no flicker);
				// otherwise the block is rebuilt wholesale.
				const renderAsstNode = (container, node) => {
					const blocks = blocksOf(node);
					const nmd = nonMdSig(blocks);
					const mdHost = container.querySelector(".ma-assistantMd");
					if (mdHost !== null && nmd === container.dataset.arenaNmd) {
						let rootRec = null;
						for (const [, rec] of mdRoots) {
							if (rec.host === mdHost) { rootRec = rec; break; }
						}
						if (rootRec !== null) {
							const text = blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
							rootRec.root.render(mdApi.React.createElement(mdApi.MarkdownText, { text }));
							return;
						}
					}
					container.dataset.arenaNmd = nmd;
					unmountContainerRoots(container);
					container.textContent = "";
					const asstBlock = document.createElement("div");
					asstBlock.className = "ma-asstBlock";
					let asstHas = false;
					for (const row of assistantRows(blocks)) {
						if (row.kind === "tool") {
							asstBlock.appendChild(toolCallRow(row.name, row.argsRaw));
						} else if (row.kind === "image") {
							asstBlock.appendChild(imageRow(row.attachment));
						} else if (row.kind === "assistant" && mdApi !== null) {
							const host = document.createElement("div");
							host.className = "ma-assistantMd";
							try {
								const root = mdApi.createRoot(host);
								mdRoots.set(root, { root, host });
								root.render(mdApi.React.createElement(mdApi.MarkdownText, { text: row.text }));
							} catch {
								host.textContent = row.text;
							}
							asstBlock.appendChild(host);
						} else if (row.kind === "reasoning") {
							asstBlock.appendChild(thinkRow(row.text));
						} else {
							asstBlock.appendChild(bubble(row.kind, row.text));
						}
						asstHas = true;
					}
					if (asstHas) container.appendChild(asstBlock);
				};

				// Render one node into its keyed container (create or repaint).
				const renderNodeInto = (container, row) => {
					const node = row.node;
					if (isContextNode(node)) {
						unmountContainerRoots(container);
						container.textContent = "";
						container.appendChild(contextRow(node));
					} else if (isTurnTailNode(node)) {
						unmountContainerRoots(container);
						container.textContent = "";
						const tail = turnTailRow(node);
						const actRow = document.createElement("div");
						actRow.className = "ma-actRow";
						actRow.appendChild(copyButton(row.turnText ?? ""));
						if (tail.style.display !== "none") actRow.appendChild(tail);
						container.appendChild(actRow);
					} else if (isAssistantNode(node)) {
						renderAsstNode(container, node);
					} else if (isToolResultNode(node)) {
						unmountContainerRoots(container);
						container.textContent = "";
						const text = toolResultText(contentOf(node));
						const name = node.call?.name ?? node.data?.call?.name ?? "";
						container.appendChild(toolResultRow(name, text, node.isError === true));
					} else if (isUserNode(node)) {
						// A round prompt (user node) injected by the orchestrator:
						// render it as a labeled divider, not a user bubble.
						unmountContainerRoots(container);
						container.textContent = "";
						container.appendChild(roundDivider(node));
					}
				};

				const renderArenaPane = () => {
					if (arenaMount === null || arenaMount.paneBody === null) return;
					const body = arenaMount.paneBody;
					const flow = arenaMount.paneFlow ?? body;
					const interactionsHost = arenaMount.interactionsHost ?? null;
					const anchor = interactionsHost !== null ? interactionsHost : flow;
					let snap;
					try {
						snap = ctx.sessions.binding(arenaMount.arenaSessionId)?.session?.getSnapshot?.();
					} catch {
						snap = void 0;
					}
					// Build the render list: order + per-node signature + the turn text a
					// turn-tail's copy button carries. Skip logic matches the old build.
					const rows = [];
					let hasContent = false;
					let turnText = "";
					let skipUntilUser = false;
					const isPermissionGrant = (node) => {
						if (node === null || node === void 0) return false;
						const text = textOfContent(contentOf(node));
						if (/^\/permission\s/.test(text.trim())) return true;
						const cmd = commandNameOf(node);
						if (cmd === "permission") return true;
						return false;
					};
					for (const key of orderOf(snap)) {
						const node = nodeOf(snap, key);
						if (node === void 0) continue;
						if (isUserNode(node)) {
							if (isPermissionGrant(node)) {
								skipUntilUser = true;
								continue;
							}
							skipUntilUser = false;
							// Each non-permission user node in the arena session is an
							// orchestrator round prompt (质疑 / 终评 / 审查). Render it
							// as a visible round divider so the challenger's replies
							// read as separate turns instead of one continuous block.
							rows.push({ key, node, sig: nodeSig(node, "") });
							hasContent = true;
						} else if (isCommandNode(node)) {
							if (isPermissionGrant(node)) skipUntilUser = true;
						} else if (isTurnTailNode(node)) {
							rows.push({ key, node, sig: nodeSig(node, turnText), turnText });
							hasContent = true;
						} else if (isAssistantNode(node)) {
							if (skipUntilUser) continue;
							for (const row of assistantRows(blocksOf(node))) if (row.kind === "assistant") turnText += row.text + "\n";
							rows.push({ key, node, sig: nodeSig(node, "") });
							hasContent = true;
						} else if (isContextNode(node)) {
							rows.push({ key, node, sig: nodeSig(node, "") });
							hasContent = true;
						} else if (isToolResultNode(node)) {
							if (skipUntilUser) continue;
							rows.push({ key, node, sig: nodeSig(node, "") });
							hasContent = true;
						}
					}
					// Diff: drop containers whose node disappeared from the order.
					for (const [key, rec] of [...arenaNodeEls]) {
						if (!rows.some((r) => r.key === key)) {
							unmountContainerRoots(rec.el);
							rec.el.remove();
							arenaNodeEls.delete(key);
						}
					}
					// Create / repaint / reorder node containers (all before the
					// interactions host, which stays fixed at the end of the body).
					for (const row of rows) {
						let rec = arenaNodeEls.get(row.key);
						if (rec === void 0) {
							const el = document.createElement("div");
							el.className = "ma-arenaNode";
							el.dataset.arenaNodeKey = row.key;
							rec = { el, sig: row.sig };
							arenaNodeEls.set(row.key, rec);
							flow.insertBefore(el, anchor);
							renderNodeInto(el, row);
						} else {
							if (rec.el.parentElement !== flow) flow.insertBefore(rec.el, anchor);
							if (rec.sig !== row.sig) {
								rec.sig = row.sig;
								renderNodeInto(rec.el, row);
							}
						}
					}
					// Empty state only when there is truly nothing (no nodes); the status
					// is idempotent (one marker, removed the moment content appears).
					if (!hasContent) {
						let status = null;
						for (const c of body.children) if (c.dataset?.arenaStatus !== void 0) { status = c; break; }
						if (status === null) {
							status = document.createElement("div");
							status.className = "ma-paneStatus";
							status.dataset.arenaStatus = "";
							status.textContent = t("arena.pane.empty");
							flow.insertBefore(status, anchor);
						}
					} else {
						for (const c of [...body.children]) {
							if (c.dataset?.arenaStatus !== void 0) c.remove();
						}
					}
					renderInteractions(interactionsHost, snap);
				};
				loadMd().then((api) => {
					if (api !== null && arenaMount !== null && arenaMount.paneBody !== null) renderArenaPane();
				}).catch(() => {});

				// Deliver the whole answer batch for a question wait (same wire
				// shape as the platform's user-questions flow).
				const submitAnswers = (wait, questions, answers) => {
					const batch = {
						answers: questions.map((q) => {
							const d = answers[q.id] ?? { selected: [], custom: "" };
							const custom = (d.custom ?? "").trim();
							return {
								id: q.id,
								selected: custom === "" || q.multiSelect === true ? (d.selected ?? []) : [],
								...(custom === "" ? {} : { custom })
							};
						})
					};
					wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer: batch } }).catch(() => {});
				};

				// Render the arena session's pending interactions (questions the
				// arena model asked, or tool-permission approvals) in the right
				// pane so they can be answered without switching sessions.
				const renderInteractions = (body, snap) => {
					// The interactions host is rebuilt on every repaint (the incremental
					// node diff leaves it alone, so without this cards would accumulate).
					body.textContent = "";
					const waits = pendingOf(snap).filter(isWait);
					if (waits.length === 0) return;
					const wait = waits[0];
					if (wait.kind === "approval") {
						const card = document.createElement("div");
						card.className = "ma-question";
						card.dataset.arenaQuestion = "";
						const title = document.createElement("div");
						title.className = "ma-questionTitle";
						title.textContent = t("arena.question.approval");
						const text = document.createElement("div");
						text.className = "ma-questionText";
						text.textContent = wait.payload?.reason ?? wait.payload?.toolName ?? "";
						const actions = document.createElement("div");
						actions.className = "ma-questionActions";
						const allow = document.createElement("button");
						allow.type = "button";
						allow.className = "ma-questionBtn primary";
						allow.textContent = t("arena.question.allow");
						allow.addEventListener("click", () => {
							wait.respond({
								ok: true,
								value: {
									sessionId: wait.sessionId,
									approvalId: wait.payload?.approvalId,
									outcome: "allowed-once"
								}
							}).catch(() => {});
						});
						const reject = document.createElement("button");
						reject.type = "button";
						reject.className = "ma-questionBtn";
						reject.textContent = t("arena.question.reject");
						reject.addEventListener("click", () => {
							wait.respond({
								ok: true,
								value: {
									sessionId: wait.sessionId,
									approvalId: wait.payload?.approvalId,
									outcome: "rejected"
								}
							}).catch(() => {});
						});
						actions.append(allow, reject);
						card.append(title, text, actions);
						body.appendChild(card);
						return;
					}
					const questions = Array.isArray(wait.payload?.questions) ? wait.payload.questions : [];
					if (questions.length === 0) return;
					// Draft answers survive re-renders (streaming tokens re-paint
					// the pane); reset only when a new wait arrives.
					const draft = arenaMount.questionDraft;
					if (draft === null || draft.waitKey !== wait.key) {
						arenaMount.questionDraft = { waitKey: wait.key, answers: {} };
					}
					const answers = arenaMount.questionDraft.answers;
					const card = document.createElement("div");
					card.className = "ma-question";
					card.dataset.arenaQuestion = "";
					const title = document.createElement("div");
					title.className = "ma-questionTitle";
					title.textContent = t("arena.question.header");
					card.appendChild(title);
					for (const q of questions) {
						const block = document.createElement("div");
						block.className = "ma-questionBlock";
						const qText = document.createElement("div");
						qText.className = "ma-questionText";
						qText.textContent = q.question;
						block.appendChild(qText);
						if (q.detail !== void 0) {
							const det = document.createElement("div");
							det.className = "ma-questionDetail";
							det.textContent = q.detail;
							block.appendChild(det);
						}
						const opts = Array.isArray(q.options) ? q.options : [];
						if (opts.length > 0) {
							for (const option of opts) {
								const btn = document.createElement("button");
								btn.type = "button";
								btn.className = "ma-questionOpt";
								const entry = answers[q.id] ?? { selected: [], custom: "" };
								if (entry.selected.includes(option.label)) btn.classList.add("selected");
								btn.textContent = option.label;
								btn.addEventListener("click", () => {
									const cur = answers[q.id] ?? { selected: [], custom: "" };
									if (q.multiSelect === true) {
										cur.selected = cur.selected.includes(option.label)
											? cur.selected.filter((x) => x !== option.label)
											: [...cur.selected, option.label];
									} else {
										cur.selected = [option.label];
										cur.custom = "";
									}
									answers[q.id] = cur;
									if (q.multiSelect !== true) {
										submitAnswers(wait, questions, answers);
										return;
									}
									renderArenaPane();
								});
								block.appendChild(btn);
							}
						} else {
							const input = document.createElement("input");
							input.type = "text";
							input.className = "ma-questionInput";
							input.placeholder = t("arena.question.placeholder");
							input.value = (answers[q.id]?.custom ?? "").trim();
							input.addEventListener("input", () => {
								const cur = answers[q.id] ?? { selected: [], custom: "" };
								cur.custom = input.value;
								answers[q.id] = cur;
							});
							block.appendChild(input);
						}
						card.appendChild(block);
					}
					const actions = document.createElement("div");
					actions.className = "ma-questionActions";
					const submit = document.createElement("button");
					submit.type = "button";
					submit.className = "ma-questionBtn primary";
					submit.textContent = t("arena.question.submit");
					submit.addEventListener("click", () => submitAnswers(wait, questions, answers));
					const cancel = document.createElement("button");
					cancel.type = "button";
					cancel.className = "ma-questionBtn";
					cancel.textContent = t("arena.question.cancel");
					cancel.addEventListener("click", () => {
						wait.respond({ ok: false, error: { code: "cancelled", message: "cancelled", details: {} } }).catch(() => {});
					});
					actions.append(submit, cancel);
					card.appendChild(actions);
					body.appendChild(card);
				};

				// Generic prompt channel for both sessions (main + arena challenger).
				const promptSession = async (sessionId, text) => {
					try {
						await ctx.sessions.binding(sessionId)?.session?.prompt?.([{ type: "text", text }], "queue");
					} catch (_promptFailure) {
						// the next round retries; the pane keeps showing what it has
					}
				};

				const createArenaSession = async (sessionId, state, firstText) => {
					// Resolve the current session's workspace so the arena session is
					// attached to the SAME workspace (shared project context). The
					// workspace list lives in workspaces.list.getSnapshot().items.
					let workspace;
					try {
						const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
						const items = Array.isArray(workspaces?.list?.getSnapshot?.()?.items) ? workspaces.list.getSnapshot().items : [];
						workspace = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId));
						if (workspace === void 0) {
							// fallback: match the session's cwd against workspace paths
							const summaryCwd = sessionSummaryOf(sessionId)?.cwd;
							if (summaryCwd !== void 0) {
								workspace = items.find((w) => w.path === summaryCwd);
							}
						}
					} catch {
						workspace = void 0;
					}
					const arenaId = "arena-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
					const arenaSessionId = await ctx.sessions.create({
						sessionId: arenaId,
						...(workspace !== void 0 && workspace.workspaceId !== void 0 ? { workspaceId: workspace.workspaceId } : {})
					});
					// selectModel/rename live on the connection wire API
					// (connection.api.sessions), not on ctx.sessions.
					const apiSessions = (() => {
						try {
							const connection = typeof ctx.get === "function" ? ctx.get("connection") : void 0;
							return connection?.api?.sessions ?? void 0;
						} catch {
							return void 0;
						}
					})();
					if (apiSessions !== void 0 && typeof apiSessions.selectModel === "function") {
						await apiSessions.selectModel({
							sessionId: arenaSessionId,
							provider: state.model.provider,
							model: state.model.model,
							...(state.model.reasoningEffort === void 0 ? {} : { reasoningEffort: state.model.reasoningEffort })
						});
					}
					try {
						if (apiSessions !== void 0 && typeof apiSessions.rename === "function") {
							await apiSessions.rename({ sessionId: arenaSessionId, title: t("arena.sessionTitle") });
						}
					} catch (_renameFailure) {
						// cosmetic only
					}
					// Open the arena session's client window: while a session is
					// "cold" (never opened) its live events are dropped and the
					// chat never assembles. open() pulls the tail page without
					// switching the current selection.
					try {
						await ctx.sessions.binding(arenaSessionId)?.session?.open?.();
					} catch (_openFailure) {
						// history unavailable — the pane still shows what streams
					}
					// Match the CURRENT chat's permission preset (the "permissions"
					// session projection) so the arena agent runs under the same
					// sandbox/approval policy. Applied through the host COMMAND
					// channel (session.command, like the native composer permission
					// selector): the handler flips the sandbox/approval knobs and
					// records a `command` flow node - no model turn is scheduled, so
					// the grant never enters the arena context and the arena model
					// never replies to it (a prompt-based grant would do both).
					try {
						const permission = sessionSummaryOf(sessionId)?.projectionValues?.permissions?.currentValue;
						if (permission !== void 0 && permission !== "" && permission !== "custom") {
							const arenaBinding = ctx.sessions.binding(arenaSessionId)?.session;
							if (arenaBinding !== void 0 && typeof arenaBinding.command === "function") {
								await arenaBinding.command("/permission " + permission);
							}
						}
					} catch (_permissionFailure) {
						// best effort — the arena falls back to its default policy
					}
					if (typeof firstText === "string" && firstText !== "") {
						await promptSession(arenaSessionId, firstText);
					}
					return arenaSessionId;
				};

								// Arena runtime (tab model): opens the arena session window so its
				// chat assembles; actual rendering happens inside the native
				// "竞技场" view-ring tab (ArenaView mounts the renderer).
				const mountArenaRuntime = (state) => {
					if (arenaMount === null || arenaMount.arenaSessionId === void 0) return;
					arenaMount.error = null;
					arenaMount.failedText = void 0;
					try {
						ctx.sessions.binding(arenaMount.arenaSessionId)?.session?.open?.();
					} catch {
						// ignore — the subscription renders whatever is available
					}
					arenaTick.bump();
				};

				// Head strip inside the arena tab: arena model + reasoning effort.
				const paintArenaHead = (head, sessionId) => {
					if (head === null) return;
					const state = stateBySession.get(sessionId);
					const model = state?.model ?? null;
					let arenaLabel = model === null ? "" : (model.name ?? model.model ?? "");
					if (model !== null) {
						try {
							const dirSnap = models.directoryFor(sessionId)?.store?.getSnapshot?.();
							const arenaModel = findArenaModel(dirSnap, model);
							if (arenaModel !== void 0 && arenaModel.reasoning !== void 0) {
								const efforts = arenaModel.reasoning.efforts ?? [];
								const arenaEffort = model.reasoningEffort !== void 0
									? (efforts.find((level) => level.id === model.reasoningEffort)?.name ?? model.reasoningEffort)
									: (arenaModel.reasoning.defaultEffort === void 0 ? t("effort.default") : efforts.find((level) => level.id === arenaModel.reasoning.defaultEffort)?.name ?? arenaModel.reasoning.defaultEffort);
								if (arenaEffort !== "") arenaLabel += " · " + arenaEffort;
							}
						} catch (_arenaEffortFailure) {
							// best effort
						}
					}
					head.textContent = arenaLabel === "" ? t("arena.paneTitle") : t("arena.paneTitle") + " · " + arenaLabel;
				};

				// Empty state: arena enabled but no arena session yet (pre-first-message).
				const renderArenaEmpty = (body) => {
					const status = document.createElement("div");
					status.className = "ma-paneStatus";
					status.textContent = t("arena.pane.empty");
					body.appendChild(status);
				};

				// Startup failure inside the tab: error + retry (re-runs creation
				// with the failed message).
				const renderArenaError = (body) => {
					if (arenaMount === null) return;
					const err = document.createElement("div");
					err.className = "ma-paneError";
					err.textContent = arenaMount.error ?? t("arena.error.generic");
					const retry = document.createElement("button");
					retry.type = "button";
					retry.className = "ma-questionBtn primary";
					retry.textContent = t("arena.error.retry");
					retry.addEventListener("click", () => {
						const text = arenaMount?.failedText;
						const sessionId = arenaMount?.sessionId;
						const state = sessionId === void 0 ? void 0 : stateBySession.get(sessionId);
						if (arenaMount !== null) arenaMount.error = null;
						if (text !== void 0 && state !== void 0) startChallenge(sessionId, state, text);
					});
					body.appendChild(err);
					body.appendChild(retry);
				};

				// Mount the arena renderer into the tab container (called by the
				// ArenaView ref lifecycle; also exported for the smoke test).
				const mountArenaTab = (root, sessionId) => {
					if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
					// Build head/body once per container; tick-driven refreshes repaint
					// in place instead of rebuilding the structure (which flickers).
					let head = arenaMount.paneHead;
					let body = arenaMount.paneBody;
					let freshContainer = false;
					if (head === null || body === null || head.parentElement !== root || body.parentElement !== root) {
						// New container (or session switch): reset the node pool and the
						// md registry, drop follow wiring bound to the old body, then
						// build the fixed skeleton (head + body + a trailing interactions
						// host the node diff inserts before).
						arenaMount.resizeObs?.disconnect?.();
						arenaMount.scrollUnsub?.();
						arenaMount.resizeObs = null;
						arenaMount.scrollUnsub = null;
						for (const [, rec] of arenaNodeEls) unmountContainerRoots(rec.el);
						arenaNodeEls.clear();
						root.textContent = "";
						head = document.createElement("div");
						head.className = "ma-arenaViewHead";
						body = document.createElement("div");
						body.className = "ma-paneBody";
						body.dataset.arenaPaneBody = "";
						const flow = document.createElement("div");
						flow.className = "ma-arenaFlow";
						flow.dataset.arenaFlow = "";
						const interactionsHost = document.createElement("div");
						interactionsHost.className = "ma-arenaInteractions";
						interactionsHost.dataset.arenaInteractions = "";
						flow.appendChild(interactionsHost);
						body.appendChild(flow);
						root.append(head, body);
						arenaMount.paneHead = head;
						arenaMount.paneFlow = flow;
						arenaMount.interactionsHost = interactionsHost;
						freshContainer = true;
					}
					paintArenaHead(head, sessionId);
					arenaMount.paneBody = body;
					if (arenaMount.error !== null && arenaMount.arenaSessionId === void 0) {
						renderArenaError(body);
						return;
					}
					if (arenaMount.arenaSessionId === void 0) {
						renderArenaEmpty(body);
						return;
					}
					// Subscribe once; later refreshes reuse the live subscription.
					if (arenaMount.unsubArena === null) {
						try {
							arenaMount.unsubArena = ctx.sessions.binding(arenaMount.arenaSessionId)?.session?.subscribe?.(scheduleArenaRepaint) ?? null;
						} catch {
							arenaMount.unsubArena = null;
						}
					}
					// Follow-scroll: track whether the reader is pinned to the bottom, and
					// re-pin whenever the pane's content size changes. Markdown commits
					// asynchronously (React), so the double-rAF height read in
					// renderArenaPane can miss the growth; ResizeObserver fires after the
					// actual layout change — the same mechanism the native chat uses.
					if (arenaMount.scrollUnsub === null) {
						arenaMount.arenaAtBottom = true;
						const onScroll = () => {
							if (arenaMount === null || arenaMount.paneBody === null) return;
							const b = arenaMount.paneBody;
							arenaMount.arenaAtBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
						};
						body.addEventListener("scroll", onScroll, { passive: true });
						arenaMount.scrollUnsub = () => body.removeEventListener("scroll", onScroll);
						if (typeof ResizeObserver === "function") {
							const ro = new ResizeObserver(() => {
								if (arenaMount === null || arenaMount.paneBody === null) return;
								if (arenaMount.arenaAtBottom === true) {
									arenaMount.paneBody.scrollTop = arenaMount.paneBody.scrollHeight;
								}
							});
							ro.observe(arenaMount.paneFlow ?? body);
							arenaMount.resizeObs = ro;
						}
					}
					renderArenaPane();
					// Entering the tab (fresh container) always lands on the newest message:
					// markdown commits asynchronously, so pin across several frames plus a
					// timeout fallback, and cancel the moment the reader scrolls away.
					if (freshContainer) {
						let cancelled = false;
						try {
							body.addEventListener("scroll", () => { cancelled = true; }, { once: true, passive: true });
						} catch (_pinCancelFailure) {
							// scroll wiring unavailable — fall through to the plain pin
						}
						const pinBottom = () => {
							if (cancelled || arenaMount === null || arenaMount.paneBody === null) return;
							arenaMount.paneBody.scrollTop = arenaMount.paneBody.scrollHeight;
							arenaMount.arenaAtBottom = true;
						};
						if (typeof requestAnimationFrame === "function") requestAnimationFrame(pinBottom);
						setTimeout(pinBottom, 120);
					}
					// Switching INTO the arena tab (or landing here after a reload
					// while the tab is active) must immediately re-run the
					// alignment/catch-up: a challenger phase that was interrupted
					// re-injects its round prompt right now ("切到竞技场会话时立即
					// review/终审"), and a turn that finished server-side advances.
					try {
						detectChallengeTurn();
					} catch (_tabCatchUpFailure) {
						// never break the tab mount
					}
				};

				const unmountArenaTab = (root) => {
					if (arenaMount === null) return;
					// Release the subscription only. The structure and its references
					// stay: React removes the container element on a real unmount, and
					// keeping paneHead/paneBody lets a same-container refresh repaint in
					// place instead of rebuilding (no flicker).
					arenaMount.unsubArena?.();
					arenaMount.unsubArena = null;
					arenaMount.resizeObs?.disconnect?.();
					arenaMount.scrollUnsub?.();
					arenaMount.resizeObs = null;
					arenaMount.scrollUnsub = null;
				};

				// The native view-ring seat: renders the arena session's chat inside
				// the "竞技场" tab. The ring renders one view at a time, so this only
				// mounts while the tab is active; the renderer itself is imperative
				// DOM (mountArenaTab) driven by a per-tab subscription.
				const ArenaView = (props) => {
					const sessionId = props.sessionId;
					const tick = React.useSyncExternalStore(arenaTick.subscribe, arenaTick.getSnapshot);
					const rootRef = React.useRef(null);
					React.useEffect(() => {
						const root = rootRef.current;
						if (root === null) return;
						if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
						mountArenaTab(root, sessionId);
						return () => {
							unmountArenaTab(root);
						};
					}, [sessionId, tick]);
					if (arenaMount === null || arenaMount.sessionId !== sessionId) return null;
					return React.createElement("div", { className: "ma-arenaView", "data-arena-tab": "", ref: rootRef });
				};

				// Persistent progress strip in the MAIN session header: shows the four
				// challenge stages with the active one highlighted, so the user always
				// sees who is working (model 1 drafting/revising, challenger
				// challenging/reviewing). Rendered per session header; returns null
				// unless this session's arena runtime is mid-challenge.
				const ChallengeStatus = (props) => {
					const sessionId = props.sessionId;
					React.useSyncExternalStore(arenaTick.subscribe, arenaTick.getSnapshot);
					// The strip belongs to the MAIN session header only — a competitor
					// (arena) session never shows it, whatever the runtime state:
					// clicking into an ended/interrupted competitor session must not
					// resurrect the header.
					if (sessionId === void 0 || isArenaSessionId(sessionId)) return null;
					if (arenaMount === null || arenaMount.sessionId !== sessionId) return null;
					if (!shouldShowChallengeHeader(arenaMount.challenge)) return null;
					const c = arenaMount.challenge;
					const stopBtn = React.createElement("button", {
						type: "button",
						className: "ma-challengeStop",
						"data-challenge-stop": "",
						title: t("challenge.stop"),
						"aria-label": t("challenge.stop"),
						onClick: () => { try { abortChallenge(); } catch {} }
					}, "■");
					const nodes = [];
					const mainRole = (SCENES[c.scene] ?? SCENES.business).main;
					if ((SCENES[c.scene] ?? SCENES.business).review === true) {
						// Review loop: current stage + reject counter.
						const stageLabel = c.phase === "propose" ? mainRole + " Propose…"
							: c.phase === "review" ? "Review…"
							: c.phase === "revise" ? mainRole + " Revise…" : "";
						nodes.push(React.createElement("span", { key: "stage", className: "ma-challengeStage active" }, stageLabel));
						if (c.rejectCount > 0) {
							nodes.push(React.createElement("span", { key: "sep", className: "ma-challengeSep" }, "·"));
							nodes.push(React.createElement("span", { key: "rejects", className: "ma-challengeStage" }, "Rejected " + c.rejectCount + "/3"));
						}
					} else {
						// Original challenge flow: answer -> challenge -> revise -> final.
						const stages = [
							{ key: "answer", label: mainRole + " Draft…" },
							{ key: "challenge", label: "Challenging…" },
							{ key: "revise", label: mainRole + " Revising…" },
							{ key: "final", label: "Reviewing…" }
						];
						const order = ["answer", "challenge", "revise", "final"];
						const activeIdx = order.indexOf(c.phase);
						stages.forEach((stage, i) => {
							if (i > 0) nodes.push(React.createElement("span", { key: "sep" + i, className: "ma-challengeSep" }, "→"));
							nodes.push(React.createElement("span", {
								key: stage.key,
								className: "ma-challengeStage" + (i < activeIdx ? " done" : i === activeIdx ? " active" : "")
							}, (i < activeIdx ? "✓ " : "") + stage.label));
						});
					}
					nodes.push(stopBtn);
					return React.createElement("div", { className: "ma-challengeHeader", "data-challenge-header": "" }, ...nodes);
				};

				// The header strip rides the same declaration-gated inject: it is a
				// per-session header action that renders only while this session is
				// mid-challenge (the component itself decides). The slots service is
				// resolved at call time (ctx.get), matching syncViewEntry, so it works
				// even before the host re-reads the inject declaration.
				const headerSlots = typeof ctx.get === "function" ? ctx.get("slots") : void 0;
				if (headerSlots !== void 0 && typeof headerSlots.inject === "function") {
					headerSlots.inject("conversation.session.header.actions", () => headerSlots.register({
						name: "conversation.session.header.actions",
						id: "challenge-status",
						order: -20,
						locale: NS
					}, ChallengeStatus));
				}

				// Settings page: a read-only "竞技场" card documenting the three
				// scenes and every prompt the plugin injects (role seeds via the
				// system-prompt persona waterfall, round prompts as user messages
				// into the arena session). Built from the REAL builders so the
				// documentation can never drift from the injected text.
				const buildPromptDocs = () => {
					const sample = (scene) => ({
						scene,
						userQuestion: "用户的问题原文",
						lastMainText: "主模型的回答正文（不含思维链/思考过程）",
						lastMainTools: [{ name: "run_code", argsRaw: JSON.stringify({ description: "执行脚本：核实某处代码逻辑" }) }]
					});
					const out = {};
					for (const key of Object.keys(SCENES)) {
						const c = sample(key);
						const review = SCENES[key].review === true;
						out[key] = {
							mainSeed: buildMainRoleSeed(c, t),
							arenaSeed: buildRoleSeed(c, t),
							rounds: (review ? ["review"] : ["challenge", "final"]).map((kind) => ({ kind, text: buildRoundPrompt(kind, c, t) }))
						};
					}
					return out;
				};
				const ArenaSettingsCard = () => {
					const docs = buildPromptDocs();
					const sceneKeys = ["business", "knowledge", "qa"];
					const [bg, setBg] = React.useState(backgroundAdvance);
					const nodes = [React.createElement("h2", { key: "head", className: "ma-settingsHead" }, t("settings.title"))];
					// Background-advance switch at the TOP of the arena settings
					// (user-requested; persisted via settings backgroundAdvance).
					const toggleBg = () => {
						const next = !bg;
						setBg(next);
						backgroundAdvance = next;
						try {
							apiSettings()?.mutate?.({
								ns: "model-arena",
								ops: [{ op: "set", path: ["backgroundAdvance"], value: next }]
							}).catch(() => {});
						} catch {
							// best effort
						}
					};
					nodes.push(React.createElement("div", { key: "bg", className: "ma-settingsScene", "data-arena-bg": "" },
						React.createElement("label", { className: "ma-settingsSceneTitle ma-settingsToggleRow", "data-arena-bg-toggle": "" },
							React.createElement("input", { type: "checkbox", checked: bg, onChange: toggleBg, "data-arena-bg-checkbox": "" }),
							React.createElement("span", null, t("settings.background.title"))
						),
						React.createElement("div", { className: "ma-settingsSceneDesc" }, t("settings.background.desc"))
					));
					// ── temperature tuning (settings-page only: persisted, but the
					// agent/request injection that applies these values is a
					// follow-up task and NOT implemented yet) ──
					const [temp, setTemp] = React.useState(() => ({
						enabled: temperatureSettings.enabled === true,
						business: { ...(temperatureSettings.business ?? {}) },
						knowledge: { ...(temperatureSettings.knowledge ?? {}) },
						qa: { ...(temperatureSettings.qa ?? {}) }
					}));
					// Latest temp snapshot for onChange handlers (avoids stale-closure
					// loss on rapid keystrokes between renders).
					const tempRef = React.useRef(temp);
					tempRef.current = temp;
					// Raw input strings per scene×role, so typing intermediates like
					// "0." stay visible while only valid values are persisted.
					const [tempInputs, setTempInputs] = React.useState(() => ({}));
					const tempInputValue = (sceneKey, role) => {
						const key = sceneKey + "/" + role;
						if (Object.prototype.hasOwnProperty.call(tempInputs, key)) return tempInputs[key];
						const cell = temp[sceneKey];
						const v = cell === void 0 ? void 0 : cell[role];
						return typeof v === "number" ? String(v) : "";
					};
					const persistTemperature = (next) => {
						setTemp(next);
						try {
							apiSettings()?.mutate?.({
								ns: "model-arena",
								ops: [{ op: "set", path: ["temperature"], value: next }]
							}).catch(() => {});
						} catch {
							// best effort
						}
					};
					const toggleTemp = () => persistTemperature({ ...temp, enabled: !temp.enabled });
					const onTempChange = (sceneKey, role, raw) => {
						if (raw !== "") {
							// Immediate reject: illegal characters / >2 decimal places,
							// or a value above the 0..2 cap — the controlled input keeps
							// its previous text ("0.155" and "2.01" can never be typed).
							if (!/^\d*\.?\d{0,2}$/.test(raw)) return;
							if (Number(raw) > 2) return;
						}
						const key = sceneKey + "/" + role;
						setTempInputs((prev) => ({ ...prev, [key]: raw }));
						const result = normalizeTemperatureInput(raw);
						if (!result.ok) return; // typing intermediate ("0.") — display only
						const base = tempRef.current;
						persistTemperature({ ...base, [sceneKey]: { ...(base[sceneKey] ?? {}), [role]: result.value } });
					};
					const tempScene = (sceneKey) => {
						const field = (role) => React.createElement("label", { key: role, className: "ma-settingsTempRow" },
							React.createElement("span", { className: "ma-settingsTempLabel" }, t(role === "main" ? "settings.temperature.main" : "settings.temperature.challenger")),
							React.createElement("input", {
								className: "ma-settingsTempInput",
								type: "text",
								inputMode: "decimal",
								pattern: "\\d*\\.?\\d{0,2}",
								autoComplete: "off",
								spellCheck: false,
								value: tempInputValue(sceneKey, role),
								placeholder: t("settings.temperature.default"),
								onChange: (event) => onTempChange(sceneKey, role, event.target.value),
								"data-arena-temp-input": sceneKey + "-" + role
							})
						);
						return React.createElement("div", { key: sceneKey, className: "ma-settingsTempScene" },
							React.createElement("div", { className: "ma-settingsSceneTitle" }, t("scene." + sceneKey)),
							field("main"),
							field("challenger")
						);
					};
					nodes.push(React.createElement("div", { key: "temp", className: "ma-settingsScene", "data-arena-temp": "" },
						React.createElement("label", { className: "ma-settingsSceneTitle ma-settingsToggleRow", "data-arena-temp-toggle": "" },
							React.createElement("input", { type: "checkbox", checked: temp.enabled, onChange: toggleTemp, "data-arena-temp-checkbox": "" }),
							React.createElement("span", null, t("settings.temperature.title"))
						),
						React.createElement("div", { className: "ma-settingsSceneDesc" }, t("settings.temperature.desc")),
						...(temp.enabled ? sceneKeys.map(tempScene) : [])
					));
					nodes.push(React.createElement("div", { key: "scenes-label", className: "ma-settingsSectionTitle" }, t("settings.scenes")));
					for (const key of sceneKeys) {
						const scene = SCENES[key];
						const d = docs[key];
						const meta = scene.main + " → " + scene.arena + " · " + (scene.review === true ? t("settings.flow.review") : t("settings.flow.challenge"));
						const block = React.createElement("div", { key: key, className: "ma-settingsScene" },
							React.createElement("div", { className: "ma-settingsSceneTitle" }, t("scene." + key)),
							React.createElement("div", { className: "ma-settingsSceneMeta" }, meta),
							React.createElement("div", { className: "ma-settingsSceneDesc" }, t("settings.scene." + key + ".desc")),
							React.createElement("div", { className: "ma-settingsPromptLabel" }, t("settings.prompt.roles")),
							React.createElement("pre", { className: "ma-settingsPrompt" }, t("settings.prompt.roleMain") + "\n" + d.mainSeed + "\n\n" + t("settings.prompt.roleArena") + "\n" + d.arenaSeed),

							...d.rounds.map((round) => React.createElement("pre", { key: round.kind, className: "ma-settingsPrompt" }, "[" + t("settings.prompt.kind." + round.kind) + "]\n" + round.text))
						);
						nodes.push(block);
					}
					nodes.push(React.createElement("p", { key: "note", className: "ma-settingsNote" }, t("settings.note")));
					return React.createElement("div", { className: "ma-settingsCard", "data-arena-settings": "" }, ...nodes);
				};
				const settingsSlots = typeof ctx.get === "function" ? ctx.get("slots") : void 0;
				if (settingsSlots !== void 0 && typeof settingsSlots.inject === "function") {
					// Top-level settings nav entry ("设置 → 竞技场"), registered into
					// the settings.section list slot that the settings page core always
					// declares — more reliable than the per-plugin card surface, and it
					// is exactly the "an option named Arena in settings" the user asked
					// for. The nav row label comes from the settings.title locale key.
					settingsSlots.inject("settings.section", () => settingsSlots.register({
						name: "settings.section",
						id: "model-arena",
						order: 20,
						label: () => t("settings.title"),
						locale: NS
					}, ArenaSettingsCard));
				}

				// Register/unregister the "竞技场" view-ring tab: the ledger is
				// global, so disposal is what hides the tab outside arena-enabled
				// sessions. Retried on every sync until the conversation package
				// declares the slot.
				let arenaViewDisposer = null;
				// Push the per-session role map to the node half (settings "persona"),
				// which injects it into the system-prompt waterfall. Only writes when the
				// map actually changes (sync runs frequently). Non-arena sessions clear
				// their entry; the arena session (challenger) gets its own role.
				let lastPersonaSig = null;
				const syncPersona = () => {
					try {
						const sessionId = currentSessionId();
						const state = sessionId === void 0 ? void 0 : stateBySession.get(sessionId);
						const active = state !== void 0 && state.enabled === true && state.model !== null && state.model !== void 0;
						let next = {};
						if (active && arenaMount !== null && arenaMount.sessionId === sessionId) {
							next[sessionId] = buildMainRoleSeed(arenaMount.challenge, t);
							if (arenaMount.arenaSessionId !== void 0) {
								next[arenaMount.arenaSessionId] = buildRoleSeed(arenaMount.challenge, t);
							}
						}
						const sig = JSON.stringify(next);
						if (sig === lastPersonaSig) return;
						lastPersonaSig = sig;
						apiSettings()?.mutate?.({
							ns: "model-arena",
							ops: [{ op: "set", path: ["persona"], value: next }]
						}).catch(() => {});
					} catch (_personaSyncFailure) {
						// persona sync must never break the plugin lifecycle
					}
				};

				const syncViewEntry = () => {
					const sessionId = currentSessionId();
					const state = sessionId === void 0 ? void 0 : stateBySession.get(sessionId);
					const active = state !== void 0 && state.enabled === true && state.model !== null && state.model !== void 0;
					// Resolve the slots service at call time: it is a runtime service
					// (ctx.get("slots")), so registration works even before the host
					// re-reads the inject declaration after a plugin update.
					const slots = typeof ctx.get === "function" ? ctx.get("slots") : void 0;
					if (slots === void 0 || typeof slots.register !== "function") return;
					if (active && arenaViewDisposer === null) {
						try {
							arenaViewDisposer = slots.register({
								name: "conversation.view",
								id: "arena",
								order: 5,
								label: () => t("view.arena"),
								locale: NS
							}, ArenaView);
						} catch (_registerFailure) {
							arenaViewDisposer = null; // slot not declared yet — next sync retries
						}
					} else if (!active && arenaViewDisposer !== null) {
						arenaViewDisposer();
						arenaViewDisposer = null;
						arenaTick.bump();
					}
				};
				// ── challenge-mode orchestration ─────────────────────────────────
				// Last chat node key of a session (turn-completion anchor).
				const lastKeyOfSnapshot = (sessionId) => {
					try {
						const order = orderOf(ctx.sessions.binding(sessionId)?.session?.getSnapshot?.());
						return order.length > 0 ? order[order.length - 1] : null;
					} catch {
						return null;
					}
				};
				// A session pausing on a user interaction (question / tool-permission)
				// is legitimately not-producing: the agent may briefly read as
				// not-running while it awaits the user's answer. A pending wait must
				// never count as "stopped without output" — otherwise answering a
				// main-model question mid-round would abort the whole challenge.
				const hasPendingInteraction = (snap) => pendingOf(snap).some(isWait);
				// Key of the main-session node carrying the last injected round text
				// (the challenger's feedback injected as a user message). Re-anchoring
				// to THIS node — instead of the newest node — keeps the turn check
				// correct when a revision finished while the arena runtime was
				// unmounted (session switch): the newest node is then the finished
				// revise turn itself, and anchoring to it would miss it.
				const injectedNodeKey = (sessionId, text) => {
					if (typeof text !== "string" || text === "") return null;
					try {
						const snap = ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
						let found = null;
						for (const key of orderOf(snap)) {
							const node = nodeOf(snap, key);
							if (node === void 0) continue;
							if (isUserNode(node) && textOfContent(contentOf(node)) === text) found = key;
						}
						return found;
					} catch {
						return null;
					}
				};
				// Session-list summary entry (cwd / permission preset projection).
				// Part of the session-contract reads: a dsh upgrade that reshapes the
				// byId summary is fixed here, not at the call sites.
				const sessionSummaryOf = (sessionId) => {
					try {
						return ctx.sessions.list.getSnapshot()?.byId?.[sessionId];
					} catch {
						return void 0;
					}
				};
				// A turn counts as complete when the session is idle and a NEW model
				// output node (assistant / assistant-step) landed after the recorded
				// anchor. Prompt user messages land in the order BEFORE the model
				// starts; they must never count as a completed turn — otherwise the
				// previous reply is reused (e.g. the challenge text as the verdict).
				const turnCompleted = (snap, sinceKey) => {
					if (snap === void 0 || snap === null) return false;
					if (runningOf(snap)) return false;
					const order = orderOf(snap);
					if (order.length === 0 || order[order.length - 1] === sinceKey) return false;
					for (let i = order.length - 1; i >= 0 && order[i] !== sinceKey; i--) {
						if (isAssistantNode(nodeOf(snap, order[i]))) return true;
					}
					return false;
				};
				// Text of the LATEST assistant node of a session (model output to
				// forward as context).
				const extractLastAssistantText = (sessionId) => {
					try {
						const snap = ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
						const order = orderOf(snap);
						let out = "";
						for (let i = order.length - 1; i >= 0; i--) {
							const node = nodeOf(snap, order[i]);
							if (node === void 0) continue;
							if (isAssistantNode(node)) {
								for (const row of assistantRows(blocksOf(node))) {
										if (row.kind === "assistant") out += row.text + "\n";
								}
								break;
							}
						}
						return out.trim();
					} catch {
						return "";
					}
				};
				// Tool-call blocks of the LATEST assistant node (name + raw args),
				// forwarded to the challenger as context. Deliberately simple: only
				// the assistant node's own tool-call blocks — no tool-result linkage.
				const extractLastAssistantTools = (sessionId) => {
					try {
						const snap = ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
						const order = orderOf(snap);
						for (let i = order.length - 1; i >= 0; i--) {
							const node = nodeOf(snap, order[i]);
							if (node === void 0) continue;
							if (isAssistantNode(node)) {
								const out = [];
								for (const row of assistantRows(blocksOf(node))) {
									if (row.kind === "tool") out.push({ name: row.name, argsRaw: row.argsRaw });
								}
								return out;
							}
						}
						return [];
					} catch {
						return [];
					}
				};

				// Start (or restart) the challenge flow on the user's first question:
				// ensure the arena session WITHOUT mirroring the question, record the
				// question + anchors, lock the composer, and wait for the main session
				// to finish answering.
				const startChallenge = (sessionId, state, text) => {
					if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
					// The arena model may never equal the input box's model (the hero
					// pick could have run before the directory resolved its current).
					try {
						const dirSnap = models.directoryFor(sessionId).store.getSnapshot();
						// Two-model auto mode: derive the complement of the input box's
						// current model even if the hero materialization has not run
						// yet (belt and suspenders — the composer gate already covers
						// the normal flow).
						if (state.model === null) {
							const auto = autoArenaModel(dirSnap);
							if (auto !== null) state.model = auto;
						}
						if (conflictsWithInput(state.model, dirSnap)) {
							state.model = null;
							arenaMount.error = t("conflict");
							arenaTick.bump();
							return;
						}
					} catch {
						// directory unavailable — proceed with the stored pick
					}
					const c = arenaMount.challenge;
					// The challenge state lives in the per-session state too, so a session
					// switch (teardown) can restore it on the way back.
					state.challenge = c;
					const ensure = arenaMount.arenaSessionId !== void 0
						? Promise.resolve(arenaMount.arenaSessionId)
						: createArenaSession(sessionId, state, null).then((arenaId) => {
							if (arenaMount === null || arenaMount.sessionId !== sessionId) throw new Error("session switched");
							arenaMount.arenaSessionId = arenaId;
							state.arena = { sessionId: arenaId };
							mountArenaRuntime(state);
							saveLink(sessionId, {
								sessionId: arenaId,
								provider: state.model.provider,
								model: state.model.model,
								...(state.model.reasoningEffort === void 0 ? {} : { reasoningEffort: state.model.reasoningEffort }),
								...(state.model.name === void 0 ? {} : { name: state.model.name }),
								scene: c.scene
							});
							// The challenger's role is injected via the system-prompt waterfall
							// (persona map synced to settings); archiving hides it from the sidebar.
							// Archive the challenger immediately: the platform excludes archived
							// sessions from the sidebar AND from the "show N more" counter,
							// so it never shows up as a phantom session. Archiving is a UI
							// hide only — the session stays fully usable (we keep prompting
							// it through binding().session).
							try {
								const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
								if (workspaces !== void 0 && typeof workspaces.archiveSession === "function") {
									workspaces.archiveSession(arenaId).catch(() => {});
								}
							} catch (_archiveFailure) {
								// best effort — hiding is cosmetic; the challenger still works
							}
							// Bind the challenger-turn subscription to the new session.
							// The wrapper also bumps arenaTick on every arena-snapshot
							// change so the header loading animation tracks the
							// challenger's running flag (see syncArena restore site),
							// and re-syncs the sidebar loading dot.
							try {
								arenaMount.unsubArenaTurn?.();
								arenaMount.unsubArenaTurn = ctx.sessions.binding(arenaId)?.session?.subscribe?.(() => {
									arenaTick.bump();
									syncChallengerLoading();
									detectChallengeTurn();
								}) ?? null;
							} catch {
								arenaMount.unsubArenaTurn = null;
							}
							return arenaId;
						});
					ensure.then(() => {
						if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
						c.userQuestion = text;
						c.active = true;
						// Model 1's role comes from the system-prompt waterfall (persona
						// map synced to settings), active from the first turn — no message.
						c.phase = isReviewScene(c) ? "propose" : "answer";
						c.skill = state.skill ?? "";
						c.rejectCount = 0;
						c.verdict = "";
						c.round = 0;
						c.stallSince = 0;
						c.challengerRePrompted = false;
						// A fresh round has never prompted the challenger yet.
						c.lastPromptSent = "";
						// A fresh round is NOT a restored challenge: restore alignment
						// must never touch it (see alignChallengeAfterRestore).
						c.restored = false;
						c.alignDone = false;
						c.lastReviewSeq = -1;
						c.proposalPath = "";
						c.designPath = "";
						c.tasksPath = "";
						c.reviewPath = "";
						c.mainAnchor = lastKeyOfSnapshot(sessionId);
						c.arenaAnchor = lastKeyOfSnapshot(arenaMount.arenaSessionId);
						// Knowledge scene: arm the node half's propose.completed detector
						// by persisting the main session id + cwd so it can poll the
						// Theseus workflow state and write back `arena.reviewRequest`.
						if (isReviewScene(c)) {
							const arenaCwd = workspacePathOf(sessionId);
							apiSettings()?.mutate?.({
								ns: "model-arena",
								ops: [
									{ op: "set", path: ["arena", "mainSessionId"], value: sessionId },
									{ op: "set", path: ["arena", "cwd"], value: typeof arenaCwd === "string" ? arenaCwd : "" }
								]
							}).catch(() => {});
						}
						updateBlock(sessionId, state);
						// The challenger session now exists: sync the persona map right away
						// (main role + challenger role) instead of waiting for the next sync.
						syncPersona();
						arenaTick.bump();
						// Persist the baseline immediately so a reload right after the
						// first question resumes the duel instead of restarting it.
						persistChallenge(sessionId);
					}).catch((error) => {
						if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
						arenaMount.error = String(error?.message ?? error);
						arenaMount.failedText = text;
						arenaTick.bump();
					});
				};

				// Stop the whole challenge from the MAIN session: cancels the
				// challenger (the user cannot see the arena session, so stopping here
				// must stop it too), unlocks the composer and ends the flow.
				const abortChallenge = () => {
					if (arenaMount === null || arenaMount.challenge.active !== true) return;
					const c = arenaMount.challenge;
					// Stop BOTH sessions like the native stop button would: the main
					// session's current generation and the challenger's.
					try {
						ctx.sessions.binding(arenaMount.sessionId)?.session?.cancel?.().catch(() => {});
					} catch (_mainCancelFailure) {
						// best effort — the flow still ends
					}
					if (arenaMount.arenaSessionId !== void 0) {
						try {
							ctx.sessions.binding(arenaMount.arenaSessionId)?.session?.cancel?.().catch(() => {});
						} catch (_cancelFailure) {
							// best effort — the flow still ends
						}
					}
					c.active = false;
					c.phase = "aborted";
					// Stop the node half's propose.completed polling for this challenge.
					if (isReviewScene(c)) stopArenaWatch();
					updateBlock(arenaMount.sessionId, stateFor(arenaMount.sessionId));
					arenaTick.bump();
					// Persist the terminal state so a reload does NOT resurrect the
					// aborted duel (alignChallengeAfterRestore leaves non-running
					// phases alone, and the Theseus bridge is not re-armed).
					persistChallenge(arenaMount.sessionId);
				};

				// Round driver: watches both sessions' snapshots and advances either the
				// original challenge flow (question -> revise -> verdict) or the
				// review loop, depending on the scene. Bound to both subscriptions;
				// no-op while the challenge is idle/done.
				const advanceChallenge = (c, mainId, arenaId) => {
					if (c.phase === "answer" || c.phase === "revise") {
						if (c.pendingAnchor) {
							// Re-anchor to the INJECTED message node, not the newest
							// node: after a session-switch catch-up the newest node
							// may already be the finished revise turn, which would
							// make the turn check below miss it. Fall through so a
							// turn that completed while the runtime was unmounted is
							// advanced in this same pass.
							const cur = injectedNodeKey(mainId, c.lastInjectedText) ?? lastKeyOfSnapshot(mainId);
							if (cur !== null && cur !== c.mainAnchor) {
								c.mainAnchor = cur;
								c.pendingAnchor = false;
							} else {
								return; // the injected message has not landed yet
							}
						}
						const snap = ctx.sessions.binding(mainId)?.session?.getSnapshot?.();
						const running = snap?.running === true;
						// User pressed stop: the main session went idle without producing a
						// new node — end the whole challenge (and cancel the challenger).
						// A pending question/approval wait is NOT a stop: the agent is
						// paused for the user's answer, so never abort on it.
						const stalled = !running && !turnCompleted(snap, c.mainAnchor) && !hasPendingInteraction(snap);
						if (stalled && (c.mainWasRunning || (c.stallSince !== 0 && Date.now() - c.stallSince > STALL_MS))) {
							abortChallenge();
							return;
						}
						// Stalled-start watchdog: the awaited session was never seen
						// running and stays idle with zero progress (a prompt that failed
						// silently can never advance the round) — arm the timer so the
						// check above ends the challenge instead of hanging forever.
						if (stalled) {
							if (c.stallSince === 0) c.stallSince = Date.now();
						} else {
							c.stallSince = 0;
						}
						c.mainWasRunning = running;
						if (turnCompleted(snap, c.mainAnchor)) {
							c.mainAnchor = lastKeyOfSnapshot(mainId);
							c.lastMainText = extractLastAssistantText(mainId);
							c.lastMainTools = extractLastAssistantTools(mainId);
							if (c.phase === "answer") {
								c.phase = "challenge";
								c.round += 1;
								c.lastPromptSent = "challenge";
								promptSession(arenaId, buildRoundPrompt("challenge", c, t));
								updateBlock(mainId, stateFor(mainId));
								syncPersona();
							} else {
								c.phase = "final";
								c.round += 1;
								c.lastPromptSent = "final";
								updateBlock(mainId, stateFor(mainId));
								arenaTick.bump();
								syncPersona();
								promptSession(arenaId, buildRoundPrompt("final", c, t));
							}
							persistChallenge(mainId);
						}
					} else if (c.phase === "challenge" || c.phase === "final") {
						const snap = ctx.sessions.binding(arenaId)?.session?.getSnapshot?.();
						const running = snap?.running === true;
						// The challenger went idle without producing output (stopped or
						// failed) — end the challenge so the flow never hangs. A pending
						// question/approval wait is the challenger pausing for the user,
						// not a stop — never abort on it.
						const stalled = !running && !turnCompleted(snap, c.arenaAnchor) && !hasPendingInteraction(snap);
						if (stalled && (c.arenaWasRunning || (c.stallSince !== 0 && Date.now() - c.stallSince > STALL_MS))) {
							abortChallenge();
							return;
						}
						// Stalled-start watchdog (see the main-waiting branch): arm the
						// timer when the arena was never seen running and stays idle.
						if (stalled) {
							if (c.stallSince === 0) c.stallSince = Date.now();
						} else {
							c.stallSince = 0;
						}
						c.arenaWasRunning = running;
						if (turnCompleted(snap, c.arenaAnchor)) {
							c.arenaAnchor = lastKeyOfSnapshot(arenaId);
							c.lastArenaText = extractLastAssistantText(arenaId);
							if (c.phase === "challenge") {
								c.phase = "revise";
								const injected = buildReviseMessage(c.lastArenaText, c, t);
								promptSession(mainId, injected);
								c.lastInjectedText = injected;
								c.pendingAnchor = true;
								updateBlock(mainId, stateFor(mainId));
								arenaTick.bump();
							} else {
								c.phase = "done";
								c.active = false;
								promptSession(mainId, stripMarkdown(c.lastArenaText));
								c.lastInjectedText = stripMarkdown(c.lastArenaText);
								updateBlock(mainId, stateFor(mainId));
								arenaTick.bump();
							}
							persistChallenge(mainId);
						}
					}
				};

				const advanceReview = (c, mainId, arenaId) => {
					try {
						if (c.phase === "propose" || c.phase === "revise") {
							// Knowledge scene: the main model runs Theseus workflow in
							// its own workspace (explore → propose → record
							// propose.completed). We do NOT advance on main-session turn
							// completion — the node half observes the workflow's
							// `propose.completed` transition and writes
							// `arena.reviewRequest`, which we consume here to hand the
							// proposal over to the challenger.
							const req = latestReviewRequest;
							if (req !== null && req.seq !== c.lastReviewSeq) {
								c.lastReviewSeq = req.seq;
								c.proposalPath = typeof req.proposalPath === "string" ? req.proposalPath : "";
								c.designPath = typeof req.designPath === "string" ? req.designPath : "";
								c.tasksPath = typeof req.tasksPath === "string" ? req.tasksPath : "";
								c.reviewPath = typeof req.reviewPath === "string" ? req.reviewPath : "";
								c.phase = "review";
								c.round += 1;
								c.lastPromptSent = "review";
								promptSession(arenaId, buildRoundPrompt("review", c, t));
								updateBlock(mainId, stateFor(mainId));
								syncPersona();
								arenaTick.bump();
								persistChallenge(mainId);
								// Clear the persisted reviewRequest after consuming it:
								// the value is GLOBAL (settings.arena.reviewRequest), so
								// a stale one left behind would be re-consumed by a
								// DIFFERENT session's restored propose phase (skipping
								// propose straight to review — the "propose 刷新恢复基线"
								// phase=review bug seen in tests). The node half
								// re-writes it on the next propose.completed (its seq
								// tracking is history-length based), so clearing is safe.
								latestReviewRequest = null;
								try {
									apiSettings()?.mutate?.({
										ns: "model-arena",
										ops: [{ op: "set", path: ["arena", "reviewRequest"], value: null }]
									}).catch(() => {});
								} catch {
									// best effort
								}
								return;
							}
							// Stop/stall watchdog — Theseus-driven, so the "stop" and
							// "stall" signals both have to be read against the workflow
							// heartbeat, not the chat turn alone:
							//   • user stop = running→idle with no new chat node AND the
							//     Theseus stage is still pre-review (propose did NOT just
							//     complete) → abort now (cancel the challenger).
							//   • Theseus at `review` = propose.completed, reviewRequest is
							//     on its way → never treat as a stop.
							//   • stall = idle with no progress (no heartbeat, or a
							//     pre-review stage that stopped advancing) for STALL_MS.
							const snap = ctx.sessions.binding(mainId)?.session?.getSnapshot?.();
							const running = snap?.running === true;
							const hasNewNode = turnCompleted(snap, c.mainAnchor);
							const idle = !running && !hasPendingInteraction(snap);
							if (idle) {
								if (c.stallSince === 0) c.stallSince = Date.now();
							} else {
								c.stallSince = 0;
							}
							const proposeDone = latestWatch !== null && latestWatch.stage === "review";
							if (idle && !hasNewNode && c.mainWasRunning && !proposeDone) {
								abortChallenge();
								return;
							}
							// "Genuinely stuck" = the MAIN SESSION has been idle for
							// STALL_MS while Theseus is still pre-review. Deliberately
							// keyed on the session's own idle duration (stallSince), not
							// on watch.at: a single Theseus step can take a long time
							// (the model "thinks through two branches"), so the last
							// progress timestamp can be old while the model is merely
							// busy — only a sustained idle means it actually stopped.
							const theseusStalled = idle && !proposeDone && c.stallSince !== 0 && Date.now() - c.stallSince > STALL_MS;
							if (theseusStalled) {
								abortChallenge();
								return;
							}
							c.mainWasRunning = running;
							// A completed main turn only re-anchors the stop detector; it
							// does NOT advance the flow (advancement is reviewRequest-driven).
							if (hasNewNode) {
								c.mainAnchor = lastKeyOfSnapshot(mainId);
								c.lastMainText = extractLastAssistantText(mainId);
								c.lastMainTools = extractLastAssistantTools(mainId);
							}
						} else if (c.phase === "review") {
							// Waiting on the ARENA session (challenger review verdict).
							const snap = ctx.sessions.binding(arenaId)?.session?.getSnapshot?.();
							// The challenger went idle without producing output (stopped or failed)
							// — end the challenge so the flow never hangs. A pending
							// question/approval wait is the challenger pausing for the user,
							// not a stop — never abort on it.
							const running = snap?.running === true;
							const stalled = !running && !turnCompleted(snap, c.arenaAnchor) && !hasPendingInteraction(snap);
							if (stalled && (c.arenaWasRunning || (c.stallSince !== 0 && Date.now() - c.stallSince > STALL_MS))) {
								abortChallenge();
								return;
							}
							// Stalled-start watchdog (see advanceChallenge): arm the timer
							// when the awaited session was never seen running and stays idle.
							if (stalled) {
								if (c.stallSince === 0) c.stallSince = Date.now();
							} else {
								c.stallSince = 0;
							}
							c.arenaWasRunning = running;
							if (turnCompleted(snap, c.arenaAnchor)) {
								c.arenaAnchor = lastKeyOfSnapshot(arenaId);
								c.lastArenaText = extractLastAssistantText(arenaId);
								const verdict = parseReviewVerdict(c.lastArenaText);
								c.verdict = verdict === "" ? "NEEDS_REVISION" : verdict;
								if (verdict === "READY") {
									// 认可 → 结束审查循环；主模型自己 record review.completed
									// READY 并按 Theseus workflow 继续后续阶段，本插件放手。
									c.phase = "done";
									c.active = false;
									const readyNote = "挑战者审查结论：READY（认可）。请 record review.completed READY 并按 Theseus workflow 继续后续阶段（user-readiness-review → apply → archive）。";
									promptSession(mainId, readyNote);
									c.lastInjectedText = readyNote;
									stopArenaWatch();
									markReviewDone(mainId);
									updateBlock(mainId, stateFor(mainId));
									arenaTick.bump();
									persistChallenge(mainId);
								} else {
									// 不认可 → 主模型修正；累计 3 次不认可后结束审查循环。
									c.rejectCount += 1;
									if (c.rejectCount >= MAX_REJECTS) {
										c.phase = "done";
										c.active = false;
										latestReviewRequest = null;
										markReviewDone(mainId);
										// Ask the node half to write the Theseus state machine back
										// to `propose` (review.completed NEEDS_REVISION) WITHOUT
										// messaging the main model — messaging it would start a
										// fresh turn and defeat "park for the human".
										apiSettings()?.mutate?.({
											ns: "model-arena",
											ops: [{ op: "set", path: ["arena", "returnToPropose"], value: { seq: Date.now() } }]
										}).catch(() => {});
										updateBlock(mainId, stateFor(mainId));
										arenaTick.bump();
										persistChallenge(mainId);
									} else {
										c.phase = "revise";
										const injected = buildReviseMessage(c.lastArenaText, c, t);
										promptSession(mainId, injected);
										c.lastInjectedText = injected;
										updateBlock(mainId, stateFor(mainId));
										arenaTick.bump();
										persistChallenge(mainId);
									}
								}
							}
						}
					} catch (_challengeFailure) {
						// orchestration must never break the session subscriptions
					}
				};

				const detectChallengeTurn = () => {
					if (arenaMount === null || arenaMount.challenge.active !== true) return;
					const c = arenaMount.challenge;
					const mainId = arenaMount.sessionId;
					const arenaId = arenaMount.arenaSessionId;
					if (arenaId === void 0) return;
					try {
						if (isReviewScene(c)) advanceReview(c, mainId, arenaId);
						else advanceChallenge(c, mainId, arenaId);
					} catch (_challengeFailure) {
						// orchestration must never break the session subscriptions
					}
				};

				// First-question detector (main session subscription): starts a new
				// challenge round; the composer lock prevents user messages while a
				// flow is running, and injected challenger messages (user nodes too)
				// arrive after the round started so they never re-trigger.
				const detectUserMessages = (sessionId, state) => {
					if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
					// Re-seed from a late-arriving snapshot: when the mount scanned an
					// empty snapshot (lastSeenSeq === 0) but this session was already
					// linked to an arena session (a previous round ran), the historical
					// user nodes that arrive after mount must be consumed as pre-existing.
					// Otherwise re-entering a finished round (esp. the repeatable
					// business scene) resurrects the header at the first step just
					// because the conversation history finished loading asynchronously.
					if (arenaMount.challenge.active !== true && arenaMount.lastSeenSeq === 0 && linksCache[sessionId] !== void 0) {
						arenaMount.lastSeenSeq = scanUserAnchorSeq(sessionId);
					}
					let snap;
					try {
						snap = ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
					} catch {
						return;
					}
					let lastSeen = arenaMount.lastSeenSeq;
					for (const key of orderOf(snap)) {
						const node = nodeOf(snap, key);
						if (node === void 0) continue;
						if (isUserNode(node) && anchorSeqOf(node) > lastSeen) {
							lastSeen = anchorSeqOf(node);
							const text = textOfContent(contentOf(node));
							if (text === "") continue;
							// Orchestrator-injected user messages (challenger output, revise
							// instruction, final verdict) must never start a new round.
							if (text === arenaMount.challenge.lastInjectedText) continue;
							if (arenaMount.challenge.active !== true) {
								// First question of a round starts it; the injected challenger
								// messages are user nodes too but arrive after the round began.
								// The review scene is one-shot: once done, do NOT re-arm (the
								// challenger stays dormant — see shouldReArmChallenge).
								if (shouldReArmChallenge(arenaMount.challenge, linksCache[sessionId], latestWatch)) {
									startChallenge(sessionId, state, text);
								}
							}
						}
					}
					arenaMount.lastSeenSeq = lastSeen;
				};

				const teardownArena = () => {
					if (arenaMount === null) return;
					arenaMount.unsubMain?.();
					arenaMount.unsubArena?.();
					arenaMount.unsubArenaTurn?.();
					arenaMount.resizeObs?.disconnect?.();
					arenaMount.scrollUnsub?.();
					for (const [, rec] of arenaNodeEls) unmountContainerRoots(rec.el);
					arenaNodeEls.clear();
					unmountMdRoots();
					// Keep the challenge state alive across session switches: stash it on
					// the per-session state so returning restores the flow (and header).
					const st = stateBySession.get(arenaMount.sessionId);
					if (st !== void 0) st.challenge = arenaMount.challenge;
					arenaMount = null;
					arenaTick.bump();
				};

				// Highest user/steering anchorSeq already in the session (seed for
				// the mirror scanner so re-entry never re-sends history).
				const scanUserAnchorSeq = (sessionId) => {
					let snap;
					try {
						snap = ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
					} catch {
						return 0;
					}
					let max = 0;
					for (const key of orderOf(snap)) {
						const node = nodeOf(snap, key);
						if (node === void 0) continue;
						if (isUserNode(node)) {
							max = Math.max(max, anchorSeqOf(node));
						}
					}
					return max;
				};

				// ── arena linkage persistence (settings "model-arena" namespace) ──
				let linksCache = {};
				// Persisted challenge orchestration state per main session
				// (phase/anchors/counters projection written by persistChallenge).
				// Restored on reload to resume an interrupted duel from its last
				// point instead of restarting a fresh round.
				let challengesCache = {};
				// Background-advance switch (persisted in settings, default OFF).
				// When ON, an arena duel whose MAIN session is not the currently
				// selected one still advances in the background (challenger reply →
				// injected into the main session; finished main turn → challenger
				// prompted), driven by the persisted challenge baseline + live
				// session snapshots. When OFF, background duels only advance on
				// return to the main session (v7 catch-up).
				let backgroundAdvance = false;
				// Temperature settings snapshot (persisted in the same namespace):
				// { enabled, business: {main, challenger}, knowledge: {...}, qa: {...} }.
				// Absent per-scene×role values mean "use dsh default". UI-only for now —
				// the agent/request injection consuming these values is a follow-up task.
				let temperatureSettings = { enabled: false, business: {}, knowledge: {}, qa: {} };
				// The session the node half is currently polling for
				// propose.completed (settings.arena.mainSessionId). The
				// reviewRequest it writes belongs to THAT session only — the
				// background advance must not consume it for another session.
				let arenaWatchMainSessionId = "";
				// Per-workspace × per-scene challenger skill
				// (workspace path -> scene -> skill path). Persisted in the same
				// namespace; a new session in the same workspace defaults to its
				// scene's entry (empty = no skill).
				let workspaceSkillsCache = {};
				// True once `loadLinks` has completed its first read: the seed must
				// wait for the persisted skills to arrive, otherwise the first
				// synchronous `sync()` seeds `state.skill` from an empty cache and
				// the persisted skill is never shown.
				let skillsLoaded = false;
				// True while a local skill write (save/clear) is in flight. The
				// write already updated `workspaceSkillsCache` synchronously, so a
				// `document-updated` round-trip that reads a still-stale descriptor
				// must not clobber it.
				let skillWriteInFlight = false;
				// Latest `arena.reviewRequest` written by the node half when it
				// observes the main model's `propose.completed`. Consumed by
				// advanceReview to hand the proposal to the challenger.
				let latestReviewRequest = null;
				// Latest `arena.watch` progress heartbeat from the node half
				// (seq/stage/at). Used by advanceReview's watchdog to distinguish
				// "Theseus still advancing" from "genuinely stuck".
				let latestWatch = null;
				// Timestamp of the last catch-up re-read of the arena bridge, so a
				// network drop that missed the `document-updated` push can recover
				// without hammering the settings describe endpoint every sync tick.
				let lastLinksRefresh = 0;
				const workspacePathOf = (sessionId) => {
					try {
						const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
						const items = Array.isArray(workspaces?.list?.getSnapshot?.()?.items) ? workspaces.list.getSnapshot().items : [];
						const ws = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId));
						if (ws !== void 0 && typeof ws.path === "string" && ws.path !== "") return ws.path;
						const summaryCwd = ctx.sessions.list.getSnapshot()?.byId?.[sessionId]?.cwd;
						if (typeof summaryCwd === "string" && summaryCwd !== "") return summaryCwd;
						return void 0;
					} catch {
						return void 0;
					}
				};
				const saveWorkspaceSkill = (sessionId, scene, skill) => {
					const ws = workspacePathOf(sessionId);
					const sceneKey = typeof scene === "string" && scene !== "" ? scene : "business";
					const cleaned = typeof skill === "string" ? skill : "";
					if (ws !== void 0) {
						// Build a fresh entry (never mutate the frozen/cached object the
						// snapshot may have handed out) and keep the in-memory cache
						// authoritative while the persist round-trip is in flight.
						const prev = workspaceSkillsCache[ws];
						const entry = { ...(prev !== null && typeof prev === "object" && !Array.isArray(prev) ? prev : {}), [sceneKey]: cleaned };
						workspaceSkillsCache[ws] = entry;
						skillWriteInFlight = true;
						try {
							apiSettings()?.mutate?.({
								ns: "model-arena",
								ops: [{ op: "set", path: ["workspaceSkills", ws], value: entry }]
							}).then(() => {
								skillWriteInFlight = false;
							}).catch(() => {
								skillWriteInFlight = false;
							});
						} catch {
							skillWriteInFlight = false;
							// persistence failed — the in-memory cache still applies
						}
					}
				};
				const apiSettings = () => {
					try {
						const connection = typeof ctx.get === "function" ? ctx.get("connection") : void 0;
						return connection?.api?.settings ?? void 0;
					} catch {
						return void 0;
					}
				};
				const loadLinks = async () => {
					try {
						const response = await apiSettings()?.describe?.({});
						const namespaces = response?.result?.value?.namespaces ?? [];
						const view = namespaces.find((n) => n !== null && n !== void 0 && n.ns === "model-arena");
						linksCache = view?.value?.links ?? {};
						challengesCache = view?.value?.challenges ?? {};
						// A local skill write already updated `workspaceSkillsCache`
						// synchronously; skip the rebuild so a still-stale descriptor
						// cannot clobber it (the write's own settle re-reads later if
						// needed — the in-memory value is authoritative for now).
						if (!skillWriteInFlight) {
							const rawSkills = view?.value?.workspaceSkills ?? {};
							workspaceSkillsCache = {};
							if (rawSkills !== null && typeof rawSkills === "object") {
								for (const ws of Object.keys(rawSkills)) {
									const v = rawSkills[ws];
									if (typeof v === "string") {
										// legacy workspace-level entry (pre-scene) → default scene
										workspaceSkillsCache[ws] = { business: v };
									} else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
										workspaceSkillsCache[ws] = { ...v };
									}
								}
							}
						}
						const rawArena = view?.value?.arena;
						arenaWatchMainSessionId = typeof rawArena?.mainSessionId === "string" ? rawArena.mainSessionId : "";
						const req = rawArena?.reviewRequest;
						latestReviewRequest = (req !== null && typeof req === "object" && typeof req.seq === "number")
							? req
							: null;
						const w = rawArena?.watch;
						latestWatch = (w !== null && typeof w === "object" && typeof w.seq === "number" && typeof w.at === "number")
							? w
							: null;
						backgroundAdvance = view?.value?.backgroundAdvance === true;
						const rawTemperature = view?.value?.temperature;
						if (rawTemperature !== null && rawTemperature !== void 0 && typeof rawTemperature === "object") {
							temperatureSettings = {
								enabled: rawTemperature.enabled === true,
								business: rawTemperature.business ?? {},
								knowledge: rawTemperature.knowledge ?? {},
								qa: rawTemperature.qa ?? {}
							};
						} else {
							temperatureSettings = { enabled: false, business: {}, knowledge: {}, qa: {} };
						}
					} catch {
						linksCache = {};
						challengesCache = {};
						if (!skillWriteInFlight) workspaceSkillsCache = {};
					}
					// The persisted skills (if any) are now available: re-run the
					// seed for any session whose skill has not been seeded yet.
					skillsLoaded = true;
				};
				const saveLink = async (mainId, link) => {
					linksCache[mainId] = link;
					try {
						await apiSettings()?.mutate?.({
							ns: "model-arena",
							ops: [{ op: "set", path: ["links", mainId], value: link }]
						});
					} catch {
						// persistence failed — the in-memory cache still links this session
					}
				};
				// Persist the challenge orchestration state (phase/anchors/counters)
				// for a main session so an interrupted duel survives a reload/restart.
				// Written IMMEDIATELY (no debounce): a page reload right after the
				// first question — while the main model is already generating — used
				// to lose the baseline (the debounce timer died with the page, the
				// reload fell back to an idle challenge and the whole flow went
				// silent: reviewRequest arriving later is never consumed because
				// detectChallengeTurn only runs for active challenges). Callers are
				// round-granular (start + each phase transition), so the extra
				// round-trip is negligible; concurrent writes are last-write-wins
				// (each writes the current snapshot via a path-scoped settings set).
				// The in-memory `challengesCache` stays authoritative while the
				// round-trip is in flight; on failure the next transition (or the
				// loadLinks 2s catch-up re-read) re-syncs.
				const persistChallenge = (mainId, force) => {
					// Guard: normally only the CURRENT session's runtime may persist
					// its challenge. `force` lifts that for the background advance,
					// which persists OTHER sessions' duels from their snapshot-derived
					// challenge objects (there is no arenaMount for them).
					if (!force && (arenaMount === null || arenaMount.sessionId !== mainId)) return;
					const projected = toPersistedChallenge(force ? challengesCache[mainId] : arenaMount.challenge);
					if (projected === null) return;
					challengesCache[mainId] = projected;
					try {
						apiSettings()?.mutate?.({
							ns: "model-arena",
							ops: [{ op: "set", path: ["challenges", mainId], value: projected }]
						}).catch(() => {
							// best effort — the cache still holds the state; the next
							// persist or the loadLinks catch-up re-read re-syncs
						});
					} catch {
						// best effort
					}
				};
				// ── background advance (opt-in via settings.backgroundAdvance) ──
				// An arena duel whose MAIN session is NOT the current one has no
				// runtime (syncArena tears down on switch-away), so it normally only
				// advances on return (v7 catch-up). When the user enables background
				// advance, this walks every linked main session except the current
				// one and advances the duel from the PERSISTED challenge baseline +
				// live session snapshots: a finished main turn prompts the
				// challenger, a finished challenger reply is injected into the main
				// session, and a knowledge reviewRequest is consumed only when it
				// belongs to this session (settings.arena.mainSessionId). Watchdogs
				// and UI side effects are intentionally skipped — a stuck background
				// duel is handled by the normal catch-up/watchdog on return.
				const advanceBackgroundDuels = () => {
					if (!backgroundAdvance) return;
					const current = currentSessionId();
					for (const sessionId of Object.keys(linksCache)) {
						if (sessionId === current) continue;
						try {
							const persisted = challengesCache[sessionId];
							if (persisted === null || persisted === void 0 || typeof persisted !== "object") continue;
							if (!isResumableChallenge(persisted)) continue;
							const link = linksCache[sessionId];
							const arenaId = typeof link?.sessionId === "string" ? link.sessionId : "";
							if (arenaId === "") continue;
							const c = fromPersistedChallenge(persisted);
							const mainSnap = (() => {
								try {
									return ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
								} catch {
									return void 0;
								}
							})();
							const arenaSnap = (() => {
								try {
									return ctx.sessions.binding(arenaId)?.session?.getSnapshot?.();
								} catch {
									return void 0;
								}
							})();
							let advanced = false;
							if (isMainModelPhase(c.phase)) {
								if (isReviewScene(c)) {
									// knowledge: propose/revise advance on the node
									// half's reviewRequest (only for the session it
									// polls); consume + prompt the challenger review.
									const req = latestReviewRequest;
									if (req !== null && typeof req.seq === "number" && req.seq !== c.lastReviewSeq && arenaWatchMainSessionId === sessionId) {
										c.lastReviewSeq = req.seq;
										c.proposalPath = typeof req.proposalPath === "string" ? req.proposalPath : "";
										c.designPath = typeof req.designPath === "string" ? req.designPath : "";
										c.tasksPath = typeof req.tasksPath === "string" ? req.tasksPath : "";
										c.reviewPath = typeof req.reviewPath === "string" ? req.reviewPath : "";
										c.phase = "review";
										c.round += 1;
										c.lastPromptSent = "review";
										promptSession(arenaId, buildRoundPrompt("review", c, t));
										latestReviewRequest = null;
										try {
											apiSettings()?.mutate?.({
												ns: "model-arena",
												ops: [{ op: "set", path: ["arena", "reviewRequest"], value: null }]
											}).catch(() => {});
										} catch {
											// best effort
										}
										advanced = true;
									}
								} else if (turnCompletedSince(mainSnap, c.mainAnchor)) {
									// business/qa: a finished main turn prompts the
									// challenger (answer→challenge, revise→final).
									c.mainAnchor = lastKeyOfSnapshot(sessionId);
									c.lastMainText = extractLastAssistantText(sessionId);
									c.lastMainTools = extractLastAssistantTools(sessionId);
									if (c.phase === "answer") {
										c.phase = "challenge";
										c.round += 1;
										c.lastPromptSent = "challenge";
										promptSession(arenaId, buildRoundPrompt("challenge", c, t));
									} else {
										c.phase = "final";
										c.round += 1;
										c.lastPromptSent = "final";
										promptSession(arenaId, buildRoundPrompt("final", c, t));
									}
									advanced = true;
								}
							} else if (isChallengerPhase(c.phase) && turnCompletedSince(arenaSnap, c.arenaAnchor)) {
								// a finished challenger reply is injected into the
								// main session and the round advances.
								c.arenaAnchor = lastKeyOfSnapshot(arenaId);
								c.lastArenaText = extractLastAssistantText(arenaId);
								if (isReviewScene(c)) {
									const verdict = parseReviewVerdict(c.lastArenaText);
									c.verdict = verdict === "" ? "NEEDS_REVISION" : verdict;
									if (verdict === "READY") {
										c.phase = "done";
										c.active = false;
										const readyNote = "挑战者审查结论：READY（认可）。请 record review.completed READY 并按 Theseus workflow 继续后续阶段（user-readiness-review → apply → archive）。";
										promptSession(sessionId, readyNote);
										c.lastInjectedText = readyNote;
										markReviewDone(sessionId);
									} else {
										c.rejectCount += 1;
										if (c.rejectCount >= MAX_REJECTS) {
											c.phase = "done";
											c.active = false;
											markReviewDone(sessionId);
											apiSettings()?.mutate?.({
												ns: "model-arena",
												ops: [{ op: "set", path: ["arena", "returnToPropose"], value: { seq: Date.now() } }]
											}).catch(() => {});
										} else {
											c.phase = "revise";
											const injected = buildReviseMessage(c.lastArenaText, c, t);
											promptSession(sessionId, injected);
											c.lastInjectedText = injected;
										}
									}
								} else if (c.phase === "challenge") {
									c.phase = "revise";
									const injected = buildReviseMessage(c.lastArenaText, c, t);
									promptSession(sessionId, injected);
									c.lastInjectedText = injected;
									c.pendingAnchor = true;
								} else {
									// final → done
									c.phase = "done";
									c.active = false;
									const fin = stripMarkdown(c.lastArenaText);
									promptSession(sessionId, fin);
									c.lastInjectedText = fin;
								}
								advanced = true;
							}
							if (advanced) {
								challengesCache[sessionId] = toPersistedChallenge(c);
								persistChallenge(sessionId, true);
								// Keep the in-memory per-session challenge in sync: the
								// background advance mutated the PERSISTED projection, but
								// `stateBySession[sessionId].challenge` (stashed by
								// teardownArena on switch-away) still holds the pre-switch
								// phase. Without this, returning to the session re-mounts the
								// stale phase (e.g. revise) and advanceChallenge re-advances
								// revise→final, sending the challenger a SECOND final-verdict
								// prompt — the duplicate-final (revise-final-revise-final)
								// defect. Replace the stashed challenge with the advanced one
								// so a return resumes from the advanced phase.
								const st = stateBySession.get(sessionId);
								if (st !== void 0) st.challenge = c;
							}
						} catch (_backgroundAdvanceFailure) {
							// per-session best effort — retry on the next tick
						}
					}
				};
				// Resume an interrupted challenge from its persisted state: reuses the
				// restored arena session (never recreates it), re-locks the composer,
				// re-arms the Theseus bridge for the knowledge scene, keeps the
				// original question/round/anchors/counters (the incoming `text` is
				// only the user's wake-up signal — the main model gets it through the
				// platform's normal message channel, not from this plugin), then
				// catch-up once so a turn that finished server-side advances now.
				// Runs ONLY for challenges restored from persistence (c.restored ===
				// true) and only until the first re-alignment completes (c.alignDone):
				// fresh rounds are driven by advanceChallenge/advanceReview alone, so
				// this never double-injects a round prompt into a running flow.
				const alignChallengeAfterRestore = (sessionId, state) => {
					if (arenaMount === null || arenaMount.sessionId !== sessionId) return;
					const c = arenaMount.challenge;
					if (c.restored !== true || c.alignDone === true) return;
					const arenaId = arenaMount.arenaSessionId;
					if (!RUNNING_CHALLENGE_PHASES.has(c.phase)) {
						c.alignDone = true;
						return;
					}
					if (isMainModelPhase(c.phase)) {
						// Main-model phase: running or already-completed turns proceed
						// automatically (the lock applies and detectChallengeTurn
						// advances); a genuinely idle session waits for the user's
						// "continue" message — updateBlock lifts the lock for it. A
						// not-yet-loaded snapshot (async history after reload) is left
						// alone: the next sync re-runs this until the snapshot lands.
						const mainSnap = (() => {
							try {
								return ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
							} catch {
								return void 0;
							}
						})();
						if (mainSnap === void 0 || mainSnap === null) return;
						const action = resolveMainResume(mainSnap, c);
						if (action === "running" || action === "completed") {
							c.active = true;
							updateBlock(sessionId, state);
							detectChallengeTurn();
						}
						c.alignDone = true;
						return;
					}
					if (isChallengerPhase(c.phase)) {
						c.active = true;
						const arenaSnap = (() => {
							try {
								return arenaId === void 0 ? void 0 : ctx.sessions.binding(arenaId)?.session?.getSnapshot?.();
							} catch {
								return void 0;
							}
						})();
						if (arenaSnap === void 0 || arenaSnap === null) return;
						const action = resolveChallengerResume(arenaSnap, c);
						if (action === "running" || action === "completed") {
							updateBlock(sessionId, state);
							detectChallengeTurn();
							c.alignDone = true;
							return;
						}
						// Genuinely stalled: re-inject the round prompt so the
						// challenger executes it now ("切到竞技场会话时立即
						// review/终审"). Injected once per restore (challengerRePrompted
						// is a run-time flag, reset by fromPersistedChallenge) so a
						// failed prompt is retried without infinitely duplicating the
						// round instruction on every sync tick. BUT: when the SAME
						// round prompt was already sent in a previous run (persisted
						// lastPromptSent === this round's kind), the arena session has
						// it queued server-side — re-injecting hands the challenger a
						// duplicate instruction and produces a SECOND verdict
						// (the revise-final-revise-final / duplicate-final defect).
						// Skip the re-inject; a genuinely stuck challenger is still
						// caught by the STALL_MS watchdog.
						updateBlock(sessionId, state);
						if (!c.challengerRePrompted) {
							c.challengerRePrompted = true;
							const kind = c.phase === "final" ? "final" : c.phase === "review" ? "review" : "challenge";
							if (c.lastPromptSent !== kind) {
								promptSession(arenaId, buildRoundPrompt(kind, c, t));
								c.lastPromptSent = kind;
								// Persist the re-send so a SECOND reload does not
								// re-inject the same round prompt again.
								persistChallenge(sessionId);
							}
						}
						detectChallengeTurn();
						c.alignDone = true;
					}
				};
				// Persist the review loop's terminal state onto the link so a page
				// reload (which drops the in-memory `phase === "done"`) still blocks
				// re-arming the challenger for this session. `done` only ever means
				// "the knowledge review loop concluded", so it is never set for the
				// business/qa challenge flow.
				const markReviewDone = (mainId) => {
					const link = linksCache[mainId];
					if (link !== null && typeof link === "object" && !Array.isArray(link)) {
						saveLink(mainId, { ...link, done: true });
					}
				};
				// Stop the node half's propose.completed polling by clearing the
				// watched main session id (and the stale review request). Called when
				// the review loop ends (READY, 3 rejections) or the challenge aborts.
				const stopArenaWatch = () => {
					latestReviewRequest = null;
					latestWatch = null;
					try {
						apiSettings()?.mutate?.({
							ns: "model-arena",
							ops: [
								{ op: "set", path: ["arena", "mainSessionId"], value: "" },
								{ op: "set", path: ["arena", "reviewRequest"], value: null }
							]
						}).catch(() => {});
					} catch {
						// best effort
					}
				};

				// Infer a mid-flight challenge baseline from the LIVE snapshots when
				// the persisted baseline is missing. A reload right after the first
				// question can lose the write (the old debounced timer died with the
				// page; a session created milliseconds before the reload never
				// persisted at all), and pre-v20 runs never persisted challenges.
				// Without this the reload falls back to an idle challenge and the
				// whole flow goes silent: reviewRequest arrives later but is never
				// consumed because detectChallengeTurn only runs for active
				// challenges. Only sessions that HAVE an arena link AND a first user
				// question are inferred, and only when no done signal blocks
				// re-arming (v18/v19 semantics: concluded loops stay dormant).
				const inferRestoredChallenge = (sessionId, state) => {
					const link = linksCache[sessionId];
					if (link === void 0 || typeof link.sessionId !== "string" || link.sessionId === "") return null;
					// done signals block inference
					if (link.done === true) return null;
					if (latestWatch !== null && isPastReviewStage(latestWatch.stage)) return null;
					const snap = (() => {
						try {
							return ctx.sessions.binding(sessionId)?.session?.getSnapshot?.();
						} catch {
							return void 0;
						}
					})();
					if (snap === void 0 || snap === null) return null; // snapshot not ready — retry next sync
					// a first user question must exist (the duel actually started)
					let question = "";
					for (const key of orderOf(snap)) {
						const node = nodeOf(snap, key);
						if (node === void 0) continue;
						if (isUserNode(node)) {
							const text = textOfContent(contentOf(node));
							if (text !== "") {
								question = text;
								break;
							}
						}
					}
					if (question === "") return null; // no first question → not started
					const scene = state?.scene ?? link.scene ?? "business";
					return {
						active: true,
						phase: (SCENES[scene] ?? SCENES.business).review === true ? "propose" : "answer",
						scene,
						skill: typeof state?.skill === "string" ? state.skill : "",
						userQuestion: question,
						mainAnchor: lastKeyOfSnapshot(sessionId),
						arenaAnchor: (() => {
							try {
								return lastKeyOfSnapshot(link.sessionId);
							} catch {
								return null;
							}
						})(),
						rejectCount: 0,
						verdict: "",
						round: 0,
						pendingAnchor: false,
						lastPromptSent: "",
						lastInjectedText: "",
						lastReviewSeq: -1,
						proposalPath: "",
						designPath: "",
						tasksPath: "",
						reviewPath: "",
						// run-time fields
						mainWasRunning: false,
						arenaWasRunning: false,
						stallSince: 0,
						challengerRePrompted: false,
						restored: true,
						alignDone: false
					};
				};

				const syncArena = (sessionId) => {
					if (sessionId === void 0) {
						teardownArena();
						return;
					}
					let state = stateBySession.get(sessionId);
					const link = linksCache[sessionId];
					if (link !== void 0 && (state === void 0 || !(state.enabled && state.model))) {
						// Restored linkage: this session's arena session already
						// exists (created in a previous run); resume mirroring.
						state = stateFor(sessionId);
						state.enabled = true;
						state.model = {
							provider: link.provider,
							model: link.model,
							...(link.reasoningEffort === void 0 ? {} : { reasoningEffort: link.reasoningEffort }),
							...(link.name === void 0 ? {} : { name: link.name })
						};
						state.arena = { sessionId: link.sessionId };
						if (link.scene !== void 0) state.scene = link.scene;
						// Re-arm the node half's Theseus poll for a review-scene session
						// whose loop already concluded in an earlier run: the previous
						// `stopArenaWatch` cleared `mainSessionId`, leaving `watch.stage`
						// stale. Re-arming lets the node half re-read the workflow state
						// and report "past review" (apply/archive), which blocks
						// re-arming the challenger once the loop has already ended.
						// A persisted terminal challenge (done/aborted) must NOT re-arm
						// — otherwise an aborted review loop resurrects after reload.
						if (state.scene === "knowledge" && link.done !== true
							&& !isTerminalPhase(challengesCache[sessionId]?.phase)
							&& typeof link.sessionId === "string" && link.sessionId !== "") {
							apiSettings()?.mutate?.({
								ns: "model-arena",
								ops: [
									{ op: "set", path: ["arena", "mainSessionId"], value: sessionId },
									{ op: "set", path: ["arena", "cwd"], value: workspacePathOf(sessionId) ?? "" }
								]
							}).catch(() => {});
						}
					}
					// Seed the per-session challenger skill from the WORKSPACE × SCENE
					// historical entry once (undefined -> the workspace+scene default,
					// which may be "" = no skill). The user's own pick/clear afterwards
					// overrides it for this session AND updates that scene's default.
					if (state !== void 0 && skillsLoaded && state.skill === void 0) {
						const wsEntry = workspaceSkillsCache[workspacePathOf(sessionId) ?? ""];
						const seedScene = state.scene ?? "business";
						state.skill = (wsEntry !== null && typeof wsEntry === "object" && !Array.isArray(wsEntry) ? wsEntry[seedScene] : void 0) ?? "";
					}
					const active = state !== void 0 && state.enabled === true && state.model !== null && state.model !== void 0;
					if (!active) {
						teardownArena();
						return;
					}
					if (arenaMount !== null && arenaMount.sessionId === sessionId) {
						// Already mounted. A first sync that ran BEFORE the async
						// settings load (or before the session snapshot landed) may
						// have fallen back to an idle challenge — upgrade it to the
						// persisted baseline, or a baseline inferred from the live
						// snapshots, as soon as either becomes available, then
						// re-align. This closes the "reload right after the first
						// question" gap where the idle fallback would otherwise stay
						// forever and the flow would silently stall (challenge never
						// advances, reviewRequest never consumed).
						if (arenaMount.challenge.phase === "idle" && !arenaMount.challenge.restored) {
							const upgraded = fromPersistedChallenge(challengesCache[sessionId]) ?? inferRestoredChallenge(sessionId, state);
							if (upgraded !== null) {
								arenaMount.challenge = upgraded;
								updateBlock(sessionId, state);
								persistChallenge(sessionId);
								alignChallengeAfterRestore(sessionId, state);
							}
						}
						return;
					}
					teardownArena();
					let unsubMain = null;
					try {
						unsubMain = ctx.sessions.binding(sessionId)?.session?.subscribe?.(() => {
							detectUserMessages(sessionId, state);
							detectChallengeTurn();
						});
					} catch {
						unsubMain = null;
					}
					arenaMount = {
						sessionId,
						arenaSessionId: state.arena?.sessionId ?? void 0,
						unsubMain,
						unsubArena: null,
						unsubArenaTurn: null,
						paneBody: null,
						paneHead: null,
						paneFlow: null,
						interactionsHost: null,
						arenaAtBottom: true,
						scrollUnsub: null,
						resizeObs: null,
						creating: false,
						pending: [],
						lastSeenSeq: 0,
						error: null,
						questionDraft: null,
						// Restore the challenge orchestration state: the in-memory copy
						// first (session switch within this page), then the PERSISTED
						// projection (page reload / dsh restart — the baseline that
						// lets an interrupted duel resume from its last phase/anchors
						// instead of restarting a fresh round), then a baseline
						// INFERRED from the live snapshots (the persisted write can
						// be lost when the reload happens right after the first
						// question), then a fresh idle challenge. Re-alignment
						// against the live snapshots happens right below.
						challenge: state.challenge ?? fromPersistedChallenge(challengesCache[sessionId]) ?? inferRestoredChallenge(sessionId, state) ?? {
							active: false,
							phase: "idle",
							scene: state.scene ?? "business",
							skill: state.skill ?? "",
							userQuestion: "",
							mainAnchor: null,
							arenaAnchor: null,
							lastMainText: "",
							lastArenaText: "",
							rejectCount: 0,
							verdict: "",
							round: 0,
							pendingAnchor: false,
							lastPromptSent: "",
							lastInjectedText: "",
							mainWasRunning: false,
							arenaWasRunning: false,
							// Theseus review-loop bridge: the node half writes
							// arena.reviewRequest once the main model records
							// `propose.completed`; we consume its monotonic seq and
							// hand the artifact paths to the challenger.
							lastReviewSeq: -1,
							proposalPath: "",
							designPath: "",
							tasksPath: "",
							reviewPath: "",
							// ms timestamp when the awaited session first went idle
							// without progress; 0 = not stalled (see STALL_MS).
							stallSince: 0,
							// run-time flag: the restore alignment re-injected the
							// challenger round prompt once (see alignChallengeAfterRestore).
							challengerRePrompted: false,
							// run-time flags: this is NOT a restored challenge.
							restored: false,
							alignDone: false
						}
					};
					// Seed from the current snapshot so pre-existing messages are not re-mirrored.
					arenaMount.lastSeenSeq = scanUserAnchorSeq(sessionId);
					if (arenaMount.arenaSessionId !== void 0) {
						mountArenaRuntime(state);
						// Returning mid-challenge: re-apply the composer lock immediately.
						updateBlock(sessionId, state);
						// Restored linkage: listen for challenger turns on the arena session.
						// The wrapper also bumps arenaTick on EVERY arena-snapshot change
						// (including the running flag flipping idle→running), so the
						// ChallengeStatus header re-renders and can show the challenger
						// loading animation while the arena model is generating; the
						// sidebar loading dot is re-synced here too (the arena session's
						// snapshot change is the only prompt for its running flag).
						try {
							arenaMount.unsubArenaTurn = ctx.sessions.binding(arenaMount.arenaSessionId)?.session?.subscribe?.(() => {
								arenaTick.bump();
								syncChallengerLoading();
								detectChallengeTurn();
							}) ?? null;
						} catch {
							arenaMount.unsubArenaTurn = null;
						}
					}
					// Restore alignment: a persisted/restored in-flight challenge is
					// re-aligned against the LIVE snapshots — main-model phases wait
					// for the user's "continue" when genuinely idle (lock lifted in
					// updateBlock), challenger phases re-inject the round prompt so
					// the review/verdict executes immediately. Idempotent; also run
					// on every sync tick (see sync()) so a late-arriving snapshot
					// (async history load after mount) re-aligns correctly.
					alignChallengeAfterRestore(sessionId, state);
				};

				// ── menu rendering (two-level, mirroring the input box seat) ────
				const makeOption = (row) => {
					const option = document.createElement("button");
					option.type = "button";
					option.className = "ma-option";
					option.setAttribute("role", "menuitemradio");
					option.setAttribute("aria-checked", row.selected ? "true" : "false");
					const copy = document.createElement("span");
					copy.className = "ma-optionCopy";
					const name = document.createElement("span");
					name.className = "ma-optionName";
					name.textContent = row.name;
					copy.appendChild(name);
					if (row.description !== void 0) {
						const desc = document.createElement("span");
						desc.className = "ma-optionDesc";
						desc.textContent = row.description;
						copy.appendChild(desc);
					}
					option.appendChild(copy);
					if (row.selected) {
						const check = document.createElement("span");
						check.className = "ma-check";
						check.textContent = "✓";
						option.appendChild(check);
					}
					return option;
				};

				const renderMenu = (host, state, directory) => {
					host.textContent = "";
					const menu = document.createElement("div");
					menu.className = "ma-menu";
					menu.setAttribute("role", "menu");
					menu.setAttribute("aria-label", t("menu.aria"));
					const snap = directory === null ? null : directory.store.getSnapshot();
					const pane = mounted === null ? null : mounted.menuPane;
					const model = findArenaModel(snap, state.model);
					const efforts = model?.reasoning?.efforts ?? [];
					const effortLabel = model === void 0 || state.model === null || model.reasoning === void 0 ? null : state.model.reasoningEffort !== void 0
						? (efforts.find((level) => level.id === state.model.reasoningEffort)?.name ?? state.model.reasoningEffort)
						: (model.reasoning?.defaultEffort === void 0 ? t("effort.default") : efforts.find((level) => level.id === model.reasoning.defaultEffort)?.name ?? model.reasoning.defaultEffort);

					if (pane === "root" || pane === null) {
						const cell = (label, value, enabled, onPick) => {
							const b = document.createElement("button");
							b.type = "button";
							b.className = "ma-cell";
							b.disabled = !enabled;
							const l = document.createElement("span");
							l.className = "ma-cellLabel";
							l.textContent = label;
							const v = document.createElement("span");
							v.className = "ma-cellValue";
							v.textContent = value;
							const c = document.createElement("span");
							c.className = "ma-cellChevron";
							c.textContent = "›";
							b.append(l, v, c);
							b.addEventListener("click", onPick);
							return b;
						};
						menu.appendChild(cell(t("menu.model"), state.model === null ? t("model.placeholder") : model?.name ?? state.model.model, true, () => openMenu("model")));
						menu.appendChild(cell(t("menu.effort"), effortLabel === null ? t("effort.placeholder") : effortLabel, state.model !== null, () => openMenu("effort")));
					} else if (pane === "model") {
						const groups = buildModelOptions(snap, state.model);
						if (snap === null || snap.status === "loading" || snap.status === "idle") {
							const status = document.createElement("div");
							status.className = "ma-menuStatus";
							status.textContent = "…";
							menu.appendChild(status);
						} else if (snap.status === "error" || snap.status === "failed") {
							const err = document.createElement("div");
							err.className = "ma-menuError";
							const text = document.createElement("span");
							text.textContent = t("menu.error");
							const retry = document.createElement("button");
							retry.type = "button";
							retry.className = "ma-menuRetry";
							retry.textContent = t("menu.retry");
							retry.addEventListener("click", () => {
								directory?.load().catch(() => void 0);
							});
							err.append(text, retry);
							menu.appendChild(err);
						} else if (groups.length === 0) {
							const empty = document.createElement("div");
							empty.className = "ma-menuEmpty";
							empty.textContent = t("menu.empty");
							menu.appendChild(empty);
						} else {
							const list = document.createElement("div");
							list.className = "ma-groups";
							for (const group of groups) {
								const g = document.createElement("div");
								g.className = "ma-group";
								const title = document.createElement("div");
								title.className = "ma-groupTitle";
								title.textContent = group.name;
								g.appendChild(title);
								for (const row of group.models) {
									const option = makeOption(row);
									option.addEventListener("click", () => {
										state.model = {
											provider: row.provider,
											model: row.model,
											name: row.name,
											...(row.reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: row.reasoning.defaultEffort })
										};
										// Keep the popup open and advance to the effort
										// pane: the user picks the reasoning level in the
										// same interaction. Close only when the model
										// offers no effort choices at all.
										if (row.reasoning !== void 0 && buildEffortChoices(row.reasoning, t).length > 0) {
											openMenu("effort");
										} else {
											closeMenu();
										}
										repaint();
									});
									g.appendChild(option);
								}
								list.appendChild(g);
							}
							menu.appendChild(list);
						}
					} else if (pane === "effort") {
						const choices = buildEffortChoices(model?.reasoning, t);
						const effectiveEffort = state.model?.reasoningEffort ?? model?.reasoning?.defaultEffort;
						if (choices.length === 0) {
							const empty = document.createElement("div");
							empty.className = "ma-menuEmpty";
							empty.textContent = t("effort.none");
							menu.appendChild(empty);
						} else {
							const list = document.createElement("div");
							list.className = "ma-groups";
							for (const choice of choices) {
								const option = makeOption({ name: choice.label, description: choice.description, selected: effectiveEffort === choice.effort });
								option.addEventListener("click", () => {
									if (state.model === null) return;
									state.model = {
										...state.model,
										...(choice.effort === void 0 ? {} : { reasoningEffort: choice.effort })
									};
									closeMenu();
									repaint();
								});
								list.appendChild(option);
							}
							menu.appendChild(list);
						}
					}
					host.appendChild(menu);
				};

				// ── menu lifecycle (one open menu at a time) ────────────────────
				let menuHost = null;
				const onDocMouseDown = (event) => {
					if (menuHost !== null && menuHost.contains(event.target)) return;
					closeMenu();
				};
				const onDocKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					if (mounted !== null && mounted.menuPane !== null && mounted.menuPane !== "root") {
						openMenu("root");
					} else {
						closeMenu();
					}
				};
				const closeMenu = () => {
					if (mounted === null || mounted.menuPane === null) return;
					mounted.menuPane = null;
					if (menuHost !== null) menuHost.textContent = "";
					document.removeEventListener("mousedown", onDocMouseDown);
					document.removeEventListener("keydown", onDocKeyDown);
				};
				const openMenu = (pane) => {
					if (mounted === null) return;
					if (mounted.menuPane === pane) {
						closeMenu();
						return;
					}
					const wasClosed = mounted.menuPane === null;
					mounted.menuPane = pane;
					renderMenu(menuHost, mounted.state, mounted.directory);
					if (wasClosed) {
						document.addEventListener("mousedown", onDocMouseDown);
						document.addEventListener("keydown", onDocKeyDown);
					}
				};

				// ── the panel (visible when the toggle is on) ──────────────────
				// Composer gate: while the arena is on but no arena model is picked,
				// the session's composer is blocked (reason shown as the placeholder,
				// input disabled) so a send cannot silently drop the arena and start
				// a plain conversation. The block clears once the model is picked
				// (effort always resolves to the model's default or provider default).
				// Visible stage label while the challenge flow owns the composer.
				const challengePhaseReason = (phase) => {
					switch (phase) {
						case "answer": return t("block.challenge.answer");
						case "challenge": return t("block.challenge.challenger");
						case "revise": return t("block.challenge.revise");
						case "final": return t("block.challenge.verdict");
						case "propose": return t("block.challenge.propose");
						case "review": return t("block.challenge.review");
						default: return t("block.challenge");
					}
				};
				const updateBlock = (sessionId, state) => {
					const conversation = ctx.get("conversation");
					if (conversation === void 0 || conversation.blocks === void 0) return;
					if (state.enabled && state.model === null) {
						// Two-model auto mode derives the arena model from the
						// directory (complement of the input box's current model) —
						// never block on a tick where that materialization has not
						// run yet: the arena is ready as soon as the directory
						// resolves two models.
						try {
							const auto = autoArenaModel(models.directoryFor(sessionId)?.store?.getSnapshot?.() ?? null);
							if (auto !== null) {
								conversation.blocks.set(sessionId, void 0);
								return;
							}
						} catch (_autoBlockFailure) {
							// fall through to the plain block
						}
						conversation.blocks.set(sessionId, { reason: t("block.reason") });
					} else if (arenaMount !== null && arenaMount.sessionId === sessionId && shouldShowChallengeHeader(arenaMount.challenge)) {
						// A restored main-model phase whose session is genuinely idle
						// (a turn that was interrupted server-side — e.g. dsh restart)
						// must NOT lock the composer: the user sends "continue" to
						// wake the main model up (the backend session survives a
						// refresh, so running/finished turns proceed on their own and
						// stay locked). The header still shows the stage + hint.
						// Only RESTORED challenges get this treatment — a fresh round
						// always locks while the main model works.
						const c = arenaMount.challenge;
						if (c.restored === true && isMainModelPhase(c.phase) && resolveMainResume(
							(() => { try { return ctx.sessions.binding(sessionId)?.session?.getSnapshot?.(); } catch { return void 0; } })(),
							c
						) === "waiting") {
							conversation.blocks.set(sessionId, void 0);
						} else {
							conversation.blocks.set(sessionId, { reason: challengePhaseReason(c.phase) });
						}
					} else {
						conversation.blocks.set(sessionId, void 0);
					}
				};

				const buildPanel = (state, sessionId, directory) => {
					const panel = document.createElement("div");
					panel.className = "ma-panel";
					panel.dataset.arenaPanel = "";

					const label = document.createElement("span");
					label.className = "ma-panelLabel";
					label.textContent = t("panel.label");
					panel.appendChild(label);

					const selector = document.createElement("div");
					selector.className = "ma-selector";
					const trigger = document.createElement("button");
					trigger.type = "button";
					trigger.className = "ma-trigger";
					trigger.dataset.arenaTrigger = "";
					const triggerLabel = document.createElement("span");
					triggerLabel.className = "ma-triggerLabel";
					const triggerEffort = document.createElement("span");
					triggerEffort.className = "ma-triggerEffort";
					const chevron = document.createElement("span");
					chevron.className = "ma-chevron";
					chevron.textContent = "▾";
					trigger.append(triggerLabel, triggerEffort, chevron);
					menuHost = document.createElement("div");
					selector.append(trigger, menuHost);
					panel.appendChild(selector);

					trigger.addEventListener("click", () => {
						if (mounted !== null && mounted.menuPane !== null) closeMenu();
						else openMenu("root");
					});

					// Scenario selector: which role pair the challenge flow uses.
					const sceneRow = document.createElement("div");
					sceneRow.className = "ma-sceneRow";
					sceneRow.dataset.arenaSceneRow = "";
					const sceneLabel = document.createElement("span");
					sceneLabel.className = "ma-panelLabel";
					sceneLabel.textContent = t("scene.label");
					sceneRow.appendChild(sceneLabel);
					const sceneSeg = document.createElement("div");
					sceneSeg.className = "ma-sceneSeg";
					const sceneBtns = {};
					for (const key of ["business", "knowledge", "qa"]) {
						const btn = document.createElement("button");
						btn.type = "button";
						btn.className = "ma-sceneBtn";
						btn.dataset.arenaScene = key;
						btn.textContent = t("scene." + key);
						btn.addEventListener("click", () => {
							if (state.scene === key) return;
							state.scene = key;
							// Skill is bound to the scene: switching scenes loads that
							// scene's remembered skill (empty = none).
							const wsEntry = workspaceSkillsCache[workspacePathOf(sessionId) ?? ""];
							state.skill = (wsEntry !== null && typeof wsEntry === "object" && !Array.isArray(wsEntry) ? wsEntry[key] : void 0) ?? "";
							if (arenaMount !== null && arenaMount.sessionId === sessionId) {
								arenaMount.challenge.scene = key;
								arenaMount.challenge.skill = state.skill;
							}
							repaintPanel();
							syncPersona();
						});
						sceneBtns[key] = btn;
						sceneSeg.appendChild(btn);
					}
					sceneRow.appendChild(sceneSeg);
					panel.appendChild(sceneRow);

					// Challenger skill: optional workspace-persisted skill path (file or
					// folder) the challenger reads and follows. Empty = no skill. Picked
					// in this hero panel; persisted per workspace so new sessions in the
					// same workspace reuse it.
					const skillRow = document.createElement("div");
					skillRow.className = "ma-skillRow";
					skillRow.dataset.arenaSkillRow = "";
					const skillLabel = document.createElement("span");
					skillLabel.className = "ma-panelLabel";
					skillLabel.textContent = t("skill.label");
					skillRow.appendChild(skillLabel);
					const skillSel = document.createElement("div");
					skillSel.className = "ma-selector";
					const skillTrigger = document.createElement("button");
					skillTrigger.type = "button";
					skillTrigger.className = "ma-trigger";
					skillTrigger.dataset.arenaSkillTrigger = "";
					const skillValue = document.createElement("span");
					skillValue.className = "ma-triggerLabel ma-skillValue";
					const skillChevron = document.createElement("span");
					skillChevron.className = "ma-chevron";
					skillChevron.textContent = "▾";
					skillTrigger.append(skillValue, skillChevron);
					const skillHost = document.createElement("div");
					skillHost.className = "ma-skillHost";
					skillSel.append(skillTrigger, skillHost);
					skillRow.appendChild(skillSel);
					panel.appendChild(skillRow);
					let skillOpen = false;
					let skillOutside = null;
					const closeSkill = () => {
						skillOpen = false;
						skillHost.textContent = "";
						if (skillOutside !== null) { document.removeEventListener("mousedown", skillOutside); skillOutside = null; }
					};
					const applySkill = (skill) => {
						state.skill = typeof skill === "string" ? skill : "";
						if (arenaMount !== null && arenaMount.sessionId === sessionId) arenaMount.challenge.skill = state.skill;
						saveWorkspaceSkill(sessionId, state.scene ?? "business", state.skill);
						closeSkill();
						repaintPanel();
						syncPersona();
					};
					const openSkill = () => {
						skillOpen = true;
						skillHost.textContent = "";
						const pop = document.createElement("div");
						pop.className = "ma-skillPopover";
						pop.dataset.arenaSkillPopover = "";
						const cur = document.createElement("p");
						cur.className = "ma-skillPath";
						cur.textContent = state.skill === void 0 || state.skill === "" ? t("skill.empty") : state.skill;
						pop.appendChild(cur);
						const browse = document.createElement("button");
						browse.type = "button";
						browse.className = "ma-questionBtn";
						browse.textContent = t("skill.browse");
						browse.addEventListener("click", () => {
							const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
							Promise.resolve(workspaces?.pickDirectory?.()).then((path) => {
								if (typeof path === "string" && path !== "") applySkill(path);
							}).catch(() => {});
						});
						pop.appendChild(browse);
						const manual = document.createElement("div");
						manual.className = "ma-questionActions";
						const input = document.createElement("input");
						input.type = "text";
						input.className = "ma-questionInput";
						input.placeholder = t("skill.manual");
						input.value = typeof state.skill === "string" ? state.skill : "";
						const confirm = document.createElement("button");
						confirm.type = "button";
						confirm.className = "ma-questionBtn primary";
						confirm.textContent = t("skill.confirm");
						confirm.addEventListener("click", () => {
							applySkill((input.value ?? "").trim());
						});
						manual.append(input, confirm);
						pop.appendChild(manual);
						if (typeof state.skill === "string" && state.skill !== "") {
							const clear = document.createElement("button");
							clear.type = "button";
							clear.className = "ma-questionBtn";
							clear.textContent = t("skill.clear");
							clear.addEventListener("click", () => applySkill(""));
							pop.appendChild(clear);
						}
						skillHost.appendChild(pop);
						skillOutside = (event) => {
							if (skillSel.contains(event.target)) return;
							closeSkill();
						};
						document.addEventListener("mousedown", skillOutside);
					};
					skillTrigger.addEventListener("click", () => {
						if (skillOpen) closeSkill();
						else openSkill();
					});
					const note = document.createElement("span");
					note.className = "ma-hint";
					panel.appendChild(note);

					const repaintPanel = () => {
						const snap = directory === null ? null : directory.store.getSnapshot();
						// Two-model auto mode: with exactly two models the arena model
						// is DERIVED (the complement of the input box's current model)
						// and follows composer switches — no manual pick needed. It
						// applies only while the arena session does not exist yet;
						// once created the arena model is frozen (a composer switch
						// mid-duel must never rewire the running challenger), and the
						// conflict-clear below must not clobber the frozen pick either.
						const arenaLocked = state.enabled && arenaMount !== null && arenaMount.sessionId === sessionId && arenaMount.arenaSessionId !== void 0;
						if (state.enabled && !arenaLocked) {
							const auto = autoArenaModel(snap);
							if (auto !== null) {
								// Keep a user-chosen reasoning effort on the SAME
								// model across unrelated repaints (a composer switch
								// lands on the other complement and falls back to
								// that model's default).
								if (state.model !== null && state.model.provider === auto.provider && state.model.model === auto.model && state.model.reasoningEffort !== auto.reasoningEffort) {
									auto.reasoningEffort = state.model.reasoningEffort;
								}
								state.model = auto;
							}
						}
						let conflict = false;
						if (!arenaLocked && conflictsWithInput(state.model, snap)) {
							state.model = null;
							conflict = true;
						}
						for (const key of Object.keys(sceneBtns)) {
							sceneBtns[key].setAttribute("aria-pressed", state.scene === key ? "true" : "false");
						}
						// Reflect the resolved state (a conflict may have cleared the
						// arena model) into the composer gate.
						updateBlock(sessionId, state);
						const failed = directory === null || snap === null || snap.status === "error" || snap.status === "failed";
						const model = findArenaModel(snap, state.model);
						const efforts = model?.reasoning?.efforts ?? [];
						const modelLabel = state.model === null ? t("model.placeholder") : model?.name ?? state.model.model;
						const effortLabel = model === void 0 || state.model === null || model.reasoning === void 0 ? null : state.model.reasoningEffort !== void 0
							? (efforts.find((level) => level.id === state.model.reasoningEffort)?.name ?? state.model.reasoningEffort)
							: (model.reasoning?.defaultEffort === void 0 ? t("effort.default") : efforts.find((level) => level.id === model.reasoning.defaultEffort)?.name ?? model.reasoning.defaultEffort);
						triggerLabel.textContent = modelLabel;
						triggerEffort.textContent = effortLabel === null ? "" : effortLabel;
						trigger.setAttribute("aria-label", t("menu.aria") + "：" + (effortLabel === null ? modelLabel : modelLabel + " · " + effortLabel));
						skillValue.textContent = typeof state.skill === "string" && state.skill !== "" ? pathBasename(state.skill) : t("skill.placeholder");
						skillTrigger.setAttribute("aria-label", t("skill.label") + "：" + (typeof state.skill === "string" && state.skill !== "" ? state.skill : t("skill.placeholder")));
						if (conflict) {
							note.className = "ma-conflict";
							note.textContent = t("conflict");
						} else if (failed) {
							note.className = "ma-error";
							note.textContent = t("menu.error");
							const retry = document.createElement("button");
							retry.type = "button";
							retry.className = "ma-errorRetry";
							retry.textContent = t("menu.retry");
							retry.addEventListener("click", () => {
								directory?.load().catch(() => void 0);
							});
							note.appendChild(retry);
						} else {
							note.className = "ma-hint";
							note.textContent = "";
						}
					};
					panel.repaintPanel = repaintPanel;
					panel._closeMenu = closeMenu;
					panel._renderMenu = () => {
						if (mounted !== null && mounted.menuPane !== null) renderMenu(menuHost, mounted.state, mounted.directory);
					};
					return panel;
				};

				// ── competitor invisibility ──────────────────────────────────────
				// The arena (model 2) session is a competitor: it must NOT appear in
				// the sidebar list, and the user must not be able to switch into it
				// and chat with it privately (that would corrupt the mirrored
				// context). These guards only hide its list row and bounce any
				// selection back — the session itself keeps working (tab only).
				const isArenaSessionId = (sessionId) => {
					if (sessionId === void 0 || sessionId === null) return false;
					for (const mainId of Object.keys(linksCache)) {
						const link = linksCache[mainId];
						if (link !== void 0 && link.sessionId === sessionId) return true;
					}
					return false;
				};
				// Hide the arena session row in the sidebar. Rows are identified by
				// title text "竞技场"/"Arena" — the arena session is renamed at create
				// time. Idempotent + marked so repaint never re-touches the row
				// (avoids the MutationObserver feedback loop).
				const hideArenaSessionRows = () => {
					try {
						for (const row of document.querySelectorAll(ANCHORS.sidebarRow)) {
							if (!(row instanceof HTMLElement)) continue;
							if (row.dataset.arenaHidden !== void 0) continue;
							// The arena session is renamed to "竞技场"/"Arena" at create;
							// its row title lives in the ANCHORS.sidebarTitle span
							// (status/time are separate sibling spans). Match the title
							// span exactly so a user session merely mentioning 竞技场 is
							// never hidden.
							const titleEl = row.querySelector?.(ANCHORS.sidebarTitle);
							const titleText = titleEl instanceof HTMLElement ? (titleEl.textContent || "").trim() : "";
							const isArena = titleText === "竞技场" || titleText === "Arena";
							if (isArena) {
								row.style.display = "none";
								row.dataset.arenaHidden = "";
							}
						}
					} catch (_hideFailure) {
						// sidebar structure changed — retry next schedule tick
					}
				};
				// Challenger loading indicator in the SIDEBAR: the main session's own
				// row shows the platform's running dot while the main model generates,
				// but nothing while the CHALLENGER (arena model) is working — the main
				// session is idle then. Inject a small rotating dot into the ARENA
				// MAIN session's row's status slot while a challenger round is active
				// AND its arena session is running, and remove it otherwise. The main
				// row is located by matching the sessions-list displayTitle (falling
				// back to the currently-selected row), and the dot STAYS there even
				// when that session is not the current one — a challenger running via
				// the background advance keeps its indicator visible on switch-away
				// instead of vanishing. Idempotent + marked so repaint never
				// re-touches the row (MutationObserver feedback guard).
				const syncChallengerLoading = () => {
					try {
						const current = currentSessionId();
						const list = ctx.sessions.list.getSnapshot?.();
						// Collect the MAIN session ids whose challenger is currently
						// generating — not just "is any challenger running". linksCache
						// may hold several historical links (one per arena duel), and the
						// dot must land on the row of the main session whose challenger
						// is ACTUALLY running, never on an already-ended duel's row.
						const runningMainIds = [];
						for (const mainId of Object.keys(linksCache)) {
							const link = linksCache[mainId];
							if (link === null || typeof link !== "object" || typeof link.sessionId !== "string") continue;
							// 当前会话用 arenaMount 的实时挑战状态（比持久化基线更新），
							// 其余会话用持久化基线 challengesCache
							const challenge = (mainId === current && arenaMount !== null && arenaMount.sessionId === mainId)
								? arenaMount.challenge
								: challengesCache[mainId];
							if (challenge === null || typeof challenge !== "object" || challenge.active !== true) continue;
							if (!isChallengerPhase(challenge.phase)) continue;
							let snap = void 0;
							try {
								snap = ctx.sessions.binding(link.sessionId)?.session?.getSnapshot?.();
							} catch {}
							if (snap?.running === true) runningMainIds.push(mainId);
						}
						// 竞技场主会话的侧边栏行：按 sessions-list 的 displayTitle 匹配标题
						// span（与 hideArenaSessionRows 识别竞技场行同一模式）。
						const rowForMainId = (mainId) => {
							try {
								const summary = list?.byId?.[mainId];
								const title = typeof summary?.displayTitle === "string" ? summary.displayTitle.trim() : "";
								if (title === "") return null;
								for (const el of document.querySelectorAll(ANCHORS.sidebarRow)) {
									if (!(el instanceof HTMLElement)) continue;
									const titleEl = el.querySelector?.(ANCHORS.sidebarTitle);
									if (titleEl instanceof HTMLElement && (titleEl.textContent || "").trim() === title) return el;
								}
							} catch {}
							return null;
						};
						// 注入目标：每个「挑战者正在运行」的主会话行（未选中也显示）。
						const runningRows = new Set();
						for (const mainId of runningMainIds) {
							const row = rowForMainId(mainId);
							if (row !== null) runningRows.add(row);
						}
						// 回退：标题定位失败（会话列表尚未加载完）时，仅当运行的挑战者
						// 恰好属于当前会话，才回退到当前选中行——绝不复用到其它（可能已
						// 结束）会话的行，这正是「spin 挂在已结束挑战者会话上」的根因。
						let fallbackRow = null;
						if (runningRows.size === 0 && runningMainIds.length === 1 && runningMainIds[0] === current) {
							for (const el of document.querySelectorAll(ANCHORS.sidebarRow)) {
								if (el instanceof HTMLElement && typeof el.className === "string" && el.className.split(/\s+/).includes(ANCHORS.sidebarSelected)) {
									fallbackRow = el;
									break;
								}
							}
						}
						const showDot = runningRows.size > 0 || fallbackRow !== null;
						for (const el of document.querySelectorAll(ANCHORS.sidebarRow)) {
							if (!(el instanceof HTMLElement)) continue;
							const dot = el.querySelector(".ma-sidebarLoading");
							const isTarget = runningRows.has(el) || (fallbackRow !== null && el === fallbackRow);
							if (showDot && isTarget) {
								if (dot === null) {
									const slot = el.querySelector(ANCHORS.sidebarSlot) ?? el;
									const spinner = document.createElement("span");
									spinner.className = "ma-sidebarLoading";
									spinner.dataset.arenaSidebarLoading = "";
									spinner.setAttribute("role", "status");
									spinner.setAttribute("aria-label", t("challenge.loading"));
									// Make the seat the positioning context for the absolutely-
									// positioned ring via an inline style — a CSS rule on the
									// hashed .YDXeBa_* class is fragile across dsh web upgrades
									// and left the ring centered over a larger ancestor (the
									// "spins in the middle of the title" bug). Inline style on
									// the exact element is bulletproof.
									try {
										slot.style.position = "relative";
									} catch {}
									slot.appendChild(spinner);
									el.dataset.arenaLoading = "";
								}
							} else if (dot !== null) {
								dot.remove();
								delete el.dataset.arenaLoading;
							}
						}
					} catch (_loadingSyncFailure) {
						// sidebar structure changed — retry next schedule tick
					}
				};
				// Prevent switching INTO an arena session: if the current selection
				// is a competitor session, bounce the selection back to its linked
				// main session. Guarded so we never fight a legitimate selection
				// (e.g. the arena session being opened programmatically).
				let lastGuardedSelection = null;
				const guardArenaSelection = () => {
					try {
						const current = currentSessionId();
						if (current === void 0 || !isArenaSessionId(current)) {
							lastGuardedSelection = current ?? null;
							return;
						}
						if (lastGuardedSelection === current) return;
						// bounce back to the linked main session
						let mainId = void 0;
						for (const key of Object.keys(linksCache)) {
							const link = linksCache[key];
							if (link !== void 0 && link.sessionId === current) mainId = key;
						}
						if (mainId !== void 0) {
							lastGuardedSelection = current;
							// ctx.get resolves RUNTIME services only; the sessions service
							// is the injected ctx.sessions face ("sessions" is in the plugin's
							// inject list), whose open(id) selects a session as current.
							// Falling back to it keeps the bounce working when ctx.get
							// cannot resolve "sessions".
							let sessionsApi = void 0;
							try {
								sessionsApi = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
							} catch {
								sessionsApi = void 0;
							}
							if ((sessionsApi === void 0 || typeof sessionsApi.open !== "function") && ctx.sessions !== void 0 && typeof ctx.sessions.open === "function") {
								sessionsApi = ctx.sessions;
							}
							if (sessionsApi !== void 0 && typeof sessionsApi.open === "function") sessionsApi.open(mainId);
						}
					} catch (_guardFailure) {
						// never let the guard break the plugin lifecycle
					}
				};

				const sync = () => {
					try {
				guardArenaSelection();
				hideArenaSessionRows();
					const sessionId = currentSessionId();
					const row = sessionId === void 0 ? null : findHeroRow();
					if (row === null) {
						cleanup();
					} else if (mounted !== null && mounted.row === row && mounted.sessionId === sessionId) {
						repaint();
					} else {
						cleanup();

					const state = stateFor(sessionId);
					let directory = null;
					let unsubDirectory = null;
					try {
						directory = models.directoryFor(sessionId);
						directory.load().catch(() => void 0);
						unsubDirectory = directory.store.subscribe(() => repaint());
					} catch (_directoryFailure) {
						directory = null;
					}

					const toggle = document.createElement("button");
					toggle.type = "button";
					toggle.className = "ma-toggle";
					toggle.dataset.arenaToggle = "";
					const repaintToggle = () => {
						toggle.textContent = t("toggle.label");
						toggle.setAttribute("aria-pressed", state.enabled ? "true" : "false");
						toggle.setAttribute("aria-label", t(state.enabled ? "toggle.aria.on" : "toggle.aria.off"));
						toggle.setAttribute("title", t(state.enabled ? "toggle.title.on" : "toggle.title.off"));
					};
					toggle.addEventListener("click", () => {
						state.enabled = !state.enabled;
						closeMenu();
						repaint();
					});

					const panel = buildPanel(state, sessionId, directory);

					mounted = {
						row,
						sessionId,
						state,
						toggle,
						panel,
						directory,
						unsubDirectory,
						menuPane: null,
						repaintToggle,
						repaintPanel: panel.repaintPanel,
						lastSignature: null
					};
					row.appendChild(toggle);
					repaint();
					}
				// Arena runtime, view-ring tab, persona map and the poll-based
				// catch-up track the CURRENT session — not the hero row. Message
				// sessions have no hero row, so without this the runtime is never
				// torn down on switch-away, never restored on entry (including a
				// persisted linkage after reload), and the catch-up poll never runs
				// there — leaving a round stranded mid-flight (archived arena
				// sessions can drop live events) with the header up forever.
				syncArena(sessionId);
				syncViewEntry();
				syncPersona();
				// Restore alignment runs on EVERY sync tick (not just the mount in
				// syncArena): the async history load may deliver the snapshot AFTER
				// mount, so a main-model phase first read as "waiting" must re-align
				// to "running"/"completed" once the snapshot lands, and a challenger
				// phase must re-inject its round prompt as soon as it is visible.
				if (sessionId !== void 0) alignChallengeAfterRestore(sessionId, stateFor(sessionId));
				// Poll-based catch-up: session live events can be missed while
				// the arena runtime is unmounted (session switch) or when an
				// archived arena session drops events — advance the challenge
				// straight from the current snapshots on every sync tick, so a
				// round that finished while away is caught up on return and a
				// conclusion is never silently lost.
				if (arenaMount !== null && arenaMount.challenge.active === true) {
					detectChallengeTurn();
					// Recovery re-read: the node half writes `arena.reviewRequest`
					// (and the watch heartbeat) via settings; if the network dropped
					// right at the propose→challenger handoff (or during the
					// challenger's review), the `document-updated` push may have been
					// missed. Re-read the persisted bridge on a throttle, then advance
					// once more so a fresh reviewRequest/watch is consumed immediately.
					if (Date.now() - lastLinksRefresh > 2000) {
						lastLinksRefresh = Date.now();
						loadLinks().then(() => {
							if (arenaMount !== null && arenaMount.challenge.active === true) detectChallengeTurn();
						}).catch(() => {});
					}
				}
				// Re-sync the sidebar challenger dot AFTER the arena mount has been
				// torn down/restored and the turn advanced, so it reads the current
				// session's phase + running flag (never a stale mount) and cleans up
				// any dot orphaned on a deselected row.
				syncChallengerLoading();
				} catch (_syncFailure) {
					// one bad tick must never kill the schedule chain
				}
			};

				const cleanup = () => {
					if (mounted === null) return;
					const was = mounted;
					was.panel._closeMenu?.();
					updateBlock(was.sessionId, { enabled: false, model: null });
					was.toggle.remove();
					was.panel.remove();
					was.unsubDirectory?.();
					mounted = null;
				};

				// Render signature: repaint only touches the DOM when the visible
				// state actually changed — otherwise repaint's own DOM mutations
				// feed the body MutationObserver -> schedule -> sync -> repaint
				// loop (open dropdowns flicker/close forever).
				const renderSignature = () => {
					const snap = mounted.directory === null ? null : mounted.directory.store.getSnapshot();
					return JSON.stringify({
						loc: t("toggle.label"),
						enabled: mounted.state.enabled,
						model: mounted.state.model,
						current: snap?.current ?? null,
						status: snap?.status ?? null,
						groups: (Array.isArray(snap?.groups) ? snap.groups : []).map((g) => [g.id, g.name, g.models.map((m) => m.id)])
					});
				};

				const repaint = () => {
					if (mounted === null) return;
					const signature = renderSignature();
					if (signature === mounted.lastSignature) return;
					mounted.lastSignature = signature;
					mounted.repaintToggle();
					if (mounted.state.enabled) {
						if (mounted.panel.parentElement === null) {
							mounted.row.parentElement?.insertBefore(mounted.panel, mounted.row.nextSibling);
						}
					} else if (mounted.panel.parentElement !== null) {
						mounted.panel.remove();
					}
					mounted.repaintPanel();
					mounted.panel._renderMenu?.();
				};

				const schedule = () => {
					clearTimeout(schedule.timer);
					schedule.timer = setTimeout(sync, 60);
				};

				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				const unsubscribeSessions = ctx.sessions.list.subscribe(schedule);
				const unsubscribeLocale = ctx.locale.subscribe(() => {
					if (mounted !== null) repaint();
				});
				// Archive coupling: when a session linked to an arena session is
				// archived (sidebar "Archive"), archive its arena counterpart too.
				// The archived set lives on the workspaces list snapshot; we diff
				// against the last seen set and archive any linked arena session
				// whose main session just entered it. Guarded so an arena session
				// archived on its own never re-triggers (it has no link row).
				let lastArchivedIds = null;
				let unsubArchives = null;
				const syncArchiveCoupling = () => {
					try {
						const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
						const snap = workspaces?.list?.getSnapshot?.();
						const archived = Array.isArray(snap?.archivedSessionIds) ? snap.archivedSessionIds : [];
						if (lastArchivedIds === null) {
							lastArchivedIds = archived;
							return;
						}
						const newlyArchived = archived.filter((id) => !lastArchivedIds.includes(id));
						lastArchivedIds = archived;
						if (newlyArchived.length === 0) return;
						for (const mainId of newlyArchived) {
							const link = linksCache[mainId];
							if (link === void 0 || link.sessionId === void 0) continue;
							if (archived.includes(link.sessionId)) continue;
							if (typeof workspaces?.archiveSession !== "function") continue;
							workspaces.archiveSession(link.sessionId).catch(() => {});
						}
					} catch (_archiveSyncFailure) {
						// never let archive coupling break the plugin lifecycle
					}
				};
				try {
					const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : void 0;
					if (workspaces?.list?.subscribe !== void 0 && typeof workspaces.list.subscribe === "function") {
						unsubArchives = workspaces.list.subscribe(syncArchiveCoupling);
						syncArchiveCoupling(); // seed the baseline
					}
				} catch (_archiveSubscribeFailure) {
					unsubArchives = null;
				}

				// Mount immediately (synchronous first paint), then keep the
				// MutationObserver/session subscriptions fresh.
				sync();
				schedule();

				// Background-advance poll: while the feature is enabled, advance
				// every linked duel whose MAIN session is not the current one from
				// its persisted baseline (challenger reply → injected into the main
				// session; finished main turn → challenger prompted; knowledge
				// reviewRequest consumed when it belongs to that session). No-op
				// when the switch is off; the interval is cheap (walks linksCache).
				const backgroundTimer = setInterval(() => {
					try {
						advanceBackgroundDuels();
					} catch (_backgroundTimerFailure) {
						// never break the plugin lifecycle
					}
				}, 2000);
				if (typeof backgroundTimer.unref === "function") backgroundTimer.unref();

				// Restore persisted arena linkages (async; re-syncs when loaded)
				// and keep them fresh on settings changes.
				loadLinks().then(() => sync());
				let unsubRemote = null;
				try {
					unsubRemote = ctx.remote?.$on?.("settings/document-updated", (ns) => {
						if (ns === "model-arena") loadLinks().then(() => sync());
					});
				} catch {
					unsubRemote = null;
				}

				exports.__internals = {
					mountArenaTab,
					unmountArenaTab,
					renderArenaPane,
					arenaTick,
					getArenaMount: () => arenaMount,
					syncViewEntry,
					advanceBackgroundDuels,
					clearReviewDone: (sessionId) => {
						const link = linksCache[sessionId];
						if (link !== null && typeof link === "object" && !Array.isArray(link)) {
							const next = { ...link };
							delete next.done;
							saveLink(sessionId, next);
						}
					}
				};
								return () => {
					clearTimeout(schedule.timer);
					clearInterval(backgroundTimer);
					observer.disconnect();
					unsubscribeSessions?.();
					unsubscribeLocale?.();
				unsubArchives?.();
					unsubRemote?.();
					teardownArena();
					cleanup();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.buildModelOptions = buildModelOptions;
		exports.buildEffortChoices = buildEffortChoices;
		exports.normalizeTemperatureInput = normalizeTemperatureInput;
		exports.conflictsWithInput = conflictsWithInput;
		exports.findArenaModel = findArenaModel;
		exports.totalModelsOf = totalModelsOf;
		exports.autoArenaModel = autoArenaModel;
		exports.textOfContent = textOfContent;
		exports.assistantRows = assistantRows;
		exports.nonMdSig = nonMdSig;
		exports.SCENES = SCENES;
		exports.fmt = fmt;
		exports.extractFileRefs = extractFileRefs;
		exports.pathBasename = pathBasename;
		exports.buildRoundPrompt = buildRoundPrompt;
		exports.parseReviewVerdict = parseReviewVerdict;
		exports.roundLabelOf = roundLabelOf;
		exports.MAX_REJECTS = MAX_REJECTS;
		exports.formatToolTrail = formatToolTrail;
		exports.toolArgsSummary = toolArgsSummary;
		exports.buildReviseMessage = buildReviseMessage;
		exports.stripMarkdown = stripMarkdown;
		exports.buildRoleSeed = buildRoleSeed;
		exports.shouldShowChallengeHeader = shouldShowChallengeHeader;
		exports.shouldReArmChallenge = shouldReArmChallenge;
		exports.isPastReviewStage = isPastReviewStage;
		exports.isMainModelPhase = isMainModelPhase;
		exports.isChallengerPhase = isChallengerPhase;
		exports.isTerminalPhase = isTerminalPhase;
		exports.isResumableChallenge = isResumableChallenge;
		exports.toPersistedChallenge = toPersistedChallenge;
		exports.fromPersistedChallenge = fromPersistedChallenge;
		exports.resolveMainResume = resolveMainResume;
		exports.resolveChallengerResume = resolveChallengerResume;
		exports.STALL_MS = STALL_MS;
		return module.exports;
	}
});
