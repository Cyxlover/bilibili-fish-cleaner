// 纯状态机：四类集合、六条互斥规则与判定优先级。
// 不接触 DOM，也不接触扩展 API；所有断言只经过公开操作与 decide。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-state.js');
const { purgeState } = globalThis.DSHCC;

function observation(commentKey, mid, extra) {
  return Object.assign({
    commentKey,
    aid: '1',
    mid: String(mid),
    text: '正文',
    isReply: false,
    rootCommentKey: commentKey,
  }, extra || {});
}

function verdict(action) {
  return { action, rulesVersion: 'v2b@test', clues: [] };
}

function hideEntry(commentKey, mid, extra) {
  return Object.assign({
    commentKey,
    mid: String(mid),
    rulesVersion: 'manual',
    action: 'hide',
    clues: [],
    scope: 'thread',
    rootCommentKey: commentKey,
    at: 1000,
  }, extra || {});
}

describe('状态机：集合与互斥', () => {
  it('初始状态四类集合都为空，规则隐藏不写入任何集合', () => {
    const state = purgeState.create();
    assert.deepEqual(state.accountBlocked, []);
    assert.deepEqual(state.accountAllowed, []);
    assert.deepEqual(state.manualHidden, []);
    assert.deepEqual(state.keptException, []);

    const decided = purgeState.decide(state, observation('k1', 101), verdict('hide'));
    assert.equal(decided.hide, true);
    assert.equal(decided.reason, 'rule');
    assert.deepEqual(state.manualHidden, []);
    assert.deepEqual(state.keptException, []);
  });

  it('hide 幂等加入手动隐藏，并从保留例外移除，同时留下完整记录', () => {
    const before = purgeState.restore(purgeState.create(), { commentKey: 'k1', at: 900 });
    assert.deepEqual(before.keptException, ['k1']);

    const entry = hideEntry('k1', 101);
    const after = purgeState.hide(before, entry);
    assert.deepEqual(after.manualHidden, ['k1']);
    assert.deepEqual(after.keptException, []);
    assert.equal(after.records.k1.commentKey, 'k1');
    assert.equal(after.records.k1.mid, '101');
    assert.equal(after.records.k1.rulesVersion, 'manual');
    assert.equal(after.records.k1.action, 'hide');
    assert.deepEqual(after.records.k1.clues, []);
    assert.equal(after.records.k1.scope, 'thread');
    assert.equal(after.records.k1.rootCommentKey, 'k1');
    assert.equal(after.records.k1.at, 1000);

    const again = purgeState.hide(after, hideEntry('k1', 101, { at: 2000 }));
    assert.deepEqual(again.manualHidden, ['k1']);
    assert.equal(again.records.k1.at, 2000);
    assert.deepEqual(before.keptException, ['k1'], '旧状态不能被修改');
  });

  it('restore 撤销手动隐藏并加入保留例外，但不动账号屏蔽', () => {
    let state = purgeState.blockAccount(purgeState.create(), { mid: 101, at: 1 });
    state = purgeState.hide(state, hideEntry('k1', 101));
    const restored = purgeState.restore(state, { commentKey: 'k1', at: 2000 });

    assert.deepEqual(restored.manualHidden, []);
    assert.deepEqual(restored.keptException, ['k1']);
    assert.deepEqual(restored.accountBlocked, ['101']);
    assert.equal(restored.records.k1, undefined);
  });

  it('屏蔽与保留账号互斥且后写覆盖，账号变化不删除单条保留例外', () => {
    let state = purgeState.restore(purgeState.create(), { commentKey: 'k1', at: 1 });
    state = purgeState.blockAccount(state, { mid: 101, at: 2 });
    assert.deepEqual(state.accountBlocked, ['101']);
    assert.deepEqual(state.accountAllowed, []);

    state = purgeState.allowAccount(state, { mid: 101, at: 3 });
    assert.deepEqual(state.accountBlocked, []);
    assert.deepEqual(state.accountAllowed, ['101']);
    assert.deepEqual(state.keptException, ['k1']);

    state = purgeState.blockAccount(state, { mid: 101, at: 4 });
    assert.deepEqual(state.accountBlocked, ['101']);
    assert.deepEqual(state.accountAllowed, []);
    assert.deepEqual(state.keptException, ['k1']);

    state = purgeState.removeAllowedAccount(state, { mid: 101 });
    assert.deepEqual(state.accountAllowed, []);
  });
});

describe('状态机：decide 优先级', () => {
  it('parentHidden > kept > manual > account > allowed > rule', () => {
    let state = purgeState.create();
    state = purgeState.allowAccount(state, { mid: 101 });
    state = purgeState.blockAccount(state, { mid: 101 });
    state = purgeState.allowAccount(state, { mid: 101 });
    state = purgeState.hide(state, hideEntry('k1', 101));
    state = purgeState.restore(state, { commentKey: 'k1' });

    assert.deepEqual(
      purgeState.decide(state, observation('k1', 101), verdict('hide')),
      { hide: false, reason: 'kept' },
    );
    assert.deepEqual(
      purgeState.decide(state, observation('k1', 101), verdict('hide'), { parentHidden: true }),
      { hide: true, reason: 'parent' },
    );

    state = purgeState.hide(state, hideEntry('k1', 101));
    assert.deepEqual(
      purgeState.decide(state, observation('k1', 101), verdict('none')),
      { hide: true, reason: 'manual' },
    );

    state = purgeState.restore(purgeState.create(), { commentKey: 'other' });
    state = purgeState.blockAccount(state, { mid: 101 });
    assert.deepEqual(
      purgeState.decide(state, observation('k1', 101), verdict('none')),
      { hide: true, reason: 'account' },
    );

    const allowed = purgeState.allowAccount(purgeState.create(), { mid: 101 });
    assert.deepEqual(
      purgeState.decide(allowed, observation('k1', 101), verdict('hide')),
      { hide: false, reason: 'allowed' },
    );
    assert.deepEqual(
      purgeState.decide(purgeState.create(), observation('k1', 101), verdict('suspect')),
      { hide: false, reason: 'suspect' },
    );
  });

  it('外层整串隐藏时，内部回复的保留例外不使整串重新出现', () => {
    let state = purgeState.restore(purgeState.create(), { commentKey: 'reply-1', at: 1 });
    const reply = observation('reply-1', 102, { isReply: true, rootCommentKey: 'thread-1' });
    assert.deepEqual(
      purgeState.decide(state, reply, verdict('hide'), { parentHidden: true }),
      { hide: true, reason: 'parent' },
    );
  });

  it('保留账号不会被规则隐藏，但手动隐藏仍然生效', () => {
    const state = purgeState.allowAccount(purgeState.create(), { mid: 101 });
    assert.equal(purgeState.decide(state, observation('k1', 101), verdict('hide')).hide, false);
    const manuallyHidden = purgeState.hide(state, hideEntry('k1', 101));
    assert.equal(purgeState.decide(manuallyHidden, observation('k1', 101), verdict('none')).hide, true);
  });
});
