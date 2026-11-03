/**
 * 注入消息的来源标记。
 *
 * 两个功能共用同一个 `source.kind`：Chat 据此把消息渲染成「收到执行请求」的触发条目，
 * 而不是一条用户气泡。归属到功能的差别写在 `summary` 里（续跑是「…，继续」，监工是
 * 「…，<superviseText>」），聊天记录里一眼能看出是谁触发的。
 *
 * `kind` 是 merge-extensible 的字符串，本插件在自己的模块里声明，不需要宿主登记。
 */
const SOURCE_KIND = 'graceful-inject';

export { SOURCE_KIND };
