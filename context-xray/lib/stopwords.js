// dsh-plugin-context-xray — 停用词表。
//
// 分词之后必须过一遍这里，否则「的×553、是×191、the×293」这类虚词会淹没
// 真正有信息量的词。表分两部分：中文虚词与英文 stopwords，覆盖两种 reasoning
// 语言。调用方可以通过 options.stopwords 追加自己的排除词。

/** 中文虚词、代词、连词、常见动词，以及数量词。 */
const ZH = `的 了 是 我 你 他 她 它 们 在 有 和 就 不 都 也 这 那 但 而 与 或 个 之 其 为 以 及 对 从 到 会 能 要 说 被 把 给 让
一个 这个 那个 什么 怎么 如果 因为 所以 可以 需要 应该 已经 就是 但是 然后 现在 时候 里面 上面 下面 一些 这些 那些 我们 你们 他们 自己
没有 一下 可能 或者 只是 还是 这样 那样 的话 之一 之类 来 去 好 又 很 再 才 只 更 最 等 并 且 由 于 中 上 下 前 后 时 里 外
问 看 做 走 有 没 真 地 得 着 过 呢 吗 吧 啊 嗯 哦 呀 嘛 呗 的话 一样 一起 一直 一般 一定 有点 有些 不会 不能 不用 不是 不过 不再 不同
其实 其他 其中 以及 而且 而是 于是 因此 从而 总之 例如 比如 包括 关于 根据 通过 按照 作为 由于 为了 除了 无论 虽然 尽管 只要 只有 即使
只有 主要 直接 已经 正在 仍然 依然 通常 一般 往往 常常 经常 偶尔 大概 也许 或许 应该 必须 能够 愿意 打算 准备 尝试 继续 开始 结束
第一 第二 第三 最后 首先 其次 接着 下面 上面 前面 后面 左边 右边 已经够了`.split(/\s+/);

/** 英文 stopwords，够覆盖 reasoning 里混入的英文片段。 */
const EN = `the a an is are was were be been being of to in on at for with and or but if then this that these those it its as by from not no
do does did have has had i me my we our you your they their he she his her let lets can could should would will just so than there here when where
what which who how all any some more most other into out up down over under again further once only own same too very don now also may might must
about after before between during without within while because each both few many much such nor own's s t re ve ll d m
need needs needed through logic use used uses using get gets got make makes made see sees seen know known think want wants like way ways
thing things time times first last next new old good well back still even less part parts put take taken give given find finds found look looks looking
actually really probably maybe sure right wrong yes okay fine another others different instead however therefore though although since unless until
whether either neither per via etc eg ie
please cannot cant thanks thank hello hi lets saw`.split(/\s+/);

/** 全部停用词，小写形式；分词结果按小写比对。 */
export const STOPWORDS = new Set([...ZH, ...EN].filter((word) => word !== '').map((word) => word.toLowerCase()));

/**
 * 判定一个分词结果是否值得统计。
 * @param word - 分词得到的词。
 * @param minLength - 词长下限，默认 2（单字中文词基本都是虚词）。
 * @returns 是否保留。
 */
export function keep(word, minLength = 2) {
  if (word.length < minLength) return false;
  if (/^\d+$/.test(word)) return false;
  return !STOPWORDS.has(word.toLowerCase());
}
