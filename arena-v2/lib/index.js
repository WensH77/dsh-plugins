// dsh-plugin-arena-v2 — node half
//
// 目标：类 plan 的 chip 入口（/arena 命令）开启竞技场后，主代理收到用户内容自动
// 创建「可接续子代理」（竞技场挑战者），把内容转交给它应答。多轮对话复用同一个
// 挑战者：首轮用 subagent 创建（拿到 durable 的 subagentId），后续轮次用
// send_message 给同一个 id 续聊，挑战者的上下文跨轮次累积。
//
// 挑战者模型：**固定** deepseek-v4-pro · 推理深度 max，与父代理完全解耦——
// 父代理用什么模型都不影响挑战者。实现不是靠继承父代理路由，而是在挑战者子代理
// 的创建窗口（registerContinuableSetup，新建与冷恢复都会走）里安装一个固定的模型
// 选择（installModelSelection），在 agent/request 瀑布里把每次请求的
// provider/model/reasoningEffort 覆盖为固定值。这与 api-proxy 给 Web 会话固定
// 模型用的是同一机制，只是作用域只落在挑战者自己身上。
//
// 实现分四部分：
// 1) 竞技场模式：/arena 命令把模式状态写入 ~/.dsh/arena-v2 侧文件（按会话 id，
//    重启后恢复）；chip 挂载时经 /arena-v2/state 路由从侧文件恢复开关态；
//    **与预设无关，只看 chip 是否开启**。
// 2) 固定模型选择：registerContinuableSetup 的 contribution 按 label
//    （CHALLENGER_LABEL，subagent 工具的 description）识别挑战者子代理，命中才
//    安装 installModelSelection；同父会话的其它子代理、其它会话的子代理不受影响。
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
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'arena-v2';
const inject = ['settings', 'systemPrompt'];

/** 挑战者子代理的 durable label（subagent 工具的 description 参数）。 */
const CHALLENGER_LABEL = 'arena-challenger';

/** 场景中文名（宿主侧提示用）。 */
const SCENE_NAMES = { business: '业务探索', knowledge: '知识沉淀', qa: '测试用例' };

/**
 * 默认多源检索指引：注入主代理「回答前主动检索的知识源」策略——所有场景默认
 * 共用同一份（Jira / git / openspec / 代码库），不按场景绑定；可按场景在
 * sceneSearchGuide 里覆盖或置空（空字符串 = 该场景不注入）。
 */
const DEFAULT_SEARCH_GUIDE = [
  '[arena-v2 多源检索]',
  '回答前主动检索以下知识源（不要只查代码库），并按需交叉验证：',
  '1. Jira：优先用 mcp__jira__* 工具（如 getTeamworkGraphContext / getTeamworkGraphObject）查相关 issue / 需求 / 缺陷；拿到的条目作为来源列出。',
  '2. git：用 bash 查提交历史与分支（git log --oneline -20、git branch -a、git show <commit>、git log --all --grep=<关键词>），定位相关提交 / 分支 / PR。',
  '3. openspec：读工作区 openspec/ 目录（specs/ 规格、states/ 状态、decisions/ 决策、.runtime/sessions/ 会话状态），把相关规格作为回答依据。',
  '4. 代码库：grep / read 照常，与以上来源交叉验证。',
  '回答中注明每个结论的来源（Jira 条目 / commit / openspec 规格 / 代码路径）；无法从任何来源证实的判断标明「推断」。'
].join('\n');

/** 默认场景检索指引：目前只注入业务探索（business）；knowledge / qa 默认不注入（空 = 不注入），后续需要再按场景扩展。 */
const DEFAULT_SCENE_SEARCH_GUIDE = {
  business: DEFAULT_SEARCH_GUIDE,
  knowledge: '',
  qa: ''
};

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

