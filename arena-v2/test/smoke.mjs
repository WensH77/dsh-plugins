// arena-v2 smoke test: verify module loads, defaults are correct, and the
// section-text gating logic behaves (arena mode / subagent / disabled).
import assert from 'node:assert/strict';
import {
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
  DEFAULT_EXPLORER_MODEL,
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
  childCreateDenyReason,
  childWorkOf,
  collectAnswer,
  collectAnotherRoundChoice,
  collectAskAnswerText,
  collectFiles,
  collectToolRecords,
  collectUserQuestion,
  composeRoundText,
  explorerLabelFor,
  explorerModelOf,
  foldArenaMode,
  hasArenaChildDelegation,
  hasReadinessReconcileText,
  lastAnsweredReconciliationOf,
  inject,
  isChallengerLabel,
  isExplorerLabel,
  kickResumeText,
  knowledgeChildStageOf,
  knowledgeStageResumeOf,
  name,
  normalizeScene,
  parseAdvanceChoice,
  parseArenaCommand,
  parseAnotherRoundAnswer,
  parseIntentOutput,
  parseKnowledgeChoice,
  parseReviewFileVerdict,
  parseStageResult,
  parseVerdictOutcome,
  planKnowledgeAdvance,
  planKnowledgeGate,
  readinessAskSkippedDocRead,
  roundEventsOf,
  readinessPreStepShouldInject,
  buildReadinessAskQuestions,
  readinessTurnHostAsk,
  sanitizeSessionRefs,
  sceneFromAnyLabel,
  sceneFromLabel,
  scenePersonasOf,
  scenesAllowedIn,
  sessionEventsOf,
  subagentProviderOf
} from '../lib/index.js';

// exports
assert.equal(name, 'arena-v2');
assert.ok(Array.isArray(inject) && inject.includes('settings') && inject.includes('systemPrompt'));
assert.equal(typeof apply, 'function');

// 场景（空白页 hero 开关右侧分段控件：业务探索/知识沉淀/测试用例）：
// 键值固定 + 归一化回落 business
assert.deepEqual(SCENES, ['business', 'knowledge', 'qa'], '三个场景键：业务探索/知识沉淀/测试用例');
assert.equal(normalizeScene('business'), 'business');
assert.equal(normalizeScene('knowledge'), 'knowledge');
assert.equal(normalizeScene('qa'), 'qa');
assert.equal(normalizeScene('whatever'), 'business', '未知场景回落 business');
assert.equal(normalizeScene(void 0), 'business', '空值回落 business');
assert.equal(SCENE_NAMES.business, '业务探索');
assert.equal(SCENE_NAMES.knowledge, '知识沉淀');
assert.equal(SCENE_NAMES.qa, '测试用例');

// 场景挑战者 label：身份携带场景（arena-challenger:<scene>），旧版无后缀兼容
assert.equal(challengerLabelFor('business'), 'arena-challenger:business');
assert.equal(challengerLabelFor('qa'), 'arena-challenger:qa');
assert.equal(challengerLabelFor('whatever'), 'arena-challenger:business', '未知场景回落 business');
assert.ok(isChallengerLabel('arena-challenger:business'), '场景 label 命中');
assert.ok(isChallengerLabel('arena-challenger'), '旧版无后缀 label 命中');
assert.ok(!isChallengerLabel('arena-challenger:nope'), '非法场景后缀不命中');
assert.ok(!isChallengerLabel('some-other-agent'), '非挑战者 label 不命中');
assert.equal(sceneFromLabel('arena-challenger:knowledge'), 'knowledge');
assert.equal(sceneFromLabel('arena-challenger'), 'business', '旧版无后缀视为 business');
assert.equal(sceneFromLabel('other'), null, '非挑战者 label 无场景');

// /arena 命令解析：off / 场景参数 / 消息兜底
assert.deepEqual(parseArenaCommand('off'), { off: true, scene: null, message: '' }, 'off 关闭');
assert.deepEqual(parseArenaCommand('business'), { off: false, scene: 'business', message: '' }, '场景参数');
assert.deepEqual(parseArenaCommand('knowledge 帮我看看x'), { off: false, scene: 'knowledge', message: '帮我看看x' }, '场景 + 消息');
assert.deepEqual(parseArenaCommand('  qa  '), { off: false, scene: 'qa', message: '' }, '空白裁剪');
assert.deepEqual(parseArenaCommand('帮我看看x'), { off: false, scene: null, message: '帮我看看x' }, '首词非场景键 → 消息');
assert.deepEqual(parseArenaCommand(''), { off: false, scene: null, message: '' }, '空入参');

// 宿主创建挑战者的 provider：默认 spawn，配置可覆盖
assert.equal(subagentProviderOf({}), 'spawn', '默认 spawn');
assert.equal(subagentProviderOf({ subagentProvider: 'fork' }), 'fork', '配置覆盖');
assert.equal(subagentProviderOf({ subagentProvider: '' }), 'spawn', '空值回落 spawn');

// 三场景 persona：结构按场景——business 回落顶层默认，knowledge/qa 有独立默认，配置可覆盖
const bizPersonas = scenePersonasOf({}, 'business');
assert.equal(bizPersonas.mainPersona, DEFAULT_MAIN_PERSONA, 'business 主代理回落顶层默认');
assert.equal(bizPersonas.challengerPrompt, DEFAULT_CHALLENGER_PROMPT, 'business 挑战者回落顶层默认');
assert.equal(bizPersonas.challengePrompt, DEFAULT_CHALLENGE_PROMPT, 'business 质疑轮模板回落顶层默认');
const knPersonas = scenePersonasOf({}, 'knowledge');
assert.ok(knPersonas.mainPersona.includes('主控者'), 'knowledge 主代理默认为主控者（Workflow Controller）');
assert.ok(knPersonas.challengerPrompt.includes('审查者'), 'knowledge 挑战者默认不同');
assert.ok(knPersonas.explorerPrompt.includes('探索者子代理'), 'knowledge 有独立探索者 persona');
assert.ok(knPersonas.explorePrompt.includes('theseus-explore'), 'knowledge 有 explore 委派模板');
assert.ok(knPersonas.explorePrompt.includes('{question}'), 'explore 委派模板带用户原文占位符');
assert.ok(knPersonas.proposePrompt.includes('theseus-propose'), 'knowledge 有 propose 委派模板');
assert.ok(knPersonas.reviewPrompt.includes('theseus-review-spec'), 'knowledge 有 review 委派模板');
assert.ok(knPersonas.readinessPrompt.includes('theseus-user-readiness-review'), 'knowledge 有 readiness 委派模板');
assert.ok(knPersonas.reportPrompt.includes('subagent_fork'), 'knowledge 报告经 fork reporter 生成');
assert.ok(knPersonas.challengerPrompt.includes('Done'), '挑战者只返回 Done');
assert.ok(!knPersonas.challengerPrompt.includes('五维审查'), '挑战者 persona 不绑定审查细节（skill 可能调整）');
assert.notEqual(knPersonas.mainPersona, bizPersonas.mainPersona, 'knowledge 与 business 主代理不同');
const qaPersonas = scenePersonasOf({}, 'qa');
assert.ok(qaPersonas.mainPersona.includes('QA Expert'), 'qa 主代理默认不同');
assert.ok(qaPersonas.challengerPrompt.includes('最终用户'), 'qa 挑战者为用户视角验收');
assert.ok(qaPersonas.challengePrompt.includes('逐条验收'), 'qa 质疑轮模板为验收轮');
assert.equal(scenePersonasOf({}, 'whatever').mainPersona, DEFAULT_MAIN_PERSONA, '未知场景回落 business');
const overPersonas = scenePersonasOf({ scenePersonas: { knowledge: { mainPersona: '自定义' } } }, 'knowledge');
assert.equal(overPersonas.mainPersona, '自定义', 'scenePersonas 覆盖生效');
assert.equal(overPersonas.challengerPrompt, knPersonas.challengerPrompt, '未覆盖字段回落场景默认');

// 意图识别输出解析（flash LLM 判定 need_answer / no_need_answer）
assert.equal(parseIntentOutput('{"answer":"need_answer"}'), 'need_answer', 'JSON need_answer');
assert.equal(parseIntentOutput('{"answer": "no_need_answer"}'), 'no_need_answer', 'JSON no_need_answer（带空格）');
assert.equal(parseIntentOutput('need_answer'), 'need_answer', '裸词 need_answer');
assert.equal(parseIntentOutput('no_need_answer'), 'no_need_answer', '裸词 no_need_answer（先于 need_answer 检查）');
assert.equal(parseIntentOutput('{"answer":"no_need_answer"} 额外内容'), 'no_need_answer', '子串回退 no_need_answer');
assert.equal(parseIntentOutput(''), null, '空输出 null');
assert.equal(parseIntentOutput('随便说点什么'), null, '无关键字 null');
assert.equal(parseIntentOutput(null), null, '非字符串 null');

// 意图识别配置默认：flash + off 思考 + 保守兜底
const intentDefaults = Config({}).intent;
assert.equal(intentDefaults.enabled, true, 'intent 默认开启');
assert.equal(intentDefaults.provider, 'deepseek-official', 'intent provider 默认 deepseek-official');
assert.equal(intentDefaults.model, 'deepseek-v4-flash', 'intent 模型默认 deepseek-v4-flash');
assert.equal(intentDefaults.reasoningEffort, 'off', 'intent 默认关思考');
assert.equal(intentDefaults.timeoutMs, 3000, 'intent 超时默认 3000ms');

