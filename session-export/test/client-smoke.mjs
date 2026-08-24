// Client smoke test for dsh-plugin-session-export: loads the browser bundle in
// a vm sandbox and verifies the module surface loads, the pure helpers produce
// XHTML-safe markup, segment packing works, and the locale dictionaries stay in
// sync.
// Run: node test/client-smoke.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let loaded = null;
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
    createElement: () => ({}),
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
check('pure helpers exported', ['escapeXml', 'renderMarkdownHtml', 'buildMessageHtml', 'buildExportCss', 'buildSegmentsHtml', 'sanitizeFileName'].every((k) => typeof loaded[k] === 'function'));

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

// ── segment packing ─────────────────────────────────────────────────────────
console.log('segment packing:');
{
  const opts = { segmentHeight: 200 };
  const css = 'body{}';
  const headerHtml = '<header class="dse-export-head"><h1 class="dse-title">T</h1></header>';
  const footerHtml = '<footer class="dse-footer">F</footer>';
  const messageHtmls = ['<section class="dse-msg">1</section>', '<section class="dse-msg">2</section>', '<section class="dse-msg">3</section>', '<section class="dse-msg">4</section>'];
  const messageHeights = [80, 80, 80, 80]; // 4 × 80 = 320 > 200 -> 2 segments
  const segments = loaded.buildSegmentsHtml({ css, headerHtml, footerHtml, messageHtmls, messageHeights, headerH: 40, footerH: 20, opts });
  check('packs into 2 segments', segments.length === 2, String(segments.length));
  check('segment 1 height = 56 + header(40) + 160', segments[0].height === 256, String(segments[0].height));
  check('segment 2 height = 56 + 160 + footer(20+30)', segments[1].height === 266, String(segments[1].height));
  check('header only on first segment', segments[0].html.includes('dse-export-head') && !segments[1].html.includes('dse-export-head'));
  check('footer only on last segment', !segments[0].html.includes('dse-footer') && segments[1].html.includes('dse-footer'));
  check('embed style on every segment', segments.every((s) => s.html.startsWith('<style>')));
  check('message order preserved', segments[0].html.includes('>1</section>') && segments[0].html.includes('>2</section>') && segments[1].html.includes('>3</section>') && segments[1].html.includes('>4</section>'));
  const single = loaded.buildSegmentsHtml({ css, headerHtml, footerHtml, messageHtmls: ['<section class="dse-msg">1</section>'], messageHeights: [30], headerH: 40, footerH: 20, opts });
  check('single message -> one segment with header+footer', single.length === 1 && single[0].html.includes('dse-export-head') && single[0].html.includes('dse-footer'), JSON.stringify(single));
  // an over-tall message gets its own (over-limit) segment instead of splitting
  const tall = loaded.buildSegmentsHtml({ css, headerHtml, footerHtml, messageHtmls: ['<section class="dse-msg">big</section>', '<section class="dse-msg">2</section>'], messageHeights: [500, 20], headerH: 0, footerH: 0, opts });
  check('over-tall message keeps its own segment', tall.length === 2 && tall[0].height === 556, JSON.stringify(tall.map((s) => s.height)));
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
