// dsh-plugin-context-xray — 报告渲染（tool 与离线 CLI 共用）。
//
// 可读性优先：
//   - 时间轴按桶压缩到固定宽度，否则 180+ 步的 sparkline 一行能到 240 字符、终端里折行
//   - 时序类信息走表格（前/中/后占比 + 峰值步），比让人读一整行符号可靠
//   - 每个块带稳定编号，三个「工具结果：bash」才分得清、也才好互相引用
//   - 重复块合并计数，5 条空参数的 list_agents 不该占 5 行
//
// 所有视图都有条数上限，因为这份文本会进入模型的上下文。

/** 中文按两字符宽计，用于终端对齐。 */
function width(text) {
  let total = 0;
  for (const char of text) total += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  return total;
}

/** @returns 按显示宽度补齐的单元格。 */
export function cell(text, target, align = 'left') {
  const gap = ' '.repeat(Math.max(0, target - width(text)));
  return align === 'left' ? text + gap : gap + text;
}

/** @returns 表格行。 */
function row(cells, widths, aligns = []) {
  return '| ' + cells.map((text, index) => cell(text, widths[index], aligns[index] ?? 'left')).join(' | ') + ' |';
}

/** @returns 分隔行。 */
function divider(widths, aligns = []) {
  return '|' + widths.map((size, index) => (aligns[index] === 'right' ? '-'.repeat(size + 1) + ':' : ':' + '-'.repeat(size + 1))).join('|') + '|';
}

/** @returns 一串数字压成单行 sparkline。 */
export function sparkline(values) {
  const glyphs = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values.map((value) => (value === 0 ? '·' : glyphs[Math.min(glyphs.length - 1, Math.round((value / max) * (glyphs.length - 1)))])).join('');
}

/**
 * 把一条按步的序列压成固定桶数，每桶取最大值（保留峰值特征）。
 * @param series - 逐步命中数。
 * @param buckets - 目标宽度，默认 48。
 * @returns 压缩后的序列。
 */
function compress(series, buckets = 48) {
  if (series.length <= buckets) return series;
  const size = series.length / buckets;
  const out = [];
  for (let index = 0; index < buckets; index += 1) {
    const from = Math.floor(index * size);
    const to = Math.max(from + 1, Math.floor((index + 1) * size));
    out.push(Math.max(...series.slice(from, to)));
  }
  return out;
}

/** @returns 序列在早/中/晚三段的占比。 */
function stages(series) {
  const total = series.reduce((sum, value) => sum + value, 0);
  if (total === 0) return [0, 0, 0];
  const third = Math.ceil(series.length / 3);
  return [series.slice(0, third), series.slice(third, third * 2), series.slice(third * 2)].map((part) => part.reduce((sum, value) => sum + value, 0) / total);
}

/** @returns 峰值所在的步号，全零时返回 null。 */
function peakStep(series) {
  let best = 0;
  for (let index = 1; index < series.length; index += 1) if (series[index] > series[best]) best = index;
  return series[best] === 0 ? null : best + 1;
}

/**
 * 找出持续够长的主导段。逐步比较会产生上百次抖动，只有成段的主导才有解释价值。
 * @param steps - 报告的 steps。
 * @param minLength - 一段至少持续多少步，默认 4。
 * @returns 段落数组。
 */
function dominantRuns(steps, minLength = 4) {
  const runs = [];
  let current = null;
  for (const step of steps) {
    const lead = step.top[0]?.label ?? '（无）';
    if (current !== null && current.label === lead) {
      current.end = step.step;
      current.length += 1;
      continue;
    }
    if (current !== null) runs.push(current);
    current = { label: lead, start: step.step, end: step.step, length: 1 };
  }
  if (current !== null) runs.push(current);
  return runs.filter((run) => run.length >= minLength);
}

/** @returns 占比条。 */
function bar(share, size = 24) {
  return '█'.repeat(Math.max(1, Math.round(share * size)));
}