// dsh-session: URI 中和（防 session-reference 预处理器抛错 / 防挑战者解引用主上下文）
assert.equal(sanitizeSessionRefs('dsh-session:abc'), 'dsh-session：abc', 'ASCII 冒号转全角');
assert.equal(sanitizeSessionRefs('@[x](dsh-session:YWJj) mention'), '@[x](dsh-session：YWJj) mention', 'mention 形式也中和');
assert.equal(sanitizeSessionRefs('截断的 dsh-session:' + 'A'.repeat(90)), '截断的 dsh-session：' + 'A'.repeat(90), '截断 URI 也不留裸片段');
assert.equal(sanitizeSessionRefs('普通文本没有引用'), '普通文本没有引用', '无引用原样保留');
assert.equal(sanitizeSessionRefs('dsh-session：已全角'), 'dsh-session：已全角', '已中和的不重复处理');
assert.equal(sanitizeSessionRefs(null), '', '非字符串返回空');
// 组装文本链路也中和（composeRoundText 返回前 sanitize）
const refEvents = [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答引用了 dsh-session:abc 会话' }] } } }
];
const composedRef = composeRoundText({}, 'challenge', refEvents);
assert.ok(!composedRef.includes('dsh-session:'), 'composeRoundText 输出不含 ASCII dsh-session:');
assert.ok(composedRef.includes('dsh-session：abc'), 'composeRoundText 输出为中和后形式');

// 宿主驱动：回合（组装/创建挑战者/派发质疑·终评）由宿主自动推进，主代理只作答/修正
assert.ok(DEFAULT_INSTRUCTION.includes('竞技回合由系统自动推进'), '指令声明回合由宿主自动推进');
assert.ok(DEFAULT_INSTRUCTION.includes('你不负责创建挑战者'), '指令声明不创建挑战者');
assert.ok(DEFAULT_INSTRUCTION.includes('也不负责发送质疑/终评消息'), '指令声明不派发消息');
assert.ok(DEFAULT_INSTRUCTION.includes('回答完成后结束当前回合'), '作答后结束回合（宿主接管）');
assert.ok(DEFAULT_INSTRUCTION.includes('修正完成后结束当前回合'), '修正后结束回合（宿主送终评）');
assert.ok(DEFAULT_INSTRUCTION.includes('结束当前回合'), '各阶段都结束回合由宿主推进');
assert.ok(!DEFAULT_INSTRUCTION.includes('arena_compose'), '指令不再要求主代理调 arena_compose');
assert.ok(!DEFAULT_INSTRUCTION.includes('send_message'), '指令不再要求主代理调 send_message');
assert.ok(!DEFAULT_INSTRUCTION.includes('arena_finish'), '指令不再要求主代理调 arena_finish');
// 主代理仍需做的事：作答（歧义澄清）+ 呈现质疑/修正 + 呈现终评
assert.ok(DEFAULT_INSTRUCTION.includes('以 Technical Expert 的身份回答用户问题'), '主代理先回答');
assert.ok(DEFAULT_INSTRUCTION.includes('ask_user_question 工具向用户澄清'), '歧义时先用 ask_user_question 澄清');
assert.ok(DEFAULT_INSTRUCTION.includes('拿到澄清后再回答'), '澄清后再回答');
assert.ok(DEFAULT_INSTRUCTION.includes('时序强约束'), '澄清是时序强约束');
assert.ok(DEFAULT_INSTRUCTION.includes('禁止先给出结论再补问'), '禁止先答后问');
assert.ok(DEFAULT_INSTRUCTION.includes('把质疑原样呈现给用户'), '质疑原样呈现');
assert.ok(DEFAULT_INSTRUCTION.includes('逐条回应并修正你的回答'), '逐条修正');
assert.ok(DEFAULT_INSTRUCTION.includes('把终评结论原样呈现给用户'), '终评原样呈现');
assert.ok(DEFAULT_INSTRUCTION.includes('质疑轮模板'), '指令引用质疑轮模板');
assert.ok(DEFAULT_INSTRUCTION.includes('终评轮模板'), '指令引用终评轮模板');
assert.ok(DEFAULT_INSTRUCTION.includes('{challengePrompt}') && DEFAULT_INSTRUCTION.includes('{verdictPrompt}'), '指令含回合模板占位符');
assert.ok(!DEFAULT_INSTRUCTION.includes('{challengerPrompt}'), '默认指令不再内嵌人设（避免与系统 persona 重复）');

// 主代理 persona：业务探索 Technical Expert；约束按时机分组；与挑战者 persona 不同
assert.ok(DEFAULT_MAIN_PERSONA.includes('Technical Expert'), '主代理 persona 为 Technical Expert');
assert.ok(DEFAULT_MAIN_PERSONA.includes('逐条修正'), '主代理针对质疑逐条修正');
assert.ok(DEFAULT_MAIN_PERSONA.includes('ask_user_question'), '主代理可用 ask_user_question');
assert.ok(DEFAULT_MAIN_PERSONA.includes('【答题时】'), '答题约束成组');
assert.ok(DEFAULT_MAIN_PERSONA.includes('【面对质疑时】'), '质疑约束成组');
assert.ok(DEFAULT_MAIN_PERSONA.includes('必须先 ask_user_question 向用户澄清指代'), '答题时先澄清');
assert.ok(DEFAULT_MAIN_PERSONA.includes('调查只用于列出候选与依据，不替代澄清'), '调查不替代澄清');
assert.ok(DEFAULT_MAIN_PERSONA.includes('不认可的条目用 ask_user_question 提出异议'), '质疑时可用异议');
// 执行边界：评审不执行修改；认可 ≠ 用户授权
assert.ok(DEFAULT_MAIN_PERSONA.includes('【执行边界】'), 'persona 含执行边界');
assert.ok(DEFAULT_MAIN_PERSONA.includes('不执行任何代码/文档修改'), '竞技场流程不执行修改');
assert.ok(DEFAULT_MAIN_PERSONA.includes('不是用户授权'), '认可不等于用户授权');
assert.notEqual(DEFAULT_MAIN_PERSONA, DEFAULT_CHALLENGER_PROMPT, '主代理与挑战者 persona 不同');

// 挑战者 persona：业务探索 Business Analyst（质疑 + 终评）
assert.ok(DEFAULT_CHALLENGER_PROMPT.includes('challenger'), '人设自述为挑战者');
assert.ok(DEFAULT_CHALLENGER_PROMPT.includes('Business Analyst'), '挑战者 persona 为 Business Analyst');
assert.ok(DEFAULT_CHALLENGER_PROMPT.includes('业务分析师'), '中文角色名');
assert.ok(DEFAULT_CHALLENGER_PROMPT.includes('质疑并给出终评'), '挑战者负责质疑与终评');
assert.equal(CHALLENGER_LABEL, 'arena-challenger');

// 质疑轮模板：结构化字段 + 逐条质疑指令
assert.ok(DEFAULT_CHALLENGE_PROMPT.includes('[质疑轮]'), '质疑轮模板标题');
assert.ok(DEFAULT_CHALLENGE_PROMPT.includes('{question}'), '质疑轮含用户问题占位符');
assert.ok(DEFAULT_CHALLENGE_PROMPT.includes('{answer}'), '质疑轮含回答占位符');
assert.ok(DEFAULT_CHALLENGE_PROMPT.includes('{files}') && DEFAULT_CHALLENGE_PROMPT.includes('{tools}'), '质疑轮含文件/工具占位符');
assert.ok(DEFAULT_CHALLENGE_PROMPT.includes('逐条质疑'), '质疑轮要求逐条质疑');
assert.ok(DEFAULT_CHALLENGE_PROMPT.includes('禁止辩论'), '质疑轮禁止辩论');

// 终评轮模板：逐条核对 + 认可/仍存疑
assert.ok(DEFAULT_VERDICT_PROMPT.includes('[终评轮]'), '终评轮模板标题');
assert.ok(DEFAULT_VERDICT_PROMPT.includes('{answer}'), '终评轮含修正后回答占位符');
assert.ok(DEFAULT_VERDICT_PROMPT.includes('逐条核对'), '终评轮要求逐条核对质疑');
assert.ok(DEFAULT_VERDICT_PROMPT.includes('认可或仍存疑'), '终评轮结论为认可/仍存疑');
assert.ok(DEFAULT_VERDICT_PROMPT.includes('不要提出新的质疑'), '终评轮不再提出新质疑');

