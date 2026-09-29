// dsh-plugin-chat-rollback — tar `--exclude` 匹配引擎（纯函数，无 IO）。
// 从原单文件 index.js 拆出：快照清单、哈希清单与恢复剪枝三侧共用同一判定
// （isExcluded / findPruneExpr / tarExcludeArgs），保证对「哪些路径被排除」
// 与真实 bsdtar 的判定完全一致。matchPath / EXCLUDE_FLAGS 另供
// test/matcher-fuzz.mjs 做差分 fuzz（不再靠字符串截取 index.js）。
// ── tar --exclude 语义的忠实移植（libarchive __archive_pathmatch）────────
// bsdtar/gtar 的排除匹配（exclusion flag = PATHMATCH_NO_ANCHOR_START |
// PATHMATCH_NO_ANCHOR_END，见 libarchive archive_match.c）：
//   - 未锚定：模式在路径每个元素（/ 分隔处）逐一尝试，'^' 可锚定开头
//   - 未锚定结尾：'$' 可锚定结尾；模式耗尽时剩余 / 段被忽略（dir 匹配 dir/）
//   - '*' 跨 / 匹配任意串（尾随 '*' 恒成功），'?' 单字符，[...] 字符类
//     （'^'/'!' 取反、支持范围、'\]' 转义），'\\' 转义下一个字符
//   - 模式与路径两侧的前导 './' 都会被跳过
// 移植到 JS 是为了让 hash 清单、恢复剪枝与 tar 自身对「哪些路径被排除」的
// 判定完全一致——三者不一致时（旧实现的字面匹配 vs tar 通配），恢复剪枝会把
// tar 排除过但 JS 判定未排除的文件删掉。

/** shell 单引号转义（runSh 的命令体是 sh -c 字符串，排除模式必须引起来防
 * 通配符被 shell 展开）。纯字符串函数，随匹配引擎同文件（findPruneExpr 用它
 * 拼 find -name 剪枝参数；workspace.js 经此导入，供 tar/find 路径引用）。 */
function shq(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'";
}

const MATCH_MAX_RECURSION = 30;

/** pm_slashskip：跳过 '/', './', 结尾的 '.'（对应 C 的 pm_slashskip）。 */
function matchSlashskip(str, i) {
  while (i < str.length && (str[i] === '/' || (str[i] === '.' && (str[i + 1] === '/' || str[i + 1] === undefined)))) i += 1;
  return i;
}

/** pm_list：[...] 字符类匹配（对应 C 的 pm_list）。 */
function matchClass(p, start, end, c) {
  let i = start;
  let match = true;
  let nomatch = false;
  if (p[i] === '!' || p[i] === '^') { match = false; nomatch = true; i += 1; }
  let rangeStart = null;
  while (i < end) {
    let nextRangeStart = null;
    const ch = p[i];
    if (ch === '-') {
      if (rangeStart === null || i === end - 1) {
        if (ch === c) return match;
      } else {
        let rangeEnd = p[++i];
        if (rangeEnd === '\\') rangeEnd = p[++i];
        if (rangeStart <= c && c <= rangeEnd) return match;
      }
    } else if (ch === '\\') {
      i += 1;
      if (p[i] === c) return match;
      nextRangeStart = p[i];
    } else {
      if (ch === c) return match;
      nextRangeStart = ch;
    }
    rangeStart = nextRangeStart;
    i += 1;
  }
  return nomatch;
}

/** pm：核心 glob 匹配（对应 C 的 pm；si 为字符串起始下标，piStart 为模式
 * 起始下标——'*' 回溯递归必须从消费后的位置继续，否则同一 '*' 被反复重入）。 */
function matchPmAt(p, s, si, flags, depth, piStart = 0) {
  if (depth > MATCH_MAX_RECURSION) return -1;
  let pi = piStart;
  if (s[si] === '.' && s[si + 1] === '/') si = matchSlashskip(s, si + 1);
  if (p[pi] === '.' && p[pi + 1] === '/') pi = matchSlashskip(p, pi + 1);
  for (;;) {
    if (pi >= p.length) {
      if (s[si] === '/') {
        if (flags.noAnchorEnd) return 1;
        si = matchSlashskip(s, si);
      }
      return si >= s.length;
    }
    const ch = p[pi];
    if (ch === '?') {
      if (si >= s.length) return 0;
    } else if (ch === '*') {
      while (p[pi] === '*') pi += 1;
      if (pi >= p.length) return 1; // 尾随 '*' 恒成功
      let s2 = si;
      while (s2 < s.length) {
        const r = matchPmAt(p, s, s2, flags, depth + 1, pi);
        if (r) return r;
        s2 += 1;
      }
      return 0;
    } else if (ch === '[') {
      let end = pi + 1;
      while (end < p.length && p[end] !== ']') {
        if (p[end] === '\\' && end + 1 < p.length) end += 1;
        end += 1;
      }
      if (end < p.length && p[end] === ']') {
        // 注意：不守卫 si >= s.length——macOS 系统 libarchive（Apple 分支）
        // 在字符串耗尽时仍执行字符类判定，否定类 [!a] 因而匹配已耗尽的串
        // （实测 `log[!a]` 排除 `log`）；保持一致才能三侧判定统一。
        if (!matchClass(p, pi + 1, end, s[si])) return 0;
        pi = end; // 由循环尾部的 ++ 越过 ']'
      } else {
        // 无闭合 ']'：按字面 '['
        if (p[pi] !== s[si]) return 0;
      }
    } else if (ch === '\\') {
      if (pi + 1 >= p.length) {
        if (s[si] !== '\\') return 0; // 尾随反斜杠匹配自身
      } else {
        pi += 1;
        if (p[pi] !== s[si]) return 0;
      }
    } else if (ch === '/') {
      if (s[si] !== '/' && si < s.length) return 0;
      pi = matchSlashskip(p, pi);
      si = matchSlashskip(s, si);
      if (pi >= p.length && flags.noAnchorEnd) return 1;
      pi -= 1; // 抵消循环尾部的 ++
      si -= 1;
    } else if (ch === '$') {
      if (pi + 1 >= p.length && flags.noAnchorEnd) {
        return matchSlashskip(s, si) >= s.length;
      }
      if (p[pi] !== s[si]) return 0;
    } else {
      if (p[pi] !== s[si]) return 0;
    }
    pi += 1;
    si += 1;
  }
}

