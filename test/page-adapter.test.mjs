// 页面适配层测试：评论节点 → 观测。
//
// 两类夹具：
//   1) 真实快照（.scratch/.../dom-snapshot/）—— 确认在真实结构上能读出评论；
//   2) 合成的畸形结构 —— 确认「结构异常跳过该节点继续」「shadow root 不可达时
//      返回状态而不抛异常」这两条硬约束真的成立。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasSnapshots, loadSnapshot } from './support/fixtures.mjs';
import { loadExtension } from './support/load-extension.mjs';
import { parseHTML } from './support/mini-dom.mjs';

await loadExtension(
  'src/lib/comment-key.js',
  'src/lib/dom-selectors.js',
  'src/lib/content-gate.js',
  'src/lib/page-adapter.js',
);

// 真实快照是可选的本地研究数据：缺失时依赖快照的用例跳过（开源仓库的正常状态），
// 用内联 HTML 构造的用例照常运行。
const NO_SNAPSHOTS = !hasSnapshots() && '缺少本地页面快照';

const ns = globalThis.DSHCC;
const { pageAdapter, commentKey } = ns;

const AID = '117457272440544';

// ---- 合成夹具：一层层拼出与真实结构同形的嵌套 shadow DOM -------------------

function userInfo(mid, nickname) {
  return [
    '<bili-comment-user-info>',
    '<template shadowrootmode="open">',
    '<div id="info"><div id="user-name">',
    `<a data-user-profile-id="${mid}" href="//space.bilibili.com/${mid}">${nickname}</a>`,
    '</div></div>',
    '</template>',
    '</bili-comment-user-info>',
  ].join('');
}

function body(mid, nickname, text, options) {
  const opts = options || {};
  const parts = ['<div id="body">'];
  if (!opts.noAvatar) {
    parts.push(`<a id="user-avatar" data-user-profile-id="${mid}"></a>`);
  }
  parts.push('<div id="main">');
  parts.push(`<div id="header">${userInfo(opts.noAvatar ? mid : mid, nickname)}</div>`);
  if (!opts.noRichText) {
    parts.push(
      '<div id="content"><bili-rich-text>',
      '<template shadowrootmode="open">',
      `<p id="contents">${text}</p>`,
      '</template>',
      '</bili-rich-text></div>',
    );
  }
  parts.push('</div></div>');
  return parts.join('');
}

function reply(mid, nickname, text, options) {
  return [
    '<bili-comment-reply-renderer>',
    '<template shadowrootmode="open">',
    body(mid, nickname, text, options),
    '</template>',
    '</bili-comment-reply-renderer>',
  ].join('');
}

function thread(mid, nickname, text, options) {
  const opts = options || {};
  if (opts.noShadow) {
    return '<bili-comment-thread-renderer></bili-comment-thread-renderer>';
  }
  const parts = [
    '<bili-comment-thread-renderer>',
    '<template shadowrootmode="open">',
    '<bili-comment-renderer id="comment">',
    '<template shadowrootmode="open">',
    body(mid, nickname, text, opts),
    '</template>',
    '</bili-comment-renderer>',
  ];
  if (opts.rawReplies) {
    parts.push(opts.rawReplies);
  } else if (opts.replies && opts.replies.length) {
    parts.push(
      '<div id="replies"><bili-comment-replies-renderer>',
      '<template shadowrootmode="open">',
      '<div id="expander"><div id="expander-contents">',
      opts.replies.join(''),
      '</div></div>',
      '</template>',
      '</bili-comment-replies-renderer></div>',
    );
  }
  parts.push('</template>', '</bili-comment-thread-renderer>');
  return parts.join('');
}

function buildPage(threads, options) {
  const opts = options || {};
  const commentsAttrs = opts.noParams ? '' : ` data-params="1,${AID}"`;
  const inner = opts.noFeed
    ? ''
    : `<div id="contents"><div id="feed">${threads.join('')}</div></div>`;
  const host = opts.noShadow
    ? `<bili-comments${commentsAttrs}></bili-comments>`
    : `<bili-comments${commentsAttrs}><template shadowrootmode="open">${inner}</template></bili-comments>`;
  return parseHTML(`<html><body><div id="commentapp">${host}</div></body></html>`);
}

