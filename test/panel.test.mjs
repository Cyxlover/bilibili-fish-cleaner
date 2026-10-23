// 侧边面板：记录视图与名单视图的呈现、按整串折叠、恢复与解除屏蔽的动作边界。
//
// 面板只消费 purge-state 的状态与 purge-records 的记录，不自己推断互斥规则；
// 这里测的是「面板显示什么」与「点一下会调用哪个动作」。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from './support/mini-dom.mjs';
import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-state.js', 'src/ui/panel.js');
const { purgeState, panel } = globalThis.DSHCC;

const NOW = new Date(2026, 9, 23, 22, 0, 0).getTime();
const MINUTE = 60 * 1000;

function ruleRecord(overrides) {
  return Object.assign({
    commentKey: 'r1',
    mid: '1001',
    rulesVersion: 'v2b-longform@2026.10.23',
    action: 'hide',
    clues: [{ clueId: 'nickFish', source: 'account', strength: 'strong', fragment: '大肥鱼', label: '昵称含鱼' }],
    scope: 'thread',
    rootCommentKey: 'r1',
    at: NOW - 5 * MINUTE,
  }, overrides);
}

describe('记录视图：规则隐藏与手动隐藏分得开', () => {
  it('两类记录都带来源标记、原因、规则版本与时间', () => {
    const state = purgeState.hide(purgeState.create(), {
      commentKey: 'm1',
      mid: '2002',
      rulesVersion: 'manual',
      action: 'hide',
      scope: 'thread',
      at: NOW - MINUTE,
    });
    const view = panel.buildView({
      state,
      ruleRecords: [ruleRecord()],
      view: 'records',
      now: NOW,
    });

    assert.equal(view.view, 'records');
    assert.equal(view.records.length, 2);
    const manual = view.records.find((item) => item.commentKey === 'm1');
    const rule = view.records.find((item) => item.commentKey === 'r1');
    assert.equal(manual.source, 'manual');
    assert.equal(rule.source, 'rule');
    assert.notEqual(manual.sourceLabel, rule.sourceLabel);
    assert.equal(manual.reasonText.length > 0, true);
    assert.equal(rule.rulesVersion, 'v2b-longform@2026.10.23');
    assert.equal(rule.reasons[0].label, '昵称含鱼');
    assert.equal(rule.reasons[0].fragment, '大肥鱼');
    // 夹具里的强度是字符串，面板原样展示；引擎给的数字则写成「强度 N」。
    assert.equal(rule.reasons[0].strengthText, 'strong');
    const numeric = panel.buildView({
      state: purgeState.create(),
      ruleRecords: [ruleRecord({ commentKey: 'n1', clues: [
        { clueId: 'actionTag', strength: 2, fragment: '（尾巴）', label: '括号动作' },
        { clueId: 'nickFish', strength: '', fragment: '大肥鱼', label: '昵称含鱼' },
      ] })],
      view: 'records',
      now: NOW,
    }).records[0];
    assert.equal(numeric.reasons[0].strengthText, '强度 2');
    assert.equal(numeric.reasons[1].strengthText, '');
    assert.equal(manual.timeText, '今天 21:59');
    assert.equal(rule.timeText, '今天 21:55');
    // 规则隐藏是临时的，面板要说清楚它不跨刷新。
    assert.equal(rule.temporary, true);
    assert.equal(manual.temporary, false);
  });

  it('评论摘要取正文，没有正文时退回线索片段', () => {
    const view = panel.buildView({
      state: purgeState.create(),
      ruleRecords: [ruleRecord({ commentKey: 'a', text: '本鱼今天也想吃白饭' }), ruleRecord({ commentKey: 'b' })],
      view: 'records',
      now: NOW,
    });
    const withText = view.records.find((item) => item.commentKey === 'a');
    const withoutText = view.records.find((item) => item.commentKey === 'b');
    assert.equal(withText.summary, '本鱼今天也想吃白饭');
    assert.equal(withoutText.summary, '大肥鱼');
  });

  it('整串被隐藏时只显示一条整串记录，不列出内部回复', () => {
    const state = purgeState.create();
    const view = panel.buildView({
      state,
      ruleRecords: [
        ruleRecord({ commentKey: 'root', scope: 'thread', rootCommentKey: 'root' }),
        ruleRecord({ commentKey: 'reply1', scope: 'reply', rootCommentKey: 'root' }),
        ruleRecord({ commentKey: 'reply2', scope: 'reply', rootCommentKey: 'root' }),
      ],
      view: 'records',
      now: NOW,
    });
    assert.deepEqual(view.records.map((item) => item.commentKey), ['root']);
    assert.equal(view.records[0].scope, 'thread');
  });

  it('一级评论可见时，单独隐藏的楼中楼回复仍单独列出、可单独恢复', () => {
    const state = purgeState.hide(purgeState.create(), {
      commentKey: 'reply9',
      mid: '3003',
      scope: 'reply',
      rootCommentKey: 'visible-root',
      at: NOW - 2 * MINUTE,
    });
    const view = panel.buildView({ state, ruleRecords: [], view: 'records', now: NOW });
    assert.deepEqual(view.records.map((item) => item.commentKey), ['reply9']);
    assert.equal(view.records[0].scope, 'reply');
    assert.equal(view.records[0].rootCommentKey, 'visible-root');
  });

  it('不同一级评论的整串记录互不影响', () => {
    const view = panel.buildView({
      state: purgeState.create(),
      ruleRecords: [
        ruleRecord({ commentKey: 'rootA', scope: 'thread', rootCommentKey: 'rootA' }),
        ruleRecord({ commentKey: 'rootB', scope: 'thread', rootCommentKey: 'rootB' }),
        ruleRecord({ commentKey: 'replyOfA', scope: 'reply', rootCommentKey: 'rootA' }),
      ],
      view: 'records',
      now: NOW,
    });
    assert.deepEqual(view.records.map((item) => item.commentKey).sort(), ['rootA', 'rootB']);
  });

  it('同一条评论同时有规则记录与手动记录时只显示手工那条', () => {
    const state = purgeState.hide(purgeState.create(), { commentKey: 'same', mid: '4004', scope: 'thread', at: NOW });
    const view = panel.buildView({
      state,
      ruleRecords: [ruleRecord({ commentKey: 'same', scope: 'thread', rootCommentKey: 'same' })],
      view: 'records',
      now: NOW,
    });
    assert.equal(view.records.length, 1);
    assert.equal(view.records[0].source, 'manual');
  });

  it('没有记录时给出空状态文案，不抛错', () => {
    const view = panel.buildView({ state: null, ruleRecords: null, view: 'records', now: NOW });
    assert.deepEqual(view.records, []);
    assert.equal(view.emptyText.length > 0, true);
  });
});

