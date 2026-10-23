// 清除强度的持久化：默认激进，三档可切换，脏数据一律回落默认，存储坏掉时安静降级。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-strength.js');
const { purgeStrength } = globalThis.DSHCC;

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

describe('清除强度：档位与默认值', () => {
  it('存储键与默认档位固定', () => {
    assert.equal(purgeStrength.KEY, 'dshcc.purge.strength');
    assert.equal(purgeStrength.DEFAULT, 'aggressive');
    assert.deepEqual(purgeStrength.LEVELS, ['conservative', 'standard', 'aggressive']);
  });

  it('三个合法档位原样保留', () => {
    for (const level of purgeStrength.LEVELS) {
      assert.equal(purgeStrength.normalize(level), level);
    }
  });

  it('非法值一律落回默认档位', () => {
    for (const value of ['high', 'AGGRESSIVE', '', ' conservative', 0, 1, true, null, undefined, {}, []]) {
      assert.equal(purgeStrength.normalize(value), 'aggressive', `normalize(${JSON.stringify(value)})`);
    }
  });
});

describe('清除强度：持久化与跨刷新记忆', () => {
  it('从未设置过时是默认档位', async () => {
    const store = purgeStrength.createStore(fakeAdapter());
    assert.equal(await store.load(), 'aggressive');
  });

  it('切换档位后换一个 store 读同一个存储仍然记得（模拟刷新）', async () => {
    const adapter = fakeAdapter();
    await purgeStrength.createStore(adapter).save('conservative');
    assert.equal(await purgeStrength.createStore(adapter).load(), 'conservative');

    await purgeStrength.createStore(adapter).save('standard');
    assert.equal(await purgeStrength.createStore(adapter).load(), 'standard');
  });

  it('存了非法值也读回默认档位', async () => {
    for (const value of ['暴力', 42, null, {}]) {
      const store = purgeStrength.createStore(fakeAdapter({ [purgeStrength.KEY]: value }));
      assert.equal(await store.load(), 'aggressive');
    }
  });

  it('保存非法值时按默认档位存下去', async () => {
    const adapter = fakeAdapter();
    await purgeStrength.createStore(adapter).save('super');
    assert.equal(adapter.data.get(purgeStrength.KEY), 'aggressive');
  });
});

describe('清除强度：失败降级', () => {
  it('读取抛异常时按默认档位处理，不把异常抛给调用方', async () => {
    const store = purgeStrength.createStore({
      get() {
        throw new Error('storage unavailable');
      },
      set() {},
    });
    assert.equal(await store.load(), 'aggressive');
  });

  it('写入抛异常时安静失败并返回 false', async () => {
    const store = purgeStrength.createStore({
      get() {
        return undefined;
      },
      set() {
        throw new Error('quota exceeded');
      },
    });
    assert.equal(await store.save('standard'), false);
  });

  it('保存成功后返回 true', async () => {
    assert.equal(await purgeStrength.createStore(fakeAdapter()).save('standard'), true);
  });

  it('没有适配器时也能工作，读回默认值且不抛异常', async () => {
    const store = purgeStrength.createStore(null);
    assert.equal(await store.load(), 'aggressive');
    await assert.doesNotReject(store.save('conservative'));
    assert.equal(typeof store.subscribe(() => {}), 'function');
  });
});

describe('清除强度：变更通知', () => {
  it('其它页面改动强度时通知监听者，并忽略无关键', async () => {
    const adapter = fakeAdapter();
    const store = purgeStrength.createStore(adapter);
    const seen = [];
    const unsubscribe = store.subscribe((level) => seen.push(level));

    adapter.set('other.key', 'standard');
    adapter.set(purgeStrength.KEY, 'conservative');
    adapter.set(purgeStrength.KEY, 'standard');

    assert.deepEqual(seen, ['conservative', 'standard']);
    unsubscribe();
    adapter.set(purgeStrength.KEY, 'aggressive');
    assert.deepEqual(seen, ['conservative', 'standard']);
  });

  it('通知里带非法值时归一化成默认档位', async () => {
    const adapter = fakeAdapter();
    const seen = [];
    purgeStrength.createStore(adapter).subscribe((level) => seen.push(level));

    adapter.set(purgeStrength.KEY, '乱写的');
    assert.deepEqual(seen, ['aggressive']);
  });
});

describe('清除强度：存储适配器', () => {
  it('detectAdapter 给出可读可写的适配器', async () => {
    const adapter = purgeStrength.detectAdapter();
    assert.equal(typeof adapter.get, 'function');
    assert.equal(typeof adapter.set, 'function');
    assert.equal(typeof adapter.subscribe, 'function');
    await adapter.set(purgeStrength.KEY, 'standard');
    assert.equal(await adapter.get(purgeStrength.KEY), 'standard');
  });
});
