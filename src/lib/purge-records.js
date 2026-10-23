// 自动清除的隐藏记录：只记录「规则真的移除了哪条评论」。
//
// 记录只活在当前页面会话里：规则隐藏是临时效果，关闭开关就清空；不写
// chrome.storage、不写账号名单、不跨刷新累积。后续面板可直接 list() 展示。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var VERSION = 'v1';
  var LIMIT = 500;

  function cleanClues(clues) {
    if (!Array.isArray(clues)) return [];
    return clues.map(function (clue) {
      return {
        clueId: clue && clue.clueId,
        source: clue && clue.source,
        strength: clue && clue.strength,
        fragment: clue && clue.fragment,
        label: clue && clue.label,
      };
    });
  }

  function create(options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : LIMIT;
    var items = [];

    function add(entry) {
      if (!entry || typeof entry.commentKey !== 'string' || entry.commentKey === '') return null;
      var record = {
        commentKey: entry.commentKey,
        mid: entry.mid == null ? null : String(entry.mid),
        rulesVersion: entry.rulesVersion || '',
        action: entry.action === 'hide' ? 'hide' : entry.action,
        clues: cleanClues(entry.clues),
        scope: entry.scope === 'reply' ? 'reply' : 'thread',
        rootCommentKey: entry.rootCommentKey == null ? null : entry.rootCommentKey,
        at: typeof entry.at === 'number' ? entry.at : now(),
      };
      items.push(record);
      if (items.length > limit) items.splice(0, items.length - limit);
      return record;
    }

    return {
      add: add,
      clear: function () {
        items.length = 0;
      },
      list: function () {
        return items.slice();
      },
      count: function () {
        return items.length;
      },
    };
  }

  NS.purgeRecords = {
    VERSION: VERSION,
    LIMIT: LIMIT,
    create: create,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
