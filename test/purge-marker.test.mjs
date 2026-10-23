// 关闭状态下的「标记」：hide 与 suspect 必须一眼能区分，悬停能看到线索，
// 重复扫描不能叠出一堆标记，重新渲染后要跟着新节点走。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';
import { parseHTML } from './support/mini-dom.mjs';

await loadExtension('src/lib/purge-marker.js');
const { purgeMarker } = globalThis.DSHCC;

function page() {
  const document = parseHTML(`
    <html><body>
      <bili-comments>
        <bili-comment-thread-renderer>
          <bili-comment-renderer id="comment">
            <div id="body"><bili-rich-text><p id="contents">一级评论</p></bili-rich-text></div>
          </bili-comment-renderer>
        </bili-comment-thread-renderer>
      </bili-comments>
    </body></html>
  `);
  return { document, body: document.querySelector('div#body') };
}

const clue = (label, fragment, strength) => ({ label, fragment, strength, used: true });

describe('标记：两种判定可区分', () => {
  it('hide 标记与 suspect 标记使用不同的 tone 与文案', () => {
    const { document, body } = page();
    const ui = purgeMarker.create(document);
    ui.apply([
      { commentKey: 'k1', tone: 'hidden', clues: [clue('昵称含鱼', '大肥鱼', 2)], body },
      { commentKey: 'k2', tone: 'suspect', clues: [clue('称呼主人', '主人', 3)], body },
    ]);

    const hidden = body.querySelector('[data-dshcc-mark="hidden"]');
    const suspect = body.querySelector('[data-dshcc-mark="suspect"]');
    assert.ok(hidden);
    assert.ok(suspect);
    assert.notEqual(hidden.textContent, suspect.textContent);
    assert.match(hidden.textContent, /自动清除已关闭/);
    assert.match(suspect.textContent, /疑似/);
  });

  it('悬停提示包含线索标签与命中片段', () => {
    const { document, body } = page();
    const ui = purgeMarker.create(document);
    ui.apply([
      {
        commentKey: 'k1',
        tone: 'hidden',
        clues: [clue('昵称含鱼', '大肥鱼', 2), clue('称呼主人', '主人', 3)],
        body,
      },
    ]);

    const marker = body.querySelector('[data-dshcc-mark]');
    const title = marker.getAttribute('title');
    assert.match(title, /昵称含鱼/);
    assert.match(title, /大肥鱼/);
    assert.match(title, /称呼主人/);
  });

  it('线索强度带进标记：数字显示「强度 N」，字符串原样，缺失不加后缀', () => {
    const { document, body } = page();
    const ui = purgeMarker.create(document);
    ui.apply([
      {
        commentKey: 'k1',
        tone: 'hidden',
        clues: [
          clue('昵称含鱼', '大肥鱼', 2),
          { label: '称呼主人', fragment: '主人', strength: 'strong', used: true },
          { label: '正文复读', fragment: '', used: true },
        ],
        body,
      },
    ]);

    const marker = body.querySelector('[data-dshcc-mark]');
    const title = marker.getAttribute('title');
    assert.match(title, /昵称含鱼（大肥鱼） · 强度 2/);
    assert.match(title, /称呼主人（主人） · strong/);
    assert.equal(title.split('\n').pop(), '· 正文复读');
    assert.doesNotMatch(title, /undefined/);
  });

  it('标记放在正文之前，不污染正文内容', () => {
    const { document, body } = page();
    const ui = purgeMarker.create(document);
    ui.apply([{ commentKey: 'k1', tone: 'hidden', clues: [], body }]);

    assert.equal(body.firstElementChild.getAttribute('data-dshcc-mark'), 'hidden');
    assert.equal(document.querySelector('p#contents').textContent, '一级评论');
  });
});

describe('标记：重复扫描与重渲染', () => {
  it('同一节点重复 apply 不会叠加标记', () => {
    const { document, body } = page();
    const ui = purgeMarker.create(document);
    const items = [{ commentKey: 'k1', tone: 'hidden', clues: [], body }];
    ui.apply(items);
    ui.apply(items);
    ui.apply(items);

    assert.equal(ui.count(), 1);
    assert.equal(body.querySelectorAll('[data-dshcc-mark]').length, 1);
  });

  it('节点被重渲染后，标记跟到新节点，旧节点上的标记被清掉', () => {
    const { document, body } = page();
    const replacement = document.createElement('div');
    replacement.setAttribute('id', 'body');
    replacement.setAttribute('data-new', '');
    const holder = document.querySelector('bili-comment-renderer');
    holder.replaceChild(replacement, body);

    const ui = purgeMarker.create(document);
    ui.apply([{ commentKey: 'k1', tone: 'hidden', clues: [], body }]);
    assert.equal(body.querySelectorAll('[data-dshcc-mark]').length, 1);

    ui.apply([{ commentKey: 'k1', tone: 'hidden', clues: [], body: replacement }]);
    assert.equal(body.querySelectorAll('[data-dshcc-mark]').length, 0);
    assert.equal(replacement.querySelectorAll('[data-dshcc-mark]').length, 1);
    assert.equal(ui.count(), 1);
  });

  it('apply 空列表或 clear 会移除全部标记', () => {
    const { document, body } = page();
    const ui = purgeMarker.create(document);
    ui.apply([{ commentKey: 'k1', tone: 'hidden', clues: [], body }]);
    ui.apply([]);
    assert.equal(body.querySelectorAll('[data-dshcc-mark]').length, 0);
    assert.equal(ui.count(), 0);

    ui.apply([{ commentKey: 'k2', tone: 'suspect', clues: [], body }]);
    ui.clear();
    assert.equal(body.querySelectorAll('[data-dshcc-mark]').length, 0);
  });
});