/** @returns 按显示宽度截断的文本。 */
function truncate(text, max) {
  if (width(text) <= max) return text;
  let out = '';
  for (const char of text) {
    if (width(out + char) > max - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** @returns 块的显示名：稳定编号 + 标签 + 预览。编号让同名块可区分、可引用。 */
function blockName(block, max = 46) {
  const preview = block.preview ?? '';
  const body = preview === '' ? block.label : `${block.label} · ${preview}`;
  return truncate(`#${block.index + 1} ${body}`, max);
}

/**
 * 渲染「命中词 + 原句」两行结构。只给光秃秃的词，读的人判不了它算不算真问题；
 * 给回它所在的原句才能一眼确认。
 * @param entries - [{ index, label, preview, terms: [{ word, sentence }] }]。
 * @param limit - 最多渲染几条消息。
 * @returns 行数组。
 */
function termLines(entries, limit) {
  const out = [];
  for (const entry of entries.slice(0, limit)) {
    out.push(`- ${blockName(entry, 46)}`);
    for (const item of entry.terms) out.push(`  - \`${item.word}\`${item.sentence === '' ? '' : ` ← ${item.sentence}`}`);
  }
  return out;
}

/** 类别汇总：把逐块结果折成来源类别，三个口径各算一份占比。 */
function kindSummary(blocks) {
  const byKind = new Map();
  for (const block of blocks) {
    const entry = byKind.get(block.kind) ?? { kind: block.kind, blocks: 0, chars: 0, weighted: 0, rawHits: 0, tokens: 0, cumulative: 0 };
    entry.blocks += 1;
    entry.chars += block.chars;
    entry.weighted += block.weighted;
    entry.rawHits += block.rawHits;
    entry.tokens += block.tokens ?? 0;
    entry.cumulative += block.cumulative ?? 0;
    byKind.set(block.kind, entry);
  }
  const rows = [...byKind.values()];
  const mentionTotal = rows.reduce((sum, entry) => sum + entry.weighted, 0) || 1;
  const tokenTotal = rows.reduce((sum, entry) => sum + entry.tokens, 0) || 1;
  const cumulativeTotal = rows.reduce((sum, entry) => sum + entry.cumulative, 0) || 1;
  return rows
    .sort((a, b) => b.cumulative - a.cumulative)
    .map((entry) => ({ ...entry, mentionShare: entry.weighted / mentionTotal, tokenShare: entry.tokens / tokenTotal, cumulativeShare: entry.cumulative / cumulativeTotal }));
}

/**
 * 渲染完整报告。
 * @param report - analyzeMentions() 的结果。
 * @param options - { limit, matrix, dead, minTerms, title, buckets }。
 * @returns markdown 文本。
 */
export function renderReport(report, options = {}) {
  const limit = options.limit ?? 12;
  const matrixLimit = options.matrix ?? 10;
  const deadLimit = options.dead ?? 8;
  const buckets = options.buckets ?? 40;
  // 词数太少的块，每词均值天然虚高（9 个词的用户消息能拿 6.0），
  // 所以强度榜设一个门槛，否则榜单在奖励「词少」。
  const minTerms = options.minTerms ?? 20;
  const lines = [];
  const steps = report.totals.reasoning;

  lines.push(`## 上下文 X 光${options.title ? ` · ${options.title}` : ''}`);
  lines.push('');
  lines.push(`${report.totals.blocks} 个上下文块 · ${steps} 段 reasoning · 去重有效词 ${report.totals.distinctTerms} 个 · 原始提及 ${report.totals.rawHits} 次`);
  const occupancy = report.totals.occupancy;
  lines.push(`末次 prompt ≈ ${report.totals.realPrompt.toLocaleString('en-US')} tokens${occupancy === null ? '' : `（窗口占用 ${(occupancy * 100).toFixed(2)}%）`} · 全程累计 ≈ ${Math.round(report.totals.cumulativeTokens).toLocaleString('en-US')} tokens`);
  lines.push('');
  lines.push('> **提及度，不是注意力**：统计的是 reasoning 里提到了什么，不是计算时看了什么。任务主题会显著影响结果。');
  lines.push('>');
  lines.push('> 归因折扣：词在块内出现一次只算半份证据——通用词常在某个块里偶现一次，却被我反复使用。');
  lines.push('');

  lines.push('### 来源占比');
  lines.push('');
  lines.push('> 三个口径各说各的：**提及**是它被想起多少，**体积**是它在当前 prompt 里占多大，**累计**是整个会话为它付了多少（每步都会重发一次）。');
  lines.push('');
  for (const entry of kindSummary(report.blocks)) {
    lines.push(`${cell(entry.kind, 12)} ${cell(bar(entry.mentionShare), 20)} ${cell(`${(entry.mentionShare * 100).toFixed(1)}%`, 6, 'right')} 提及 ${cell(`${(entry.tokenShare * 100).toFixed(1)}%`, 6, 'right')} 体积 ${cell(`${(entry.cumulativeShare * 100).toFixed(1)}%`, 6, 'right')} 累计 ${String(entry.blocks).padStart(3)} 块`);
  }
  lines.push('');

  const ranked = report.blocks.filter((block) => block.terms >= minTerms);
  lines.push(`### 强度榜（词数 ≥ ${minTerms}，按每词加权提及数排序）`);
  lines.push('');
  lines.push('> 「体积」是这块在当前 prompt 里的规模，「累计」是整个会话为它付的总账。两个数差得越大，说明越是被反复重发的固定成本；累计为 0 表示这块是最后一次输出，还没被任何请求重发过。');
  lines.push('');
  const strengthWidths = [50, 7, 7, 7, 8, 9];
  lines.push(row(['块', '覆盖率', '提及', '强度', '体积', '累计'], strengthWidths, ['left', 'right', 'right', 'right', 'right', 'right']));
  lines.push(divider(strengthWidths, ['left', 'right', 'right', 'right', 'right', 'right']));
  for (const block of ranked.slice(0, limit)) {
    lines.push(row([blockName(block), `${(block.coverage * 100).toFixed(0)}%`, String(block.rawHits), block.intensity.toFixed(2), (block.tokens ?? 0).toLocaleString('en-US'), (block.cumulative ?? 0).toLocaleString('en-US')], strengthWidths, ['left', 'right', 'right', 'right', 'right', 'right']));
  }
  if (ranked.length === 0) lines.push('| （没有达到词数门槛的块） |  |  |  |  |  |');
  lines.push('');

  const tracked = ranked.slice(0, 8);
  if (steps > 1 && tracked.length > 0) {
    lines.push(`### 时间分布（会话压成 ${buckets} 格，每格取该区间峰值）`);
    lines.push('');
    const timelineWidths = [50, 6, 6, 6, 8, buckets];
    lines.push(row(['块', '早1/3', '中1/3', '晚1/3', '峰值步', '分布'], timelineWidths, ['left', 'right', 'right', 'right', 'right', 'left']));
    lines.push(divider(timelineWidths, ['left', 'right', 'right', 'right', 'right', 'left']));
    for (const block of tracked) {
      const shares = stages(block.series);
      const at = peakStep(block.series);
      lines.push(row([blockName(block), `${(shares[0] * 100).toFixed(0)}%`, `${(shares[1] * 100).toFixed(0)}%`, `${(shares[2] * 100).toFixed(0)}%`, at === null ? '—' : String(at), sparkline(compress(block.series, buckets))], timelineWidths, ['left', 'right', 'right', 'right', 'right', 'left']));
    }
    lines.push('');
    const runs = dominantRuns(report.steps);
    if (runs.length > 0) {
      lines.push('主导段（同一来源连续主导 ≥ 4 步）：');
      lines.push('');
      for (const run of runs.slice(0, 6)) lines.push(`- 第 ${run.start}–${run.end} 步（${run.length} 步）${run.label}`);
      if (runs.length > 6) lines.push(`- …另有 ${runs.length - 6} 段`);
      lines.push('');
    }
  }

  if (report.matrix.length > 0) {
    const { minSpan, skippedBySpan } = report.totals;
    lines.push(`### 关键词（按提及次数排序，跨度 ≥ ${minSpan}，top ${Math.min(matrixLimit, report.matrix.length)}）`);
    lines.push('');
    lines.push(`> 归因力 = min(提及, 上下文) ÷ 跨度，越高越能指向具体的块；提及 > 上下文说明这词更多出自我的措辞而非上下文。`);
    lines.push(`> 跨度门槛随轮数缩放（本轮 ${steps} 段 reasoning → ≥ ${minSpan}），已挡掉 ${skippedBySpan} 个只在一两处出现过的词——它们的分母接近 1，会把归因力抬成假冠军。`);
    lines.push('');
    const matrixWidths = [16, 6, 6, 7, 5, 34];
    lines.push(row(['词', '归因力', '提及', '上下文', '跨度', '贡献最大的块'], matrixWidths, ['left', 'right', 'right', 'right', 'right', 'left']));
    lines.push(divider(matrixWidths, ['left', 'right', 'right', 'right', 'right', 'left']));
    for (const entry of report.matrix.slice(0, matrixLimit)) {
      const source = entry.sourceIndex < 0 ? '—' : `#${entry.sourceIndex + 1} ${truncate(`${entry.sourceLabel}${entry.sourcePreview ? ` · ${entry.sourcePreview}` : ''}`, 30)}`;
      lines.push(row([entry.term, entry.attribution.toFixed(2), String(entry.total), String(entry.contextTotal), String(entry.blocks), source], matrixWidths, ['left', 'right', 'right', 'right', 'right', 'left']));
    }
    lines.push('');
  }

  if (report.unclosed.length > 0) {
    const termCount = report.unclosed.reduce((sum, entry) => sum + entry.terms.length, 0);
    lines.push(`### 未闭合的用户输入（${report.unclosed.length} 条消息 / ${termCount} 个词）`);
    lines.push('');
    lines.push('> 这些词你说了，但在**那一轮**的 reasoning 和答复里都没出现过。窗口取到下一条用户消息为止，不是整个会话。');
    lines.push('>');
    lines.push('> 两类假阳性要自己滤：**指令类词**（「用英文」「帮我」）是被遵守而不是被讨论的，所以永远不会出现；**拼写变体与缩写**也会被当词统计。');
    lines.push('>');
    lines.push('> 这是日志里唯一能算出来的遗漏类型。「想过、答了、但没做到」和「该查而根本没查」都留不下可数的痕迹——所以这个清单空着**不代表没有遗漏**。');
    lines.push('');
    lines.push(...termLines(report.unclosed, deadLimit));
    if (report.unclosed.length > deadLimit) lines.push(`- …另有 ${report.unclosed.length - deadLimit} 条`);
    lines.push('');
  }

  if (report.inactive.length > 0) {
    const termCount = report.inactive.reduce((sum, entry) => sum + entry.terms.length, 0);
    lines.push(`### 回复里无出处的标识符（${report.inactive.length} 段回复 / ${termCount} 个）`);
    lines.push('');
    lines.push('> 我在这段回复里精确写出的标识符 / 路径 / 版本号 / 行号，**在此之前**的 reasoning 与上下文里都没出现过这个写法。要核对是不是我拼错或编的。');
    lines.push('>');
    lines.push('> 只查这一类是量出来的结果：词级匹配在同一会话里报 121 个，绝大多数是我写报告时的措辞（`dig` / `实证` / `核实` / `I\'ll`），收窄到可核对 token 后剩 3 个。代价是纯自然语言的凭空断言查不到——**清单空着不代表没问题**。');
    lines.push('');
    lines.push(...termLines(report.inactive, deadLimit));
    if (report.inactive.length > deadLimit) lines.push(`- …另有 ${report.inactive.length - deadLimit} 条`);
    lines.push('');
  }

  // 覆盖率 0 = 从头到尾没被提及过。这是「能砍」的第一手候选，但它不等于「没用」：
  // 有些内容是被遵守而不是被讨论的。
  const dead = report.blocks.filter((block) => block.covered === 0);
  if (dead.length > 0) {
    // 同一形态的块（例如 5 次空参数的 list_agents）合并成一行，否则清单全是重复。
    const groups = new Map();
    for (const block of dead) {
      const key = `${block.label}\u0000${block.preview ?? ''}`;
      const entry = groups.get(key) ?? { block, count: 0, chars: 0 };
      entry.count += 1;
      entry.chars += block.chars;
      groups.set(key, entry);
    }
    lines.push(`### 从未被提及的块（${dead.length} 个，合并后 ${groups.size} 类，合计 ${dead.reduce((sum, block) => sum + block.chars, 0).toLocaleString('en-US')} 字符）`);
    lines.push('');
    for (const entry of [...groups.values()].slice(0, deadLimit)) {
      const times = entry.count > 1 ? ` ×${entry.count}` : '';
      lines.push(`- ${blockName(entry.block, 60)}${times}（${entry.chars} 字符）`);
    }
    if (groups.size > deadLimit) lines.push(`- …另有 ${groups.size - deadLimit} 类`);
    lines.push('');
    lines.push('> 从没被提及不等于没用：被遵守的规则通常不会被讨论；而极短的用户指令（「修复」「直接提交」）在提及度上必然垫底。这份清单是排查起点，不是删除建议。');
  }

  return lines.join('\n');
}
