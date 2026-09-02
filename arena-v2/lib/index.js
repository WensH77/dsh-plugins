// dsh-plugin-arena-v2 — node half
//
// 目标：类 plan 的 chip 入口（/arena 命令）开启竞技场后，主代理收到用户内容自动
// 创建「可接续子代理」（竞技场挑战者），把内容转交给它应答。多轮对话复用同一个
// 挑战者：首轮用 subagent 创建（拿到 durable 的 subagentId），后续轮次用
// send_message 给同一个 id 续聊，挑战者的上下文跨轮次累积。
//
// 挑战者/探索者模型：**固定** deepseek-v4-pro · 推理深度 max，与父代理完全解耦——
// 父代理用什么模型都不影响。dsh 0.1.2-alpha.4 起按**创建请求**注入：ContinuableStartSpec.request
// 传 agentOptions（provider/model/reasoningEffort，spawn provider 支持）与 persona
// （阴影 deployment:persona）——两者随 descriptor 持久化、冷恢复重放，不再有
// registerContinuableSetup 创建窗口钩子。
//
// 实现分四部分：
// 1) 竞技场模式：/arena 命令把模式状态写入 ~/.dsh/arena-v2 侧文件（按会话 id，
//    重启后恢复）；chip 挂载时经 /arena-v2/state 路由从侧文件恢复开关态；
//    **与预设无关，只看 chip 是否开启**。
// 2) 固定模型选择：创建竞技场子代理时随 startContinuable 请求传入 agentOptions；
//    同父会话的其它子代理、其它会话的子代理不受影响。
// 3) 挑战者 id 追踪：监听 subagent/start（子代理创建/唤醒/冷恢复）以及按 label
//    枚举本会话的直接子代理（ctx.subagents.listChildren），把「当前挑战者 id」
//    注入系统提示。主代理直接读提示里的 id 即可 send_message，无需从历史工具
//    结果里翻找（对上下文压缩、插件热启用、重启都稳）。
// 4) 自动竞技指令：通过 system-prompt/assemble 的 section 注入（非 complete
//    persona 的可组合段落），仅当竞技场模式开启、会话有 subagent 工具、且非
//    子代理会话时生效。主代理 persona 在开启时动态安装/卸载。
import z from '@deepseek-ai/schemastery';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';
// 0.1.2-alpha.4 起 PERSONA_ORDER 已移除；deployment:persona 的固定槽位序号为 0
// （SECTION_ORDERS.DEPLOYMENT_PERSONA = 0，旧版 PERSONA_ORDER 亦为 0）。
import { PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt';
const PERSONA_ORDER = 0;
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'arena-v2';
const inject = ['settings', 'systemPrompt'];

/** 挑战者子代理的 durable label（subagent 工具的 description 参数）。 */
const CHALLENGER_LABEL = 'arena-challenger';

/** 知识沉淀场景探索者子代理的 durable label。 */
const EXPLORER_LABEL = 'arena-explorer';

/** 场景中文名（宿主侧提示用）。 */
const SCENE_NAMES = { business: '业务探索', knowledge: '知识沉淀', qa: '测试用例' };

// ── 知识沉淀场景（knowledge）：Theseus workflow 对抗流程的固定交互协议 ──────
// 主控者（主代理）持有 Theseus CLI（mode/judge/record）与全部 ask_user_question；
// 探索者子代理执行 explore/propose/user-readiness/requirement-report 并产出工件；
// 挑战者子代理执行 theseus-review-spec、只写 review.md、只返回 "Done"。
// 判定一律读文件（review.md / openspec/states/*），不依赖子代理自述。

/** 探索者/挑战者返回协议的行前缀（宿主机器解析子代理结算消息）。 */
const K_STAGE_DONE = 'STAGE_DONE';
const K_NEED_QUESTION = 'NEED_QUESTION';
const K_BLOCKED = 'BLOCKED';

/** 主控者在终评 READY 后询问「是否生成领导层报告」的固定问题 id 与选项文案。 */
const ARENA_K_REPORT_QUESTION_ID = 'arena_k_report';
const ARENA_K_REPORT_YES = '生成报告（截图 + PPT）';
const ARENA_K_REPORT_NO = '跳过';

/** 主控者在终评 NEEDS_REVISION 后询问「是否再来一轮修订」的固定问题 id 与选项文案。 */
const ARENA_K_REVISION_QUESTION_ID = 'arena_k_revision';
const ARENA_K_REVISION_YES = '再来一轮修订（重新 propose + 送审）';
const ARENA_K_REVISION_NO = '结束并保留当前工件';

/** 阶段推进确认门：进入下一阶段（propose/review/readiness/apply）前询问用户的固定问题 id 与选项文案。 */
const ARENA_K_ADVANCE_QUESTION_ID = 'arena_k_advance';
const ARENA_K_ADVANCE_YES = '确认，进入下一阶段';
const ARENA_K_ADVANCE_NO = '暂停，先不推进';

/**
 * 默认多源检索指引：注入主代理「回答前主动检索的知识源」策略（Jira / git /
 * openspec / 代码库），不按场景绑定；可按场景在 sceneSearchGuide 里覆盖或置空
 * （空字符串 = 该场景不注入）。历史会话检索已拆为独立的
 * DEFAULT_SESSION_HISTORY_GUIDE（全场景、能力式条件、只给主代理）。
 */
const DEFAULT_SEARCH_GUIDE = [
  '[arena-v2 多源检索]',
  '回答前主动检索以下知识源（不要只查代码库），并按需交叉验证：',
  '1. Jira：优先用 mcp__jira__* 工具（如 getTeamworkGraphContext / getTeamworkGraphObject）查相关 issue / 需求 / 缺陷；拿到的条目作为来源列出。',
  '2. git：用 bash 查提交历史与分支（git log --oneline -20、git branch -a、git show <commit>、git log --all --grep=<关键词>），定位相关提交 / 分支 / PR。',
  '3. openspec：读工作区 openspec/ 目录（specs/ 规格、states/ 状态、decisions/ 决策、.runtime/sessions/ 会话状态），把相关规格作为回答依据。',
  '4. 代码库：grep / read 照常，与以上来源交叉验证。',
  '回答中注明每个结论的来源（Jira 条目 / commit / openspec 规格 / 代码路径 / 历史会话）；无法从任何来源证实的判断标明「推断」。'
].join('\n');

/** 知识沉淀场景检索指引：Theseus workflow 知识源（主控者绑定/门控/apply 时检索）。 */
const KNOWLEDGE_SEARCH_GUIDE = [
  '[arena-v2 知识沉淀检索]',
  '执行 Theseus workflow 相关动作前，先检索以下知识源（按需交叉验证，注明来源）：',
  '1. openspec 规格与变更：openspec/specs/**/spec.md（frontmatter 的 anchors/scope/triggers + 正文）、openspec/changes/**（proposal/design/tasks/review/decision-log）、openspec/drafts/**（exploration handoff）；按 frontmatter 的 status 判定可信度——status: active 可直接采信，status: draft 须先对当前代码/工件验证再采信（与 theseus-retrieve-specs 的 Trust Handling 一致）。',
  '2. workflow 运行时：openspec/states/<id>.json（当前阶段/artifacts/lanes）、openspec/.runtime/sessions/*.json（会话绑定）——只读，经 Theseus CLI（judge/status）查询。',
  '3. 检索工具：node "$(git rev-parse --show-toplevel)/scripts/spec-meta.ts" search --term "<term>"（或 list 查看已解析元数据）——与 theseus-retrieve-specs 同一入口；helper 不可用时回退直接文件搜索，并在 trace/摘要里声明该回退。',
  '4. Jira：mcp__jira__* 查 issue/需求/缺陷作为提案与审查的源上下文（Theseus skill 只把 JIRA key 当检索输入、未声明接入方式，此项由本指引补充）。',
  '5. 代码库：grep / read 照常——探索/审查优先读 worktrees/<project>/explore-master/（**只读基线，不得修改**）；apply 阶段写代码必须用该 change 的 feature worktree（worktrees/<project>/<branch>/，见 AGENTS.md 的强制 worktree 约定），不要在 explore-master 或子项目主 checkout 里改。',
  '6. 历史会话（dsh 会话历史）：若你具备检索本地 dsh 历史会话的能力（例如技能列表中有 session-search，`node ~/.agents/skills/session-search/session-search.mjs`），**绑定/续跑与准备探索输入时**先短查询（主题词 2–4 字）拿候选会话，命中则 `--show <session-id>` 拉完整上下文——本主题此前若沉淀/讨论过，素材并入探索输入并交叉验证；引用注明 session id 与日期（字面子串匹配，搜不到 ≠ 没发生过，换同义词重试）。',
  '以上只是知识源清单；检索的**执行细节与输出契约**以工作区 SKILL.md 为准（theseus-retrieve-specs 的 Search Order 与 `Relevant specs consulted` / `Trust notes` 块），冲突时一律以 SKILL.md 为准。'
].join('\n');

/** 默认场景检索指引：business 多源检索；knowledge Theseus 知识源；qa 不注入（空 = 不注入）。 */
const DEFAULT_SCENE_SEARCH_GUIDE = {
  business: DEFAULT_SEARCH_GUIDE,
  knowledge: KNOWLEDGE_SEARCH_GUIDE,
  qa: ''
};

/**
 * 默认历史会话检索指引（`sessionHistoryGuide`，全场景共用，'' = 不注入）。
 *
 * **只注入主代理**：它随竞技指令段落（arena-v2:auto-arena）渲染，而该段落对子代理
 * 会话直接返回空——挑战者/探索者是独立会话（父代理历史本就不进入），让它们回捞
 * 历史会话既无意义，也会污染对抗（它们只该基于收到的回合材料与工作区文件判断）。
 *
 * **能力式条件**：正文以「若你具备…」开头，会话没有历史检索技能/工具时整段自然
 * 失效，不需要宿主侧探测技能目录，也不影响没有该能力的部署。
 */
const DEFAULT_SESSION_HISTORY_GUIDE = [
  '[arena-v2 历史会话检索]',
  '若你具备检索本地 dsh 历史会话的能力（例如技能列表中有 session-search，或其它等价的会话检索技能/工具），遇到下列情况**先检索再作答**，不要凭印象回答：',
  '1. 用户提到**当前会话之外**的过往内容（「我们之前聊过」「上次那个方案」「我记得讨论过」「之前那个数字/文件/决定/报错」）；',
  '2. 你要复用一个在本会话里没有出处的结论、数字、文件路径或历史决定；',
  '3. 质疑/审查里出现「这个之前定过」「与既有决定冲突」类争议，需要原始出处来裁决。',
  '用法：先用短查询（2–4 字或一个词）拿候选会话，再拉取该会话完整上下文，然后才回答；引用过往结论时注明 session id 与日期，让用户可自行核对。',
  '边界：它是字面子串匹配、不做语义联想——**搜不到不等于没发生过**，换同义词重试；仍无结果就如实说「没搜到」，不要断言「我们没讨论过」。内容就在当前会话里时不要用它，直接回看上文。',
  '没有该能力则整段跳过，不影响其它检索源。'
].join('\n');

/** 意图识别默认配置：flash 轻量模型、关思考、快速超时。 */
const DEFAULT_INTENT_CONFIG = {
  enabled: true,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'off',
  timeoutMs: 3000,
  maxTokens: 16
};

/**
 * 解析意图识别模型的输出 → 'need_answer' | 'no_need_answer' | null。
 * 先 JSON（{"answer": ...}），再子串回退；`no_need_answer` 先于 `need_answer`
 * 检查（前者包含后者作为子串）。纯函数，供测试。
 */
function parseIntentOutput(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return null;
  try {
    const parsed = JSON.parse(t);
    const answer = parsed?.answer;
    if (answer === 'need_answer') return 'need_answer';
    if (answer === 'no_need_answer') return 'no_need_answer';
  } catch {}
  if (t.includes('no_need_answer')) return 'no_need_answer';
  if (t.includes('need_answer')) return 'need_answer';
  return null;
}

/** 场景对应的挑战者 label：arena-challenger:<scene>（旧版无后缀的 business 挑战者兼容）。 */
function challengerLabelFor(scene) {
  return CHALLENGER_LABEL + ':' + normalizeScene(scene);
}

/** 是否为竞技场挑战者 label（含旧版无后缀的 business 挑战者）。 */
function isChallengerLabel(label) {
  if (label === CHALLENGER_LABEL) return true;
  if (typeof label === 'string' && label.startsWith(CHALLENGER_LABEL + ':')) {
    return SCENES.includes(label.slice(CHALLENGER_LABEL.length + 1));
  }
  return false;
}

/** 从挑战者 label 提取场景（旧版无后缀 → business；非挑战者 label → null）。 */
function sceneFromLabel(label) {
  if (label === CHALLENGER_LABEL) return 'business';
  if (typeof label === 'string' && label.startsWith(CHALLENGER_LABEL + ':')) {
    const scene = label.slice(CHALLENGER_LABEL.length + 1);
    return SCENES.includes(scene) ? scene : null;
  }
  return null;
}

/** 场景对应的探索者 label：arena-explorer:<scene>。 */
function explorerLabelFor(scene) {
  return EXPLORER_LABEL + ':' + normalizeScene(scene);
}

/** 是否为知识沉淀探索者 label。 */
function isExplorerLabel(label) {
  if (typeof label === 'string' && label.startsWith(EXPLORER_LABEL + ':')) {
    return SCENES.includes(label.slice(EXPLORER_LABEL.length + 1));
  }
  return false;
}

/** 从任意竞技场子代理 label（挑战者/探索者）提取场景；其它 label → null。 */
function sceneFromAnyLabel(label) {
  return sceneFromLabel(label) ?? (isExplorerLabel(label) ? label.slice(EXPLORER_LABEL.length + 1) : null);
}

/**
 * 解析 /arena 命令入参：'off' → 关闭；首词是场景键 → { scene, message }（其余为
 * 消息）；否则整段视为消息（场景由宿主按会话原场景解析，默认 business）。
 * @returns {{ off: boolean, scene: string|null, message: string }}
 */
function parseArenaCommand(rawInput) {
  const raw = (rawInput ?? '').trim();
  if (raw === 'off') return { off: true, scene: null, message: '' };
  const m = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (m && SCENES.includes(m[1])) {
    return { off: false, scene: m[1], message: (m[2] ?? '').trim() };
  }
  return { off: false, scene: null, message: raw };
}

/** 挑战者固定模型默认值：deepseek-v4-pro · max 推理深度。 */
const DEFAULT_CHALLENGER_MODEL = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max'
};

/** 默认主代理 persona：业务探索（Technical Expert）。注入目标会话，阴影覆盖预设 persona（'' = 保留预设）。约束按时机分组：答题时 vs 面对质疑时。 */
const DEFAULT_MAIN_PERSONA = [
  '[arena-v2 host]',
  '你是 Technical Expert（技术专家），竞技场主答者。',
  '',
  '【答题时】',
  '1. 先回答用户问题。',
  '2. 用户问题含指代性口语词或多义术语时，必须先 ask_user_question 向用户澄清指代，再回答；调查只用于列出候选与依据，不替代澄清；不臆测、不先给结论再补问、不把「存在多个候选」当作最终答案。',
  '',
  '【面对质疑时】',
  '1. 收到挑战者的逐条质疑后，逐条修正你的回答。',
  '2. 不必全盘接受质疑，不认可的条目用 ask_user_question 提出异议。',
  '',
  '【执行边界】',
  '竞技场流程只做调查、评审、给出结论，不执行任何代码/文档修改（不写文件、不 edit、不改配置）。',
  '挑战者的「认可」只是评审结论，不是用户授权；代码/文档修改必须等待用户明确指示后再执行。',
  '',
  '用中文回答，禁止辩论。'
].join('\n');

/**
 * 默认质疑轮模板：主代理回答后按此组装结构化消息发给挑战者。占位符由主代理
 * 按指令填写：{question} 用户问题原文，{answer} 回答正文（不含思维链），
 * {files} 提到的文件，{tools} 工具操作记录。
 */
const DEFAULT_CHALLENGE_PROMPT = [
  '[质疑轮]',
  '用户问题：「{question}」',
  'Technical Expert的回答：「{answer}」',
  '提到的文件：「{files}」',
  'Technical Expert 的工具操作记录：',
  '「{tools}」',
  '',
  '请用中文对上述回答**逐条质疑**：逐点审查回答中的每个观点、结论与依据，指出问题或漏洞；禁止辩论，只输出你的质疑（直接以质疑者口吻表达，不要自我称呼角色名）。'
].join('\n');

/**
 * 默认终评轮模板：主代理修正后按此组装终评消息发给挑战者。
 * 占位符同上（{answer} 为修正后的回答）。
 */
const DEFAULT_VERDICT_PROMPT = [
  '[终评轮]',
  'Technical Expert修正后的回答：「{answer}」',
  '提到的文件：「{files}」',
  'Technical Expert 的工具操作记录：',
  '「{tools}」',
  '',
  '修正已完成。请先**逐条核对**你上一轮提出的质疑是否在修正后的回答中被逐一回应：逐点对照每条质疑，确认已被解决或指出仍未解决的项；然后仅给出最终评审结论（认可或仍存疑）。禁止辩论，只输出你的结论，不要提出新的质疑。',
  '**最后单独一行**输出结论标记（供系统判定，不要加其它文字）：`结论：认可` 或 `结论：仍存疑`。'
].join('\n');

/**
 * 默认结论输出要求：终评「认可」，或终评「仍存疑」且用户拒绝再来一轮时，主代理
 * 据此**整理并输出本轮完整结论**（不是概览/摘要）。配置 `conclusionPrompt` 可覆盖，
 * `''` = 不注入（回到只呈现终评的旧行为）。
 */
const DEFAULT_CONCLUSION_PROMPT = [
  '【结论输出要求】',
  '不要只给概览、摘要或「已完成评审」之类的过程说明——要输出可直接当作最终答案使用的完整结论：',
  '1. **结论本身**：对用户问题的直接回答，逐条、具体（含关键结论值/名称/路径），不要指望用户回看前文；',
  '2. **依据与出处**：每条结论标注来源（文件路径·行号 / Jira issue / git 提交或分支 / openspec 文档 / 命令输出）；',
  '3. **经质疑修正的要点**：哪些结论在质疑后发生了改变，以及改变的原因；',
  '4. **仍未解决 / 仍存疑项**：逐条列出，说明影响与后续确认方式（没有则写「无」）；',
  '5. **建议的下一步**：只给建议，不执行任何代码/文档修改（评审结论不等于用户授权）。'
].join('\n');

// ── 终评结论 → 是否再来一轮（宿主机器判定）────────────────────────────────
// 设计：终评「仍存疑」时**由用户决定**是否再来一轮「修正 → 终评」——主代理必须用
// ask_user_question 询问，宿主从会话事件里机器提取用户的选择来推进状态机。
// **不记录 / 不累加轮次，也不设 max 上限**：verdictRounds 与 maxVerdictRounds 作为
// 既有设计保留（字段/配置/占位符都在），但不参与判定，轮数完全由用户逐轮决定。

/** 「是否再来一轮」提问的固定问题 id（宿主按此在 ask_user_question 结果里定位答案）。 */
const ARENA_ANOTHER_ROUND_QUESTION_ID = 'arena_another_round';
/** 「再来一轮」固定选项文案（宿主机器识别 → 继续修正-终评）。 */
const ARENA_ANOTHER_ROUND_YES = '再来一轮（修正 + 终评）';
/** 「结束竞技」固定选项文案（宿主机器识别 → 整理结论并关闭）。 */
const ARENA_ANOTHER_ROUND_NO = '结束竞技，输出结论';

/** 终评「仍存疑」类结论标记（先于「认可」类检查——「不认可」「未通过」含「认可」「通过」子串）。 */
const VERDICT_DISPUTED_MARKERS = ['仍存疑', '存疑', '不认可', '未通过', '不通过', '仍未解决'];
const VERDICT_DISPUTED_MARKERS_EN = ['NEEDS_REVISION', 'NEEDS REVISION'];
/** 终评「认可」类结论标记（business=认可 / qa=通过 / knowledge=READY）。 */
const VERDICT_APPROVED_MARKERS = ['认可', '通过', '无异议'];
const VERDICT_APPROVED_MARKERS_EN = ['READY', 'APPROVED'];

/**
 * 「存疑已消解」类表述——它们含「存疑」「仍未解决」子串却表示**没有**存疑，
 * 匹配前先剔除，避免把认可结论误判成仍存疑。
 */
const VERDICT_RESOLVED_NOISE = [
  /不再存疑/g,
  /无仍?存疑/g,
  /没有仍?存疑/g,
  /存疑(?:项)?(?:均|都|全部)?已(?:解决|消除|澄清|回应)/g,
  /仍未解决(?:的)?(?:项|条目)?\s*[:：]?\s*(?:无|没有|不存在)/g
];

/** 在一段文本里判定认可/存疑（存疑优先——否定词含肯定词子串）。 */
function matchVerdictMarkers(text) {
  const cleaned = VERDICT_RESOLVED_NOISE.reduce((s, re) => s.replace(re, ''), text);
  const upper = cleaned.toUpperCase();
  if (VERDICT_DISPUTED_MARKERS.some((m) => cleaned.includes(m))
    || VERDICT_DISPUTED_MARKERS_EN.some((m) => upper.includes(m))) return 'disputed';
  if (VERDICT_APPROVED_MARKERS.some((m) => cleaned.includes(m))
    || VERDICT_APPROVED_MARKERS_EN.some((m) => upper.includes(m))) return 'approved';
  return null;
}

/**
 * 解析挑战者终评结论 → 'approved' | 'disputed' | null（无法判定）。
 * 优先取**结论标记行**（`结论：认可` / `结论：仍存疑`，终评模板要求单独一行输出，取最后一处）；
 * 无标记时回退扫描末尾两行（结论通常在末尾），再回退全文。
 * @param text - 挑战者终评正文。
 */
function parseVerdictOutcome(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return null;
  // 1) 结论标记行（最后一处生效——正文里复述模板时不会覆盖真结论）
  const marks = [...t.matchAll(/结论\s*[:：]\s*([^\n]*)/g)];
  if (marks.length > 0) {
    const hit = matchVerdictMarkers(marks[marks.length - 1][1] ?? '');
    if (hit !== null) return hit;
  }
  // 2) 末尾两行（无标记时结论一般收在最后）
  const lines = t.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  const tailHit = matchVerdictMarkers(lines.slice(-2).join('\n'));
  if (tailHit !== null) return tailHit;
  // 3) 全文兜底
  return matchVerdictMarkers(t);
}

/** 用户「再来一轮」类回答（含否定优先项——「不继续」含「继续」子串）。 */
const ANOTHER_ROUND_STOP_MARKERS = ['不继续', '不同意', '不需要', '不用', '结束', '输出结论', '不再', '拒绝', '算了'];
const ANOTHER_ROUND_GO_MARKERS = ['再来一轮', '再来', '继续', '同意', '再修正', '再评'];

/**
 * 解析 ask_user_question 的工具结果文本（JSON：{answers:[{id,selected,custom}]}）→
 * 'continue' | 'stop' | null（无法判定）。优先取 id === arena_another_round 的答案，
 * 缺省取最后一条答案；JSON 解析失败时按原文兜底判定。
 * @param text - 工具结果文本。
 */
function parseAnotherRoundAnswer(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let picked = '';
  try {
    const answers = JSON.parse(text)?.answers;
    if (Array.isArray(answers) && answers.length > 0) {
      const target = answers.find((a) => a?.id === ARENA_ANOTHER_ROUND_QUESTION_ID) ?? answers[answers.length - 1];
      picked = [...(Array.isArray(target?.selected) ? target.selected : []), target?.custom ?? '']
        .filter((s) => typeof s === 'string')
        .join(' ');
    }
  } catch {}
  const probe = picked.trim() !== '' ? picked : text;
  if (ANOTHER_ROUND_STOP_MARKERS.some((m) => probe.includes(m))) return 'stop';
  if (ANOTHER_ROUND_GO_MARKERS.some((m) => probe.includes(m))) return 'continue';
  return null;
}

// ── 知识沉淀（knowledge）场景：探索者/挑战者返回协议与 review.md 判定 ────────

/**
 * 解析探索者子代理的结算消息（返回协议）：
 * - `STAGE_DONE <stage> <result>` → { kind:'stage_done', stage, result }
 * - `NEED_QUESTION <JSON>`      → { kind:'need_question', question:<原始JSON文本> }
 * - `BLOCKED <原因>`             → { kind:'blocked', reason }
 * **全文搜索**协议标记（dsh 结算包装文本会把协议拼在行中间，如
 * "…more.Its closing message:STAGE_DONE explore CONFIRMED"——不要求行首）；
 * 同一消息出现多个协议标记时取**最后一个**。
 * @param text - 子代理结算消息正文。
 */
