// Client smoke test for dsh-plugin-session-export: loads the browser bundle in
// a vm sandbox and verifies the module surface loads, the pure helpers produce
// XHTML-safe markup, segment packing works, and the locale dictionaries stay in
// sync.
// Run: node test/client-smoke.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let loaded = null;
// Mini createElement that faithfully reproduces React's children semantics
// (props.children, string children vs dangerouslySetInnerHTML) so the button
// icon wiring can be asserted structurally without a real React runtime.
function miniCreateElement(type, props, ...children) {
  return {
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.length <= 1 ? (children[0] ?? null) : children
  };
}
const sandbox = {
  window: {},
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, appendChild() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} }
  },
  console,
  encodeURIComponent,
  fetch: async () => ({ json: async () => ({ ok: true }) }),
  react: {
    createElement: miniCreateElement,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (f) => f
  }
};
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    loaded = factory((id) => {
      if (id in sandbox) return sandbox[id];
      throw new Error('unexpected require: ' + id);
    });
  }
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failed += 1;
    console.log(' FAIL ' + label + (detail !== undefined ? '  -> ' + detail : ''));
  }
}

// ── module surface ──────────────────────────────────────────────────────────
console.log('module surface:');
check('apply exported', typeof loaded.apply === 'function');
check('ExportAction exported', typeof loaded.ExportAction === 'function');
check('pure helpers exported', ['escapeXml', 'renderMarkdownHtml', 'buildMessageHtml', 'buildExportCss', 'packSegments', 'buildSegmentHtml', 'sanitizeFileName'].every((k) => typeof loaded[k] === 'function'));

