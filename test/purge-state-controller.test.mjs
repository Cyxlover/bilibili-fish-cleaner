// 控制器接入状态机：规则、手动、账号三个来源互不误伤。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';
import { parseHTML } from './support/mini-dom.mjs';

await loadExtension(
  'src/lib/purge-state.js',
  'src/lib/purge-marker.js',
  'src/lib/purge-records.js',
  'src/lib/purge-controller.js',
);
const { purgeState, purgeMarker, purgeRecords, purgeController } = globalThis.DSHCC;

function memorySettings(initial) {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => { value = next; },
    subscribe: () => () => {},
  };
}

function memoryStateStore(initial) {
  let value = purgeState.normalize(initial || purgeState.create());
  return {
    load: async () => value,
    save: async (next) => { value = purgeState.normalize(next); return true; },
    current: () => value,
  };
}

function fixture() {
  const doc = parseHTML([
    '<html><body><div id="commentapp"><bili-comments>',
    '<template shadowrootmode="open"><div id="feed">',
    '<bili-comment-thread-renderer id="t1"><div id="body">规则命中</div></bili-comment-thread-renderer>',
    '<bili-comment-thread-renderer id="t2"><div id="body">手动隐藏</div></bili-comment-thread-renderer>',
    '<bili-comment-thread-renderer id="t3"><div id="body">账号维度</div></bili-comment-thread-renderer>',
    '</div></template>',
    '</bili-comments></div></body></html>',
  ].join(''));
  const feed = doc.querySelector('bili-comments').shadowRoot.querySelector('#feed');
  const t1 = feed.querySelector('#t1');
  const t2 = feed.querySelector('#t2');
  const t3 = feed.querySelector('#t3');
  return {
    doc, feed, t1, t2, t3,
    body1: t1.querySelector('#body'),
    body2: t2.querySelector('#body'),
    body3: t3.querySelector('#body'),
  };
}

function observation(key, mid, extra) {
  return Object.assign({
    commentKey: key,
    aid: '1',
    mid: String(mid),
    nickname: '用户' + mid,
    text: '正文',
    isReply: false,
    rootCommentKey: key,
  }, extra || {});
}

function verdict(action) {
  return {
    action,
    rulesVersion: 'v2b@test',
    scope: 'thread',
    clues: action === 'none' ? [] : [{
      clueId: 'nickFish', source: 'account', strength: 'strong',
      fragment: '鱼', label: '昵称含鱼',
    }],
  };
}

function make(f, options = {}) {
  const observations = options.observations || [
    observation('k1', 101),
    observation('k2', 202),
    observation('k3', 303),
  ];
  const entries = options.entries || [
    { observation: observations[0], node: f.t1, body: f.body1 },
    { observation: observations[1], node: f.t2, body: f.body2 },
    { observation: observations[2], node: f.t3, body: f.body3 },
  ];
  const map = options.verdicts || { k1: 'hide', k2: 'none', k3: 'none' };
  return purgeController.create({
    doc: f.doc,
    settings: memorySettings(Boolean(options.enabled)),
    records: options.records || purgeRecords.create({ now: () => 10 }),
    marker: purgeMarker.create(f.doc),
    stateStore: options.store || memoryStateStore(options.state),
    initialEnabled: Boolean(options.enabled),
    collect: () => ({
      status: 'ok', state: 'ok', message: '', aid: '1',
      observations, entries, threads: 3, replies: 0, total: 3, skipped: 0,
    }),
    judge: (obs) => verdict(map[obs.commentKey] || 'none'),
  });
}

describe('控制器与状态机：关闭自动清除只还原规则', () => {
  it('手动隐藏与账号屏蔽在关闭时生效，开关只还原规则隐藏', async () => {
    const f = fixture();
    const store = memoryStateStore();
    const controller = make(f, { store });
    await controller.start();
    assert.equal(f.t1.parentNode, f.feed);

    await controller.hideComment(observation('k2', 202));
    assert.equal(f.t2.parentNode, null);

    await controller.blockAccount(303);
    assert.equal(f.t3.parentNode, null);

    await controller.setEnabled(true);
    assert.equal(f.t1.parentNode, null);
    await controller.setEnabled(false);
    assert.equal(f.t1.parentNode, f.feed, '规则隐藏被还原');
    assert.equal(f.t2.parentNode, null, '手动隐藏保持');
    assert.equal(f.t3.parentNode, null, '账号屏蔽保持');
    assert.deepEqual(controller.getState().manualHidden, ['k2']);
    assert.deepEqual(controller.getState().accountBlocked, ['303']);
  });

  it('规则隐藏不写入手动状态', async () => {
    const f = fixture();
    const store = memoryStateStore();
    const controller = make(f, { store, enabled: true });
    await controller.start();
    assert.equal(f.t1.parentNode, null);
    assert.deepEqual(controller.getState().manualHidden, []);
    assert.deepEqual(store.current().manualHidden, []);
    assert.deepEqual(store.current().accountBlocked, []);
  });
});

