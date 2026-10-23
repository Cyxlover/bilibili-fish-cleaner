// 徽标上的自动清除开关：独立字段，不污染中性 title/hint。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';
import { parseHTML } from './support/mini-dom.mjs';

await loadExtension('src/lib/dom-selectors.js', 'src/lib/content-gate.js', 'src/lib/page-adapter.js', 'src/ui/badge.js');
const { badge } = globalThis.DSHCC;

function documentFixture() {
  return parseHTML('<html><body><div id="commentapp"></div></body></html>');
}

describe('徽标：自动清除开关', () => {
  it('开关状态是独立字段，title/hint 保持中性', () => {
    const view = badge.formatView({ status: 'ok', state: 'ok', threads: 1, replies: 0, purge: { enabled: true } });
    assert.equal(view.purgeEnabled, true);
    assert.equal(view.toggleLabel, '自动清除：开');
    assert.doesNotMatch(view.title + view.hint, /隐藏|疑似|自动清除/);
  });

  it('点击开关触发回调，render 更新按钮状态', () => {
    const doc = documentFixture();
    let clicks = 0;
    const ui = badge.mount(doc, { onPurgeToggle: () => { clicks += 1; } });
    const button = ui.shadow.querySelector('[data-role="purge-toggle"]');
    assert.ok(button);
    assert.equal(button.textContent, '自动清除：关');

    button.click();
    assert.equal(clicks, 1);

    ui.render({ status: 'ok', state: 'ok', threads: 1, replies: 0, purge: { enabled: true } });
    assert.equal(button.textContent, '自动清除：开');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(ui.host.getAttribute('data-dshcc-purge'), 'on');

    ui.render({ status: 'ok', state: 'ok', threads: 1, replies: 0, purge: { enabled: false } });
    assert.equal(button.textContent, '自动清除：关');
    assert.equal(ui.host.getAttribute('data-dshcc-purge'), 'off');
  });
});