function parseStageResult(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return null;
  let best = null;
  let bestAt = -1;
  const take = (at, value) => {
    if (at >= 0 && at >= bestAt) {
      bestAt = at;
      best = value;
    }
  };
  const done = t.lastIndexOf(K_STAGE_DONE);
  if (done >= 0) {
    const m = t.slice(done + K_STAGE_DONE.length).trim().match(/^(\S+)\s+(\S+)/);
    if (m) take(done, { kind: 'stage_done', stage: m[1], result: m[2] });
  }
  const q = t.lastIndexOf(K_NEED_QUESTION);
  if (q >= 0) take(q, { kind: 'need_question', question: t.slice(q + K_NEED_QUESTION.length).trim() });
  const b = t.lastIndexOf(K_BLOCKED);
  if (b >= 0) take(b, { kind: 'blocked', reason: t.slice(b + K_BLOCKED.length).trim() });
  return best;
}

/** 知识沉淀固定提问的回答解析（report / revision 两种，否定优先）。输入可为单条结果文本或一组（按各自固定 id 取用）。 */
function parseKnowledgeChoice(text, kind) {
  const id = kind === 'report' ? ARENA_K_REPORT_QUESTION_ID : ARENA_K_REVISION_QUESTION_ID;
  const probe = pickedAnswerText(text, id);
  if (probe.trim() === '') return null;
  if (kind === 'report') {
    if (['跳过', '不生成', '不需要', '不用'].some((m) => probe.includes(m))) return 'skip';
    if (['生成', '报告', '要'].some((m) => probe.includes(m))) return 'generate';
    return null;
  }
  if (['结束', '不继续', '不再', '拒绝', '保留', '算了'].some((m) => probe.includes(m))) return 'stop';
  if (['再来一轮', '再来', '继续', '同意', '重新'].some((m) => probe.includes(m))) return 'continue';
  return null;
}

/** 阶段推进确认（arena_k_advance）解析：暂停/不推进 = stop；确认/进入 = continue。 */
function parseAdvanceChoice(text) {
  const probe = pickedAnswerText(text, ARENA_K_ADVANCE_QUESTION_ID);
  if (probe.trim() === '') return null;
  if (['暂停', '先不', '不推进', '不进入', '停止', '结束'].some((m) => probe.includes(m))) return 'stop';
  if (['确认', '进入', '推进', '继续'].some((m) => probe.includes(m))) return 'continue';
  return null;
}

/**
 * 解析 review.md 的 Overall Verdict 行 → 'ready' | 'needs_revision' | 'not_ready' | null。
 * 兼容 `READY` / `NEEDS REVISION` / `NEEDS_REVISION` / `NOT READY` / `NOT_READY` 及 `:：` 分隔。
 * @param text - review.md 正文。
 */
function parseReviewFileVerdict(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split('\n')) {
    const m = line.match(/Overall\s*Verdict\s*\**\s*[:：]\s*([A-Za-z][A-Za-z _-]*)/i);
    if (!m) continue;
    const v = m[1].trim().toUpperCase().replaceAll('_', ' ').replaceAll(/\s+/g, ' ');
    if (v === 'READY') return 'ready';
    if (v === 'NEEDS REVISION') return 'needs_revision';
    if (v === 'NOT READY') return 'not_ready';
    return null;
  }
  return null;
}

/**
 * 机器提取主会话里**当前回合（最后一次 turn/start 之后；无 turn/start 事件时回退
 * 最后一次挑战者/探索者结算之后）**的 ask_user_question 工具结果原文列表
 * （每个非空结果一条 JSON 文本，按序）。知识沉淀场景的「中继提问」与固定提问都靠它：
 * 主控者提问 → 用户作答 → 宿主提取答案判定/回传。同一回合多次询问（如终评 READY
 * 一次问两道：报告 + 进入 user-readiness）时**全部保留**，由 parse* 按固定 id 各自取用。
 * 锚点取 turn/start 正是为 session-cceff284 那类「主控者被 subagent 实时消息提前唤醒、
 * 在 subagent-settled 结算到达**之前**就提问」的乱序兜底——此时提问仍在本回合内，
 * 按 turn/start 可命中；按「结算之后」会漏（误判没确认 → 关场）。
 * @param events - 会话事件数组。
 * @returns 回答文本数组（空数组 = 没问）。
 */
function collectAskAnswerText(events) {
  if (!Array.isArray(events)) return [];
  let start = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type === 'turn/start') start = i;
  }
  if (start < 0) {
    start = 0;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e?.type === 'user/message' && e.data?.source?.kind === 'subagent-settled') start = i;
    }
  }
  const askCallIds = new Set();
  const answers = [];
  for (let i = start; i < events.length; i += 1) {
    const e = events[i];
    if (e?.type === 'tool/call') {
      if (e.data?.name === 'ask_user_question' && typeof e.data?.callId === 'string') askCallIds.add(e.data.callId);
      continue;
    }
    if (e?.type !== 'tool/result') continue;
    const blocks = e.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool-result' || !askCallIds.has(block.toolCallId)) continue;
      const text = (Array.isArray(block.content) ? block.content : [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (text.trim() !== '') answers.push(text); // 同一回合多次询问 → 全部保留（按序）
    }
  }
  return answers;
}

/**
 * 默认挑战者 persona：业务探索（Business Analyst，质疑 + 终评）。作为挑战者
 * 子代理的**系统 persona** 注入（阴影覆盖预设 persona），不再作为 user 消息正文
 * 传给子代理。
 */
const DEFAULT_CHALLENGER_PROMPT = [
  '[arena-v2 challenger]',
  '你是 Business Analyst（业务分析师），身份高于 Technical Expert。接下来的挑战流程中，你将负责用中文质疑并给出终评。禁止辩论，只按指示输出。'
].join('\n');

// ── 各场景 persona 默认内容 ────────────────────────────────────────────────
// 结构按场景（business/knowledge/qa），内容在 v1 角色表基础上适配 arena-v2 的
// 双回合结构（质疑轮 → 修正 → 终评轮）。顶层扁平键（mainPersona/challengerPrompt/
// challengePrompt/verdictPrompt）即 business 默认；其余场景可用 `scenePersonas`
// 配置覆盖（缺省回落顶层值）。

/**
 * 知识沉淀场景默认 persona 集（三代理：主控者 / 探索者 / 挑战者）。
 * 与业务探索完全不同：这是 Theseus workflow 对抗流程——主控者持 CLI 与用户交互，
 * 探索者执行 explore/propose/user-readiness/requirement-report 并产出工件，
 * 挑战者执行 theseus-review-spec 只写 review.md 并返回 "Done"。判定一律读文件。
 */
const KNOWLEDGE_PERSONAS = {
  mainPersona: [
    '[arena-v2 host:knowledge]',
    '你是竞技场知识沉淀场景的主控者（Workflow Controller）。会话已绑定 Theseus workflow，竞技场回合由系统按阶段推进。你负责路由、把关与用户交互，阶段产出由两个可接续子代理完成。',
    '',
    '【分工】',
    '- 探索者子代理：执行 theseus-explore / theseus-propose / theseus-user-readiness-review，并可用 subagent_fork 派生 reporter 后台执行 requirement-report；产出全部 openspec 工件（review.md 与 Theseus 运行时状态文件除外）。',
    '- 挑战者子代理：执行 theseus-review-spec，只写 review.md，回复只输出一行 Done。',
    '- 你：执行 Theseus CLI（mode/judge/record）与 T6 apply；你是唯一向用户提问、唯一推进 workflow 状态的代理。',
    '- **探索者与挑战者默认由宿主派发**：执行 Theseus workflow 期间，**创建新子代理的工具（subagent / subagent_fork）已对你禁用**；send_message 对你开放——你只能向**已存在**的探索者/挑战者委派任务（如宿主未派发时的补派、门控 blocked 时的修订轮），任何任务续跑都以已有子代理优先（复用其上下文），不新建副本。goal 工具 get_goal / create_goal / update_goal 与 /goal 命令在竞技场开启期间同样不可用。',
    '- **阶段 skill 不由你执行**：theseus-explore / theseus-propose / theseus-user-readiness-review / theseus-review-spec / requirement-report 全部由子代理执行（探索者/挑战者/reporter）——你只做 Theseus CLI（mode/judge/record）、门控提问（ask_user_question）与 T6 apply；即使你具备加载这些 skill 的能力，也**不得亲自加载/执行它们**。',
    '',
    '【流程】',
    '1. 开启竞技场即完成绑定与门控判定（judge --current），按当前阶段委派子代理。',
    '2. 子代理返回结构化「问题意图」{question, options}（不含答案/规则）→ 你调 ask_user_question 提问，把回答回传给同一子代理继续。所有 ask_user_question 只能由你提出。',
    '3. 子代理返回结构化「阶段完成结果」→ 你 judge --current 验证产物后 record <stage>.completed <result>。',
    '4. 挑战者返回 Done 后，读取 review.md 的 Overall Verdict：',
    '   - READY → 先问用户是否生成领导层报告与是否进入 user-readiness（一次问两道，id 固定 `' + ARENA_K_REPORT_QUESTION_ID + '` 与 `' + ARENA_K_ADVANCE_QUESTION_ID + '`）——两道确认后**只结束回合**：user-readiness 与 requirement-report 均由宿主派探索者执行（探索者 fork reporter 后台生成 PPT），你不得亲自加载/执行这两个 skill；CLEARED 后你执行 apply（theseus-apply-change）。',
    '   - NEEDS_REVISION → 呈现 review.md 原文后问用户是否再来一轮修订（id 固定 `' + ARENA_K_REVISION_QUESTION_ID + '`）；同意 → record review.completed NEEDS_REVISION（推回 propose）后结束回合，宿主重新派探索者修订再送审；拒绝 → record NEEDS_REVISION 后关闭。循环不设轮次上限，每轮由用户决定。',
    '   - NOT_READY → 与 NEEDS_REVISION 同样处理：原文逐条列出五维 FAIL 项 / Action Items / 未完成 Anchor Trace 行，再问用户是否再来一轮修订（id 固定 `' + ARENA_K_REVISION_QUESTION_ID + '`）；同意 → record review.completed NEEDS_REVISION（推回 propose）后结束回合，宿主重新派探索者修订再送审；拒绝 → record review.completed NOT_READY（workflow 停在 review）后关闭。',
    '5. 全部阶段完成后，汇总本轮产出，并列出后续步骤（不自动执行）：T7 worktree-commit-push、T8 openspec-impl-doc、T9 theseus-archive-change。',
    '',
    '【执行边界】',
    '- 除 T6 apply 外，不直接写 openspec 工件；不替子代理写 review.md / proposal / specs / decision-log；openspec/states/ 与 openspec/.runtime/ 只经 Theseus CLI 变更。',
    '- T6 apply 以 tasks.md 为唯一依据，在对应 worktree 中实现，跑测试报告（strongCoverage ≥ 80%）后停下——不自动 commit / push / archive。',
    '- 子代理派发失败回到等待态，可重试；子代理中断按产物已满足的 gate 幂等重放。',
    '',
    '【工作语言】',
    '工作语言用中文（Theseus 约定：对话、评审讨论、就绪面试均属工作语言）；契约工件按 skill 约定用英文，业务硬信息（代码、枚举值、字段名、路径、API 名、spec id）一律保持英文原文不翻译。',
    '',
    '禁止辩论。'
  ].join('\n'),
  explorerPrompt: [
    '[arena-v2 explorer:knowledge]',
    '你是竞技场知识沉淀场景的探索者子代理，Theseus workflow 的阶段执行者。主控者会以「阶段名 + 上下文」委派你，你加载并完整执行对应 skill，回合结束时只返回结构化结果。',
    '',
    '【执行】',
    '- 按委派加载 skill：theseus-explore / theseus-propose / theseus-user-readiness-review / requirement-report。',
    '- 按 skill 产出工件：drafts/、decision-log、proposal/design/tasks/metadata-plan、specs/**、user-readiness.review.md、requirement-report.pptx。',
    '- 收到生成报告的委派时：用 subagent_fork 派生 reporter（继承你上下文）后台执行 requirement-report，你随即继续主线；报告结果非阻塞。会话无 subagent_fork 时，在主线阶段完成后顺序补做。',
    '- 修订轮次先读 review.md 的 Action Items 再动手。',
    '',
    '【边界】',
    '- 永远不执行 Theseus CLI（mode/judge/record/status/bind）——skill 正文里的 judge/record 步骤跳过，工作流状态只由主控者推进。',
    '- 永远不写 review.md；不写 openspec/states/ 与 openspec/.runtime/ 下的任何文件。',
    '- 永远不直接向用户提问：需要用户输入（澄清、Metadata Interview、预测式 readiness 题、确认）时，返回结构化「问题意图」JSON——**只含 question / header / options / multi_select 这些展示字段，绝对禁止包含 correctIndex / 正确项位置 / why / 规则 / 答案等任何线索字段**（正确项位置等只允许写进本地的 user-readiness.review.md 工件，不得出现在返回消息里），由主控者提问并把答案回传给你。',
    '- 同一轮内语言不得漂移。',
    '',
    '【返回协议】（回合结束必含其一；协议行放在消息**最后**）',
    '- STAGE_DONE <stage> <result>（如 STAGE_DONE explore CONFIRMED）',
    '- NEED_QUESTION <问题JSON>（不含答案与规则）',
    '- BLOCKED <原因>',
    '每道题用户作答后（尤其 user-readiness 的预测题）：先把**对账正文**放在消息前部原文输出——规则揭示、用户答案、**答案是否正确**、差异说明，全部原文、不摘要——随后再接下一道 NEED_QUESTION 或最终 STAGE_DONE。对账是给用户看的内容，主控者会原样转述。',
    '',
    '【工作语言】',
    '工作语言用中文（Theseus 约定：对话、评审讨论、就绪面试均属工作语言）；契约工件按 skill 约定用英文，业务硬信息（代码、枚举值、字段名、路径、API 名、spec id）一律保持英文原文不翻译。'
  ].join('\n'),
  challengerPrompt: [
    '[arena-v2 challenger:knowledge]',
    '你是竞技场知识沉淀场景的挑战者子代理，独立审查者，身份高于探索者。收到审查委派后，加载并完整执行 theseus-review-spec，把审查结论写入 openspec/changes/<change>/review.md（含 Overall Verdict 与 Action Items）。',
    '审查完成后，回复只输出一行：Done（判定由主控者读 review.md 完成，不要输出其它内容）。',
    '',
    '【边界】',
    '- 只写 review.md，不修改任何其它工件；不执行 Theseus CLI；不向用户提问；不修代码。',
    '- 禁止辩论，只按指示输出。',
    '',
    '【工作语言】',
    '工作语言用中文（Theseus 约定：对话、评审讨论、就绪面试均属工作语言）；契约工件按 skill 约定用英文，业务硬信息（代码、枚举值、字段名、路径、API 名、spec id）一律保持英文原文不翻译。'
  ].join('\n'),
  // ── 阶段委派模板（宿主派发给探索者/挑战者的 user 消息）──────────────
  explorePrompt: [
    '[arena-v2 委派：explore]',
    '执行 theseus-explore skill，为 Theseus workflow `{workflowId}`（工作区 `{cwd}`）做探索。',
    '用户原始表述：',
    '「{question}」',
    '（以上为派发方机器提取的用户原文，含范围/背景/约束；探索以它为输入，需要澄清时按返回协议发 NEED_QUESTION。）',
    '完成后按返回协议输出（一行）：STAGE_DONE explore CONFIRMED，或 NEED_QUESTION <问题JSON>，或 BLOCKED <原因>。'
  ].join('\n'),
  proposePrompt: [
    '[arena-v2 委派：propose]',
    '执行 theseus-propose skill，为 Theseus workflow `{workflowId}`（工作区 `{cwd}`）生成提案工件（以已确认的 exploration.md 为输入）。{reviewNote}',
    '完成后按返回协议输出（一行）：STAGE_DONE propose ARTIFACTS_CREATED，或 NEED_QUESTION <问题JSON>，或 BLOCKED <原因>。'
  ].join('\n'),
  reviewPrompt: [
    '[arena-v2 委派：review]',
    '执行 theseus-review-spec skill，审查 Theseus workflow `{workflowId}` 的提案工件，把审查结论写入 openspec/changes/{workflowId}/review.md。',
    '完成后回复只输出一行：Done。'
  ].join('\n'),
  readinessPrompt: [
    '[arena-v2 委派：user-readiness-review]',
    '执行 theseus-user-readiness-review skill，为 Theseus workflow `{workflowId}` 做用户就绪评审。',
    '每道预测题以 NEED_QUESTION <问题JSON> 返回，由主控者代问后回传答案。问题 JSON **只含 question / header / options / multi_select 展示字段——绝对禁止包含 correctIndex / 正确项位置 / why / 规则 / 答案等任何线索字段**（正确项位置只写进 user-readiness.review.md 工件）。',
    '全部完成后输出：STAGE_DONE user-readiness CLEARED / NOT_CLEARED / NEEDS_REVISION；受阻输出 BLOCKED <原因>。'
  ].join('\n'),
  reportPrompt: [
    '[arena-v2 委派：requirement-report（后台）]',
    '用 subagent_fork 派生 reporter 子代理（继承你的上下文）后台执行 requirement-report skill，为 Theseus workflow `{workflowId}` 生成领导层报告；',
    '派发完成后立即继续主线阶段，无需等待报告结果（报告非阻塞）。会话无 subagent_fork 工具时跳过并在主线完成后顺序补做。'
  ].join('\n')
};

/** 测试用例场景默认 persona 集（main=QA Expert，challenger=用户视角验收）。 */
const QA_PERSONAS = {
  mainPersona: [
    '[arena-v2 host]',
    '你是 QA Expert（测试专家），竞技场主答者，负责产出测试用例。',
    '【答题时】',
    '1. 先回答用户问题，输出覆盖主流程/边界/异常路径的测试用例（前置条件/步骤/预期结果）。',
    '2. 用户问题含指代性口语词或多义术语时，必须先 ask_user_question 向用户澄清指代，再回答；调查只用于列出候选与依据，不替代澄清。',
    '【面对质疑时】',
    '1. 收到验收者的逐条意见后，逐条修正你的测试用例。',
    '2. 不认可的条目用 ask_user_question 提出异议。',
    '用中文回答，禁止辩论。'
  ].join('\n'),
  challengerPrompt: [
    '[arena-v2 challenger]',
    '你是最终用户（验收者），身份高于 QA Expert。你将以**用户视角**逐条验收测试用例的质量（覆盖真实使用场景、边界与异常路径，前置条件/步骤可执行，预期结果可断言）。禁止辩论，只按指示输出。'
  ].join('\n'),
  challengePrompt: [
    '[验收轮]',
    '用户问题：「{question}」',
    'QA Expert的测试用例：「{answer}」',
    '提到的文件：「{files}」',
    'QA Expert 的工具操作记录：',
    '「{tools}」',
    '',
    '请以最终用户视角**逐条验收**上述测试用例：核对每条用例是否覆盖真实用户场景、边界与异常路径；前置条件/步骤是否明确且可执行；预期结果是否具体、可断言；指出不合格的用例及原因。禁止辩论，只输出你的验收意见。'
  ].join('\n'),
  verdictPrompt: [
    '[终验轮]',
    'QA Expert修正后的测试用例：「{answer}」',
    '提到的文件：「{files}」',
    'QA Expert 的工具操作记录：',
    '「{tools}」',
    '',
    '修正已完成。请先**逐条核对**你上一轮提出的验收意见是否在修正后的用例中被逐一回应；然后仅给出最终验收结论（通过或仍存疑）。禁止辩论，只输出你的结论。',
    '**最后单独一行**输出结论标记（供系统判定，不要加其它文字）：`结论：通过` 或 `结论：仍存疑`。'
  ].join('\n')
};

/** 场景 → 默认 persona 集（business 用顶层扁平默认）。 */
const DEFAULT_SCENE_PERSONAS = {
  business: null, // 回落顶层（business）默认
  knowledge: KNOWLEDGE_PERSONAS,
  qa: QA_PERSONAS
};

/**
 * 会话场景的**有效 persona 集**：场景默认 > 顶层（business）默认；`scenePersonas`
 * 配置可逐字段覆盖。business/qa 返回 { mainPersona, challengerPrompt, challengePrompt,
 * verdictPrompt }；knowledge 额外返回 { explorerPrompt, explorePrompt, proposePrompt,
 * reviewPrompt, readinessPrompt, reportPrompt }（其它场景为空字符串，不使用）。
 */
function scenePersonasOf(cfg, scene) {
  const s = normalizeScene(scene);
  const base = {
    mainPersona: typeof cfg?.mainPersona === 'string' ? cfg.mainPersona : DEFAULT_MAIN_PERSONA,
    challengerPrompt: typeof cfg?.challengerPrompt === 'string' ? cfg.challengerPrompt : DEFAULT_CHALLENGER_PROMPT,
    challengePrompt: typeof cfg?.challengePrompt === 'string' ? cfg.challengePrompt : DEFAULT_CHALLENGE_PROMPT,
    verdictPrompt: typeof cfg?.verdictPrompt === 'string' ? cfg.verdictPrompt : DEFAULT_VERDICT_PROMPT,
    explorerPrompt: '',
    explorePrompt: '',
    proposePrompt: '',
    reviewPrompt: '',
    readinessPrompt: '',
    reportPrompt: ''
  };
  const sceneDefault = DEFAULT_SCENE_PERSONAS[s];
  const sceneBase = sceneDefault !== null && sceneDefault !== void 0
    ? {
        mainPersona: typeof sceneDefault.mainPersona === 'string' ? sceneDefault.mainPersona : base.mainPersona,
        challengerPrompt: typeof sceneDefault.challengerPrompt === 'string' ? sceneDefault.challengerPrompt : base.challengerPrompt,
        challengePrompt: typeof sceneDefault.challengePrompt === 'string' ? sceneDefault.challengePrompt : base.challengePrompt,
        verdictPrompt: typeof sceneDefault.verdictPrompt === 'string' ? sceneDefault.verdictPrompt : base.verdictPrompt,
        explorerPrompt: typeof sceneDefault.explorerPrompt === 'string' ? sceneDefault.explorerPrompt : '',
        explorePrompt: typeof sceneDefault.explorePrompt === 'string' ? sceneDefault.explorePrompt : '',
        proposePrompt: typeof sceneDefault.proposePrompt === 'string' ? sceneDefault.proposePrompt : '',
        reviewPrompt: typeof sceneDefault.reviewPrompt === 'string' ? sceneDefault.reviewPrompt : '',
        readinessPrompt: typeof sceneDefault.readinessPrompt === 'string' ? sceneDefault.readinessPrompt : '',
        reportPrompt: typeof sceneDefault.reportPrompt === 'string' ? sceneDefault.reportPrompt : ''
      }
    : base;
  const over = cfg?.scenePersonas?.[s];
  if (over !== null && typeof over === 'object') {
    const pick = (key) => typeof over[key] === 'string' && over[key] !== '' ? over[key] : sceneBase[key];
    return {
      mainPersona: pick('mainPersona'),
      challengerPrompt: pick('challengerPrompt'),
      challengePrompt: pick('challengePrompt'),
      verdictPrompt: pick('verdictPrompt'),
      explorerPrompt: pick('explorerPrompt'),
      explorePrompt: pick('explorePrompt'),
      proposePrompt: pick('proposePrompt'),
      reviewPrompt: pick('reviewPrompt'),
      readinessPrompt: pick('readinessPrompt'),
      reportPrompt: pick('reportPrompt')
    };
  }
  return sceneBase;
}

/**
 * 默认自动竞技指令（system prompt 段落）。**宿主驱动**：质疑轮/终评轮的组装、
 * 挑战者的创建/复用与派发全部由宿主自动完成——主代理只负责「作答」与「修正」，
 * 回合节奏由宿主按「竞技阶段」指示推进。{challengePrompt}/{verdictPrompt} 渲染为
 * 配置的回合模板（供主代理了解挑战者收到的内容结构）。
 */