// 固定模型：与父代理无关，默认 deepseek-v4-pro · max
assert.deepEqual(DEFAULT_CHALLENGER_MODEL, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' });
assert.deepEqual(challengerModelOf({}), DEFAULT_CHALLENGER_MODEL, '空配置回退默认固定模型');
assert.deepEqual(
  challengerModelOf({ challengerModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } }),
  { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
  '配置的 challengerModel 生效'
);
assert.equal(challengerModelOf({ challengerModel: { model: 'deepseek-v4-pro' } }).reasoningEffort, 'max', '缺省推理深度回退 max');

// 探索者模型（0.33.24 起与挑战者分离）：官方 deepseek-v4-flash · high
assert.deepEqual(DEFAULT_EXPLORER_MODEL, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' });
assert.deepEqual(explorerModelOf({}), DEFAULT_EXPLORER_MODEL, '空配置回退默认探索者模型');
assert.deepEqual(
  explorerModelOf({ explorerModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' } }),
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
  '配置的 explorerModel 生效（可覆盖回 v4-pro）'
);
assert.equal(explorerModelOf({ explorerModel: { model: 'deepseek-v4-flash' } }).reasoningEffort, 'high', '缺省推理深度回退 high');
assert.notDeepEqual(DEFAULT_EXPLORER_MODEL, DEFAULT_CHALLENGER_MODEL, '探索者与挑战者默认模型分离');

// 竞技场模式折叠：会话日志里的 arena/mode 事件，最后一条生效（保留兼容）
assert.equal(foldArenaMode([]), false, '空事件 = 未开启');
assert.equal(foldArenaMode([{ type: 'user' }]), false, '无 arena/mode = 未开启');
assert.equal(foldArenaMode([{ type: 'arena/mode', data: { active: true } }]), true, 'arena/mode true = 开启');
assert.equal(foldArenaMode([{ type: 'arena/mode', data: { active: true } }, { type: 'arena/mode', data: { active: false } }]), false, '最后一条生效（关）');
assert.equal(foldArenaMode(undefined), false, '无事件数组 = 未开启');

// 工具记录机器提取：排除 send_message/subagent，beforeSendMessage 截断到最近一次转发之前
const toolEvents = [
  { type: 'tool/call', data: { name: 'grep', arguments: '{"pattern":"event page"}' } },
  { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a/b/c.php","limit":60}' } },
  { type: 'tool/call', data: { name: 'send_message', arguments: '{"subagent_id":"x","message":"[质疑轮] ..."}' } },
  { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"git status"}' } }
];
assert.deepEqual(
  collectToolRecords(toolEvents),
  ['1. bash「git status」'],
  'beforeSendMessage=true 只保留最近一次 send_message 之前的工具'
);
assert.deepEqual(
  collectToolRecords(toolEvents, { beforeSendMessage: false }),
  ['1. grep「event page」', '2. read「a/b/c.php」', '3. bash「git status」'],
  'beforeSendMessage=false 保留全部（排除 send_message）'
);
assert.deepEqual(collectToolRecords([]), [], '空事件 = 空记录');
assert.deepEqual(collectToolRecords([{ type: 'tool/call', data: { name: 'send_message', arguments: '{}' } }]), [], '纯 send_message = 空记录');

// 机器提取：用户问题 / 回答正文 / 提到的文件 / 组装
const sampleEvents = [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'event page是哪个项目里的' }] } },
  { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '挑战者结算' }] } },
  { type: 'tool/call', data: { name: 'grep', arguments: '{"pattern":"event","file_path":"a/b.php"}' } },
  { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a/b.php","limit":60}' } },
  { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls","description":"list"}' } },
  { type: 'tool/call', data: { name: 'send_message', arguments: '{"subagent_id":"x"}' } },
  { type: 'assistant/message', data: { message: { content: [
    { type: 'reasoning', text: '思考过程' },
    { type: 'text', text: '最终回答正文' }
  ] } } }
];
assert.equal(collectUserQuestion(sampleEvents), 'event page是哪个项目里的', '取最后一条真实用户消息（排除 subagent-settled）');
assert.equal(collectAnswer(sampleEvents), '最终回答正文', '取最后 assistant 文本块（排除 reasoning）');
assert.deepEqual(collectFiles(sampleEvents), ['a/b.php'], 'file_path 去重提取');
// composeRoundText：四字段全部机器替换
const composed = composeRoundText({}, 'challenge', sampleEvents);
assert.ok(composed.includes('[质疑轮]'), '质疑轮模板');
assert.ok(composed.includes('event page是哪个项目里的'), '{question} 被机器替换');
assert.ok(composed.includes('最终回答正文'), '{answer} 被机器替换');
assert.ok(composed.includes('提到的文件：「a/b.php」'), '{files} 被机器替换且用「」包裹（与 question/answer 对称）');
assert.ok(composed.includes('grep「a/b.php」'), '{tools} 被机器替换（摘要取 file_path）');
assert.ok(composed.includes('「1. grep「a/b.php」'), '{tools} 外层也用「」包裹（与 answer/files 对称）');
assert.ok(!composed.includes('{question}') && !composed.includes('{answer}'), '无残留占位符');
const verdictComposed = composeRoundText({}, 'verdict', sampleEvents);
assert.ok(verdictComposed.includes('[终评轮]'), '终评轮模板');
assert.ok(verdictComposed.includes('提到的文件：「a/b.php」'), '终评轮 files 也用「」包裹');
assert.ok(!verdictComposed.includes('{answer}') && !verdictComposed.includes('{files}'), '终评轮占位符全部替换');
// 空事件回退：files/tools 填「（无）」
const emptyComposed = composeRoundText({}, 'challenge', []);
assert.ok(emptyComposed.includes('（无）'), '空提取回退（无）');

// Gate logic replicas (mirrors the section text fn in lib/index.js)
// 与预设无关：只看竞技场模式（宿主侧文件，测试用 arenaOn 布尔建模）+ 会话有
// subagent 工具；子代理会话不注入。
const gate = (cfg, agent, { hasSubagent = true, arenaOn = false } = {}) => {
  if (!cfg.enabled) return false;
  if (!agent) return false;
  const depth = agent.options?.subagentDepth;
  if (depth !== void 0 && depth !== null) return false;
  if (agent.session?.header?.origin === 'subagent') return false;
  if (!arenaOn) return false;
  if (!hasSubagent) return false;
  return true;
};
const cfg = { enabled: true };
assert.equal(gate(cfg, { options: {}, session: { header: {} } }, { arenaOn: true }), true, '模式开启 = 命中（与预设无关）');
assert.equal(gate(cfg, { options: {}, session: { header: {} } }, { arenaOn: false }), false, '模式未开启 = 不命中');
assert.equal(gate(cfg, { options: { subagentDepth: 1 }, session: { header: { origin: 'subagent' } } }, { arenaOn: true }), false, '子代理不注入');
assert.equal(gate(cfg, { options: {}, session: { header: {} } }, { hasSubagent: false, arenaOn: true }), false, '会话没有 subagent 工具（如 minimal）= 不注入');
assert.equal(gate({ ...cfg, enabled: false }, { options: {}, session: { header: {} } }, { arenaOn: true }), false, '插件关闭时不注入');

// Config 默认值：新字段与默认指令/固定模型/双 persona/回合模板一致
const defaults = Config({});
assert.equal(defaults.challengerPrompt, DEFAULT_CHALLENGER_PROMPT, 'challengerPrompt 默认值一致');
assert.equal(defaults.challengePrompt, DEFAULT_CHALLENGE_PROMPT, 'challengePrompt 默认值一致');
assert.equal(defaults.verdictPrompt, DEFAULT_VERDICT_PROMPT, 'verdictPrompt 默认值一致');
assert.equal(defaults.mainPersona, DEFAULT_MAIN_PERSONA, 'mainPersona 默认值一致');
assert.equal(defaults.instruction, DEFAULT_INSTRUCTION, 'instruction 默认值一致');
assert.equal(defaults.maxVerdictRounds, 3, 'maxVerdictRounds 默认 3');
assert.deepEqual(defaults.challengerModel, DEFAULT_CHALLENGER_MODEL, 'challengerModel 默认值一致');
assert.deepEqual(defaults.explorerModel, DEFAULT_EXPLORER_MODEL, 'explorerModel 默认值一致');
// 多源检索指引：目前只注入业务探索（business）；knowledge / qa 默认不注入
assert.equal(defaults.sceneSearchGuide.business, DEFAULT_SEARCH_GUIDE, 'business 默认注入多源检索指引');
assert.ok(defaults.sceneSearchGuide.knowledge.includes('openspec/specs'), 'knowledge 注入 Theseus 知识源检索指引');
assert.ok(defaults.sceneSearchGuide.knowledge.includes('openspec/states'), 'knowledge 检索指引含 workflow 运行时');
assert.ok(defaults.sceneSearchGuide.knowledge.includes('spec-meta.ts'), 'knowledge 检索指引含 spec-meta');
assert.ok(defaults.sceneSearchGuide.knowledge.includes('历史会话'), 'knowledge 检索指引含历史会话源');

// 工作区门控：knowledge/qa 默认仅 intranet-aio；business 不限
const wsGate = { knowledge: 'intranet-aio', qa: 'intranet-aio' };
assert.deepEqual(scenesAllowedIn('/Users/wens.huang/Documents/intranet-aio', wsGate), ['business', 'knowledge', 'qa'], 'intranet-aio 工作区三个场景全可用');
assert.deepEqual(scenesAllowedIn('/Users/wens.huang/Documents/dsh-plugins', wsGate), ['business'], '非 intranet-aio 只余 business');
assert.deepEqual(scenesAllowedIn('/Users/wens.huang/Documents/intranet-aio/worktrees/intranet-mod/x', wsGate), ['business', 'knowledge', 'qa'], 'intranet-aio 子目录同样命中');
assert.deepEqual(scenesAllowedIn('', wsGate), ['business'], 'cwd 未知只放行业务');
assert.deepEqual(scenesAllowedIn('/any/path', {}), ['business', 'knowledge', 'qa'], '无门控配置 = 全部可用');
assert.equal(defaults.sceneWorkspace.knowledge, 'intranet-aio', 'sceneWorkspace.knowledge 默认 intranet-aio');
assert.equal(defaults.sceneWorkspace.qa, 'intranet-aio', 'sceneWorkspace.qa 默认 intranet-aio');
assert.ok(defaults.sceneSearchGuide.knowledge.includes('session-search'), 'knowledge 检索指引含 session-search 入口');
assert.equal(defaults.sceneSearchGuide.qa, '', 'qa 默认不注入');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('mcp__jira'), '指引含 Jira MCP 工具');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('git log'), '指引含 git 检索');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('openspec'), '指引含 openspec 检索');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('代码库'), '指引含代码库检索');

