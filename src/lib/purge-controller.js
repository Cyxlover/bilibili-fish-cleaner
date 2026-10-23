// 自动清除控制器：把「页面节点 + 判定结果 + 开关 + 持久状态」落成真实 DOM 操作。
//
// 判定优先级由 purge-state.decide 统一给出：
//   parent > kept > manual > account > allowed > rule
// 规则隐藏只在开关打开时生效，且只存在于当前页面会话；手动隐藏与账号屏蔽
// 独立于开关、跨刷新保留。所有 DOM 操作都按 commentKey 找当前节点，重渲染后
// 的新节点会在下一次 scan 被重新判定；任何单条失败都只跳过该项。
//
// 清除强度（conservative / standard / aggressive）只改两件事：判定用哪套规则
// （保守档用 v1，其余用默认规则集），以及规则判「疑似」的评论是否一并清除。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var VERSION = 'v3';

  // 与 purge-strength.js 的 LEVELS/DEFAULT 一致；控制器自己也要能独立工作。
  var STRENGTHS = ['conservative', 'standard', 'aggressive'];
  var DEFAULT_STRENGTH = 'aggressive';
  var CONSERVATIVE_RULES_VERSION = 'v1';

  function normalizeEnabled(value) {
    return value === true;
  }

  function normalizeStrength(value) {
    return STRENGTHS.indexOf(value) === -1 ? DEFAULT_STRENGTH : value;
  }

  function emptyResult(message) {
    return {
      status: 'internal-error',
      state: 'waiting',
      message: message || '评论区结构异常，已跳过本次自动清除',
      aid: null,
      bvid: null,
      observations: [],
      entries: [],
      threads: 0,
      replies: 0,
      total: 0,
      skipped: 0,
      selectorVersion: '',
    };
  }

  function noopRecords() {
    return {
      add: function () {},
      clear: function () {},
      list: function () { return []; },
      count: function () { return 0; },
    };
  }

  function memoryStateStore() {
    return {
      load: function () { return Promise.resolve(null); },
      save: function () { return Promise.resolve(false); },
    };
  }

  function attachBody(item, entry) {
    if (!entry || !entry.body) return null;
    return {
      commentKey: item.commentKey,
      mid: item.mid,
      rulesVersion: item.rulesVersion,
      action: item.action,
      clues: item.clues,
      scope: item.scope,
      rootCommentKey: item.rootCommentKey,
      tone: item.tone,
      body: entry.body,
    };
  }

  function create(options) {
    var opts = options || {};
    var doc = opts.doc || (typeof document === 'undefined' ? null : document);
    var settings = opts.settings || (NS.purgeSettings && NS.purgeSettings.defaultStore) || null;
    var records = opts.records || (NS.purgeRecords ? NS.purgeRecords.create() : noopRecords());
    var marker = opts.marker || (NS.purgeMarker ? NS.purgeMarker.create(doc) : null);
    var stateApi = opts.stateApi || NS.purgeState;
    if (!stateApi) throw new Error('缺少 purgeState');
    var stateStore = opts.stateStore || (NS.purgeStateStore
      ? NS.purgeStateStore.create()
      : memoryStateStore());
    var collect = opts.collect || function () {
      if (!NS.pageAdapter || typeof NS.pageAdapter.collectWithNodes !== 'function') {
        throw new Error('页面适配层不可用');
      }
      return NS.pageAdapter.collectWithNodes(doc);
    };
    var judge = opts.judge || function (observation, pageContext, judgeOptions) {
      if (!NS.engine || typeof NS.engine.judge !== 'function') {
        throw new Error('判定引擎不可用');
      }
      return NS.engine.judge(observation, pageContext, judgeOptions);
    };

    var enabled = normalizeEnabled(opts.initialEnabled);
    var strength = normalizeStrength(opts.strength);
    // 调用方显式给了档位就以它为准，不再让存档覆盖。
    var strengthGiven = opts.strength !== undefined && opts.strength !== null;
    var strengthStore = opts.strengthStore || (NS.purgeStrength && NS.purgeStrength.defaultStore) || null;
    var ready = opts.ready !== false;
    var userSet = false;
    var disposed = false;
    var hidden = new Map();
    var lastResult = null;
    var lastEntries = Object.create(null);
    var lastObservations = Object.create(null);
    var state = stateApi.create(opts.state);

    function safeCollect() {
      try {
        return collect() || emptyResult();
      } catch (error) {
        return emptyResult();
      }
    }

    function persist() {
      var aid = lastResult && lastResult.aid;
      try {
        var done = stateStore && typeof stateStore.save === 'function'
          ? stateStore.save(state, aid)
          : false;
        return Promise.resolve(done).then(function () { return true; }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    function setState(next) {
      state = stateApi.normalize(next);
      return state;
    }

    // 切视频时丢掉旧视频的持久化记录。先由调用方清空内存规则记录，
    // 再调这里：顺序反了会把新视频刚写下的记录一起删掉。
    function dropVideo(aid) {
      var target = typeof aid === 'string' ? aid : String(aid == null ? '' : aid);
      if (!target) return Promise.resolve(false);
      var clear = stateStore && typeof stateStore.clearVideo === 'function'
        ? stateStore.clearVideo
        : (NS.purgeStateStore && typeof NS.purgeStateStore.clearVideo === 'function'
          ? NS.purgeStateStore.clearVideo
          : null);
      if (!clear) return Promise.resolve(false);
      state = stateApi.normalize(clear(state, target));
      return persist();
    }

    function insertHidden(entry) {
      var node = entry && entry.node;
      var parent = entry && entry.parent;
      if (!node || !parent || node.parentNode !== null) return false;
      try {
        if (entry.nextSibling && entry.nextSibling.parentNode === parent) {
          parent.insertBefore(node, entry.nextSibling);
        } else {
          parent.appendChild(node);
        }
        return true;
      } catch (error) {
        return false;
      }
    }

    function pruneHidden() {
      Array.from(hidden.keys()).forEach(function (key) {
        var entry = hidden.get(key);
        if (!entry) return;
        // 节点被站点重新插回，说明页面已经换了一轮；删除旧记录，交给本次扫描。
        if (entry.node.parentNode !== null) hidden.delete(key);
      });
    }

    function restoreReason(reason) {
      var entries = Array.from(hidden.keys()).map(function (key) {
        return { key: key, entry: hidden.get(key) };
      }).filter(function (item) {
        return item.entry && (!reason || item.entry.reason === reason);
      }).reverse();
      var restored = 0;
      for (var i = 0; i < entries.length; i += 1) {
        hidden.delete(entries[i].key);
        if (insertHidden(entries[i].entry)) restored += 1;
      }
      if (!reason || reason === 'rule') records.clear();
      return restored;
    }

    function restoreAll() {
      return restoreReason(null);
    }

    function restoreOne(key) {
      var entry = hidden.get(key);
      if (!entry) return false;
      hidden.delete(key);
      return insertHidden(entry);
    }

    function restoreByAccount(mid, reason) {
      var target = String(mid);
      var entries = Array.from(hidden.keys()).map(function (key) {
        return { key: key, entry: hidden.get(key) };
      }).filter(function (item) {
        return item.entry && item.entry.reason === reason && String(item.entry.mid) === target;
      }).reverse();
      var restored = 0;
      for (var i = 0; i < entries.length; i += 1) {
        hidden.delete(entries[i].key);
        if (insertHidden(entries[i].entry)) restored += 1;
      }
      return restored;
    }

    function decisionsFor(result) {
      var decisions = [];
      var observations = Array.isArray(result.observations) ? result.observations : [];
      var entries = Array.isArray(result.entries) ? result.entries : [];
      var byKey = Object.create(null);
      // 保守档只认本条自身证据，用 v1；标准与激进都走默认规则集。
      var judgeOptions = strength === 'conservative'
        ? { rulesVersion: CONSERVATIVE_RULES_VERSION }
        : undefined;

      lastEntries = Object.create(null);
      lastObservations = Object.create(null);
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        if (!entry || !entry.observation || !entry.observation.commentKey) continue;
        byKey[entry.observation.commentKey] = entry;
        lastEntries[entry.observation.commentKey] = entry;
      }
      for (var n = 0; n < observations.length; n += 1) {
        if (observations[n] && observations[n].commentKey) {
          lastObservations[observations[n].commentKey] = observations[n];
        }
      }

      for (var j = 0; j < observations.length; j += 1) {
        var observation = observations[j];
        if (!observation || !observation.commentKey) continue;
        var node = byKey[observation.commentKey];
        if (!node || !node.node || !node.body) continue; // 观察存在但节点缺失：跳过
        var pageContext = { sameAccountOnPage: [] };
        for (var k = 0; k < observations.length; k += 1) {
          var other = observations[k];
          if (!other || other.commentKey === observation.commentKey) continue;
          if (String(other.mid) !== String(observation.mid)) continue;
          pageContext.sameAccountOnPage.push({ text: other.text, isReply: other.isReply === true });
        }
        try {
          decisions.push({
            observation: observation,
            verdict: asStrengthVerdict(judge(observation, pageContext, judgeOptions)),
            entry: node,
          });
        } catch (error) {
          // 单条判定失败只跳过这一条。
        }
      }
      return decisions;
    }

    function scopeOf(observation) {
      return observation.isReply === true ? 'reply' : 'thread';
    }

    function rootOf(observation) {
      return observation.rootCommentKey || observation.commentKey;
    }

    // 强度只改一件事：激进档把「疑似」当成「隐藏」处理，其余档位原样返回。
    // 关闭开关时不改写，关闭态必须看得到原文、只留标记。
    function asStrengthVerdict(verdict) {
      if (!verdict || typeof verdict !== 'object' || !enabled) return verdict;
      if (strength !== 'aggressive' || verdict.action !== 'suspect') return verdict;
      var next = {};
      for (var field in verdict) {
        if (Object.prototype.hasOwnProperty.call(verdict, field)) next[field] = verdict[field];
      }
      next.action = 'hide';
      return next;
    }

    function markTone(decision, stateDecision) {
      if (stateDecision.reason === 'suspect') return 'suspect';
      if (stateDecision.reason !== 'rule') return null;
      var action = decision.verdict && decision.verdict.action;
      if (action === 'hide' && !enabled) return 'hidden';
      if (action === 'suspect') return 'suspect';
      return null;
    }

    function evaluate(decisions) {
      var hides = [];
      var marks = [];
      var seen = Object.create(null);
      var threadHidden = Object.create(null);

      // 已经被手动隐藏的一级评论，即使本页节点缺失，也不能让它的回复单独复活。
      var manual = Array.isArray(state.manualHidden) ? state.manualHidden : [];
      for (var m = 0; m < manual.length; m += 1) threadHidden[manual[m]] = true;

      function inspect(decision, replyPass) {
        var observation = decision.observation;
        var key = observation.commentKey;
        if (seen[key]) return;
        seen[key] = true;
        if (replyPass && threadHidden[rootOf(observation)]) return;
        var stateDecision;
        try {
          stateDecision = stateApi.decide(state, observation, decision.verdict, { parentHidden: false });
        } catch (error) {
          return;
        }
        var ruleOnly = stateDecision.reason === 'rule';
        var shouldHide = stateDecision.hide && (!ruleOnly || enabled);
        if (shouldHide) {
          if (!replyPass) threadHidden[key] = true;
          hides.push({ decision: decision, reason: stateDecision.reason });
          return;
        }
        var tone = markTone(decision, stateDecision);
        if (!tone) return;
        marks.push({
          commentKey: key,
          mid: observation.mid,
          rulesVersion: decision.verdict.rulesVersion,
          action: decision.verdict.action,
          clues: decision.verdict.clues,
          scope: scopeOf(observation),
          rootCommentKey: rootOf(observation),
          tone: tone,
        });
      }

      // 一级评论先判，楼中楼后判；整串被隐藏时，其下回复不再单独处理。
      for (var i = 0; i < decisions.length; i += 1) {
        if (decisions[i].observation.isReply !== true) inspect(decisions[i], false);
      }
      for (var j = 0; j < decisions.length; j += 1) {
        if (decisions[j].observation.isReply === true) inspect(decisions[j], true);
      }
      return { hides: hides, marks: marks };
    }

    function removeHides(items) {
      for (var i = 0; i < items.length; i += 1) {
        var decision = items[i].decision;
        var entry = decision.entry;
        if (!entry || !entry.node || !entry.node.parentNode) continue;
        var node = entry.node;
        var parent = node.parentNode;
        var nextSibling = node.nextSibling || null;
        try {
          parent.removeChild(node);
        } catch (error) {
          continue;
        }
        var observation = decision.observation;
        var key = observation.commentKey;
        if (hidden.has(key)) hidden.delete(key);
        hidden.set(key, {
          node: node,
          parent: parent,
          nextSibling: nextSibling,
          reason: items[i].reason,
          mid: observation.mid,
          rootCommentKey: rootOf(observation),
        });
        if (items[i].reason === 'rule') {
          records.add({
            commentKey: key,
            mid: observation.mid,
            aid: observation.aid || '',
            rulesVersion: decision.verdict.rulesVersion,
            action: 'hide',
            clues: decision.verdict.clues,
            scope: scopeOf(observation),
            rootCommentKey: rootOf(observation),
          });
        }
      }
    }

    function view() {
      return {
        enabled: enabled,
        strength: strength,
        hidden: hidden.size,
        marked: marker && typeof marker.count === 'function' ? marker.count() : 0,
        records: records.count ? records.count() : 0,
        manual: Array.isArray(state.manualHidden) ? state.manualHidden.length : 0,
        kept: Array.isArray(state.keptException) ? state.keptException.length : 0,
        blocked: Array.isArray(state.accountBlocked) ? state.accountBlocked.length : 0,
        allowed: Array.isArray(state.accountAllowed) ? state.accountAllowed.length : 0,
      };
    }

    function applyResult(result) {
      if (!enabled) {
        // 关闭态只还原规则隐藏；手动隐藏与账号屏蔽的节点继续留在 hidden 里。
        if (restoreReason('rule') > 0) result = safeCollect();
      } else {
        pruneHidden();
      }

      var entries = Array.isArray(result.entries) ? result.entries : [];
      if (result.status !== 'ok' || entries.length === 0) {
        if (!enabled && marker) marker.apply([]);
        result.purge = view();
        return result;
      }

      var decisions = decisionsFor(result);
      var built = evaluate(decisions);
      var marks = [];
      for (var i = 0; i < built.marks.length; i += 1) {
        var withBody = attachBody(built.marks[i], lastEntries[built.marks[i].commentKey]);
        if (withBody) marks.push(withBody);
      }
      if (marker) marker.apply(marks);
      removeHides(built.hides);

      result.purge = view();
      return result;
    }

    function scan() {
      if (!ready) {
        var pending = safeCollect();
        pending.purge = view();
        return pending;
      }
      lastResult = applyResult(safeCollect());
      return lastResult;
    }

    function saveSettings(value) {
      try {
        var done = settings && typeof settings.save === 'function' ? settings.save(value) : false;
        return Promise.resolve(done).then(function () { return enabled; }, function () { return enabled; });
      } catch (error) {
        return Promise.resolve(enabled);
      }
    }

    function setEnabled(value) {
      var next = normalizeEnabled(value);
      userSet = true;
      ready = true;
      if (next === enabled) {
        scan();
        return saveSettings(next);
      }
      enabled = next;
      if (!enabled) {
        restoreReason('rule');
        if (marker) marker.apply([]);
      }
      scan();
      return saveSettings(next);
    }

    function toggle() {
      return setEnabled(!enabled);
    }

    function saveStrength() {
      try {
        if (!strengthStore || typeof strengthStore.save !== 'function') return Promise.resolve(strength);
        return Promise.resolve(strengthStore.save(strength)).then(function () {
          return strength;
        }, function () {
          return strength;
        });
      } catch (error) {
        return Promise.resolve(strength);
      }
    }

    // 换档就是换判定口径，所以先把规则隐藏的评论原样还回页面，再重扫一遍；
    // 手动隐藏与账号屏蔽不受影响（它们的理由不是 'rule'）。
    function setStrength(value) {
      var next = normalizeStrength(value);
      userSet = true;
      ready = true;
      if (next === strength) {
        scan();
        return saveStrength();
      }
      strength = next;
      restoreReason('rule');
      if (marker) marker.apply([]);
      scan();
      return saveStrength();
    }

    function getStrength() {
      return strength;
    }

    function resolveObservation(input) {
      if (!input) return null;
      if (typeof input === 'string') return lastObservations[input] || null;
      if (input.observation) return input.observation;
      return input;
    }

    function hideComment(input) {
      var observation = resolveObservation(input);
      if (!observation || !observation.commentKey) return Promise.resolve(false);
      var key = observation.commentKey;
      setState(stateApi.hide(state, {
        commentKey: key,
        mid: observation.mid,
        aid: observation.aid,
        rulesVersion: 'manual',
        action: 'hide',
        clues: [],
        scope: scopeOf(observation),
        rootCommentKey: rootOf(observation),
        at: Date.now(),
      }));
      var saving = persist();
      scan();
      return saving.then(function () { return true; });
    }

    function restoreComment(input) {
      var observation = resolveObservation(input);
      var key = typeof input === 'string'
        ? input
        : (observation && observation.commentKey);
      if (!key) return Promise.resolve(false);
      setState(stateApi.restore(state, {
        commentKey: key,
        aid: observation && observation.aid,
        at: Date.now(),
      }));
      restoreOne(key);
      var saving = persist();
      scan();
      return saving.then(function () { return true; });
    }

    function blockAccount(mid) {
      if (mid === null || mid === undefined || mid === '') return Promise.resolve(false);
      setState(stateApi.blockAccount(state, { mid: mid, at: Date.now() }));
      var saving = persist();
      scan();
      return saving.then(function () { return true; });
    }

    function unblockAccount(mid) {
      if (mid === null || mid === undefined || mid === '') return Promise.resolve(false);
      setState(stateApi.unblockAccount(state, { mid: mid }));
      restoreByAccount(mid, 'account');
      var saving = persist();
      scan();
      return saving.then(function () { return true; });
    }

    function allowAccount(mid) {
      if (mid === null || mid === undefined || mid === '') return Promise.resolve(false);
      setState(stateApi.allowAccount(state, { mid: mid, at: Date.now() }));
      // 之前被规则隐藏的该账号节点先放回，再让 allowed 决定不再隐藏。
      restoreByAccount(mid, 'rule');
      var saving = persist();
      scan();
      return saving.then(function () { return true; });
    }

    function removeAllowedAccount(mid) {
      if (mid === null || mid === undefined || mid === '') return Promise.resolve(false);
      setState(stateApi.removeAllowedAccount(state, { mid: mid }));
      var saving = persist();
      scan();
      return saving.then(function () { return true; });
    }

    function start() {
      if (disposed) return Promise.resolve(enabled);
      var settingsLoading;
      try {
        settingsLoading = settings && typeof settings.load === 'function'
          ? settings.load()
          : false;
      } catch (error) {
        settingsLoading = false;
      }
      var stateLoading;
      try {
        stateLoading = stateStore && typeof stateStore.load === 'function'
          ? stateStore.load()
          : null;
      } catch (error) {
        stateLoading = null;
      }
      var strengthLoading;
      try {
        strengthLoading = strengthStore && typeof strengthStore.load === 'function'
          ? strengthStore.load()
          : null;
      } catch (error) {
        strengthLoading = null;
      }
      return Promise.all([
        Promise.resolve(settingsLoading).catch(function () { return false; }),
        Promise.resolve(stateLoading).catch(function () { return null; }),
        Promise.resolve(strengthLoading).catch(function () { return null; }),
      ]).then(function (values) {
        if (!userSet) enabled = normalizeEnabled(values[0]);
        setState(values[1] || stateApi.create());
        // 存档的档位只在调用方没显式指定、且用户本次没主动改过时生效。
        if (!userSet && !strengthGiven) strength = normalizeStrength(values[2]);
        ready = true;
        if (settings && typeof settings.subscribe === 'function') {
          unsubscribe = settings.subscribe(function (value) {
            setEnabled(value);
          });
        }
        scan();
        return enabled;
      });
    }

    var unsubscribe = null;

    function destroy() {
      disposed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      restoreAll();
      if (marker) marker.clear();
      records.clear();
    }

    return {
      start: start,
      scan: scan,
      setEnabled: setEnabled,
      toggle: toggle,
      getEnabled: function () { return enabled; },
      setStrength: setStrength,
      getStrength: getStrength,
      getView: view,
      getState: function () { return stateApi.normalize(state); },
      hideComment: hideComment,
      restoreComment: restoreComment,
      blockAccount: blockAccount,
      unblockAccount: unblockAccount,
      allowAccount: allowAccount,
      removeAllowedAccount: removeAllowedAccount,
      dropVideo: dropVideo,
      last: function () { return lastResult; },
      destroy: destroy,
    };
  }

  NS.purgeController = {
    VERSION: VERSION,
    create: create,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