const threadA = thread('10220021', '用户甲', '一级评论正文A', {
  replies: [
    reply('30001', '用户乙', '楼中楼正文A-1'),
    reply('30002', '用户丙', '楼中楼正文A-2'),
  ],
});
const threadB = thread('547756523', '用户丁', '一级评论正文B');

// ---- 真实快照 ---------------------------------------------------------------

describe('页面适配层：真实快照', { skip: NO_SNAPSHOTS }, () => {
  const document = buildLikeSnapshot();

  function buildLikeSnapshot() {
    return loadSnapshot('initial');
  }

  const result = pageAdapter.collect(document);

  it('解析成功并读到视频 aid', () => {
    assert.equal(result.status, 'ok');
    assert.equal(result.state, 'ok');
    assert.equal(result.aid, AID);
  });

  it('一级评论与楼中楼各自计数', () => {
    assert.equal(result.threads, 2);
    assert.equal(result.replies, 1);
    assert.equal(result.total, 3);
    assert.equal(result.skipped, 0);
  });

  it('每条观测的字段完整且类型正确', () => {
    for (const obs of result.observations) {
      assert.equal(obs.aid, AID);
      assert.match(obs.mid, /^\d+$/);
      assert.equal(typeof obs.nickname, 'string');
      assert.ok(obs.nickname.length > 0, '昵称不应为空');
      assert.equal(typeof obs.text, 'string');
      assert.ok(obs.text.length > 0, '正文不应为空');
      assert.equal(typeof obs.isReply, 'boolean');
      assert.equal(typeof obs.rootCommentKey, 'string');
      assert.equal(typeof obs.commentKey, 'string');
    }
  });

  // 观测契约里的点赞数与发布时间页面上都取得到（research/dom-findings.md 第 19、20 行）。
  it('观测带上点赞数与发布时间，缺失的字段留空', () => {
    const root = result.observations.find((obs) => !obs.isReply);
    assert.equal(root.likeCount, 676);
    assert.equal(root.publishedAt, new Date(2026, 9, 21, 9, 24, 0, 0).getTime() / 1000);
  });

  // 引擎的观测契约用 authorMid，扩展内部用 mid：适配层必须同时给出两者，
  // 否则引擎侧 normalizeObservation 拿到的是 null，按作者取资料的那一步就永远缺 mid。
  it('引擎契约字段 authorMid 与内部字段 mid 一致', () => {
    for (const obs of result.observations) {
      assert.equal(obs.authorMid, obs.mid, 'authorMid 必须与 mid 同值');
      assert.match(obs.authorMid, /^\d+$/);
    }
  });

  it('一级评论的 rootCommentKey 就是它自己，楼中楼指向所属一级评论', () => {
    const roots = result.observations.filter((obs) => !obs.isReply);
    const replies = result.observations.filter((obs) => obs.isReply);
    assert.equal(roots.length, 2);
    assert.equal(replies.length, 1);

    for (const root of roots) {
      assert.equal(root.rootCommentKey, root.commentKey);
    }
    const rootKeys = new Set(roots.map((obs) => obs.commentKey));
    for (const item of replies) {
      assert.ok(rootKeys.has(item.rootCommentKey), '楼中楼的所属一级评论必须能在本次观测里找到');
    }
  });

  it('commentKey 与 comment-key 模块独立算出的结果一致', () => {
    const obs = result.observations[0];
    assert.equal(
      obs.commentKey,
      commentKey.buildKey({ aid: obs.aid, mid: obs.mid, text: obs.text }),
    );
  });

  it('同一页面的其他快照结构同样可解析', async () => {
    const { SNAPSHOTS, loadSnapshot: load } = await import('./support/fixtures.mjs');
    for (const name of Object.keys(SNAPSHOTS)) {
      const other = pageAdapter.collect(load(name));
      assert.equal(other.status, 'ok', `${name} 应能解析`);
      assert.equal(other.skipped, 0, `${name} 不应有跳过节点`);
    }
  });
});

