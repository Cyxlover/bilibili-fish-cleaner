// 计数徽标：只显示「我读到了几条」，不做任何判定与隐藏。
//
// 徽标挂在页面角落的固定位置，内部用 shadow DOM 渲染，避免被站点 CSS 影响，
// 也避免自己的样式漏进评论区（要求：装完插件评论区外观不变）。

(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});

  var HOST_ID = 'dshcc-badge';
  var TITLE = '大肥鱼清除计划';

  var HOST_STYLE = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'z-index: 2147483000',
    'pointer-events: none',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'background: none',
  ].join(';');

  var SHADOW_HTML = [
    '<style>',
    ':host { all: initial; }',
    '.box {',
    '  box-sizing: border-box;',
    '  pointer-events: auto;',
    '  min-width: 148px;',
    '  max-width: 280px;',
    '  padding: 8px 10px;',
    '  border-radius: 8px;',
    '  border: 1px solid rgba(255, 255, 255, 0.16);',
    '  background: rgba(24, 25, 28, 0.88);',
    '  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);',
    '  color: #fff;',
    '  font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;',
    '  font-size: 12px;',
    '  line-height: 1.5;',
    '  text-align: left;',
    '  white-space: normal;',
    '}',
    '.title {',
    '  font-size: 11px;',
    '  letter-spacing: 0.02em;',
    '  opacity: 0.72;',
    '}',
    '.counts {',
    '  display: flex;',
    '  gap: 12px;',
    '  margin-top: 2px;',
    '  font-variant-numeric: tabular-nums;',
    '}',
    '.count { white-space: nowrap; }',
    '.count b {',
    '  font-size: 15px;',
    '  font-weight: 600;',
    '  color: #4cc2ff;',
    '}',
    '.hint {',
    '  margin-top: 2px;',
    '  color: #ffd76e;',
    '  font-size: 11px;',
    '}',
    '.is-disabled .hint { color: #ff9a9a; }',
    '.toggle {',
    '  margin-top: 6px;',
    '  padding: 3px 8px;',
    '  border: 1px solid rgba(255, 255, 255, 0.28);',
    '  border-radius: 999px;',
    '  background: rgba(255, 255, 255, 0.08);',
    '  color: #fff;',
    '  font: inherit;',
    '  font-size: 11px;',
    '  cursor: pointer;',
    '}',
    '.toggle:hover { background: rgba(255, 255, 255, 0.16); }',
    '.toggle[aria-pressed="true"] { border-color: #4cc2ff; color: #9fdcff; }',
    '.strength {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  margin-top: 6px;',
    '  font-size: 11px;',
    '  opacity: 0.85;',
    '}',
    '.strength select {',
    '  flex: 1 1 auto;',
    '  padding: 2px 4px;',
    '  border: 1px solid rgba(255, 255, 255, 0.28);',
    '  border-radius: 6px;',
    '  background: rgba(255, 255, 255, 0.08);',
    '  color: #fff;',
    '  font: inherit;',
    '  font-size: 11px;',
    '  cursor: pointer;',
    '}',
    '.strength select option { color: #111; }',
    '[hidden] { display: none !important; }',
    '</style>',
    '<div class="box">',
    '  <div class="title"></div>',
    '  <div class="counts">',
    '    <span class="count" data-role="threads">一级评论 <b>0</b></span>',
    '    <span class="count" data-role="replies">楼中楼 <b>0</b></span>',
    '  </div>',
    '  <div class="hint" hidden></div>',
    '  <button class="toggle" type="button" data-role="purge-toggle" aria-pressed="false">自动清除：关</button>',
    '  <label class="strength">清除强度',
    '    <select data-role="purge-strength">',
    '      <option value="conservative">保守</option>',
    '      <option value="standard">标准</option>',
    '      <option value="aggressive">激进</option>',
    '    </select>',
    '  </label>',
    '</div>',
  ].join('\n');

  var STRENGTHS = ['conservative', 'standard', 'aggressive'];
  var DEFAULT_STRENGTH = 'aggressive';

  function normalizeStrength(value) {
    return STRENGTHS.indexOf(value) === -1 ? DEFAULT_STRENGTH : value;
  }

  function toCount(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  // 纯函数：把一次扫描结果变成徽标要显示的文案。
  // 单独抽出来是为了让「徽标显示什么」可以在 Node 里离线测试。
  function formatView(input) {
    var view = input || {};
    var status = view.status || 'no-comment-app';
    var state = view.state || (ns.pageAdapter && ns.pageAdapter.statusState
      ? ns.pageAdapter.statusState(status)
      : 'waiting');
    var message = view.message || (ns.pageAdapter && ns.pageAdapter.statusMessage
      ? ns.pageAdapter.statusMessage(status)
      : '');
    // 开关是独立字段：不挤进 title/hint，避免把「隐藏/疑似」这类词带进
    // 徽标原有的中性文案（gate-and-badge 有回归断言）。
    var purge = view.purge || {};
    var purgeEnabled = view.purgeEnabled === true || purge.enabled === true;
    // 档位同样单独成字段：不并入 title/hint，徽标主文案保持中性。
    var strength = normalizeStrength(view.strength !== undefined ? view.strength : purge.strength);

    if (state === 'ok') {
      return {
        state: 'ok',
        title: TITLE,
        threads: toCount(view.threads),
        replies: toCount(view.replies),
        showCounts: true,
        hint: '',
        showHint: false,
        purgeEnabled: purgeEnabled,
        toggleLabel: purgeEnabled ? '自动清除：开' : '自动清除：关',
        strength: strength,
      };
    }

    return {
      state: state,
      title: TITLE,
      threads: toCount(view.threads),
      replies: toCount(view.replies),
      showCounts: false,
      hint: message || '评论区暂不可用',
      showHint: true,
      purgeEnabled: purgeEnabled,
      toggleLabel: purgeEnabled ? '自动清除：开' : '自动清除：关',
      strength: strength,
    };
  }

  function mount(doc, options) {
    var target = doc || (typeof document === 'undefined' ? null : document);
    var opts = options || {};
    if (!target || !target.documentElement) {
      return null;
    }

    var host = target.createElement('div');
    host.setAttribute('id', HOST_ID);
    host.setAttribute('style', HOST_STYLE);
    host.setAttribute('data-dshcc', 'badge');

    var shadow = host.attachShadow({ mode: 'open' });
    if (target.documentElement.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      shadow.innerHTML = SHADOW_HTML;
    } else {
      shadow.innerHTML = SHADOW_HTML;
    }

    var box = shadow.querySelector('.box');
    var titleEl = shadow.querySelector('.title');
    var countsEl = shadow.querySelector('.counts');
    var threadsEl = shadow.querySelector('[data-role="threads"] b');
    var repliesEl = shadow.querySelector('[data-role="replies"] b');
    var hintEl = shadow.querySelector('.hint');
    var toggleEl = shadow.querySelector('[data-role="purge-toggle"]');
    var strengthEl = shadow.querySelector('[data-role="purge-strength"]');

    if (toggleEl) {
      toggleEl.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof opts.onPurgeToggle === 'function') opts.onPurgeToggle();
      });
    }

    if (strengthEl) {
      strengthEl.addEventListener('change', function () {
        if (typeof opts.onStrengthChange === 'function') opts.onStrengthChange(strengthEl.value);
      });
    }

    target.documentElement.appendChild(host);

    function render(input) {
      var view = formatView(input);
      titleEl.textContent = view.title;
      threadsEl.textContent = String(view.threads);
      repliesEl.textContent = String(view.replies);
      countsEl.hidden = !view.showCounts;
      hintEl.textContent = view.hint;
      hintEl.hidden = !view.showHint;
      box.setAttribute('class', view.state === 'disabled' ? 'box is-disabled' : 'box');
      if (toggleEl) {
        toggleEl.textContent = view.toggleLabel;
        toggleEl.setAttribute('aria-pressed', view.purgeEnabled ? 'true' : 'false');
      }
      if (strengthEl) strengthEl.value = view.strength;
      host.setAttribute('data-dshcc-purge', view.purgeEnabled ? 'on' : 'off');
      host.setAttribute('data-dshcc-strength', view.strength);

      // 供人工核对与自动化核对用的机器可读状态（不影响页面外观）
      host.setAttribute('data-dshcc-state', view.state);
      host.setAttribute('data-dshcc-threads', String(view.threads));
      host.setAttribute('data-dshcc-replies', String(view.replies));
      host.setAttribute('data-dshcc-status', String(input && input.status ? input.status : ''));
      host.setAttribute('data-dshcc-aid', String(input && input.aid ? input.aid : ''));
    }

    function destroy() {
      if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
    }

    return {
      host: host,
      shadow: shadow,
      render: render,
      destroy: destroy,
    };
  }

  ns.badge = {
    HOST_ID: HOST_ID,
    TITLE: TITLE,
    STRENGTHS: STRENGTHS,
    DEFAULT_STRENGTH: DEFAULT_STRENGTH,
    normalizeStrength: normalizeStrength,
    formatView: formatView,
    mount: mount,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
