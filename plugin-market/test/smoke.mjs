// dsh-plugin-market 契约快照 smoke 测试（P0 重构护栏）
//
// 运行：npm test（= node test/smoke.mjs）
//
// 覆盖两层契约（重构 P1-P5 全程不得漂移）：
//  1) 纯函数行为契约：githubRepoInfo / gitSpec / disableBlock / stripEmptyArrayMarker /
//     readPatchState / reviewKey / compareVersions / routeOverrideOf。
//     lib 已按域拆分——直接 import 各域模块断言（P2 拆分前为「临时副本注入导出」方式）。
//  2) 路由表契约：服务端 handle 分支路径全集（routes.js 分发表）== 固定 16 条；
//     client.js 引用的 /plugin-market/* 路径必须是该全集的子集。
import { readFileSync, writeFileSync, rmSync, mkdtempSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { githubRepoInfo, gitSpec, compareVersions, makeQueue, readJsonFile, writeJsonFile } from '../lib/util.js'
import { disableBlock, stripEmptyArrayMarker, readPatchState, localDependencyInfo } from '../lib/patch.js'
import { reviewKey } from '../lib/review.js'
import { routeOverrideOf, ROUTES } from '../lib/routes.js'
import { rangeBreakFinding, scanFindingTag, pluginMachineLevel, dshBreakingGuard } from '../lib/dsh.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIB_ROUTES = join(__dirname, '..', 'lib', 'routes.js')
const LIB_CLIENT = join(__dirname, '..', 'lib', 'client.js')
const LIB_DSH = join(__dirname, '..', 'lib', 'dsh.js')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('  ok  ' + msg)
  } else {
    failures += 1
    console.error('FAIL  ' + msg)
  }
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log('  ok  ' + msg)
  else {
    failures += 1
    console.error('FAIL  ' + msg + '\n      expected: ' + e + '\n      actual:   ' + a)
  }
}

// ── 服务端路由全集（routes.js 分发表的 16 条；改动端点必须同步改这里） ────────
const SERVER_PATHS = [
  '/state',
  '/sources',
  '/toggle',
  '/check-update',
  '/install',
  '/install/confirm',
  '/install/help',
  '/install/interrupt',
  '/update',
  '/update/help',
  '/uninstall',
  '/review',
  '/cleanup',
  '/dsh-version',
  '/dsh-version/check',
  '/dsh-version/analyze',
]

// ── 1) 纯函数契约：直连 import 各域模块（util/patch/review/routes） ──────────
console.log('\n[githubRepoInfo ← util.js]')
assertEq(githubRepoInfo('owner/repo'), { owner: 'owner', name: 'repo', path: null }, "owner/name → {owner,name,path:null}")
assertEq(githubRepoInfo('  https://github.com/a/b.git  '), { owner: 'a', name: 'b', path: null }, '完整 URL + 空白 + .git 后缀')
assertEq(githubRepoInfo('https://github.com/a/b.git#path:sub/dir'), { owner: 'a', name: 'b', path: 'sub/dir' }, '#path: 子目录')
assertEq(githubRepoInfo('WensH77/dsh-plugins#path:plugin-market'), { owner: 'WensH77', name: 'dsh-plugins', path: 'plugin-market' }, 'owner/name#path:')
for (const bad of ['', '   ', 'not a repo', 'a/b/c', 'github.com/x#tag:y']) {
  let threw = false
  try { githubRepoInfo(bad) } catch { threw = true }
  assert(threw, '非法地址抛错：' + JSON.stringify(bad))
}

console.log('\n[gitSpec ← util.js]')
assertEq(gitSpec({ owner: 'a', name: 'b', path: null }), 'github:a/b', '无子目录')
assertEq(gitSpec({ owner: 'a', name: 'b', path: 'sub' }), 'github:a/b#path:sub', '带子目录')

console.log('\n[disableBlock / stripEmptyArrayMarker ← patch.js]')
assertEq(disableBlock('x'), '- id: x\n  disabled: true\n', 'disableBlock 块形状')
assertEq(stripEmptyArrayMarker('# 注释\n[]\n'), '# 注释\n', '注释+[] → 移除 [] 保留注释')
assertEq(stripEmptyArrayMarker('[]\n'), '', '仅 [] → 空串')
const withEntries = '# a\n- id: x\n  disabled: true\n'
assertEq(stripEmptyArrayMarker(withEntries), withEntries, '已有条目 → 原样返回')
assertEq(stripEmptyArrayMarker('# 只有注释\n'), '# 只有注释\n', '无 [] 纯注释 → 原样')