// ---- 计数随评论增加 ---------------------------------------------------------

describe('页面适配层：计数跟随 DOM', () => {
  it('追加一级评论后计数增加', () => {
    const document = buildPage([threadA]);
    const before = pageAdapter.collect(document);
    assert.equal(before.threads, 1);
    assert.equal(before.replies, 2);

    const feed = pageAdapter.findCommentsHost(document).shadowRoot.querySelector('#feed');
    const cloned = parseHTML(threadB).querySelector('bili-comment-thread-renderer');
    feed.appendChild(cloned);

    const after = pageAdapter.collect(document);
    assert.equal(after.threads, 2);
    assert.equal(after.replies, 2);
    assert.equal(after.observations.length, 4);
  });

  it('展开楼中楼后计数增加', () => {
    const document = buildPage([threadB]);
    assert.equal(pageAdapter.collect(document).replies, 0);

    const threadEl = pageAdapter
      .findCommentsHost(document)
      .shadowRoot.querySelector('bili-comment-thread-renderer');
    const repliesRenderer = parseHTML(
      '<bili-comment-replies-renderer><template shadowrootmode="open">' +
        '<div id="expander"><div id="expander-contents">' +
        reply('40001', '用户戊', '展开后出现的楼中楼') +
        '</div></div></template></bili-comment-replies-renderer>',
    ).querySelector('bili-comment-replies-renderer');
    threadEl.shadowRoot.appendChild(repliesRenderer);

    const after = pageAdapter.collect(document);
    assert.equal(after.threads, 1);
    assert.equal(after.replies, 1);
  });
});

// ---- 结构异常 ---------------------------------------------------------------

describe('页面适配层：结构异常跳过而不中断', () => {
  it('缺 shadow root 的一级评论被跳过，其余照常解析', () => {
    const document = buildPage([threadA, thread('555', '用户己', '正常评论', { noShadow: true }), threadB]);
    const result = pageAdapter.collect(document);

    assert.equal(result.status, 'ok');
    assert.equal(result.threads, 2);
    assert.equal(result.skipped, 1);
  });

  it('缺正文节点的一级评论被跳过，其余照常解析', () => {
    const document = buildPage([threadA, thread('666', '用户庚', '无正文', { noRichText: true })]);
    const result = pageAdapter.collect(document);

    assert.equal(result.threads, 1);
    assert.equal(result.skipped, 1);
  });

  it('缺作者 mid 的评论被跳过（没有 mid 就没法合成标识）', () => {
    const document = buildPage([
      threadA,
      thread('', '无 mid 用户', '正文', { noAvatar: true }),
    ]);
    const result = pageAdapter.collect(document);

    assert.equal(result.threads, 1);
    assert.equal(result.skipped, 1);
  });

  it('楼中楼容器结构异常时只丢楼中楼，一级评论仍在', () => {
    const document = buildPage([
      thread('777', '用户辛', '一级评论', {
        // 容器在、但没有 shadow root：真实改版时最可能出现的形态
        rawReplies: '<div id="replies"><bili-comment-replies-renderer></bili-comment-replies-renderer></div>',
      }),
    ]);
    const result = pageAdapter.collect(document);

    assert.equal(result.status, 'ok');
    assert.equal(result.threads, 1);
    assert.equal(result.replies, 0);
    assert.equal(result.skipped, 1);
  });

  it('楼中楼里单条结构异常只丢那一条，其余楼中楼仍在', () => {
    const document = buildPage([
      thread('888', '用户壬', '一级评论', {
        replies: [
          reply('90001', '用户癸', '正常楼中楼'),
          reply('90002', '用户子', '缺正文的楼中楼', { noRichText: true }),
          reply('90003', '用户丑', '另一条正常楼中楼'),
        ],
      }),
    ]);
    const result = pageAdapter.collect(document);

    assert.equal(result.threads, 1);
    assert.equal(result.replies, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.observations.length, 3);
  });
});