// knowledge 检索指引：与工作区 theseus 技能对齐（状态词汇 / spec-meta 入口 / worktree 边界 / 优先级）
assert.ok(!KNOWLEDGE_SEARCH_GUIDE.includes('needs-review'), 'knowledge 指引不再引用仓库中不存在的 needs-review 状态');
assert.ok(!KNOWLEDGE_SEARCH_GUIDE.includes('stale'), 'knowledge 指引不再引用仓库中不存在的 stale 状态');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('status: active'), 'knowledge 指引用真实状态词汇 active');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('status: draft'), 'knowledge 指引用真实状态词汇 draft（draft 须先验证）');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('git rev-parse --show-toplevel'), 'spec-meta 用仓库根解析路径调用（cwd 无关）');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('只读基线'), 'explore-master 标注为只读基线');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('feature worktree'), 'apply 阶段写代码走 feature worktree（不是 explore-master）');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('SKILL.md 为准'), '与工作区 SKILL.md 冲突时以 SKILL.md 为准');

// 历史会话检索指引：独立字段、全场景、只给主代理、能力式条件
assert.equal(defaults.sessionHistoryGuide, DEFAULT_SESSION_HISTORY_GUIDE, 'sessionHistoryGuide 默认值一致');
assert.ok(!DEFAULT_SEARCH_GUIDE.includes('session-search'), '历史会话已拆出，不再内嵌在 business 多源检索里');
assert.ok(KNOWLEDGE_SEARCH_GUIDE.includes('session-search'), '历史会话作为检索源之一出现在 knowledge 指引里（用户明确要求搜索源包含历史会话）');
assert.ok(DEFAULT_SESSION_HISTORY_GUIDE.includes('session-search'), '历史会话指引点名 session-search 等价能力');
assert.ok(DEFAULT_SESSION_HISTORY_GUIDE.includes('没有该能力则整段跳过'), '无该能力时优雅跳过');
assert.ok(DEFAULT_SESSION_HISTORY_GUIDE.includes('搜不到不等于没发生过'), '含字面子串匹配的边界说明');
assert.ok(DEFAULT_SESSION_HISTORY_GUIDE.includes('session id'), '引用过往结论须注明 session id');
assert.equal(Config({ sessionHistoryGuide: '' }).sessionHistoryGuide, '', "sessionHistoryGuide 可置空（'' = 不注入）");

assert.ok(!('targetPresets' in defaults), 'targetPresets 已移除（与预设无关）');

// ── 终评「仍存疑」→ 询问用户是否再来一轮（不计轮次、不设上限）─────────────
// 终评结论标记：模板要求最后单独一行输出 `结论：认可` / `结论：仍存疑`
assert.ok(DEFAULT_VERDICT_PROMPT.includes('结论：认可'), '终评轮要求输出认可结论标记');
assert.ok(DEFAULT_VERDICT_PROMPT.includes('结论：仍存疑'), '终评轮要求输出仍存疑结论标记');
assert.ok(scenePersonasOf({}, 'qa').verdictPrompt.includes('结论：通过'), 'qa 终验轮标记为通过');
assert.equal(scenePersonasOf({}, 'knowledge').verdictPrompt, DEFAULT_VERDICT_PROMPT, 'knowledge 质疑/终评模板回落顶层值但不被 Theseus 流程渲染');

// 结论判定：标记行优先 → 末尾两行 → 全文；存疑优先于认可（否定词含肯定词子串）
assert.equal(parseVerdictOutcome('结论：认可'), 'approved', '标记行认可');
assert.equal(parseVerdictOutcome('结论：仍存疑'), 'disputed', '标记行仍存疑');
assert.equal(parseVerdictOutcome('结论：通过'), 'approved', 'qa 通过 = 认可');
assert.equal(parseVerdictOutcome('最终审查结论：NEEDS_REVISION'), 'disputed', 'knowledge NEEDS_REVISION = 存疑');
assert.equal(parseVerdictOutcome('READY'), 'approved', 'READY = 认可');
assert.equal(parseVerdictOutcome('第2条仍未解决。\n结论：仍存疑'), 'disputed', '标记行取最后一处');
assert.equal(
  parseVerdictOutcome('模板：结论：认可 或 结论：仍存疑\n结论：认可'),
  'approved',
  '复述模板不覆盖真结论（取最后一处标记）'
);
assert.equal(parseVerdictOutcome('此前的存疑均已解决，认可修正稿。'), 'approved', '「存疑已解决」不误判为存疑');
assert.equal(parseVerdictOutcome('仍未解决项：无。认可。'), 'approved', '「仍未解决项：无」不误判为存疑');
assert.equal(parseVerdictOutcome('无标记也无关键词的一段话'), null, '无法判定 = null（宿主保守按仍存疑处理）');
assert.equal(parseVerdictOutcome(''), null, '空文本 null');
assert.equal(parseVerdictOutcome(null), null, '非字符串 null');

// 用户选择：ask_user_question 结果机器提取（固定问题 id + 固定选项文案）
assert.equal(ARENA_ANOTHER_ROUND_QUESTION_ID, 'arena_another_round', '固定问题 id');
assert.ok(DEFAULT_INSTRUCTION.includes(ARENA_ANOTHER_ROUND_QUESTION_ID), '指令告知固定问题 id');
assert.ok(DEFAULT_INSTRUCTION.includes(ARENA_ANOTHER_ROUND_YES), '指令含「再来一轮」固定选项');
assert.ok(DEFAULT_INSTRUCTION.includes(ARENA_ANOTHER_ROUND_NO), '指令含「结束竞技」固定选项');
assert.ok(DEFAULT_INSTRUCTION.includes('必须调用 ask_user_question 工具'), '仍存疑必须问用户');
const answerJson = (selected, id = ARENA_ANOTHER_ROUND_QUESTION_ID, custom) => JSON.stringify({
  answers: [{ id, selected, ...custom !== undefined ? { custom } : {} }]
});
assert.equal(parseAnotherRoundAnswer(answerJson([ARENA_ANOTHER_ROUND_YES])), 'continue', '选再来一轮 = continue');
assert.equal(parseAnotherRoundAnswer(answerJson([ARENA_ANOTHER_ROUND_NO])), 'stop', '选结束 = stop');
assert.equal(parseAnotherRoundAnswer(answerJson([], ARENA_ANOTHER_ROUND_QUESTION_ID, '不继续了')), 'stop', '自定义否定 = stop（否定优先）');
assert.equal(parseAnotherRoundAnswer(answerJson([], ARENA_ANOTHER_ROUND_QUESTION_ID, '继续吧')), 'continue', '自定义肯定 = continue');
assert.equal(parseAnotherRoundAnswer('not json'), null, '非 JSON 且无关键词 = null');
assert.equal(parseAnotherRoundAnswer(''), null, '空结果 null');

// 会话事件里提取用户选择：只看最后一次挑战者结算之后的 ask_user_question 结果
const askResultEvent = (callId, text) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } }
});
const choiceEvents = [
  // 结算前的历史询问（澄清指代）——不能影响判定
  { type: 'tool/call', data: { name: 'ask_user_question', callId: 'old' } },
  askResultEvent('old', answerJson(['继续'])),
  { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '结论：仍存疑' }] } },
  { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } },
  askResultEvent('c1', answerJson([ARENA_ANOTHER_ROUND_NO]))
];
assert.equal(collectAnotherRoundChoice(choiceEvents), 'stop', '只取结算之后的选择');
assert.equal(
  collectAnotherRoundChoice([
    { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [] } },
    { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } },
    askResultEvent('c1', answerJson([ARENA_ANOTHER_ROUND_YES]))
  ]),
  'continue',
  '选再来一轮'
);
assert.equal(
  collectAnotherRoundChoice([
    { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [] } },
    { type: 'tool/call', data: { name: 'read', callId: 'r1' } },
    askResultEvent('r1', answerJson([ARENA_ANOTHER_ROUND_YES]))
  ]),
  null,
  '非 ask_user_question 的工具结果不算选择'
);
assert.equal(collectAnotherRoundChoice([]), null, '没问过 = null（宿主收尾关闭）');
assert.equal(collectAnotherRoundChoice(undefined), null, '无事件数组 = null');

// 收尾要求整理完整结论（认可 / 用户拒绝再来一轮都走这里），不是只给概览
assert.equal(defaults.conclusionPrompt, DEFAULT_CONCLUSION_PROMPT, 'conclusionPrompt 默认值一致');
assert.ok(DEFAULT_CONCLUSION_PROMPT.includes('【结论输出要求】'), '结论要求有标题');
assert.ok(DEFAULT_CONCLUSION_PROMPT.includes('不要只给概览'), '明确禁止只给概览');
assert.ok(DEFAULT_CONCLUSION_PROMPT.includes('依据与出处'), '结论要带出处');
assert.ok(DEFAULT_CONCLUSION_PROMPT.includes('仍未解决'), '结论要列仍存疑项');
assert.ok(DEFAULT_CONCLUSION_PROMPT.includes('不执行任何代码/文档修改'), '结论阶段仍守执行边界');
assert.ok(DEFAULT_INSTRUCTION.includes('【结论输出要求】'), '指令引用结论输出要求');

// 轮次计数：设计与字段保留，但不记录、不累加、不设上限
assert.equal(defaults.maxVerdictRounds, 3, 'maxVerdictRounds 保留（不参与判定）');
assert.ok(!DEFAULT_INSTRUCTION.includes('{maxVerdictRounds}'), '指令不再用轮数上限约束主代理');

