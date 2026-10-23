// 手动状态的本机持久化：chrome.storage.local → localStorage → 内存。
//
// 存的是 purge-state 的纯数据；写入前按条数上限与视频归属做清理，避免长期
// 使用无限增长。任何存储异常都安静降级为内存状态，绝不让内容脚本崩掉。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var KEY = 'dshcc.state.v1';
  var VERSION = 'v1';
  var LIMITS = {
    commentLimit: 1000,
    perVideoLimit: 300,
    accountLimit: 500,
  };

  function memoryAdapter() {
    var data = {};
    return {
      get: function (key) { return data[key]; },
      set: function (key, value) { data[key] = value; },
    };
  }

  function detectAdapter() {
    if (NS.purgeSettings && typeof NS.purgeSettings.detectAdapter === 'function') {
      return NS.purgeSettings.detectAdapter();
    }
    return memoryAdapter();
  }

  function mergeLimits(limits) {
    var source = limits || {};
    return {
      commentLimit: Number.isFinite(source.commentLimit) && source.commentLimit > 0
        ? Math.floor(source.commentLimit) : LIMITS.commentLimit,
      perVideoLimit: Number.isFinite(source.perVideoLimit) && source.perVideoLimit > 0
        ? Math.floor(source.perVideoLimit) : LIMITS.perVideoLimit,
      accountLimit: Number.isFinite(source.accountLimit) && source.accountLimit > 0
        ? Math.floor(source.accountLimit) : LIMITS.accountLimit,
    };
  }

  function commentKeys(state) {
    var all = state.manualHidden.concat(state.keptException);
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      if (out.indexOf(all[i]) === -1) out.push(all[i]);
    }
    return out;
  }

  function atOfComment(state, key) {
    var meta = state.meta.comments[key];
    return meta && typeof meta.at === 'number' ? meta.at : 0;
  }

  function atOfAccount(state, mid) {
    var meta = state.meta.accounts[mid];
    return meta && typeof meta.at === 'number' ? meta.at : 0;
  }

  function oldest(keys, atFor) {
    return keys.slice().sort(function (a, b) {
      var delta = atFor(a) - atFor(b);
      return delta !== 0 ? delta : 0;
    });
  }

  function removeComment(state, key) {
    state.manualHidden = state.manualHidden.filter(function (item) { return item !== key; });
    state.keptException = state.keptException.filter(function (item) { return item !== key; });
    delete state.records[key];
    delete state.meta.comments[key];
  }

  function removeAccount(state, mid) {
    state.accountBlocked = state.accountBlocked.filter(function (item) { return item !== mid; });
    state.accountAllowed = state.accountAllowed.filter(function (item) { return item !== mid; });
    delete state.meta.accounts[mid];
  }

  function prune(raw, options) {
    var state = NS.purgeState.normalize(raw);
    var opts = options || {};
    var limits = mergeLimits(opts.limits);
    var aid = opts.aid == null ? '' : String(opts.aid);

    // 先按视频限制清理：只清当前视频，其他视频不受影响。
    if (aid) {
      var inVideo = commentKeys(state).filter(function (key) {
        var meta = state.meta.comments[key];
        return meta && meta.aid === aid;
      });
      if (inVideo.length > limits.perVideoLimit) {
        var dropVideo = oldest(inVideo, function (key) { return atOfComment(state, key); })
          .slice(0, inVideo.length - limits.perVideoLimit);
        for (var i = 0; i < dropVideo.length; i += 1) removeComment(state, dropVideo[i]);
      }
    }

    // 再按全局上限淘汰最旧评论键（手动隐藏与保留例外共用名额）。
    var allComments = commentKeys(state);
    if (allComments.length > limits.commentLimit) {
      var dropComments = oldest(allComments, function (key) { return atOfComment(state, key); })
        .slice(0, allComments.length - limits.commentLimit);
      for (var j = 0; j < dropComments.length; j += 1) removeComment(state, dropComments[j]);
    }

    // 账号维度不按视频归属，只受全局账号上限约束。
    var accounts = state.accountBlocked.concat(state.accountAllowed).filter(function (mid, index, list) {
      return list.indexOf(mid) === index;
    });
    if (accounts.length > limits.accountLimit) {
      var dropAccounts = oldest(accounts, function (mid) { return atOfAccount(state, mid); })
        .slice(0, accounts.length - limits.accountLimit);
      for (var k = 0; k < dropAccounts.length; k += 1) removeAccount(state, dropAccounts[k]);
    }

    return NS.purgeState.normalize(state);
  }

  function clearVideo(raw, aid) {
    var state = NS.purgeState.normalize(raw);
    var target = aid == null ? '' : String(aid);
    if (!target) return state;
    var keys = commentKeys(state).filter(function (key) {
      var meta = state.meta.comments[key];
      return meta && meta.aid === target;
    });
    for (var i = 0; i < keys.length; i += 1) removeComment(state, keys[i]);
    return NS.purgeState.normalize(state);
  }

  function create(options) {
    var opts = options || {};
    var adapter = opts.adapter || detectAdapter();
    var limits = mergeLimits(opts.limits);

    function load() {
      try {
        var got = adapter && typeof adapter.get === 'function' ? adapter.get(KEY) : undefined;
        return Promise.resolve(got).then(function (raw) {
          if (raw === null || raw === undefined || raw === '') return NS.purgeState.create();
          if (typeof raw === 'string') raw = JSON.parse(raw);
          return prune(raw, { limits: limits });
        }, function () {
          return NS.purgeState.create();
        });
      } catch (error) {
        return Promise.resolve(NS.purgeState.create());
      }
    }

    function save(state, aid) {
      var next = prune(state, { aid: aid, limits: limits });
      try {
        var done = adapter && typeof adapter.set === 'function' ? adapter.set(KEY, next) : false;
        return Promise.resolve(done).then(function () { return true; }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    function reset() {
      try {
        var done = adapter && typeof adapter.set === 'function' ? adapter.set(KEY, null) : false;
        return Promise.resolve(done).then(function () { return true; }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    return {
      load: load,
      save: save,
      reset: reset,
      limits: limits,
    };
  }

  NS.purgeStateStore = {
    VERSION: VERSION,
    KEY: KEY,
    LIMITS: LIMITS,
    create: create,
    prune: prune,
    clearVideo: clearVideo,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