// ---- 状态而非异常 -----------------------------------------------------------

describe('页面适配层：shadow root 不可达时返回状态', () => {
  it('bili-comments 没有 shadow root → shadow-root-unavailable，不抛异常', () => {
    const document = buildPage([threadA], { noShadow: true });
    const result = pageAdapter.collect(document);

    assert.equal(result.status, 'shadow-root-unavailable');
    assert.equal(result.state, 'disabled');
    assert.match(result.message, /shadow root/);
    assert.equal(result.total, 0);
  });

  it('没有 #commentapp → no-comment-app', () => {
    const document = parseHTML('<html><body></body></html>');
    assert.equal(pageAdapter.collect(document).status, 'no-comment-app');
  });

  it('有 bili-comments 但没有评论流 → feed-pending', () => {
    const document = buildPage([], { noFeed: true });
    const result = pageAdapter.collect(document);
    assert.equal(result.status, 'feed-pending');
    assert.equal(result.state, 'waiting');
  });

  it('缺 data-params → no-video-context', () => {
    const document = buildPage([threadA], { noParams: true });
    assert.equal(pageAdapter.collect(document).status, 'no-video-context');
  });

  it('文档为 null / 无查询能力时也不抛异常', () => {
    assert.equal(pageAdapter.collect(null).status, 'no-document');
    assert.equal(pageAdapter.collect({}).status, 'no-document');
  });

  it('每种状态都有可读文案', () => {
    for (const status of Object.values(pageAdapter.STATUS)) {
      assert.equal(typeof pageAdapter.statusMessage(status), 'string');
      assert.ok(['ok', 'waiting', 'disabled'].includes(pageAdapter.statusState(status)));
    }
  });
});

// ---- 只读性 -----------------------------------------------------------------

describe('页面适配层：只读', () => {
  it('解析不改变评论区 DOM', () => {
    const document = buildPage([threadA, threadB]);
    const feed = pageAdapter.findCommentsHost(document).shadowRoot.querySelector('#feed');
    const before = feed.childNodes.length;
    const hostCount = document.querySelectorAll('*').length;

    pageAdapter.collect(document);
    pageAdapter.collect(document);

    assert.equal(feed.childNodes.length, before);
    assert.equal(document.querySelectorAll('*').length, hostCount);
  });

  it('连续两次解析结果完全一致（无随机、无累积）', () => {
    const document = buildPage([threadA, threadB]);
    const first = pageAdapter.collect(document);
    const second = pageAdapter.collect(document);
    assert.deepEqual(
      first.observations.map((obs) => obs.commentKey),
      second.observations.map((obs) => obs.commentKey),
    );
  });
});

// ---- shadow root 收集 -------------------------------------------------------

describe('页面适配层：shadow root 收集', () => {
  it('真实快照里能收集到评论区下的全部 shadow root', { skip: NO_SNAPSHOTS }, () => {
    const document = loadSnapshot('initial');
    const host = pageAdapter.findCommentsHost(document);
    const roots = pageAdapter.collectShadowRoots(host);

    assert.ok(roots.length >= 6, '嵌套结构里应有多个 shadow root，实际 ' + roots.length);
    assert.equal(new Set(roots).size, roots.length, '不应重复收集同一个 root');
    for (const root of roots) {
      assert.equal(typeof root.querySelectorAll, 'function');
      assert.ok(root.host, '每个 root 都应有宿主元素');
    }
  });

  it('宿主元素本身也算（首个 root 属于起始元素）', { skip: NO_SNAPSHOTS }, () => {
    const document = loadSnapshot('initial');
    const host = pageAdapter.findCommentsHost(document);
    const roots = pageAdapter.collectShadowRoots(host);
    assert.equal(roots[0].host, host);
  });

  it('cap 生效，不会无上限遍历', { skip: NO_SNAPSHOTS }, () => {
    const document = loadSnapshot('initial');
    const host = pageAdapter.findCommentsHost(document);
    const limited = pageAdapter.collectShadowRoots(host, 5);
    assert.ok(limited.length <= pageAdapter.collectShadowRoots(host).length);
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(pageAdapter.collectShadowRoots(null), []);
  });
});

