// 清除强度的持久化：三档，默认激进。
//
// 档位决定判定用哪套规则、以及规则判「疑似」的评论要不要一并清掉；档位本身
// 只是一个字符串，非法值一律落回默认档位。存储优先 chrome.storage.local，
// 其次 localStorage；两者都不可用或读写失败时安静退化，绝不让内容脚本崩掉。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var KEY = 'dshcc.purge.strength';
  var VERSION = 'v1';

  // 顺序即弹层里的展示顺序：从最保守到最强。
  var LEVELS = ['conservative', 'standard', 'aggressive'];
  var DEFAULT = 'aggressive';

  function normalize(value) {
    return LEVELS.indexOf(value) === -1 ? DEFAULT : value;
  }

  function safeGet(adapter) {
    try {
      var value = adapter && typeof adapter.get === 'function' ? adapter.get(KEY) : undefined;
      return Promise.resolve(value).then(normalize, function () {
        return DEFAULT;
      });
    } catch (error) {
      return Promise.resolve(DEFAULT);
    }
  }

  function safeSet(adapter, level) {
    try {
      var value = adapter && typeof adapter.set === 'function' ? adapter.set(KEY, normalize(level)) : false;
      return Promise.resolve(value).then(function () {
        return true;
      }, function () {
        return false;
      });
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  function createStore(adapter) {
    var current = adapter || null;

    return {
      load: function () {
        return safeGet(current);
      },
      save: function (level) {
        return safeSet(current, level);
      },
      subscribe: function (listener) {
        if (!current || typeof current.subscribe !== 'function' || typeof listener !== 'function') {
          return function () {};
        }
        var off;
        try {
          off = current.subscribe(function (key, value) {
            if (key === KEY) listener(normalize(value));
          });
        } catch (error) {
          return function () {};
        }
        return typeof off === 'function' ? off : function () {};
      },
    };
  }

  // 浏览器适配层：chrome.storage.local（MV3），退化到 localStorage，再退化到内存。
  function chromeAdapter(storage) {
    return {
      get: function (key) {
        var got = storage.get(key);
        if (got && typeof got.then === 'function') {
          return got.then(function (items) {
            return items ? items[key] : undefined;
          });
        }
        return new Promise(function (resolve) {
          storage.get(key, function (items) {
            resolve(items ? items[key] : undefined);
          });
        });
      },
      set: function (key, value) {
        var payload = {};
        payload[key] = value;
        var done = storage.set(payload);
        if (done && typeof done.then === 'function') return done;
        return new Promise(function (resolve) {
          storage.set(payload, function () {
            resolve();
          });
        });
      },
      subscribe: function (listener) {
        var area = root.chrome && root.chrome.storage && root.chrome.storage.onChanged;
        if (!area || typeof area.addListener !== 'function') return function () {};
        var handler = function (changes, areaName) {
          if (areaName !== 'local' || !changes || !changes[KEY]) return;
          listener(KEY, changes[KEY].newValue);
        };
        area.addListener(handler);
        return function () {
          if (typeof area.removeListener === 'function') area.removeListener(handler);
        };
      },
    };
  }

  function localAdapter(storage) {
    return {
      get: function (key) {
        var raw = storage.getItem(key);
        if (raw === null || raw === undefined) return undefined;
        try {
          return JSON.parse(raw);
        } catch (error) {
          return undefined;
        }
      },
      set: function (key, value) {
        storage.setItem(key, JSON.stringify(value));
      },
      subscribe: function () {
        return function () {};
      },
    };
  }

  function memoryAdapter() {
    var data = Object.create(null);
    return {
      get: function (key) {
        return data[key];
      },
      set: function (key, value) {
        data[key] = value;
      },
      subscribe: function () {
        return function () {};
      },
    };
  }

  function detectAdapter() {
    try {
      if (root.chrome && root.chrome.storage && root.chrome.storage.local) {
        return chromeAdapter(root.chrome.storage.local);
      }
    } catch (error) {
      // 继续尝试下一种存储。
    }
    try {
      if (root.localStorage) return localAdapter(root.localStorage);
    } catch (error) {
      // localStorage 在部分隐私模式下会直接抛错。
    }
    return memoryAdapter();
  }

  NS.purgeStrength = {
    VERSION: VERSION,
    KEY: KEY,
    DEFAULT: DEFAULT,
    LEVELS: LEVELS,
    normalize: normalize,
    createStore: createStore,
    detectAdapter: detectAdapter,
    defaultStore: createStore(detectAdapter()),
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
