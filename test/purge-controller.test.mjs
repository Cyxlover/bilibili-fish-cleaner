// 自动清除控制器：真实 DOM 操作必须可逆、可重扫、失败只影响单条。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';
import { parseHTML } from './support/mini-dom.mjs';

await loadExtension(
  'src/lib/purge-state.js',
  'src/lib/purge-state-store.js',
  'src/lib/purge-marker.js',
  'src/lib/purge-records.js',
  'src/lib/purge-controller.js',
);

const { purgeController, purgeMarker, purgeRecords } = globalThis.DSHCC;

function memorySettings(initial) {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => { value = next; },
    subscribe: () => () => {},
  };
}

function fixture() {
  const doc = parseHTML([
    '<html><body><div id="commentapp"><bili-comments>',
    '<template shadowrootmode="open"><div id="feed">',
    '<bili-comment-thread-renderer id="t1"><div id="body">第一条</div></bili-comment-thread-renderer>',
    '<bili-comment-thread-renderer id="t2"><div id="body">第二条</div></bili-comment-thread-renderer>',
    '</div></template>',
    '</bili-comments></div></body></html>',
  ].join(''));
  const commentsHost = doc.querySelector('bili-comments');
  const feed = commentsHost.shadowRoot.querySelector('#feed');
  const t1 = feed.querySelector('#t1');
  const t2 = feed.querySelector('#t2');
  return {
    doc,
    feed,
    t1,
    t2,
    body1: t1.querySelector('#body'),
    body2: t2.querySelector('#body'),
  };
}

function observation(key, mid, text, extra) {
  return Object.assign({
    commentKey: key,
    aid: '1',
    mid: String(mid),
    nickname: '用户' + mid,
    text,
    isReply: false,
    rootCommentKey: key,
  }, extra || {});
}

function verdict(action, rulesVersion = 'v2b-longform@2026.10.23') {
  return {
    action,
    rulesVersion,
    scope: 'thread',
    clues: action === 'none' ? [] : [{
      clueId: 'nickFish',
      source: 'account',
      strength: 'strong',
      fragment: '大肥鱼',
      label: '昵称含鱼',
    }],
  };
}

function makeController(f, options = {}) {
  const map = options.verdicts || { k1: 'hide', k2: 'suspect' };
  return purgeController.create({
    doc: f.doc,
    settings: memorySettings(Boolean(options.enabled)),
    strength: options.strength,
    records: options.records || purgeRecords.create({ now: () => 123 }),
    marker: options.marker || purgeMarker.create(f.doc),
    collect: options.collect || (() => ({
      status: 'ok',
      state: 'ok',
      message: '',
      observations: options.observations || [
        observation('k1', 101, '主人，白饭好了'),
        observation('k2', 102, '一般路过'),
      ],
      entries: options.entries || [
        { observation: observation('k1', 101, '主人，白饭好了'), node: f.t1, body: f.body1 },
        { observation: observation('k2', 102, '一般路过'), node: f.t2, body: f.body2 },
      ],
      threads: 2,
      replies: 0,
      total: 2,
      skipped: 0,
    })),
    judge: (obs) => verdict(map[obs.commentKey] || 'none'),
  });
}

// 真实浏览器的 document.querySelectorAll 不穿 shadow 边界，所以「页面上还剩几个标记」
// 只能逐个 shadow root 进去数。E2E 探针就是这么数的，这里用同一口径。
function countDocumentMarks(doc, tone) {
  const selector = tone ? '[data-dshcc-mark="' + tone + '"]' : '[data-dshcc-mark]';
  let total = 0;
  const visit = (scope) => {
    total += scope.querySelectorAll(selector).length;
    scope.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) visit(element.shadowRoot);
    });
  };
  visit(doc);
  return total;
}