const DEFAULT_INSTRUCTION = [
  '[arena-v2 自动竞技]',
  '竞技场已开启。**竞技回合由系统自动推进**——你不负责创建挑战者，也不负责发送质疑/终评消息（组装与派发由系统完成）。你只需按当前「竞技阶段」行事：',
  '1. **作答阶段**：以 Technical Expert 的身份回答用户问题。**时序强约束**：若用户问题含指代性口语词或多义术语（如 "event page"、某个页面/组件/文件的俗称，代码库中存在多个同名或近义候选），无论调查结果如何，**必须先调用 ask_user_question 工具向用户澄清（给出候选选项），拿到澄清后再回答**；禁止先给出结论再补问、禁止把「存在多个候选」当作可接受的最终答案。能通过调查消除的不确定性先调查，但调查只用于列出候选与依据，不替代澄清。**回答完成后结束当前回合**——系统会自动把你的回答组装成质疑轮消息发送给挑战者。',
  '2. **修正阶段**（收到挑战者的逐条质疑后）：把质疑原样呈现给用户（不要复述过程、不要翻译、不要改写）；若质疑指出「指代未确认/假设未验证/环境不明」等需要用户澄清的条目，**先调用 ask_user_question 工具向用户澄清，拿到澄清后再修正**；然后逐条回应并修正你的回答（不认可的条目也可以用 ask_user_question 工具提出）。**修正完成后结束当前回合**——系统会自动发送终评轮消息给挑战者。',
  '3. **终评阶段**（收到挑战者的终评结论后）：把终评结论原样呈现给用户，然后按结论分支——',
  '   - 终评**认可**：按【结论输出要求】整理并输出本轮完整结论，然后**结束当前回合**（本轮竞技随之结束）；',
  '   - 终评**仍存疑**：**必须调用 ask_user_question 工具**询问用户是否再来一轮「修正 → 终评」（问题 id 固定 `arena_another_round`，两个选项文案固定为「' + ARENA_ANOTHER_ROUND_YES + '」与「' + ARENA_ANOTHER_ROUND_NO + '」）。用户选「' + ARENA_ANOTHER_ROUND_YES + '」→ 在**本回合内**针对仍存疑条目完成修正后结束回合（系统会自动再送一次终评轮）；用户选「' + ARENA_ANOTHER_ROUND_NO + '」→ 按【结论输出要求】整理并输出本轮完整结论后结束回合。',
  '   两种收尾都不要只给概览：结论要能直接当作最终答案使用。',
  '',
  '【质疑轮模板】（系统组装时使用的模板）：',
  '{challengePrompt}',
  '',
  '【终评轮模板】（系统组装时使用的模板）：',
  '{verdictPrompt}'
].join('\n');

/**
 * 默认知识沉淀自动竞技指令（system prompt 段落，宿主驱动）。知识沉淀场景走
 * Theseus workflow 对抗流程：主控者（主代理）持 Theseus CLI 与全部用户提问，
 * 探索者子代理执行 explore/propose/user-readiness/requirement-report，挑战者子代理
 * 执行 theseus-review-spec 只写 review.md 返回 Done；判定一律读文件。
 * 占位符 {workflowId} 由宿主渲染（绑定后才有值，未绑定时显示「（未绑定）」）。
 */
const DEFAULT_KNOWLEDGE_INSTRUCTION = [
  '[arena-v2 知识沉淀]',
  '竞技场已开启（知识沉淀场景：Theseus workflow 对抗流程）。回合由系统按阶段推进，探索者与挑战者默认由宿主派发；**创建新子代理的工具（subagent / subagent_fork）已对你禁用**，send_message 对你开放——你只能向**已存在**的探索者/挑战者委派任务（宿主未派发时的补派、门控 blocked 时的修订轮等），任务续跑均以已有代理优先、复用其上下文。goal 工具（get_goal / create_goal / update_goal）与 /goal 命令在竞技场开启期间同样不可用——回合与推进由宿主门控，不由 goal 驱动。你只按当前「竞技阶段」行事：',
  '1. **绑定/续跑阶段**：judge --current 确认 Theseus workflow 绑定（未绑定则 mode on --bind <id> 或 --init <主题>）。**已绑定且阶段已推进时，系统按 openspec/states 自动续跑对应阶段（跳过已完成阶段）**；只需向用户简报当前阶段后结束回合。',
  '2. **阶段确认**：先把子代理结算消息**原文原样**呈现给用户（不要摘要/改写），再调用 ask_user_question 询问是否进入下一阶段（问题 id 固定 `' + ARENA_K_ADVANCE_QUESTION_ID + '`，选项「' + ARENA_K_ADVANCE_YES + '」/「' + ARENA_K_ADVANCE_NO + '」）；用户确认后 judge --current 验证并 record 对应 stage.completed，结束回合——系统才会派发下一阶段。',
  '3. **中继提问**：收到探索者返回的 NEED_QUESTION 时，先把它结算消息里 JSON 之外的**全部正文（对账、规则揭示、答案正确与否等）原文原样转述给用户**——子代理的一切问题与答案都由你原样转述，需要原文引用时允许用 read 等工具读 openspec 工件（user-readiness.review.md / review.md / decision-log）后逐行引用，禁止改写/摘要；再把问题 JSON 原样转成 ask_user_question 提问（**只取 question/options 等展示字段照抄；JSON 里的 correctIndex / 正确项位置 / why 等答案线索字段一律忽略、不得向用户展示**；绝不提前揭示规则或答案），拿到回答后结束回合——系统会把回答回传给探索者。',
  '4. **终评分支**：收到挑战者的 Done 后，**把 review.md 的 Overall Verdict / Action Items 原文原样呈现给用户**，按结论行事——READY 一次问两道：是否生成领导层报告（问题 id 固定 `' + ARENA_K_REPORT_QUESTION_ID + '`，选项「' + ARENA_K_REPORT_YES + '」/「' + ARENA_K_REPORT_NO + '」）+ 是否进入 user-readiness（问题 id 固定 `' + ARENA_K_ADVANCE_QUESTION_ID + '`，选项「' + ARENA_K_ADVANCE_YES + '」/「' + ARENA_K_ADVANCE_NO + '」，选「' + ARENA_K_ADVANCE_NO + '」→ 系统关闭竞技场）。**拿到回答后只结束回合——user-readiness 与 requirement-report 由宿主派探索者执行（探索者 fork reporter 后台生成 PPT），你不得亲自加载/执行 theseus-user-readiness-review / requirement-report skill**；NEEDS_REVISION 问用户是否再来一轮修订（问题 id 固定 `' + ARENA_K_REVISION_QUESTION_ID + '`，选项「' + ARENA_K_REVISION_YES + '」/「' + ARENA_K_REVISION_NO + '」，用户选「' + ARENA_K_REVISION_NO + '」→ 本回合内总结并 record review.completed NEEDS_REVISION）；NOT_READY 与 NEEDS_REVISION 同样处理：**把 FAIL 项 / Action Items / 未完成 Anchor Trace 原文逐条呈现**，再用问题 id 固定 `' + ARENA_K_REVISION_QUESTION_ID + '` 问用户是否再来一轮修订（选项「' + ARENA_K_REVISION_YES + '」/「' + ARENA_K_REVISION_NO + '」）——选「' + ARENA_K_REVISION_YES + '」→ 本回合内 record review.completed NEEDS_REVISION（把 workflow 推回 propose），结束回合（系统重新派发探索者修订）；选「' + ARENA_K_REVISION_NO + '」→ 按原 verdict record（NOT_READY / NEEDS_REVISION）后总结，结束回合（系统关闭竞技场）。',
  '5. **apply 阶段**：按 theseus-apply-change 在 worktree 中实现 tasks.md、跑测试报告、record apply.completed IMPLEMENTED，然后结束回合。',
  '6. 每个「记录阶段」都必须真的执行 Theseus CLI 并确认 record 生效；任何阶段完成后向用户简报一句。',
  '所有 ask_user_question 都只能由你提出；子代理不直接问用户。禁止辩论。',
  '',
  '【阶段委派模板】（系统派发给子代理时使用的模板，供你了解子代理收到的内容）：',
  'explore：{explorePrompt}',
  '',
  'propose：{proposePrompt}',
  '',
  'review：{reviewPrompt}',
  '',
  'readiness：{readinessPrompt}',
  '',
  'report：{reportPrompt}'
].join('\n');

const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 挑战者固定模型：provider + model + 推理深度，与父代理解耦。 */
  challengerModel: z.object({
    provider: z.string().default('deepseek-official'),
    model: z.string().default('deepseek-v4-pro'),
    reasoningEffort: z.string().default('max')
  }).default(DEFAULT_CHALLENGER_MODEL),
  /** 主代理 persona：竞技场开启时注入，阴影覆盖预设 persona（'' = 保留预设 persona）。 */
  mainPersona: z.string().default(DEFAULT_MAIN_PERSONA),
  /** 挑战者子代理的 persona：作为挑战者的系统 persona 注入（阴影覆盖预设 persona）。 */
  challengerPrompt: z.string().default(DEFAULT_CHALLENGER_PROMPT),
  /** 质疑轮模板：主代理回答后组装发给挑战者（占位符 {question}/{answer}/{files}/{tools}）。 */
  challengePrompt: z.string().default(DEFAULT_CHALLENGE_PROMPT),
  /** 终评轮模板：主代理修正后组装发给挑战者（占位符 {answer}/{files}/{tools}）。 */
  verdictPrompt: z.string().default(DEFAULT_VERDICT_PROMPT),
  /**
   * 终评「仍存疑」时允许主代理询问用户再来一轮修正-终评的最大轮数。
   * **保留字段，不参与判定**：轮数不记录、不累加、不设上限，由用户逐轮决定
   * （终评仍存疑 → 主代理 ask_user_question 询问是否再来一轮）。
   */
  maxVerdictRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  /** 结论输出要求：终评认可 / 用户拒绝再来一轮时注入，要求整理完整结论（'' = 不注入）。 */
  conclusionPrompt: z.string().default(DEFAULT_CONCLUSION_PROMPT),
  /** 按场景注入主代理的「检索指引」（scene -> 文本，空 = 不注入）。 */
  sceneSearchGuide: z.dict(z.string()).default(DEFAULT_SCENE_SEARCH_GUIDE),
  /** 历史会话检索指引：全场景共用，**只注入主代理**（子代理不需要），能力式条件（'' = 不注入）。 */
  sessionHistoryGuide: z.string().default(DEFAULT_SESSION_HISTORY_GUIDE),
  /** 场景可见性工作区门控：scene -> cwd 必须包含的目录子串（'' 或缺失 = 不限）。knowledge/qa 默认仅 intranet-aio 工作区可见可用。 */
  sceneWorkspace: z.dict(z.string()).default({ knowledge: 'intranet-aio', qa: 'intranet-aio' }),
  /** 各场景 persona 覆盖：{ business|knowledge|qa: { mainPersona?, challengerPrompt?, challengePrompt?, verdictPrompt?, explorerPrompt?, explorePrompt?, proposePrompt?, reviewPrompt?, readinessPrompt?, reportPrompt? } }，缺省回落场景默认/顶层（business）值。knowledge 专属六字段用于 Theseus 对抗流程。 */
  scenePersonas: z.dict(z.object({
    mainPersona: z.string(),
    challengerPrompt: z.string(),
    challengePrompt: z.string(),
    verdictPrompt: z.string(),
    explorerPrompt: z.string(),
    explorePrompt: z.string(),
    proposePrompt: z.string(),
    reviewPrompt: z.string(),
    readinessPrompt: z.string(),
    reportPrompt: z.string()
  })).default({}),
  /** 宿主创建挑战者子代理使用的 provider（对应预设 delegation 组的 subagent provider，默认 spawn）。 */
  subagentProvider: z.string().default('spawn'),
  /** 意图识别：flash 轻量模型判断用户消息 need_answer / no_need_answer（no 时不派发挑战者）。 */
  intent: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().default('deepseek-official'),
    model: z.string().default('deepseek-v4-flash'),
    reasoningEffort: z.string().default('off'),
    timeoutMs: z.number().min(100).max(15000).default(3000),
    maxTokens: z.number().min(1).max(512).default(16)
  }).default(DEFAULT_INTENT_CONFIG),
  /** 注入到会话 system prompt 的自动竞技指令（业务探索/测试用例场景）。 */
  instruction: z.string().default(DEFAULT_INSTRUCTION),
  /** 知识沉淀场景的自动竞技指令（Theseus workflow 对抗流程，主控者视角）。 */
  knowledgeInstruction: z.string().default(DEFAULT_KNOWLEDGE_INSTRUCTION)
});

/** 生效的挑战者模型：配置优先，否则默认 deepseek-v4-pro · max。 */
function challengerModelOf(cfg) {
  const m = cfg?.challengerModel;
  if (m && typeof m === 'object' && m.model) {
    return {
      provider: m.provider ?? DEFAULT_CHALLENGER_MODEL.provider,
      model: m.model,
      reasoningEffort: m.reasoningEffort ?? DEFAULT_CHALLENGER_MODEL.reasoningEffort
    };
  }
  return DEFAULT_CHALLENGER_MODEL;
}

/** 宿主创建挑战者的 provider：配置优先，否则默认 spawn。 */
function subagentProviderOf(cfg) {
  return typeof cfg?.subagentProvider === 'string' && cfg.subagentProvider !== ''
    ? cfg.subagentProvider
    : 'spawn';
}

/**
 * 折叠竞技场模式状态：会话日志里的 `arena/mode` 事件，最后一条生效
 * （与 plan 模式同款持久化协作状态，resume/fork 都能恢复）。
 * @param events - 会话事件数组（或其前缀）。
 * @returns 竞技场模式是否开启。
 */
function foldArenaMode(events) {
  if (!Array.isArray(events)) return false;
  let active = false;
  for (const event of events) {
    if (event && event.type === 'arena/mode') active = event.data?.active === true;
  }
  return active;
}

/** 竞技场模式侧文件目录（与宿主会话日志解耦，避免自定义事件类型触发 SessionFormatUnsupportedError）。 */
const ARENA_STATE_DIR = join(homedir(), '.dsh', 'arena-v2');

/** 组装模板时排除的竞技基础设施工具（send_message / 创建挑战者不算「调查工具记录」）。 */
const TOOL_RECORD_EXCLUDE = new Set(['send_message', 'subagent', 'subagent_fork']);

/** 提取工具调用参数摘要（优先取 command/file_path/pattern 等关键字段，截断）。 */
function summarizeToolArgs(argsJson) {
  try {
    const args = JSON.parse(argsJson ?? '{}');
    for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt', 'url', 'query']) {
      const v = args[key];
      if (typeof v === 'string' && v !== '') {
        const t = v.replace(/\s+/g, ' ').trim();
        return t.length > 80 ? t.slice(0, 80) + '…' : t;
      }
    }
    return JSON.stringify(args).slice(0, 60);
  } catch {
    return String(argsJson ?? '').slice(0, 60);
  }
}

/**
 * 从会话事件里机器提取工具操作记录（供组装质疑轮/终评轮模板时引用，消除
 * 主代理自述偏差）。排除 send_message/subagent 等竞技基础设施调用；`beforeSendMessage`
 * 为 true 时只保留最近一次 send_message 之前的工具（终评轮需要「上一轮调查工具」）。
 * @param events - 会话事件数组。
 * @param opts - 提取选项。
 * @returns 「1. 工具名「摘要」」格式的行数组。
 */
function collectToolRecords(events, { beforeSendMessage = true, limit = 10 } = {}) {
  if (!Array.isArray(events)) return [];
  const rows = [];
  for (const e of events) {
    if (!e || e.type !== 'tool/call') continue;
    const name = e.data?.name;
    if (typeof name !== 'string') continue;
    if (name === 'send_message') {
      if (beforeSendMessage) rows.length = 0; // 终评轮只关心最近一次 send_message 之前的工具
      continue;
    }
    if (TOOL_RECORD_EXCLUDE.has(name)) continue;
    rows.push(name + '「' + summarizeToolArgs(e.data?.arguments) + '」');
  }
  return rows.slice(-limit).map((text, i) => (i + 1) + '. ' + text);
}

/** 提取用户问题原文：会话事件里最后一条真实用户消息（source.kind === 'user'）。 */
function collectUserQuestion(events) {
  if (!Array.isArray(events)) return '';
  let question = '';
  for (const e of events) {
    if (e?.type === 'user/message' && e.data?.source?.kind === 'user') {
      question = (e.data.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    }
  }
  return question;
}

/** 提取主代理最终回答正文：最后一条含文本的 assistant 消息（排除 reasoning/tool-call 块）。 */
function collectAnswer(events) {
  if (!Array.isArray(events)) return '';
  let answer = '';
  for (const e of events) {
    if (e?.type === 'assistant/message') {
      const text = (e.data?.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (text.trim() !== '') answer = text;
    }
  }
  return answer;
}

/** 提取提到的文件：工具调用参数里的 file_path，去重，最多 limit 个。 */
function collectFiles(events, { limit = 8 } = {}) {
  if (!Array.isArray(events)) return [];
  const seen = new Set();
  const files = [];
  for (const e of events) {
    if (e?.type !== 'tool/call') continue;
    const args = e.data?.arguments;
    if (typeof args !== 'string') continue;
    let filePath;
    try {
      filePath = JSON.parse(args)?.file_path;
    } catch {}
    if (typeof filePath === 'string' && filePath !== '' && !seen.has(filePath)) {
      seen.add(filePath);
      files.push(filePath);
    }
  }
  return files.slice(-limit);
}

/**
 * 机器提取用户对「是否再来一轮修正-终评」的选择：只看**当前回合**（最后一次
 * turn/start 之后；无 turn/start 时回退最后一次挑战者结算之后）主代理调用
 * `ask_user_question` 的工具结果，读 answers[].selected。
 * 与「四字段机器提取」同一思路——用户决策由宿主从会话事件读取，不靠主代理自述。
 * 锚点用 turn/start 与 knowledge 场景一致：挑战者若先发实时消息再落结算，
 * 主代理在结算事件入库前就提问（乱序）时，按「结算之后」会漏掉回答。
 * @param events - 会话事件数组。
 * @returns 'continue'（再来一轮）| 'stop'（结束并输出结论）| null（没问 / 无法判定）。
 */
function collectAnotherRoundChoice(events) {
  if (!Array.isArray(events)) return null;
  let start = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type === 'turn/start') start = i;
  }
  if (start < 0) {
    start = 0;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e?.type === 'user/message' && e.data?.source?.kind === 'subagent-settled') start = i;
    }
  }
  const askCallIds = new Set();
  let choice = null;
  for (let i = start; i < events.length; i += 1) {
    const e = events[i];
    if (e?.type === 'tool/call') {
      if (e.data?.name === 'ask_user_question' && typeof e.data?.callId === 'string') askCallIds.add(e.data.callId);
      continue;
    }
    if (e?.type !== 'tool/result') continue;
    const blocks = e.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool-result') continue;
      if (!askCallIds.has(block.toolCallId)) continue;
      const text = (Array.isArray(block.content) ? block.content : [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      const parsed = parseAnotherRoundAnswer(text);
      if (parsed !== null) choice = parsed; // 同一回合多次询问时以最后一次为准
    }
  }
  return choice;
}

/**
 * 中和文本里的 `dsh-session:` 会话引用 URI（ASCII 冒号 → 全角冒号）。
 * 原因：dsh 的 session-reference 预处理器会对 user 消息文本里的 `dsh-session:[base64url]`
 * 做解码校验——工具摘要 80 字截断可能把 URI 拦腰截断 → 非 canonical 抛
 * `invalid session reference URI`（本轮运行失败）；即便 URI 合法，挑战者也会被
 * 注入被引用会话的上下文（隔离漏洞）。组装回合文本时中和，既防抛错又防子代理
 * 解引用主上下文。
 */
function sanitizeSessionRefs(text) {
  if (typeof text !== 'string') return text ?? '';
  return text.replaceAll('dsh-session:', 'dsh-session：');
}

/**
 * 从 dsh 会话对象取事件日志数组。dsh 0.1.2-alpha.4 的 `Session` **不再暴露 `.events`**
 * （只有 `snapshotEvents()` 与公开的 `log`）——0.33.x 此前所有 `agent.session?.events`
 * 读取在运行时都是 undefined，导致宿主的回答/字段机器提取全部落空（本会话实证：
 * 派发给探索者的「用户原始表述」显示「（无）」、k_gate 把用户已点的「确认」判成
 * 「没确认」→ 误关竞技场）。统一走 `snapshotEvents()`（含 turn/start 等全部日志事件，
 * 与持久化的 jsonl 同源），并兼容旧 `.events` / `.log` 字段。
 * @param sess - dsh Session（或 Agent.session / 事件处理器收到的 session）。
 * @returns 会话事件数组（只读快照或原数组；拿不到 → []）。
 */
function sessionEventsOf(sess) {
  if (!sess) return [];
  if (typeof sess.snapshotEvents === 'function') {
    try {
      const snap = sess.snapshotEvents();
      if (Array.isArray(snap)) return snap;
    } catch {}
  }
  if (Array.isArray(sess.events)) return sess.events;
  if (Array.isArray(sess.log)) return sess.log;
  return [];
}

/**
 * 从一条 ask_user_question 工具结果文本里提取选中项文本。
 * @param text - 结果 JSON（{answers:[{id,selected,custom}]}）原文；非 JSON 时按 allowFallback
 *   返回原文供关键词兜底。
 * @param questionId - 固定提问 id；命中该 id 的答案优先。传 '' = 直接取最后一项。
 * @param allowFallback - true 时：无匹配 id 取该条最后一项；JSON 解析失败返回原文。
 * @returns 提取到的选中项拼接文本（'' = 无）。
 */
function pickAnswerFromText(text, questionId, allowFallback) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  let picked = '';
  try {
    const answers = JSON.parse(text)?.answers;
    if (Array.isArray(answers) && answers.length > 0) {
      const target = questionId === '' ? void 0 : answers.find((a) => a?.id === questionId);
      const chosen = target ?? (allowFallback ? answers[answers.length - 1] : void 0);
      if (chosen) {
        picked = [...(Array.isArray(chosen.selected) ? chosen.selected : []), chosen.custom ?? '']
          .filter((v) => typeof v === 'string')
          .join(' ');
      }
    }
  } catch {}
  return picked.trim() !== '' ? picked : (allowFallback ? text : '');
}

/**
 * 聚合一次回合内的 ask_user_question 选中文本（输入可为单条结果文本或一组结果文本）。
 * 一组结果里只采纳**含目标 questionId** 的那条（如终评 READY 一次问两道：报告 + 推进，
 * 两条结果都在窗口内，各按自己的 id 取），全部不含时回退最后一条的旧语义
 * （取最后一项 / 非 JSON 原文），保持与单条输入的旧行为一致。
 */
function pickedAnswerText(input, questionId) {
  const list = Array.isArray(input) ? input : [input];
  const hits = [];
  for (const text of list) {
    const p = pickAnswerFromText(text, questionId, false);
    if (p !== '') hits.push(p);
  }
  if (hits.length > 0) return hits.join(' ');
  const last = list.length > 0 ? list[list.length - 1] : '';
  return typeof last === 'string' ? pickAnswerFromText(last, questionId, true) : '';
}

/**
 * k_gate 阶段推进决策（纯函数，便于测试）：
 * @param advance - parseAdvanceChoice 结果 'continue' | 'stop' | null。
 * @param actual - readWorkflowStage 结果（'' = 读不到状态文件）。
 * @param expected - 期望推进到的阶段（propose / review / apply；'' = 无）。
 * @returns {{ action: 'dispatch'|'retry'|'close', reason?: string }}
 *   dispatch = 推进（用户确认；或确认答案未被宿主提取到，但主控者已 record——
 *             Theseus 状态文件推进到 expected 即 record 生效的机器信号，见 persona
 *             「用户确认才 judge+record」）；
 *   retry    = 用户确认但 record 未生效（停留 k_gate，提示主控者排查后重试）；
 *   close    = 用户明确暂停 / 未确认且未 record（附 reason，提示语由调用方注入）。
 */
function planKnowledgeAdvance(advance, actual, expected) {
  const advanced = expected !== '' && actual === expected;
  if (advance === 'stop') return { action: 'close', reason: 'user-paused' };
  if (advance === 'continue') {
    return advanced ? { action: 'dispatch' } : { action: 'retry' };
  }
  if (advanced) return { action: 'dispatch', reason: 'file-truth' };
  return { action: 'close', reason: 'no-confirm-no-record' };
}

/**
 * k_gate 回合决策（0.33.20 起支持修订轮留场）：用户同意「让探索者修订」
 * （revision === 'continue'），或本回合内主控者已向竞技场子代理 send_message 委派任务
 * （childTaskInFlight——修订轮、rerun、补派、追问/答案回传、报告派生等统一形态）→
 * **stay** 留场等待子代理结算，既不推进也不按「未确认」关场；其余按 planKnowledgeAdvance。
 * 注意：成因（修订/重跑/补派）不影响行为——凡「任务已交给子代理」都应等结算。
 */
