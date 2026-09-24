// dsh-plugin-context-xray — 宿主端 smoke 测试。
//
// 用假 ctx 与假会话直接跑注册与执行，不需要起 dsh web：
// 验证工具注册面、归因结构，以及报告里该有的段落。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMentions, split } from '../lib/mention.js';
import { apply } from '../lib/index.js';
import { renderReport } from '../lib/render.js';

/** 造一个只有注册面与会话查询的宿主上下文。 */
function fakeCtx(sessions = new Map()) {
  const registered = [];
  return {
    registered,
    tools: { register: (tool) => registered.push(tool) },
    sessions: { get: (id) => sessions.get(id) }
  };
}

/** 造一个只提供事件快照的会话。 */
function fakeSession(id, events) {
  return { id, snapshotEvents: () => events };
}

/** 一段能被 reasoning 引用的上下文文本。 */
const SYSTEM_TEXT = '上下文分析工具的归因口径与停用词过滤规则说明。';
const USER_TEXT = '请分析工具调用与上下文归因的关系。';
const INJECT_TEXT = '工作区指令要求报告必须包含来源占比与强度榜。';
const REASONING = '我需要先拆解上下文块，再看工具调用与归因口径，强度榜与来源占比都要给出来。工具结果也要统计。';
const RESULT_TEXT = '工具结果：上下文块归因完成，来源占比与强度榜已经生成。';

/** 造一段含两步、一次工具调用的最小会话事件流。 */
function fixture() {
  return [
    { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT }] } } },
    { type: 'request/header', seq: 1, data: { header: { tools: [{ name: 'bash', description: 'run a command' }, { name: 'read', description: 'read a file' }] } } },
    { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: USER_TEXT }] } },
    { type: 'user/message', seq: 3, data: { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: INJECT_TEXT }] } },
    { type: 'assistant/message', seq: 4, data: { usage: { inputTokens: 120, cacheReadTokens: 880, outputTokens: 40, reasoningTokens: 30 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: REASONING }, { type: 'tool-call', name: 'bash', arguments: '{"command":"ls 上下文"}' }] } } },
    { type: 'tool/call', seq: 5, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls 上下文"}' } },
    { type: 'tool/result', seq: 6, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: RESULT_TEXT }] }] } } },
    { type: 'assistant/message', seq: 7, data: { usage: { inputTokens: 150, cacheReadTokens: 1200, outputTokens: 20, reasoningTokens: 10 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: '来源占比已经够了，强度榜需要再核对工具结果的覆盖率。' }] } } },
    { type: 'request/context', seq: 8, data: { contextWindow: 500000, model: 'test-model' } }
  ];
}

test('split 把上下文按来源分类，注入与用户消息分开', () => {
  const report = analyzeMentions(fixture(), { matrixTerms: 10 });
  const kinds = report.blocks.map((block) => block.kind);
  assert.ok(kinds.includes('system'));
  assert.ok(kinds.includes('user'));
  assert.ok(kinds.includes('inject'));
  assert.ok(kinds.includes('tool-result'));
  assert.ok(kinds.includes('assistant'));
  assert.equal(report.totals.reasoning, 2);
  assert.equal(report.blocks.length, report.totals.blocks);
});

/** 造一条带指定 source.kind 的用户消息事件。 */
function injected(kind) {
  return { type: 'user/message', seq: 0, data: { role: 'user', source: { kind }, content: [{ type: 'text', text: '注入内容 widget' }] } };
}

/** 取一条注入事件拆出来的块标签。 */
function injectLabel(kind) {
  return split([injected(kind)]).blocks.find((block) => block.kind === 'inject')?.label;
}

test('注入块的展示名跟着生产者的 kind 走，未知插件剥前缀后仍能命中', () => {
  // dsh 0.1.7 的格式 v4 把「运行时快照」从退役的 { kind: 'plugin' } 包装改成裸名
  // runtime-context：不认这个键，报告里就会显示成「注入：runtime-context」。
  assert.equal(injectLabel('runtime-context'), '注入：运行时快照');
  assert.equal(injectLabel('agent-instructions'), '注入：工作区指令');
  assert.equal(injectLabel('tool-jobs'), '注入：后台任务通知');
  // 第三方插件的 kind 是 plugin:<包名>，熟键命中就给可读的名字。
  assert.equal(injectLabel('plugin:dsh-plugin-theseus-crew'), '注入：Theseus Crew 阶段指令');
  // 第一方 kind 被命名空间化时，剥前缀要能回落到已有标签。
  assert.equal(injectLabel('plugin:tool-jobs'), '注入：后台任务通知');
  // 不认识的插件：前缀保留——它标的是「第三方来源」，不是可有可无的装饰。
  assert.equal(injectLabel('plugin:dsh-plugin-unknown'), '注入：plugin:dsh-plugin-unknown');
  // 裸名不认识的原样展示。
  assert.equal(injectLabel('team-message'), '注入：team-message');
  // v4 之前的退役包装（离线入口读的 v3 日志里还在）不该退化。
  assert.equal(injectLabel('plugin'), '注入：运行时快照');
});

