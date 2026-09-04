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

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIB_ROUTES = join(__dirname, '..', 'lib', 'routes.js')
const LIB_CLIENT = join(__dirname, '..', 'lib', 'client.js')

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
