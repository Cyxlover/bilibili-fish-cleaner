// 关闭自动清除时的「标记」层：只往评论主体里插一块提示，不改正文、不移除节点。
//
// hide 用红色实线标签（比 suspect 更醒目），suspect 用蓝色虚线标签；原生
// title 提供悬停线索明细。标记按 commentKey 记账，重复扫描原地更新不叠加。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var VERSION = 'v1';
  var ATTR = 'data-dshcc-mark';

  var STYLES = {
    hidden: 'display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin:6px 0;padding:4px 8px;' +
      'border:1px solid #ff4d4f;border-radius:4px;background:#fff1f0;color:#a8071a;' +
      'font-size:12px;line-height:18px;',
    suspect: 'display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin:6px 0;padding:4px 8px;' +
      'border:1px dashed #1677ff;border-radius:4px;background:#f0f7ff;color:#0958d9;' +
      'font-size:12px;line-height:18px;',
  };

  function labelOf(tone) {
    return tone === 'suspect' ? '疑似评论 · 仅提示' : '规则命中 · 自动清除已关闭';
  }

  // 线索强度只做展示：引擎给的是 1–4 档数字，旧记录与夹具里是字符串，两种都要能显示；
  // 缺失或空串则不加任何后缀。
  function strengthText(strength) {
    if (typeof strength === 'number' && isFinite(strength)) return '强度 ' + strength;
    if (typeof strength === 'string' && strength !== '') return strength;
    return '';
  }

  function clueText(clue) {
    var label = clue && clue.label ? clue.label : '未命名线索';
    var suffix = strengthText(clue && clue.strength);
    var head = clue && clue.fragment ? label + '（' + clue.fragment + '）' : label;
    return suffix ? head + ' · ' + suffix : head;
  }

  function titleOf(clues) {
    if (!Array.isArray(clues) || clues.length === 0) return '判定线索：暂无明细';
    return '判定线索：\n' + clues.map(function (clue) {
      return '· ' + clueText(clue);
    }).join('\n');
  }

  function detailOf(clues) {
    if (!Array.isArray(clues) || clues.length === 0) return '线索不足';
    return clues.map(function (clue) {
      var label = clue && clue.label ? clue.label : '未命名线索';
      var suffix = strengthText(clue && clue.strength);
      return suffix ? label + '（' + suffix + '）' : label;
    }).join(' · ');
  }

  function paint(element, item) {
    var tone = item.tone === 'suspect' ? 'suspect' : 'hidden';
    element.setAttribute(ATTR, tone);
    element.setAttribute('data-dshcc-comment-key', String(item.commentKey || ''));
    element.setAttribute('role', 'note');
    element.setAttribute('style', STYLES[tone]);
    element.setAttribute('title', titleOf(item.clues));

    var label = element.querySelector('[data-dshcc-part="label"]');
    var detail = element.querySelector('[data-dshcc-part="detail"]');
    if (label) label.textContent = labelOf(tone);
    if (detail) detail.textContent = detailOf(item.clues);
  }

  function createElement(doc, item) {
    var element = doc.createElement('div');
    var label = doc.createElement('span');
    var detail = doc.createElement('span');
    label.setAttribute('data-dshcc-part', 'label');
    detail.setAttribute('data-dshcc-part', 'detail');
    detail.setAttribute('style', 'opacity:.8;');
    element.appendChild(label);
    element.appendChild(detail);
    paint(element, item);
    return element;
  }

  function create(doc) {
    var targetDocument = doc || (typeof document === 'undefined' ? null : document);
    var mounted = new Map();

    function removeEntry(key) {
      var entry = mounted.get(key);
      if (!entry) return;
      if (entry.element.parentNode) entry.element.parentNode.removeChild(entry.element);
      mounted.delete(key);
    }

    return {
      apply: function (items) {
        var desired = Object.create(null);
        var list = Array.isArray(items) ? items : [];

        for (var i = 0; i < list.length; i += 1) {
          var item = list[i];
          if (!item || typeof item.commentKey !== 'string' || !item.body) continue;
          desired[item.commentKey] = true;
          var existing = mounted.get(item.commentKey);

          if (existing && existing.body === item.body) {
            paint(existing.element, item);
            continue;
          }
          if (existing) removeEntry(item.commentKey);
          var element = createElement(targetDocument, item);
          item.body.insertBefore(element, item.body.firstChild);
          mounted.set(item.commentKey, { element: element, body: item.body });
        }

        Array.from(mounted.keys()).forEach(function (key) {
          if (!desired[key]) removeEntry(key);
        });
      },
      clear: function () {
        Array.from(mounted.keys()).forEach(removeEntry);
      },
      count: function () {
        return mounted.size;
      },
      markerFor: function (commentKey) {
        var entry = mounted.get(commentKey);
        return entry ? entry.element : null;
      },
    };
  }

  NS.purgeMarker = {
    VERSION: VERSION,
    ATTR: ATTR,
    create: create,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
