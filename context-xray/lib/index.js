// dsh-plugin-context-xray — 宿主端：注册 context_xray 工具。
//
// 工具让 agent 在会话里直接问「我这份上下文是被谁吃掉的、哪些从没被想起」。
// 分析对象默认是调用它的那个会话；也可以指定另一个活跃会话的 id。
//
// 口径与已知边界见 lib/mention.js 顶部注释——这里是提及度代理，不是注意力。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { analyzeMentions } from './mention.js';
import { renderReport } from './render.js';

const name = 'context-xray';
const inject = ['tools', 'sessions'];

const DESCRIPTION = `把当前会话的上下文拆成块（系统提示词、各类注入、用户消息、工具结果、你自己写进上下文的工具入参与回复正文），用各块的关键词在 reasoning 块里被提到了多少次做归因，输出来源占比、强度榜、时间分布与从未被提及的块。

这是**提及度代理，不是注意力**：它统计的是 reasoning 里提到了什么，不是计算时看了什么；任务主题会显著影响结果。关键词用 Intl.Segmenter 分词后过滤停用词，覆盖率与强度都做了长度归一化，原始提及次数保留作参考。

用于判断长会话里该压缩什么、哪些注入或工具结果值得保留、上下文结构是否失衡。`;

/**
 * 解析要分析的会话：默认调用方自己的会话，也接受显式 session id。
 * @param ctx - 宿主上下文（提供 sessions 服务）。
 * @param exec - 工具执行上下文。
 * @param requested - 调用方指定的会话 id，可省略。
 * @returns Session 实例。
 */
function resolveSession(ctx, exec, requested) {
  if (typeof requested === 'string' && requested !== '') {
    const session = ctx.sessions.get(requested);
    if (session === undefined) throw new Error(`没有 id 为 "${requested}" 的活跃会话；本工具只能分析当前已加载的会话，历史会话请用离线入口 tools/xray.mjs`);
    return session;
  }
  const session = exec.agent?.session;
  if (session === undefined) throw new Error('context_xray 需要一个所属 agent 会话，或显式传入 session');
  return session;
}

/**
 * 注册工具。
 * @param ctx - 宿主上下文。
 */
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'context_xray',
    description: DESCRIPTION,
    parameters: {
      session: { type: 'string', description: '要分析的会话 id；省略则分析当前会话' },
      limit: { type: 'integer', description: '强度榜条数，默认 12' },
      matrix: { type: 'integer', description: '关键词矩阵行数，默认 10' },
      minTerms: { type: 'integer', description: '进入强度榜的最小词数门槛，默认 20（词太少的块每词均值虚高）' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    execute(args, exec) {
      const session = resolveSession(ctx, exec, args.session);
      const report = analyzeMentions(session.snapshotEvents(), {
        matrixTerms: Math.min(Math.max(args.matrix ?? 10, 0), 200)
      });
      return renderReport(report, {
        limit: Math.min(Math.max(args.limit ?? 12, 1), 60),
        matrix: Math.min(Math.max(args.matrix ?? 10, 0), 200),
        minTerms: Math.max(args.minTerms ?? 20, 1),
        title: session.id
      });
    }
  }));
}

export { apply, inject, name };
