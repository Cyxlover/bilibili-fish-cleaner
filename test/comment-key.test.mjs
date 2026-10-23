import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

const { commentKey } = await loadExtension('src/lib/comment-key.js');

const videoA = { aid: '117457272440544' };
const videoB = { aid: '998877665544' };

describe('合成评论标识', () => {
  it('同一视频、同一作者、同一正文得到同一个标识（页面重渲染后不变）', () => {
    const first = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频讲得清楚。' });
    const afterRerender = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频讲得清楚。' });

    assert.equal(first, afterRerender);
  });

  it('视频不同则标识不同', () => {
    const a = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频讲得清楚。' });
    const b = commentKey.buildKey({ ...videoB, mid: '10220021', text: '这个视频讲得清楚。' });

    assert.notEqual(a, b);
  });

  it('作者不同则标识不同', () => {
    const a = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频讲得清楚。' });
    const b = commentKey.buildKey({ ...videoA, mid: '547756523', text: '这个视频讲得清楚。' });

    assert.notEqual(a, b);
  });

  it('正文只差空白（换行、连续空格、首尾空白）时视为同一条', () => {
    const a = commentKey.buildKey({ ...videoA, mid: '10220021', text: '  这个视频\n讲得  清楚。 ' });
    const b = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频 讲得 清楚。' });

    assert.equal(a, b);
  });

  it('正文不同则标识不同', () => {
    const a = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频讲得清楚。' });
    const b = commentKey.buildKey({ ...videoA, mid: '10220021', text: '这个视频讲得不太清楚。' });

    assert.notEqual(a, b);
  });

  it('楼中楼标识与其所属一级评论的标识不同，且同一楼中楼重复出现时保持一致', () => {
    const root = commentKey.buildKey({ ...videoA, mid: '10220021', text: '一级评论正文' });
    const reply = commentKey.buildKey({
      ...videoA,
      mid: '547756523',
      text: '楼中楼回复正文',
      rootCommentKey: root,
    });
    const replyAgain = commentKey.buildKey({
      ...videoA,
      mid: '547756523',
      text: '楼中楼回复正文',
      rootCommentKey: root,
    });

    assert.notEqual(reply, root);
    assert.equal(reply, replyAgain);
  });

  it('相同作者与正文的楼中楼，挂在不同的以及评论下时标识不同', () => {
    const rootA = commentKey.buildKey({ ...videoA, mid: '10220021', text: '一级评论正文 A' });
    const rootB = commentKey.buildKey({ ...videoA, mid: '10220021', text: '一级评论正文 B' });
    const underA = commentKey.buildKey({
      ...videoA,
      mid: '547756523',
      text: '楼中楼回复正文',
      rootCommentKey: rootA,
    });
    const underB = commentKey.buildKey({
      ...videoA,
      mid: '547756523',
      text: '楼中楼回复正文',
      rootCommentKey: rootB,
    });

    assert.notEqual(underA, underB);
  });

  it('标识可直接作为 HTML 属性值与存储键使用（仅字母数字冒号下划线点横线）', () => {
    const key = commentKey.buildKey({
      ...videoA,
      mid: '10220021',
      text: '含标点、表情 [抓狂]、@某人 与 emoji 🐟 的正文',
    });

    assert.match(key, /^[A-Za-z0-9:_.-]+$/);
  });
});
