// 内容脚本：把页面适配层、判定引擎与自动清除控制器串起来。
//
// 默认只观测并显示计数；用户打开徽标上的开关后，规则判为 hide 的评论会被
// 移除（一级整串、楼中楼单条），suspect 只打标记。关闭开关会立刻还原本页
// 由规则移除的节点，绝不改动手动隐藏或账号名单。
//
// 四类变化（初始加载 / 滚动新增 / 展开楼中楼 / 站内切换视频）统一收敛成
// 「重新扫描一次」：
//   - MutationObserver 不跨 shadow 边界，所以对 bili-comments 以下的每个 shadow root
//     各挂一个观察点，回调里只做去抖 + 重扫；
//   - 站内切换视频可能整页导航、也可能 SPA 复用宿主，两种都防：#commentapp 的 identity
//     变化、href 变化、aid 变化都会触发重扫。

(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});
  if (!ns.contentGate || !ns.pageAdapter || !ns.badge ||
      !ns.engine || !ns.purgeSettings || !ns.purgeMarker ||
      !ns.purgeRecords || !ns.purgeState || !ns.purgeStateStore ||
      !ns.purgeController || !ns.manualActions || !ns.messageBridge) {
    return;
  }

  var doc = global.document;
  if (!doc || !doc.documentElement) {
    return;
  }

  // 站点范围：非视频播放页不注入任何行为。
  if (!ns.contentGate.isVideoPage(global.location && global.location.pathname)) {
    return;
  }

  if (global.__dshccContentScriptLoaded) {
    return;
  }
  global.__dshccContentScriptLoaded = true;

  var PREFIX = '[大肥鱼清除计划]';
  var DEBOUNCE_MS = 150;
  var WATCHDOG_MS = 2000;
  var SHADOW_ROOT_CAP = 20000;

  var state = {
    aid: null,
    timerId: 0,
    printed: Object.create(null),
    lastSummary: '',
    lastStatus: null,
    shadowObservers: [],
    observedRoots: typeof WeakSet === 'function' ? new WeakSet() : null,
    appObserver: null,
    docObserver: null,
    observedApp: null,
    lastApp: null,
    lastHref: String((global.location && global.location.href) || ''),
    // 上一次推送给侧边栏的内容指纹：没变就不发消息。
    lastBridgeSig: '',
  };

  var records = ns.purgeRecords.create();
  var stateStore = ns.purgeStateStore.create();
  var strengthStore = ns.purgeStrength ? ns.purgeStrength.defaultStore : null;
  var controller = ns.purgeController.create({
    doc: doc,
    records: records,
    stateStore: stateStore,
    strengthStore: strengthStore,
    // 判定统一走 profileJudge：先把作者简介（若已按需读到）塞进观测，再交给引擎。
    judge: profileJudge,
    // 设置尚未读出前先只采集，避免把已开启的用户先闪一下标记。
    ready: false,
  });
  var badge = ns.badge.mount(doc, {
    onPurgeToggle: function () {
      controller.toggle();
      if (badge && controller.last()) badge.render(controller.last());
      scheduleScan();
    },
    onStrengthChange: function (level) {
      controller.setStrength(level);
      if (badge && controller.last()) badge.render(controller.last());
      scheduleScan();
    },
  });
  var manualActions = ns.manualActions.create(doc, { controller: controller });

  // 消息桥：侧边栏要「当前视频的隐藏记录」时同步应答，页面上的隐藏/恢复发生
  // 变化时主动推一条。侧边栏没打开时消息无人接收，静默失败即可。
  var bridge = ns.messageBridge.create({
    transport: ns.messageBridge.chromeTransport(global.chrome),
    getSnapshot: snapshot,
    onCommand: handlePanelCommand,
  });

  // 简介按需读取：内容脚本自己不发请求，缺口交给 Service Worker（bridge.requestProfile）。
  // 读到的简介只在本页内存里，回来后触发一次重扫，判定才用得上它。
  var profileClient = ns.profileClient ? ns.profileClient.create({
    engine: ns.engine,
    request: function (observation) {
      return bridge.requestProfile(observation);
    },
    onChange: function () {
      scheduleScan();
    },
  }) : null;

  // 判定入口：profileClient 在时由它插入简介；不在时退回引擎原样判定。
  function profileJudge(observation, pageContext) {
    if (profileClient) return profileClient.judge(observation, pageContext);
    if (!ns.engine || typeof ns.engine.judge !== 'function') {
      throw new Error('判定引擎不可用');
    }
    return ns.engine.judge(observation, pageContext);
  }

  function snapshot() {
    var last = controller.last() || {};
    var view = typeof controller.getView === 'function' ? controller.getView() : {};
    return {
      // videoId 供面板显示，aid 供面板按视频筛选手动记录（两者都可能有缺）。
      videoId: last.bvid || last.aid || '',
      aid: last.aid || '',
      records: records.list(),
      state: controller.getState(),
      stats: {
        records: records.count ? records.count() : 0,
        hidden: view.hidden || 0,
        marked: view.marked || 0,
        manual: view.manual || 0,
        kept: view.kept || 0,
        blocked: view.blocked || 0,
        allowed: view.allowed || 0,
        threads: last.threads || 0,
        replies: last.replies || 0,
        skipped: last.skipped || 0,
        status: last.status || '',
        enabled: view.enabled === true,
        strength: view.strength || '',
      },
    };
  }

  // 面板上的操作要在页面上真正生效：改内存状态 → 重扫 → 推送新快照。
  function handlePanelCommand(command) {
    if (!command || typeof command !== 'object') return;
    var action = command.action;
    if (action === 'restore' && command.commentKey) {
      controller.restoreComment(command.commentKey);
    } else if (action === 'unblock' && command.mid) {
      controller.unblockAccount(command.mid);
    } else if (action === 'unallow' && command.mid) {
      controller.removeAllowedAccount(command.mid);
    } else {
      return;
    }
    scheduleScan();
  }

  function publish() {
    if (!bridge) return;
    var current = snapshot();
    var sig = ns.messageBridge.signature(current);
    if (sig === state.lastBridgeSig) return;
    state.lastBridgeSig = sig;
    bridge.push();
  }

  function scheduleScan() {
    if (state.timerId) {
      return;
    }
    state.timerId = global.setTimeout(function () {
      state.timerId = 0;
      scan();
    }, DEBOUNCE_MS);
  }

  // 每个 shadow root 各挂一个观察点；不跨边界，所以必须逐个补挂。
  function observeShadowRoot(root) {
    if (!root || typeof global.MutationObserver !== 'function') {
      return;
    }
    if (state.observedRoots) {
      if (state.observedRoots.has(root)) {
        return;
      }
      state.observedRoots.add(root);
    }
    var observer = new global.MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });
    state.shadowObservers.push({ observer: observer, root: root });
  }

  // 被重建的评论节点会留下已脱离文档的观察点，及时断开，避免长期累积。
  function pruneShadowObservers() {
    for (var i = state.shadowObservers.length - 1; i >= 0; i -= 1) {
      var entry = state.shadowObservers[i];
      var hostEl = entry.root ? entry.root.host : null;
      if (hostEl && hostEl.isConnected !== false) {
        continue;
      }
      entry.observer.disconnect();
      state.shadowObservers.splice(i, 1);
      if (state.observedRoots) {
        state.observedRoots.delete(entry.root);
      }
    }
  }

  function observeStructure() {
    var app = ns.pageAdapter.findCommentApp(doc);
    if (app && app !== state.observedApp) {
      if (state.appObserver) {
        state.appObserver.disconnect();
      }
      state.observedApp = app;
      state.appObserver = new global.MutationObserver(scheduleScan);
      state.appObserver.observe(app, { childList: true, subtree: true });
    }

    if (!state.docObserver && typeof global.MutationObserver === 'function') {
      // 只关心「#commentapp 是不是换了一个节点」，避免为整页噪声买单。
      state.docObserver = new global.MutationObserver(function () {
        var current = ns.pageAdapter.findCommentApp(doc);
        if (current !== state.lastApp) {
          state.lastApp = current;
          state.observedApp = null;
          scheduleScan();
        }
      });
      state.docObserver.observe(doc.documentElement, { childList: true, subtree: true });
    }
    state.lastApp = app;
  }

  function printObservations(result) {
    var i;
    for (i = 0; i < result.observations.length; i += 1) {
      var obs = result.observations[i];
      if (state.printed[obs.commentKey]) {
        continue;
      }
      state.printed[obs.commentKey] = true;
      // 逐条打印，便于人工核对：类型、昵称、mid、正文，附带完整观测对象。
      console.info(
        PREFIX + ' 观测｜' + (obs.isReply ? '楼中楼' : '一级评论') +
        '｜' + (obs.nickname || '(无昵称)') + '（mid ' + obs.mid + '）｜' + obs.text,
        obs,
      );
    }
  }

  function reportStatus(result) {
    if (result.status === state.lastStatus) {
      return;
    }
    state.lastStatus = result.status;
    if (result.state === 'disabled') {
      console.warn(PREFIX + ' ' + result.message);
      return;
    }
    if (result.state === 'waiting') {
      console.info(PREFIX + ' ' + result.message);
    }
  }

  function scan() {
    var result;
    // 每次扫描重新发放「取几个作者资料」的名额：滚动一次不会变成抓取风暴。
    if (profileClient) profileClient.beginScan();
    try {
      result = controller.scan();
    } catch (error) {
      // 控制器承诺不抛异常；万一抛了也不能阻断页面。
      console.warn(PREFIX + ' 自动清除异常，已跳过本次扫描', error);
      return;
    }

    // 站内切换视频：aid 一变，先丢掉上一支视频的规则记录，再清掉它的持久化残留。
    // 顺序不能反：dropVideo 会清 state 里该 aid 的记录，若先清空内存再切 aid 才对得上。
    if (result.aid && result.aid !== state.aid) {
      var previousAid = state.aid;
      records.clear();
      if (previousAid && typeof controller.dropVideo === 'function') {
        Promise.resolve(controller.dropVideo(previousAid)).catch(function () {});
      }
      state.aid = result.aid;
      state.printed = Object.create(null);
    }

    if (badge) {
      badge.render(result);
    }

    // 手动入口跟随可见条目重挂；被规则或手动移除的评论不会留下按钮。
    manualActions.apply(result.entries || []);

    observeStructure();
    reportStatus(result);
    printObservations(result);

    var summary = [
      result.status,
      result.aid || '-',
      result.threads,
      result.replies,
      result.skipped,
    ].join('|');
    if (summary !== state.lastSummary) {
      state.lastSummary = summary;
      console.info(
        PREFIX + ' 当前计数：一级评论 ' + result.threads + ' / 楼中楼 ' + result.replies +
        '（aid ' + (result.aid || '未知') + '，跳过 ' + result.skipped + ' 个异常节点）',
      );
    }

    var host = ns.pageAdapter.findCommentsHost(doc);
    if (host) {
      var roots = ns.pageAdapter.collectShadowRoots(host, SHADOW_ROOT_CAP);
      for (var i = 0; i < roots.length; i += 1) {
        observeShadowRoot(roots[i]);
      }
    }
    pruneShadowObservers();
    publish();
  }

  function watchdog() {
    var href = String((global.location && global.location.href) || '');
    var app = ns.pageAdapter.findCommentApp(doc);
    if (href !== state.lastHref || app !== state.lastApp || !state.shadowObservers.length) {
      state.lastHref = href;
      state.lastApp = app;
      scheduleScan();
    }
  }

  // 先挂监听再跑首次扫描：侧边栏在这之后打开也能立刻拿到快照。
  bridge.listen();

  global.addEventListener('popstate', scheduleScan, false);
  global.addEventListener('hashchange', scheduleScan, false);

  scan();
  try {
    controller.start().then(scheduleScan, scheduleScan);
  } catch (error) {
    scheduleScan();
  }
  global.setInterval(watchdog, WATCHDOG_MS);
})(typeof globalThis !== 'undefined' ? globalThis : this);
