// 注入范围闸门与徽标文案的离线测试。
//
// 徽标的 DOM 部分（shadow DOM + 固定定位）只能在浏览器里验证，这里测的是它
// 「显示什么」——把扫描结果变成文案的纯函数，以及站点范围判定。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension(
  'src/lib/comment-key.js',
  'src/lib/dom-selectors.js',
  'src/lib/content-gate.js',
  'src/lib/page-adapter.js',
  'src/ui/badge.js',
);

const ns = globalThis.DSHCC;
const { contentGate, badge, pageAdapter } = ns;

describe('注入范围：只在视频播放页生效', () => {
  const videoPaths = [
    '/video/BV1GJ411x7h7',
    '/video/BV1GJ411x7h7/',
    '/video/BV1GJ411x7h7?spm_id_from=333.999', // 传入 href 派生串时的防御
    '/video/av117457272440544',
    '/video/BV1xx411c7mD/?p=2',
  ];
  for (const pathname of videoPaths) {
    it(`视频页：${pathname}`, () => {
      assert.equal(contentGate.isVideoPage(pathname), true);
      assert.ok(contentGate.videoIdFromPath(pathname));
    });
  }

  const otherPaths = [
    '/',
    '/video/',
    '/bangumi/play/ep123456',
    '/read/cv12345',
    '/space/10220021',
    '/video/BV1GJ411x7h',
    '',
    null,
  ];
  for (const pathname of otherPaths) {
    it(`非视频页：${String(pathname)}`, () => {
      assert.equal(contentGate.isVideoPage(pathname), false);
      assert.equal(contentGate.videoIdFromPath(pathname), null);
    });
  }
});

describe('徽标只显示读到的条数', () => {
  it('正常解析时显示两个计数', () => {
    const view = badge.formatView({
      status: pageAdapter.STATUS.OK,
      state: 'ok',
      threads: 2,
      replies: 1,
    });

    assert.equal(view.state, 'ok');
    assert.equal(view.showCounts, true);
    assert.equal(view.showHint, false);
    assert.equal(view.threads, 2);
    assert.equal(view.replies, 1);
    assert.equal(view.title, badge.TITLE);
  });

  it('计数取整且不接受负数/非数字', () => {
    const view = badge.formatView({ status: 'ok', state: 'ok', threads: 3.9, replies: -1 });
    assert.equal(view.threads, 3);
    assert.equal(view.replies, 0);

    const nan = badge.formatView({ status: 'ok', state: 'ok', replies: 'abc' });
    assert.equal(nan.replies, 0);
  });

  it('等待中不显示计数，显示可读提示', () => {
    const view = badge.formatView({ status: pageAdapter.STATUS.NO_COMMENT_APP });
    assert.equal(view.state, 'waiting');
    assert.equal(view.showCounts, false);
    assert.equal(view.showHint, true);
    assert.ok(view.hint.length > 0);
  });

  it('停用时提示可见且语气是「停用」而非「无评论」', () => {
    const view = badge.formatView({ status: pageAdapter.STATUS.SHADOW_ROOT_UNAVAILABLE });
    assert.equal(view.state, 'disabled');
    assert.equal(view.showCounts, false);
    assert.match(view.hint, /停用/);
  });

  it('未知状态按等待处理，不会伪造计数', () => {
    const view = badge.formatView({ status: 'something-new', threads: 5, replies: 5 });
    assert.equal(view.showCounts, false);
    assert.equal(view.showHint, true);
  });

  it('文案里不出现任何判定性措辞', () => {
    const texts = [];
    for (const status of Object.values(pageAdapter.STATUS)) {
      const view = badge.formatView({ status });
      texts.push(view.title + view.hint);
    }
    for (const text of texts) {
      assert.doesNotMatch(text, /水军|机器人|删除|隐藏|疑似|异常账号/);
    }
  });
});