test('归因带出覆盖率与强度，且 reasoning 里提到的块命中不为零', () => {
  const report = analyzeMentions(fixture(), { matrixTerms: 10 });
  const user = report.blocks.find((block) => block.kind === 'user');
  assert.ok(user.covered > 0, '用户消息里的词应当被 reasoning 提到');
  assert.ok(user.coverage > 0 && user.coverage <= 1);
  assert.ok(user.intensity > 0);
  assert.equal(report.blocks.reduce((sum, block) => sum + block.rawHits, 0), report.totals.rawHits);
});

test('矩阵只保留真正被提及过的词', () => {
  const report = analyzeMentions(fixture(), { matrixTerms: 10 });
  assert.ok(report.matrix.length > 0);
  for (const entry of report.matrix) assert.ok(entry.total > 0, `${entry.term} 不该出现在矩阵里`);
});

test('renderReport 输出关键段落', () => {
  const text = renderReport(analyzeMentions(fixture(), { matrixTerms: 10 }), { minTerms: 1 });
  for (const heading of ['## 上下文 X 光', '### 来源占比', '### 强度榜', '### 时间分布', '### 关键词']) {
    assert.ok(text.includes(heading), `报告缺少 ${heading}`);
  }
  assert.ok(text.includes('提及度'), '报告必须声明这是提及度而非注意力');
});

test('块内只出现一次的词按半份计权，且不从词集里删除', () => {
  const events = [
    { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [{ type: 'text', text: 'widget' }] } } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'widget widget widget widget' }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  const system = report.blocks.find((block) => block.kind === 'system');
  assert.equal(system.rawHits, 4, '原始提及次数照常统计');
  assert.equal(system.weighted, 2, 'count=1 只算半份，df=1，故 4 × 0.5 = 2');
  // 关键回归：低频词必须留在词集里。删掉它会让小块的 terms 归零，
  // 整块被误判成「从未被提及」——实测会把死重清单从 4 个炸到 154 个。
  assert.equal(system.terms, 1);
  assert.equal(system.covered, 1);
});

test('矩阵按提及次数排序，并带上贡献最大的来源块', () => {
  const report = analyzeMentions(fixture(), { matrixTerms: 10 });
  const totals = report.matrix.map((entry) => entry.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), '矩阵必须按展示的提及列排序');
  for (const entry of report.matrix) {
    assert.ok(entry.sourceLabel !== null, `${entry.term} 缺少来源块`);
    assert.ok(entry.contextTotal > 0);
  }
});

test('最小跨度门槛随 reasoning 轮数缩放', () => {
  const build = (steps) => {
    const events = [{ type: 'system/message', seq: 0, data: { message: { role: 'system', content: [{ type: 'text', text: 'widget' }] } } }];
    for (let index = 0; index < steps; index += 1) {
      events.push({ type: 'assistant/message', seq: events.length, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'widget' }] } } });
    }
    return events;
  };
  // 固定门槛会在短会话里太严、长会话里太松，所以跟着轮数走。
  assert.equal(analyzeMentions(build(10), {}).totals.minSpan, 2);
  assert.equal(analyzeMentions(build(100), {}).totals.minSpan, 3);
  assert.equal(analyzeMentions(build(200), {}).totals.minSpan, 5);
});

test('跨度低于门槛的词不进矩阵', () => {
  const report = analyzeMentions(fixture(), { matrixTerms: 10 });
  assert.ok(report.totals.minSpan >= 2);
  for (const entry of report.matrix) {
    assert.ok(entry.blocks >= report.totals.minSpan, `${entry.term} 跨度 ${entry.blocks} 低于门槛 ${report.totals.minSpan}`);
  }
  assert.ok(report.totals.skippedBySpan >= 0);
});