// ── markdown → XHTML ────────────────────────────────────────────────────────
console.log('markdown renderer:');
{
  const html = loaded.renderMarkdownHtml('**bold** and `code` and <b>raw</b>');
  check('bold', html.includes('<strong>bold</strong>'), html);
  check('inline code', html.includes('<code>code</code>'), html);
  check('raw html escaped', html.includes('&lt;b&gt;raw&lt;/b&gt;') && !html.includes('<b>raw</b>'), html);
}
{
  const html = loaded.renderMarkdownHtml('*em* ~~strike~~ [link](https://example.com/a?b=1&c=2)');
  check('italic', html.includes('<em>em</em>'), html);
  check('strikethrough', html.includes('<s>strike</s>'), html);
  check('link href escaped', html.includes('href="https://example.com/a?b=1&amp;c=2"'), html);
}
{
  const html = loaded.renderMarkdownHtml('```js\nconst x = 1;\n```');
  check('fence keeps lang label', html.includes('class="dse-code-lang">js<'), html);
  check('fence code escaped', html.includes('<code>const x = 1;</code>'), html);
}
{
  const html = loaded.renderMarkdownHtml('# 标题\n\n> 引用\n\n- 甲\n- 乙');
  check('heading', html.includes('<h1>标题</h1>'), html);
  check('blockquote', html.includes('<blockquote>引用</blockquote>'), html);
  check('list', html.includes('<ul><li>甲</li><li>乙</li></ul>'), html);
}
{
  const html = loaded.renderMarkdownHtml('- [x] 完成\n- [ ] 待办');
  check('task list checkboxes', html.includes('class="dse-check on"') && html.includes('class="dse-check"') && html.includes('class="dse-task"'), html);
}
{
  const html = loaded.renderMarkdownHtml('| a | b |\n| --- | --- |\n| 1 | 2 |');
  check('gfm table', html.includes('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'), html);
}
{
  const html = loaded.renderMarkdownHtml('---\n\n段落一\n第二行\n\n段落二');
  check('hr self-closed', html.includes('<hr/>'), html);
  check('paragraph lines joined', html.includes('<p>段落一 第二行</p>') && html.includes('<p>段落二</p>'), html);
}
{
  // regression: raw <tag>-like text inside LIST ITEMS and TABLE CELLS must be
  // escaped — an unescaped < would break the SVG foreignObject XML (real
  // session messages hit this: `zstd -dc <backup> | tar -C <cwd> -xf -`)
  const listHtml = loaded.renderMarkdownHtml('- 执行 `zstd -dc <backup> | tar -C <cwd> -xf -` 撤销');
  check('list inline code with <tag> escaped', listHtml.includes('&lt;backup&gt;') && listHtml.includes('&lt;cwd&gt;') && !listHtml.includes('<backup>') && !listHtml.includes('<cwd>'), listHtml);
  const tableHtml = loaded.renderMarkdownHtml('| cmd | desc |\n| --- | --- |\n| `<a>` | 用 `<b>` 替换 |');
  check('table cell <tag> escaped', tableHtml.includes('&lt;a&gt;') && tableHtml.includes('&lt;b&gt;') && !tableHtml.includes('<a>') && !tableHtml.includes('<b>'), tableHtml);
  const nestedListHtml = loaded.renderMarkdownHtml('- 外层\n  - 内层含 `<x>`');
  check('nested list item escaped', nestedListHtml.includes('&lt;x&gt;') && !nestedListHtml.includes('<x>'), nestedListHtml);
}
{
  // XHTML hygiene: no raw & outside entities, no unescaped < followed by space
  const samples = [
    loaded.renderMarkdownHtml('**a** & <x> `c` [l](https://e.com/?q=1&r=2)'),
    loaded.renderMarkdownHtml('```\nif (a && b) { return "<tag>"; }\n```'),
    loaded.renderMarkdownHtml('# t\n- [ ] x\n> q\n\n| a |\n| --- |\n| b |')
  ];
  const bad = samples.filter((html) => /&(?!amp;|lt;|gt;|quot;|#\d+;)/.test(html) || /<[^a-zA-Z/!]/.test(html));
  check('output is XHTML-safe', bad.length === 0, JSON.stringify(bad));
}

// ── message markup ──────────────────────────────────────────────────────────
console.log('message markup:');
{
  const labels = { user: '你', assistant: '助手', image: '图片附件' };
  const userHtml = loaded.buildMessageHtml({ role: 'user', text: '你好 **世界**', time: 1700000000000, imageCount: 1 }, labels);
  check('user bubble', userHtml.includes('class="dse-msg dse-user"') && userHtml.includes('class="dse-bubble"'), userHtml);
  check('user image placeholder', userHtml.includes('图片附件') && userHtml.includes('× 1'), userHtml);
  check('role + time', userHtml.includes('你 · <span class="dse-time">') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(userHtml), userHtml);
  const asmHtml = loaded.buildMessageHtml({ role: 'assistant', text: '回答', time: 1700000000000, imageCount: 0 }, labels);
  check('assistant body', asmHtml.includes('class="dse-msg dse-assistant"') && asmHtml.includes('class="dse-body"') && !asmHtml.includes('dse-bubble'), asmHtml);
}

// ── header button icon wiring ───────────────────────────────────────────────
// Regression: React renders string children as TEXT — the SVG glyph must be
// injected via dangerouslySetInnerHTML, or the header shows the raw SVG markup
// instead of an icon (reported as "header 处只能看见 svg").
console.log('header button:');
{
  const element = loaded.ExportAction({ sessionId: 's1', t: (k) => 'L:' + k });
  const found = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    found.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
    else walk(node.children);
  };
  walk(element);
  const button = found.find((n) => n.type === 'button');
  const iconSpan = found.find((n) => n.type === 'span' && n.props && typeof n.props.dangerouslySetInnerHTML === 'object');
  check('button rendered', button !== undefined);
  check('icon injected via dangerouslySetInnerHTML (not string child)', iconSpan !== undefined && typeof iconSpan.props.dangerouslySetInnerHTML.__html === 'string' && iconSpan.props.dangerouslySetInnerHTML.__html.includes('<svg'), JSON.stringify(iconSpan?.props));
  const buttonChildren = Array.isArray(button?.children) ? button.children : [button?.children];
  check('button has no raw string svg child', buttonChildren.every((c) => typeof c !== 'string' || !c.includes('<svg')), JSON.stringify(buttonChildren.map((c) => typeof c)));
}

// ── segment packing + segment html ──────────────────────────────────────────
console.log('segment packing:');
{
  const opts = { segmentHeight: 200 };
  const css = 'body{}';
  const headerHtml = '<header class="dse-export-head"><h1 class="dse-title">T</h1></header>';
  const footerHtml = '<footer class="dse-footer">F</footer>';
  const messageHtmls = ['<section class="dse-msg">1</section>', '<section class="dse-msg">2</section>', '<section class="dse-msg">3</section>', '<section class="dse-msg">4</section>'];
  const groups = loaded.packSegments([80, 80, 80, 80], opts); // 4 × 80 = 320 > 200 -> 2 segments
  check('packs into 2 segments', groups.length === 2 && groups[0].idx.join(',') === '0,1' && groups[1].idx.join(',') === '2,3', JSON.stringify(groups));
  const html0 = loaded.buildSegmentHtml({ css, headerHtml, footerHtml, messageHtmls, idx: groups[0].idx, first: true, last: false });
  const html1 = loaded.buildSegmentHtml({ css, headerHtml, footerHtml, messageHtmls, idx: groups[1].idx, first: false, last: true });
  check('header only on first segment', html0.includes('dse-export-head') && !html1.includes('dse-export-head'));
  check('footer only on last segment', !html0.includes('dse-footer') && html1.includes('dse-footer'));
  check('embed style on every segment', html0.startsWith('<style>') && html1.startsWith('<style>'));
  check('message order preserved', html0.includes('>1</section>') && html0.includes('>2</section>') && html1.includes('>3</section>') && html1.includes('>4</section>'));
  check('wrapped in .dse-export', html0.includes('<div class="dse-export">') && html0.endsWith('</div>'));
  const single = loaded.buildSegmentHtml({ css, headerHtml, footerHtml, messageHtmls, idx: [0], first: true, last: true });
  check('single segment has header+footer', single.includes('dse-export-head') && single.includes('dse-footer'), single);
  // an over-tall message keeps its own (over-limit) segment instead of splitting
  const tall = loaded.packSegments([500, 20], opts);
  check('over-tall message keeps its own segment', tall.length === 2 && tall[0].idx.join(',') === '0' && tall[1].idx.join(',') === '1', JSON.stringify(tall));
  // zero/undefined heights degrade to a single group
  const zeros = loaded.packSegments([0, 0, 0], opts);
  check('zero heights -> one group', zeros.length === 1 && zeros[0].idx.length === 3, JSON.stringify(zeros));
}

// ── filename sanitize ───────────────────────────────────────────────────────
console.log('filename:');
check('sanitizes illegal chars', loaded.sanitizeFileName('a/b\\c:*?"<>| d') === 'a-b-c- d', loaded.sanitizeFileName('a/b\\c:*?"<>| d'));
check('strips trailing dots/spaces', loaded.sanitizeFileName('标题...  ') === '标题', loaded.sanitizeFileName('标题...  '));
check('empty falls back to session', loaded.sanitizeFileName('  /// ') === 'session', loaded.sanitizeFileName('  /// '));
check('keeps CJK title', loaded.sanitizeFileName('导出会话 123') === '导出会话 123', loaded.sanitizeFileName('导出会话 123'));
check('caps at 80 chars', loaded.sanitizeFileName('x'.repeat(200)).length === 80);

// ── theme sampling falls back without CSS vars ──────────────────────────────
console.log('theme:');
{
  const colors = loaded.sampleThemeColors();
  check('samples all 8 colors', Object.keys(colors).length === 8 && Object.values(colors).every((v) => typeof v === 'string' && v !== ''), JSON.stringify(colors));
}

// ── locale parity via apply ─────────────────────────────────────────────────
console.log('locale:');
{
  let dicts = null;
  loaded.apply({
    effect: (fn) => fn(),
    locale: { register: (ns, d) => { dicts = d; return () => {}; }, bind: () => (key) => 'L:' + key },
    slots: { inject: () => {} }
  });
  check('zh/en registered', dicts !== null && Object.keys(dicts.zh).length === Object.keys(dicts.en).length);
  const zhOnly = Object.keys(dicts.zh).filter((k) => !(k in dicts.en));
  const enOnly = Object.keys(dicts.en).filter((k) => !(k in dicts.zh));
  check('no key drift', zhOnly.length === 0 && enOnly.length === 0, zhOnly.concat(enOnly).join(','));
}

console.log(failed === 0 ? 'CLIENT SMOKE PASS' : failed + ' CLIENT SMOKE FAILURES');
process.exit(failed === 0 ? 0 : 1);