function planKnowledgeGate(advance, revision, actual, expected, childTaskInFlight = false) {
  if (revision === 'continue' || childTaskInFlight) return { action: 'stay', reason: 'child-task-in-flight' };
  return planKnowledgeAdvance(advance, actual, expected);
}

/**
 * 检测一段事件里主控者是否已向**竞技场子代理**（durable id 集合）发起过 send_message
 * 委派。这是「子代理任务在途」的机械信号，与成因无关：修订轮、中断后的 rerun、
 * 宿主漏派后的补派、NEED_QUESTION 答案直传、report fork 催办……都表现为同一形态；
 * 宿主据此在 k_gate / k_verdict 留场等待结算，在 k_ask 跳过重复中继。
 * @param events - 会话事件数组。
 * @param childIds - 竞技场子代理 durable id 列表（按 label 缓存）。
 * @returns 是否在本段事件中发现对竞技场子代理的 send_message。
 */
function hasArenaChildDelegation(events, childIds) {
  if (!Array.isArray(events)) return false;
  const ids = new Set((childIds ?? []).filter((v) => typeof v === 'string' && v !== ''));
  if (ids.size === 0) return false;
  return events.some((e) => {
    if (e?.type !== 'tool/call' || e.data?.name !== 'send_message') return false;
    try {
      const args = typeof e.data?.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data?.arguments;
      return ids.has(String(args?.agent_id ?? ''));
    } catch {
      return false;
    }
  });
}

/**
 * 知识沉淀「子代理工作阶段」→ 该阶段期望的派发信息。子代理工作阶段指：阶段执行权
 * 在探索者/挑战者手里、宿主等待其结算回传的阶段（k_explore / k_propose / k_review /
 * k_readiness）。决策/交互阶段（k_init / k_gate / k_ask / k_verdict / k_apply）的执行权
 * 在主代理手里，用户消息会照常到达主代理、由主代理推进，不属于这里。
 * @param phase - 会话阶段。
 * @returns { pending: 'explore'|'propose'|'review'|'readiness', role: 'explorer'|'challenger' } | null
 */
function knowledgeChildStageOf(phase) {
  switch (phase) {
    case ARENA_PHASE_K_EXPLORE: return { pending: 'explore', role: 'explorer' };
    case ARENA_PHASE_K_PROPOSE: return { pending: 'propose', role: 'explorer' };
    case ARENA_PHASE_K_REVIEW: return { pending: 'review', role: 'challenger' };
    case ARENA_PHASE_K_READINESS: return { pending: 'readiness', role: 'explorer' };
    default: return null;
  }
}

/**
 * 断点续跑判定（纯函数）：会话处于某个「子代理工作阶段」且 pendingDispatch 与该阶段
 * 一致（即阶段执行权在子代理、宿主在等结算）→ 返回续跑目标；否则 null。
 * 子代理工作阶段被进程重启/崩溃中断后（子代理回合死在半途、无结算无工件），阶段被
 * 持久化在侧文件、重启后恢复，但宿主不会自动重派——用户发任意消息（如「继续」）时
 * 由调用方据此重派同一阶段（见 apply 内 kickResumeChild）。
 * @param state - readArenaState 结果。
 * @param isKnowledge - 是否 knowledge 场景。
 */
function childWorkOf(state, isKnowledge) {
  if (!state?.active) return null;
  if (isKnowledge) {
    const m = knowledgeChildStageOf(state.phase);
    if (!m || state.pendingDispatch !== m.pending) return null;
    if (typeof state.workflowId !== 'string' || state.workflowId === '') return null;
    return { scene: state.scene, phase: state.phase, pending: m.pending, role: m.role, workflowId: state.workflowId };
  }
  if (state.phase === ARENA_PHASE_CHALLENGE && state.pendingDispatch === ARENA_PHASE_CHALLENGE) {
    return { scene: state.scene, phase: state.phase, pending: 'challenge', role: 'challenger', workflowId: '' };
  }
  if (state.phase === ARENA_PHASE_VERDICT && state.pendingDispatch === ARENA_PHASE_VERDICT) {
    return { scene: state.scene, phase: state.phase, pending: 'verdict', role: 'challenger', workflowId: '' };
  }
  return null;
}

/**
 * Theseus 阶段 → 竞技场续跑目标（k_init 续跑与 agent/created 断点自愈共用，0.33.23）。
 * @param stageNow - `openspec/states/<workflowId>.json` 的 currentStage。
 * @returns 子代理工作阶段的续跑目标 { pending, phase, kStage, role, templateKey }；
 *   apply → { pending: null, phase: k_apply }（主控者执行）；archive/done/未知 → null（无需续跑）。
 */
function knowledgeStageResumeOf(stageNow) {
  switch (stageNow) {
    case 'explore': return { pending: 'explore', phase: ARENA_PHASE_K_EXPLORE, kStage: 'explore', role: 'explorer', templateKey: 'explorePrompt' };
    case 'propose': return { pending: 'propose', phase: ARENA_PHASE_K_PROPOSE, kStage: 'propose', role: 'explorer', templateKey: 'proposePrompt' };
    case 'review': return { pending: 'review', phase: ARENA_PHASE_K_REVIEW, kStage: '', role: 'challenger', templateKey: 'reviewPrompt' };
    case 'user-readiness-review': return { pending: 'readiness', phase: ARENA_PHASE_K_READINESS, kStage: 'readiness', role: 'explorer', templateKey: 'readinessPrompt' };
    case 'apply': return { pending: null, phase: ARENA_PHASE_K_APPLY, kStage: '', role: null, templateKey: null };
    default: return null;
  }
}

/**
 * 断点续跑的**短指令**文本：发给既有子代理（其历史中已含完整委派）的续跑提示，
 * 自带阶段返回协议，避免重发整份委派模板（那会重复污染子代理上下文）。
 * @param work - childWorkOf 的返回。
 * @returns 续跑指令文本。
 */
function kickResumeText(work) {
  const workflow = work.workflowId !== '' ? '（' + work.workflowId + '）' : '';
  switch (work.pending) {
    case 'explore':
      return '[arena-v2 宿主续跑] 宿主进程重启中断了你正在执行的 theseus-explore' + workflow + '。基于你历史中已收到的完整委派继续执行 theseus-explore skill；若工件已满足 gate 则直接核验并按返回协议输出（一行）：STAGE_DONE explore CONFIRMED，或 NEED_QUESTION <问题JSON>，或 BLOCKED <原因>。';
    case 'propose':
      return '[arena-v2 宿主续跑] 宿主进程重启中断了你正在执行的 theseus-propose' + workflow + '。基于你历史中已收到的完整委派继续执行 theseus-propose skill，产出/补齐提案工件后按返回协议输出（一行）：STAGE_DONE propose ARTIFACTS_CREATED，或 NEED_QUESTION <问题JSON>，或 BLOCKED <原因>。';
    case 'review':
      return '[arena-v2 宿主续跑] 宿主进程重启中断了你正在执行的 theseus-review-spec' + workflow + '。基于你历史中已收到的完整委派继续审查并把结论写入 review.md，完成后只回复一行 Done。';
    case 'readiness':
      return '[arena-v2 宿主续跑] 宿主进程重启中断了你正在执行的 theseus-user-readiness-review' + workflow + '。基于你历史中已收到的完整委派继续执行（预测题对账契约不变），完成后按返回协议输出（一行）：STAGE_DONE user-readiness CLEARED / NOT_CLEARED / NEEDS_REVISION，或 NEED_QUESTION <问题JSON>，或 BLOCKED <原因>。';
    case 'challenge':
      return '[arena-v2 宿主续跑] 宿主进程重启中断了你正在进行的质疑轮。基于你历史中已收到的完整委派继续完成本轮质疑并结束回合（结算会回传给主代理呈现）。';
    case 'verdict':
      return '[arena-v2 宿主续跑] 宿主进程重启中断了你正在进行的终评轮。基于你历史中已收到的完整委派（含主代理修正稿）继续完成终评并结束回合（结算会回传给主代理呈现）。';
    default:
      return '';
  }
}


/**
 * 按 round 组装质疑轮/终评轮结构化文本：四个字段（用户问题/回答正文/提到的文件/
 * 工具操作记录）全部由宿主侧从会话事件机器提取，模板渲染也在这里完成——主代理
 * 不再自述任何字段，只把返回文本转发给挑战者。返回前中和 `dsh-session:` URI。
 * @param cfg - 插件配置（读取 challengePrompt/verdictPrompt 模板）。
 * @param round - 'challenge' | 'verdict'。
 * @param events - 会话事件数组。
 * @returns 组装好的结构化消息文本。
 */
function composeRoundText(cfg, round, events, scene) {
  const p = scenePersonasOf(cfg, scene);
  const template = round === 'verdict' ? p.verdictPrompt : p.challengePrompt;
  const tools = collectToolRecords(events, { beforeSendMessage: round === 'verdict', limit: 10 });
  const files = collectFiles(events);
  return sanitizeSessionRefs(template
    .replaceAll('{question}', collectUserQuestion(events))
    .replaceAll('{answer}', collectAnswer(events))
    .replaceAll('{files}', files.length > 0 ? files.join('\n') : '（无）')
    .replaceAll('{tools}', tools.length > 0 ? tools.join('\n') : '（无）'));
}

/**
 * 会话级竞技状态（keyed by session id）：
 * - active: 竞技场是否开启
 * - phase: 当前竞技阶段（awaiting=等用户问题 / challenge=质疑轮 / verdict=终评轮）
 * - verdictRounds: 保留字段（既有设计），**不再记录也不累加**，不参与任何判定
 * - verdictOutcome: 最近一次终评结论（approved=认可 / disputed=仍存疑），present 阶段分支用
 * 旧格式（仅 {active}）兼容读取。
 */
const ARENA_PHASE_AWAITING = 'awaiting';
const ARENA_PHASE_ANSWER = 'answer';
const ARENA_PHASE_CHALLENGE = 'challenge';
const ARENA_PHASE_REVISE = 'revise';
const ARENA_PHASE_VERDICT = 'verdict';
const ARENA_PHASE_PRESENT = 'present';
// 知识沉淀场景（Theseus workflow 对抗流程）的竞技阶段。
const ARENA_PHASE_K_INIT = 'k_init';          // 主控者：绑定 workflow + judge
const ARENA_PHASE_K_GATE = 'k_gate';          // 主控者：judge + record 阶段完成
const ARENA_PHASE_K_ASK = 'k_ask';            // 主控者：中继提问（ask_user_question）
const ARENA_PHASE_K_EXPLORE = 'k_explore';    // 探索者：theseus-explore
const ARENA_PHASE_K_PROPOSE = 'k_propose';    // 探索者：theseus-propose
const ARENA_PHASE_K_REVIEW = 'k_review';      // 挑战者：theseus-review-spec
const ARENA_PHASE_K_VERDICT = 'k_verdict';    // 主控者：按 review.md 结论分支
const ARENA_PHASE_K_READINESS = 'k_readiness'; // 探索者：theseus-user-readiness-review
const ARENA_PHASE_K_APPLY = 'k_apply';        // 主控者：theseus-apply-change（T6）
const ARENA_PHASES = new Set([
  ARENA_PHASE_AWAITING,
  ARENA_PHASE_ANSWER,
  ARENA_PHASE_CHALLENGE,
  ARENA_PHASE_REVISE,
  ARENA_PHASE_VERDICT,
  ARENA_PHASE_PRESENT,
  ARENA_PHASE_K_INIT,
  ARENA_PHASE_K_GATE,
  ARENA_PHASE_K_ASK,
  ARENA_PHASE_K_EXPLORE,
  ARENA_PHASE_K_PROPOSE,
  ARENA_PHASE_K_REVIEW,
  ARENA_PHASE_K_VERDICT,
  ARENA_PHASE_K_READINESS,
  ARENA_PHASE_K_APPLY
]);

/** 终评结论取值（present 阶段据此分支：认可 → 整理结论；仍存疑 → 问用户是否再来一轮）。 */
const ARENA_VERDICT_OUTCOMES = new Set(['approved', 'disputed']);

/** 知识沉淀 review.md 判定取值。 */
const ARENA_K_OUTCOMES = new Set(['ready', 'needs_revision', 'not_ready']);

/** 竞技场开启期间对主会话禁用的 goal 工具真实注册名（dsh 0.1.2-alpha.4 的 tool-goal 三个模型工具）。 */
const GOAL_TOOL_NAMES = ['get_goal', 'create_goal', 'update_goal'];
/** 知识沉淀场景额外禁用的「创建新子代理」工具：探索者/挑战者由宿主派发（或主控者用
 *  send_message 向**已存在**的子代理委派），主控者不得新建副本（新副本没有阶段上下文，
 *  游离于状态机之外）。send_message 保持开放——主控者只能向已存在的探索者/挑战者委派
 *  任务（如门控 blocked 时的修订轮、宿主漏派时的补派）。 */
const CHILD_CREATE_TOOL_NAMES = ['subagent', 'subagent_fork'];
/** /goal 影子命令的固定拒绝文案（遮蔽预设 command-goal 后返回）。 */
const ARENA_GOAL_BLOCK_TEXT = '竞技场模式下已禁用 /goal：竞技回合与推进由宿主门控，goal 自动续跑会与竞技阶段冲突；如需使用 goal，请先 /arena off 关闭竞技场。';

/** 竞技场场景键（空白页 hero 开关右侧的分段控件：业务探索/知识沉淀/测试用例）。 */
const SCENES = ['business', 'knowledge', 'qa'];

/** 归一化场景键：未知值回落 business（当前仅存状态，行为接入见 README「场景」）。 */
function normalizeScene(value) {
  return SCENES.includes(value) ? value : 'business';
}

/**
 * 某会话工作区下可见/可用的场景（sceneWorkspace 门控）：scene 的 gate 为 '' 或缺失 =
 * 不限；否则 cwd 必须包含该目录子串（如 'intranet-aio'）。business 默认不限（无 gate）。
 * @param cwd - 会话工作区绝对路径（未知时传 '' → 只放行业务）。
 * @param gate - scene -> 目录子串 的映射。
 */
function scenesAllowedIn(cwd, gate) {
  const g = gate !== null && typeof gate === 'object' ? gate : {};
  return SCENES.filter((sc) => {
    const needle = g[sc];
    return typeof needle !== 'string' || needle === '' || (typeof cwd === 'string' && cwd !== '' && cwd.includes(needle));
  });
}

/** 会话级竞技状态文件路径（keyed by session id）。 */
function arenaStatePath(sessionId) {
  return join(ARENA_STATE_DIR, String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_') + '.json');
}

/** 读取会话的竞技状态（无文件 = 关闭 + awaiting）。 */
function readArenaState(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(arenaStatePath(sessionId), 'utf8'));
    const pending = parsed?.pendingDispatch;
    return {
      active: parsed?.active === true,
      phase: ARENA_PHASES.has(parsed?.phase) ? parsed.phase : ARENA_PHASE_AWAITING,
      verdictRounds: Number.isFinite(parsed?.verdictRounds) && parsed.verdictRounds >= 0 ? parsed.verdictRounds : 0,
      scene: normalizeScene(parsed?.scene),
      pendingDispatch: pending === ARENA_PHASE_CHALLENGE || pending === ARENA_PHASE_VERDICT
        || pending === 'explore' || pending === 'propose' || pending === 'review' || pending === 'readiness'
        ? pending
        : null,
      verdictOutcome: ARENA_VERDICT_OUTCOMES.has(parsed?.verdictOutcome) ? parsed.verdictOutcome : null,
      // 知识沉淀场景字段（旧文件兼容缺省）。
      workflowId: typeof parsed?.workflowId === 'string' ? parsed.workflowId : '',
      kStage: typeof parsed?.kStage === 'string' ? parsed.kStage : '',
      kNext: typeof parsed?.kNext === 'string' ? parsed.kNext : '',
      kPrev: ARENA_PHASES.has(parsed?.kPrev) ? parsed.kPrev : '',
      kResult: typeof parsed?.kResult === 'string' ? parsed.kResult : '',
      reviewOutcome: ARENA_K_OUTCOMES.has(parsed?.reviewOutcome) ? parsed.reviewOutcome : null,
      kQuestion: typeof parsed?.kQuestion === 'string' ? parsed.kQuestion : ''
    };
  } catch {
    return {
      active: false, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, scene: 'business', pendingDispatch: null,
      verdictOutcome: null, workflowId: '', kStage: '', kNext: '', kPrev: '', kResult: '', reviewOutcome: null, kQuestion: ''
    };
  }
}

/** 写入会话的竞技状态（侧文件，同会话内下一条消息生效；未指定字段保留既有值，显式 null 清空）。 */
function writeArenaState(sessionId, state) {
  const prev = readArenaState(sessionId);
  const pending = state.pendingDispatch === ARENA_PHASE_CHALLENGE || state.pendingDispatch === ARENA_PHASE_VERDICT
    || state.pendingDispatch === 'explore' || state.pendingDispatch === 'propose' || state.pendingDispatch === 'review'
    || state.pendingDispatch === 'readiness'
    ? state.pendingDispatch
    : null;
  // undefined = 保留既有值；显式 null = 清空（新一轮/收尾时复位）。
  const outcome = state.verdictOutcome === void 0 ? prev.verdictOutcome : state.verdictOutcome;
  const reviewOutcome = state.reviewOutcome === void 0 ? prev.reviewOutcome : state.reviewOutcome;
  const str = (v) => (typeof v === 'string' ? v : '');
  mkdirSync(ARENA_STATE_DIR, { recursive: true });
  writeFileSync(arenaStatePath(sessionId), JSON.stringify({
    active: state.active === true,
    phase: ARENA_PHASES.has(state.phase) ? state.phase : ARENA_PHASE_AWAITING,
    verdictRounds: Number.isFinite(state.verdictRounds) && state.verdictRounds >= 0 ? state.verdictRounds : 0,
    scene: normalizeScene(state.scene ?? prev.scene),
    pendingDispatch: pending,
    verdictOutcome: ARENA_VERDICT_OUTCOMES.has(outcome) ? outcome : null,
    workflowId: state.workflowId === void 0 ? prev.workflowId : str(state.workflowId),
    kStage: state.kStage === void 0 ? prev.kStage : str(state.kStage),
    kNext: state.kNext === void 0 ? prev.kNext : str(state.kNext),
    kPrev: state.kPrev === void 0 ? prev.kPrev : str(state.kPrev),
    kResult: state.kResult === void 0 ? prev.kResult : str(state.kResult),
    reviewOutcome: ARENA_K_OUTCOMES.has(reviewOutcome) ? reviewOutcome : null,
    kQuestion: state.kQuestion === void 0 ? prev.kQuestion : str(state.kQuestion)
  }), 'utf8');
}

/** 读取会话的竞技场模式开关（兼容旧调用）。 */
function readArenaMode(sessionId) {
  return readArenaState(sessionId).active;
}

/** 写入会话的竞技场模式开关（保留既有 phase/verdictRounds）。 */
function writeArenaMode(sessionId, active) {
  const current = readArenaState(sessionId);
  writeArenaState(sessionId, { ...current, active });
}