console.log('\n[readPatchState ← patch.js]')
{
  const patchText = [
    '# dsh patch layer',
    '- id: chat-rollback',
    '  disabled: true',
    '- id: plugin-market',
    '  name: dsh-plugin-market',
    '- insert:',
    '    - id: plugin-market',
    '      name: dsh-plugin-market',
    '- id: some-plugin',
    '  disabled: false',
    '',
  ].join('\n')
  const patchFile = join(tmpdir(), 'pm-smoke-patch-' + Date.now() + '-cordis.patch.yml')
  writeFileSync(patchFile, patchText, 'utf8')
  const state = await readPatchState(patchFile)
  assertEq(state.disables, ['chat-rollback'], 'disables 解析')
  assertEq(state.forced, ['some-plugin'], 'forced 解析')
  assertEq(state.inserts, ['plugin-market'], 'inserts 解析')
  assertEq(state.insertNames, { 'plugin-market': 'dsh-plugin-market' }, 'insertNames 解析')
  rmSync(patchFile, { force: true })
}

console.log('\n[reviewKey ← review.js]')
assertEq(reviewKey('dsh-plugin-market', '0.13.0'), 'dsh-plugin-market@0.13.0', '常规键')
assertEq(reviewKey('@scope/pkg', '1.0.0'), '@scope/pkg@1.0.0', 'scoped 包')
assertEq(reviewKey('pkg', null), 'pkg@latest', '无版本 → latest')
for (const [name, ver] of [['../../etc', '0.1.0'], ['Pkg', '1.0.0'], ['pkg', '1.0'], ['pkg', '1.0.0-坏' + '']]) {
  const key = reviewKey(name, ver)
  assert(String(key).startsWith('invalid-') && key.length > 20, '非法 name/version → sha1 兜底键：' + JSON.stringify(name + '@' + ver))
}

console.log('\n[compareVersions ← util.js]')
assertEq(compareVersions('0.13.0', '0.14.0'), -1, 'minor 递增')
assertEq(compareVersions('1.2.3', '1.2.3'), 0, '相同')
assertEq(compareVersions('0.1.2-alpha.4', '0.1.2'), -1, '预发布 < 正式版')
assertEq(compareVersions('0.1.2', '0.1.2-rc.1'), 1, '正式版 > 预发布')
assertEq(compareVersions('0.1.2-alpha.10', '0.1.2-alpha.9'), 1, '数字预发布按数值比较')
assertEq(compareVersions('0.1.2-alpha', '0.1.2-alpha.1'), -1, '短标识符 < 长标识符')
assertEq(compareVersions('0.1.2-alpha.4', '0.1.2-beta.1'), -1, 'alpha < beta')
assertEq(compareVersions('abc', '0.1.2'), 0, '非法版本 → 0')

console.log('\n[routeOverrideOf ← routes.js]')
assertEq(routeOverrideOf({}), null, '空 body → null')
assertEq(routeOverrideOf({ model: 'deepseek-v4-flash', effort: 'high' }), { model: 'deepseek-v4-flash', reasoningEffort: 'high' }, 'model+effort 透传')
assertEq(routeOverrideOf({ model: '  ', effort: 'low' }), { reasoningEffort: 'low' }, '空白 model 丢弃')

console.log('\n[makeQueue ← util.js]')
{
  const q = makeQueue()
  const order = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await Promise.all([
    q(async () => { await sleep(20); order.push(1) }),
    q(async () => { await sleep(1); order.push(2) }),
    q(async () => { order.push(3) }),
  ])
  assertEq(order, [1, 2, 3], '队列严格串行（后入队不插队）')
}