describe('名单视图：屏蔽、保留与保留例外', () => {
  const state = purgeState.allowAccount(
    purgeState.blockAccount(
      purgeState.restore(purgeState.create(), { commentKey: 'kept1', at: NOW - 3 * MINUTE }),
      { mid: '1001', at: NOW - 4 * MINUTE },
    ),
    { mid: '2002', at: NOW - 5 * MINUTE },
  );

  it('三条名单同时给出，且带时间', () => {
    const view = panel.buildView({ state, ruleRecords: [], view: 'accounts', now: NOW });
    assert.equal(view.view, 'accounts');
    assert.deepEqual(view.accounts.blocked.map((item) => item.mid), ['1001']);
    assert.deepEqual(view.accounts.allowed.map((item) => item.mid), ['2002']);
    assert.deepEqual(view.kept.map((item) => item.commentKey), ['kept1']);
    assert.equal(view.accounts.blocked[0].timeText, '今天 21:56');
  });

  it('切换视图不改变底层状态', () => {
    const before = purgeState.normalize(state);
    panel.buildView({ state, ruleRecords: [], view: 'accounts', now: NOW });
    panel.buildView({ state, ruleRecords: [], view: 'records', now: NOW });
    assert.deepEqual(purgeState.normalize(state), before);
  });
});