function apply(ctx) {
  ctx.inject(['settings', 'systemPrompt'], async (settingsCtx) => {
    let scope;
    try {
      scope = settingsCtx.settings.register(name, Config, {
        base: {
          enabled: true,
          challengerModel: DEFAULT_CHALLENGER_MODEL,
          mainPersona: DEFAULT_MAIN_PERSONA,
          challengerPrompt: DEFAULT_CHALLENGER_PROMPT,
          challengePrompt: DEFAULT_CHALLENGE_PROMPT,
          verdictPrompt: DEFAULT_VERDICT_PROMPT,
          maxVerdictRounds: 3,
          conclusionPrompt: DEFAULT_CONCLUSION_PROMPT,
          sceneSearchGuide: DEFAULT_SCENE_SEARCH_GUIDE,
          sessionHistoryGuide: DEFAULT_SESSION_HISTORY_GUIDE,
          sceneWorkspace: { knowledge: 'intranet-aio', qa: 'intranet-aio' },
          scenePersonas: {},
          subagentProvider: 'spawn',
          intent: DEFAULT_INTENT_CONFIG,
          instruction: DEFAULT_INSTRUCTION
        }
      });
    } catch (error) {
      ctx.logger?.warn?.('arena-v2: settings register failed: ' + String(error?.message ?? error));
    }

    // ── 竞技场子代理的固定模型 + persona ───────────────────────────────
    // dsh 0.1.2-alpha.4 移除了 registerContinuableSetup；新机制是创建时经
    // ContinuableStartSpec.request 传入 agentOptions（provider/model/reasoningEffort，
    // spawn provider 支持）与 persona（阴影 deployment:persona）——两者随 descriptor
    // 持久化、冷恢复时重放，故不再需要创建窗口钩子。见 dispatchKnowledge /
    // dispatchArenaRound 的 startContinuable 调用。
    // ── 竞技场子代理 id 追踪 ────────────────────────────────────────────────
    // subagents: `${父会话 id}::${label}` -> 子代理 id（durable，跨轮次/重启有效；
    //   business/qa 一个挑战者 label；knowledge 有 explorer 与 challenger 两个 label）。
    // resolving:  同键 -> 最近一次 listChildren 尝试时间（节流）。
    // mainPersonas: 会话 id -> 主代理 persona 段落的 disposer。
    const subagents = new Map();
    const resolving = new Map();
    const mainPersonas = new Map();
    const kickThrottle = new Map(); // sessionId -> 最近一次断点续跑派发时间（防重复续跑）
    const RESOLVE_THROTTLE_MS = 10_000;
    const KICK_THROTTLE_MS = 30_000;
    const subagentKey = (sessionId, label) => sessionId + '::' + label;
    const challengerKey = (sessionId, scene) => subagentKey(sessionId, challengerLabelFor(scene));
    const explorerKey = (sessionId, scene) => subagentKey(sessionId, explorerLabelFor(scene));

    /** 顶层会话（非子代理会话）——竞技场只作用于顶层会话。 */
    const isTopLevelAgent = (agent) => {
      try {
        if (!agent?.id || !agent?.session?.header) return false;
        if (agent.session.header.origin === 'subagent') return false;
        const depth = agent.options?.subagentDepth;
        if (depth !== void 0 && depth !== null) return false;
        return true;
      } catch {
        return false;
      }
    };

    /**
     * 按 (父会话, label) 找回竞技场子代理并缓存。listChildren 是只读枚举，不加载
     * Agent；label 是子代理 descriptor 里的 durable 字段（= subagent 工具的
     * description），因此只命中该 label 的子代理，不会被同父会话的其它子代理污染。
     */
    const resolveSubagent = async (parentSessionId, label, { force = false } = {}) => {
      try {
        if (!parentSessionId || typeof label !== 'string' || label === '') return;
        const key = subagentKey(parentSessionId, label);
        const subagentsSvc = settingsCtx.get('subagents');
        if (!subagentsSvc || typeof subagentsSvc.listChildren !== 'function') return;
        const now = Date.now();
        const last = resolving.get(key);
        if (!force && last !== void 0 && now - last < RESOLVE_THROTTLE_MS) return;
        resolving.set(key, now);
        const entries = await subagentsSvc.listChildren(parentSessionId);
        const found = (entries ?? []).find((entry) => (
          entry?.kind === 'child'
          && entry?.mode === 'continuable'
          && (entry?.label === label || (label === CHALLENGER_LABEL + ':business' && entry?.label === CHALLENGER_LABEL))
        ));
        if (found?.id) subagents.set(key, String(found.id));
      } catch (error) {
        ctx.logger?.warn?.('arena-v2: resolve subagent failed: ' + String(error?.message ?? error));
      }
    };
    const resolveChallenger = (parentSessionId, scene, opts) => resolveSubagent(parentSessionId, challengerLabelFor(scene), opts);
    const resolveExplorer = (parentSessionId, scene, opts) => resolveSubagent(parentSessionId, explorerLabelFor(scene), opts);

    /** 该会话是否已有任意场景的竞技场子代理（枚举子代理，按 label 判断；用于命令/路由的场景锁定）。 */
    const findArenaChildEntry = async (sessionId) => {
      try {
        const subagentsSvc = settingsCtx.get('subagents');
        if (!subagentsSvc || typeof subagentsSvc.listChildren !== 'function') return null;
        const entries = await subagentsSvc.listChildren(sessionId);
        return (entries ?? []).find((entry) => (
          entry?.kind === 'child' && entry?.mode === 'continuable'
          && (isChallengerLabel(entry?.label) || isExplorerLabel(entry?.label))
        )) ?? null;
      } catch {
        return null;
      }
    };

    /** 同步快路径：subagents 内存缓存已知该会话有竞技场子代理（listChildren 懒解析的命中）。 */
    const hasKnownChild = (sessionId) => {
      const prefix = sessionId + '::';
      for (const k of subagents.keys()) {
        if (k.startsWith(prefix)) return true;
      }
      return false;
    };

    // 子代理存在性结果缓存（正负缓存，TTL 10s）——场景锁定检查在用户可见路径上
    // （命令 /arena <scene>、路由 ?scene=），避免每次点击都打一次 listChildren。
    // statePayload（每次状态拉取）顺带预热本缓存：挂载/轮询先查一次，随后的场景
    // 点击基本命中缓存，无需再等 listChildren。
    const childCheckCache = new Map();
    const CHILD_CHECK_TTL_MS = 10_000;
    /** 缓存化的竞技场子代理 entry 查询（无子代理 = null）。 */
    const cachedChildEntry = async (sessionId) => {
      try {
        const cached = childCheckCache.get(sessionId);
        if (cached !== void 0 && Date.now() - cached.at < CHILD_CHECK_TTL_MS) return cached.entry;
        const entry = await findArenaChildEntry(sessionId);
        childCheckCache.set(sessionId, { entry, at: Date.now() });
        return entry;
      } catch {
        return null;
      }
    };
    /** 场景锁定快速判断：内存 Map 已知有子代理 → true；否则走缓存化查询。 */
    const hasChallengerCached = async (sessionId) => {
      try {
        if (hasKnownChild(sessionId)) return true; // 已解析过的会话，同步快路径
        const entry = await cachedChildEntry(sessionId);
        return entry !== null;
      } catch {
        return false;
      }
    };

    // ── 主代理 persona + 竞技工具：按竞技场模式动态安装/卸载 ──────────────
    // arena_compose / arena_finish 不再全局注册，而是随竞技场开启注册到该会话
    // 作用域（agent.ctx.tools）、关闭即卸载——关闭后模型看不到这两个工具，机制上
    // 无法再走竞技流程（不依赖模型自觉，即使历史上下文里残留竞技指令）。
    const buildComposeTool = () => defineTool({
      name: 'arena_compose',
      description: '竞技场专用：按模板组装发给挑战者的结构化消息。用户问题、回答正文（不含思维链）、提到的文件、工具操作记录四个字段全部由宿主侧从当前会话事件机器提取，无需你自行填写或记忆。round 填 challenge 组装【质疑轮】，round 填 verdict 组装【终评轮】（终评轮自动取最近一次 send_message 之前的调查工具记录与你的修正稿）。把返回的 text 直接作为 send_message 的 message，或作为 subagent 创建时的 prompt。',
      parameters: {
        round: {
          type: 'string',
          required: true,
          enum: ['challenge', 'verdict'],
          description: 'challenge = 质疑轮；verdict = 终评轮'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{
          type: 'text',
          text: '已组装' + (args?.round === 'verdict' ? '终评轮' : '质疑轮') + '消息（四个字段由宿主侧机器提取）：\n' + value.text
        }]
      },
      async execute(args, exec) {
        const agent = exec.agent;
        const events = sessionEventsOf(agent?.session);
        if (events.length === 0) throw new Error('arena_compose requires a calling agent session with an event log');
        const cfg = scope?.get?.() ?? {};
        const round = args?.round === 'verdict' ? 'verdict' : 'challenge';
        const scene = (() => {
          try { return readArenaState(String(agent.id)).scene; } catch { return 'business'; }
        })();
        return { text: composeRoundText(cfg, round, events, scene) };
      }
    });

    const buildFinishTool = () => defineTool({
      name: 'arena_finish',
      description: '竞技场专用（兼容保留；宿主驱动下由宿主自动收尾，主代理不需要调用）：结束本轮对抗并关闭竞技场（Arena 取消选中）。在终评「认可」，或终评「仍存疑」且用户拒绝再来一轮时调用；终评「仍存疑」且用户同意再来一轮时不要调用（应在本回合内完成修正后结束回合，由宿主再送一次终评轮）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            closed: { type: 'boolean', required: true }
          }
        },
        render: () => [{ type: 'text', text: '竞技场已关闭（本轮对抗结束）。' }]
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (!agent?.id) throw new Error('arena_finish requires a calling agent');
        finishArenaRound(String(agent.id));
        return { closed: true };
      }
    });

    /** 给目标会话安装主代理 persona + 竞技工具（幂等）；返回是否安装。 */
    const installMainPersona = (agent) => {
      try {
        const id = String(agent.id);
        if (mainPersonas.has(id)) return true;
        const cfg = scope?.get?.() ?? {};
        const disposers = [];
        // 主代理 persona 按会话场景取（场景默认 > 顶层 business 默认 > 配置覆盖）。
        const scene = (() => {
          try { return readArenaState(id).scene; } catch { return 'business'; }
        })();
        const persona = scenePersonasOf(cfg, scene).mainPersona;
        if (persona !== '') {
          const d = agent.ctx?.systemPrompt?.section?.({
            name: PERSONA_SECTION,
            order: PERSONA_ORDER,
            text: persona
          });
          if (typeof d !== 'function') return false;
          disposers.push(d);
        }
        // 竞技工具注册到该会话作用域（关闭/会话销毁时随 disposer 一并卸载）。
        const tools = agent.ctx?.tools;
        for (const def of [buildComposeTool(), buildFinishTool()]) {
          const td = tools?.register?.(def);
          if (typeof td === 'function') disposers.push(td);
        }
        // 竞技场模式下禁用 goal 工具（get_goal/create_goal/update_goal）与 /goal 命令：
        // 防止主代理或用户经 goal 绕过竞技场门控（无人管控地创建/推进 goal、goal 自动
        // 续跑与宿主阶段机抢回合）。知识沉淀场景额外禁用**创建新子代理**的 subagent /
        // subagent_fork（0.33.20 起开放 send_message：主控者只能向已存在的探索者/挑战者
        // 委派任务——新副本没有阶段上下文且游离于状态机外，宿主走 subagents 服务 API
        // 不受影响；子代理会话是独立工具作用域，也不受影响）。
        // restrict 过滤 scope 继承到的工具（含预设层的），且只认真实注册名：0.33.9 曾用
        // 'goal' 作 deny 名——那不是任何已注册工具，restrict 因 unknown name 整单抛错被
        // 跳过，等于从未生效（实证：竞技场开启窗口内主控者 send_message/subagent 调用
        // 全部成功）。整单失败时逐名重试，让能命中的名字仍然生效。
        const restrictDeny = (names) => {
          const applied = [];
          const one = (name) => {
            try {
              const d = tools?.restrict?.({ deny: [name] });
              if (typeof d === 'function') applied.push(d);
            } catch (error) {
              ctx.logger?.warn?.('arena-v2: restrict deny failed (' + name + '): ' + String(error?.message ?? error));
            }
          };
          try {
            const d = tools?.restrict?.({ deny: names });
            if (typeof d === 'function') applied.push(d);
          } catch {
            for (const name of names) one(name);
          }
          return applied;
        };
        for (const d of restrictDeny(scene === 'knowledge'
          ? [...GOAL_TOOL_NAMES, ...CHILD_CREATE_TOOL_NAMES]
          : [...GOAL_TOOL_NAMES])) {
          disposers.push(d);
        }
        // /goal 命令影子：在主代理会话作用域注册同名命令，遮蔽预设作用域（tool-both 的
        // command-goal）的 /goal——竞技场开启期间键入 /goal（含 goal 条 UI 快捷操作）一律
        // 拒绝并提示，关闭竞技场时随 disposer 恢复原命令。注册后按该会话的命令解析结果
        // 核验：若 /goal 仍解析到预设的 command-goal（影子落到了不遮蔽它的层，如全局层），
        // 立即回滚——避免给其它会话泄漏一条禁用的 goal 命令；机械兜底由上方工具 deny 覆盖。
        try {
          const shadow = {
            name: 'goal',
            description: '竞技场模式下已禁用（竞技回合由宿主门控；/arena off 关闭后可正常使用）',
            input: { hint: '[disabled in arena]' },
            handler: async () => ({ kind: 'error', text: ARENA_GOAL_BLOCK_TEXT })
          };
          let cd = agent.ctx?.commands?.register?.(shadow);
          if (typeof cd === 'function') {
            try {
              const listed = settingsCtx.get('commands')?.list?.(agent) ?? [];
              const effective = listed.some((c) => c?.name === 'goal' && String(c?.description ?? '').includes('竞技场模式下已禁用'));
              if (!effective) {
                try { cd(); } catch {}
                cd = undefined;
              }
            } catch {
              try { cd(); } catch {}
              cd = undefined;
            }
          }
          if (typeof cd === 'function') disposers.push(cd);
        } catch (error) {
          ctx.logger?.warn?.('arena-v2: /goal shadow register failed: ' + String(error?.message ?? error));
        }
        if (disposers.length === 0) return false;
        mainPersonas.set(id, () => {
          for (const f of disposers) {
            try {
              f();
            } catch {}
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    /** 卸载主代理 persona（幂等）。 */
    const disposeMainPersona = (id) => {
      const d = mainPersonas.get(id);
      if (typeof d === 'function') {
        try {
          d();
        } catch {}
      }
      mainPersonas.delete(id);
    };

    /** 切换会话的竞技场模式：写入侧文件状态并同步主代理 persona（scene 指定则写入，缺省保留原场景）。 */
    const setArenaMode = (agent, active, scene) => {
      try {
        const sessionId = String(agent?.id ?? '');
        if (sessionId === '') return 'noop';
        const st = readArenaState(sessionId);
        const sceneChanged = active && scene !== void 0 && normalizeScene(scene) !== st.scene;
        if (st.active === active && !sceneChanged) return 'noop';
        if (active) {
          // 开启：重置竞技阶段为「等用户问题」，并清空知识沉淀场景的会话字段。
          writeArenaState(sessionId, {
            active: true, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, scene, verdictOutcome: null,
            workflowId: '', kStage: '', kNext: '', kPrev: '', kResult: '', reviewOutcome: null, kQuestion: ''
          });
        } else {
          writeArenaMode(sessionId, false);
        }
        if (isTopLevelAgent(agent)) {
          if (active) installMainPersona(agent);
          else disposeMainPersona(sessionId);
        }
        ctx.logger?.info?.('arena-v2: session ' + sessionId + ' arena mode -> ' + active + ' scene=' + (scene ?? st.scene));
        return 'committed';
      } catch {
        return 'noop';
      }
    };

    /** 结束本轮完整对抗：关闭竞技场（active=false + phase 重置）+ 卸载主代理 persona + 注入场景化收尾提醒。 */
    const finishArenaRound = (sessionId) => {
      try {
        const st = readArenaState(sessionId);
        writeArenaState(sessionId, {
          active: false, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, verdictOutcome: null,
          workflowId: '', kStage: '', kNext: '', kPrev: '', kResult: '', reviewOutcome: null, kQuestion: ''
        });
        disposeMainPersona(sessionId);
        // 场景化收尾提醒：
        // - business/qa：评审已结束，压住「认可后顺手改代码/文档」的历史惯性——修改必须等用户明确指示；
        // - knowledge：apply 改动在 worktree 中，commit/push/archive（T7-T9）需用户明确指示。
        const note = st.scene === 'knowledge'
          ? '[arena-v2] 知识沉淀竞技场已结束。如需继续：先 `/arena knowledge` 重新开启，宿主会按 openspec/states 的当前阶段自动续跑并复用已有探索者/挑战者——**不要自行创建或委派子代理**。apply 改动位于对应 worktree 中；T7 worktree-commit-push、T8 openspec-impl-doc、T9 theseus-archive-change 请等待用户明确指示后再执行，不要自动 commit / push / archive。'
          : '[arena-v2] 竞技场评审已结束并关闭。若需修改代码或文档，请等待用户明确指示后再执行；不要自动执行任何写操作。';
        try {
          const agent = settingsCtx.get('agents')?.get(sessionId);
          if (agent && typeof agent.inject === 'function') {
            agent.inject(createUserMessage({
              content: [{
                type: 'text',
                text: note
              }],
              source: { kind: 'plugin', form: 'notice' }
            }));
          }
        } catch {}
        ctx.logger?.info?.('arena-v2: session ' + sessionId + ' round finished, arena off');
      } catch {}
    };

    // 会话出现时（新建/重启/热启用后恢复）：按 label 找回既有挑战者，让系统提示
    // 从一开始就带上正确的 id（对上下文压缩也稳——压缩可能剪掉含 subagentId 的
    // 工具结果，但提示每轮都会重新渲染）。主代理 persona 仅在竞技场模式开启时安装
    // （模式状态存于 ~/.dsh/arena-v2 侧文件，重启后由 agent/created 恢复）。
    const offCreated = settingsCtx.on('agent/created', ({ agent }) => {
      try {
        if (!isTopLevelAgent(agent)) return;
        const id = String(agent.id);
        const st = readArenaState(id);
        void resolveChallenger(id, st.scene, { force: true });
        if (st.scene === 'knowledge') void resolveExplorer(id, st.scene, { force: true });
        if (st.active) installMainPersona(agent);
        // 知识沉淀断点自愈（0.33.23）：会话被打开/重启挂载时按 Theseus 真相对齐，
        // 自动重建侧文件并派发缺失的阶段（含 review 挑战者）。
        if (st.scene === 'knowledge') void reconcileKnowledgeResume(agent, id);
      } catch {}
    });

    // 子代理创建/唤醒/冷恢复：尽快重查该父会话的挑战者（按 label 校正，避免把
    // 同父会话的其它子代理当成挑战者）。
    const offStart = settingsCtx.on('subagent/start', (info) => {
      try {
        const sessions = settingsCtx.get('sessions');
        const childId = info?.id ? String(info.id) : null;
        if (!sessions || !childId) return;
        const child = sessions.get(childId);
        const parentId = child?.header?.parentSession ? String(child.header.parentSession) : null;
        if (!parentId) return;
        const parent = sessions.get(parentId);
        if (!parent?.header) return;
        if (parent.header.origin === 'subagent') return;
        // 按父会话当前场景找回挑战者（label 校正，避免把同父会话的其它子代理当成挑战者）。
        const st = readArenaState(parentId);
        childCheckCache.delete(parentId); // 子代理出现，失效存在性缓存
        void resolveChallenger(parentId, st.scene, { force: true });
        if (st.scene === 'knowledge') void resolveExplorer(parentId, st.scene, { force: true });
      } catch {}
    });

    // 会话销毁时清理追踪，避免 Map 无限增长。
    const offDisposed = settingsCtx.on('agent/disposed', ({ agent }) => {
      try {
        if (agent?.id) {
          const id = String(agent.id);
          const prefix = id + '::';
          for (const k of [...subagents.keys()]) {
            if (k.startsWith(prefix)) subagents.delete(k);
          }
          for (const k of [...resolving.keys()]) {
            if (k.startsWith(prefix)) resolving.delete(k);
          }
          childCheckCache.delete(id);
          intentBySession.delete(id);
          disposeMainPersona(id);
        }
      } catch {}
    });

    // ── 宿主驱动：竞技回合状态机 ──────────────────────────────────────────
    // **回合完全由宿主推进**，不依赖主代理自觉：
    // - 用户发消息（user/message, kind=user）且空闲 → phase=answer（主代理作答）
    // - 主代理回合结束（turn/end, phase=answer）→ 宿主组装质疑轮 → 创建/复用挑战者
    //   → phase=challenge（挑战者工作）
    // - 挑战者结算 → 父会话自动收到 subagent-settled 消息（phase=challenge）→
    //   phase=revise（主代理呈现质疑并修正）
    // - 主代理回合结束（turn/end, phase=revise）→ 宿主组装终评轮 → 续聊挑战者
    //   → phase=verdict（挑战者终评）
    // - 终评结算回传（phase=verdict）→ phase=present（主代理呈现终评）
    // - 主代理回合结束（turn/end, phase=present）→ 宿主关闭竞技场
    // phase + pendingDispatch 持久化在侧文件，重启后按状态恢复推进。
    const isArenaTopLevelSession = (session) => {
      try {
        const header = session?.header;
        if (!header || header.origin === 'subagent') return false;
        return readArenaMode(String(session.id));
      } catch {
        return false;
      }
    };

    /** 取会话的 live 主代理（派发/续聊挑战者需要）。 */
    const resolveMainAgent = (sessionId) => {
      try {
        return settingsCtx.get('agents')?.get?.(sessionId) ?? null;
      } catch {
        return null;
      }
    };

    /**
     * 机器读取用户对「是否再来一轮修正-终评」的选择（终评仍存疑时主代理必须用
     * ask_user_question 询问）：从会话事件里提取（优先调用方传入的当前回合事件；
     * 缺省回退 live 主代理的会话日志），读不到 → null（收尾）。
     */
    const readAnotherRoundChoice = (sessionId, events) => {
      try {
        return collectAnotherRoundChoice(events ?? sessionEventsOf(resolveMainAgent(sessionId)?.session));
      } catch {
        return null;
      }
    };

    /** 向主会话注入一条可见的竞技场提示（成功/失败都能看到，不再只进终端日志）。中和 dsh-session: 防预处理器抛错。
     *  0.33.20：steer 不可用时回退 inject，两者都不可用/取不到 live agent 时记日志——
     *  不再静默丢提示（session-98182034 的 k_gate retry 提示曾因静默失败让用户以为卡死）。 */
    const steerArenaNote = (mainAgent, text) => {
      const message = () => createUserMessage({
        content: [{ type: 'text', text: sanitizeSessionRefs(text) }],
        source: { kind: 'user' }
      });
      try {
        if (mainAgent && typeof mainAgent.steer === 'function') {
          mainAgent.steer(message());
          return;
        }
        if (mainAgent && typeof mainAgent.inject === 'function') {
          mainAgent.inject(message());
          return;
        }
        ctx.logger?.warn?.('arena-v2: arena note dropped (no live main agent with steer/inject) — text: ' + String(text).slice(0, 120));
      } catch (error) {
        ctx.logger?.warn?.('arena-v2: arena note delivery failed: ' + String(error?.message ?? error));
      }
    };

    // 宿主派发用的信号：startContinuable/queueHostSubagentPrompt 内部会调用 signal.throwIfAborted()，
    // 缺省 undefined 会直接抛错（Cannot read properties of undefined (reading
    // 'throwIfAborted')）；插件卸载时 abort 释放。
    const dispatchAbort = new AbortController();

    /**
     * 宿主协议消息进入子代理（dsh 0.1.2-alpha.4 移除了 subagents.followup）：
     * 优先 queueHostSubagentPrompt（host-only Queue，符号键、保留宿主来源）；
     * 服务是远程 face 未实现符号时回退 sendMessage（agent-message 归属）。
     */
    const queueToChild = async (subagentsSvc, mainAgent, childId, content, signal) => {
      try {
        await queueHostSubagentPrompt(subagentsSvc, mainAgent, childId, content, { kind: 'user' }, signal);
      } catch (error) {
        if (subagentsSvc !== null && typeof subagentsSvc?.sendMessage === 'function') {
          await subagentsSvc.sendMessage(mainAgent, childId, content, { signal });
        } else {
          throw error;
        }
      }
    };

    /**
     * 宿主派发回合：组装结构化消息（composeRoundText 机器提取四字段）并创建/复用
     * 挑战者。round 填 'challenge'（质疑轮）或 'verdict'（终评轮）。
     * 任何失败都**注入会话可见**（主代理会把错误原样呈现给用户），并回到等待态可重试。
     */
    const dispatchArenaRound = async (sessionId, round) => {
      try {
        const mainAgent = resolveMainAgent(sessionId);
        if (!mainAgent) {
          ctx.logger?.warn?.('arena-v2: dispatch ' + round + ' aborted — live main agent unavailable for ' + sessionId);
          steerArenaNote(null, '⚠ 竞技场' + (round === 'verdict' ? '终评' : '质疑') + '轮派发失败：无法取得当前会话的 live 主代理（已回到等待态，可重试）。');
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null, verdictOutcome: null });
          return;
        }
        const st = readArenaState(sessionId);
        const scene = st.scene;
        const cfg = scope?.get?.() ?? {};
        const events = sessionEventsOf(mainAgent.session);
        if (events.length === 0) {
          ctx.logger?.warn?.('arena-v2: dispatch ' + round + ' aborted — no session events for ' + sessionId);
          steerArenaNote(mainAgent, '⚠ 竞技场' + (round === 'verdict' ? '终评' : '质疑') + '轮派发失败：无法读取会话事件（已回到等待态，可重试）。');
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null, verdictOutcome: null });
          return;
        }
        const text = composeRoundText(cfg, round, events, scene);
        const content = [{ type: 'text', text }];
        const subagentsSvc = settingsCtx.get('subagents');
        if (!subagentsSvc || typeof subagentsSvc.startContinuable !== 'function') {
          const msg = '⚠ 竞技场' + (round === 'verdict' ? '终评' : '质疑') + '轮派发失败：subagents 服务不可用（已回到等待态，可重试）。';
          ctx.logger?.warn?.('arena-v2: dispatch ' + round + ' aborted — subagents service unavailable');
          steerArenaNote(mainAgent, msg);
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null, verdictOutcome: null });
          return;
        }
        const key = challengerKey(sessionId, scene);
        let childId = subagents.get(key);
        if (!childId) {
          await resolveChallenger(sessionId, scene, { force: true });
          childId = subagents.get(key);
          if (childId) ctx.logger?.info?.('arena-v2: dispatch ' + round + ' recovered existing challenger ' + childId);
        }
        // 固定模型 + persona：随创建请求传入（dsh 0.1.2-alpha.4 机制，冷恢复重放）。
        const model = challengerModelOf(cfg);
        const persona = scenePersonasOf(cfg, scene).challengerPrompt;
        const agentOptions = {
          provider: model.provider,
          model: model.model,
          ...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}
        };
        if (childId) {
          await queueToChild(subagentsSvc, mainAgent, childId, content, dispatchAbort.signal);
          ctx.logger?.info?.('arena-v2: dispatch ' + round + ' -> queue ' + childId);
        } else {
          const res = await subagentsSvc.startContinuable({
            provider: subagentProviderOf(cfg),
            label: challengerLabelFor(scene),
            request: {
              parent: mainAgent,
              prompt: content,
              maxDepth: 1,
              agentOptions,
              ...persona !== '' ? { persona } : {}
            },
            signal: dispatchAbort.signal
          });
          if (res?.childId) subagents.set(key, String(res.childId));
          ctx.logger?.info?.('arena-v2: dispatch ' + round + ' -> create ' + String(res?.childId ?? ''));
        }
      } catch (error) {
        const errText = String(error?.message ?? error);
        ctx.logger?.warn?.('arena-v2: dispatch ' + round + ' failed: ' + errText);
        // 派发失败（如 provider 未注册/子代理创建被拒）：回到等待态并把错误注入会话可见。
        try {
          const mainAgent = resolveMainAgent(sessionId);
          steerArenaNote(mainAgent, '⚠ 竞技场' + (round === 'verdict' ? '终评' : '质疑') + '轮派发失败：' + errText + '（已回到等待态，可重试）。');
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null, verdictOutcome: null });
        } catch {}
      }
    };

    // ── 知识沉淀（knowledge）场景：Theseus workflow 对抗流程 ────────────────
    // 主控者（主代理）持 Theseus CLI（mode/judge/record）与全部 ask_user_question；
    // 探索者子代理执行 explore/propose/user-readiness/requirement-report；
    // 挑战者子代理执行 theseus-review-spec 只写 review.md 返回 Done。
    // 判定一律读文件（openspec/.runtime、openspec/states、review.md），不依赖子代理自述。

    /** 会话工作区 cwd（Theseus 运行时与工件都在会话工作区下）。 */
    const sessionCwd = (session) => {
      try {
        const cwd = session?.header?.cwd ?? resolveMainAgent(String(session?.id ?? ''))?.session?.header?.cwd;
        return typeof cwd === 'string' ? cwd : '';
      } catch {
        return '';
      }
    };

    const readOptionalJsonFile = (path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    };

    /** 读主会话绑定的 Theseus workflow id（dsh 上下文键 dsh:<sessionId> → 会话焦点文件）。 */
    const readKnowledgeWorkflowId = (cwd, sessionId) => {
      try {
        if (!cwd) return '';
        const focus = readOptionalJsonFile(join(cwd, 'openspec', '.runtime', 'sessions', 'dsh__' + String(sessionId) + '.json'));
        const id = focus?.activeWorkflowId;
        return typeof id === 'string' ? id : '';
      } catch {
        return '';
      }
    };

    /** 读 Theseus workflow 的当前阶段（record 生效验证用；文件不存在/损坏 → ''）。 */
    const readWorkflowStage = (cwd, workflowId) => {
      try {
        if (!cwd || !workflowId) return '';
        const state = readOptionalJsonFile(join(cwd, 'openspec', 'states', String(workflowId) + '.json'));
        const stage = state?.currentStage;
        return typeof stage === 'string' ? stage : '';
      } catch {
        return '';
      }
    };

    /** 读 review.md 的 Overall Verdict → 'ready' | 'needs_revision' | 'not_ready' | null。 */
    const readReviewOutcome = (cwd, workflowId) => {
      try {
        if (!cwd || !workflowId) return null;
        return parseReviewFileVerdict(readFileSync(join(cwd, 'openspec', 'changes', String(workflowId), 'review.md'), 'utf8'));
      } catch {
        return null;
      }
    };

    /** 渲染知识沉淀阶段委派模板（{workflowId}/{cwd}/{reviewNote}/{question} 占位符）。 */
    const renderKnowledgeTemplate = (template, st, cwd, reviewNote, question) => (template ?? '')
      .replaceAll('{workflowId}', st.workflowId || '（未绑定）')
      .replaceAll('{cwd}', cwd || '（未知工作区）')
      .replaceAll('{reviewNote}', reviewNote ?? '')
      .replaceAll('{question}', typeof question === 'string' && question !== '' ? question : '（无）');

    /**
     * 宿主派发知识沉淀子代理（探索者 / 挑战者）：按 label 创建/复用，失败注入会话
     * 可见告警并回退等待态可重试。
     * @param role - 'explorer' | 'challenger'
     * @param noteName - 告警文案里的中文角色名
     */
    const dispatchKnowledge = async (sessionId, role, stage, text, noteName) => {
      try {
        const mainAgent = resolveMainAgent(sessionId);
        const fail = (msg) => {
          steerArenaNote(mainAgent, msg);
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null });
        };
        if (!mainAgent) {
          ctx.logger?.warn?.('arena-v2: k-dispatch ' + stage + ' aborted — live main agent unavailable for ' + sessionId);
          fail('⚠ 竞技场' + noteName + '派发失败：无法取得当前会话的 live 主代理（已回到等待态，可重试）。');
          return;
        }
        const st = readArenaState(sessionId);
        const cfg = scope?.get?.() ?? {};
        const subagentsSvc = settingsCtx.get('subagents');
        if (!subagentsSvc || typeof subagentsSvc.startContinuable !== 'function') {
          ctx.logger?.warn?.('arena-v2: k-dispatch ' + stage + ' aborted — subagents service unavailable');
          fail('⚠ 竞技场' + noteName + '派发失败：subagents 服务不可用（已回到等待态，可重试）。');
          return;
        }
        const label = role === 'explorer' ? explorerLabelFor(st.scene) : challengerLabelFor(st.scene);
        const key = subagentKey(sessionId, label);
        let childId = subagents.get(key);
        if (!childId) {
          // 重跑/重启后内存缓存为空：派发前强制按 label 找回既有可接续子代理，
          // 命中就直接续聊（上下文跨轮次保留），而不是新建一个丢上下文的副本。
          await resolveSubagent(sessionId, label, { force: true });
          childId = subagents.get(key);
          if (childId) ctx.logger?.info?.('arena-v2: k-dispatch ' + stage + ' recovered existing ' + role + ' ' + childId);
        }
        const content = [{ type: 'text', text: sanitizeSessionRefs(text) }];
        // 固定模型 + persona：随创建请求传入（dsh 0.1.2-alpha.4 的机制；spawn 支持，
        // 并随 descriptor 持久化、冷恢复重放）。
        const model = challengerModelOf(cfg);
        const personas = scenePersonasOf(cfg, st.scene);
        const persona = role === 'explorer' ? personas.explorerPrompt : personas.challengerPrompt;
        const agentOptions = {
          provider: model.provider,
          model: model.model,
          ...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}
        };
        if (childId) {
          await queueToChild(subagentsSvc, mainAgent, childId, content, dispatchAbort.signal);
          ctx.logger?.info?.('arena-v2: k-dispatch ' + stage + ' -> queue ' + childId);
        } else {
          const res = await subagentsSvc.startContinuable({
            provider: subagentProviderOf(cfg),
            label,
            request: {
              parent: mainAgent,
              prompt: content,
              maxDepth: 1,
              agentOptions,
              ...persona !== '' ? { persona } : {}
            },
            signal: dispatchAbort.signal
          });
          if (res?.childId) subagents.set(key, String(res.childId));
          ctx.logger?.info?.('arena-v2: k-dispatch ' + stage + ' -> create ' + String(res?.childId ?? ''));
        }
      } catch (error) {
        const errText = String(error?.message ?? error);
        ctx.logger?.warn?.('arena-v2: k-dispatch ' + stage + ' failed: ' + errText);
        try {
          steerArenaNote(resolveMainAgent(sessionId), '⚠ 竞技场' + noteName + '派发失败：' + errText + '（已回到等待态，可重试）。');
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null });
        } catch {}
      }
    };

    /**
     * 断点续跑：子代理工作阶段（knowledge 的 k_explore/k_propose/k_review/k_readiness，
     * business/qa 的 challenge/verdict）被宿主进程重启/崩溃中断后，用户发任意消息
     * （如「继续」）→ 若对应子代理**没有运行中的任务**，把同一阶段幂等重派：
     * - 子代理已存在（durable，历史中含完整委派）→ 投递**短续跑指令**（kickResumeText，
     *   自带阶段返回协议），不重发整份模板、不污染上下文；
     * - 子代理从未创建（崩溃落在派发写入与创建之间）→ knowledge 按阶段完整模板重建
     *   （与 k_init 续跑一致），business/qa 走 dispatchArenaRound 重建。
     * 30s 节流防重复；子代理 live 且 running 时跳过（避免双发）。
     * @param sessionId - 顶层会话 id。
     * @param work - childWorkOf 的结果。
     * @param cwd - 会话工作区。
     * @returns 是否触发续跑。
     */
    const kickResumeChild = async (sessionId, work, cwd) => {
      try {
        const st = readArenaState(sessionId);
        if (!st.active) return false;
        const cfg = scope?.get?.() ?? {};
        const scene = work.scene ?? st.scene;
        const label = work.role === 'explorer' ? explorerLabelFor(scene) : challengerLabelFor(scene);
        const key = subagentKey(sessionId, label);
        const subagentsSvc = settingsCtx.get('subagents');
        const mainAgent = resolveMainAgent(sessionId);
        if (!subagentsSvc || !mainAgent) return false;
        let childId = subagents.get(key);
        if (childId) {
          const live = settingsCtx.get('agents')?.get?.(childId);
          if (live && live.status === 'running') {
            ctx.logger?.info?.('arena-v2: kick resume ' + work.pending + ' skipped (child running ' + childId + ') for ' + sessionId);
            return false; // 子代理仍在工作，普通消息照旧忽略，不双发
          }
        } else {
          await resolveSubagent(sessionId, label, { force: true });
          childId = subagents.get(key);
        }
        const now = Date.now();
        const last = kickThrottle.get(sessionId);
        if (last !== void 0 && now - last < KICK_THROTTLE_MS) {
          ctx.logger?.info?.('arena-v2: kick resume ' + work.pending + ' throttled for ' + sessionId);
          return false;
        }
        kickThrottle.set(sessionId, now);
        const content = [{ type: 'text', text: sanitizeSessionRefs(kickResumeText(work)) }];
        if (childId) {
          await queueToChild(subagentsSvc, mainAgent, childId, content, dispatchAbort.signal);
          ctx.logger?.info?.('arena-v2: kick resume ' + work.pending + ' -> queue ' + childId + ' for ' + sessionId);
          return true;
        }
        // 子代理从未创建（崩溃落在派发写入与 startContinuable 之间）：按阶段完整重建。
        if (work.pending === 'challenge' || work.pending === 'verdict') {
          ctx.logger?.info?.('arena-v2: kick resume ' + work.pending + ' -> recreate challenger for ' + sessionId);
          void dispatchArenaRound(sessionId, work.pending);
          return true;
        }
        const personas = scenePersonasOf(cfg, 'knowledge');
        const template = work.pending === 'explore' ? personas.explorePrompt
          : work.pending === 'propose' ? personas.proposePrompt
            : work.pending === 'review' ? personas.reviewPrompt
              : personas.readinessPrompt;
        const roleName = work.role === 'explorer' ? '探索者' : '挑战者';
        // 重建窗口的子代理没有历史委派；explore 的原问题已不可回放（当前消息是「继续」），
        // 模板按无问题渲染（探索者需要澄清会发 NEED_QUESTION），阶段工件幂等可覆盖。
        const text = renderKnowledgeTemplate(template, { ...st, workflowId: st.workflowId }, cwd, '', '');
        ctx.logger?.info?.('arena-v2: kick resume ' + work.pending + ' -> recreate ' + roleName + ' for ' + sessionId);
        void dispatchKnowledge(sessionId, work.role, work.pending, text, roleName);
        return true;
      } catch (error) {
        ctx.logger?.warn?.('arena-v2: kick resume failed: ' + String(error?.message ?? error));
        return false;
      }
    };

    /**
     * 知识沉淀断点自愈（0.33.23）：宿主在 `agent/created` 时机（会话被打开/重启挂载）
     * 按 Theseus 文件真相对齐一次——发现「Theseus 已推进到子代理工作阶段，而竞技场
     * 侧文件已清空（被误关/中断）或还停在对应工作阶段（重启中断）」时，**自动重建
     * 侧文件并派发该阶段**（含创建 review 挑战者），不需要用户手动重开竞技场/发消息。
     * 明确关闭的竞技场（侧文件 active=false 但 workflowId/kStage 保留）不自动续跑，
     * 尊重用户开关意图。
     * @param agent - 顶层会话的 live 主代理。
     * @param sessionId - 会话 id。
     */
    const reconcileKnowledgeResume = async (agent, sessionId) => {
      try {
        const st = readArenaState(sessionId);
        if (st.scene !== 'knowledge') return;
        const cwd = sessionCwd(agent?.session ?? null);
        if (cwd === '') return;
        const workflowId = readKnowledgeWorkflowId(cwd, sessionId);
        if (workflowId === '') return;
        const stageNow = readWorkflowStage(cwd, workflowId);
        const target = knowledgeStageResumeOf(stageNow ?? '');
        if (!target) return; // archive/done/未知：无需续跑
        // 用户明确关闭（off 只置 active=false，字段保留）→ 不自动重开。
        if (!st.active && (st.workflowId !== '' || st.kStage !== '')) return;
        if (st.active) {
          // 重启中断：还停在对应工作阶段 → 走 kick 短续跑（复用既有子代理上下文）。
          const work = childWorkOf(st, true);
          if (work && work.pending === target.pending) {
            void kickResumeChild(sessionId, work, cwd);
            return;
          }
          // 其余 active 状态（决策阶段/等待用户）→ 不打扰，交给既有回合逻辑。
          return;
        }
        // 侧文件 inactive 且已清空（被误关/中断后无人恢复）：按 Theseus 真相重建并派发。
        const now = Date.now();
        const last = kickThrottle.get(sessionId);
        if (last !== void 0 && now - last < KICK_THROTTLE_MS) return;
        kickThrottle.set(sessionId, now);
        const cfg = scope?.get?.() ?? {};
        const personas = scenePersonasOf(cfg, 'knowledge');
        if (target.pending === null) {
          // apply：主控者执行阶段——重开竞技场并注入 apply 回合提示。
          writeArenaState(sessionId, { active: true, scene: 'knowledge', phase: ARENA_PHASE_K_APPLY, pendingDispatch: null, kStage: '', kNext: '', kResult: '', workflowId, reviewOutcome: null });
          installMainPersona(agent);
          steerArenaNote(resolveMainAgent(sessionId), '[arena-v2] 宿主：workflow 已处于 apply 阶段（readiness 已 CLEARED）。请按当前「竞技阶段」执行 apply（theseus-apply-change）。');
          ctx.logger?.info?.('arena-v2: knowledge auto-resume -> apply turn for ' + sessionId);
          return;
        }
        const question = target.pending === 'explore'
          ? collectUserQuestion(sessionEventsOf(agent?.session))
          : '';
        const text = renderKnowledgeTemplate(personas[target.templateKey], { ...st, workflowId }, cwd, '', question);
        writeArenaState(sessionId, {
          active: true, scene: 'knowledge', phase: target.phase, pendingDispatch: target.pending,
          kStage: target.kStage, kNext: '', kResult: '', workflowId, reviewOutcome: null
        });
        installMainPersona(agent);
        const roleName = target.role === 'challenger' ? '挑战者' : '探索者';
        ctx.logger?.info?.('arena-v2: knowledge auto-resume -> ' + target.pending + ' (' + roleName + ') for ' + sessionId);
        void dispatchKnowledge(sessionId, target.role, target.pending, text, roleName);
      } catch (error) {
        ctx.logger?.warn?.('arena-v2: knowledge auto-resume failed: ' + String(error?.message ?? error));
      }
    };
    // ── 意图识别（flash LLM）：判断用户消息 need_answer / no_need_answer ────
    // 并行预判：用户消息到达即进入作答阶段（主代理零延迟作答），同时用 flash 轻量
    // 模型（reasoningEffort=off）判定该消息是否需要竞技；turn/end 时取结果——
    // no_need_answer（纯测试/问候/确认/闲聊）不派发挑战者、静默复位 awaiting；
    // need_answer 或判定失败（保守）→ 照常派发。
    const eventText = (event) => {
      try {
        const content = event?.data?.content;
        if (!Array.isArray(content)) return '';
        return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
      } catch {
        return '';
      }
    };

    /** 调 flash LLM 做意图判定；返回 'need_answer' | 'no_need_answer' | null（失败/未启用）。 */
    const classifyIntentNeed = async (cfg, userText, sessionId, signal) => {
      try {
        const intent = cfg?.intent ?? DEFAULT_INTENT_CONFIG;
        if (intent.enabled === false) return null;
        const llm = settingsCtx.get('llm');
        if (!llm || typeof llm.stream !== 'function') return null;
        if (typeof userText !== 'string' || userText.trim() === '') return null;
        const system = '判断下面这条用户消息是否需要详细回答/进入竞技流程：纯测试、问候、确认、闲聊、无需回复的内容 → 输出 no_need_answer；实质性提问或请求 → 输出 need_answer。只输出 JSON：{"answer":"need_answer"} 或 {"answer":"no_need_answer"}，不要输出其它内容。';
        const messages = [createUserMessage({
          content: [{ type: 'text', text: userText }],
          source: { kind: 'plugin', plugin: name }
        })];
        const base = {
          provider: intent.provider ?? DEFAULT_INTENT_CONFIG.provider,
          model: intent.model ?? DEFAULT_INTENT_CONFIG.model,
          messages,
          system,
          maxTokens: Number.isFinite(intent.maxTokens) ? intent.maxTokens : DEFAULT_INTENT_CONFIG.maxTokens,
          sessionId,
          purpose: 'arena-intent',
          signal
        };
        const attempt = async (options) => {
          const assembler = new BlockAssembler();
          for await (const chunk of llm.stream(options)) {
            signal.throwIfAborted();
            assembler.push(chunk);
          }
          return (assembler.blocks() ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        };
        try {
          const text = await attempt({ ...base, reasoningEffort: intent.reasoningEffort ?? DEFAULT_INTENT_CONFIG.reasoningEffort });
          return parseIntentOutput(text);
        } catch (error) {
          // 模型不支持该 reasoningEffort → 省略该字段重试一次。
          if (String(error?.message ?? '').includes('UNSUPPORTED_REASONING_EFFORT')) {
            const text = await attempt(base);
            return parseIntentOutput(text);
          }
          return null;
        }
      } catch {
        return null;
      }
    };

    // sessionId -> 最近一条用户消息的判定 promise（每次用户消息覆盖；turn/end 取结果）。
    const intentBySession = new Map();
    const seedIntent = (sessionId, userText) => {
      try {
        const cfg = scope?.get?.() ?? {};
        const timeout = Number.isFinite(cfg?.intent?.timeoutMs) ? cfg.intent.timeoutMs : DEFAULT_INTENT_CONFIG.timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const promise = classifyIntentNeed(cfg, userText, sessionId, controller.signal)
          .catch(() => null)
          .finally(() => clearTimeout(timer));
        intentBySession.set(sessionId, { text: userText, promise });
      } catch {}
    };
    const awaitIntent = async (sessionId) => {
      const entry = intentBySession.get(sessionId);
      if (entry === void 0) return null;
      try {
        return await entry.promise;
      } catch {
        return null;
      }
    };

    const offSessionEvent = settingsCtx.on('session/event', async (session, event) => {
      try {
        if (!event || !session) return;
        const sessionId = String(session.id);
        // 竞技场会话的事件追踪（终端可见；配合注入会话的失败提示定位）。
        if (readArenaMode(sessionId)) {
          const tr = readArenaState(sessionId);
          if (event.type === 'user/message' || event.type === 'turn/start' || event.type === 'turn/end') {
            ctx.logger?.info?.('arena-v2: ev ' + event.type + ' kind=' + String(event.data?.source?.kind) + ' session=' + sessionId + ' phase=' + tr.phase);
          }
        }
        if (!isArenaTopLevelSession(session)) return;
        const st = readArenaState(sessionId);
        const isKnowledge = st.scene === 'knowledge';
        const cwd = sessionCwd(session);
        // 用户新消息：空闲时开启新一轮——knowledge → 绑定阶段（k_init），business/qa → 作答阶段。
        // 并行预判意图（flash），turn/end 时据此决定是否继续。
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
          if (st.phase === ARENA_PHASE_AWAITING) {
            const userText = eventText(event);
            writeArenaState(sessionId, {
              active: true,
              phase: isKnowledge ? ARENA_PHASE_K_INIT : ARENA_PHASE_ANSWER,
              verdictRounds: 0,
              verdictOutcome: null,
              reviewOutcome: null,
              workflowId: isKnowledge ? '' : st.workflowId
            });
            void seedIntent(sessionId, userText);
            ctx.logger?.info?.('arena-v2: user msg -> phase ' + (isKnowledge ? 'k_init' : 'answer') + ' for ' + sessionId);
          } else {
            // 断点续跑：子代理工作阶段（knowledge k_explore/k_propose/k_review/k_readiness，
            // business/qa challenge/verdict）被宿主进程重启/崩溃中断后（子代理回合死在
            // 半途、无结算、无工件），用户发任意消息（如「继续」）→ 子代理未在运行则
            // 幂等重派同一阶段，一条「继续」恢复所有断点、无需手动关开竞技场。
            // 其余阶段（主代理交互阶段 k_init/k_gate/k_ask/k_verdict/k_apply/answer/revise/
            // present）的用户消息照旧只记录——消息本身会到达主代理，由其按阶段指示推进。
            const work = childWorkOf(st, isKnowledge);
            if (work) {
              ctx.logger?.info?.('arena-v2: user msg during child phase ' + st.phase + ' -> kick resume for ' + sessionId);
              void kickResumeChild(sessionId, work, cwd);
            } else {
              ctx.logger?.info?.('arena-v2: user msg ignored (phase=' + st.phase + ') for ' + sessionId);
            }
          }
          return;
        }
        // 子代理结算回传。
        if (event.type === 'user/message' && event.data?.source?.kind === 'subagent-settled') {
          if (!isKnowledge) {
            if (st.phase === ARENA_PHASE_CHALLENGE && st.pendingDispatch === ARENA_PHASE_CHALLENGE) {
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_REVISE, pendingDispatch: null });
            } else if (st.phase === ARENA_PHASE_VERDICT && st.pendingDispatch === ARENA_PHASE_VERDICT) {
              // 终评回传：机器判定结论（认可 / 仍存疑），present 阶段据此分支。
              // 无法判定时保守按「仍存疑」处理——把决定权交回用户（问是否再来一轮），
              // 而不是直接关闭竞技场。
              const parsedOutcome = parseVerdictOutcome(eventText(event));
              writeArenaState(sessionId, {
                active: true,
                phase: ARENA_PHASE_PRESENT,
                pendingDispatch: null,
                verdictOutcome: parsedOutcome ?? 'disputed'
              });
              ctx.logger?.info?.('arena-v2: verdict outcome=' + String(parsedOutcome ?? 'unparsed→disputed') + ' for ' + sessionId);
            }
            return;
          }
          // ── knowledge：探索者/挑战者结算 ──
          const settleText = eventText(event);
          if (st.phase === ARENA_PHASE_K_EXPLORE || st.phase === ARENA_PHASE_K_PROPOSE || st.phase === ARENA_PHASE_K_READINESS) {
            if (st.pendingDispatch !== st.kStage) return; // 错轮结算忽略
            const parsed = parseStageResult(settleText);
            if (parsed?.kind === 'need_question') {
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_ASK, pendingDispatch: null, kPrev: st.phase, kQuestion: parsed.question });
              ctx.logger?.info?.('arena-v2: k question relay from ' + st.phase + ' for ' + sessionId);
              return;
            }
            if (parsed?.kind === 'blocked') {
              steerArenaNote(resolveMainAgent(sessionId), '⚠ 探索者受阻：' + (parsed.reason || '未说明原因') + '。竞技场已回到等待态，可重试。');
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null });
              return;
            }
            if (parsed?.kind === 'stage_done') {
              const stage = st.kStage;
              let next = '';
              if (stage === 'explore') next = 'propose';
              else if (stage === 'propose') next = 'review';
              else if (stage === 'readiness') next = parsed.result === 'CLEARED' ? 'apply' : 'close';
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_GATE, pendingDispatch: null, kNext: next, kResult: parsed.result });
              ctx.logger?.info?.('arena-v2: k stage done ' + stage + ' result=' + parsed.result + ' next=' + next + ' for ' + sessionId);
              return;
            }
            steerArenaNote(resolveMainAgent(sessionId), '⚠ 探索者返回内容无法解析（期望 STAGE_DONE / NEED_QUESTION / BLOCKED 协议行）。竞技场已回到等待态，可重试。');
            writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null });
            return;
          }
          if (st.phase === ARENA_PHASE_K_REVIEW && st.pendingDispatch === 'review') {
            // 挑战者返回 Done；判定读 review.md 文件（文件为唯一真相）。
            const outcome = readReviewOutcome(cwd, st.workflowId);
            writeArenaState(sessionId, {
              active: true,
              phase: ARENA_PHASE_K_VERDICT,
              pendingDispatch: null,
              reviewOutcome: outcome ?? 'not_ready'
            });
            ctx.logger?.info?.('arena-v2: k review outcome=' + String(outcome ?? 'unparsed→not_ready') + ' for ' + sessionId);
          }
          return;
        }
        // 主代理回合结束：按阶段派发或关闭竞技场。
        if (event.type === 'turn/end') {
          if (!isKnowledge) {
            if (st.phase === ARENA_PHASE_ANSWER) {
              // 意图门控：no_need_answer（纯测试/问候/确认）不派发、静默复位；need_answer
              // 或判定失败（保守放行）→ 照常派发质疑轮。
              const intent = await awaitIntent(sessionId);
              if (intent === 'no_need_answer') {
                writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, pendingDispatch: null });
                ctx.logger?.info?.('arena-v2: skip dispatch (no_need_answer) for ' + sessionId);
                return;
              }
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_CHALLENGE, pendingDispatch: ARENA_PHASE_CHALLENGE });
              void dispatchArenaRound(sessionId, 'challenge');
            } else if (st.phase === ARENA_PHASE_REVISE) {
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_VERDICT, pendingDispatch: ARENA_PHASE_VERDICT });
              void dispatchArenaRound(sessionId, 'verdict');
            } else if (st.phase === ARENA_PHASE_PRESENT) {
              // 终评呈现回合结束：仅当终评「仍存疑」且用户明确选择再来一轮时，
              // 再派发一次终评轮（主代理已在本回合内完成修正）；其余情况——终评认可、
              // 用户拒绝、或没问/无法判定——都收尾关闭（主代理按【结论输出要求】
              // 已整理并输出完整结论）。不记录轮次、不设上限：由用户逐轮决定。
              const choice = st.verdictOutcome === 'disputed'
                ? readAnotherRoundChoice(sessionId, sessionEventsOf(session))
                : null;
              if (choice === 'continue') {
                writeArenaState(sessionId, {
                  active: true,
                  phase: ARENA_PHASE_VERDICT,
                  pendingDispatch: ARENA_PHASE_VERDICT,
                  verdictOutcome: null
                });
                ctx.logger?.info?.('arena-v2: another round requested by user -> verdict for ' + sessionId);
                void dispatchArenaRound(sessionId, 'verdict');
                return;
              }
              ctx.logger?.info?.('arena-v2: finish round (outcome=' + String(st.verdictOutcome)
                + ' choice=' + String(choice) + ') for ' + sessionId);
              finishArenaRound(sessionId);
            }
            return;
          }
          // ── knowledge：主控者回合结束，按阶段推进 ──
          const cfgK = scope?.get?.() ?? {};
          const personasK = scenePersonasOf(cfgK, 'knowledge');
          // 会话事件取 session/event 处理器收到的当前 Session 快照（dsh 0.1.2-alpha.4
          // 的 Session 没有 .events；snapshotEvents() 与持久化 jsonl 同源，含 turn/start）。
          const eventsK = sessionEventsOf(session);
          // 「子代理任务在途」的机械信号（0.33.22 泛化）：本回合主控者是否已向竞技场
          // 子代理（按 label 缓存的 durable id）send_message 委派过任务——修订轮、中断后
          // rerun、宿主漏派后的补派、NEED_QUESTION 答案直传等统一形态。k_gate / k_verdict
          // 据此留场等待结算（不把「未确认/未 record」误判成关场），k_ask 据此跳过重复中继。
          const arenaChildIds = [
            subagents.get(explorerKey(sessionId, st.scene)),
            subagents.get(challengerKey(sessionId, st.scene))
          ].filter((v) => typeof v === 'string');
          const childTaskInFlight = hasArenaChildDelegation(eventsK, arenaChildIds);
          if (st.phase === ARENA_PHASE_K_INIT) {
            // 续跑优先：会话焦点文件已有绑定时，以 Theseus 状态文件为真相跳到对应阶段
            // （跳过意图门控——重启/重开后用户发「继续」即可续跑，不会重跑已完成的阶段）。
            const workflowId = readKnowledgeWorkflowId(cwd, sessionId);
            if (workflowId === '') {
              const intent = await awaitIntent(sessionId);
              if (intent === 'no_need_answer') {
                writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, pendingDispatch: null });
                ctx.logger?.info?.('arena-v2: k skip dispatch (no_need_answer) for ' + sessionId);
                return;
              }
              steerArenaNote(resolveMainAgent(sessionId), '⚠ 未检测到 Theseus workflow 绑定：请先 /theseus on --bind <id> 或 --init <主题>，再重新开始。竞技场已回到等待态。');
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null });
              return;
            }
            const stageNow = readWorkflowStage(cwd, workflowId) || 'explore';
            const resumeFrom = (phase, kStage, pending, template, role, noteName, extra) => {
              const text = renderKnowledgeTemplate(template, { ...st, workflowId }, cwd, '', extra ?? '');
              writeArenaState(sessionId, { active: true, phase, pendingDispatch: pending, kStage, kNext: '', kResult: '', workflowId });
              void dispatchKnowledge(sessionId, role, pending, text, noteName);
            };
            if (stageNow === 'propose') {
              // explore 已记录：跳过重复 record，直接派发 propose。
              ctx.logger?.info?.('arena-v2: k resume at propose for ' + sessionId);
              resumeFrom(ARENA_PHASE_K_PROPOSE, 'propose', 'propose', personasK.proposePrompt, 'explorer', '探索者');
            } else if (stageNow === 'review') {
              // propose 已记录：直接送审（review.md 尚未产出时挑战者会照常审查现有工件）。
              ctx.logger?.info?.('arena-v2: k resume at review for ' + sessionId);
              resumeFrom(ARENA_PHASE_K_REVIEW, '', 'review', personasK.reviewPrompt, 'challenger', '挑战者');
            } else if (stageNow === 'user-readiness-review') {
              // review READY 已记录：直接续 readiness（报告是否生成已无法回放，按跳过处理；需要报告可事后补）。
              ctx.logger?.info?.('arena-v2: k resume at readiness for ' + sessionId);
              resumeFrom(ARENA_PHASE_K_READINESS, 'readiness', 'readiness', personasK.readinessPrompt, 'explorer', '探索者');
            } else if (stageNow === 'apply') {
              // readiness CLEARED 已记录：主控者直接执行 apply。
              ctx.logger?.info?.('arena-v2: k resume at apply for ' + sessionId);
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_APPLY, pendingDispatch: null, kStage: '', kNext: '', kResult: '', workflowId });
              steerArenaNote(resolveMainAgent(sessionId), '[arena-v2] 宿主：workflow 已处于 apply 阶段（readiness 已 CLEARED）。请按当前「竞技阶段」执行 apply（theseus-apply-change）。');
            } else if (stageNow === 'archive' || stageNow === 'done') {
              // workflow 已完成/归档：无需再跑竞技场。
              ctx.logger?.info?.('arena-v2: k resume sees ' + stageNow + ' -> close for ' + sessionId);
              steerArenaNote(resolveMainAgent(sessionId), '[arena-v2] Theseus workflow 已处于 ' + stageNow + ' 阶段，本轮竞技场无需继续。');
              finishArenaRound(sessionId);
            } else {
              // explore（首次或仍在 explore 阶段）。
              const question = collectUserQuestion(eventsK);
              resumeFrom(ARENA_PHASE_K_EXPLORE, 'explore', 'explore', personasK.explorePrompt, 'explorer', '探索者', question);
            }
            return;
          }
          if (st.phase === ARENA_PHASE_K_GATE) {
            if (st.kNext === 'close') {
              finishArenaRound(sessionId); // readiness NOT_CLEARED / NEEDS_REVISION：主控者已总结
              return;
            }
            // 阶段推进确认门：用户必须选「确认，进入下一阶段」才推进；选暂停 → 不推进
            // 关闭。确认回答偶发取不到（结算乱序/一次多问）时，以 Theseus 状态文件为
            // 真相兜底——主控者 persona 只允许「用户确认后」才 judge+record，状态文件推进
            // 到 expected 本身就是用户已确认的机器信号；仍未推进则关场并给**可见提示**
            // （不再静默误关），可重开 `/arena knowledge` 发「继续」续跑。
            const answers = collectAskAnswerText(eventsK);
            const advance = parseAdvanceChoice(answers);
            // 修订轮（0.33.20）：judge 未通过时主控者可问用户是否让探索者修订（固定 id
            // arena_k_revision），同意后主控者用 send_message 向**既有探索者**委派修订轮
            // （创建类工具仍被禁用）。此时本回合无 arena_k_advance 确认、也未 record——
            // 不能走「未确认→关场」：保持 k_gate 等待探索者修订结算，再重新确认/record。
            // 0.33.21/0.33.22：若主控者跳过提问、直接 send_message 委派（修订/rerun/补派
            // 等），以 childTaskInFlight 机械信号兜底同样留场，不依赖主代理「记得提问」。
            const revision = parseKnowledgeChoice(answers, 'revision');
            const expected = st.kNext === 'propose' || st.kNext === 'review' || st.kNext === 'apply' ? st.kNext : '';
            const actual = expected === '' ? '' : readWorkflowStage(cwd, st.workflowId);
            const plan = planKnowledgeGate(advance, revision, actual, expected, childTaskInFlight);
            if (plan.action === 'stay') {
              ctx.logger?.info?.('arena-v2: k gate child task in flight (revision=' + String(revision) + ') -> stay k_gate for ' + sessionId);
              return;
            }
            if (plan.action === 'dispatch') {
              if (advance === null) {
                ctx.logger?.info?.('arena-v2: k advance answer unparsed but state file advanced (' + expected + ') -> dispatch by file truth for ' + sessionId);
              }
              if (st.kNext === 'propose') {
                const text = renderKnowledgeTemplate(personasK.proposePrompt, st, cwd, '');
                writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_PROPOSE, pendingDispatch: 'propose', kStage: 'propose', kNext: '', kResult: '' });
                void dispatchKnowledge(sessionId, 'explorer', 'propose', text, '探索者');
              } else if (st.kNext === 'review') {
                const text = renderKnowledgeTemplate(personasK.reviewPrompt, st, cwd, '');
                writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_REVIEW, pendingDispatch: 'review', kStage: '', kNext: '', kResult: '' });
                void dispatchKnowledge(sessionId, 'challenger', 'review', text, '挑战者');
              } else if (st.kNext === 'apply') {
                // readiness CLEARED：主控者已 record；steer 一条宿主提示开启 apply 回合
                // （k_gate 回合刚结束，必须注入新消息触发主控者的 k_apply 回合）。
                writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_APPLY, pendingDispatch: null, kNext: '' });
                steerArenaNote(resolveMainAgent(sessionId), '[arena-v2] 宿主：user-readiness 已 CLEARED。请按当前「竞技阶段」执行 apply（theseus-apply-change）。');
              }
              return;
            }
            if (plan.action === 'retry') {
              steerArenaNote(resolveMainAgent(sessionId), '⚠ record 未生效：Theseus workflow 阶段未推进（期望 ' + (expected || '—') + '，实际 ' + (actual || '未知') + '）。请 judge --current 排查并完成 record 后再结束回合。');
              return; // 留在 k_gate 重试
            }
            // close：用户暂停（stop）/ 未确认且未 record（no-confirm-no-record）。
            ctx.logger?.info?.('arena-v2: k advance gate -> close (choice=' + String(advance)
              + ' reason=' + String(plan.reason ?? '') + ') for ' + sessionId);
            if (plan.reason === 'no-confirm-no-record') {
              steerArenaNote(resolveMainAgent(sessionId), '⚠ 未能确认推进下一阶段：未读到你的「确认」回答，且 Theseus workflow 仍未推进到 ' + (expected || '—') + '（当前 ' + (actual || '未知') + '）。竞技场已关闭——如需继续请重开 `/arena knowledge` 后发「继续」，宿主会按 openspec/states 续跑。');
            }
            finishArenaRound(sessionId);
            return;
          }
          if (st.phase === ARENA_PHASE_K_ASK) {
            const answers = collectAskAnswerText(eventsK);
            if (answers.length === 0) {
              steerArenaNote(resolveMainAgent(sessionId), '⚠ 未取到用户对中继提问的回答。竞技场已回到等待态，可重试。');
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null });
              return;
            }
            const answer = answers[answers.length - 1];
            const resumePhase = st.kPrev === ARENA_PHASE_K_EXPLORE || st.kPrev === ARENA_PHASE_K_PROPOSE || st.kPrev === ARENA_PHASE_K_READINESS
              ? st.kPrev
              : ARENA_PHASE_K_EXPLORE;
            const resumeStage = st.kStage !== '' ? st.kStage
              : (resumePhase === ARENA_PHASE_K_EXPLORE ? 'explore' : resumePhase === ARENA_PHASE_K_PROPOSE ? 'propose' : 'readiness');
            writeArenaState(sessionId, { active: true, phase: resumePhase, pendingDispatch: resumeStage, kStage: resumeStage, kPrev: '', kQuestion: '' });
            if (childTaskInFlight) {
              // 主控者已直接把答案 send_message 回传给探索者（替代宿主中继）→ 只恢复
              // 阶段状态等待结算，不再重复派发中继答案（避免探索者收到双份）。
              ctx.logger?.info?.('arena-v2: k ask answer relayed by controller directly -> skip host relay for ' + sessionId);
              return;
            }
            void dispatchKnowledge(sessionId, 'explorer', resumeStage, '[中继答案] ' + answer + '\n\n继续你当前阶段，按返回协议输出。', '探索者');
            return;
          }
          if (st.phase === ARENA_PHASE_K_VERDICT) {
            if (st.reviewOutcome === 'ready') {
              const answers = collectAskAnswerText(eventsK);
              const reportChoice = parseKnowledgeChoice(answers, 'report');
              const advance = parseAdvanceChoice(answers);
              if (advance !== 'continue') {
                if (childTaskInFlight) {
                  // 主控者已直接向竞技场子代理委派任务（如自行派发 readiness/报告）→ 留场等结算。
                  ctx.logger?.info?.('arena-v2: k READY gate child task in flight -> stay k_verdict for ' + sessionId);
                  return;
                }
                // 用户未确认进入 user-readiness（暂停/没问）→ 不推进，关闭竞技场。
                ctx.logger?.info?.('arena-v2: k READY advance gate -> close (choice=' + String(advance) + ') for ' + sessionId);
                finishArenaRound(sessionId);
                return;
              }
              const reportNote = reportChoice === 'generate' ? renderKnowledgeTemplate(personasK.reportPrompt, st, cwd, '') : '';
              const text = (reportNote === '' ? '' : reportNote + '\n\n') + renderKnowledgeTemplate(personasK.readinessPrompt, st, cwd, '');
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_READINESS, pendingDispatch: 'readiness', kStage: 'readiness', kNext: '', reviewOutcome: null });
              void dispatchKnowledge(sessionId, 'explorer', 'readiness', text, '探索者');
              return;
            }
            if (st.reviewOutcome === 'needs_revision' || st.reviewOutcome === 'not_ready') {
              // NOT_READY 与 NEEDS_REVISION 不区分：本质都是「探索者要重新修订」——
              // 一律问用户是否再来一轮；同意 → 重新派发 propose（修订轮，读到的是
              // review.md 的 Action Items / FAIL 项），拒绝/没问 → 按原 verdict 收尾
              // （主控者已 record review.completed NOT_READY 或 NEEDS_REVISION）。
              const choice = parseKnowledgeChoice(collectAskAnswerText(eventsK), 'revision');
              if (choice === 'continue') {
                const text = renderKnowledgeTemplate(personasK.proposePrompt, st, cwd, '本轮为修订轮：先读 review.md 的 Action Items（含 FAIL 项）逐条回应，再生成/更新工件。');
                writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_PROPOSE, pendingDispatch: 'propose', kStage: 'propose', kNext: '', reviewOutcome: null });
                void dispatchKnowledge(sessionId, 'explorer', 'propose', text, '探索者');
              } else if (childTaskInFlight) {
                // 主控者已直接把修订任务 send_message 给探索者（替代宿主重派）→ 留场等结算。
                ctx.logger?.info?.('arena-v2: k verdict ' + st.reviewOutcome + ' child task in flight -> stay k_verdict for ' + sessionId);
                return;
              } else {
                ctx.logger?.info?.('arena-v2: k verdict ' + st.reviewOutcome + ' -> close (choice=' + String(choice) + ') for ' + sessionId);
                finishArenaRound(sessionId);
              }
              return;
            }
            // reviewOutcome 为 null（无法判定，settle 时已保守置为 not_ready，理论不可达）
            finishArenaRound(sessionId);
            return;
          }
          if (st.phase === ARENA_PHASE_K_APPLY) {
            const actual = readWorkflowStage(cwd, st.workflowId);
            if (actual === 'archive') {
              finishArenaRound(sessionId);
            } else {
              steerArenaNote(resolveMainAgent(sessionId), '⚠ apply 未完成记录：Theseus workflow 仍处于 ' + (actual || '未知') + ' 阶段。请按 theseus-apply-change 完成任务与测试报告，record apply.completed IMPLEMENTED 后再结束回合。');
            }
            return;
          }
          // ── 自愈续跑：结算协议解析失败曾被回退 awaiting，但主代理已按结算消息
          // judge+record、Theseus 状态文件已推进（kStage 残留、workflowId 仍在）。
          // 以状态文件为真相恢复推进——文件推进到哪就派发哪个下一阶段（跳过重复 record）。
          if (st.phase === ARENA_PHASE_AWAITING && st.kStage !== '' && st.workflowId !== '') {
            const stageNow = readWorkflowStage(cwd, st.workflowId);
            if (st.kStage === 'explore' && stageNow === 'propose') {
              const text = renderKnowledgeTemplate(personasK.proposePrompt, st, cwd, '');
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_PROPOSE, pendingDispatch: 'propose', kStage: 'propose', kNext: '', kResult: '' });
              ctx.logger?.info?.('arena-v2: k resume (explore done) -> propose for ' + sessionId);
              void dispatchKnowledge(sessionId, 'explorer', 'propose', text, '探索者');
            } else if (st.kStage === 'propose' && stageNow === 'review') {
              const text = renderKnowledgeTemplate(personasK.reviewPrompt, st, cwd, '');
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_REVIEW, pendingDispatch: 'review', kStage: '', kNext: '', kResult: '' });
              ctx.logger?.info?.('arena-v2: k resume (propose done) -> review for ' + sessionId);
              void dispatchKnowledge(sessionId, 'challenger', 'review', text, '挑战者');
            } else if (st.kStage === 'readiness' && stageNow === 'apply') {
              writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_K_APPLY, pendingDispatch: null, kNext: '', kStage: '' });
              ctx.logger?.info?.('arena-v2: k resume (readiness done) -> apply for ' + sessionId);
              steerArenaNote(resolveMainAgent(sessionId), '[arena-v2] 宿主：user-readiness 已完成并通过记录。请按当前「竞技阶段」执行 apply（theseus-apply-change）。');
            }
          }
        }
      } catch {}
    });

    // ── 竞技场模式入口：/arena 命令（chip / hero 开关共用）────────────────
    // 参数：off 关闭；business|knowledge|qa 指定场景（首词是场景键则作场景，其余为
    // 消息）；无场景键时整段为消息，场景按会话原场景解析（默认 business）。
    // **场景锁定**：会话已有挑战者时不允许切换场景（请求场景 ≠ 当前场景 → 拒绝）；
    // 无挑战者的会话可经命令指定场景（/arena business|knowledge|qa）。
    const commands = settingsCtx.get('commands');
    const offCommand = commands?.register?.({
      name: 'arena',
      description: '开启或关闭竞技场（无挑战者时可用 /arena business|knowledge|qa 指定场景；已有挑战者的会话场景锁定，不可切换）',
      input: { hint: '[off|business|knowledge|qa|message]' },
      handler: async ({ agent, rawInput }) => {
        const parsed = parseArenaCommand(rawInput);
        if (parsed.off) {
          const outcome = setArenaMode(agent, false);
          return {
            kind: 'success',
            text: outcome === 'noop' ? '竞技场已是关闭状态。' : '竞技场已关闭。'
          };
        }
        const sessionId = String(agent?.id ?? '');
        const st = readArenaState(sessionId);
        const currentScene = st.scene; // 会话原场景（默认 business）
        const targetScene = parsed.scene ?? currentScene;
        // 工作区门控：knowledge/qa 仅限 intranet-aio（sceneWorkspace 可配）；命令指定
        // 被门控场景且当前 cwd 不满足 → 拒绝。
        if (parsed.scene !== null) {
          const cwd = agent?.session?.header?.cwd ?? '';
          const allowed = scenesAllowedIn(typeof cwd === 'string' ? cwd : '', scope?.get?.()?.sceneWorkspace);
          if (!allowed.includes(targetScene)) {
            return {
              kind: 'success',
              text: '场景 ' + (SCENE_NAMES[targetScene] ?? targetScene) + ' 仅限 intranet-aio 工作区使用；当前工作区不可用。'
            };
          }
        }
        // 场景锁定：请求场景与当前场景不一致时，若会话已有挑战者 → 拒绝切换。
        // （走带缓存的存在性检查——用户点击路径，避免每次 listChildren。）
        if (parsed.scene !== null && parsed.scene !== currentScene) {
          if (await hasChallengerCached(sessionId)) {
            return {
              kind: 'success',
              text: '竞技场场景已锁定：该会话已有' + (SCENE_NAMES[currentScene] ?? currentScene) + '挑战者，不能切换场景；如需其它场景请开新会话。'
            };
          }
        }
        const outcome = setArenaMode(agent, true, targetScene);
        if (parsed.message !== '') {
          try {
            agent.steer(createUserMessage({
              content: [{ type: 'text', text: parsed.message }],
              source: { kind: 'user' }
            }));
          } catch {}
        }
        const sceneName = SCENE_NAMES[targetScene] ?? targetScene;
        return {
          kind: 'success',
          text: outcome === 'committed'
            ? '竞技场已开启（场景：' + sceneName + '），下一条消息开始竞技。'
            : '竞技场已开启（场景：' + sceneName + '）。'
        };
      }
    });

    // ── 竞技场模式状态查询/场景保存：chip 与空白页 hero 开关共用 ───────────
    // 与 command-setting 同款 web 路由模式：客户端 fetch
    // /arena-v2/state?session=<id> 拿到当前会话的竞技场开关、场景与挑战者存在性
    // （hasChallenger/challengerScene——chip 据此决定是否显示场景选择），
    // 刷新页面 / 切换会话后 chip / hero 开关状态不丢。
    // 写场景：/arena-v2/state?session=<id>&scene=business|knowledge|qa —— hero 开关
    // 右侧分段控件保存场景；已有挑战者的会话场景锁定（不一致 → 400）。
    const sendJson = (res, status, payload) => {
      try {
        res?.setHeader?.('content-type', 'application/json');
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      } catch {}
    };
    /** 组装状态负载：开关/场景 + 挑战者存在性（枚举子代理按 label 判断，顺带预热锁定检查缓存）。 */
    const statePayload = async (sessionId) => {
      const st = readArenaState(sessionId);
      let hasChallenger = false;
      let challengerScene = st.scene;
      try {
        const entry = await cachedChildEntry(sessionId);
        if (entry !== null) {
          hasChallenger = true;
          const s = sceneFromAnyLabel(entry.label);
          if (s !== null) challengerScene = s;
        }
      } catch {}
      // 工作区门控：knowledge/qa 仅 intranet-aio（可配置 sceneWorkspace）可见可用。
      let allowedScenes = SCENES;
      try {
        const cwd = settingsCtx.get('agents')?.get?.(sessionId)?.session?.header?.cwd ?? '';
        allowedScenes = scenesAllowedIn(typeof cwd === 'string' ? cwd : '', scope?.get?.()?.sceneWorkspace);
      } catch {}
      return { ok: true, active: st.active, scene: st.scene, hasChallenger, challengerScene, allowedScenes };
    };
    let offRoute;
    try {
      offRoute = settingsCtx.get('webServer')?.register?.({
        kind: 'exact',
        path: '/arena-v2/state',
        handler: async (req, res) => {
          try {
            const url = new URL(req?.url ?? '/', 'http://x');
            const session = url.searchParams.get('session') ?? '';
            if (session === '') {
              sendJson(res, 400, { ok: false, message: 'missing session' });
              return;
            }
            const scene = url.searchParams.get('scene');
            if (scene !== null) {
              if (!SCENES.includes(scene)) {
                sendJson(res, 400, { ok: false, message: 'invalid scene' });
                return;
              }
              const current = readArenaState(session);
              // 工作区门控：被门控场景且 cwd 不满足 → 拒绝（与 /arena 命令一致）。
              try {
                const cwd = settingsCtx.get('agents')?.get?.(session)?.session?.header?.cwd ?? '';
                const allowed = scenesAllowedIn(typeof cwd === 'string' ? cwd : '', scope?.get?.()?.sceneWorkspace);
                if (!allowed.includes(scene)) {
                  sendJson(res, 400, { ok: false, message: 'scene not allowed in this workspace' });
                  return;
                }
              } catch {}
              // 场景锁定：已有挑战者的会话不允许切场景（与 /arena 命令一致，走缓存检查）。
              if (scene !== current.scene) {
                if (await hasChallengerCached(session)) {
                  sendJson(res, 400, { ok: false, message: 'scene locked: session already has a challenger' });
                  return;
                }
              }
              writeArenaState(session, { ...current, scene });
            }
            const payload = await statePayload(session);
            sendJson(res, 200, payload);
          } catch (error) {
            sendJson(res, 500, { ok: false, message: String(error?.message ?? error) });
          }
        }
      });
    } catch (error) {
      ctx.logger?.warn?.('arena-v2: state route register failed: ' + String(error?.message ?? error));
    }

    // ── 三场景 persona 查询：设置弹窗竞技场卡片拉取（有效 persona 集）──
    let offPersonasRoute;
    try {
      offPersonasRoute = settingsCtx.get('webServer')?.register?.({
        kind: 'exact',
        path: '/arena-v2/personas',
        handler: (req, res) => {
          try {
            const cfg = scope?.get?.() ?? {};
            const scenes = {};
            for (const s of SCENES) scenes[s] = scenePersonasOf(cfg, s);
            sendJson(res, 200, { ok: true, scenes });
          } catch (error) {
            sendJson(res, 500, { ok: false, message: String(error?.message ?? error) });
          }
        }
      });
    } catch (error) {
      ctx.logger?.warn?.('arena-v2: personas route register failed: ' + String(error?.message ?? error));
    }

    // ── 竞技工具已改为随竞技场开启按会话注册（见 installMainPersona）──
    // arena_compose / arena_finish 只在竞技场开启的会话可见，关闭即卸载。

    // 自动竞技指令注入：非子代理会话 + enabled + 竞技场模式开启 + 会话有 subagent 工具。
    // 与预设无关——只看 chip 是否开启；工具检查按会话作用域实时判断，没有
    // subagent 工具的预设（如 minimal）不会注入，避免进入无法创建挑战者的坏状态。
    const disposeSection = settingsCtx.systemPrompt?.section?.({
      name: 'arena-v2:auto-arena',
      order: 950,
      text: (context) => {
        try {
          const cfg = scope?.get?.() ?? {};
          const agent = context?.agent;
          const sessionId = agent ? String(agent.id) : '';
          // 诊断：记录每个注入门控（复现时看 dsh web 终端输出定位失败门）。
          const arenaOn = sessionId !== '' ? readArenaMode(sessionId) : false;
          const hasSubagent = (() => {
            try {
              const tools = settingsCtx.get('tools');
              return tools?.get?.('subagent', context.scope) !== void 0;
            } catch {
              return false;
            }
          })();
          ctx.logger?.info?.('arena-v2: section gate agent=' + sessionId
            + ' enabled=' + (cfg.enabled === true)
            + ' arenaOn=' + arenaOn
            + ' hasSubagent=' + hasSubagent
            + ' depth=' + String(agent?.options?.subagentDepth)
            + ' origin=' + String(agent?.session?.header?.origin));
          if (!cfg.enabled) return '';
          if (!agent) return '';
          // 子代理会话不注入（避免递归竞技）。
          const depth = agent.options?.subagentDepth;
          if (depth !== void 0 && depth !== null) return '';
          if (agent.session?.header?.origin === 'subagent') return '';
          // 竞技场模式未开启时不注入（chip 或 /arena 开启后才进入竞技流程）。
          if (!readArenaMode(String(agent.id))) return '';
          // 会话工具目录里没有 subagent 则不注入（与预设无关的可用性检查）。
          const tools = settingsCtx.get('tools');
          if (tools?.get?.('subagent', context.scope) === void 0) return '';
          // 无缓存 id 时懒触发一次按 (会话, 场景) 找回（节流）；本回合交给指令的
          // 兜底（历史里查 subagentId 或新建），下一轮提示就位。
          const state = readArenaState(sessionId);
          const scene = state.scene;
          const challengerId = subagents.get(challengerKey(sessionId, scene));
          if (!challengerId) void resolveChallenger(sessionId, scene);
          if (scene === 'knowledge') {
            const explorerId = subagents.get(explorerKey(sessionId, scene));
            if (!explorerId) void resolveExplorer(sessionId, scene);
          }
          const instruction = typeof cfg.instruction === 'string' ? cfg.instruction : '';
          // 回合模板按当前场景取（场景默认 > 顶层 business 默认 > 配置覆盖）。
          const personas = scenePersonasOf(cfg, scene);
          const prompt = personas.challengerPrompt;
          const challenge = personas.challengePrompt;
          const verdict = personas.verdictPrompt;
          const maxRounds = Number.isFinite(cfg.maxVerdictRounds) && cfg.maxVerdictRounds >= 1
            ? cfg.maxVerdictRounds
            : 3;
          // 结论输出要求：终评收尾（认可 / 用户拒绝再来一轮）时要求整理完整结论
          // （'' = 不注入）。
          const conclusion = typeof cfg.conclusionPrompt === 'string' ? cfg.conclusionPrompt : DEFAULT_CONCLUSION_PROMPT;
          // 历史会话检索指引：全场景共用一份（'' = 不注入）。只会出现在主代理的
          // 提示里——本段落对子代理会话早已返回空（见上面的 origin/depth 门控）。
          const sessionGuide = typeof cfg.sessionHistoryGuide === 'string'
            ? cfg.sessionHistoryGuide
            : DEFAULT_SESSION_HISTORY_GUIDE;
          // ── knowledge 场景：Theseus workflow 对抗流程的注入体与阶段指示 ──
          if (scene === 'knowledge') {
            const knowledgeInstruction = typeof cfg.knowledgeInstruction === 'string' && cfg.knowledgeInstruction !== ''
              ? cfg.knowledgeInstruction
              : DEFAULT_KNOWLEDGE_INSTRUCTION;
            const explorerId = subagents.get(explorerKey(sessionId, scene));
            const kNext = state.kNext;
            const kNextName = kNext === 'propose' ? 'propose' : kNext === 'review' ? 'review（挑战者审查）' : 'apply';
            const gateText = kNext === 'close'
              ? '[arena-v2 竞技阶段]\n当前阶段：收尾——探索者已返回 user-readiness 未 CLEARED。**先原样呈现探索者结算消息原文（不要摘要/改写）**，再用 read 工具读 openspec/changes/<workflow>/user-readiness.review.md，把 Requirement Alignment 表（每道题规则、用户答案、✅/❌ 正确与否）**原文逐行转述**；然后按实际结果 record user-readiness-review.completed（NOT_CLEARED / NEEDS_REVISION），向用户总结评估结论与后续建议，然后结束回合（本轮竞技随之结束）。'
              : kNext === 'propose'
                ? '[arena-v2 竞技阶段]\n当前阶段：阶段确认——探索者已返回 STAGE_DONE explore。\n1. **把探索者结算消息原文原样呈现给用户（不要摘要、不要改写、不要省略协议行）**；\n2. 调用 ask_user_question 询问是否进入下一阶段：问题 id 固定填 `' + ARENA_K_ADVANCE_QUESTION_ID + '`，选项为「' + ARENA_K_ADVANCE_YES + '（' + kNextName + '）」与「' + ARENA_K_ADVANCE_NO + '」；\n3. 用户选「' + ARENA_K_ADVANCE_YES + '」→ judge --current 验证产物后 record explore.completed CONFIRMED，简报一句，结束回合（系统会派发下一阶段）；用户选「' + ARENA_K_ADVANCE_NO + '」→ 直接结束回合（系统关闭竞技场）。若 judge 未通过（存在 FAIL 项）→ 先向用户说明失败项，再用问题 id 固定填 `' + ARENA_K_REVISION_QUESTION_ID + '`（选项「' + ARENA_K_REVISION_YES + '」/「' + ARENA_K_REVISION_NO + '」）询问是否让探索者修订；用户同意 → 用 send_message 向探索者（id 见上方）发送修订轮指令（列出失败项，要求补全后按返回协议输出一行 STAGE_DONE explore CONFIRMED 或 NEED_QUESTION / BLOCKED）后结束回合，等待探索者修订结算后再重新确认；用户拒绝 → 结束回合（系统关闭竞技场）。'
                : kNext === 'review'
                  ? '[arena-v2 竞技阶段]\n当前阶段：阶段确认——探索者已返回 STAGE_DONE propose。\n1. **把探索者结算消息原文原样呈现给用户（不要摘要、不要改写、不要省略协议行）**；\n2. 调用 ask_user_question 询问是否进入下一阶段：问题 id 固定填 `' + ARENA_K_ADVANCE_QUESTION_ID + '`，选项为「' + ARENA_K_ADVANCE_YES + '（' + kNextName + '）」与「' + ARENA_K_ADVANCE_NO + '」；\n3. 用户选「' + ARENA_K_ADVANCE_YES + '」→ judge --current 验证产物后 record propose.completed ARTIFACTS_CREATED，简报一句，结束回合（系统会派发挑战者审查）；用户选「' + ARENA_K_ADVANCE_NO + '」→ 直接结束回合（系统关闭竞技场）。若 judge 未通过（存在 FAIL 项，如 design.md 缺失、specs 未登记）→ 先向用户说明失败项，再用问题 id 固定填 `' + ARENA_K_REVISION_QUESTION_ID + '`（选项「' + ARENA_K_REVISION_YES + '」/「' + ARENA_K_REVISION_NO + '」）询问是否让探索者修订；用户同意 → 用 send_message 向探索者（id 见上方）发送修订轮指令（列出失败项，要求补全后按返回协议输出一行 STAGE_DONE propose ARTIFACTS_CREATED 或 NEED_QUESTION / BLOCKED）后结束回合，等待探索者修订结算后再重新确认；用户拒绝 → 结束回合（系统关闭竞技场）。'
                  : kNext === 'apply'
                    ? '[arena-v2 竞技阶段]\n当前阶段：阶段确认——探索者已返回 STAGE_DONE user-readiness CLEARED。\n1. **把探索者结算消息原文原样呈现给用户（不要摘要、不要改写、不要省略协议行）**；再用 read 工具读 openspec/changes/<workflow>/user-readiness.review.md，把 Requirement Alignment 表（每道题规则、用户答案、✅/❌ 正确与否）**原文逐行转述**；\n2. 调用 ask_user_question 询问是否进入 apply：问题 id 固定填 `' + ARENA_K_ADVANCE_QUESTION_ID + '`，选项为「' + ARENA_K_ADVANCE_YES + '（' + kNextName + '）」与「' + ARENA_K_ADVANCE_NO + '」；\n3. 用户选「' + ARENA_K_ADVANCE_YES + '」→ judge --current 验证产物后 record user-readiness-review.completed CLEARED，结束回合（系统进入 apply 回合）；用户选「' + ARENA_K_ADVANCE_NO + '」→ 直接结束回合（系统关闭竞技场）。若 judge 未通过（存在 FAIL 项）→ 先向用户说明失败项，再用问题 id 固定填 `' + ARENA_K_REVISION_QUESTION_ID + '`（选项「' + ARENA_K_REVISION_YES + '」/「' + ARENA_K_REVISION_NO + '」）询问是否让探索者修订；用户同意 → 用 send_message 向探索者（id 见上方）发送修订轮指令（列出失败项，要求补全后按返回协议输出一行 STAGE_DONE user-readiness CLEARED / NOT_CLEARED / NEEDS_REVISION 或 NEED_QUESTION / BLOCKED）后结束回合，等待探索者修订结算后再重新确认；用户拒绝 → 结束回合（系统关闭竞技场）。'
                    : '';
            const phaseText = state.phase === ARENA_PHASE_K_INIT
              ? '[arena-v2 竞技阶段]\n当前阶段：绑定/续跑——judge --current 确认 Theseus workflow 绑定（未绑定则用 bash 执行 mode on --bind <id> 或 --init <主题>）。**已绑定且 Theseus 阶段已推进（propose/review/user-readiness-review/apply）时，宿主会按 openspec/states 状态文件自动跳到对应阶段续跑，跳过已完成阶段**——你只需向用户简报当前阶段，然后结束回合。'
              : state.phase === ARENA_PHASE_K_GATE
                ? gateText
                : state.phase === ARENA_PHASE_K_ASK
                  ? '[arena-v2 竞技阶段]\n当前阶段：中继提问——① 把结算消息正文里 NEED_QUESTION JSON 之外的**全部内容（含对账/规则揭示/答案正确与否）原文原样呈现给用户，不摘要、不改写**；需要原文引用时可用 read 工具读 openspec 工件（如 user-readiness.review.md / review.md）后再转述；② 再用结算消息里的问题 JSON **原样**调用 ask_user_question 提问（只取 question/options 展示字段照抄；若 JSON 里出现 correctIndex / 正确项位置 / why 等答案线索字段，**一律忽略、不得向用户展示**；绝不提前揭示规则或答案），拿到回答后结束回合（系统会把回答回传给探索者）。'
                  : state.phase === ARENA_PHASE_K_EXPLORE
                    ? '[arena-v2 竞技阶段]\n当前阶段：探索中——探索者正在执行 theseus-explore，无需操作 即使收到子代理的进度报告、或 Theseus 门控显示 ready，也不要提前行动——阶段完成由系统在结算后切换指示。'
                    : state.phase === ARENA_PHASE_K_PROPOSE
                      ? '[arena-v2 竞技阶段]\n当前阶段：提案中——探索者正在执行 theseus-propose，无需操作 即使收到子代理的进度报告、或 Theseus 门控显示 ready，也不要提前行动——阶段完成由系统在结算后切换指示。'
                      : state.phase === ARENA_PHASE_K_REVIEW
                        ? '[arena-v2 竞技阶段]\n当前阶段：审查中——挑战者正在执行 theseus-review-spec，无需操作 即使收到子代理的进度报告、或 Theseus 门控显示 ready，也不要提前行动——阶段完成由系统在结算后切换指示。'
                        : state.phase === ARENA_PHASE_K_READINESS
                          ? '[arena-v2 竞技阶段]\n当前阶段：就绪评审中——探索者正在执行 theseus-user-readiness-review，无需操作 即使收到子代理的进度报告、或 Theseus 门控显示 ready，也不要提前行动——阶段完成由系统在结算后切换指示。'
                          : state.phase === ARENA_PHASE_K_VERDICT
                            ? (state.reviewOutcome === 'ready'
                              ? '[arena-v2 竞技阶段]\n当前阶段：终评（READY）——**把挑战者结算消息与 review.md 的 Overall Verdict / Action Items 原文原样呈现给用户（不要摘要/改写）**，然后**必须调用 ask_user_question 一次问两道**：① 是否生成领导层报告——问题 id 固定填 `' + ARENA_K_REPORT_QUESTION_ID + '`，选项固定为「' + ARENA_K_REPORT_YES + '」与「' + ARENA_K_REPORT_NO + '」；② 是否进入 user-readiness——问题 id 固定填 `' + ARENA_K_ADVANCE_QUESTION_ID + '`，选项固定为「' + ARENA_K_ADVANCE_YES + '（user-readiness）」与「' + ARENA_K_ADVANCE_NO + '」。拿到回答后**只结束回合，不要执行任何阶段 skill**——user-readiness 与 requirement-report 均由宿主派发给探索者执行（探索者会 fork reporter 在后台生成 PPT）；**你不得亲自加载/执行 theseus-user-readiness-review、requirement-report skill，不得自己提问预测题**（两道都选「进入/生成」→ 系统派发探索者执行 user-readiness；② 选「' + ARENA_K_ADVANCE_NO + '」→ 系统关闭竞技场）。'
                              : state.reviewOutcome === 'needs_revision'
                                ? '[arena-v2 竞技阶段]\n当前阶段：终评（NEEDS_REVISION）——**把 review.md 的 Overall Verdict 与 Action Items 原文原样呈现给用户（不要摘要/改写）**，然后**必须调用 ask_user_question** 询问是否再来一轮修订：问题 id 固定填 `' + ARENA_K_REVISION_QUESTION_ID + '`，选项固定为「' + ARENA_K_REVISION_YES + '」与「' + ARENA_K_REVISION_NO + '」。用户选「' + ARENA_K_REVISION_YES + '」→ 本回合内 record review.completed NEEDS_REVISION（把 workflow 推回 propose）后直接结束回合（系统自动重新派发探索者修订）；用户选「' + ARENA_K_REVISION_NO + '」→ 本回合内总结并 record review.completed NEEDS_REVISION，然后结束回合（系统关闭竞技场）。'
                                : '[arena-v2 竞技阶段]\n当前阶段：终评（NOT_READY）——**把 review.md 原文原样呈现给用户**：逐条列出五维 FAIL 项、Action Items 与未完成/无证据的 Anchor Trace 行（不要摘要/改写），然后**必须调用 ask_user_question** 询问是否再来一轮修订：问题 id 固定填 `' + ARENA_K_REVISION_QUESTION_ID + '`，选项固定为「' + ARENA_K_REVISION_YES + '」与「' + ARENA_K_REVISION_NO + '」。用户选「' + ARENA_K_REVISION_YES + '」→ 本回合内 record review.completed NEEDS_REVISION（把 workflow 推回 propose）后直接结束回合（系统自动重新派发探索者修订）；用户选「' + ARENA_K_REVISION_NO + '」→ 本回合内总结并 record review.completed NOT_READY（workflow 停在 review），然后结束回合（系统关闭竞技场）。')
                            : state.phase === ARENA_PHASE_K_APPLY
                              ? '[arena-v2 竞技阶段]\n当前阶段：apply——按 theseus-apply-change skill 执行：读 tasks.md，在对应 worktree 实现（可建议开启 test-case lane 并 record lane.open），跑测试报告（strongCoverage ≥ 80%），record apply.completed IMPLEMENTED，向用户总结产出与后续步骤 T7 worktree-commit-push / T8 openspec-impl-doc / T9 theseus-archive-change（不自动执行），然后结束回合。'
                              : '';
            const body = knowledgeInstruction
              .replaceAll('{workflowId}', state.workflowId || '（未绑定）')
              .replaceAll('{explorePrompt}', personas.explorePrompt)
              .replaceAll('{proposePrompt}', personas.proposePrompt)
              .replaceAll('{reviewPrompt}', personas.reviewPrompt)
              .replaceAll('{readinessPrompt}', personas.readinessPrompt)
              .replaceAll('{reportPrompt}', personas.reportPrompt);
            if (body === '') return '';
            const guide = cfg.sceneSearchGuide && typeof cfg.sceneSearchGuide === 'object'
              && typeof cfg.sceneSearchGuide[scene] === 'string'
              ? cfg.sceneSearchGuide[scene]
              : '';
            const parts = [
              `[arena-v2 竞技场]\n当前场景：${SCENE_NAMES[scene] ?? scene}\nTheseus workflow：${state.workflowId || '（未绑定）'}\n探索者子代理 id：${explorerId || '（无，需要时创建）'}\n挑战者子代理 id：${challengerId || '（无，需要时创建）'}`,
              body,
              guide,
              sessionGuide,
              phaseText
            ].filter((p) => p !== '');
            ctx.logger?.info?.('arena-v2: section injected agent=' + sessionId + ' scene=' + scene
              + ' workflow=' + (state.workflowId || 'none') + ' explorer=' + (explorerId || 'none') + ' challenger=' + (challengerId || 'none'));
            return parts.join('\n\n');
          }
          // ── business / qa：质疑轮 → 修正 → 终评轮 ──
          // 竞技阶段：从侧文件读取（宿主驱动状态机维护），按当前阶段给主代理
          // 明确的回合指示——它只负责当前阶段的动作，节奏由宿主推进。
          const presentText = state.verdictOutcome === 'disputed'
            ? [
                '[arena-v2 竞技阶段]',
                '当前阶段：终评（仍存疑）——已收到挑战者的终评结论。',
                '1. 先把终评结论原样呈现给用户；',
                '2. **必须调用 ask_user_question 工具**询问用户是否再来一轮「修正 → 终评」：问题 id 固定填 `' + ARENA_ANOTHER_ROUND_QUESTION_ID + '`，两个选项文案固定为「' + ARENA_ANOTHER_ROUND_YES + '」与「' + ARENA_ANOTHER_ROUND_NO + '」（系统按此识别你的用户选择）；',
                '3. 用户选「' + ARENA_ANOTHER_ROUND_YES + '」→ 在**本回合内**针对仍存疑条目完成修正，然后结束回合（系统会自动再送一次终评轮）；',
                '4. 用户选「' + ARENA_ANOTHER_ROUND_NO + '」→ 按下面【结论输出要求】整理并输出本轮完整结论，然后结束回合（本轮竞技随之结束）。',
                '未按上述询问就结束回合的，系统一律按「结束」处理并关闭竞技场。'
              ].join('\n')
            : [
                '[arena-v2 竞技阶段]',
                '当前阶段：终评（认可）——已收到挑战者的终评结论。先把终评结论原样呈现给用户，再按下面【结论输出要求】整理并输出本轮完整结论，然后结束回合（本轮竞技随之结束）。'
              ].join('\n');
          const phaseText = state.phase === ARENA_PHASE_ANSWER
            ? '[arena-v2 竞技阶段]\n当前阶段：作答——以 Technical Expert 身份回答用户问题（歧义先澄清）。回答完成后结束回合。'
            : state.phase === ARENA_PHASE_CHALLENGE
              ? '[arena-v2 竞技阶段]\n当前阶段：质疑轮进行中——挑战者正在审查你的回答，无需操作。'
              : state.phase === ARENA_PHASE_REVISE
                ? '[arena-v2 竞技阶段]\n当前阶段：修正——已收到挑战者的逐条质疑。原样呈现质疑，逐条回应并修正你的回答（不认可的条目可用 ask_user_question 提出）；修正完成后结束回合，系统会自动送终评。'
                : state.phase === ARENA_PHASE_VERDICT
                  ? '[arena-v2 竞技阶段]\n当前阶段：终评轮进行中——挑战者正在评审你的修正稿，无需操作。'
                  : state.phase === ARENA_PHASE_PRESENT
                    ? (conclusion === '' ? presentText : presentText + '\n\n' + conclusion)
                    : '';
          const body = instruction
            .replaceAll('{challengerLabel}', challengerLabelFor(scene))
            .replaceAll('{challengerPrompt}', prompt)
            .replaceAll('{challengePrompt}', challenge)
            .replaceAll('{verdictPrompt}', verdict)
            .replaceAll('{maxVerdictRounds}', String(maxRounds));
          if (body === '') return '';
          // 场景检索指引：按当前场景注入「回答前主动检索的知识源」策略（空 = 不注入）。
          const guide = cfg.sceneSearchGuide && typeof cfg.sceneSearchGuide === 'object'
            && typeof cfg.sceneSearchGuide[scene] === 'string'
            ? cfg.sceneSearchGuide[scene]
            : '';
          const parts = [
            `[arena-v2 竞技场]\n当前场景：${SCENE_NAMES[scene] ?? scene}\n当前挑战者子代理 id：${challengerId || '（无，需要时创建）'}`,
            body,
            guide,
            sessionGuide,
            phaseText
          ].filter((p) => p !== '');
          ctx.logger?.info?.('arena-v2: section injected agent=' + sessionId + ' scene=' + scene + ' challenger=' + (challengerId || 'none'));
          return parts.join('\n\n');
        } catch {
          return '';
        }
      }
    });

    return () => {
      try {
        disposeSection?.();
      } catch {}
      try {
        offCreated?.();
      } catch {}
      try {
        offStart?.();
      } catch {}
      try {
        offDisposed?.();
      } catch {}
      try {
        offSessionEvent?.();
      } catch {}
      try {
        offCommand?.();
      } catch {}
      try {
        offRoute?.();
      } catch {}
      try {
        offPersonasRoute?.();
      } catch {}
      try {
        dispatchAbort.abort();
      } catch {}
      try {
        intentBySession.clear();
      } catch {}
      try {
        scope?.dispose?.();
      } catch {}
    };
  });
}

