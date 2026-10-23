// 页面适配层：评论节点 → 观测。
//
// 规格里的适配层契约是「节点变成观测」与「指令变成 DOM 操作」两段，且不含任何判断
// 逻辑。本文件是第一段（节点 → 观测）；第二段（隐藏/标记）由 purge-controller 负责。
//
// 结构前提（逐层验证过，见 research/dom-findings.md §2）：
//
//   #commentapp > bili-comments            ← light DOM；data-params="1,<aid>"
//     └ #shadow-root
//        > #contents > #feed
//          > bili-comment-thread-renderer              ← 一条一级评论
//            └ #shadow-root
//               > bili-comment-renderer#comment
//                 └ #shadow-root
//                    > div#body
//                       > a#user-avatar[data-user-profile-id]   ← 作者 mid
//                       > div#main
//                          > div#header > bili-comment-user-info
//                            └ #shadow-root > div#info > div#user-name > a  ← 昵称
//                          > div#content > bili-rich-text
//                            └ #shadow-root > p#contents        ← 正文纯文本
//               > div#replies > bili-comment-replies-renderer   ← 楼中楼容器（在 thread 的 shadow 里）
//                 └ #shadow-root > div#expander > div#expander-contents
//                    > bili-comment-reply-renderer              ← 一条楼中楼
//                      └ #shadow-root > div#body > div#main > bili-comment-user-info / bili-rich-text
//
// 三条硬约束：
// 1) 普通 document.querySelector 一条评论都命中不到，必须逐层穿透 shadow root；
// 2) 页面 DOM 里没有 rpid，评论标识只能由 aid + mid + 正文合成（见 comment-key.js）；
// 3) 只读：本层不发任何请求、不改变站点状态、不翻页、不抓全量评论。