console.log('\n[readJsonFile/writeJsonFile ← util.js]')
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-smoke-json-'))
  const file = join(dir, 'state.json')
  try {
    await writeJsonFile(file, { a: 1, b: 'x' })
    assertEq(await readJsonFile(file, null), { a: 1, b: 'x' }, 'round-trip 一致（2 空格缩进 + 结尾换行）')
    assertEq(await readJsonFile(join(dir, 'missing.json'), 'FALLBACK'), 'FALLBACK', '缺失文件 → fallback')
    writeFileSync(file, '{broken', 'utf8')
    assertEq(await readJsonFile(file, []), [], '损坏 JSON → fallback')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[localDependencyInfo ← patch.js]')
{
  const dir = mkdtempSync(join(tmpdir(), 'pm-smoke-local-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-x': 'link:../x' } }), 'utf8')
    assertEq(localDependencyInfo(dir, 'dsh-plugin-x'), { local: true, spec: 'link:../x', path: 'link:../x' }, 'link: 依赖 → local + spec')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-n': '^1.0.0' } }), 'utf8')
    assertEq(localDependencyInfo(dir, 'dsh-plugin-n'), { local: false, spec: null, path: null }, 'npm 依赖 → 非本地')
    // node_modules 符号链接指向 profile 外 → 本地安装（path 为真实路径）
    const outside = mkdtempSync(join(tmpdir(), 'pm-smoke-out-'))
    try {
      const fsMod = await import('node:fs')
      fsMod.mkdirSync(join(dir, 'node_modules'), { recursive: true })
      const target = join(outside, 'real-pkg')
      fsMod.mkdirSync(target)
      symlinkSync(target, join(dir, 'node_modules', 'dsh-plugin-y'))
      const info = localDependencyInfo(dir, 'dsh-plugin-y')
      // macOS /var → /private/var 前缀差异：与 realpath 比较而非字面 target
      const realTarget = realpathSync(target)
      assert(info.local === true && info.path === realTarget, 'symlink 指向 profile 外 → local + path=real')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── range-break 分层契约：声明所在 section 决定严重度与 kind ──────────────────
console.log('\n[rangeBreakFinding ← dsh.js]')
{
  const target = '0.1.5-alpha.1'
  const peer = rangeBreakFinding('@deepseek-ai/dsh-agent', '^0.1.2-alpha.2', target, 'peerDependencies')
  assertEq(peer.severity, 'info', 'peerDependencies 越界 → info（不参与安装，仅声明失真）')
  assertEq(peer.kind, 'range-break-peer', 'peerDependencies 越界 kind = range-break-peer')
  const dev = rangeBreakFinding('@deepseek-ai/dsh-llm', '0.1.2-rc.1', target, 'devDependencies')
  assertEq(dev.severity, 'medium', 'devDependencies 越界 → medium（本地抢先命中）')
  assertEq(dev.kind, 'range-break-dev', 'devDependencies 越界 kind = range-break-dev')
  const dep = rangeBreakFinding('@deepseek-ai/dsh-llm', '0.1.2-rc.1', target, 'dependencies')
  assertEq(dep.severity, 'high', 'dependencies 越界 → high（污染 profile 根）')
  assertEq(dep.kind, 'range-break', 'dependencies 越界 kind = range-break')
  assert(peer.message.includes(target) && dep.message.includes('0.1.2-rc.1'), 'message 带上声明范围与目标版本')
  // 分层理由由 kind + 短标签承担，不再逐条把同一句括号解释刷进 message
  assert(!peer.message.includes('（') && !dev.message.includes('（') && !dep.message.includes('（'), 'message 不含括号解释（解释只出现一次，不逐条重复）')
  assertEq(
    [scanFindingTag(dep), scanFindingTag(dev), scanFindingTag(peer), scanFindingTag({ severity: 'high', kind: 'removed-module' }), scanFindingTag({ severity: 'high' })],
    ['dependencies 越界', 'devDependencies 越界', 'peer 声明失真', '宿主模块消失', '高'],
    'scanFindingTag：kind → 短标签（旧缓存无 kind 时退化为严重度标签）'
  )
  const clientText = readFileSync(LIB_CLIENT, 'utf8')
  assert(clientText.includes('pm-scanInfo') && clientText.includes('dshReportScanPluginCount') && clientText.includes('pm-scanPluginName'),
    'client.js 按插件折叠渲染机器结论（每个插件一个 <details>）')
  assert(!clientText.includes('dshReportScanPeerGroup') && !clientText.includes('devDependencies 不随发布安装'),
    'client.js 不再使用旧的「全网 peer 汇总组」与逐条括号解释文案')
  assert(clientText.includes('dshInstallCommand') && clientText.includes('@deepseek-ai/dsh@next') && clientText.includes('@deepseek-ai/dsh@latest') && clientText.includes('/-alpha\\./u'),
    'client.js 带可复制的安装命令推导（rc/beta → @next、alpha → 精确版本、正式版 → @latest）')
  assert(clientText.includes('pm-cmdText') && clientText.includes('navigator.clipboard'), 'client.js 安装命令行可复制（Clipboard API + 选中复制回退）')
  assert(clientText.includes('findingMessage'), 'client.js 渲染时裁掉旧缓存 finding 里重复的括号解释（无需重跑扫描即可看新版文案）')
}

// ── 机器档位 + 破坏性护栏：devDeps / peer 属声明层，不得把版本抬成 breaking ──
console.log('\n[pluginMachineLevel / dshBreakingGuard ← dsh.js]')
{
  const high = { severity: 'high', kind: 'range-break' }
  const dev = { severity: 'medium', kind: 'range-break-dev' }
  const peer = { severity: 'info', kind: 'range-break-peer' }

  assertEq(pluginMachineLevel([]), 'clean', '无 finding → clean')
  assertEq(pluginMachineLevel([peer]), 'clean', '仅 peer 声明失真 → clean（不进运行期判据）')
  assertEq(pluginMachineLevel([dev, dev]), 'notice', '仅 devDependencies 越界 → notice（开发期提示）')
  assertEq(pluginMachineLevel([dev, high]), 'affected', '有 high 覆盖 medium → affected')
  assertEq(pluginMachineLevel([{ severity: 'high', kind: 'removed-module' }]), 'affected', '宿主模块消失 → affected')

  const zeroRuntime = { method: 'registry-closure', removedModules: [], plugins: [{ moduleName: 'p', machine: 'notice', findings: [dev] }] }
  assertEq(dshBreakingGuard(zeroRuntime, true), true, '零运行期破坏点 + 模型判 breaking → 降级为兼容')
  assertEq(dshBreakingGuard(zeroRuntime, false), false, '模型本就没判 breaking → 不降级')
  assertEq(dshBreakingGuard({ ...zeroRuntime, removedModules: ['@deepseek-ai/dsh-x'] }, true), false, '有宿主模块消失 → 保持模型结论')
  assertEq(dshBreakingGuard({ method: 'registry-closure', removedModules: [], plugins: [{ findings: [high] }] }, true), false, '有 high finding（dependencies 越界）→ 保持模型结论')
  assertEq(dshBreakingGuard({ method: 'local-only', removedModules: [], plugins: [] }, true), null, '扫描不可用（local-only）→ 不判定，保持模型结论')
  assertEq(dshBreakingGuard(null, true), null, '未跑扫描 → 不判定')

  // 线上真实误报复刻：0.1.5-rc.1 → 0.1.5-rc.2 补丁级抬版 + 某插件 devDeps 未同步
  const persisted = {
    method: 'registry-closure',
    removedModules: [],
    plugins: [{ moduleName: '@yuxianglin/dsh-bridge-browser', machine: 'notice', findings: Array.from({ length: 20 }, () => dev) }],
  }
  assertEq(dshBreakingGuard(persisted, true), true, '复刻 0.1.5-rc.2 误报：仅 devDeps 越界不再把结论抬成 breaking')

  // prompt 口径：两个 breaking 维度必须分开表述，且声明层提示被显式排除
  const dshText = readFileSync(LIB_DSH, 'utf8')
  assert(dshText.includes('**与是否影响本机已装插件无关**'), 'versions[].breaking = 上游口径，明确与本机影响解耦')
  assert(dshText.includes('devDependencies 越界属开发期提示、peer 声明失真属声明层问题'), '判断指引显式排除 devDeps / peer 作为 breaking 依据')
  assert(dshText.includes('**勿**据此判定 breakingChanges'), '扫描提示区显式要求模型不得据 devDeps 判 breakingChanges')
  assert(dshText.includes('const DSH_VERDICT_SCHEMA = 2') && dshText.includes('prev.verdictSchema === DSH_VERDICT_SCHEMA'),
    '判定口径版本：口径升级后旧缓存作废（回到待分析），修复不必等远端再发新版')
}

// ── 渲染行为契约：把 client.js 里真实的「按插件折叠」渲染块抽出来，用假 DOM 跑一遍 ──
// 浏览器脚本不经 node 加载（只能 --check 语法），这里用源码锚点抽出该块 + 假 DOM 执行，
// 覆盖真实执行路径：折叠分组、档位圆点/标签、默认展开、括号裁剪、clean 计数。
console.log('\n[扫描报告按插件折叠 ← client.js 渲染块 @ 假 DOM]')
{
  const src = readFileSync(LIB_CLIENT, 'utf8')
  const start = src.indexOf('if (d && d.scan && (Array.isArray(d.scan.plugins)')
  const end = src.indexOf('if (d.details)', start)
  assert(start > 0 && end > start, '能定位渲染块（锚点：if (d && d.scan …) / if (d.details)）')
  if (start > 0 && end > start) {
    const createElement = (tag) => ({
      tagName: tag, className: '', style: {}, dataset: {}, children: [], textContent: '',
      appendChild(child) { this.children.push(child); return child },
      addEventListener() {}, querySelector() { return null }, remove() {},
    })
    const document = { createElement, createTextNode: (text) => ({ kind: 'text', text: String(text) }) }
    const dict = {
      dshReportScan: '本地插件契约扫描（机器判定）',
      dshReportScanIntro: '用「本地插件使用指纹 × 目标版本宿主模块闭包」做的确定性核对，先于 LLM 分析。',
      dshReportScanClean: '{count} 个插件机器判定未命中',
      dshReportScanLocalOnly: '（registry 不可达，仅指纹、无闭包核对）',
      dshReportScanCleanNone: '（机器判定未发现受影响插件）',
      dshReportScanPluginCount: '{count} 条机器结论（点击展开）',
      dshReportScanKindRemoved: '宿主模块消失',
      dshReportScanKindDeps: 'dependencies 越界',
      dshReportScanKindDevDeps: 'devDependencies 越界',
      dshReportScanKindPeer: 'peer 声明失真',
      dshReportScanKindHigh: '高', dshReportScanKindMedium: '中', dshReportScanKindInfo: '提示',
    }
    const t = (key) => dict[key] ?? key
    const tpl = (template, params) => String(template).replace(/\{(\w+)\}/g, (_, key) => (params[key] !== undefined ? String(params[key]) : ''))
    // 渲染块依赖的 module 级小工具：同样从源码抽出来执行（保证测的是线上实现，不是副本）
    const fmStart = src.indexOf('function findingMessage(f)')
    const fmEnd = src.indexOf('\n\t\t}', fmStart)
    assert(fmStart > 0 && fmEnd > fmStart, '能定位 findingMessage（锚点：function findingMessage）')
    const findingMessage = new Function('return ' + src.slice(fmStart, fmEnd + 4))()
    // client.js 渲染块只依赖 document / t / tpl / findingMessage / d / body，故可直接在假 DOM 上执行
    const render = (scan) => {
      const body = createElement('div')
      new Function('document', 't', 'tpl', 'findingMessage', 'd', 'body', src.slice(start, end))(document, t, tpl, findingMessage, { scan }, body)
      return body
    }
    const textOf = (node) => (node.kind === 'text' ? node.text : String(node.textContent ?? '') + (node.children ?? []).map(textOf).join(''))
    const groupOf = (body) => body.children.filter((n) => n.tagName === 'details')

    // 1) 复刻线上真实缓存形状：单插件 20 条 devDependencies 越界（旧版平铺 20 行）
    const devFindings = Array.from({ length: 20 }, (_, i) => ({
      severity: 'medium',
      kind: 'range-break-dev',
      message: '声明的 @deepseek-ai/dsh-p' + i + ' 依赖范围 1.0.7 未覆盖目标版本 0.1.5-rc.1（devDependencies 不随发布安装，但本地开发装了就可能在插件自己的 node_modules 里抢先命中旧副本）',
    }))
    const body = render({
      method: 'registry-closure',
      errors: [],
      plugins: [
        { moduleName: '@yuxianglin/dsh-bridge-browser', version: '0.0.3', machine: 'notice', findings: devFindings, evidence: {} },
        { moduleName: 'dsh-plugin-market', version: '0.14.4', machine: 'clean', findings: [], evidence: {} },
      ],
    })
    const groups = groupOf(body)
    assertEq(groups.length, 1, '一个插件一个 <details>（20 条同源结论收成一个折叠组）')
    const summary = groups[0].children[0]
    assertEq(summary.tagName, 'summary', '折叠组首子节点是 <summary>')
    assertEq(summary.children[0].dataset.severity, 'medium', '组行首圆点按最高档位着色（medium）')
    assert(textOf(summary).includes('@yuxianglin/dsh-bridge-browser@0.0.3') && textOf(summary).includes('20 条机器结论'),
      '组标题 = 包名@版本 + 结论条数：' + JSON.stringify(textOf(summary)))
    assert(groups[0].open !== true, 'medium-only 组默认收起')
    const items = groups[0].children[1].children
    assertEq(items.length, 20, '20 条 finding 全部收进组内（不丢条目）')
    assertEq(items[0].children[0].textContent, 'devDependencies 越界', 'finding 首列是短标签（devDependencies 越界）')
    assertEq(items[0].children[0].dataset.severity, 'medium', 'finding 标签按严重度着色')
    assertEq(textOf(items[0]), 'devDependencies 越界声明的 @deepseek-ai/dsh-p0 依赖范围 1.0.7 未覆盖目标版本 0.1.5-rc.1',
      '旧缓存里的括号解释在渲染时被裁掉')
    assert(textOf(body).endsWith('1 个插件机器判定未命中'), 'clean 插件仍只计数：' + JSON.stringify(textOf(body).slice(-40)))

    // 2) dependencies 越界（high）默认展开，免得不小心把真破坏点折住
    const bodyHigh = render({
      method: 'registry-closure',
      errors: [],
      plugins: [{
        moduleName: 'dsh-plugin-x', version: '1.0.0', machine: 'affected', evidence: {},
        findings: [
          { severity: 'high', kind: 'range-break', message: '声明的 @deepseek-ai/dsh-llm 依赖范围 0.1.2-rc.1 未覆盖目标版本 0.1.5-rc.1' },
          { severity: 'info', kind: 'range-break-peer', message: '声明的 @deepseek-ai/dsh-agent 依赖范围 ^0.1.2 未覆盖目标版本 0.1.5-rc.1' },
        ],
      }],
    })
    const highGroup = groupOf(bodyHigh)[0]
    assertEq(highGroup.open, true, '含 high 的组默认展开')
    assertEq(highGroup.children[0].children[0].dataset.severity, 'high', '组圆点取最高档位（high 覆盖同组 info）')
    assertEq(highGroup.children[1].children.map((li) => li.children[0].textContent), ['dependencies 越界', 'peer 声明失真'],
      '同组不同档位的 finding 各自带短标签')

    // 3) 无任何 finding：只输出 clean 计数（区块标题/说明/local-only 提示照旧）
    const bodyClean = render({ method: 'local-only', errors: [], plugins: [{ moduleName: 'a', version: '1.0.0', findings: [], evidence: {} }] })
    assertEq(groupOf(bodyClean).length, 0, '无 finding 时不产生折叠组')
    assertEq(textOf(bodyClean), '本地插件契约扫描（机器判定）：用「本地插件使用指纹 × 目标版本宿主模块闭包」做的确定性核对，先于 LLM 分析。（registry 不可达，仅指纹、无闭包核对）1 个插件机器判定未命中 · （机器判定未发现受影响插件）',
      '全 clean + local-only 文案（区块标题/说明保留，折叠组为空）')
  }
}

// ── 升级命令推导契约：同样抽 client.js 真实函数执行 ──────────────────────────
console.log('\n[dshInstallCommand ← client.js 抽取]')
{
  const src = readFileSync(LIB_CLIENT, 'utf8')
  const start = src.indexOf('function dshInstallCommand(version)')
  const end = src.indexOf('\n\t\t}', start)
  assert(start > 0 && end > start, '能定位 dshInstallCommand（锚点：function dshInstallCommand）')
  if (start > 0 && end > start) {
    const dshInstallCommand = new Function('return ' + src.slice(start, end + 4))()
    assertEq(dshInstallCommand('0.1.5-rc.1'), 'npm install -g @deepseek-ai/dsh@next', 'rc → @next（线上缓存的目标版本即此档）')
    assertEq(dshInstallCommand('0.1.5-beta.2'), 'npm install -g @deepseek-ai/dsh@next', 'beta → @next')
    assertEq(dshInstallCommand('0.1.5-alpha.2'), 'npm install -g @deepseek-ai/dsh@0.1.5-alpha.2', 'alpha → 精确版本（alpha 线无 dist-tag）')
    assertEq(dshInstallCommand('0.1.4'), 'npm install -g @deepseek-ai/dsh@latest', '正式版 → @latest')
    assertEq(dshInstallCommand(undefined), 'npm install -g @deepseek-ai/dsh@latest', '缺版本号 → @latest 兜底')
  }
}

// ── 状态灯契约：paint 文案 + 「正在分析」轮询时间线（同样抽 client.js 真实实现执行） ──
// 背景：服务端要等「拉版本材料 + L1 契约扫描」跑完才把 status 翻成 analyzing，期间仍是 idle。
// 没有守卫时，点击后第一次 1s 轮询就会拿陈旧 idle 覆盖并退回 60s —— analyzing 整个窗口被跳过，
// 「正在分析新版本…」实际显示不出来，判定也要等下一次 60s 轮询才出现。
console.log('\n[状态灯「正在分析」← client.js 抽取]')
{
  const src = readFileSync(LIB_CLIENT, 'utf8')
  // 1) paint：状态 → 圆点档位 + 文案
  const pStart = src.indexOf('const paint = (d) => {')
  const pEnd = src.indexOf('let dshReportOverlay = null;', pStart)
  assert(pStart > 0 && pEnd > pStart, '能定位 paint（锚点：const paint / let dshReportOverlay）')
  if (pStart > 0 && pEnd > pStart) {
    const ver = { textContent: '' }
    const statusEl = { dataset: {}, title: '', querySelector: () => ver }
    // 文案取自 client.js 的真实 zh 字典：此前这里是手抄的 fixture，抄本与产品文案漂移时测试照样通过
    const zhStart = src.indexOf('const zh = {')
    const zhEnd = src.indexOf('\n\t\t};', src.indexOf('{', zhStart)) + 4
    assert(zhStart > 0 && zhEnd > 4, '能定位 zh 字典（锚点：const zh = {）')
    const dict = new Function('return ' + src.slice(src.indexOf('{', zhStart), zhEnd))()
    assertEq(dict.dshBreakingShort, '兼容性问题',
      'zh 字典：红灯短文案 = 兼容性问题（判据是本机运行期兼容性，避免与官方「破坏性变更」撞词）')
    assert(/可能影响已装插件的兼容性/.test(dict.dshBreaking),
      'zh 字典：红灯标题标明「可能」+「已装插件」的兼容性（判据来自模型分类，且要说清是谁的兼容性）')
    assert(!/破坏性/.test(dict.dshBreaking + dict.dshBreakingShort),
      'zh 字典：红灯文案不得出现「破坏性」——该词留给上游口径（官方 release notes 的「破坏性变更」）')
    assertEq(dict.dshReportVersionBreaking, '破坏性变更',
      'zh 字典：逐版本标签保持上游口径「破坏性变更」，与红灯的本机口径形成对照')
    const h = new Function('t', `
      let statusEl = null; let lastState = null;
      ${src.slice(pStart, pEnd)}
      return { paint, mount: (el) => { statusEl = el } };
    `)((key) => dict[key] ?? key)
    h.mount(statusEl)
    const shot = (d) => { h.paint(d); return statusEl.dataset.state + ' | ' + ver.textContent }
    assertEq(shot({ ok: true, status: 'analyzing', installed: '0.1.5-rc.1' }), 'analyzing | v0.1.5-rc.1 · 正在分析新版本…',
      'analyzing 状态确实会渲染出「正在分析新版本…」（圆点档位 = analyzing）')
    assertEq(shot({ ok: true, hasUpdate: true, verdict: 'breaking', installed: '0.1.5-rc.1' }), 'breaking | v0.1.5-rc.1 · 兼容性问题', 'breaking 文案/档位')
    assertEq(shot({ ok: true, hasUpdate: true, installed: '0.1.5-rc.1' }), 'update | v0.1.5-rc.1 · 有新版本', 'update 文案/档位')
    assertEq(shot({ ok: true, checked: true, hasUpdate: false, installed: '0.1.5-rc.1' }), 'ok | v0.1.5-rc.1', '已是最新文案/档位')
  }

  // 2) 轮询时间线：抽真实的 startPoll / fetchState，用假定时器跑「点击 → 材料/扫描 → LLM → 判定」
  const sStart = src.indexOf('const startPoll = (f) => {')
  const sEnd = src.indexOf('const onClick = () => {', sStart)
  assert(sStart > 0 && sEnd > sStart, '能定位 startPoll/fetchState（锚点：const startPoll / const onClick）')
  if (sStart > 0 && sEnd > sStart) {
    let clock = 0
    let seq = 0
    const timers = new Map()
    const setIntervalFn = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms, next: clock + ms }); return id }
    const clearIntervalFn = (id) => { timers.delete(id) }
    const paints = []
    let server = { ok: true, status: 'idle', installed: '0.1.5-rc.1', hasUpdate: true, verdict: null }
    const call = () => Promise.resolve(server)
    const paint = (d) => paints.push(clock + ':' + d.status)
    const h = new Function('call', 'paint', 'setInterval', 'clearInterval', 'FAST_POLL_MS', 'NORMAL_POLL_MS', `
      let fast = false; let pollTimer = null; let analyzeUntil = 0;
      ${src.slice(sStart, sEnd)}
      return { startPoll, fetchState, fast: () => fast, guard: () => { analyzeUntil = Date.now() + 120000 }, unguard: () => { analyzeUntil = 0 } };
    `)(call, paint, setIntervalFn, clearIntervalFn, 1000, 60000)
    const tick = async (ms) => {
      const target = clock + ms
      for (;;) {
        let due = null
        for (const [id, timer] of timers) if (timer.next <= target && (due === null || timer.next < timers.get(due).next)) due = id
        if (due === null) break
        const timer = timers.get(due)
        clock = timer.next
        timer.next = clock + timer.ms
        timer.fn()
        for (let k = 0; k < 5; k++) await Promise.resolve()
      }
      clock = target
      for (let k = 0; k < 5; k++) await Promise.resolve()
    }
    h.guard()             // 点击：起「正在分析」守卫
    h.startPoll(true)     // 点击：切 1s 快轮询
    await tick(3000)      // 服务端拉 release/compare + L1 契约扫描（status 仍 idle）
    assertEq(paints, [], '材料/扫描阶段的陈旧 idle 响应不画（不会把「正在分析」打回去）')
    assertEq(h.fast(), true, '守卫期内不退回 60s 轮询（否则整个 analyzing 窗口会被跳过）')
    server = { ...server, status: 'analyzing' } // 服务端翻 analyzing 并返回响应
    h.unguard()
    await tick(1000)
    assertEq(paints, ['4000:analyzing'], '服务端一翻 analyzing，1s 轮询立刻画出')
    assertEq(h.fast(), true, 'LLM 阶段保持 1s 轮询')
    await tick(16000)
    server = { ...server, status: 'idle', verdict: 'breaking' } // LLM 完成，写回判定
    await tick(1000)
    assertEq(paints[paints.length - 1], '21000:idle', '判定写回后 1s 内更新文案（不必再等 60s）')
    assertEq(h.fast(), false, '分析结束自动降回 60s 轮询')
  }
  const clientText = readFileSync(LIB_CLIENT, 'utf8')
  assert(clientText.includes('paint({ ...(lastState ?? {}), ok: true, status: "analyzing" })'),
    '点击瞬间就切「正在分析」文案（不等服务端翻状态，也不再只把圆点置橙）')
  assert(clientText.includes('ANALYZE_GUARD_MS'), '守卫带上限，请求卡死时不会把灯永久钉在「正在分析」')
}