/** 知识沉淀场景默认 persona 集（main=Knowledge Expert，challenger=审查者）。 */
const KNOWLEDGE_PERSONAS = {
  mainPersona: [
    '[arena-v2 host]',
    '你是 Knowledge Expert（知识专家），竞技场主答者，负责产出结构化方案。',
    '【答题时】',
    '1. 先回答用户问题，输出结构化方案（现状/依据/结论/行动项）。',
    '2. 用户问题含指代性口语词或多义术语时，必须先 ask_user_question 向用户澄清指代，再回答；调查只用于列出候选与依据，不替代澄清。',
    '【面对质疑时】',
    '1. 收到审查者的逐条质疑后，逐条修正你的方案。',
    '2. 不认可的条目用 ask_user_question 提出异议。',
    '用中文回答，禁止辩论。'
  ].join('\n'),
  challengerPrompt: [
    '[arena-v2 challenger]',
    '你是方案审查者（Challenger），身份高于 Knowledge Expert。你将审查主答者的方案，逐条指出问题或漏洞，并给出审查结论（READY / NEEDS_REVISION）。禁止辩论，只按指示输出。'
  ].join('\n'),
  challengePrompt: [
    '[审查轮]',
    '用户问题：「{question}」',
    'Knowledge Expert的方案：「{answer}」',
    '提到的文件：「{files}」',
    'Knowledge Expert 的工具操作记录：',
    '「{tools}」',
    '',
    '请用中文对上述方案**逐条审查**：逐点检查方案中的每个观点、结论、依据与行动项，指出问题或漏洞；最后给出一行审查结论（READY 或 NEEDS_REVISION）。禁止辩论，只输出你的审查意见。'
  ].join('\n'),
  verdictPrompt: [
    '[终审轮]',
    'Knowledge Expert修正后的方案：「{answer}」',
    '提到的文件：「{files}」',
    'Knowledge Expert 的工具操作记录：',
    '「{tools}」',
    '',
    '修正已完成。请先**逐条核对**你上一轮提出的审查意见是否在修正后的方案中被逐一回应；然后仅给出最终审查结论（认可或仍存疑）。禁止辩论，只输出你的结论。',
    '**最后单独一行**输出结论标记（供系统判定，不要加其它文字）：`结论：认可` 或 `结论：仍存疑`。'
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
 * 配置可逐字段覆盖。返回 { mainPersona, challengerPrompt, challengePrompt, verdictPrompt }。
 */
function scenePersonasOf(cfg, scene) {
  const s = normalizeScene(scene);
  const base = {
    mainPersona: typeof cfg?.mainPersona === 'string' ? cfg.mainPersona : DEFAULT_MAIN_PERSONA,
    challengerPrompt: typeof cfg?.challengerPrompt === 'string' ? cfg.challengerPrompt : DEFAULT_CHALLENGER_PROMPT,
    challengePrompt: typeof cfg?.challengePrompt === 'string' ? cfg.challengePrompt : DEFAULT_CHALLENGE_PROMPT,
    verdictPrompt: typeof cfg?.verdictPrompt === 'string' ? cfg.verdictPrompt : DEFAULT_VERDICT_PROMPT
  };
  const sceneDefault = DEFAULT_SCENE_PERSONAS[s];
  const sceneBase = sceneDefault !== null && sceneDefault !== void 0
    ? {
        mainPersona: sceneDefault.mainPersona,
        challengerPrompt: sceneDefault.challengerPrompt,
        challengePrompt: sceneDefault.challengePrompt,
        verdictPrompt: sceneDefault.verdictPrompt
      }
    : base;
  const over = cfg?.scenePersonas?.[s];
  if (over !== null && typeof over === 'object') {
    return {
      mainPersona: typeof over.mainPersona === 'string' && over.mainPersona !== '' ? over.mainPersona : sceneBase.mainPersona,
      challengerPrompt: typeof over.challengerPrompt === 'string' && over.challengerPrompt !== '' ? over.challengerPrompt : sceneBase.challengerPrompt,
      challengePrompt: typeof over.challengePrompt === 'string' && over.challengePrompt !== '' ? over.challengePrompt : sceneBase.challengePrompt,
      verdictPrompt: typeof over.verdictPrompt === 'string' && over.verdictPrompt !== '' ? over.verdictPrompt : sceneBase.verdictPrompt
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
  /** 各场景 persona 覆盖：{ business|knowledge|qa: { mainPersona?, challengerPrompt?, challengePrompt?, verdictPrompt? } }，缺省回落场景默认/顶层（business）值。 */
  scenePersonas: z.dict(z.object({
    mainPersona: z.string(),
    challengerPrompt: z.string(),
    challengePrompt: z.string(),
    verdictPrompt: z.string()
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
  /** 注入到会话 system prompt 的自动竞技指令。 */
  instruction: z.string().default(DEFAULT_INSTRUCTION)
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
 * 机器提取用户对「是否再来一轮修正-终评」的选择：只看**最后一次挑战者结算之后**
 * （即终评呈现回合内）主代理调用 `ask_user_question` 的工具结果，读 answers[].selected。
 * 与「四字段机器提取」同一思路——用户决策由宿主从会话事件读取，不靠主代理自述。
 * @param events - 会话事件数组。
 * @returns 'continue'（再来一轮）| 'stop'（结束并输出结论）| null（没问 / 无法判定）。
 */
function collectAnotherRoundChoice(events) {
  if (!Array.isArray(events)) return null;
  let start = 0;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e?.type === 'user/message' && e.data?.source?.kind === 'subagent-settled') start = i;
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
const ARENA_PHASES = new Set([
  ARENA_PHASE_AWAITING,
  ARENA_PHASE_ANSWER,
  ARENA_PHASE_CHALLENGE,
  ARENA_PHASE_REVISE,
  ARENA_PHASE_VERDICT,
  ARENA_PHASE_PRESENT
]);

/** 终评结论取值（present 阶段据此分支：认可 → 整理结论；仍存疑 → 问用户是否再来一轮）。 */
const ARENA_VERDICT_OUTCOMES = new Set(['approved', 'disputed']);

/** 竞技场场景键（空白页 hero 开关右侧的分段控件：业务探索/知识沉淀/测试用例）。 */
const SCENES = ['business', 'knowledge', 'qa'];

/** 归一化场景键：未知值回落 business（当前仅存状态，行为接入见 README「场景」）。 */
function normalizeScene(value) {
  return SCENES.includes(value) ? value : 'business';
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
      pendingDispatch: pending === ARENA_PHASE_CHALLENGE || pending === ARENA_PHASE_VERDICT ? pending : null,
      verdictOutcome: ARENA_VERDICT_OUTCOMES.has(parsed?.verdictOutcome) ? parsed.verdictOutcome : null
    };
  } catch {
    return { active: false, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, scene: 'business', pendingDispatch: null, verdictOutcome: null };
  }
}

/** 写入会话的竞技状态（侧文件，同会话内下一条消息生效；未指定 scene/verdictOutcome 时保留既有值）。 */
function writeArenaState(sessionId, state) {
  const prev = readArenaState(sessionId);
  const pending = state.pendingDispatch === ARENA_PHASE_CHALLENGE || state.pendingDispatch === ARENA_PHASE_VERDICT
    ? state.pendingDispatch
    : null;
  // undefined = 保留既有值；显式 null = 清空（新一轮/收尾时复位）。
  const outcome = state.verdictOutcome === void 0 ? prev.verdictOutcome : state.verdictOutcome;
  mkdirSync(ARENA_STATE_DIR, { recursive: true });
  writeFileSync(arenaStatePath(sessionId), JSON.stringify({
    active: state.active === true,
    phase: ARENA_PHASES.has(state.phase) ? state.phase : ARENA_PHASE_AWAITING,
    verdictRounds: Number.isFinite(state.verdictRounds) && state.verdictRounds >= 0 ? state.verdictRounds : 0,
    scene: normalizeScene(state.scene ?? prev.scene),
    pendingDispatch: pending,
    verdictOutcome: ARENA_VERDICT_OUTCOMES.has(outcome) ? outcome : null
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
          scenePersonas: {},
          subagentProvider: 'spawn',
          intent: DEFAULT_INTENT_CONFIG,
          instruction: DEFAULT_INSTRUCTION
        }
      });
    } catch (error) {
      ctx.logger?.warn?.('arena-v2: settings register failed: ' + String(error?.message ?? error));
    }

    // ── 挑战者固定模型 + persona：安装到挑战者子代理自身的创建窗口 ────────
    // registerContinuableSetup 对每个可接续子代理的新建与冷恢复都会执行；
    // 这里按 label 识别挑战者：
    // - 固定模型选择（installModelSelection）在 agent/request 瀑布里覆盖
    //   provider/model/reasoningEffort；
    // - 挑战者 persona（challengerPrompt）在挑战者创建时直接注入（竞技场开启后
    //   才创建挑战者，所以首条消息就带 persona）。
    // 同父会话的其它子代理、其它会话的子代理均不受影响，父代理也完全自由。
    let offSetup;
    const mountSetup = () => {
      if (offSetup !== void 0) return;
      const subagents = settingsCtx.get('subagents');
      if (!subagents || typeof subagents.registerContinuableSetup !== 'function') return;
      offSetup = subagents.registerContinuableSetup((childCtx) => {
        try {
          const cfg = scope?.get?.() ?? {};
          if (!cfg.enabled) return () => {};
          const events = childCtx?.agent?.session?.events;
          if (!events) return () => {};
          // 挑战者子代理的 descriptor 在创建种子（seedDescriptorTurn）里，
          // 冷恢复时也在会话日志里——按场景 label 精确识别（含旧版无后缀兼容）。
          const descriptor = foldSubagentDescriptor(events);
          if (!descriptor || descriptor.mode !== 'continuable' || !isChallengerLabel(descriptor.label)) {
            return () => {};
          }
          const challengerScene = sceneFromLabel(descriptor.label) ?? 'business';
          const model = challengerModelOf(cfg);
          const fixed = {
            provider: model.provider,
            model: model.model,
            ...model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}
          };
          ctx.logger?.info?.('arena-v2: challenger fixed model -> ' + JSON.stringify(fixed));
          const disposers = [];
          // 挑战者 persona：按挑战者所属场景取（场景默认 > 顶层 business 默认 > 配置覆盖）。
          // 创建时注入。阴影覆盖预设 persona（deployment:persona 是命名槽，子代理作用域
          // 注册的段落最近、优先）。
          const persona = scenePersonasOf(cfg, challengerScene).challengerPrompt;
          if (persona !== '') {
            const d = childCtx.systemPrompt?.section?.({
              name: PERSONA_SECTION,
              order: PERSONA_ORDER,
              text: persona
            });
            if (typeof d === 'function') disposers.push(d);
            ctx.logger?.info?.('arena-v2: challenger persona injected');
          }
          // selection 对象只需 current（快照源）与 assembled（快照槽）；
          // installModelSelection 会在每次 system-prompt/assemble 与
          // agent/request 时读取并覆盖请求配置。
          disposers.push(installModelSelection(childCtx, {
            current: fixed,
            assembled: void 0
          }));
          return () => {
            for (const d of disposers) {
              try {
                d();
              } catch {}
            }
          };
        } catch (error) {
          ctx.logger?.warn?.('arena-v2: challenger setup failed: ' + String(error?.message ?? error));
          return () => {};
        }
      });
    };
    mountSetup();
    // 服务尚未就绪时，等第一个 subagent provider 出现再补装（保险）。
    const offProviderAdded = settingsCtx.on('subagent/provider-added', () => {
      try {
        mountSetup();
      } catch {}
    });

    // ── 挑战者 id 追踪 ────────────────────────────────────────────────────
    // challengers: `${父会话 id}::${scene}` -> 该场景挑战者子代理 id（durable，
    //   跨轮次/重启有效；一个会话可因命令切场景而有多个场景的挑战者）。
    // resolving:   `${父会话 id}::${scene}` -> 最近一次 listChildren 尝试时间（节流）。
    // mainPersonas: 会话 id -> 主代理 persona 段落的 disposer。
    const challengers = new Map();
    const resolving = new Map();
    const mainPersonas = new Map();
    const RESOLVE_THROTTLE_MS = 10_000;
    const challengerKey = (sessionId, scene) => sessionId + '::' + normalizeScene(scene);

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
     * 按 (父会话, 场景) 找回挑战者子代理并缓存。listChildren 是只读枚举，不加载
     * Agent；label 是子代理 descriptor 里的 durable 字段（= subagent 工具的
     * description），因此只命中该场景的挑战者，不会被同父会话的其它子代理污染。
     */
    const resolveChallenger = async (parentSessionId, scene, { force = false } = {}) => {
      try {
        if (!parentSessionId) return;
        const s = normalizeScene(scene);
        const key = challengerKey(parentSessionId, s);
        const subagents = settingsCtx.get('subagents');
        if (!subagents || typeof subagents.listChildren !== 'function') return;
        const now = Date.now();
        const last = resolving.get(key);
        if (!force && last !== void 0 && now - last < RESOLVE_THROTTLE_MS) return;
        resolving.set(key, now);
        const entries = await subagents.listChildren(parentSessionId);
        const label = challengerLabelFor(s);
        const found = (entries ?? []).find((entry) => (
          entry?.kind === 'child'
          && entry?.mode === 'continuable'
          && (entry?.label === label || (s === 'business' && entry?.label === CHALLENGER_LABEL))
        ));
        if (found?.id) challengers.set(key, String(found.id));
      } catch (error) {
        ctx.logger?.warn?.('arena-v2: resolve challenger failed: ' + String(error?.message ?? error));
      }
    };

    /** 该会话是否已有任意场景的挑战者（枚举子代理，按 label 判断；用于命令/路由的场景锁定）。 */
    const findChallengerEntry = async (sessionId) => {
      try {
        const subagents = settingsCtx.get('subagents');
        if (!subagents || typeof subagents.listChildren !== 'function') return null;
        const entries = await subagents.listChildren(sessionId);
        return (entries ?? []).find((entry) => (
          entry?.kind === 'child' && entry?.mode === 'continuable' && isChallengerLabel(entry?.label)
        )) ?? null;
      } catch {
        return null;
      }
    };

    /** 同步快路径：challengers 内存缓存已知该会话有挑战者（listChildren 懒解析的命中）。 */
    const hasKnownChallenger = (sessionId) => {
      const prefix = sessionId + '::';
      for (const k of challengers.keys()) {
        if (k.startsWith(prefix)) return true;
      }
      return false;
    };

    // 挑战者存在性结果缓存（正负缓存，TTL 10s）——场景锁定检查在用户可见路径上
    // （命令 /arena <scene>、路由 ?scene=），避免每次点击都打一次 listChildren。
    // statePayload（每次状态拉取）顺带预热本缓存：挂载/轮询先查一次，随后的场景
    // 点击基本命中缓存，无需再等 listChildren。
    const challengerCheckCache = new Map();
    const CHALLENGER_CHECK_TTL_MS = 10_000;
    /** 缓存化的挑战者 entry 查询（无挑战者 = null）。 */
    const cachedChallengerEntry = async (sessionId) => {
      try {
        const cached = challengerCheckCache.get(sessionId);
        if (cached !== void 0 && Date.now() - cached.at < CHALLENGER_CHECK_TTL_MS) return cached.entry;
        const entry = await findChallengerEntry(sessionId);
        challengerCheckCache.set(sessionId, { entry, at: Date.now() });
        return entry;
      } catch {
        return null;
      }
    };
    /** 场景锁定快速判断：内存 Map 已知有挑战者 → true；否则走缓存化查询。 */
    const hasChallengerCached = async (sessionId) => {
      try {
        if (hasKnownChallenger(sessionId)) return true; // 已解析过的会话，同步快路径
        const entry = await cachedChallengerEntry(sessionId);
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
        if (!agent?.session?.events) throw new Error('arena_compose requires a calling agent session');
        const cfg = scope?.get?.() ?? {};
        const round = args?.round === 'verdict' ? 'verdict' : 'challenge';
        const scene = (() => {
          try { return readArenaState(String(agent.id)).scene; } catch { return 'business'; }
        })();
        return { text: composeRoundText(cfg, round, agent.session.events, scene) };
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
        // 竞技场模式下禁用 goal 工具：防止主代理经 goal 绕过竞技场门控（如无人
        // 管控地创建/推进 goal）。restrict 过滤 scope 继承到的工具（含预设层的
        // goal）；会话无 goal（如 minimal）时 restrict 因 unknown name 抛错，跳过。
        try {
          const rd = tools?.restrict?.({ deny: ['goal'] });
          if (typeof rd === 'function') disposers.push(rd);
        } catch (error) {
          ctx.logger?.warn?.('arena-v2: restrict goal failed: ' + String(error?.message ?? error));
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
          // 开启：重置竞技阶段为「等用户问题」。
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, scene, verdictOutcome: null });
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

    /** 结束本轮完整对抗：关闭竞技场（active=false + phase 重置）+ 卸载主代理 persona + 注入执行边界提醒。 */
    const finishArenaRound = (sessionId) => {
      try {
        writeArenaState(sessionId, { active: false, phase: ARENA_PHASE_AWAITING, verdictRounds: 0, verdictOutcome: null });
        disposeMainPersona(sessionId);
        // 执行边界兜底：评审已结束，压住「认可后顺手改代码/文档」的历史惯性——
        // 修改必须等用户明确指示（评审结论不等于用户授权）。
        try {
          const agent = settingsCtx.get('agents')?.get(sessionId);
          if (agent && typeof agent.inject === 'function') {
            agent.inject(createUserMessage({
              content: [{
                type: 'text',
                text: '[arena-v2] 竞技场评审已结束并关闭。若需修改代码或文档，请等待用户明确指示后再执行；不要自动执行任何写操作。'
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
        if (st.active) installMainPersona(agent);
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
        challengerCheckCache.delete(parentId); // 挑战者出现，失效存在性缓存
        void resolveChallenger(parentId, st.scene, { force: true });
      } catch {}
    });

    // 会话销毁时清理追踪，避免 Map 无限增长。
    const offDisposed = settingsCtx.on('agent/disposed', ({ agent }) => {
      try {
        if (agent?.id) {
          const id = String(agent.id);
          const prefix = id + '::';
          for (const k of [...challengers.keys()]) {
            if (k.startsWith(prefix)) challengers.delete(k);
          }
          for (const k of [...resolving.keys()]) {
            if (k.startsWith(prefix)) resolving.delete(k);
          }
          challengerCheckCache.delete(id);
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
    // - 主代理回合结束（turn/end, phase=revise）→ 宿主组装终评轮 → followup 挑战者
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
     * ask_user_question 询问）：从 live 主代理的会话事件里提取，读不到 → null（收尾）。
     */
    const readAnotherRoundChoice = (sessionId) => {
      try {
        return collectAnotherRoundChoice(resolveMainAgent(sessionId)?.session?.events);
      } catch {
        return null;
      }
    };

    /** 向主会话注入一条可见的竞技场提示（成功/失败都能看到，不再只进终端日志）。中和 dsh-session: 防预处理器抛错。 */
    const steerArenaNote = (mainAgent, text) => {
      try {
        mainAgent?.steer?.(createUserMessage({
          content: [{ type: 'text', text: sanitizeSessionRefs(text) }],
          source: { kind: 'user' }
        }));
      } catch {}
    };

    // 宿主派发用的信号：startContinuable/followup 内部会调用 signal.throwIfAborted()，
    // 缺省 undefined 会直接抛错（Cannot read properties of undefined (reading
    // 'throwIfAborted')）；插件卸载时 abort 释放。
    const dispatchAbort = new AbortController();

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
        const events = mainAgent.session?.events;
        if (!events) {
          ctx.logger?.warn?.('arena-v2: dispatch ' + round + ' aborted — no session events for ' + sessionId);
          steerArenaNote(mainAgent, '⚠ 竞技场' + (round === 'verdict' ? '终评' : '质疑') + '轮派发失败：无法读取会话事件（已回到等待态，可重试）。');
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null, verdictOutcome: null });
          return;
        }
        const text = composeRoundText(cfg, round, events, scene);
        const content = [{ type: 'text', text }];
        const subagents = settingsCtx.get('subagents');
        if (!subagents || typeof subagents.startContinuable !== 'function' || typeof subagents.followup !== 'function') {
          const msg = '⚠ 竞技场' + (round === 'verdict' ? '终评' : '质疑') + '轮派发失败：subagents 服务不可用（已回到等待态，可重试）。';
          ctx.logger?.warn?.('arena-v2: dispatch ' + round + ' aborted — subagents service unavailable');
          steerArenaNote(mainAgent, msg);
          writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_AWAITING, pendingDispatch: null, verdictOutcome: null });
          return;
        }
        const key = challengerKey(sessionId, scene);
        const childId = challengers.get(key);
        if (childId) {
          await subagents.followup(mainAgent, childId, content, { source: { kind: 'user' }, signal: dispatchAbort.signal });
          ctx.logger?.info?.('arena-v2: dispatch ' + round + ' -> followup ' + childId);
        } else {
          const res = await subagents.startContinuable({
            provider: subagentProviderOf(cfg),
            label: challengerLabelFor(scene),
            request: { parent: mainAgent, prompt: content, maxDepth: 1 },
            signal: dispatchAbort.signal
          });
          if (res?.childId) challengers.set(key, String(res.childId));
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
        // 用户新消息：空闲时开启新一轮（作答阶段）；回合进行中不打断。
        // 并行预判意图（flash），turn/end 时据此决定是否派发挑战者。
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
          if (st.phase === ARENA_PHASE_AWAITING) {
            const userText = eventText(event);
            writeArenaState(sessionId, { active: true, phase: ARENA_PHASE_ANSWER, verdictRounds: 0, verdictOutcome: null });
            void seedIntent(sessionId, userText);
            ctx.logger?.info?.('arena-v2: user msg -> phase answer for ' + sessionId);
          } else {
            ctx.logger?.info?.('arena-v2: user msg ignored (phase=' + st.phase + ') for ' + sessionId);
          }
          return;
        }
        // 挑战者结算回传（质疑/终评到达父会话）。
        if (event.type === 'user/message' && event.data?.source?.kind === 'subagent-settled') {
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
        // 主代理回合结束：按阶段派发质疑轮/终评轮，或关闭竞技场。
        if (event.type === 'turn/end') {
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
            const choice = st.verdictOutcome === 'disputed' ? readAnotherRoundChoice(sessionId) : null;
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
        const entry = await cachedChallengerEntry(sessionId);
        if (entry !== null) {
          hasChallenger = true;
          const s = sceneFromLabel(entry.label);
          if (s !== null) challengerScene = s;
        }
      } catch {}
      return { ok: true, active: st.active, scene: st.scene, hasChallenger, challengerScene };
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
          const challengerId = challengers.get(challengerKey(sessionId, scene));
          if (!challengerId) void resolveChallenger(sessionId, scene);
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
        offSetup?.();
      } catch {}
      try {
        offProviderAdded?.();
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
  CHALLENGER_LABEL,
  Config,
  DEFAULT_CHALLENGER_MODEL,
  DEFAULT_CHALLENGER_PROMPT,
  DEFAULT_CHALLENGE_PROMPT,
  DEFAULT_CONCLUSION_PROMPT,
  DEFAULT_INSTRUCTION,
  DEFAULT_MAIN_PERSONA,
  DEFAULT_SCENE_SEARCH_GUIDE,
  DEFAULT_SEARCH_GUIDE,
  DEFAULT_VERDICT_PROMPT,
  SCENES,
  SCENE_NAMES,
  apply,
  challengerLabelFor,
  challengerModelOf,
  collectAnswer,
  collectAnotherRoundChoice,
  collectFiles,
  collectToolRecords,
  collectUserQuestion,
  composeRoundText,
  foldArenaMode,
  inject,
  isChallengerLabel,
  name,
  normalizeScene,
  parseArenaCommand,
  parseAnotherRoundAnswer,
  parseIntentOutput,
  parseVerdictOutcome,
  sanitizeSessionRefs,
  sceneFromLabel,
  scenePersonasOf,
  subagentProviderOf
};
export default { Config, apply, inject, name };
