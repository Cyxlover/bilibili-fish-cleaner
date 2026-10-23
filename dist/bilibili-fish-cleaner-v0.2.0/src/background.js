// Service Worker：两件事。
//   1) 点工具栏图标直接展开 Edge 原生侧边面板（不需要弹窗或跳转页面）。
//   2) 代表扩展去读「按需资料」——内容脚本自己不发网络请求，跨域读取只能在这里做
//      （spec.md:110 要求 Service Worker 承担这件事）。
//
// 取资料的纪律都在引擎里（engine/profile-need.js 决定要不要读，engine/profile-reader.js
// 负责单次请求、超时、串行排队与失败降级），这里只做三件它做不了的事：
// 真发请求、接 chrome.storage.local、以及把结果回给内容脚本。
//
// 边界：
//   - 只有 GET，只有一个域名（manifest.host_permissions 里那一个）；
//   - 只读名片里的 sign 一个字段，缓存只落 {sign, at}；
//   - credentials: 'omit'，不把请求绑到用户登录态上；
//   - 失败一律安静降级为 {status:'failed'}，绝不重试。

(function (global) {
  'use strict';

  var BEHAVIOR = { openPanelOnActionClick: true };

  // 与 src/lib/message-bridge.js 的 CHANNELS.PROFILE 同值。
  // 这里不 import 桥：Service Worker 只需要认这一个频道名。
  var PROFILE_CHANNEL = 'dshcc:profile';
  var PROFILE_CACHE_KEY = 'dshcc.profile.cache.v1';
  var BUNDLE = '/src/lib/engine-bundle.js';

  var profileListening = false;
  var reader = null;

  function readLastError() {
    try {
      return chrome && chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError : null;
    } catch (error) {
      return null;
    }
  }

  // 引擎包是普通脚本（不是 ES module），Service Worker 用 importScripts 拿它。
  // 拿不到就返回 null：判定与取资料一起降级，面板照常工作。
  function engine() {
    if (global.DSHCC && global.DSHCC.engine) return global.DSHCC.engine;
    if (typeof global.importScripts !== 'function') return null;
    try {
      global.importScripts(BUNDLE);
    } catch (error) {
      return null;
    }
    return global.DSHCC && global.DSHCC.engine ? global.DSHCC.engine : null;
  }

  function storageArea() {
    var area = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
    if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') return null;
    return area;
  }

  // 缓存的存储适配：整块 JSON 存取，TTL 与条数上限由引擎自己管。
  function cacheStore() {
    var area = storageArea();
    if (!area) return null;
    return {
      load: function () {
        return new Promise(function (resolve) {
          try {
            area.get(PROFILE_CACHE_KEY, function (data) {
              // lastError 必须在回调里读掉，否则控制台会报「未检查的运行时错误」。
              readLastError();
              resolve(data ? data[PROFILE_CACHE_KEY] : null);
            });
          } catch (error) {
            resolve(null);
          }
        });
      },
      save: function (entries) {
        return new Promise(function (resolve) {
          try {
            var patch = {};
            patch[PROFILE_CACHE_KEY] = entries && typeof entries === 'object' ? entries : {};
            area.set(patch, function () {
              readLastError();
              resolve(true);
            });
          } catch (error) {
            resolve(false);
          }
        });
      },
    };
  }

  // 站点公开资料接口：只读，不带 cookie。引擎会补 URL 与 mid 查询串。
  function request(url, init) {
    var options = init && typeof init === 'object' ? init : {};
    return global.fetch(url, {
      method: 'GET',
      credentials: 'omit',
      signal: options.signal,
      headers: { accept: 'application/json' },
    });
  }

  function profileReader() {
    if (reader) return reader;
    var api = engine();
    if (!api || typeof api.createProfileReader !== 'function') return null;
    if (typeof global.fetch !== 'function') return null;
    var store = cacheStore();
    var cache = store && typeof api.createProfileCache === 'function'
      ? api.createProfileCache(store)
      : null;
    reader = api.createProfileReader({ request: request, cache: cache });
    return reader;
  }

  function answer(sendResponse, profile) {
    if (typeof sendResponse !== 'function') return;
    try {
      sendResponse({
        channel: PROFILE_CHANNEL,
        profile: profile && typeof profile === 'object' ? profile : null,
      });
    } catch (error) {
      // 内容脚本那边已经关掉了消息通道：忽略。
    }
  }

  // 内容脚本问一次，这里替它读一次；读不到就回 null，绝不重试、绝不抛。
  function onProfileRequest(message, sender, sendResponse) {
    var current = profileReader();
    var observation = message && typeof message.observation === 'object' ? message.observation : null;
    if (!current || !observation) {
      answer(sendResponse, null);
      return false;
    }
    Promise.resolve()
      .then(function () {
        return current.read(observation);
      })
      .then(function (profile) {
        answer(sendResponse, profile);
      }, function () {
        answer(sendResponse, { status: 'failed' });
      });
    // 应答是异步的：保持消息通道打开，否则 sendResponse 会静默失败。
    return true;
  }

  function onMessage(message, sender, sendResponse) {
    var channel = message && typeof message === 'object' ? message.channel : '';
    if (channel !== PROFILE_CHANNEL) return false;
    return onProfileRequest(message, sender, sendResponse);
  }

  // 点击图标 = 开面板。老版本浏览器没有 sidePanel：安静降级。
  function registerPanel() {
    if (typeof chrome === 'undefined' || !chrome.sidePanel
      || typeof chrome.sidePanel.setPanelBehavior !== 'function') {
      return;
    }
    try {
      var done = chrome.sidePanel.setPanelBehavior(BEHAVIOR);
      if (done && typeof done.catch === 'function') done.catch(function () {});
    } catch (error) {
      // 同上：不影响内容脚本。
    }
  }

  function registerProfile() {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    var hook = chrome.runtime.onMessage;
    if (!hook || typeof hook.addListener !== 'function') return;
    // 重复注册会让同一条请求被应答两次，所以只挂一次。
    if (profileListening) return;
    hook.addListener(onMessage);
    profileListening = true;
  }

  function start() {
    registerPanel();
    registerProfile();
  }

  // 没有扩展 API 时（Node 测试、面板页）整个文件都不做事。
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(start);
    chrome.runtime.onStartup.addListener(start);
    // 服务脚本每次启动都会重跑一遍，这里补一次注册（事件监听之外的那次）。
    start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