// ── 知识沉淀（knowledge）：Theseus workflow 对抗流程 ──────────────────────
// 双 label：探索者 arena-explorer:<scene> + 挑战者 arena-challenger:<scene>
assert.equal(EXPLORER_LABEL, 'arena-explorer', '探索者 label 前缀');
assert.equal(explorerLabelFor('knowledge'), 'arena-explorer:knowledge', '探索者 label 带场景');
assert.equal(explorerLabelFor('whatever'), 'arena-explorer:business', '未知场景回落 business');
assert.ok(isExplorerLabel('arena-explorer:knowledge'), '探索者 label 命中');
assert.ok(!isExplorerLabel('arena-explorer:nope'), '非法场景后缀不命中');
assert.ok(!isExplorerLabel(CHALLENGER_LABEL + ':knowledge'), '挑战者 label 不是探索者');
assert.equal(sceneFromAnyLabel('arena-challenger:knowledge'), 'knowledge', 'any label 取挑战者场景');
assert.equal(sceneFromAnyLabel('arena-explorer:knowledge'), 'knowledge', 'any label 取探索者场景');
assert.equal(sceneFromAnyLabel('other'), null, '非竞技场 label 无场景');

// 探索者返回协议解析（取最后一个协议行；前缀行）
assert.deepEqual(parseStageResult('叙述…\nSTAGE_DONE explore CONFIRMED'), { kind: 'stage_done', stage: 'explore', result: 'CONFIRMED' }, 'STAGE_DONE 解析');
assert.deepEqual(parseStageResult('STAGE_DONE user-readiness CLEARED'), { kind: 'stage_done', stage: 'user-readiness', result: 'CLEARED' }, 'readiness 阶段结果');
assert.equal(parseStageResult('NEED_QUESTION {"question":"q?"}').kind, 'need_question', 'NEED_QUESTION 解析');
assert.equal(parseStageResult('NEED_QUESTION {"question":"q?"}').question, '{"question":"q?"}', '问题 JSON 原文保留');
assert.deepEqual(parseStageResult('BLOCKED 缺 JIRA 票据'), { kind: 'blocked', reason: '缺 JIRA 票据' }, 'BLOCKED 解析');
assert.equal(parseStageResult('随便说点什么'), null, '无协议行 null');
assert.equal(parseStageResult(null), null, '非字符串 null');
assert.deepEqual(
  parseStageResult('STAGE_DONE explore CONFIRMED\n多余行'),
  { kind: 'stage_done', stage: 'explore', result: 'CONFIRMED' },
  '协议行取最后一处命中'
);
// dsh 结算包装文本：协议拼在行中间（"…Its closing message:STAGE_DONE explore CONFIRMED"）——
// 曾因要求行首导致解析失败、流程停在 propose 不派发（session-406356e0 事故）。
assert.deepEqual(
  parseStageResult('Background subagent 45c5b11a finished and will do no further work unless you send it more.Its closing message:STAGE_DONE explore CONFIRMED'),
  { kind: 'stage_done', stage: 'explore', result: 'CONFIRMED' },
  '结算包装文本（协议不在行首）也能解析'
);
assert.deepEqual(
  parseStageResult('先返回了一个问题 NEED_QUESTION {"question":"q?"}，随后补充 STAGE_DONE explore CONFIRMED'),
  { kind: 'stage_done', stage: 'explore', result: 'CONFIRMED' },
  '同消息多协议标记取最后一个'
);

// review.md Overall Verdict 解析（文件为判定唯一真相）
assert.equal(parseReviewFileVerdict('**Overall Verdict**: READY'), 'ready', 'READY 认可');
assert.equal(parseReviewFileVerdict('**Overall Verdict**: NEEDS REVISION'), 'needs_revision', 'NEEDS REVISION');
assert.equal(parseReviewFileVerdict('**Overall Verdict**: NEEDS_REVISION'), 'needs_revision', '下划线兼容');
assert.equal(parseReviewFileVerdict('Overall Verdict：NOT READY'), 'not_ready', 'NOT READY + 全角冒号');
assert.equal(parseReviewFileVerdict('没有 verdict 行'), null, '无判定 null');
assert.equal(parseReviewFileVerdict(null), null, '非字符串 null');

// 知识沉淀固定提问（主控者 ask_user_question → 宿主判定）
const kReportJson = (sel) => JSON.stringify({ answers: [{ id: ARENA_K_REPORT_QUESTION_ID, selected: [sel] }] });
const kRevisionJson = (sel) => JSON.stringify({ answers: [{ id: ARENA_K_REVISION_QUESTION_ID, selected: [sel] }] });
assert.equal(ARENA_K_REPORT_QUESTION_ID, 'arena_k_report', '报告提问 id 固定');
assert.equal(ARENA_K_REVISION_QUESTION_ID, 'arena_k_revision', '修订提问 id 固定');
assert.equal(parseKnowledgeChoice(kReportJson(ARENA_K_REPORT_YES), 'report'), 'generate', '选生成报告');
assert.equal(parseKnowledgeChoice(kReportJson(ARENA_K_REPORT_NO), 'report'), 'skip', '选跳过（否定优先）');
assert.equal(parseKnowledgeChoice(kRevisionJson(ARENA_K_REVISION_YES), 'revision'), 'continue', '选再来一轮');
assert.equal(parseKnowledgeChoice(kRevisionJson(ARENA_K_REVISION_NO), 'revision'), 'stop', '选结束（否定优先）');
assert.equal(parseKnowledgeChoice('garbage', 'report'), null, '无法判定 null（按 skip/stop 兜底）');
// 阶段推进确认门（arena_k_advance）：确认才推进；暂停/没问 → 不推进
assert.equal(ARENA_K_ADVANCE_QUESTION_ID, 'arena_k_advance', '推进确认提问 id 固定');
const kAdvanceJson = (sel) => JSON.stringify({ answers: [{ id: ARENA_K_ADVANCE_QUESTION_ID, selected: [sel] }] });
assert.equal(parseAdvanceChoice(kAdvanceJson(ARENA_K_ADVANCE_YES)), 'continue', '确认进入下一阶段');
assert.equal(parseAdvanceChoice(kAdvanceJson(ARENA_K_ADVANCE_NO)), 'stop', '暂停不推进（否定优先）');
assert.equal(parseAdvanceChoice(JSON.stringify({ answers: [{ id: 'other', selected: ['确认'] }] })), 'continue', '非固定 id 回落最后一条答案');
assert.equal(parseAdvanceChoice(''), null, '空回答 null（宿主按不推进关闭）');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes(ARENA_K_ADVANCE_QUESTION_ID), 'knowledge 指令含推进确认提问 id');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('原文原样'), 'knowledge 指令要求子代理结论原文呈现');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('一切问题与答案都由你原样转述'), 'knowledge 指令：子代理问题与答案一律原样转述');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('user-readiness 必读对账（0.33.29'), 'knowledge 指令含 readiness 无条件必读规则（0.33.29）');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('必须先用 read 工具读'), 'readiness：转问用户前必须先 read user-readiness.review.md（0.33.29）');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('允许用 read 等工具'), 'knowledge 指令：允许用工具读工件原文引用');
assert.ok(scenePersonasOf({}, 'knowledge').explorerPrompt.includes('答案是否正确'), '探索者 persona 要求输出对账（答案正确与否）');
assert.ok(scenePersonasOf({}, 'knowledge').explorerPrompt.includes('就绪评审对账硬格式'), '探索者 persona：对账+下一题同条硬格式（0.33.30）');
assert.ok(scenePersonasOf({}, 'knowledge').explorerPrompt.includes('回合最后一条'), '探索者 persona 明示 dsh 只回传回合最后一条（0.33.30）');
assert.ok(scenePersonasOf({}, 'knowledge').explorerPrompt.includes('禁止先把对账作为回合中段文本发出'), '探索者 persona 禁止回合中段先发对账（0.33.30）');
assert.ok(!scenePersonasOf({}, 'knowledge').explorerPrompt.includes('正确项位置, why'), '问题意图不再携带答案线索字段');
assert.ok(scenePersonasOf({}, 'knowledge').explorerPrompt.includes('correctIndex'), '探索者 persona 明确禁止 correctIndex 等线索字段');
assert.ok(scenePersonasOf({}, 'knowledge').readinessPrompt.includes('correctIndex'), 'readiness 委派模板同样禁止答案线索字段');
// 工作语言只在三套 persona 各声明一次（其它位置不重复）
for (const key of ['mainPersona', 'explorerPrompt', 'challengerPrompt']) {
  const text = scenePersonasOf({}, 'knowledge')[key];
  assert.ok(text.includes('【工作语言】'), key + ' 含工作语言段');
const kMainPersona = scenePersonasOf({}, 'knowledge').mainPersona;
assert.ok(kMainPersona.includes('默认由宿主派发'), '主控者 persona 声明探索者/挑战者默认由宿主派发');
assert.ok(kMainPersona.includes('subagent / subagent_fork）已对你禁用'), '主控者 persona 声明创建新子代理的工具已禁用（0.33.20：仅禁创建）');
assert.ok(kMainPersona.includes('send_message 对你开放'), '主控者 persona 声明 send_message 开放');
assert.ok(kMainPersona.includes('只能向**已存在**的探索者/挑战者委派任务'), '主控者 persona 声明只能向已存在的子代理委派');
assert.ok(kMainPersona.includes('已有子代理优先'), '主控者 persona 声明续跑以已有代理优先');
assert.ok(kMainPersona.includes('不新建副本'), '主控者 persona 声明不新建副本');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('subagent / subagent_fork）已对你禁用'), 'knowledge 指令声明创建类委派工具禁用');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('send_message 对你开放'), 'knowledge 指令声明 send_message 开放');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('只能向**已存在**的探索者/挑战者委派任务'), 'knowledge 指令声明只能向已存在的子代理委派');
assert.ok(kMainPersona.includes('goal 工具 get_goal / create_goal / update_goal'), '主控者 persona 声明 goal 工具在开启期间禁用');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('goal 工具（get_goal / create_goal / update_goal）与 /goal 命令在竞技场开启期间同样不可用'), 'knowledge 指令声明 goal 工具与 /goal 命令不可用');
assert.ok(ARENA_GOAL_BLOCK_TEXT.includes('/goal') && ARENA_GOAL_BLOCK_TEXT.includes('已禁用'), '/goal 影子命令返回禁用提示');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('NOT_READY 与 NEEDS_REVISION 同样处理'), 'NOT_READY 与 NEEDS_REVISION 不再区分（都问是否再来一轮修订）');
assert.ok(kMainPersona.includes('阶段 skill 不由你执行'), '主控者 persona 声明阶段 skill 不由其执行');
assert.ok(kMainPersona.includes('不得亲自加载/执行它们'), '主控者 persona 禁止亲自加载阶段 skill');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('你不得亲自加载/执行 theseus-user-readiness-review / requirement-report skill'), '指令禁止主代理自跑 readiness/报告 skill');
assert.ok(kMainPersona.includes('NOT_READY → 与 NEEDS_REVISION 同样处理'), 'persona 流程 step 4 的 NOT_READY 与 NEEDS_REVISION 已统一');
assert.ok(!kMainPersona.includes('NOT_READY → 不再送审'), 'persona 不再出现旧版「NOT_READY 不再送审」文案');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('推回 propose'), '再来一轮时把 workflow 推回 propose 重新修订');
  assert.ok(text.includes('工作语言用中文'), key + ' 声明工作语言为中文');
  assert.ok(text.includes('保持英文原文不翻译'), key + ' 声明硬信息不翻译');
}
assert.ok(!scenePersonasOf({}, 'knowledge').readinessPrompt.includes('工作语言'), '委派模板不重复语言约束');
assert.ok(!DEFAULT_KNOWLEDGE_INSTRUCTION.includes('用中文回答'), 'knowledge 指令不再重复语言约束');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes(ARENA_K_REPORT_QUESTION_ID), 'knowledge 指令含报告提问 id');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes(ARENA_K_REVISION_QUESTION_ID), 'knowledge 指令含修订提问 id');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('Theseus CLI'), 'knowledge 指令声明主控者持 CLI');
assert.ok(DEFAULT_KNOWLEDGE_INSTRUCTION.includes('ask_user_question 都只能由你提出'), 'knowledge 指令声明提问独占');
assert.ok(defaults.knowledgeInstruction, DEFAULT_KNOWLEDGE_INSTRUCTION, 'knowledgeInstruction 默认一致');