// 采集只看当前挂在评论流里的节点：被移除的读不到，站点新渲染的下一次扫描就能读到——
// 与真实页面里滚动加载新评论时的行为一致。
function collectFromFeed(feed) {
  const spec = {
    t1: { key: 'k1', mid: 101, text: '主人，白饭好了' },
    t2: { key: 'k2', mid: 102, text: '一般路过' },
  };
  return () => {
    const observations = [];
    const entries = [];
    feed.children.forEach((node) => {
      const item = spec[node.id];
      if (!item) return;
      const observed = observation(item.key, item.mid, item.text);
      observations.push(observed);
      entries.push({ observation: observed, node, body: node.querySelector('#body') });
    });
    return {
      status: 'ok',
      state: 'ok',
      observations,
      entries,
      threads: entries.length,
      replies: 0,
      total: entries.length,
      skipped: 0,
    };
  };
}

describe('自动清除控制器：开关与还原', () => {
  it('关闭态：不删节点，hide 与 suspect 各自打可区分标记', async () => {
    const f = fixture();
    const controller = makeController(f);
    await controller.start();

    assert.equal(f.t1.parentNode, f.feed);
    assert.equal(f.t2.parentNode, f.feed);
    const hiddenMark = purgeMarker.ATTR;
    assert.equal(f.body1.querySelector('[' + hiddenMark + ']').getAttribute(hiddenMark), 'hidden');
    assert.equal(f.body2.querySelector('[' + hiddenMark + ']').getAttribute(hiddenMark), 'suspect');
    assert.equal(controller.getView().hidden, 0);
    assert.equal(controller.getView().records, 0);
  });

  it('开启态：hide 移除节点、suspect 保留并标记，记录一次实际隐藏', async () => {
    const f = fixture();
    const records = purgeRecords.create({ now: () => 456 });
    // 这条断言的是标准档语义：默认档已是激进，疑似也会被清除。
    const controller = makeController(f, { records, strength: 'standard' });
    await controller.start();
    await controller.setEnabled(true);

    assert.equal(f.t1.parentNode, null);
    assert.equal(f.t2.parentNode, f.feed);
    assert.equal(f.body2.querySelector('[' + purgeMarker.ATTR + ']').getAttribute(purgeMarker.ATTR), 'suspect');
    assert.equal(records.count(), 1);
    assert.deepEqual(records.list()[0], {
      commentKey: 'k1',
      mid: '101',
      rulesVersion: 'v2b-longform@2026.10.23',
      action: 'hide',
      clues: records.list()[0].clues,
      scope: 'thread',
      rootCommentKey: 'k1',
      at: 456,
    });
    assert.equal(records.list()[0].clues[0].clueId, 'nickFish');
  });

  it('关闭后按原顺序还原，清空记录并恢复标记', async () => {
    const f = fixture();
    const records = purgeRecords.create();
    const controller = makeController(f, { records });
    await controller.start();
    await controller.setEnabled(true);
    await controller.setEnabled(false);

    assert.equal(f.feed.children.length, 2);
    assert.equal(f.feed.children[0], f.t1);
    assert.equal(f.feed.children[1], f.t2);
    assert.equal(records.count(), 0);
    assert.ok(f.body1.querySelector('[' + purgeMarker.ATTR + ']'));
  });

  it('重渲染后同一 commentKey 的新节点会被再次隐藏', async () => {
    const f = fixture();
    let currentT1 = f.t1;
    const collect = () => ({
      status: 'ok',
      state: 'ok',
      observations: [observation('k1', 101, '主人，白饭好了')],
      entries: [{ observation: observation('k1', 101, '主人，白饭好了'), node: currentT1, body: f.body1 }],
      threads: 1,
      replies: 0,
      total: 1,
      skipped: 0,
    });
    const controller = makeController(f, { collect, verdicts: { k1: 'hide' } });
    await controller.start();
    await controller.setEnabled(true);
    assert.equal(currentT1.parentNode, null);

    currentT1 = parseHTML('<bili-comment-thread-renderer id="t1b"><div id="body">重渲染</div></bili-comment-thread-renderer>').querySelector('bili-comment-thread-renderer');
    f.feed.appendChild(currentT1);
    const result = controller.scan();

    assert.equal(currentT1.parentNode, null);
    assert.equal(result.purge.hidden, 1);
  });

  it('楼中楼只移除自己，一级评论仍保留', async () => {
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
    const replyBody = reply.querySelector('#body');
    const replyObs = observation('reply-1', 201, '主人说得对', {
      isReply: true,
      rootCommentKey: 'thread-1',
    });
    const controller = purgeController.create({
      doc,
      settings: memorySettings(true),
      records: purgeRecords.create(),
      marker: purgeMarker.create(doc),
      collect: () => ({
        status: 'ok', state: 'ok', observations: [replyObs],
        entries: [{ observation: replyObs, node: reply, body: replyBody }],
        threads: 1, replies: 1, total: 1, skipped: 0,
      }),
      judge: () => verdict('hide'),
    });
    await controller.start();

    assert.equal(thread.parentNode, feed);
    assert.equal(reply.parentNode, null);
    assert.equal(controller.getView().records, 1);
  });

  it('缺观察或节点缺失的条目只跳过，不抛异常也不影响其他条目', async () => {
    const f = fixture();
    const bad = makeController(f, {
      observations: [observation('k1', 101, '主人，白饭好了')],
      entries: [{ node: f.t1, body: f.body1 }, { observation: observation('k1', 101, '主人'), body: f.body1 }],
      verdicts: { k1: 'hide' },
    });
    await bad.start();
    assert.doesNotThrow(() => bad.scan());
    assert.equal(f.t1.parentNode, f.feed);

    const missing = makeController(f, {
      observations: [observation('k1', 101, '主人'), observation('k2', 102, '普通')],
      entries: [{ observation: observation('k1', 101, '主人'), node: f.t1, body: f.body1 }],
      verdicts: { k1: 'hide', k2: 'hide' },
    });
    await missing.start();
    await missing.setEnabled(true);
    assert.equal(f.t1.parentNode, null);
    assert.equal(f.t2.parentNode, f.feed);
  });

  it('采集抛错时安静降级，已隐藏节点保持隐藏', async () => {
    const f = fixture();
    let fail = false;
    const controller = makeController(f, {
      collect: () => {
        if (fail) throw new Error('页面结构炸了');
        return {
          status: 'ok',
          state: 'ok',
          observations: [observation('k1', 101, '主人')],
          entries: [{ observation: observation('k1', 101, '主人'), node: f.t1, body: f.body1 }],
          threads: 1, replies: 0, total: 1, skipped: 0,
        };
      },
      verdicts: { k1: 'hide' },
    });
    await controller.start();
    await controller.setEnabled(true);
    fail = true;
    const result = controller.scan();
    assert.equal(result.status, 'internal-error');
    assert.equal(f.t1.parentNode, null);
    assert.equal(controller.getView().hidden, 1);
  });

  // 真实浏览器 E2E（Edge + 真实视频页）看到的「关→开→关 后还剩 1 个 hidden 标记」
  // 就是这个形状：关闭时先把规则隐藏的节点还原，紧接着同一次扫描把还原回来的评论重新
  // 判定，于是它带上「规则命中 · 自动清除已关闭」的红色标记。标记属于刚回来的评论，
  // 不是上一次留下的残影；再打开一次就会连同节点一起消失。
  it('关闭后那一个 hidden 标记属于刚还原的评论，不是残留（复现 E2E 关→开→关）', async () => {
    const f = fixture();
    // 模拟「命中规则的那条一开始还没加载出来」，只有疑似那条在页面上。
    f.feed.removeChild(f.t1);
    const controller = makeController(f, { collect: collectFromFeed(f.feed) });
    await controller.start();

    assert.equal(countDocumentMarks(f.doc, 'hidden'), 0);

    await controller.setEnabled(true);
    assert.equal(countDocumentMarks(f.doc, 'hidden'), 0);

    // 滚动加载：开启期间站点新渲染一条命中规则的评论，应被直接移除（不留标记）。
    f.feed.appendChild(f.t1);
    controller.scan();
    assert.equal(f.t1.parentNode, null);
    assert.equal(countDocumentMarks(f.doc, 'hidden'), 0);

    // 关闭：还原回来的这条带着红色标记，整页恰好一个，且就是它自己。
    await controller.setEnabled(false);
    assert.equal(f.t1.parentNode, f.feed);
    assert.equal(f.feed.children.length, 2);
    assert.equal(countDocumentMarks(f.doc, 'hidden'), 1);
    const envelope = f.body1.querySelector('[data-dshcc-mark="hidden"]');
    assert.ok(envelope);
    assert.match(envelope.textContent, /自动清除已关闭/);
    assert.equal(envelope.getAttribute('data-dshcc-comment-key'), 'k1');
    // 标记账本与页面上的实际标记数一致：没有游离在文档之外、清不掉的残留。
    assert.equal(controller.getView().marked, countDocumentMarks(f.doc));
    assert.equal(controller.getView().records, 0);

    // 再打开：标记随节点一起消失，不会越关越多。
    await controller.setEnabled(true);
    assert.equal(f.t1.parentNode, null);
    assert.equal(countDocumentMarks(f.doc, 'hidden'), 0);
  });
});