describe('面板 DOM：打开关闭、切视图、动作按钮', () => {
  function setup() {
    const doc = parseHTML('<html><body></body></html>');
    const calls = [];
    let state = purgeState.hide(purgeState.create(), { commentKey: 'm1', mid: '2002', scope: 'thread', at: NOW - MINUTE });
    state = purgeState.blockAccount(state, { mid: '2002', at: NOW - 6 * MINUTE });
    state = purgeState.allowAccount(state, { mid: '3003', at: NOW - 7 * MINUTE });
    const controller = {
      getState: () => state,
      last: () => ({ entries: [] }),
      restoreComment: (key) => {
        calls.push(['restore', key]);
        state = purgeState.restore(state, { commentKey: key, at: NOW });
        return Promise.resolve(true);
      },
      unblockAccount: (mid) => {
        calls.push(['unblock', mid]);
        state = purgeState.unblockAccount(state, { mid });
        return Promise.resolve(true);
      },
      removeAllowedAccount: (mid) => {
        calls.push(['unallow', mid]);
        state = purgeState.removeAllowedAccount(state, { mid });
        return Promise.resolve(true);
      },
    };
    const cleared = [];
    const records = { list: () => [], clear: () => cleared.push('clear') };
    const instance = panel.create({ doc, controller, records, now: () => NOW });
    return { doc, instance, calls, cleared, getState: () => state };
  }

  it('打开后挂到文档，关闭后摘掉', () => {
    const { doc, instance } = setup();
    assert.equal(instance.isOpen(), false);
    instance.open();
    assert.equal(instance.isOpen(), true);
    assert.ok(doc.body.querySelector('[data-dshcc="panel"]'));
    instance.close();
    assert.equal(instance.isOpen(), false);
    assert.equal(doc.body.querySelector('[data-dshcc="panel"]'), null);
  });

  it('记录视图每条都有恢复入口，点击恢复该条且不解除作者屏蔽', async () => {
    const { instance, calls, getState } = setup();
    instance.open();
    const buttons = instance.root().querySelectorAll('[data-act="restore"]');
    assert.equal(buttons.length, 1);
    buttons[0].click();
    await Promise.resolve();
    assert.deepEqual(calls, [['restore', 'm1']]);
    assert.deepEqual(getState().accountBlocked, ['2002']);
    instance.close();
  });

  it('名单视图提供独立的取消屏蔽动作', async () => {
    const { instance, calls } = setup();
    instance.open();
    instance.setView('accounts');
    assert.equal(instance.root().querySelectorAll('[data-act="restore"]').length, 0);
    const unblock = instance.root().querySelectorAll('[data-act="unblock"]');
    assert.equal(unblock.length, 1);
    assert.equal(unblock[0].getAttribute('data-mid'), '2002');
    unblock[0].click();
    await Promise.resolve();
    assert.deepEqual(calls, [['unblock', '2002']]);
    instance.close();
  });

  it('清空记录只清规则记录', async () => {
    const { instance, cleared, calls } = setup();
    instance.open();
    instance.root().querySelector('[data-act="clear-records"]').click();
    await Promise.resolve();
    assert.deepEqual(cleared, ['clear']);
    assert.deepEqual(calls, []);
    instance.close();
  });

  it('切回记录视图会重新渲染', () => {
    const { instance } = setup();
    instance.open();
    instance.setView('accounts');
    assert.ok(instance.root().textContent.includes('账号'));
    instance.setView('records');
    assert.ok(instance.root().textContent.includes('手动隐藏'));
    instance.close();
  });
});

