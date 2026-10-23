// 持久化：正常往返、损坏降级、条数上限与按视频清理。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-state.js', 'src/lib/purge-state-store.js');
const { purgeState, purgeStateStore } = globalThis.DSHCC;

function memoryAdapter(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; },
  };
}

function hide(state, key, mid, aid, at) {
  return purgeState.hide(state, {
    commentKey: key,
    mid,
    aid,
    rulesVersion: 'manual',
    action: 'hide',
    clues: [],
    scope: 'thread',
    rootCommentKey: key,
    at,
  });
}

describe('状态持久化：往返与降级', () => {
  it('save 写入 dshcc.state.v1，load 还原四类集合与记录', async () => {
    const adapter = memoryAdapter();
    const store = purgeStateStore.create({ adapter });
    let state = hide(purgeState.create(), 'k1', 101, '1', 10);
    state = purgeState.blockAccount(state, { mid: 202, at: 11 });
    state = purgeState.allowAccount(state, { mid: 303, at: 12 });
    state = purgeState.restore(state, { commentKey: 'k1', at: 13 });

    assert.equal(await store.save(state), true);
    assert.ok(adapter.data['dshcc.state.v1']);
    const loaded = await store.load();
    assert.deepEqual(loaded.accountBlocked, ['202']);
    assert.deepEqual(loaded.accountAllowed, ['303']);
    assert.deepEqual(loaded.manualHidden, []);
    assert.deepEqual(loaded.keptException, ['k1']);
  });

  it('没有数据、JSON 损坏或读取抛错时安静返回空状态', async () => {
    const empty = await purgeStateStore.create({ adapter: memoryAdapter() }).load();
    assert.deepEqual(empty.manualHidden, []);

    const broken = memoryAdapter({ 'dshcc.state.v1': '{not json' });
    const brokenState = await purgeStateStore.create({
      adapter: {
        get() { return JSON.parse('{not json'); },
        set() {},
      },
    }).load();
    assert.deepEqual(brokenState.manualHidden, []);

    const failing = {
      get() { throw new Error('storage unavailable'); },
      set() { throw new Error('storage unavailable'); },
    };
    const store = purgeStateStore.create({ adapter: failing });
    assert.deepEqual((await store.load()).accountBlocked, []);
    assert.equal(await store.save(purgeState.create()), false);
  });
});

describe('状态持久化：容量与按视频清理', () => {
  it('同一视频的评论键超过单视频上限时保留最新的', async () => {
    let state = purgeState.create();
    state = hide(state, 'a1', 1, '100', 10);
    state = hide(state, 'a2', 2, '100', 20);
    state = hide(state, 'a3', 3, '100', 30);
    state = purgeState.restore(state, { commentKey: 'a2', at: 25 });

    const pruned = purgeStateStore.prune(state, {
      aid: '100',
      limits: { commentLimit: 10, perVideoLimit: 2, accountLimit: 10 },
    });
    assert.deepEqual(pruned.manualHidden.sort(), ['a3']);
    assert.deepEqual(pruned.keptException, ['a2']);
    assert.equal(pruned.records.a3.commentKey, 'a3');
    assert.equal(pruned.records.a1, undefined);
  });

  it('全局评论上限按时间淘汰最旧，且不误删账号维度', () => {
    let state = purgeState.create();
    state = hide(state, 'old', 1, '1', 10);
    state = hide(state, 'new', 2, '1', 20);
    state = purgeState.blockAccount(state, { mid: 9, at: 5 });
    state = purgeState.restore(state, { commentKey: 'new', at: 21 });

    const pruned = purgeStateStore.prune(state, {
      limits: { commentLimit: 1, perVideoLimit: 10, accountLimit: 10 },
    });
    assert.deepEqual(pruned.manualHidden, []);
    assert.deepEqual(pruned.keptException, ['new']);
    assert.deepEqual(pruned.accountBlocked, ['9']);
  });

  it('账号集合超过上限时淘汰最旧，屏蔽与保留同步删除', () => {
    let state = purgeState.create();
    state = purgeState.blockAccount(state, { mid: 1, at: 10 });
    state = purgeState.blockAccount(state, { mid: 2, at: 20 });
    state = purgeState.blockAccount(state, { mid: 3, at: 30 });
    state = purgeState.allowAccount(state, { mid: 4, at: 40 });

    const pruned = purgeStateStore.prune(state, {
      limits: { commentLimit: 10, perVideoLimit: 10, accountLimit: 3 },
    });
    assert.deepEqual(pruned.accountBlocked, ['2', '3']);
    assert.deepEqual(pruned.accountAllowed, ['4']);
  });

  it('clearVideo 只清除该视频归属的评论状态，不动账号名单', () => {
    let state = purgeState.create();
    state = hide(state, 'v1-a', 1, '1', 10);
    state = hide(state, 'v2-a', 1, '2', 20);
    state = purgeState.blockAccount(state, { mid: 1, at: 30 });
    const cleared = purgeStateStore.clearVideo(purgeState.normalize(state), '1');
    assert.deepEqual(cleared.manualHidden, ['v2-a']);
    assert.deepEqual(cleared.accountBlocked, ['1']);
  });
});
