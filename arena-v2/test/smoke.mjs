// arena-v2 smoke test: verify module loads, defaults are correct, and the
// section-text gating logic behaves (arena mode / subagent / disabled).
import assert from 'node:assert/strict';
import {
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
assert.ok(knPersonas.mainPersona.includes('Knowledge Expert'), 'knowledge 主代理默认不同');
assert.ok(knPersonas.challengerPrompt.includes('审查者'), 'knowledge 挑战者默认不同');
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
// 多源检索指引：目前只注入业务探索（business）；knowledge / qa 默认不注入
assert.equal(defaults.sceneSearchGuide.business, DEFAULT_SEARCH_GUIDE, 'business 默认注入多源检索指引');
assert.equal(defaults.sceneSearchGuide.knowledge, '', 'knowledge 默认不注入');
assert.equal(defaults.sceneSearchGuide.qa, '', 'qa 默认不注入');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('mcp__jira'), '指引含 Jira MCP 工具');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('git log'), '指引含 git 检索');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('openspec'), '指引含 openspec 检索');
assert.ok(DEFAULT_SEARCH_GUIDE.includes('代码库'), '指引含代码库检索');
assert.ok(!('targetPresets' in defaults), 'targetPresets 已移除（与预设无关）');

// ── 终评「仍存疑」→ 询问用户是否再来一轮（不计轮次、不设上限）─────────────
// 终评结论标记：模板要求最后单独一行输出 `结论：认可` / `结论：仍存疑`
assert.ok(DEFAULT_VERDICT_PROMPT.includes('结论：认可'), '终评轮要求输出认可结论标记');
assert.ok(DEFAULT_VERDICT_PROMPT.includes('结论：仍存疑'), '终评轮要求输出仍存疑结论标记');
assert.ok(scenePersonasOf({}, 'qa').verdictPrompt.includes('结论：通过'), 'qa 终验轮标记为通过');
assert.ok(scenePersonasOf({}, 'knowledge').verdictPrompt.includes('结论：认可'), 'knowledge 终审轮也有结论标记');

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

console.log('arena-v2 smoke OK');