describe('控制器与状态机：保留账号与保留例外', () => {
  it('保留账号挡住规则隐藏，但仍可手动隐藏与恢复', async () => {
    const f = fixture();
    const store = memoryStateStore(purgeState.allowAccount(purgeState.create(), { mid: 101 }));
    const controller = make(f, { store, enabled: true });
    await controller.start();
    assert.equal(f.t1.parentNode, f.feed);

    await controller.hideComment(observation('k1', 101));
    assert.equal(f.t1.parentNode, null);
    await controller.restoreComment('k1');
    assert.equal(f.t1.parentNode, f.feed);
    assert.deepEqual(controller.getState().keptException, ['k1']);
    assert.deepEqual(controller.getState().accountAllowed, ['101']);
  });

  it('取消屏蔽账号时恢复该账号被账号屏蔽的节点，再按规则重判', async () => {
    const f = fixture();
    const store = memoryStateStore(purgeState.blockAccount(purgeState.create(), { mid: 101 }));
    const controller = make(f, { store, enabled: false });
    await controller.start();
    assert.equal(f.t1.parentNode, null);

    await controller.unblockAccount(101);
    assert.equal(f.t1.parentNode, f.feed);
    assert.deepEqual(controller.getState().accountBlocked, []);
  });
});

describe('控制器与状态机：整串讨论', () => {
  function threadFixture() {
    const doc = parseHTML([
      '<html><body><div id="commentapp"><bili-comments>',
      '<template shadowrootmode="open"><div id="feed">',
      '<bili-comment-thread-renderer id="t1"><div id="body">一级</div>',
      '<bili-comment-reply-renderer id="r1"><div id="body">回复</div></bili-comment-reply-renderer>',
      '</bili-comment-thread-renderer>',
      '</div></template>',
      '</bili-comments></div></body></html>',
    ].join(''));
    const feed = doc.querySelector('bili-comments').shadowRoot.querySelector('#feed');
    const thread = feed.querySelector('#t1');
    const reply = feed.querySelector('#r1');
    return {
      doc, feed, thread, reply,
      threadBody: thread.querySelector('#body'),
      replyBody: reply.querySelector('#body'),
    };
  }

  it('恢复整串时，此前单独隐藏的回复仍然隐藏', async () => {
    const f = threadFixture();
    const threadObs = observation('k1', 101);
    const replyObs = observation('r1', 202, { isReply: true, rootCommentKey: 'k1' });
    const controller = make(f, {
      observations: [threadObs, replyObs],
      entries: [
        { observation: threadObs, node: f.thread, body: f.threadBody },
        { observation: replyObs, node: f.reply, body: f.replyBody },
      ],
      verdicts: { k1: 'none', r1: 'none' },
      store: memoryStateStore(),
    });
    await controller.start();

    await controller.hideComment(replyObs);
    assert.equal(f.reply.parentNode, null);
    await controller.hideComment(threadObs);
    assert.equal(f.thread.parentNode, null);

    await controller.restoreComment('k1');
    assert.equal(f.thread.parentNode, f.feed);
    assert.equal(f.reply.parentNode, null, '回复仍保持单条隐藏');
    assert.deepEqual(controller.getState().manualHidden, ['r1']);
    assert.deepEqual(controller.getState().keptException, ['k1']);
  });

  it('整串仍隐藏时，内部回复的保留例外不让整串出现', async () => {
    const f = threadFixture();
    const threadObs = observation('k1', 101);
    const replyObs = observation('r1', 202, { isReply: true, rootCommentKey: 'k1' });
    let state = purgeState.restore(purgeState.create(), { commentKey: 'r1' });
    // 外层一级评论被账号屏蔽，内层 r1 的保留例外不能把外层拉回来。
    state = purgeState.blockAccount(state, { mid: 101, at: 7 });
    const controller = make(f, {
      observations: [threadObs, replyObs],
      entries: [
        { observation: threadObs, node: f.thread, body: f.threadBody },
        { observation: replyObs, node: f.reply, body: f.replyBody },
      ],
      verdicts: { k1: 'none', r1: 'none' },
      store: memoryStateStore(state),
    });
    await controller.start();
    assert.equal(f.thread.parentNode, null);
  });
});