// 三档清除强度：保守用 v1 规则且只清 hide；标准沿用现状；激进把 suspect 一并清掉。
describe('自动清除控制器：清除强度', () => {
  // 判定替身：记录的规则版本 = 控制器实际请求的版本（保守档应为 v1，其余走默认）。
  // 同时把收到的第三个参数收集起来，用来断言「切换规则版本」这条契约。
  function withStrength(f, options = {}) {
    const seen = [];
    const map = options.verdicts || { k1: 'hide', k2: 'suspect' };
    const records = options.records || purgeRecords.create();
    const controller = purgeController.create({
      doc: f.doc,
      settings: memorySettings(Boolean(options.enabled)),
      records,
      marker: purgeMarker.create(f.doc),
      strength: options.strength,
      collect: options.collect || (() => ({
        status: 'ok',
        state: 'ok',
        message: '',
        observations: [
          observation('k1', 101, '主人，白饭好了'),
          observation('k2', 102, '一般路过'),
        ],
        entries: [
          { observation: observation('k1', 101, '主人，白饭好了'), node: f.t1, body: f.body1 },
          { observation: observation('k2', 102, '一般路过'), node: f.t2, body: f.body2 },
        ],
        threads: 2,
        replies: 0,
        total: 2,
        skipped: 0,
      })),
      judge: (obs, pageContext, judgeOptions) => {
        seen.push(judgeOptions);
        const requested = judgeOptions && judgeOptions.rulesVersion;
        return verdict(map[obs.commentKey] || 'none', (requested || 'v2b-longform') + '@2026.10.23');
      },
    });
    return { controller, records, seen };
  }

  it('激进档：suspect 走和 hide 完全一样的隐藏路径与记录', async () => {
    const f = fixture();
    const { controller, records } = withStrength(f, { enabled: true, strength: 'aggressive' });
    await controller.start();

    assert.equal(f.t1.parentNode, null);
    assert.equal(f.t2.parentNode, null, '激进档下疑似评论也应被移除');
    assert.equal(countDocumentMarks(f.doc, 'suspect'), 0);
    assert.equal(controller.getView().hidden, 2);
    assert.equal(controller.getView().records, 2);

    const suspectRecord = records.list().filter((record) => record.commentKey === 'k2')[0];
    assert.ok(suspectRecord);
    assert.equal(suspectRecord.action, 'hide');
    assert.equal(suspectRecord.rulesVersion, 'v2b-longform@2026.10.23');
    assert.equal(suspectRecord.scope, 'thread');
    assert.equal(suspectRecord.rootCommentKey, 'k2');
    assert.equal(suspectRecord.mid, '102');
    assert.deepEqual(suspectRecord.clues, [{
      clueId: 'nickFish',
      source: 'account',
      strength: 'strong',
      fragment: '大肥鱼',
      label: '昵称含鱼',
    }]);
  });

  it('标准档：suspect 仍然只标记、不隐藏', async () => {
    const f = fixture();
    const { controller, records } = withStrength(f, { enabled: true, strength: 'standard' });
    await controller.start();

    assert.equal(f.t1.parentNode, null);
    assert.equal(f.t2.parentNode, f.feed);
    assert.equal(
      f.body2.querySelector('[' + purgeMarker.ATTR + ']').getAttribute(purgeMarker.ATTR),
      'suspect',
    );
    assert.equal(records.count(), 1);
    assert.equal(controller.getView().strength, 'standard');
  });

  it('保守档：suspect 不隐藏，判定改用 v1 规则', async () => {
    const f = fixture();
    const records = purgeRecords.create();
    const { controller, seen } = withStrength(f, {
      enabled: true,
      strength: 'conservative',
      records,
    });
    await controller.start();

    assert.equal(f.t2.parentNode, f.feed);
    assert.ok(seen.length > 0);
    for (const judgeOptions of seen) {
      assert.equal(judgeOptions && judgeOptions.rulesVersion, 'v1');
    }
    assert.equal(records.count(), 1);
    assert.equal(records.list()[0].rulesVersion, 'v1@2026.10.23');
    assert.equal(controller.getView().strength, 'conservative');
  });

  it('标准档与激进档不指定规则版本，仍用默认规则集', async () => {
    for (const level of ['standard', 'aggressive']) {
      const f = fixture();
      const { controller, seen } = withStrength(f, { strength: level });
      await controller.start();
      assert.ok(seen.length > 0, level);
      for (const judgeOptions of seen) {
        assert.equal(judgeOptions, undefined, level + ' 不该覆盖规则版本');
      }
    }
  });

  it('切换强度立刻重新判定：已清除的疑似评论会立刻回来或再次消失', async () => {
    const f = fixture();
    const { controller } = withStrength(f, {
      enabled: true,
      strength: 'aggressive',
      collect: collectFromFeed(f.feed),
    });
    await controller.start();
    assert.equal(f.t2.parentNode, null);

    controller.setStrength('standard');
    assert.equal(f.t2.parentNode, f.feed, '降到标准档后疑似评论立刻回到页面');
    assert.equal(
      f.body2.querySelector('[' + purgeMarker.ATTR + ']').getAttribute(purgeMarker.ATTR),
      'suspect',
    );

    controller.setStrength('aggressive');
    assert.equal(f.t2.parentNode, null, '再升回激进档又被清除');
    assert.equal(controller.getStrength(), 'aggressive');
  });

  it('非法档位按默认（激进）处理', async () => {
    const f = fixture();
    const { controller } = withStrength(f, { enabled: true, strength: '超高' });
    await controller.start();

    assert.equal(controller.getStrength(), 'aggressive');
    assert.equal(f.t2.parentNode, null);
  });

  it('关闭开关时激进档也不隐藏任何东西，只标记', async () => {
    const f = fixture();
    const { controller, records } = withStrength(f, { enabled: false, strength: 'aggressive' });
    await controller.start();

    assert.equal(f.t1.parentNode, f.feed);
    assert.equal(f.t2.parentNode, f.feed);
    assert.equal(records.count(), 0);
    assert.equal(
      f.body2.querySelector('[' + purgeMarker.ATTR + ']').getAttribute(purgeMarker.ATTR),
      'suspect',
    );
  });
});