// 中继答案提取：只看当前回合（最后一次 turn/start 之后；无 turn/start 回退最后一次
// 结算之后）的 ask_user_question 结果原文，同一回合多次询问全部保留（数组）。
const kAskResult = (callId, text) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } }
});
assert.deepEqual(
  collectAskAnswerText([
    { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: 'NEED_QUESTION {"question":"x"}' }] } },
    { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } },
    kAskResult('c1', '{"answers":[{"id":"q","selected":["A"]}]}')
  ]),
  ['{"answers":[{"id":"q","selected":["A"]}]}'],
  '提取结算后的回答原文（数组）'
);
assert.deepEqual(
  collectAskAnswerText([
    { type: 'tool/call', data: { name: 'ask_user_question', callId: 'old' } },
    kAskResult('old', '{"answers":[]}'),
    { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [] } }
  ]),
  [],
  '结算前（且无 turn/start 锚）的提问不计入'
);
assert.deepEqual(collectAskAnswerText([]), [], '没问 = 空数组');
// session-cceff284 事故回归：主控者被 subagent 实时消息提前唤醒、在结算消息到达**之前**
// 提问——答案在 turn/start 之后必须仍能被提取（旧实现锚定「最后一次结算之后」会漏掉 →
// 误判未确认 → 关场；运行时事件源缺失导致整条链落空，见 sessionEventsOf 用例）。
const kTurnEvents = [
  { type: 'turn/start' },
  { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } },
  kAskResult('c1', '{"answers":[{"id":"arena_k_advance","selected":["确认，进入下一阶段 (Recommended)"]}]}'),
  { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: 'STAGE_DONE explore CONFIRMED' }] } }
];
assert.deepEqual(
  collectAskAnswerText(kTurnEvents),
  ['{"answers":[{"id":"arena_k_advance","selected":["确认，进入下一阶段 (Recommended)"]}]}'],
  '提问早于结算（同一回合内）仍能提取答案'
);
assert.equal(
  parseAdvanceChoice(collectAskAnswerText(kTurnEvents)),
  'continue',
  '提前提问的确认也能被宿主判定为 continue'
);
// 跨回合污染防护：上一回合的提问不计入本回合
const kCrossTurn = [
  { type: 'turn/start' },
  { type: 'tool/call', data: { name: 'ask_user_question', callId: 'old' } },
  kAskResult('old', '{"answers":[{"id":"arena_k_advance","selected":["暂停，先不推进"]}]}'),
  { type: 'turn/end' },
  { type: 'turn/start' },
  { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [] } }
];
assert.deepEqual(collectAskAnswerText(kCrossTurn), [], '上一回合的提问不计入本回合');

// 终评 READY 一次问两道（报告 + 进入 user-readiness）：两条回答都在窗口内，
// parse* 按各自固定 id 取用，不再「只认最后一条」。
const kTwoAskTurn = [
  { type: 'turn/start' },
  { type: 'tool/call', data: { name: 'ask_user_question', callId: 'r1' } },
  kAskResult('r1', JSON.stringify({ answers: [{ id: ARENA_K_REPORT_QUESTION_ID, selected: ['生成领导层报告'] }] })),
  { type: 'tool/call', data: { name: 'ask_user_question', callId: 'a1' } },
  kAskResult('a1', JSON.stringify({ answers: [{ id: ARENA_K_ADVANCE_QUESTION_ID, selected: ['确认，进入 user-readiness'] }] })),
  { type: 'user/message', data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: 'Done' }] } }
];
const kTwoAnswers = collectAskAnswerText(kTwoAskTurn);
assert.equal(kTwoAnswers.length, 2, '一次问两道 → 两条回答都提取到');
assert.equal(parseKnowledgeChoice(kTwoAnswers, 'report'), 'generate', '按报告 id 判定生成报告');
assert.equal(parseAdvanceChoice(kTwoAnswers), 'continue', '按推进 id 判定确认进入（不被报告条干扰）');
assert.deepEqual(collectAskAnswerText(kTwoAskTurn.slice(0, 4)), [kTwoAnswers[0]], '缺推进条时只返回报告条');

// sessionEventsOf：dsh 0.1.2-alpha.4 的 Session 无 .events——统一走 snapshotEvents()/log
assert.deepEqual(sessionEventsOf(null), [], '无会话 → 空数组');
assert.deepEqual(sessionEventsOf({}), [], '空对象 → 空数组');
assert.deepEqual(
  sessionEventsOf({ snapshotEvents: () => ['a', 'b'] }),
  ['a', 'b'],
  'snapshotEvents() 优先（alpha.4 真实 API）'
);
assert.deepEqual(
  sessionEventsOf({ events: ['old'] }),
  ['old'],
  '旧 .events 字段兼容'
);
assert.deepEqual(
  sessionEventsOf({ log: ['x'] }),
  ['x'],
  '.log 字段兜底'
);
assert.deepEqual(
  sessionEventsOf({ snapshotEvents: () => { throw new Error('boom'); }, log: ['x'] }),
  ['x'],
  'snapshotEvents 抛错时回退 .log'
);

