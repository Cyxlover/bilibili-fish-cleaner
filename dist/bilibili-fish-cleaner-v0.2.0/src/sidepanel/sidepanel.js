// 侧边栏页面：把本地状态摊成 panel 的两个视图。
//
// 侧边栏是独立扩展页面，拿不到页面里的 DOM 节点，所以这里只做「名单与记录
// 的查看与撤销」：状态读写走 purge-state-store，动作走 purge-state 的纯函数。
//
// 当前视频的规则隐藏记录只有内容脚本知道，所以打开面板时经消息桥向当前标签
// 索取一份快照（状态 + 规则记录 + 计数），页面上的隐藏/恢复变化再由内容脚本
// 推送过来。非 B 站标签没有内容脚本时，快照为 null，面板退回本地持久化状态
// 并显示空态，不报错。

(function (global) {
  'use strict';

  var ns = global.DSHCC = global.DSHCC || {};
  var stateApi = ns.purgeState;
  var store = ns.purgeStateStore ? ns.purgeStateStore.create() : null;
  var panelApi = ns.panel;
  var bridgeApi = ns.messageBridge;
  // 页面上唯一暴露给外部的入口（测试与 mount 共用同一个对象）。
  var sidepanelApi = ns.sidepanel = ns.sidepanel || {};

  function mount() {
    var host = document.getElementById('dshcc-root');
    if (!host || !panelApi || !stateApi) {
      if (host) host.textContent = '面板加载失败，请重新加载扩展。';
      return null;
    }

    var state = stateApi.create();
    var ruleRecords = [];
    var aid = '';
    var instance = null;
    var bridge = null;

    function save() {
      if (!store || typeof store.save !== 'function') return Promise.resolve(false);
      try {
        return Promise.resolve(store.save(state, null)).then(function () { return true; }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    // 页面推来的快照是「当前视频」的权威视图：状态、规则记录与视频 aid 一起替换。
    function apply(snapshot) {
      if (!snapshot) return false;
      if (snapshot.state) {
        state = stateApi.create(snapshot.state);
        stateApi.normalize(state);
      }
      ruleRecords = Array.isArray(snapshot.records) ? snapshot.records.slice() : [];
      aid = typeof snapshot.aid === 'string' ? snapshot.aid : '';
      if (instance) {
        instance.setContext({ aid: aid });
        instance.render();
      }
      return true;
    }

    function refresh() {
      if (!bridge || typeof bridge.requestSnapshot !== 'function') return Promise.resolve(null);
      return bridge.requestSnapshot().then(function (snapshot) {
        apply(snapshot);
        return snapshot;
      }, function () {
        return null;
      });
    }

    // 面板上的恢复/解除屏蔽同时通知内容脚本：光改存储页面不会变。
    function command(payload) {
      if (!bridge || typeof bridge.sendCommand !== 'function') return Promise.resolve(null);
      return bridge.sendCommand(payload).then(function (reply) {
        if (reply) return refresh();
        return null;
      }, function () {
        return null;
      });
    }

    function act(fn) {
      return Promise.resolve(save()).then(function (saved) {
        fn();
        return saved;
      });
    }

    var controller = {
      getState: function () { return state; },
      last: function () { return { entries: [] }; },
      restoreComment: function (key) {
        state = stateApi.restore(state, { commentKey: key, at: Date.now() });
        return act(function () { command({ action: 'restore', commentKey: key }); });
      },
      unblockAccount: function (mid) {
        state = stateApi.unblockAccount(state, { mid: mid });
        return act(function () { command({ action: 'unblock', mid: mid }); });
      },
      removeAllowedAccount: function (mid) {
        state = stateApi.removeAllowedAccount(state, { mid: mid });
        return act(function () { command({ action: 'unallow', mid: mid }); });
      },
    };

    instance = panelApi.create({
      controller: controller,
      aid: aid,
      // 规则记录不在本地持久化里：由内容脚本的快照填充。
      records: {
        list: function () { return ruleRecords.slice(); },
        clear: function () { return false; },
      },
    });
    instance.open();

    if (bridgeApi && typeof bridgeApi.create === 'function') {
      bridge = bridgeApi.create({
        transport: bridgeApi.chromeTransport(global.chrome),
        onPush: apply,
      });
      if (typeof bridge.listen === 'function') bridge.listen();
    }

    var loaded = store && typeof store.load === 'function'
      ? Promise.resolve(store.load()).then(function (stored) {
        state = stateApi.create(stored || {});
      }, function () {})
      : Promise.resolve();

    loaded.then(function () {
      instance.render();
      return refresh();
    }, function () {});

    sidepanelApi.instance = instance;
    sidepanelApi.refresh = refresh;
    return instance;
  }

  // 先把 mount 挂到命名空间，再决定何时调用：mount 内部会读 sidepanelApi。
  sidepanelApi.mount = mount;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