test('体积用真实 usage 校准，累计把每步重发的固定成本算进去', () => {
  const report = analyzeMentions(fixture(), { matrixTerms: 10 });
  // 末次锚点：input 150 + cacheRead 1200。
  assert.equal(report.totals.realPrompt, 1350);
  assert.equal(report.totals.occupancy, 1350 / 500000);
  const system = report.blocks.find((block) => block.kind === 'system');
  assert.ok(system.tokens > 0, '系统提示词应当有体积');
  // 两个锚点都包含它 → 累计至少是体积的两倍。
  assert.ok(system.cumulative >= system.tokens * 2, `累计 ${system.cumulative} 应远大于体积 ${system.tokens}`);
  assert.ok(report.totals.cumulativeTokens > 0);
});

test('抓出用户说了、但那一轮从没提过的词', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'check widget and gadget' }] } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'widget needs a look' }, { type: 'text', text: 'widget looked at' }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  assert.equal(report.unclosed.length, 1);
  // widget 在 reasoning 与答复里都出现过；check / gadget 一次都没有。
  assert.deepEqual(report.unclosed[0].terms.map((item) => item.word), ['check', 'gadget']);
  assert.ok(report.unclosed[0].terms[0].sentence.includes('check'), '必须带原句，否则判不了');
});

test('只算当轮窗口：下一轮提到过也不算闭合', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the widget thing' }] } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'unrelated musing' }, { type: 'text', text: 'ok' }] } } },
    { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'anything else' }] } },
    { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'widget widget widget' }, { type: 'text', text: 'widget done' }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  const first = report.unclosed.find((entry) => entry.index === 0);
  assert.ok(first !== undefined, '第一条消息的 widget 不该被下一轮洗白');
  assert.ok(first.terms.some((item) => item.word === 'widget'));
});

test('URL 碎片不算遗漏', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'page https://stg.example.pro/project widget broken' }] } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'broken widget on the page' }, { type: 'text', text: 'page checked' }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  const words = report.unclosed.flatMap((entry) => entry.terms.map((item) => item.word));
  assert.ok(!words.includes('https'));
  assert.ok(!words.includes('example'));
  assert.ok(!words.includes('stg'));
});

test('回复里上下文没有的标识符会被列出来', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'the widget is broken' }] } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'widget needs a fix' }, { type: 'text', text: 'widget fixed. see spec v2.1 and config.widgetTimeout.' }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  const words = report.inactive.flatMap((entry) => entry.terms.map((item) => item.word));
  assert.ok(words.some((word) => /v2\.1|widgetTimeout/u.test(word)), '上下文里没有的标识符该被列出');
  assert.ok(report.inactive[0].terms.every((item) => item.sentence !== ''), '每条都要带原句');
});

test('纯措辞不算无出处标识符', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'the widget is broken' }] } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'looking' }, { type: 'text', text: "I'll dig into it. Verified, and the caveat stands." }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  // 实测这类的量级：一个会话里 121 个词级标记，绝大多数就是这种措辞。
  assert.equal(report.inactive.length, 0, 'dig / Verified / caveat 这类措辞不该报');
});

test('引用上下文里已有的词不算不活跃', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'warning says consultations are blocked' }] } },
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, reasoningTokens: 2 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'checking' }, { type: 'text', text: 'consultations are blocked.' }] } } }
  ];
  const report = analyzeMentions(events, { matrixTerms: 5 });
  assert.equal(report.inactive.length, 0, '引用用户原文里的词不该被判为不活跃');
});

test('apply 注册 context_xray，执行返回报告文本', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal(ctx.registered.length, 1);
  const tool = ctx.registered[0];
  assert.equal(tool.name, 'context_xray');

  const session = fakeSession('session-test', fixture());
  const text = await tool.execute({ minTerms: 1 }, { agent: { session } });
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('session-test'));
  assert.ok(text.includes('### 来源占比'));
});

test('显式指定未知会话时给出可操作的错误', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const tool = ctx.registered[0];
  await assert.rejects(() => tool.execute({ session: 'session-missing' }, {}), /没有 id 为 "session-missing"/);
});

test('没有所属 agent 也没有 session 参数时拒绝执行', async () => {
  const ctx = fakeCtx();
  apply(ctx);
  await assert.rejects(() => ctx.registered[0].execute({}, {}), /需要一个所属 agent 会话/);
});

test('指定活跃会话时分析的是那个会话', async () => {
  const other = fakeSession('session-other', fixture());
  const ctx = fakeCtx(new Map([['session-other', other]]));
  apply(ctx);
  const text = await ctx.registered[0].execute({ session: 'session-other', minTerms: 1 }, {});
  assert.ok(text.includes('session-other'));
});
