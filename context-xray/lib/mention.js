// dsh-plugin-context-xray — 提及归因核心。
//
// 思路：拿不到 attention，就用「这块上下文里的词，在我的 reasoning 里被提到
// 了多少次」做代理。三步：
//   1. 把会话拆成上下文块（系统提示词 / 各类注入 / 用户消息 / 工具结果）与
//      reasoning 块（每个 assistant 步骤一段）。
//   2. 对每块分词、去停用词，得到该块的词集。
//   3. 统计这些词在各 reasoning 块里的出现次数。
//
// 两个指标的口径差别很大，不能混用：
//   - rawHits（原始提及次数）有严重长度偏置：11,798 字符的系统提示词天然压过
//     41 字符的用户消息。它只能当「总声量」看。
//   - intensity（每词平均加权提及次数）做了长度归一化，才是接近「注意力」的那个
//     数。本仓库实测：用户消息 8.3，AGENTS.md 1.8，系统提示词 0.94。
//   - coverage（多少比例的词被提到过）用来发现「整块内容从没被用上」。
//
// 已知天花板：reasoning 是自然语言生成物，它反映的是「我在思考时提到了什么」，
// 不是「我在计算时看了什么」。任务主题会强烈影响结果——分析上下文的任务里，
// 上下文类词汇天然高频。这不是注意力测量。

import { keep } from './stopwords.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * 中英混合分词并过滤停用词。
 * @param text - 原文。
 * @param options - 可选 { minLength, stopwords }，stopwords 为追加排除表。
 * @returns 保留下来的词数组（含重复）。
 */
export function terms(text, options = {}) {
  const minLength = options.minLength ?? 2;
  const extra = options.stopwords;
  const out = [];
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue;
    const word = part.segment;
    if (!keep(word, minLength)) continue;
    if (extra?.has(word.toLowerCase())) continue;
    out.push(word);
  }
  return out;
}

/** 上下文块的展示名。注入类必须与用户自己发的消息分开，否则归因会说谎。 */
const INJECTION_LABELS = {
  'session-reference': '注入：会话引用快照',
  'agent-instructions': '注入：工作区指令',
  'skill-catalog': '注入：技能目录',
  plugin: '注入：运行时快照'
};