export {
  ARENA_ANOTHER_ROUND_NO,
  ARENA_ANOTHER_ROUND_QUESTION_ID,
  ARENA_ANOTHER_ROUND_YES,
  ARENA_GOAL_BLOCK_TEXT,
  ARENA_K_ADVANCE_NO,
  ARENA_K_ADVANCE_QUESTION_ID,
  ARENA_K_ADVANCE_YES,
  ARENA_K_REPORT_NO,
  ARENA_K_REPORT_QUESTION_ID,
  ARENA_K_REPORT_YES,
  ARENA_K_REVISION_NO,
  ARENA_K_REVISION_QUESTION_ID,
  ARENA_K_REVISION_YES,
  CHALLENGER_LABEL,
  Config,
  DEFAULT_CHALLENGER_MODEL,
  DEFAULT_CHALLENGER_PROMPT,
  DEFAULT_CHALLENGE_PROMPT,
  DEFAULT_CONCLUSION_PROMPT,
  DEFAULT_INSTRUCTION,
  DEFAULT_KNOWLEDGE_INSTRUCTION,
  DEFAULT_MAIN_PERSONA,
  DEFAULT_SCENE_SEARCH_GUIDE,
  DEFAULT_SEARCH_GUIDE,
  DEFAULT_SESSION_HISTORY_GUIDE,
  DEFAULT_VERDICT_PROMPT,
  EXPLORER_LABEL,
  KNOWLEDGE_SEARCH_GUIDE,
  SCENES,
  SCENE_NAMES,
  apply,
  challengerLabelFor,
  challengerModelOf,
  childWorkOf,
  collectAnswer,
  collectAnotherRoundChoice,
  collectAskAnswerText,
  collectFiles,
  collectToolRecords,
  collectUserQuestion,
  composeRoundText,
  explorerLabelFor,
  foldArenaMode,
  hasArenaChildDelegation,
  inject,
  isChallengerLabel,
  isExplorerLabel,
  kickResumeText,
  knowledgeChildStageOf,
  knowledgeStageResumeOf,
  name,
  normalizeScene,
  parseArenaCommand,
  parseAdvanceChoice,
  parseAnotherRoundAnswer,
  parseIntentOutput,
  parseKnowledgeChoice,
  parseReviewFileVerdict,
  parseStageResult,
  parseVerdictOutcome,
  pickedAnswerText,
  planKnowledgeAdvance,
  planKnowledgeGate,
  sanitizeSessionRefs,
  sceneFromAnyLabel,
  sceneFromLabel,
  scenePersonasOf,
  scenesAllowedIn,
  sessionEventsOf,
  subagentProviderOf
};
export default { Config, apply, inject, name };