// ── 2) 路由表契约：routes.js 分发表 16 条固定 + client 引用 ⊆ 全集 ───────────
console.log('\n[路由表契约]')
{
  const tablePaths = ROUTES.map((r) => r.path)
  assertEq(tablePaths, SERVER_PATHS, 'routes.js 分发表路径 == 固定 16 条全集（顺序一致）')
  // 静态护栏：分发表必须真的被 handle 使用（防误删分发表只剩硬编码分支）
  const routesSrc = readFileSync(LIB_ROUTES, 'utf8')
  assert(/for \(const route of ROUTES\)/u.test(routesSrc), 'routes.js 内 handle 按 ROUTES 分发表分发')
  assert(/pathname === ROUTE_PREFIX \+ route\.path/u.test(routesSrc), 'routes.js 内按 ROUTE_PREFIX + route.path 匹配')
  const scanned = [...routesSrc.matchAll(/path: '(\/[a-z0-9/-]+)'/gu)].map((m) => m[1])
  assertEq(scanned, SERVER_PATHS, 'routes.js 源码字面路径（path: \'…\'）== 固定 16 条全集')
}
{
  const clientSrc = readFileSync(LIB_CLIENT, 'utf8')
  const refs = [...new Set([...clientSrc.matchAll(/["'](\/plugin-market\/[a-z0-9/-]+)["']/gu)].map((m) => m[1]))]
  const serverSet = new Set(SERVER_PATHS)
  // client 侧引用为完整路径（/plugin-market/xxx），服务端全集为相对 ROUTE_PREFIX 的后缀（/xxx）
  const orphans = refs.map((p) => p.replace(/^\/plugin-market/u, '')).filter((p) => !serverSet.has(p))
  assertEq(orphans, [], 'client.js 引用的路径 ⊆ 服务端全集（孤儿：' + JSON.stringify(orphans) + '）')
  console.log('      共 ' + refs.length + ' 个去重引用路径')
}

// client.js 语法护栏：浏览器脚本不经 node 加载，只有 --check 能提前拦截语法错误（P4 起）
{
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync(process.execPath, ['--check', LIB_CLIENT], { stdio: 'pipe' })
    console.log('  ok  lib/client.js 语法检查通过')
  } catch (error) {
    failures += 1
    console.error('FAIL  lib/client.js 语法检查失败：' + String(error?.stderr ?? error?.message ?? error).slice(0, 300))
  }
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exitCode = failures === 0 ? 0 : 1
