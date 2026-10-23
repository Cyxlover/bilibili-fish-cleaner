// 开关的持久化：默认关闭，开启状态跨刷新记住，存储坏掉时安静降级。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-settings.js');
const { purgeSettings } = globalThis.DSHCC;

function fakeAdapter(initial) {
  const data = new Map(initial ? Object.entries(initial) : []);
  const listeners = new Set();
  return {
    data,
    get(key) {
      return data.has(key) ? data.get(key) : undefined;
    },
    set(key, value) {
      data.set(key, value);
      for (const listener of listeners) listener(key, value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('开关存储：默认值与跨刷新记忆', () => {
  it('从未设置过时默认关闭', async () => {
    const store = purgeSettings.createStore(fakeAdapter());
    assert.equal(await store.load(), false);
  });

  it('开启后换一个 store 读同一个存储仍然开启（模拟刷新）', async () => {
    const adapter = fakeAdapter();
    const before = purgeSettings.createStore(adapter);
    await before.save(true);

    const after = purgeSettings.createStore(adapter);
    assert.equal(await after.load(), true);
  });

  it('关掉之后也记得住', async () => {
    const adapter = fakeAdapter();
    await purgeSettings.createStore(adapter).save(true);
    await purgeSettings.createStore(adapter).save(false);
    assert.equal(await purgeSettings.createStore(adapter).load(), false);
  });

  it('只把布尔 true 当作开启，脏数据一律按关闭处理', async () => {
    for (const value of ['true', 1, {}, null, 'yes']) {
      const store = purgeSettings.createStore(fakeAdapter({ [purgeSettings.KEY]: value }));
      assert.equal(await store.load(), false);
    }
  });
});

describe('开关存储：失败降级', () => {
  it('读取抛异常时按默认关闭处理，不把异常抛给调用方', async () => {
    const store = purgeSettings.createStore({
      get() {
        throw new Error('storage unavailable');
      },
      set() {},
    });
    assert.equal(await store.load(), false);
  });

  it('写入抛异常时安静失败并返回 false', async () => {
    const store = purgeSettings.createStore({
      get() {
        return undefined;
      },
      set() {
        throw new Error('quota exceeded');
      },
    });
    assert.equal(await store.save(true), false);
  });

  it('保存成功后返回 true', async () => {
    const store = purgeSettings.createStore(fakeAdapter());
    assert.equal(await store.save(true), true);
  });
});

describe('开关存储：变更通知', () => {
  it('其它页面改动开关时通知监听者，并忽略无关键', async () => {
    const adapter = fakeAdapter();
    const store = purgeSettings.createStore(adapter);
    const seen = [];
    const unsubscribe = store.subscribe((enabled) => seen.push(enabled));

    adapter.set('other.key', true);
    adapter.set(purgeSettings.KEY, true);
    adapter.set(purgeSettings.KEY, false);

    assert.deepEqual(seen, [true, false]);
    unsubscribe();
    adapter.set(purgeSettings.KEY, true);
    assert.deepEqual(seen, [true, false]);
  });
});