describe('保留例外视图：单独一页只做查阅', () => {
  const state = purgeState.restore(
    purgeState.restore(purgeState.create(), { commentKey: 'k1', at: NOW - 2 * MINUTE }),
    { commentKey: 'k2', at: NOW - 3 * MINUTE },
  );

  it('三个视图都在，保留例外的条数写在标签上', () => {
    assert.deepEqual(panel.VIEWS, ['records', 'accounts', 'kept']);
    const view = panel.buildView({ state, ruleRecords: [], view: 'kept', now: NOW });
    assert.equal(view.view, 'kept');
    assert.equal(view.title, '保留例外');
    assert.deepEqual(view.kept.map((item) => item.commentKey), ['k1', 'k2']);
    assert.equal(view.emptyText, '还没有保留例外');
  });

  it('切到保留例外只列出例外，不给恢复或解除屏蔽入口', () => {
    const doc = parseHTML('<html><body></body></html>');
    const controller = {
      getState: () => state,
      last: () => ({ entries: [] }),
      restoreComment() { throw new Error('不该被调用'); },
      unblockAccount() { throw new Error('不该被调用'); },
      removeAllowedAccount() { throw new Error('不该被调用'); },
    };
    const instance = panel.create({ doc, controller, records: { list: () => [], clear() {} }, now: () => NOW });
    instance.open();
    instance.setView('kept');
    assert.equal(instance.getView(), 'kept');
    assert.equal(instance.root().querySelectorAll('[data-act="restore"]').length, 0);
    assert.equal(instance.root().querySelectorAll('[data-act="unblock"]').length, 0);
    assert.equal(instance.root().querySelectorAll('[data-act="view"]').length, 3);
    assert.ok(instance.root().textContent.includes('评论 k1'));
    instance.close();
  });
});

// ---- 跟着视频切换 -----------------------------------------------------------

describe('记录视图：跟着视频切换', () => {
  const AID_A = '111457272440544';
  const AID_B = '222457272440544';

  function stateWithTwoVideos() {
    let state = purgeState.hide(purgeState.create(), {
      commentKey: 'mA', mid: '2001', action: 'hide', scope: 'thread', at: NOW - MINUTE, aid: AID_A,
    });
    state = purgeState.hide(state, {
      commentKey: 'mB', mid: '2002', action: 'hide', scope: 'thread', at: NOW - MINUTE, aid: AID_B,
    });
    return state;
  }

  it('两个 aid 各自只看到自己的手动记录与规则记录', () => {
    const state = stateWithTwoVideos();
    const rules = [
      ruleRecord({ commentKey: 'rA', mid: '3001', aid: AID_A }),
      ruleRecord({ commentKey: 'rB', mid: '3002', aid: AID_B }),
    ];

    const a = panel.buildView({ state, ruleRecords: rules, view: 'records', aid: AID_A, now: NOW });
    assert.equal(a.aid, AID_A);
    assert.deepEqual(a.records.map((item) => item.commentKey).sort(), ['mA', 'rA']);

    const b = panel.buildView({ state, ruleRecords: rules, view: 'records', aid: AID_B, now: NOW });
    assert.equal(b.aid, AID_B);
    assert.deepEqual(b.records.map((item) => item.commentKey).sort(), ['mB', 'rB']);
  });

  it('aid 缺失时保持宽容：老数据与没带 aid 的记录都照常显示', () => {
    const state = stateWithTwoVideos();
    const rules = [ruleRecord({ commentKey: 'rNoAid' })];

    const all = panel.buildView({ state, ruleRecords: rules, view: 'records', now: NOW });
    assert.deepEqual(all.records.map((item) => item.commentKey).sort(), ['mA', 'mB', 'rNoAid']);
    assert.equal(all.aid, '');
  });

  it('create 后 setContext 换 aid，model() 的记录跟着换', () => {
    const state = stateWithTwoVideos();
    const instance = panel.create({
      doc: parseHTML('<html><body></body></html>'),
      controller: { getState: () => state, last: () => ({ entries: [] }) },
      records: { list: () => [ruleRecord({ commentKey: 'rA', mid: '3001', aid: AID_A })], clear() {} },
      aid: AID_A,
      now: () => NOW,
    });

    assert.equal(instance.getAid(), AID_A);
    assert.equal(instance.model().aid, AID_A);
    assert.deepEqual(instance.model().records.map((item) => item.commentKey).sort(), ['mA', 'rA']);

    instance.setContext({ aid: AID_B });
    assert.equal(instance.getAid(), AID_B);
    assert.equal(instance.model().aid, AID_B);
    assert.deepEqual(instance.model().records.map((item) => item.commentKey).sort(), ['mB']);
  });
});