/** @returns 单行预览，用于区分同名的块（三个「工具结果：bash」得能分辨）。 */
function preview(text) {
  const flat = text
    .replace(/\s+/g, ' ')
    .trim()
    // 绝对路径前缀又长又没区分度（每个 bash 入参都以 cd /Users/… 开头），
    // 折叠掉才能让真正有辨识度的部分挤进那几十个字符。
    .replace(/\/Users\/[^/\s"]+/g, '~')
    .replace(/\/opt\/homebrew\/lib\/node_modules\/@deepseek-ai\//g, '@deepseek-ai/');
  return flat.length > 44 ? `${flat.slice(0, 44)}…` : flat;
}

/**
 * 判定一个词是不是「可核对的 token」——标识符、路径、版本号、字段名、数字。
 *
 * 回复侧只查这一类，是因为词级匹配实测不可用：某会话里「我写过但上下文没有」的词有
 * 121 个，绝大多数是我写报告时的措辞（`dig` / `verified` / `实证` / `核实`），不是断言；
 * 收窄到可核对 token 后剩 3 个，且全是我在回复里精确拼出的标识符
 * （`cognolink.client.ComplianceApproval` / `config.serverName` / `String.replace`）——
 * 这些才是「上下文里没有这个写法、需要核对」的东西。
 * @param word - 分词结果。
 * @returns 是否属于可核对 token。
 */
function checkableToken(word) {
  if (word.length < 3) return false;
  if (!/[A-Za-z]/.test(word)) return false;
  if (/^[A-Za-z]+['’][A-Za-z]+$/u.test(word)) return false; // 英文缩写不是标识符
  return /[./:_-]|\d/.test(word);
}

/**
 * 把文本切成句子。中英混排：中文按句末标点切，英文按换行切（英文句点同时也是
 * 文件名和版本号的一部分，按它切会把 `project-management.jsx` 切碎）。
 * @param text - 原文。
 * @returns 句子数组。
 */
function sentences(text) {
  return text
    .split(/(?<=[。！？!?])\s*|\n+/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 找出包含某个词的第一句原文。只给一个光秃秃的词，读的人无法判断它算不算遗漏；
 * 给回原句才能一眼看出这句话到底有没有被处理。
 * @param text - 该词所在的块原文。
 * @param word - 目标词。
 * @param max - 原句的显示上限，默认 120 字符。
 * @returns 原句（必要时截断）。
 */
function sentenceWith(text, word, max = 120) {
  const found = sentences(text).find((line) => line.includes(word));
  if (found === undefined) return '';
  return found.length > max ? `${found.slice(0, max)}…` : found;
}

/**
 * 去掉用户消息里的 URL 与裸域名。它们分词后是「https」「stg」「tbeng」这类碎片，
 * 在遗漏判据里全是噪音；而「在哪个环境操作的」这件事并不靠这些碎片承载。
 * @param text - 原文。
 * @returns 去掉 URL 后的文本。
 */
function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/giu, ' ').replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|pro|net|org|io|cn|dev|test)\b/giu, ' ');
}

/**
 * 词在块内出现次数对应的归因权重。
 *
 * 出现一次时只算半份：通用词常常在某个块里偶现一次，却在 reasoning 里高频出现
 * （实测 `logic` 只在 1 个块里出现 1 次、被提及 102 次），全额计入会凭空造出一个
 * 高强度块。
 *
 * 这里刻意用**折扣**而不是**过滤**：把低频词从词集里删掉会同时缩小分母，让短块
 * 的 terms 变成 0，于是整块被误判成「从未被提及」——实测那样会把死重清单从 4 个
 * 炸到 154 个，连会话起因那条用户消息都被算了进去。
 * @param count - 该词在本块内的出现次数。
 * @returns 折减系数，落在 0.5 到 1 之间。
 */
function occurrenceWeight(count) {
  return count / (count + 1);
}

/** 每 token 对应的字符数。中文与英文/JSON 的字形密度差一倍以上。 */
const CJK_PER_TOKEN = 1.2;
const OTHER_PER_TOKEN = 4;

const CJK_RANGES = [
  [0x3000, 0x303f],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef]
];

/** @returns whether the code point is a CJK character or CJK punctuation. */
function isCjk(code) {
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/**
 * 按字符密度估算一段文本的 token 数。
 *
 * 这是「体积」这把尺子，和「提及度」那把是独立的两条：体积按字符密度算，提及按
 * 词频算。两条尺子都用同一步的真实 `usage` 校准到同一批块上，所以它们可以在
 * 同一张表里并列读——「同样体积，谁被想得多」。
 * @param text - 待估算文本。
 * @returns 估算 token 数（含块结构开销）。
 */
function priceText(text) {
  let cjk = 0;
  for (const char of text) if (isCjk(char.codePointAt(0))) cjk += 1;
  return Math.ceil(cjk / CJK_PER_TOKEN + (text.length - cjk) / OTHER_PER_TOKEN) + 4;
}

/**
 * 把事件流拆成上下文块与 reasoning 块，并记录体积校准所需的两样东西。
 * @param events - 按 seq 升序的会话事件。
 * @returns { blocks, reasoning, surface, anchors, contextWindow }。surface 是完整的
 * 请求面（含 reasoning——它会被回传进后续请求，同样计费），anchors 是每一步的真实
 * prompt 规模。
 */
export function split(events) {
  const callNames = new Map();
  for (const event of events) if (event?.type === 'tool/call') callNames.set(event.data?.callId, event.data?.name);

  const blocks = [];
  const reasoning = [];
  const surface = [];
  const anchors = [];
  let contextWindow = null;
  let step = 0;
  /** 块与请求面必须同序推进，否则体积会记到别人的头上。 */
  const pushBlock = (entry) => {
    entry.price = priceText(entry.text);
    entry.position = surface.length;
    surface.push({ index: blocks.length, price: entry.price });
    blocks.push(entry);
  };

  for (const event of events) {
    const data = event?.data ?? {};
    if (event?.type === 'request/context') {
      if (typeof data.contextWindow === 'number') contextWindow = data.contextWindow;
      continue;
    }
    if (event?.type === 'system/message') {
      const text = (data.message?.content ?? []).map((block) => block.text ?? '').join('');
      if (text !== '') pushBlock({ kind: 'system', label: '系统提示词', text });
      continue;
    }
    if (event?.type === 'user/message') {
      const source = data.source?.kind ?? 'user';
      const text = (data.content ?? []).map((block) => block.text ?? '').join('');
      if (text === '') continue;
      if (source === 'user') pushBlock({ kind: 'user', label: '用户消息', text });
      else pushBlock({ kind: 'inject', label: INJECTION_LABELS[source] ?? `注入：${source}`, text });
      continue;
    }
    if (event?.type === 'tool/result') {
      const name = callNames.get(data.message?.source?.callId) ?? '?';
      const text = (data.message?.content ?? []).flatMap((block) => (block.content ?? []).map((inner) => inner.text ?? '')).join('');
      if (text !== '') pushBlock({ kind: 'tool-result', label: `工具结果：${name}`, text });
      continue;
    }
    if (event?.type === 'assistant/message') {
      // usage 描述的是「生成这条回复时送进去的 prompt」，所以锚点必须在把本条
      // 回复的内容计入请求面之前记录。
      if (data.usage) {
        step += 1;
        anchors.push({
          step,
          real: (data.usage.inputTokens ?? 0) + (data.usage.cacheReadTokens ?? 0),
          count: surface.length
        });
      }
      for (const block of data.message?.content ?? []) {
        if (block?.type === 'reasoning') {
          const text = block.text ?? '';
          reasoning.push({ step, text, position: surface.length });
          surface.push({ price: priceText(text) });
        }
        // 我自己写进上下文的工具入参与回复正文也算上下文的一部分。
        else if (block?.type === 'tool-call' && block.arguments) pushBlock({ kind: 'assistant', label: `工具入参：${block.name ?? '?'}`, text: block.arguments });
        else if (block?.type === 'text' && block.text) pushBlock({ kind: 'assistant', label: '回复正文', text: block.text });
      }
      continue;
    }
  }
  // 同名块（三个「工具结果：bash」）靠预览区分，否则报告里分不清谁是谁。
  for (const [index, block] of blocks.entries()) {
    block.preview = preview(block.text);
    block.index = index;
  }
  return { blocks, reasoning, surface, anchors, contextWindow };
}

/**
 * 计算提及归因。
 * @param events - 按 seq 升序的会话事件。
 * @param options - 可选 { minLength, stopwords, matrixTerms }。
 * @returns 报告：逐块归因、逐步骤时间分布、原始提及矩阵。
 */
export function analyzeMentions(events, options = {}) {
  const matrixTerms = options.matrixTerms ?? 40;
  const { blocks, reasoning, surface, anchors, contextWindow } = split(events);
  // 归因力的最小跨度门槛随会话规模缩放。跨度 = 这个词出现在多少个块里，而
  // 「归因力 = min(提及, 上下文) ÷ 跨度」在跨度为 1–2 时样本太小、容易被抬到榜首
  // （实测 `客户` 提及 190、只出现在 1 个块里，归因力 7.00 排第一）。
  // 门槛不写死是因为会话越长块越多：同样的 3，在 100 块的会话里已经算常见，
  // 在 600 块的会话里则是偶发共现。
  const minSpan = options.minSpan ?? Math.max(2, Math.round(reasoning.length / 40));

  // 体积校准：每一步的 scale = 该步真实 prompt ÷ 请求面的启发式估算。真实规模来自
  // provider（inputTokens + cacheReadTokens），单看 inputTokens 会漏掉命中缓存那块。
  const prefix = [0];
  for (const item of surface) prefix.push(prefix.at(-1) + item.price);
  const blockCost = new Array(blocks.length).fill(0);
  let tokenScale = 1;
  for (const anchor of anchors) {
    const heuristic = prefix[anchor.count];
    tokenScale = heuristic > 0 ? anchor.real / heuristic : 1;
    for (let position = 0; position < anchor.count; position += 1) {
      const item = surface[position];
      if (item.index !== undefined) blockCost[item.index] += item.price * tokenScale;
    }
  }
  const realPrompt = anchors.at(-1)?.real ?? 0;

  const blockTerms = blocks.map((block) => {
    const counts = new Map();
    for (const word of terms(block.text, options)) counts.set(word, (counts.get(word) ?? 0) + 1);
    return counts;
  });
  const stepCounts = reasoning.map((entry) => ({ step: entry.step, counts: terms(entry.text, options).reduce((map, word) => map.set(word, (map.get(word) ?? 0) + 1), new Map()) }));

  // df：一个词出现在多少个上下文块里。跨块共享的词按出现块数分摊，避免同一个词
  // 在每块里都被记一次全功。
  const df = new Map();
  for (const map of blockTerms) for (const word of map.keys()) df.set(word, (df.get(word) ?? 0) + 1);

  const series = blocks.map(() => new Array(reasoning.length).fill(0));
  for (const [index, map] of blockTerms.entries()) {
    for (const [word, count] of map) {
      const share = occurrenceWeight(count) / df.get(word);
      for (const [position, entry] of stepCounts.entries()) {
        const hits = entry.counts.get(word) ?? 0;
        if (hits > 0) series[index][position] += hits * share;
      }
    }
  }

  // 每个词由哪一块贡献最多——矩阵要靠它把「词」和「块」接起来。
  const termTop = new Map();
  const rows = blocks.map((block, index) => {
    const map = blockTerms[index];
    let rawHits = 0;
    let weighted = 0;
    let covered = 0;
    for (const [word, count] of map) {
      let wordHits = 0;
      for (const entry of stepCounts) wordHits += entry.counts.get(word) ?? 0;
      if (wordHits > 0) covered += 1;
      rawHits += wordHits;
      const contribution = (wordHits * occurrenceWeight(count)) / df.get(word);
      weighted += contribution;
      const best = termTop.get(word);
      if (best === undefined || contribution > best.weight) termTop.set(word, { index, weight: contribution });
    }
    const termCount = map.size;
    return {
      index,
      kind: block.kind,
      label: block.label,
      preview: block.preview,
      chars: block.text.length,
      // 体积两列：tokens 是最终快照里这块的规模，cumulative 是整个会话为它付的
      // 总账（每步重发一次，所以固定成本类的内容累计远大于快照）。
      tokens: Math.round((block.price ?? 0) * tokenScale),
      cumulative: Math.round(blockCost[index]),
      terms: termCount,
      covered,
      coverage: termCount === 0 ? 0 : covered / termCount,
      rawHits,
      perTerm: termCount === 0 ? 0 : rawHits / termCount,
      weighted: Math.round(weighted * 10) / 10,
      // 主指标：df 加权后按词数归一化，长度偏置因此被消掉。
      intensity: termCount === 0 ? 0 : weighted / termCount,
      series: series[index]
    };
  });

  const totalIntensity = rows.reduce((sum, row) => sum + row.intensity, 0);
  for (const row of rows) row.share = totalIntensity === 0 ? 0 : row.intensity / totalIntensity;

  // 原始矩阵：只保留真正被提及过的词，避免把整个词表倒出来。
  // 排序键必须与展示的「提及」列一致——曾经按词在上下文块里的出现次数排序，
  // 结果代码里的 `const` 因为满屏都是而排第一，可它只被提及 1 次。
  const totals = new Map();
  for (const map of blockTerms) for (const [word, count] of map) totals.set(word, (totals.get(word) ?? 0) + count);
  const scored = [];
  let skippedBySpan = 0;
  for (const [word, contextTotal] of totals) {
    const row = stepCounts.map((entry) => entry.counts.get(word) ?? 0);
    const total = row.reduce((sum, hits) => sum + hits, 0);
    if (total === 0) continue;
    const blockCount = df.get(word) ?? 0;
    // 跨度太低 = 样本太少，归因力的分母接近 1，会被抬成假冠军。
    if (blockCount < minSpan) {
      skippedBySpan += 1;
      continue;
    }
    const source = termTop.get(word);
    scored.push({
      term: word,
      blocks: blockCount,
      contextTotal,
      total,
      series: row,
      // 归因力：这个词能不能指向具体的块。分子取提及与上下文的较小者——只看提及
      // 会被口头词骗（`check` 提及 91 次 > 上下文 69 次），只看上下文会被填充词骗
      // （`id` 上下文 751 次但散在 198 个块里）；分母是跨度，越集中越有指向性。
      attribution: Math.min(total, contextTotal) / Math.max(blockCount, 1),
      sourceLabel: source ? blocks[source.index].label : null,
      sourcePreview: source ? blocks[source.index].preview : null,
      sourceIndex: source ? source.index : -1
    });
  }
  scored.sort((a, b) => b.total - a.total || a.term.localeCompare(b.term));
  const matrix = scored.slice(0, matrixTerms);

  const steps = stepCounts.map((entry, position) => {
    const top = rows.filter((row) => row.series[position] > 0).sort((a, b) => b.series[position] - a.series[position]).slice(0, 3).map((row) => ({ label: row.label, hits: Math.round(row.series[position] * 10) / 10 }));
    return { step: entry.step, chars: reasoning[position].text.length, terms: entry.counts.size, top };
  });

  // 未闭合的用户输入：你说了、但在**那一轮**的 reasoning 与答复里都没出现过的词。
  // 窗口按「这条用户消息到下一条用户消息之间」取，不是整个会话——否则后面几轮
  // 提到过就算覆盖了，前面被丢掉的要求会被洗白。
  //
  // 这是日志层面唯一能算出来的遗漏类型。算不出来的两类：「想过、答了、但没做到」
  // 没有可数痕迹；「该查而根本没查」连上下文都没进。
  const unclosed = [];
  const userBlocks = blocks.filter((block) => block.kind === 'user');
  for (const [order, block] of userBlocks.entries()) {
    const from = block.position;
    const to = userBlocks[order + 1]?.position ?? Number.POSITIVE_INFINITY;
    const spoken = new Set();
    for (const entry of reasoning) {
      if (entry.position > from && entry.position < to) for (const word of terms(entry.text, options)) spoken.add(word);
    }
    for (const other of blocks) {
      if (other.position <= from || other.position >= to) continue;
      if (other.kind !== 'assistant' || other.label !== '回复正文') continue;
      for (const word of terms(other.text, options)) spoken.add(word);
    }
    const cleaned = stripUrls(block.text);
    const missing = [...new Set(terms(cleaned, options))]
      .filter((word) => !spoken.has(word))
      .map((word) => ({ word, sentence: sentenceWith(cleaned, word) }));
    if (missing.length > 0) unclosed.push({ index: block.index, label: block.label, preview: block.preview, terms: missing });
  }

  // 回复侧的「无出处标识符」：我写了、但此前的 reasoning 与上下文里都没有这个写法的
  // 可核对 token（标识符 / 路径 / 版本 / 行号）。纯措辞不查——见 checkableToken。
  //
  // 「有出处」按**当时之前**算：后面某个工具结果里出现过，不能反过来给先前那句话背书。
  const inactive = [];
  const stream = [
    ...blocks.map((block) => ({ position: block.position, block })),
    ...reasoning.map((entry) => ({ position: entry.position, entry }))
  ].sort((a, b) => a.position - b.position);
  const seenSoFar = new Set();
  for (const item of stream) {
    if (item.entry !== undefined) {
      for (const word of terms(item.entry.text, options)) seenSoFar.add(word);
      continue;
    }
    const block = item.block;
    if (block.kind === 'assistant' && block.label === '回复正文') {
      const stray = [...new Set(terms(block.text, options))]
        .filter((word) => checkableToken(word) && !seenSoFar.has(word))
        .map((word) => ({ word, sentence: sentenceWith(block.text, word) }));
      if (stray.length > 0) inactive.push({ index: block.index, label: block.label, preview: block.preview, terms: stray });
      continue;
    }
    // 上下文块与工具入参都算「已经出现过」——只有我自己的回复正文要被检查。
    for (const word of terms(block.text, options)) seenSoFar.add(word);
  }

  return {
    totals: {
      blocks: rows.length,
      reasoning: reasoning.length,
      distinctTerms: totals.size,
      minSpan,
      skippedBySpan,
      realPrompt,
      tokenScale,
      occupancy: contextWindow === null ? null : realPrompt / contextWindow,
      cumulativeTokens: blockCost.reduce((sum, value) => sum + value, 0),
      rawHits: rows.reduce((sum, row) => sum + row.rawHits, 0),
      weighted: Math.round(rows.reduce((sum, row) => sum + row.weighted, 0) * 10) / 10
    },
    blocks: [...rows].sort((a, b) => b.intensity - a.intensity),
    steps,
    matrix,
    unclosed,
    inactive
  };
}