(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});
  var SEL = ns.selectors;
  var commentKey = ns.commentKey;

  // ok       = 正常解析
  // waiting  = 评论区还没到位（继续等，不是故障）
  // disabled = 结构性不可用（停用，并在徽标上给出可读提示）
  var STATUS = {
    OK: 'ok',
    NO_DOCUMENT: 'no-document',
    NO_COMMENT_APP: 'no-comment-app',
    NO_COMMENTS_HOST: 'no-comments-host',
    SHADOW_ROOT_UNAVAILABLE: 'shadow-root-unavailable',
    FEED_PENDING: 'feed-pending',
    NO_VIDEO_CONTEXT: 'no-video-context',
  };

  var STATUS_INFO = {};
  STATUS_INFO[STATUS.OK] = { state: 'ok', message: '' };
  STATUS_INFO[STATUS.NO_DOCUMENT] = {
    state: 'disabled',
    message: '读不到页面文档，插件已停用',
  };
  STATUS_INFO[STATUS.NO_COMMENT_APP] = {
    state: 'waiting',
    message: '等待评论区出现…',
  };
  STATUS_INFO[STATUS.NO_COMMENTS_HOST] = {
    state: 'waiting',
    message: '等待评论区组件加载…',
  };
  STATUS_INFO[STATUS.SHADOW_ROOT_UNAVAILABLE] = {
    state: 'disabled',
    message: '评论区 shadow root 不可达，插件已停用（页面结构可能已改版）',
  };
  STATUS_INFO[STATUS.FEED_PENDING] = {
    state: 'waiting',
    message: '等待评论流加载…',
  };
  STATUS_INFO[STATUS.NO_VIDEO_CONTEXT] = {
    state: 'disabled',
    message: '拿不到视频 aid，插件已停用',
  };

  function statusMessage(status) {
    var info = STATUS_INFO[status];
    return info ? info.message : '';
  }

  function statusState(status) {
    var info = STATUS_INFO[status];
    return info ? info.state : 'waiting';
  }

  function attr(el, name) {
    if (!el || typeof el.getAttribute !== 'function') {
      return null;
    }
    return el.getAttribute(name);
  }

  function shadowRootOf(el) {
    if (!el || typeof el !== 'object') {
      return null;
    }
    var shadow = el.shadowRoot;
    return shadow && typeof shadow.querySelector === 'function' ? shadow : null;
  }

  function textOf(node) {
    return node && typeof node.textContent === 'string' ? node.textContent : '';
  }

  function normalizeText(text) {
    return commentKey && commentKey.normalizeText ? commentKey.normalizeText(text) : String(text || '').trim();
  }

  // data-params 形如 "1,117457272440544"：第一段是内容类型（1=视频），第二段是 aid。
  function parseAid(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) {
      return null;
    }
    var parts = text.split(',');
    var aid = (parts.length > 1 ? parts[1] : parts[0]).trim();
    return /^[0-9]+$/.test(aid) ? aid : null;
  }

  // 兜底：从主页链接 //space.bilibili.com/<mid> 取 mid。
  function midFromHref(href) {
    var match = /space\.bilibili\.com\/([0-9]+)/.exec(String(href == null ? '' : href));
    return match ? match[1] : null;
  }

  // 站内切换视频后 data-params 里的 aid 不一定会更新（站点行为），但 canonical/og:url 会。
  // 这里只负责读出当前页面的 bvid，aid 是否过期交给调用方比对前后两次结果。
  function parseBvidFromUrl(url) {
    var match = /\/video\/(BV[0-9A-Za-z]{10})/.exec(String(url == null ? '' : url));
    return match ? match[1] : null;
  }

  function readBvid(doc) {
    if (!doc || typeof doc.querySelector !== 'function') {
      return null;
    }
    // 适配层承诺不抛异常：读不到 bvid 只是少一个「aid 是否过期」的判据，不该影响解析。
    try {
      var canonical = doc.querySelector(SEL.canonical);
      var bvid = parseBvidFromUrl(attr(canonical, 'href'));
      if (bvid) {
        return bvid;
      }
      var og = doc.querySelector(SEL.ogUrl);
      bvid = parseBvidFromUrl(attr(og, 'content'));
      if (bvid) {
        return bvid;
      }
    } catch (error) {
      return null;
    }
    return doc.location ? parseBvidFromUrl(doc.location.href) : null;
  }

  function findMid(body) {
    var avatar = body.querySelector(SEL.avatar);
    var mid = attr(avatar, SEL.attrProfileId);
    if (mid) {
      return String(mid);
    }

    var userInfo = body.querySelector(SEL.userInfo);
    var userInfoShadow = shadowRootOf(userInfo);
    if (userInfoShadow) {
      var nameEl = userInfoShadow.querySelector(SEL.userName);
      mid = attr(nameEl, SEL.attrProfileId);
      if (mid) {
        return String(mid);
      }
      mid = midFromHref(attr(userInfoShadow.querySelector(SEL.userNameLink), 'href'));
      if (mid) {
        return mid;
      }
    }

    // 最后兜底：结构变了但 data-user-profile-id 还在某处（就地扫一遍，不依赖属性选择器）
    if (typeof body.querySelectorAll === 'function') {
      var all = body.querySelectorAll('*');
      for (var i = 0; i < all.length; i += 1) {
        mid = attr(all[i], SEL.attrProfileId);
        if (mid) {
          return String(mid);
        }
      }
    }
    return null;
  }

  function findNickname(body) {
    var userInfo = body.querySelector(SEL.userInfo);
    var shadow = shadowRootOf(userInfo);
    if (shadow) {
      var link = shadow.querySelector(SEL.userNameLink);
      var fromLink = normalizeText(textOf(link));
      if (fromLink) {
        return fromLink;
      }
      var nameEl = shadow.querySelector(SEL.userName);
      var fromName = normalizeText(textOf(nameEl));
      if (fromName) {
        return fromName;
      }
    }
    return '';
  }

  // 正文只在 bili-rich-text 的 shadow root 里的 p#contents 上。
  // 取不到时返回 null（= 结构异常，交给调用方跳过该节点）。
  function findText(body) {
    var richText = body.querySelector(SEL.richText);
    if (!richText) {
      return null;
    }
    var shadow = shadowRootOf(richText);
    if (!shadow) {
      return null;
    }
    var contents = shadow.querySelector(SEL.richTextContents);
    if (!contents) {
      return null;
    }
    return normalizeText(textOf(contents));
  }

  // 操作栏（发布时间 / 点赞数）在 bili-comment-action-buttons-renderer 的 shadow root 里。
  function actionButtonsOf(body) {
    var shadow = shadowRootOf(body.querySelector(SEL.actionButtons));
    return shadow || null;
  }

  // 点赞数只按页面原文换算（如 676、1.2万）：认不出的形态一律 null，不估、不编。
  function parseCount(raw) {
    var text = normalizeText(raw).replace(/,/g, '');
    if (!text) {
      return null;
    }
    var match = /^([0-9]+(?:\.[0-9]+)?)\s*(万|w|W)?$/.exec(text);
    if (!match) {
      return null;
    }
    var value = Number(match[1]);
    if (!isFinite(value)) {
      return null;
    }
    return Math.round(match[2] ? value * 10000 : value);
  }

  // 发布时间是绝对时间文本「2026-10-21 09:24」，按本机时区解释成 Unix 秒（引擎契约口径）。
  // 不走 Date 的宽松解析：格式变了就返回 null，让「没有这份资料」显式留白。
  function parsePublishedAt(raw) {
    var text = normalizeText(raw);
    var match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2})/.exec(text);
    if (!match) {
      return null;
    }
    var stamp = new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), 0, 0,
    ).getTime();
    return isFinite(stamp) ? Math.floor(stamp / 1000) : null;
  }

  // 从评论主体（div#body 所在的树）解析出「作者 + 正文」。
  // 一级评论与楼中楼的差异只在 body 的来路，解析本身一致。
  function readComment(body) {
    if (!body) {
      return null;
    }
    var mid = findMid(body);
    if (!mid) {
      return null;
    }
    var text = findText(body);
    if (text === null) {
      return null;
    }
    var buttons = actionButtonsOf(body);
    return {
      mid: mid,
      nickname: findNickname(body),
      text: text,
      likeCount: buttons ? parseCount(textOf(buttons.querySelector(SEL.likeCount))) : null,
      publishedAt: buttons ? parsePublishedAt(textOf(buttons.querySelector(SEL.pubdate))) : null,
    };
  }

  function readBodyOf(commentHost) {
    var shadow = shadowRootOf(commentHost);
    if (!shadow) {
      return null;
    }
    return shadow.querySelector(SEL.body);
  }

  function makeKey(aid, mid, text, rootCommentKey) {
    return commentKey.buildKey({
      aid: aid,
      mid: mid,
      text: text,
      rootCommentKey: rootCommentKey || null,
    });
  }

  // 观测构造：DOM 字段 → 引擎契约（见 engine/README.md「观测契约」）。
  // 两处命名并存是有意的，不是重复：
  //   - mid 是扩展内部一直在用的字段名（记录、面板、状态存储都以它为准）；
  //   - authorMid 是引擎契约里的字段名，normalizeObservation 只认它。
  // 适配层正是「DOM → 引擎契约」的映射点，所以由这里同时产出两者；
  // 反过来让引擎去读 mid，会把引擎绑死在扩展的内部命名上（引擎还要供 CLI/数据集复用）。
  //
  // authorHistory 不在这里产出：它需要跨视频状态统计（本机历史），spec.md:216 允许该线索
  // 后续生效；engine/observation.js 的 normalizeHistory 对缺失字段返回 null，按首次安装处理，
  // 所以契约允许该字段缺失。
  function makeObservation(fields) {
    return {
      commentKey: fields.commentKey,
      aid: fields.aid,
      mid: fields.mid,
      authorMid: fields.mid,
      nickname: fields.nickname,
      text: fields.text,
      isReply: fields.isReply,
      rootCommentKey: fields.rootCommentKey,
      likeCount: fields.likeCount == null ? null : fields.likeCount,
      publishedAt: fields.publishedAt == null ? null : fields.publishedAt,
    };
  }

  function readReplyElement(replyEl, aid, rootCommentKey, result) {
    var body = readBodyOf(replyEl);
    if (!body) {
      result.skipped += 1;
      return;
    }
    var parsed = readComment(body);
    if (!parsed) {
      result.skipped += 1;
      return;
    }
    var key;
    try {
      key = makeKey(aid, parsed.mid, parsed.text, rootCommentKey);
    } catch (error) {
      result.skipped += 1;
      return;
    }
    var observation = makeObservation({
      commentKey: key,
      aid: aid,
      mid: parsed.mid,
      nickname: parsed.nickname,
      text: parsed.text,
      isReply: true,
      rootCommentKey: rootCommentKey,
      likeCount: parsed.likeCount,
      publishedAt: parsed.publishedAt,
    });
    result.observations.push(observation);
    if (result.withNodes) {
      result.entries.push({ observation: observation, node: replyEl, body: body });
    }
  }

  function readThread(threadEl, aid, result) {
    var threadShadow = shadowRootOf(threadEl);
    if (!threadShadow) {
      result.skipped += 1;
      return;
    }

    var commentHost = threadShadow.querySelector(SEL.commentRenderer) ||
      threadShadow.querySelector(SEL.commentRendererAny);
    if (!commentHost) {
      result.skipped += 1;
      return;
    }

    var commentBody = readBodyOf(commentHost);
    var parsed = readComment(commentBody);
    if (!parsed) {
      result.skipped += 1;
      return;
    }

    var rootKey;
    try {
      rootKey = makeKey(aid, parsed.mid, parsed.text, null);
    } catch (error) {
      result.skipped += 1;
      return;
    }

    var observation = makeObservation({
      commentKey: rootKey,
      aid: aid,
      mid: parsed.mid,
      nickname: parsed.nickname,
      text: parsed.text,
      isReply: false,
      // 一级评论「所属的一级评论」就是它自己，这样整串讨论可以按一个标识归并。
      rootCommentKey: rootKey,
      likeCount: parsed.likeCount,
      publishedAt: parsed.publishedAt,
    });
    result.observations.push(observation);
    if (result.withNodes) {
      result.entries.push({ observation: observation, node: threadEl, body: commentBody });
    }

    var repliesHost = threadShadow.querySelector(SEL.repliesInThread) ||
      threadShadow.querySelector(SEL.repliesRenderer);
    if (!repliesHost) {
      return;
    }
    var repliesShadow = shadowRootOf(repliesHost);
    if (!repliesShadow) {
      result.skipped += 1;
      return;
    }
    var list = repliesShadow.querySelector(SEL.expanderContents) || repliesShadow;
    if (!list || typeof list.querySelectorAll !== 'function') {
      result.skipped += 1;
      return;
    }
    var replies = list.querySelectorAll(SEL.replyRenderer);
    for (var i = 0; i < replies.length; i += 1) {
      try {
        readReplyElement(replies[i], aid, rootKey, result);
      } catch (error) {
        result.skipped += 1;
      }
    }
  }

  function buildResult(status, withNodes) {
    return {
      status: status || STATUS.OK,
      state: statusState(status || STATUS.OK),
      message: statusMessage(status || STATUS.OK),
      aid: null,
      bvid: null,
      observations: [],
      // entries 与 observations 一一对应，额外带可操作的评论节点与主体节点。
      // 只有 collectWithNodes 会填充；普通 collect 保持纯观测。
      entries: withNodes ? [] : undefined,
      withNodes: withNodes === true,
      threads: 0,
      replies: 0,
      total: 0,
      skipped: 0,
      selectorVersion: SEL ? SEL.VERSION : '',
    };
  }

  function finish(result, status) {
    result.status = status;
    result.state = statusState(status);
    result.message = statusMessage(status);
    result.threads = 0;
    result.replies = 0;
    result.total = 0;
    return result;
  }

  function findCommentApp(doc) {
    return doc && typeof doc.querySelector === 'function' ? doc.querySelector(SEL.commentApp) : null;
  }

  function findCommentsHost(doc) {
    var app = findCommentApp(doc);
    if (app) {
      var inApp = app.querySelector(SEL.commentsHost);
      if (inApp) {
        return inApp;
      }
    }
    return doc && typeof doc.querySelector === 'function' ? doc.querySelector(SEL.commentsHost) : null;
  }

  // 主入口：把当前评论区解析成观测列表。
  // 永不抛异常：结构性异常以 status 返回，单节点异常计入 skipped 后继续。
  function collectInternal(doc, withNodes) {
    var target = doc || (typeof document === 'undefined' ? null : document);
    var result = buildResult(STATUS.OK, withNodes);

    if (!target || typeof target.querySelector !== 'function') {
      return finish(result, STATUS.NO_DOCUMENT);
    }

    var host = findCommentsHost(target);
    if (!host) {
      return finish(result, findCommentApp(target) ? STATUS.NO_COMMENTS_HOST : STATUS.NO_COMMENT_APP);
    }

    var aid = parseAid(attr(host, SEL.attrParams));
    if (!aid) {
      return finish(result, STATUS.NO_VIDEO_CONTEXT);
    }
    result.aid = aid;
    result.bvid = readBvid(target);

    var hostShadow = shadowRootOf(host);
    if (!hostShadow) {
      return finish(result, STATUS.SHADOW_ROOT_UNAVAILABLE);
    }

    var feed = hostShadow.querySelector(SEL.feedInContents) || hostShadow.querySelector(SEL.feed);
    if (!feed) {
      return finish(result, STATUS.FEED_PENDING);
    }

    var threads = feed.querySelectorAll(SEL.thread);
    for (var i = 0; i < threads.length; i += 1) {
      try {
        readThread(threads[i], aid, result);
      } catch (error) {
        result.skipped += 1;
      }
    }

    for (var j = 0; j < result.observations.length; j += 1) {
      if (result.observations[j].isReply) {
        result.replies += 1;
      } else {
        result.threads += 1;
      }
    }
    result.total = result.observations.length;
    return result;
  }

  // 主入口（只读观测）：不返回节点引用，供判定与测试使用。
  function collect(doc) {
    return collectInternal(doc, false);
  }

  // 主入口（可操作）：观测之外并行返回 entries，供隐藏/标记层执行 DOM 操作。
  function collectWithNodes(doc) {
    return collectInternal(doc, true);
  }

  // 把 rootEl 以下（含自身）所有的 shadow root 收集出来，供内容脚本逐个挂观察点。
  // MutationObserver 不跨 shadow 边界，必须每个 root 各挂一个。
  function collectShadowRoots(rootEl, cap) {
    var roots = [];
    if (!rootEl) {
      return roots;
    }
    var limit = typeof cap === 'number' && cap > 0 ? cap : 20000;
    var queue = [rootEl];
    var visited = 0;

    while (queue.length) {
      var current = queue.shift();
      var shadow = shadowRootOf(current);
      if (shadow) {
        roots.push(shadow);
      }
      var scope = shadow || current;
      if (!scope || typeof scope.querySelectorAll !== 'function') {
        continue;
      }
      var all = scope.querySelectorAll('*');
      for (var i = 0; i < all.length; i += 1) {
        visited += 1;
        if (visited > limit) {
          return roots;
        }
        if (shadowRootOf(all[i])) {
          queue.push(all[i]);
        }
      }
    }
    return roots;
  }

  ns.pageAdapter = {
    STATUS: STATUS,
    statusMessage: statusMessage,
    statusState: statusState,
    collect: collect,
    collectWithNodes: collectWithNodes,
    collectShadowRoots: collectShadowRoots,
    findCommentsHost: findCommentsHost,
    findCommentApp: findCommentApp,
    parseAid: parseAid,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
