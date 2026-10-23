// 悬停手动入口：只负责把用户动作转给控制器，不自己判定、不自己动节点。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';
import { parseHTML } from './support/mini-dom.mjs';

await loadExtension('src/ui/manual-actions.js');
const { manualActions } = globalThis.DSHCC;

function fixture() {
  const doc = parseHTML([
    '<html><body><div id="commentapp"><bili-comments>',
    '<template shadowrootmode="open"><div id="feed">',
    '<bili-comment-thread-renderer id="t1"><div id="body"><p id="contents">一级评论</p></div></bili-comment-thread-renderer>',
    '<bili-comment-thread-renderer id="t2"><div id="body"><p id="contents">楼中楼作者</p></div></bili-comment-thread-renderer>',
    '</div></template>',
    '</bili-comments></div></body></html>',
  ].join(''));
  const feed = doc.querySelector('bili-comments').shadowRoot.querySelector('#feed');
  const t1 = feed.querySelector('#t1');
  const t2 = feed.querySelector('#t2');
  return {
    doc, feed, t1, t2,
    body1: t1.querySelector('#body'),
    body2: t2.querySelector('#body'),
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

function fakeController() {
  const calls = [];
  return {
    calls,
    hideComment: async (entry) => { calls.push(['hide', entry.observation.commentKey, entry.observation.mid]); },
    restoreComment: async (key) => { calls.push(['restore', key]); },
    blockAccount: async (mid) => { calls.push(['block', String(mid)]); },
    last: () => null,
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 与 src/ui/manual-actions.js 的 LEAVE_DELAY 保持一致：留出把鼠标移到按钮上的时间。
const LEAVE_DELAY = 400;

describe('悬停手动入口', () => {
  it('每条评论在悬停时出现隐藏按钮，重复 apply 不叠加', async () => {
    const f = fixture();
    const controller = fakeController();
    const ui = manualActions.create(f.doc, { controller });
    const entries = [
      { observation: observation('k1', 101), node: f.t1, body: f.body1 },
      { observation: observation('k2', 102), node: f.t2, body: f.body2 },
    ];
    ui.apply(entries);

    const b1 = f.body1.querySelector('button[data-dshcc-action="hide"]');
    const b2 = f.body2.querySelector('button[data-dshcc-action="hide"]');
    assert.ok(b1);
    assert.ok(b2);
    assert.equal(b1.hidden, true);
    assert.equal(b1.textContent, '隐藏');

    f.body1.dispatchEvent({ type: 'mouseenter', target: f.body1 });
    assert.equal(b1.hidden, false);
    f.body1.dispatchEvent({ type: 'mouseleave', target: f.body1 });
    await wait(LEAVE_DELAY + 120);
    assert.equal(b1.hidden, true);

    ui.apply(entries);
    assert.equal(f.body1.querySelectorAll('button[data-dshcc-action="hide"]').length, 1);
  });

  // 真实场景：按钮浮在评论右下角、紧贴下一条评论，鼠标从评论移向按钮的途中会先离开评论主体。
  // 若 mouseleave 立刻隐藏，按钮就会在指针到达之前消失，用户永远点不到。
  it('按钮靠近下一条评论时仍然够得到：离开后延迟隐藏，移到按钮上则保持', async () => {
    const f = fixture();
    const controller = fakeController();
    const ui = manualActions.create(f.doc, { controller });
    ui.apply([{ observation: observation('k1', 101), node: f.t1, body: f.body1 }]);

    const button = f.body1.querySelector('button[data-dshcc-action="hide"]');
    f.body1.dispatchEvent({ type: 'mouseenter', target: f.body1 });
    assert.equal(button.hidden, false);

    // 指针离开评论主体、正朝按钮移动：这段时间按钮必须还在。
    f.body1.dispatchEvent({ type: 'mouseleave', target: f.body1 });
    assert.equal(button.hidden, false, '离开评论后不应立刻隐藏');
    await wait(Math.floor(LEAVE_DELAY / 2));
    assert.equal(button.hidden, false, '延迟窗口内应仍然可见');

    // 指针到了按钮上：取消隐藏。
    button.dispatchEvent({ type: 'mouseenter', target: button });
    await wait(LEAVE_DELAY + 120);
    assert.equal(button.hidden, false, '指针停在按钮上时不应隐藏');

    // 指针离开按钮：再等一个延迟窗口才隐藏。
    button.dispatchEvent({ type: 'mouseleave', target: button });
    assert.equal(button.hidden, false);
    await wait(LEAVE_DELAY + 120);
    assert.equal(button.hidden, true, '离开按钮并超时才隐藏');
  });

  it('重新进入评论会取消待定的隐藏', async () => {
    const f = fixture();
    const controller = fakeController();
    const ui = manualActions.create(f.doc, { controller });
    ui.apply([{ observation: observation('k1', 101), node: f.t1, body: f.body1 }]);

    const button = f.body1.querySelector('button[data-dshcc-action="hide"]');
    f.body1.dispatchEvent({ type: 'mouseenter', target: f.body1 });
    f.body1.dispatchEvent({ type: 'mouseleave', target: f.body1 });
    await wait(Math.floor(LEAVE_DELAY / 2));
    f.body1.dispatchEvent({ type: 'mouseenter', target: f.body1 });
    await wait(LEAVE_DELAY + 120);
    assert.equal(button.hidden, false);
  });

  it('点击隐藏调用控制器，并弹出撤销/屏蔽作者/不用了', async () => {
    const f = fixture();
    const controller = fakeController();
    const ui = manualActions.create(f.doc, { controller });
    ui.apply([{ observation: observation('k1', 101), node: f.t1, body: f.body1 }]);

    const button = f.body1.querySelector('button[data-dshcc-action="hide"]');
    button.click();
    await tick();

    assert.deepEqual(controller.calls, [['hide', 'k1', '101']]);
    const toast = f.doc.body.querySelector('#dshcc-manual-toast');
    assert.ok(toast);
    const undo = toast.shadowRoot.querySelector('[data-act="undo"]');
    const block = toast.shadowRoot.querySelector('[data-act="block"]');
    const dismiss = toast.shadowRoot.querySelector('[data-act="dismiss"]');
    assert.ok(undo && block && dismiss);
    assert.match(toast.shadowRoot.textContent, /已隐藏/);

    undo.click();
    await tick();
    assert.deepEqual(controller.calls[1], ['restore', 'k1']);
    assert.equal(f.doc.body.querySelector('#dshcc-manual-toast'), null);
  });

  it('屏蔽作者按钮带上被隐藏评论的 mid，不用了只关闭条', async () => {
    const f = fixture();
    const controller = fakeController();
    const ui = manualActions.create(f.doc, { controller });
    ui.apply([{ observation: observation('k2', 202), node: f.t2, body: f.body2 }]);

    f.body2.querySelector('button[data-dshcc-action="hide"]').click();
    await tick();
    let toast = f.doc.body.querySelector('#dshcc-manual-toast');
    toast.shadowRoot.querySelector('[data-act="block"]').click();
    await tick();
    assert.deepEqual(controller.calls[1], ['block', '202']);
    assert.equal(f.doc.body.querySelector('#dshcc-manual-toast'), null);

    // 真实控制器在屏蔽后会重扫；fake 不返回 last，测试手动补挂入口。
    ui.apply([{ observation: observation('k2', 202), node: f.t2, body: f.body2 }]);
    f.body2.querySelector('button[data-dshcc-action="hide"]').click();
    await tick();
    toast = f.doc.body.querySelector('#dshcc-manual-toast');
    toast.shadowRoot.querySelector('[data-act="dismiss"]').click();
    await tick();
    assert.equal(controller.calls.length, 3);
    assert.equal(f.doc.body.querySelector('#dshcc-manual-toast'), null);
  });

  // 条目被移出列表（例如已隐藏、或切了视频）时，待定的隐藏定时器必须一起清掉，
  // 否则它会在事后把已经摘下来的按钮又改回可见状态。
  it('条目被移出列表后，待定的隐藏定时器不再生效', async () => {
    const f = fixture();
    const controller = fakeController();
    const ui = manualActions.create(f.doc, { controller });
    ui.apply([{ observation: observation('k1', 101), node: f.t1, body: f.body1 }]);

    const button = f.body1.querySelector('button[data-dshcc-action="hide"]');
    f.body1.dispatchEvent({ type: 'mouseenter', target: f.body1 });
    assert.equal(button.hidden, false);

    f.body1.dispatchEvent({ type: 'mouseleave', target: f.body1 }); // 预约隐藏
    ui.apply([]); // 该条移出 → 卸载并清定时器

    await wait(LEAVE_DELAY + 120);
    assert.equal(button.parentNode, null, '按钮应已从 DOM 移除');
    assert.equal(button.hidden, false, '移除后不应再被定时器改写');
  });
});
