// 端到端（离线）：真实快照 → 页面适配 → 判定引擎 → 控制器。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// 端到端集成依赖真实快照（可选的本地研究数据）：缺失时整个套件跳过。
import { hasSnapshots, loadSnapshot } from './support/fixtures.mjs';

const NO_SNAPSHOTS = !hasSnapshots() && '缺少本地页面快照';
import { loadExtension } from './support/load-extension.mjs';

await loadExtension(
  'src/lib/comment-key.js',
  'src/lib/dom-selectors.js',
  'src/lib/content-gate.js',
  'src/lib/page-adapter.js',
  'src/lib/engine-bundle.js',
  'src/lib/purge-settings.js',
  'src/lib/purge-state.js',
  'src/lib/purge-state-store.js',
  'src/lib/purge-marker.js',
  'src/lib/purge-records.js',
  'src/lib/purge-controller.js',
);
const ns = globalThis.DSHCC;

function memorySettings(initial) {
  let value = initial;
  return ns.purgeSettings.createStore({
    get: () => value,
    set: (next) => { value = next; },
    subscribe: () => () => {},
  });
}

describe('自动清除：真实快照集成', { skip: NO_SNAPSHOTS }, () => {
  it('默认关闭：3 条全可见，命中项显示 hidden 标记', async () => {
    const doc = loadSnapshot('initial');
    const controller = ns.purgeController.create({
      doc,
      settings: memorySettings(false),
      records: ns.purgeRecords.create(),
    });
    await controller.start();

    const result = ns.pageAdapter.collectWithNodes(doc);
    assert.equal(result.entries.length, 3);
    const marked = result.entries.filter((entry) => entry.body.querySelector('[data-dshcc-mark]'));
    assert.equal(marked.length, 1);
    assert.equal(marked[0].body.querySelector('[data-dshcc-mark]').getAttribute('data-dshcc-mark'), 'hidden');
  });

  it('开启后命中项整串移除并记录，关闭后恢复', async () => {
    const doc = loadSnapshot('initial');
    const records = ns.purgeRecords.create({ now: () => 42 });
    const controller = ns.purgeController.create({
      doc,
      settings: memorySettings(false),
      records,
    });
    await controller.start();
    await controller.setEnabled(true);

    const hidden = ns.pageAdapter.collectWithNodes(doc);
    assert.equal(hidden.entries.length, 2);
    assert.equal(records.count(), 1);
    assert.equal(records.list()[0].commentKey, 'v1:t:117457272440544:547756523:1f2fd3a3ce1eec99');
    assert.equal(records.list()[0].mid, '547756523');
    assert.equal(records.list()[0].at, 42);

    await controller.setEnabled(false);
    const restored = ns.pageAdapter.collectWithNodes(doc);
    assert.equal(restored.entries.length, 3);
    assert.equal(records.count(), 0);
  });
});