// planKnowledgeAdvance：k_gate 推进决策（文件真相兜底，杜绝「已确认却静默关场」）
assert.deepEqual(planKnowledgeAdvance('continue', 'propose', 'propose'), { action: 'dispatch' }, '确认 + record 已生效 → 派发');
assert.deepEqual(planKnowledgeAdvance('continue', 'explore', 'propose'), { action: 'retry' }, '确认但 record 未生效 → 停留重试');
// planKnowledgeGate（0.33.20-0.33.22）：用户同意修订轮 / 本回合已向竞技场子代理
// send_message 委派（统一「子代理任务在途」）→ 留场等待结算，不推进不关场
assert.deepEqual(planKnowledgeGate(null, 'continue', 'propose', 'review'), { action: 'stay', reason: 'child-task-in-flight' }, '修订轮同意 → stay（即使无推进确认、record 未生效）');
assert.deepEqual(planKnowledgeGate('continue', 'continue', 'propose', 'review'), { action: 'stay', reason: 'child-task-in-flight' }, '修订轮优先于推进判定');
assert.deepEqual(planKnowledgeGate('continue', null, 'propose', 'propose'), { action: 'dispatch' }, '无在途任务时回落原决策：确认 + record → 派发');
assert.deepEqual(planKnowledgeGate(null, 'stop', 'propose', 'review'), { action: 'close', reason: 'no-confirm-no-record' }, '拒绝修订且未 record → 关场');
assert.deepEqual(planKnowledgeGate(null, null, 'propose', 'review', true), { action: 'stay', reason: 'child-task-in-flight' }, '0.33.21：本回合已 send_message 委派给竞技场子代理 → stay（主控者跳过提问也不误关）');
assert.deepEqual(planKnowledgeGate('continue', null, 'propose', 'review', true), { action: 'stay', reason: 'child-task-in-flight' }, '在途检测优先于推进判定');
// hasArenaChildDelegation（0.33.22）：与成因无关的「子代理任务在途」机械信号
const kSendCall = (agentId) => ({ type: 'tool/call', data: { name: 'send_message', arguments: JSON.stringify({ agent_id: agentId, message: 'x' }) } });
assert.equal(hasArenaChildDelegation([kSendCall('2bf6aff4-1')], ['2bf6aff4-1', 'c909fb57-1']), true, '命中竞技场子代理 id → 在途');
assert.equal(hasArenaChildDelegation([kSendCall('other-agent')], ['2bf6aff4-1']), false, '目标是其它代理 → 不在途');
assert.equal(hasArenaChildDelegation([{ type: 'tool/call', data: { name: 'bash', arguments: '{}' } }], ['2bf6aff4-1']), false, '非 send_message 调用不计');
assert.equal(hasArenaChildDelegation([kSendCall('2bf6aff4-1')], []), false, '无竞技场子代理 id → 不误判');
assert.equal(hasArenaChildDelegation([kSendCall('2bf6aff4-1')], ['x']), false, '目标不匹配 → 不在途');
assert.equal(hasArenaChildDelegation(undefined, ['x']), false, '事件缺失 → false');
// roundEventsOf（0.33.25）：在途检测窗口化到当前回合——修复 0.33.22 全量历史扫描回归
// （历史中继 send_message 残留 → 后续每次 k_gate 都 stay 卡死，session-90527e05）
assert.deepEqual(roundEventsOf([]), [], '空事件 → 空');
assert.deepEqual(roundEventsOf(undefined), [], '事件缺失 → 空');
const noAnchor = [{ a: 1 }, { a: 2 }];
assert.equal(roundEventsOf(noAnchor), noAnchor, '无 turn/start、无 settle → 全量原引用');
const turnStartEv = () => ({ type: 'turn/start' });
const settleEv = () => ({ type: 'user/message', data: { source: { kind: 'subagent-settled' } } });
const winFallback = [{ a: 1 }, settleEv(), { a: 2 }];
assert.deepEqual(roundEventsOf(winFallback), [settleEv(), { a: 2 }], '无 turn/start → 回退最后一次 settle（含锚点起，与 collectAskAnswerText 一致）');
const winMulti = [{ a: 0 }, turnStartEv(), { a: 1 }, settleEv(), { a: 2 }, turnStartEv(), { a: 3 }];
assert.deepEqual(roundEventsOf(winMulti), [turnStartEv(), { a: 3 }], '取最后一次 turn/start 起（turn/start 优先于 settle）');
// 组合回归：历史回合的中继不算在途（可正常派发）；本回合委派仍算在途（stay 留场）
const evOldRelay = [
  { type: 'turn/start' },
  kSendCall('2bf6aff4-1'),
  { type: 'turn/end' },
  turnStartEv(), // 当前确认门回合（k_gate）
  { type: 'turn/end' }
];
assert.equal(hasArenaChildDelegation(roundEventsOf(evOldRelay), ['2bf6aff4-1']), false, '0.33.25 回归：历史回合的 send_message 中继不进入当前回合窗口 → 不在途 → k_gate 正常推进');
assert.equal(
  planKnowledgeGate('continue', null, 'review', 'review', hasArenaChildDelegation(roundEventsOf(evOldRelay), ['2bf6aff4-1'])).action,
  'dispatch',
  '组合：用户确认 + record 生效 + 仅历史中继 → 派发 review（本次事故形态）'
);
const evRoundRelay = [turnStartEv(), kSendCall('2bf6aff4-1'), { type: 'turn/end' }];
assert.equal(hasArenaChildDelegation(roundEventsOf(evRoundRelay), ['2bf6aff4-1']), true, '本回合内委派修订轮 → 仍在途 → stay 等结算');
// childCreateDenyReason（0.33.26）：tools.guard 执行级硬门的拒绝文案——restrict 够不到
// own 层注册的 subagent，guard 在 dispatch 前按 exec.name 拦；send_message 放行
assert.equal(childCreateDenyReason('subagent'), '竞技场模式下已禁用 subagent：探索者/挑战者由宿主按阶段创建；主控者只能向已存在的探索者/挑战者委派任务（send_message），禁止创建新子代理（新副本没有阶段上下文、游离于状态机外）。', 'subagent → 拒绝文案');
assert.ok(childCreateDenyReason('subagent_fork')?.includes('已禁用 subagent_fork'), 'subagent_fork → 拒绝文案');
assert.equal(childCreateDenyReason('send_message'), void 0, 'send_message 不在名单 → 放行（向既有子代理委派开放）');
assert.equal(childCreateDenyReason('list_agents'), void 0, 'list_agents 放行');
assert.equal(childCreateDenyReason(undefined), void 0, 'exec.name 缺失 → 放行');
// 0.33.29 执行观测：readinessAskSkippedDocRead（主控者未读文档就转问就绪题 → true，宿主告警）
const kAskCall=(qid)=>({ type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions:[{id:qid}] }) } });
const kReadCall=()=>({ type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ file_path: '/x/openspec/changes/event-page-content-types/user-readiness.review.md' }) } });
const kOtherAsk=()=>({ type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions:[{id:'arena_k_advance'}] }) } });
const kTurnStart=()=>({ type: 'turn/start' });
assert.equal(readinessAskSkippedDocRead([kTurnStart(), kAskCall('readiness_q1')]), true, '就绪题未先读文档 → 违例');
assert.equal(readinessAskSkippedDocRead([kTurnStart(), kReadCall(), kAskCall('readiness_q1')]), false, '先读文档再转问 → 合规');
assert.equal(readinessAskSkippedDocRead([kTurnStart(), kAskCall('arena_k_advance')]), false, '非就绪题不检测');
assert.equal(readinessAskSkippedDocRead([kTurnStart(), kAskCall('readiness_q1'), kReadCall()]), true, '读在问之后 → 仍违例');
assert.equal(readinessAskSkippedDocRead(undefined), false, '事件缺失 → false');
// 0.33.31 readinessPreStepShouldInject：裸题回合（k_ask/k_prev=k_readiness、消息缺对账）→ 宿主回合前注入
const kAskSt={active:true,scene:'knowledge',phase:'k_ask',kPrev:'k_readiness',kQuestion:'{"question":"q"}'};
assert.equal(readinessPreStepShouldInject(kAskSt,'下一题：NEED_QUESTION {"question":"x"}'), true, '裸题且缺对账 → 注入');
assert.equal(readinessPreStepShouldInject({...kAskSt,kQuestion:''},'x'), false, '无待问问题 → 不注入');
assert.equal(readinessPreStepShouldInject({...kAskSt,kPrev:'k_propose'},'x'), false, '非 readiness 中继 → 不注入');
assert.equal(readinessPreStepShouldInject({...kAskSt,active:false},'x'), false, '非 active → 不注入');
assert.equal(readinessPreStepShouldInject({...kAskSt,scene:'business'},'x'), false, '非 knowledge → 不注入');
assert.equal(readinessPreStepShouldInject(kAskSt,'**第 2 题对账**…答案是否正确：正确'), false, '探索者已打包对账 → 不重复注入');
// 0.33.32：k_readiness 待结算 + 消息携带 NEED_QUESTION（pre-step 先于宿主写 k_ask 的竞态）也能注入
const kReadSt={active:true,scene:'knowledge',phase:'k_readiness',pendingDispatch:'readiness',kQuestion:''};
assert.equal(readinessPreStepShouldInject(kReadSt,'...closing message: 下一题（第 5 题）\nNEED_QUESTION {"question":"x"}'), true, 'settle 裸题回合（pre-step 先于 k_ask 写入）→ 注入');
assert.equal(readinessPreStepShouldInject(kReadSt,'Agent 消息：requirement-report 已收讫…'), false, 'k_readiness 下非题消息（无 NEED_QUESTION）→ 不注入');
assert.equal(readinessPreStepShouldInject(kReadSt,'NEED_QUESTION {"question":"y"}'), true, '含 NEED_QUESTION 即注入');
// 0.33.33 宿主直问（方案 B）：buildReadinessAskQuestions / readinessTurnHostAsk
const kQJson=JSON.stringify({header:'就绪评审：枚举',question:'Scenario: 第一步做什么？',options:[{label:'A'},{label:'B'},{label:'C',correctIndex:2}],multi_select:false});
const bq=buildReadinessAskQuestions(kQJson,'用户预测与规则一致 → aligned。');
assert.ok(bq && bq.length===1, '解析成功返回单题数组');
assert.ok(bq[0].question.includes('【上一题对账】') && bq[0].question.includes('用户预测与规则一致'), '对账作为问题前缀（答案正确与否随弹窗呈现）');
assert.deepEqual(bq[0].options.map(o=>o.label), ['A','B','C'], '只保留 label 展示字段（correctIndex 等线索不进负载）');
assert.equal(bq[0].multi_select, false, 'multi_select 透传');
assert.equal(buildReadinessAskQuestions('not-json', null), null, '非 JSON → null');
const kReadStB={active:true,scene:'knowledge',phase:'k_readiness',pendingDispatch:'readiness'};
assert.equal(readinessTurnHostAsk(kReadStB,'...closing message: NEED_QUESTION {"question":"x"}'), true, 'k_readiness 待结算 + NEED_QUESTION → 宿主代问并替换回合');
assert.equal(readinessTurnHostAsk(kReadStB,'requirement-report 转达…'), false, '非题消息 → 不代问');
assert.equal(readinessTurnHostAsk({...kReadStB,active:false},'NEED_QUESTION x'), false, '非 active → 不代问');


