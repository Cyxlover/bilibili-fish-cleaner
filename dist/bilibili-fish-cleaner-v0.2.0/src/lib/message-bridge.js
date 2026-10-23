// 内容脚本 ↔ 侧边栏的消息桥：纯逻辑 + 可注入的 transport。
//
// 三个运行面之间只有两种方向：
//   - 侧边栏 → 内容脚本：tabs.sendMessage 请求当前标签的快照（REQUEST）；
//   - 内容脚本 → 侧边栏：runtime.sendMessage 推送状态变化（UPDATE），
//     以及对 REQUEST 的同步应答（SNAPSHOT）。
// 同一份代码两侧复用：内容脚本用 getSnapshot 应答与推送，侧边栏用 onPush
// 接收推送、用 requestSnapshot 主动索取。
//
// 这里不直接引用 chrome：真实 chrome 由 chromeTransport() 适配成四个方法，
// 测试可以注入假 transport，因此规则与消息形状都能离线断言。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};
  var VERSION = 'v1';

  var CHANNELS = {
    // 侧边栏 → 内容脚本：给我这个标签当前的快照
    REQUEST: 'dshcc:getSnapshot',
    // 内容脚本 → 侧边栏：对 REQUEST 的应答
    SNAPSHOT: 'dshcc:snapshot',
    // 内容脚本 → 侧边栏：页面上的隐藏/恢复发生了变化
    UPDATE: 'dshcc:update',
    // 侧边栏 → 内容脚本：在页面上执行一次恢复/解除屏蔽
    COMMAND: 'dshcc:command',
    // 内容脚本 → Service Worker：这个作者还缺简介，替我取一份
    // （内容脚本自己不发网络请求，规格要求这件事由 Service Worker 承担）
    PROFILE: 'dshcc:profile',
  };

  var STAT_NUMBERS = [
    'records', 'hidden', 'marked', 'manual', 'kept',
    'blocked', 'allowed', 'threads', 'replies', 'skipped',
  ];

  function toNumber(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  function toList(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  function normalizeStats(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    for (var i = 0; i < STAT_NUMBERS.length; i += 1) {
      var key = STAT_NUMBERS[i];
      out[key] = toNumber(source[key]);
    }
    out.enabled = source.enabled === true;
    out.status = typeof source.status === 'string' ? source.status : '';
    return out;
  }

  // 快照的形状对两侧都是契约：字段永远存在，缺失时给空值。
  function normalizeSnapshot(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    return {
      videoId: source.videoId === null || source.videoId === undefined ? '' : String(source.videoId),
      aid: source.aid === null || source.aid === undefined ? '' : String(source.aid),
      records: toList(source.records),
      state: source.state && typeof source.state === 'object' ? source.state : null,
      stats: normalizeStats(source.stats),
    };
  }

  function snapshotOf(envelope) {
    if (!envelope || typeof envelope !== 'object') return null;
    if (!envelope.snapshot || typeof envelope.snapshot !== 'object') return null;
    return normalizeSnapshot(envelope.snapshot);
  }

  function snapshotFromReply(reply) {
    if (!reply || typeof reply !== 'object') return null;
    if (reply.channel !== CHANNELS.SNAPSHOT) return null;
    return snapshotOf(reply);
  }

  // 简介读取的结果只有三种形态，两侧都按这三种解读：
  //   {status:'ok', value}  读到了简介
  //   {status:'failed'}     读取失败（网络 / 风控 / 超时）
  //   null                  这次没有可取的东西（不需要读，或排队里已被读过）
  // 引擎对 failed 与 null 的处理完全一致：不添线索、也不减线索。
  function normalizeProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.status === 'ok' && typeof raw.value === 'string') {
      return { status: 'ok', value: raw.value };
    }
    if (raw.status === 'failed') return { status: 'failed' };
    return null;
  }

  function profileFromReply(reply) {
    if (!reply || typeof reply !== 'object') return null;
    if (reply.channel !== CHANNELS.PROFILE) return null;
    return normalizeProfile(reply.profile);
  }

  // 请求里只带判定需要的字段：不带 commentKey / aid，一条简介用不到页面结构。
  function profileRequestOf(observation) {
    var source = observation && typeof observation === 'object' ? observation : {};
    var mid = source.authorMid === null || source.authorMid === undefined
      ? source.mid : source.authorMid;
    return {
      authorMid: mid === null || mid === undefined ? '' : String(mid),
      nickname: typeof source.nickname === 'string' ? source.nickname : '',
      text: typeof source.text === 'string' ? source.text : '',
      isReply: source.isReply === true,
    };
  }

  // 推送去重：只有面板看得见的内容变了才值得发一条消息。
  function signature(raw) {
    var snapshot = normalizeSnapshot(raw);
    var state = snapshot.state || {};
    return JSON.stringify({
      videoId: snapshot.videoId,
      aid: snapshot.aid,
      records: snapshot.records.map(function (record) {
        return String((record && record.commentKey) || '');
      }),
      manualHidden: toList(state.manualHidden),
      keptException: toList(state.keptException),
      accountBlocked: toList(state.accountBlocked),
      accountAllowed: toList(state.accountAllowed),
      stats: snapshot.stats,
    });
  }

  // 真实 chrome 的适配层：runtime.onMessage / runtime.sendMessage / tabs.*。
  // 所有回调风格 API 都包成 Promise，且「没有接收方」一律解析为 null。
  function chromeTransport(chromeApi) {
    var api = chromeApi || null;
    var runtime = api && api.runtime ? api.runtime : null;
    var tabs = api && api.tabs ? api.tabs : null;

    function readError() {
      try {
        return runtime && runtime.lastError ? runtime.lastError : null;
      } catch (error) {
        return null;
      }
    }

    function onMessage(handler) {
      if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== 'function') {
        return function () {};
      }
      function listener(message, sender, sendResponse) {
        var reply;
        try {
          reply = handler(message, sender);
        } catch (error) {
          return false;
        }
        if (reply !== undefined && reply !== null && typeof sendResponse === 'function') {
          try {
            sendResponse(reply);
          } catch (error) {
            // 接收方已经断开：忽略。
          }
        }
        return false;
      }
      runtime.onMessage.addListener(listener);
      return function () {
        if (runtime.onMessage && typeof runtime.onMessage.removeListener === 'function') {
          runtime.onMessage.removeListener(listener);
        }
      };
    }

    function send(message) {
      return new Promise(function (resolve) {
        if (!runtime || typeof runtime.sendMessage !== 'function') {
          resolve(null);
          return;
        }
        try {
          runtime.sendMessage(message, function (response) {
            readError();
            resolve(response === undefined ? null : response);
          });
        } catch (error) {
          resolve(null);
        }
      });
    }

    function sendToTab(tabId, message) {
      return new Promise(function (resolve) {
        if (!tabs || typeof tabs.sendMessage !== 'function' ||
            tabId === null || tabId === undefined) {
          resolve(null);
          return;
        }
        try {
          tabs.sendMessage(tabId, message, function (response) {
            readError();
            resolve(response === undefined ? null : response);
          });
        } catch (error) {
          resolve(null);
        }
      });
    }

    function activeTab() {
      return new Promise(function (resolve) {
        if (!tabs || typeof tabs.query !== 'function') {
          resolve(null);
          return;
        }
        try {
          tabs.query({ active: true, currentWindow: true }, function (list) {
            if (readError()) {
              resolve(null);
              return;
            }
            resolve(Array.isArray(list) && list.length ? list[0] : null);
          });
        } catch (error) {
          resolve(null);
        }
      });
    }

    return {
      onMessage: onMessage,
      send: send,
      sendToTab: sendToTab,
      activeTab: activeTab,
    };
  }

  function create(options) {
    var opts = options || {};
    var transport = opts.transport || null;
    var getSnapshot = typeof opts.getSnapshot === 'function' ? opts.getSnapshot : null;
    var onPush = typeof opts.onPush === 'function' ? opts.onPush : null;
    var onCommand = typeof opts.onCommand === 'function' ? opts.onCommand : null;
    var detach = null;

    function snapshot() {
      if (!getSnapshot) return normalizeSnapshot(null);
      try {
        return normalizeSnapshot(getSnapshot());
      } catch (error) {
        return normalizeSnapshot(null);
      }
    }

    // 单一入口：收到任何消息都先过这里，返回值就是应答（undefined = 不回应）。
    function dispatch(message, sender) {
      var channel = message && typeof message === 'object' ? message.channel : '';
      if (channel === CHANNELS.REQUEST) {
        return { channel: CHANNELS.SNAPSHOT, snapshot: snapshot() };
      }
      if (channel === CHANNELS.UPDATE) {
        var pushed = snapshotOf(message);
        if (pushed && onPush) {
          try {
            onPush(pushed, sender);
          } catch (error) {
            // 面板渲染失败不能反过来打断内容脚本。
          }
        }
        return null;
      }
      if (channel === CHANNELS.COMMAND) {
        var command = message && message.command && typeof message.command === 'object'
          ? message.command : null;
        if (!command || !onCommand) return { ok: false, reason: 'unsupported' };
        try {
          onCommand(command, sender);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: 'error' };
        }
      }
      return undefined;
    }

    function listen() {
      if (detach) return detach;
      if (!transport || typeof transport.onMessage !== 'function') {
        detach = function () {};
        return detach;
      }
      var stop = transport.onMessage(dispatch);
      detach = typeof stop === 'function' ? stop : function () {};
      return detach;
    }

    function resolveTabId(tabId) {
      if (tabId !== null && tabId !== undefined) return Promise.resolve(tabId);
      if (!transport || typeof transport.activeTab !== 'function') return Promise.resolve(null);
      return Promise.resolve(transport.activeTab()).then(function (tab) {
        return tab && tab.id !== null && tab.id !== undefined ? tab.id : null;
      }, function () {
        return null;
      });
    }

    function requestSnapshot(tabId) {
      if (!transport || typeof transport.sendToTab !== 'function') return Promise.resolve(null);
      return resolveTabId(tabId).then(function (id) {
        if (id === null || id === undefined) return null;
        return Promise.resolve(transport.sendToTab(id, { channel: CHANNELS.REQUEST }))
          .then(snapshotFromReply, function () { return null; });
      });
    }

    function push() {
      if (!transport || typeof transport.send !== 'function') return Promise.resolve(false);
      var envelope = { channel: CHANNELS.UPDATE, snapshot: snapshot() };
      return Promise.resolve(transport.send(envelope)).then(function () {
        return true;
      }, function () {
        return false;
      });
    }

    // 面板上的「恢复 / 取消屏蔽」要在页面上真正生效，光改存储不够。
    function sendCommand(command, tabId) {
      if (!transport || typeof transport.sendToTab !== 'function') return Promise.resolve(null);
      return resolveTabId(tabId).then(function (id) {
        if (id === null || id === undefined) return null;
        var envelope = { channel: CHANNELS.COMMAND, command: command };
        return Promise.resolve(transport.sendToTab(id, envelope)).then(function (reply) {
          return reply && reply.ok === true ? reply : null;
        }, function () {
          return null;
        });
      });
    }

    function dispose() {
      if (detach) detach();
      detach = null;
    }

    // 内容脚本唯一的上网途径：把「缺简介」这件事交给 Service Worker。
    // 失败、超时、没有接收方一律解析为 null——调用方据此当作「没有资料」继续判定。
    function requestProfile(observation) {
      if (!transport || typeof transport.send !== 'function') return Promise.resolve(null);
      var envelope = { channel: CHANNELS.PROFILE, observation: profileRequestOf(observation) };
      return Promise.resolve(transport.send(envelope)).then(profileFromReply, function () {
        return null;
      });
    }

    return {
      CHANNELS: CHANNELS,
      listen: listen,
      dispatch: dispatch,
      snapshot: snapshot,
      requestSnapshot: requestSnapshot,
      sendCommand: sendCommand,
      requestProfile: requestProfile,
      push: push,
      dispose: dispose,
    };
  }

  NS.messageBridge = {
    VERSION: VERSION,
    CHANNELS: CHANNELS,
    create: create,
    chromeTransport: chromeTransport,
    normalizeSnapshot: normalizeSnapshot,
    normalizeProfile: normalizeProfile,
    profileRequestOf: profileRequestOf,
    signature: signature,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