/** __archive_pathmatch：未锚定模式下模式在每个路径元素起点逐一尝试。 */
function matchPath(pattern, str, flags) {
  if (pattern === null || pattern === undefined || pattern.length === 0) return str === null || str === undefined || str.length === 0;
  if (str === null || str === undefined) return false;
  if (flags.noAnchorStart && pattern[0] === '^') {
    pattern = pattern.slice(1);
    flags = { noAnchorStart: false, noAnchorEnd: flags.noAnchorEnd };
  }
  if (pattern[0] === '/' && str[0] !== '/') return false;
  if (pattern[0] === '*' || pattern[0] === '/') {
    let pi = 0;
    let si = 0;
    while (pattern[pi] === '/') pi += 1;
    while (str[si] === '/') si += 1;
    return matchPmAt(pattern, str, si, flags, 0, pi);
  }
  if (flags.noAnchorStart) {
    let si = 0;
    for (;;) {
      if (str[si] === '/') si += 1;
      const r = matchPmAt(pattern, str, si, flags, 0);
      if (r) return r;
      const idx = str.indexOf('/', si);
      if (idx === -1) break;
      si = idx;
    }
    return 0;
  }
  return matchPmAt(pattern, str, 0, flags, 0);
}

/** 排除匹配的 flags（与 libarchive 排除侧一致：两头都不锚定）。 */
const EXCLUDE_FLAGS = { noAnchorStart: true, noAnchorEnd: true };

/** 判断相对路径是否命中任一排除项：语义与 tar --exclude 完全一致（见 matchPath）。
 * hash、tar 快照、恢复剪枝共用同一判定，保证三者对"哪些文件属于工作目录"一致。 */
function isExcluded(rel, excludes) {
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (name === '') continue;
    // 无元字符**且无斜杠**的裸模式（默认的 .git / node_modules 即此类）：
    // 未锚定语义等价于「任一路径段 === name」。先 includes 粗筛再 split 精确
    // 比对，避免为每个文件做 pm 回溯；命中即排除。含 / 或元字符（* ? [ ] \ ^ $）
    // 的模式必须走完整 matchPath——快路径的 split 会把 'build/output' 拆成两段，
    // 无法匹配跨段模式。
    if (!/[/*?\[\]\\^$]/.test(name)) {
      if (rel.includes(name) && rel.split('/').includes(name)) return true;
      continue;
    }
    if (matchPath(name, rel, EXCLUDE_FLAGS)) return true;
  }
  return false;
}

/** find 剪枝表达式：仅对 find -name 能安全处理的模式（不含 /、^、$、\）做
 * 目录剪枝以加速遍历；其余模式交给 isExcluded（matchPath）后置过滤，二者
 * 最终判定一致。快照清单与哈希清单共用同一表达式。 */
function findPruneExpr(excludes) {
  const args = [];
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    // find -name 的字符类语义与 libarchive 的 pm 存在细微分歧（无闭合 ']'、
    // 类内转义等），剪枝过头 = 快照/hash 漏文件。含 '[' 的模式一律不剪枝，
    // 交给 isExcluded（matchPath）后置过滤兜底，最终判定仍与 tar 一致。
    if (name === '' || /[/^$\\\[]/.test(name)) continue;
    args.push('-name ' + shq(name) + ' -prune');
  }
  return args.length > 0 ? args.join(' -o ') + ' -o ' : '';
}

/** 由排除项生成 tar --exclude 参数：只传裸模式。tar 的排除匹配本身就是
 * 未锚定、按路径元素尝试的 glob（见 matchPath 移植说明），「星号斜杠 P」、
 * 「点斜杠 P」等旧式变体在 libarchive 语义下既多余又会引入歧义（如 "./.*"
 * 被归一化后等价于裸 ".*"）。全部单引号包裹防 shell 展开。 */
function tarExcludeArgs(excludes) {
  const args = [];
  for (const pattern of excludes) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (name === '') continue;
    args.push('--exclude=' + shq(name));
  }
  return args.join(' ');
}


export { matchPath, EXCLUDE_FLAGS, isExcluded, findPruneExpr, tarExcludeArgs, shq };