// 0.33.27 readiness 对账机械兜底（90527e05：探索者把对账发成回合中段消息 → 只回传末条 → 对账丢失）
assert.equal(hasReadinessReconcileText('**第 1 题对账**\n规则揭示…\n答案是否正确：非错误答案（未预测）'), true, '含对账标记 → true（已打包，宿主不重复补发）');
assert.equal(hasReadinessReconcileText('下一题（第 3 题，归属分类）：\nNEED_QUESTION {"question":"…"'), false, '仅下一题无对账 → false（触发宿主补发）');
assert.equal(hasReadinessReconcileText(undefined), false, '消息缺失 → false');
const fixtureMd = [
  '# User Readiness Review',
  '## Questions and Answers',
  '### 1. 内容类型枚举：新增内容类型的第一步',
  '**Type**: prediction',
  '**User answer**: 不确定——一起核对',
  '**Rule (revealed after answer)**: 内容类型集合开放，ContentTypeInterface 是唯一事实来源。',
  '**Reconciliation**: 用户未作预测，选择一起核对——规则已揭示：先扩展 ContentTypeInterface。',
  '**Decision**: accepted',
  '### 2. 显示标签：CHANNELCHECK 显示什么',
  '**Type**: prediction',
  '**User answer**: Pulse',
  '**Rule (revealed after answer)**: CHANNELCHECK → "Pulse"。',
  '**Reconciliation**: 用户预测 "Pulse"，与规则一致 → aligned。',
  '**Decision**: accepted',
  '### 3. 归属分类（尚未作答）',
  '**Type**: prediction'
].join('\n');
const reconc2 = lastAnsweredReconciliationOf(fixtureMd);
assert.ok(reconc2 !== null && reconc2.includes('显示标签：CHANNELCHECK') && reconc2.includes('用户预测 "Pulse"，与规则一致'), '取最后一题已作答的 Reconciliation（含小节标题与对账正文，正确预测题）');
assert.equal(lastAnsweredReconciliationOf('### 1. 未答\n**Type**: prediction\n'), null, '无任何已作答 → null');
assert.equal(lastAnsweredReconciliationOf(undefined), null, '文件缺失 → null');
const fixtureUnsure = '# UR\n## Questions and Answers\n### 1. 枚举\n**User answer**: 不确定——一起核对\n**Reconciliation**: 用户未作预测，选择一起核对——规则已揭示：先扩展 ContentTypeInterface，选项 3 为规则行为。\n**Decision**: accepted\n';
assert.ok(lastAnsweredReconciliationOf(fixtureUnsure)?.includes('未作预测，选择一起核对'), '「不确定——一起核对」作答同样有 Reconciliation → 兜底可处理');
assert.deepEqual(planKnowledgeAdvance('stop', 'propose', 'propose'), { action: 'close', reason: 'user-paused' }, '用户暂停 → 关闭（即使已 record）');
assert.deepEqual(
  planKnowledgeAdvance(null, 'propose', 'propose'),
  { action: 'dispatch', reason: 'file-truth' },
  '确认答案未提取到但状态文件已推进（record 生效）→ 按文件真相派发（本次事故回归）'
);
assert.deepEqual(
  planKnowledgeAdvance(null, 'explore', 'propose'),
  { action: 'close', reason: 'no-confirm-no-record' },
  '未确认且未 record → 关闭（附可见提示）'
);
assert.deepEqual(planKnowledgeAdvance(null, '', 'propose'), { action: 'close', reason: 'no-confirm-no-record' }, '状态文件读不到按未推进处理');

// 断点续跑：子代理工作阶段判定 + 续跑目标 + 续跑短指令
// knowledgeChildStageOf：只有子代理工作阶段有对应派发信息
assert.deepEqual(knowledgeChildStageOf('k_explore'), { pending: 'explore', role: 'explorer' }, 'k_explore → 探索者 explore');
assert.deepEqual(knowledgeChildStageOf('k_propose'), { pending: 'propose', role: 'explorer' }, 'k_propose → 探索者 propose');
assert.deepEqual(knowledgeChildStageOf('k_review'), { pending: 'review', role: 'challenger' }, 'k_review → 挑战者 review');
assert.deepEqual(knowledgeChildStageOf('k_readiness'), { pending: 'readiness', role: 'explorer' }, 'k_readiness → 探索者 readiness');
assert.equal(knowledgeChildStageOf('k_gate'), null, 'k_gate 是主代理交互阶段 → null');
assert.equal(knowledgeChildStageOf('k_ask'), null, 'k_ask 是主代理交互阶段 → null');
assert.equal(knowledgeChildStageOf('k_verdict'), null, 'k_verdict 是主代理交互阶段 → null');
assert.equal(knowledgeChildStageOf('k_init'), null, 'k_init 是主代理交互阶段 → null');
assert.equal(knowledgeChildStageOf('awaiting'), null, 'awaiting → null');
assert.equal(knowledgeChildStageOf('challenge'), null, 'business challenge 不属于 knowledge 映射 → null');

// knowledgeStageResumeOf（0.33.23）：Theseus 阶段 → 竞技场续跑目标（agent/created 自愈 + k_init 续跑共用）
assert.deepEqual(knowledgeStageResumeOf('explore'), { pending: 'explore', phase: 'k_explore', kStage: 'explore', role: 'explorer', templateKey: 'explorePrompt' }, 'explore → 探索者 explore');
assert.deepEqual(knowledgeStageResumeOf('propose'), { pending: 'propose', phase: 'k_propose', kStage: 'propose', role: 'explorer', templateKey: 'proposePrompt' }, 'propose → 探索者 propose');
assert.deepEqual(knowledgeStageResumeOf('review'), { pending: 'review', phase: 'k_review', kStage: '', role: 'challenger', templateKey: 'reviewPrompt' }, 'review → **挑战者**（本次卡点的目标）');
assert.deepEqual(knowledgeStageResumeOf('user-readiness-review'), { pending: 'readiness', phase: 'k_readiness', kStage: 'readiness', role: 'explorer', templateKey: 'readinessPrompt' }, 'user-readiness-review → 探索者 readiness');
assert.deepEqual(knowledgeStageResumeOf('apply'), { pending: null, phase: 'k_apply', kStage: '', role: null, templateKey: null }, 'apply → 主控者执行（不派子代理）');
assert.equal(knowledgeStageResumeOf('archive'), null, 'archive → 无需续跑');
assert.equal(knowledgeStageResumeOf('done'), null, 'done → 无需续跑');
assert.equal(knowledgeStageResumeOf(''), null, '空/未知 → null');
assert.equal(knowledgeStageResumeOf(undefined), null, 'undefined → null');

// childWorkOf：active + 阶段与 pendingDispatch 一致才返回续跑目标
assert.equal(childWorkOf({ active: false, phase: 'k_propose', pendingDispatch: 'propose', workflowId: 'w' }, true), null, '未开启 → null');
assert.deepEqual(
  childWorkOf({ active: true, phase: 'k_propose', pendingDispatch: 'propose', workflowId: 'w', scene: 'knowledge' }, true),
  { scene: 'knowledge', phase: 'k_propose', pending: 'propose', role: 'explorer', workflowId: 'w' },
  'knowledge k_propose 匹配 → 续跑探索者 propose'
);
assert.equal(
  childWorkOf({ active: true, phase: 'k_propose', pendingDispatch: 'review', workflowId: 'w', scene: 'knowledge' }, true),
  null,
  'pendingDispatch 与阶段不一致 → null'
);
assert.equal(
  childWorkOf({ active: true, phase: 'k_propose', pendingDispatch: 'propose', workflowId: '', scene: 'knowledge' }, true),
  null,
  'workflowId 为空（未绑定）→ null'
);
assert.equal(
  childWorkOf({ active: true, phase: 'k_gate', pendingDispatch: null, workflowId: 'w', scene: 'knowledge' }, true),
  null,
  'k_gate 不续跑（主代理交互阶段）'
);
assert.deepEqual(
  childWorkOf({ active: true, phase: 'challenge', pendingDispatch: 'challenge', scene: 'business' }, false),
  { scene: 'business', phase: 'challenge', pending: 'challenge', role: 'challenger', workflowId: '' },
  'business challenge 匹配 → 续跑挑战者'
);
assert.deepEqual(
  childWorkOf({ active: true, phase: 'verdict', pendingDispatch: 'verdict', scene: 'qa' }, false),
  { scene: 'qa', phase: 'verdict', pending: 'verdict', role: 'challenger', workflowId: '' },
  'qa verdict 匹配 → 续跑挑战者'
);
assert.equal(childWorkOf({ active: true, phase: 'answer', pendingDispatch: null, scene: 'business' }, false), null, 'answer 阶段不续跑');

// kickResumeText：续跑短指令自带阶段返回协议（不重发整份委派模板）
const tExplore = kickResumeText({ pending: 'explore', workflowId: 'w' });
assert.ok(tExplore.includes('theseus-explore') && tExplore.includes('STAGE_DONE explore CONFIRMED'), 'explore 续跑指令含协议行');
const tPropose = kickResumeText({ pending: 'propose', workflowId: 'w' });
assert.ok(tPropose.includes('theseus-propose') && tPropose.includes('STAGE_DONE propose ARTIFACTS_CREATED'), 'propose 续跑指令含协议行');
const tReview = kickResumeText({ pending: 'review', workflowId: 'w' });
assert.ok(tReview.includes('theseus-review-spec') && tReview.includes('Done'), 'review 续跑指令指向 Done');
const tReadiness = kickResumeText({ pending: 'readiness', workflowId: 'w' });
assert.ok(tReadiness.includes('STAGE_DONE user-readiness'), 'readiness 续跑指令含协议行');
const tChallenge = kickResumeText({ pending: 'challenge', workflowId: '' });
assert.ok(tChallenge.includes('质疑轮') && tChallenge.includes('续跑'), 'business challenge 续跑指令');
const tVerdict = kickResumeText({ pending: 'verdict', workflowId: '' });
assert.ok(tVerdict.includes('终评轮') && tVerdict.includes('续跑'), 'business verdict 续跑指令');

console.log('arena-v2 smoke OK');
