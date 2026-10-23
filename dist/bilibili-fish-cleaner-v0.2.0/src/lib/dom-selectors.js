// 页面结构假设的唯一出处。
//
// 规格要求「选择器与结构假设集中在一处并带版本标识」：站点改版时只改本文件，
// 其他模块里不允许出现选择器字面量。
//
// 所有选择器都在真实渲染页面的快照上验证过（见 research/dom-findings.md §3）。

(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});

  var VERSION = 'v1';

  ns.selectors = {
    VERSION: VERSION,

    // 评论区外壳（light DOM）
    commentApp: '#commentapp',
    commentsHost: 'bili-comments',

    // bili-comments 的 shadow root 内
    contents: '#contents',
    feed: '#feed',
    feedInContents: '#contents #feed',
    limitMask: '#limit-mask',

    // 一级评论
    thread: 'bili-comment-thread-renderer',
    commentRenderer: 'bili-comment-renderer#comment',
    commentRendererAny: 'bili-comment-renderer',

    // 评论主体（一级评论与楼中楼共用）
    body: 'div#body',
    avatar: 'a#user-avatar',
    userInfo: 'bili-comment-user-info',
    userName: '#user-name',
    userNameLink: '#user-name a',
    richText: 'bili-rich-text',
    richTextContents: 'p#contents',

    // 操作栏：发布时间与点赞数都在它的 shadow root 里。注意 #count 在 #like 的 button 内层，
    // 不是 #like 的直接子节点（见 research/dom-findings.md 第 19、20 行）。
    actionButtons: 'bili-comment-action-buttons-renderer',
    pubdate: '#pubdate',
    likeCount: '#like #count',

    // 楼中楼：容器在 thread 的 shadow root 里，不在 comment 的 shadow root 里
    repliesInThread: '#replies bili-comment-replies-renderer',
    repliesRenderer: 'bili-comment-replies-renderer',
    expanderContents: '#expander-contents',
    replyRenderer: 'bili-comment-reply-renderer',

    // 属性
    attrProfileId: 'data-user-profile-id',
    attrParams: 'data-params',

    // 站内切换视频时，data-params 里的 aid 会被站点留在上一个视频（实测见 research/dom-findings.md），
    // 只有 canonical / og:url 会跟着换。所以 bvid 单独从这里读，用来识别 aid 是否已经过期。
    canonical: 'link[rel="canonical"]',
    ogUrl: 'meta[property="og:url"]',
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
