// 自动清除开关的持久化。
//
// 默认关闭：只有明确存过布尔 true 才算开启。存储优先 chrome.storage.local，
// 其次 localStorage；两者都不可用或读写失败时安静退化，绝不让内容脚本崩掉。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var KEY = 'dshcc.purge.enabled';
  var VERSION = 'v1';

  function normalize(value) {
    return value === true;
  }

  function safeGet(adapter) {
    try {
      var value = adapter && typeof adapter.get === 'function' ? adapter.get(KEY) : undefined;
      return Promise.resolve(value).then(normalize, function () {
        return false;
      });
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  function safeSet(adapter, enabled) {
    try {
      var value = adapter && typeof adapter.set === 'function' ? adapter.set(KEY, normalize(enabled)) : false;
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
      save: function (enabled) {
        return safeSet(current, enabled);
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

  NS.purgeSettings = {
    VERSION: VERSION,
    KEY: KEY,
    normalize: normalize,
    createStore: createStore,
    detectAdapter: detectAdapter,
    defaultStore: createStore(detectAdapter()),
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
