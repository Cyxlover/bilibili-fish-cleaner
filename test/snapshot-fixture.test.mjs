// 夹具自检：确认离线 DOM 能按真实快照还原嵌套 shadow DOM，
// 否则后续页面适配层的测试就没在测真实结构。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// 快照是可选的本地研究数据：缺失时本文件跳过（开源仓库的正常状态）。
import { hasSnapshots, loadSnapshot } from './support/fixtures.mjs';

const NO_SNAPSHOTS = !hasSnapshots() && '缺少本地页面快照';

describe('真实快照夹具', { skip: NO_SNAPSHOTS }, () => {
  const document = loadSnapshot('initial');
  const app = document.querySelector('#commentapp');
  const host = app.querySelector('bili-comments');
  const shadow = host.shadowRoot;
  const feed = shadow.querySelector('#contents #feed');

  it('能穿透 bili-comments 的 shadow root 找到评论流', () => {
    assert.ok(shadow, 'bili-comments 的 shadowRoot 应存在');
    assert.ok(feed, '#contents > #feed 应存在');
  });

  it('评论流里有两条一级评论，且每条都能进入自己的 shadow root', () => {
    const threads = feed.querySelectorAll('bili-comment-thread-renderer');

    assert.equal(threads.length, 2);
    for (const thread of threads) {
      assert.ok(thread.shadowRoot, '一级评论宿主的 shadowRoot 应存在');
      assert.ok(thread.shadowRoot.querySelector('bili-comment-renderer#comment'));
    }
  });

  it('一级评论能读到作者 mid、昵称与正文纯文本', () => {
    const thread = feed.querySelectorAll('bili-comment-thread-renderer')[0];
    const comment = thread.shadowRoot.querySelector('bili-comment-renderer#comment');
    const commentShadow = comment.shadowRoot;

    assert.equal(
      commentShadow.querySelector('a#user-avatar').getAttribute('data-user-profile-id'),
      '10220021',
    );
    const userInfo = commentShadow.querySelector('bili-comment-user-info');
    const userName = userInfo.shadowRoot.querySelector('#user-name');
    assert.equal(userName.getAttribute('data-user-profile-id'), '10220021');
    assert.ok(userName.querySelector('a').textContent.trim().length > 0);

    const richText = commentShadow.querySelector('bili-rich-text');
    assert.ok(richText.shadowRoot.querySelector('p#contents').textContent.trim().length > 0);
  });

  it('能读到楼中楼：容器在 thread 的 shadow 里，每条回复有自己的 shadow root', () => {
    const thread = feed.querySelectorAll('bili-comment-thread-renderer')[0];
    const repliesRenderer = thread.shadowRoot.querySelector('#replies bili-comment-replies-renderer');
    assert.ok(repliesRenderer, '楼中楼容器应在 thread 的 shadow root 里');

    const replies = repliesRenderer.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
    assert.equal(replies.length, 1);
    assert.ok(replies[0].shadowRoot.querySelector('bili-rich-text').shadowRoot.querySelector('p#contents'));
  });

  it('保留 body 属性里的视频 aid', () => {
    assert.match(host.getAttribute('data-params'), /^1,\d+$/);
  });
});
