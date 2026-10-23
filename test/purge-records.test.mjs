import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-records.js');
const { purgeRecords } = globalThis.DSHCC;

describe('自动清除记录', () => {
  it('记录实际隐藏所需字段，并复制线索', () => {
    const records = purgeRecords.create({ now: () => 789 });
    const clues = [{ clueId: 'nickFish', source: 'account', strength: 'strong', fragment: '大肥鱼', label: '昵称含鱼' }];
    const record = records.add({
      commentKey: 'k1',
      mid: 101,
      rulesVersion: 'v2b-longform@2026.10.23',
      action: 'hide',
      clues,
      scope: 'reply',
      rootCommentKey: 'root1',
    });

    assert.deepEqual(record, {
      commentKey: 'k1',
      mid: '101',
      rulesVersion: 'v2b-longform@2026.10.23',
      action: 'hide',
      clues,
      scope: 'reply',
      rootCommentKey: 'root1',
      at: 789,
    });
    assert.notEqual(record.clues, clues);
    assert.notEqual(record.clues[0], clues[0]);
  });

  it('关闭时 clear 清空记录，不残留账号级数据', () => {
    const records = purgeRecords.create({ now: () => 1 });
    records.add({ commentKey: 'k1', mid: 1, action: 'hide' });
    records.add({ commentKey: 'k2', mid: 2, action: 'hide' });
    assert.equal(records.count(), 2);
    records.clear();
    assert.equal(records.count(), 0);
    assert.deepEqual(records.list(), []);
  });

  it('非法条目忽略，超出上限保留最近记录', () => {
    const records = purgeRecords.create({ now: () => 1, limit: 2 });
    assert.equal(records.add({}), null);
    assert.equal(records.add(null), null);
    records.add({ commentKey: 'a', mid: 1, action: 'hide' });
    records.add({ commentKey: 'b', mid: 2, action: 'hide' });
    records.add({ commentKey: 'c', mid: 3, action: 'hide' });
    assert.deepEqual(records.list().map((item) => item.commentKey), ['b', 'c']);
  });
});
