// 手动清除与账号名单的纯状态机：状态 + 操作 → 新状态。
//
// 这里不读 DOM、不读存储、不取当前时间，所有输入都由调用方给出。
// 四类持久集合互斥规则只在本文件保证，页面层与面板层只消费 decide()。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var VERSION = 'v1';

  function strings(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i += 1) {
      var value = list[i];
      if (typeof value !== 'string' || value === '') continue;
      if (out.indexOf(value) === -1) out.push(value);
    }
    return out;
  }

  function midOf(value) {
    if (value === null || value === undefined || value === '') return '';
    return String(value);
  }

  function cleanClues(clues) {
    if (!Array.isArray(clues)) return [];
    var out = [];
    for (var i = 0; i < clues.length; i += 1) {
      var clue = clues[i];
      if (!clue || typeof clue !== 'object') continue;
      out.push({
        clueId: clue.clueId,
        source: clue.source,
        strength: clue.strength,
        fragment: clue.fragment,
        label: clue.label,
      });
    }
    return out;
  }

  function cleanRecord(entry, fallbackKey) {
    var source = entry && typeof entry === 'object' ? entry : {};
    var key = typeof source.commentKey === 'string' && source.commentKey
      ? source.commentKey
      : fallbackKey;
    if (!key) return null;
    var scope = source.scope === 'reply' ? 'reply' : 'thread';
    var rootKey = source.rootCommentKey == null ? null : String(source.rootCommentKey);
    if (scope === 'thread' && !rootKey) rootKey = key;
    return {
      commentKey: key,
      mid: midOf(source.mid),
      rulesVersion: source.rulesVersion == null ? '' : String(source.rulesVersion),
      action: source.action === 'hide' ? 'hide' : String(source.action || 'hide'),
      clues: cleanClues(source.clues),
      scope: scope,
      rootCommentKey: rootKey,
      at: typeof source.at === 'number' && isFinite(source.at) ? source.at : 0,
    };
  }

  function cleanRecordMap(raw, allowed) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      if (allowed.indexOf(key) === -1) continue;
      var record = cleanRecord(raw[key], key);
      if (record && record.commentKey === key) out[key] = record;
    }
    return out;
  }

  function cleanMeta(raw) {
    var out = { comments: {}, accounts: {} };
    var source = raw && typeof raw === 'object' ? raw : {};
    var comments = source.comments && typeof source.comments === 'object' ? source.comments : {};
    var accounts = source.accounts && typeof source.accounts === 'object' ? source.accounts : {};
    var key;
    for (key in comments) {
      if (!Object.prototype.hasOwnProperty.call(comments, key)) continue;
      var comment = comments[key] || {};
      out.comments[key] = {
        aid: comment.aid == null ? '' : String(comment.aid),
        at: typeof comment.at === 'number' && isFinite(comment.at) ? comment.at : 0,
      };
    }
    for (key in accounts) {
      if (!Object.prototype.hasOwnProperty.call(accounts, key)) continue;
      var account = accounts[key] || {};
      out.accounts[key] = {
        at: typeof account.at === 'number' && isFinite(account.at) ? account.at : 0,
      };
    }
    return out;
  }

  function normalize(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var allowed = strings(source.accountAllowed);
    var blocked = strings(source.accountBlocked).filter(function (mid) {
      return allowed.indexOf(mid) === -1;
    });
    var kept = strings(source.keptException);
    var manual = strings(source.manualHidden).filter(function (key) {
      return kept.indexOf(key) === -1;
    });
    return {
      version: VERSION,
      accountBlocked: blocked,
      accountAllowed: allowed,
      manualHidden: manual,
      keptException: kept,
      records: cleanRecordMap(source.records, manual),
      meta: cleanMeta(source.meta),
    };
  }

  function create(initial) {
    return normalize(initial);
  }

  function clone(state) {
    return normalize(state);
  }

  function push(list, value) {
    var out = list.slice();
    if (out.indexOf(value) === -1) out.push(value);
    return out;
  }

  function without(list, value) {
    return list.filter(function (item) { return item !== value; });
  }

  function atOf(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function hide(state, entry) {
    var current = normalize(state);
    var record = cleanRecord(entry, entry && entry.commentKey);
    if (!record) return current;
    var key = record.commentKey;
    var next = normalize(current);
    next.manualHidden = push(without(current.manualHidden, key), key);
    next.keptException = without(current.keptException, key);
    next.records[key] = record;
    next.meta.comments[key] = {
      aid: entry && entry.aid != null ? String(entry.aid)
        : (current.meta.comments[key] && current.meta.comments[key].aid) || '',
      at: record.at,
    };
    return next;
  }

  function restore(state, entry) {
    var current = normalize(state);
    var source = typeof entry === 'string' ? { commentKey: entry } : (entry || {});
    var key = typeof source.commentKey === 'string' ? source.commentKey : '';
    if (!key) return current;
    var next = normalize(current);
    next.manualHidden = without(current.manualHidden, key);
    next.keptException = push(current.keptException, key);
    delete next.records[key];
    var previous = current.meta.comments[key] || { aid: '' };
    next.meta.comments[key] = {
      aid: source.aid != null ? String(source.aid) : previous.aid,
      at: atOf(source.at, previous.at || 0),
    };
    return next;
  }

  function blockAccount(state, entry) {
    var current = normalize(state);
    var source = typeof entry === 'object' && entry !== null ? entry : { mid: entry };
    var mid = midOf(source.mid);
    if (!mid) return current;
    var next = normalize(current);
    next.accountBlocked = push(without(current.accountBlocked, mid), mid);
    next.accountAllowed = without(current.accountAllowed, mid);
    next.meta.accounts[mid] = { at: atOf(source.at, 0) };
    return next;
  }

  function unblockAccount(state, entry) {
    var current = normalize(state);
    var mid = midOf(typeof entry === 'object' && entry !== null ? entry.mid : entry);
    if (!mid) return current;
    var next = normalize(current);
    next.accountBlocked = without(current.accountBlocked, mid);
    return next;
  }

  function allowAccount(state, entry) {
    var current = normalize(state);
    var source = typeof entry === 'object' && entry !== null ? entry : { mid: entry };
    var mid = midOf(source.mid);
    if (!mid) return current;
    var next = normalize(current);
    next.accountAllowed = push(without(current.accountAllowed, mid), mid);
    next.accountBlocked = without(current.accountBlocked, mid);
    next.meta.accounts[mid] = { at: atOf(source.at, 0) };
    return next;
  }

  function removeAllowedAccount(state, entry) {
    var current = normalize(state);
    var mid = midOf(typeof entry === 'object' && entry !== null ? entry.mid : entry);
    if (!mid) return current;
    var next = normalize(current);
    next.accountAllowed = without(current.accountAllowed, mid);
    return next;
  }

  function has(list, value) {
    return Array.isArray(list) && value !== undefined && value !== null && list.indexOf(value) !== -1;
  }

  // 判定优先级：外层整串 > 单条保留例外 > 手动隐藏 > 账号屏蔽 > 保留账号 > 规则。
  // 规则命中只返回 reason='rule'，绝不写回四类集合。
  function decide(state, observation, verdict, options) {
    var current = normalize(state);
    var obs = observation || {};
    var opts = options || {};
    var key = typeof obs.commentKey === 'string' ? obs.commentKey : '';
    var mid = midOf(obs.mid);

    if (opts.parentHidden === true) return { hide: true, reason: 'parent' };
    if (has(current.keptException, key)) return { hide: false, reason: 'kept' };
    if (has(current.manualHidden, key)) return { hide: true, reason: 'manual' };
    if (has(current.accountBlocked, mid)) return { hide: true, reason: 'account' };
    if (has(current.accountAllowed, mid)) return { hide: false, reason: 'allowed' };
    if (verdict && verdict.action === 'hide') return { hide: true, reason: 'rule' };
    if (verdict && verdict.action === 'suspect') return { hide: false, reason: 'suspect' };
    return { hide: false, reason: 'none' };
  }

  function listRecords(state) {
    var current = normalize(state);
    return current.manualHidden.map(function (key) { return current.records[key]; }).filter(Boolean);
  }

  NS.purgeState = {
    VERSION: VERSION,
    create: create,
    normalize: normalize,
    clone: clone,
    hide: hide,
    restore: restore,
    blockAccount: blockAccount,
    unblockAccount: unblockAccount,
    allowAccount: allowAccount,
    removeAllowedAccount: removeAllowedAccount,
    decide: decide,
    listRecords: listRecords,
    has: has,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