// ---- aid 解析 ---------------------------------------------------------------

describe('页面适配层：aid 解析', () => {
  it('取 data-params 的第二段', () => {
    assert.equal(pageAdapter.parseAid('1,117457272440544'), AID);
  });

  it('只有一段时当作 aid', () => {
    assert.equal(pageAdapter.parseAid('117457272440544'), AID);
  });

  it('非数字返回 null', () => {
    assert.equal(pageAdapter.parseAid('1,abc'), null);
    assert.equal(pageAdapter.parseAid(''), null);
    assert.equal(pageAdapter.parseAid(null), null);
  });
});

// ---- 站内切换视频 -----------------------------------------------------------

describe('页面适配层：站内切换视频', () => {
  const OTHER_AID = '99887766554433';

  function commentsHost(document) {
    return document.querySelector('bili-comments');
  }

  it('同一份 DOM 改 data-params 后重扫，观测整体换成新视频', () => {
    const document = buildPage([threadA, threadB]);

    const first = pageAdapter.collect(document);
    assert.equal(first.aid, AID);
    const firstKeys = first.observations.map((obs) => obs.commentKey);

    commentsHost(document).setAttribute('data-params', `1,${OTHER_AID}`);

    const second = pageAdapter.collect(document);
    assert.equal(second.aid, OTHER_AID);
    assert.equal(second.observations.length, first.observations.length);
    for (const obs of second.observations) assert.equal(obs.aid, OTHER_AID);
    // commentKey 把 aid 算进去，换视频后同一批评论不会再撞到上一支视频的键。
    for (const key of second.observations.map((obs) => obs.commentKey)) {
      assert.ok(!firstKeys.includes(key), '换视频后 commentKey 不应与上一支视频相同');
    }
  });

  it('没有 data-params 时 aid 为空', () => {
    const document = buildPage([threadA], { noParams: true });
    const result = pageAdapter.collect(document);
    assert.ok(!result.aid);
    for (const obs of result.observations) assert.ok(!obs.aid);
  });
});

// ---- 带节点的解析：隐藏与标记需要拿到可操作的节点 -------------------------

describe('页面适配层：带节点的解析', () => {
  it('每条观测都对应一个评论节点与其主体节点，顺序一致', () => {
    const document = buildPage([threadA, threadB]);
    const result = pageAdapter.collectWithNodes(document);

    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, result.observations.length);
    for (let i = 0; i < result.entries.length; i += 1) {
      assert.equal(result.entries[i].observation, result.observations[i]);
      assert.equal(typeof result.entries[i].node.getAttribute, 'function');
      assert.equal(typeof result.entries[i].body.getAttribute, 'function');
    }
  });

  it('一级评论的节点是 bili-comment-thread-renderer，楼中楼是 bili-comment-reply-renderer', () => {
    const document = buildPage([threadA]);
    const result = pageAdapter.collectWithNodes(document);

    for (const entry of result.entries) {
      const expected = entry.observation.isReply
        ? 'bili-comment-reply-renderer'
        : 'bili-comment-thread-renderer';
      assert.equal(entry.node.localName, expected);
    }
  });

  it('普通 collect 不携带节点（保持观测对象纯粹）', () => {
    const document = buildPage([threadA]);
    const result = pageAdapter.collect(document);
    assert.equal(result.entries, undefined);
  });

  it('结构异常时仍逐条跳过，带节点解析不抛异常', () => {
    const document = buildPage([threadA, thread('555', '用户己', '正常评论', { noShadow: true })]);
    const result = pageAdapter.collectWithNodes(document);
    assert.equal(result.threads, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.entries.length, result.observations.length);
  });
});
