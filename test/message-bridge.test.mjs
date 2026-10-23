// 内容脚本 ↔ 侧边栏的消息桥：请求快照、应答、状态变化推送、无接收方降级。
//
// 桥本身不碰真实 chrome：transport 可注入，测试用假 chrome 复刻三条通道
// （runtime.onMessage / runtime.sendMessage / tabs.sendMessage + tabs.query），
// 并保持 MV3 的真实行为——没有接收方时回调拿到 undefined 且 lastError 被置位。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/purge-state.js', 'src/ui/panel.js', 'src/lib/message-bridge.js');
const { purgeState, panel, messageBridge } = globalThis.DSHCC;
const { CHANNELS } = messageBridge;

const NOW = new Date(2026, 9, 23, 22, 0, 0).getTime();

function deliver(listeners, message, sender) {
  let response;
  let responded = false;
  const sendResponse = (value) => {
    responded = true;
    response = value;
  };
  for (const listener of listeners.slice()) listener(message, sender, sendResponse);
  return responded ? response : undefined;
}

function fakeChrome(options) {
  const setup = options || {};
  const listeners = [];
  const sentToExtension = [];
  const sentToTabs = [];
  const queries = [];

  const api = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
        removeListener(fn) {
          const index = listeners.indexOf(fn);
          if (index !== -1) listeners.splice(index, 1);
        },
      },
      sendMessage(message, callback) {
        sentToExtension.push(message);
        const receivers = setup.receivers || [];
        const response = receivers.length ? deliver(receivers, message, {}) : undefined;
        if (callback) callback(response);
      },
    },
    tabs: {
      query(queryInfo, callback) {
        queries.push(queryInfo);
        if (callback) callback(setup.tabs || []);
      },
      sendMessage(tabId, message, callback) {
        sentToTabs.push({ tabId, message });
        if (!setup.tabHandler) {
          api.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          try {
            if (callback) callback(undefined);
          } finally {
            api.runtime.lastError = null;
          }
          return;
        }
        const response = setup.tabHandler(tabId, message);
        api.runtime.lastError = null;
        if (callback) callback(response);
      },
    },
  };

  return {
    api,
    listeners,
    sentToExtension,
    sentToTabs,
    queries,
    // 模拟「本上下文收到了别的运行面发来的消息」。
    deliver(message, sender) {
      return deliver(listeners, message, sender || {});
    },
  };
}

function ruleRecord(overrides) {
  return Object.assign({
    commentKey: 'r1',
    mid: '1001',
    rulesVersion: 'v2b-longform@2026.10.23',
    action: 'hide',
    clues: [{ clueId: 'nickFish', source: 'account', strength: 'strong', fragment: '大肥鱼', label: '昵称含鱼' }],
    scope: 'thread',
    rootCommentKey: 'r1',
    at: NOW - 5 * 60 * 1000,
  }, overrides);
}

function contentSnapshot() {
  return {
    videoId: 'BV1xx411c7mD',
    aid: '998877',
    records: [
      ruleRecord(),
      ruleRecord({ commentKey: 'reply1', mid: '1002', scope: 'reply', rootCommentKey: 'r1', at: NOW - 4 * 60 * 1000 }),
    ],
    state: purgeState.hide(purgeState.create(), {
      commentKey: 'm1',
      mid: '2002',
      scope: 'thread',
      at: NOW - 1000,
    }),
    stats: {
      records: 2,
      hidden: 3,
      marked: 1,
      manual: 1,
      kept: 0,
      blocked: 0,
      allowed: 0,
      threads: 5,
      replies: 9,
      skipped: 0,
      status: 'ok',
      enabled: true,
    },
  };
}

function contentBridgeFor(chromeApi, getSnapshot) {
  const bridge = messageBridge.create({
    transport: messageBridge.chromeTransport(chromeApi),
    getSnapshot: getSnapshot || contentSnapshot,
  });
  bridge.listen();
  return bridge;
}

describe('内容脚本：应答快照请求', () => {
  it('收到 dshcc:getSnapshot 时回传 videoId、规则记录、状态与统计', () => {
    const contentChrome = fakeChrome();
    contentBridgeFor(contentChrome.api);

    const reply = contentChrome.deliver({ channel: CHANNELS.REQUEST }, { tab: { id: 9 } });

    assert.equal(reply.channel, CHANNELS.SNAPSHOT);
    assert.equal(reply.snapshot.videoId, 'BV1xx411c7mD');
    assert.deepEqual(reply.snapshot.records.map((item) => item.commentKey), ['r1', 'reply1']);
    assert.deepEqual(reply.snapshot.state.manualHidden, ['m1']);
    assert.equal(reply.snapshot.stats.hidden, 3);
    assert.equal(reply.snapshot.stats.threads, 5);
    assert.equal(reply.snapshot.stats.enabled, true);
  });

  it('快照形状稳定：缺字段时给空值，不会返回 undefined', () => {
    const contentChrome = fakeChrome();
    contentBridgeFor(contentChrome.api, () => ({}));

    const reply = contentChrome.deliver({ channel: CHANNELS.REQUEST }, {});

    assert.equal(reply.snapshot.videoId, '');
    assert.deepEqual(reply.snapshot.records, []);
    assert.equal(reply.snapshot.state, null);
    assert.equal(reply.snapshot.stats.hidden, 0);
    assert.equal(reply.snapshot.stats.enabled, false);
  });

  it('取快照抛错时照样应答空快照，内容脚本不崩', () => {
    const contentChrome = fakeChrome();
    contentBridgeFor(contentChrome.api, () => {
      throw new Error('页面结构异常');
    });

    const reply = contentChrome.deliver({ channel: CHANNELS.REQUEST }, {});

    assert.equal(reply.channel, CHANNELS.SNAPSHOT);
    assert.deepEqual(reply.snapshot.records, []);
  });

  it('无关消息不回应，也不误触发推送', () => {
    const contentChrome = fakeChrome();
    contentBridgeFor(contentChrome.api);

    assert.equal(contentChrome.deliver({ channel: 'dshcc:somethingElse' }, {}), undefined);
    assert.equal(contentChrome.deliver(null, {}), undefined);
    assert.deepEqual(contentChrome.sentToExtension, []);
  });
});

describe('侧边栏：向当前标签请求快照并渲染', () => {
  it('经 tabs.sendMessage 拿到当前活动标签的快照，并渲染成「当前视频」记录', async () => {
    const contentChrome = fakeChrome();
    contentBridgeFor(contentChrome.api);

    const panelChrome = fakeChrome({
      tabs: [{ id: 7, url: 'https://www.bilibili.com/video/BV1xx411c7mD' }],
      tabHandler: (tabId, message) => contentChrome.deliver(message, { tab: { id: tabId } }),
    });
    const bridge = messageBridge.create({ transport: messageBridge.chromeTransport(panelChrome.api) });

    const snapshot = await bridge.requestSnapshot();

    assert.deepEqual(panelChrome.queries, [{ active: true, currentWindow: true }]);
    assert.deepEqual(panelChrome.sentToTabs, [{ tabId: 7, message: { channel: CHANNELS.REQUEST } }]);
    assert.equal(snapshot.videoId, 'BV1xx411c7mD');
    assert.equal(snapshot.records.length, 2);

    const view = panel.buildView({
      state: snapshot.state,
      ruleRecords: snapshot.records,
      view: 'records',
      now: NOW,
    });
    // 手动隐藏的 m1 + 规则隐藏的整串 r1（回复 reply1 被整串折叠）。
    assert.deepEqual(view.records.map((item) => item.commentKey), ['m1', 'r1']);
    assert.equal(view.records.find((item) => item.commentKey === 'm1').source, 'manual');
    assert.equal(view.records.find((item) => item.commentKey === 'r1').source, 'rule');
    assert.equal(view.counts.records, 2);
  });

  it('指定标签时不再查询当前活动标签', async () => {
    const panelChrome = fakeChrome({
      tabHandler: () => ({ channel: CHANNELS.SNAPSHOT, snapshot: contentSnapshot() }),
    });
    const bridge = messageBridge.create({ transport: messageBridge.chromeTransport(panelChrome.api) });

    const snapshot = await bridge.requestSnapshot(42);

    assert.deepEqual(panelChrome.queries, []);
    assert.deepEqual(panelChrome.sentToTabs, [{ tabId: 42, message: { channel: CHANNELS.REQUEST } }]);
    assert.equal(snapshot.videoId, 'BV1xx411c7mD');
  });
});

describe('内容脚本：状态变化推送到侧边栏', () => {
  it('隐藏/恢复后推送新快照，面板侧收到并更新模型', () => {
    const panelChrome = fakeChrome();
    const received = [];
    const panelBridge = messageBridge.create({
      transport: messageBridge.chromeTransport(panelChrome.api),
      onPush: (snapshot) => received.push(snapshot),
    });
    panelBridge.listen();

    const contentChrome = fakeChrome({ receivers: panelChrome.listeners });
    let current = contentSnapshot();
    contentBridgeFor(contentChrome.api, () => current);
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(contentChrome.api),
      getSnapshot: () => current,
    });
    bridge.listen();

    bridge.push();
    assert.equal(contentChrome.sentToExtension.length, 1);
    assert.equal(contentChrome.sentToExtension[0].channel, CHANNELS.UPDATE);
    assert.equal(contentChrome.sentToExtension[0].snapshot.records.length, 2);

    // 用户在页面上又隐藏了一条：状态与规则记录同时变化。
    current = Object.assign(contentSnapshot(), {
      records: contentSnapshot().records.concat([ruleRecord({ commentKey: 'r2', mid: '3003', at: NOW })]),
      state: purgeState.hide(purgeState.create(), {
        commentKey: 'm1',
        mid: '2002',
        scope: 'thread',
        at: NOW - 1000,
      }),
    });
    current.state = purgeState.hide(current.state, {
      commentKey: 'm2',
      mid: '4004',
      scope: 'thread',
      at: NOW,
    });

    bridge.push();

    assert.equal(received.length, 2);
    assert.equal(received[1].records.length, 3);
    assert.deepEqual(received[1].state.manualHidden, ['m1', 'm2']);
    assert.equal(received[1].stats.hidden, 3);
  });

  it('面板没开时推送照样发得出去，不抛错', async () => {
    const contentChrome = fakeChrome();
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(contentChrome.api),
      getSnapshot: contentSnapshot,
    });
    // 没有接收方时 runtime.sendMessage 的回调仍会被调用，只是 lastError 被置位。
    assert.equal(await bridge.push(), true);
    assert.equal(contentChrome.sentToExtension.length, 1);
  });

  it('没有 transport（旧单测环境）时所有方法安静降级', async () => {
    const bridge = messageBridge.create({ getSnapshot: contentSnapshot });
    assert.equal(bridge.listen(), bridge.listen()); // 重复监听是幂等的
    assert.equal(await bridge.push(), false);
    assert.equal(await bridge.requestSnapshot(), null);
  });

  it('signature 只在可见内容变化时改变，用来避免重复推送', () => {
    const base = messageBridge.signature(contentSnapshot());
    assert.equal(base, messageBridge.signature(contentSnapshot()));
    assert.notEqual(base, messageBridge.signature(
      Object.assign(contentSnapshot(), { records: contentSnapshot().records.slice(0, 1) }),
    ));
    const stateOnly = Object.assign(contentSnapshot(), {
      state: purgeState.hide(contentSnapshot().state, { commentKey: 'm9', mid: '9009', scope: 'thread', at: NOW }),
    });
    assert.notEqual(base, messageBridge.signature(stateOnly));
  });
});

describe('面板动作要在页面上真正生效', () => {
  it('内容脚本执行面板发来的恢复命令并回执 ok', () => {
    const contentChrome = fakeChrome();
    const seen = [];
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(contentChrome.api),
      getSnapshot: contentSnapshot,
      onCommand: (command) => seen.push(command),
    });
    bridge.listen();

    const reply = contentChrome.deliver(
      { channel: CHANNELS.COMMAND, command: { action: 'restore', commentKey: 'r1' } },
      { tab: { id: 7 } },
    );

    assert.deepEqual(seen, [{ action: 'restore', commentKey: 'r1' }]);
    assert.equal(reply.ok, true);
  });

  it('命令抛错时不把异常带回消息通道', () => {
    const contentChrome = fakeChrome();
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(contentChrome.api),
      onCommand: () => { throw new Error('页面没有这条评论'); },
    });
    bridge.listen();

    const reply = contentChrome.deliver(
      { channel: CHANNELS.COMMAND, command: { action: 'restore', commentKey: 'gone' } },
      {},
    );

    assert.equal(reply.ok, false);
  });

  it('没有内容脚本注册命令时回执 unsupported，不抛错', () => {
    const contentChrome = fakeChrome();
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(contentChrome.api),
      getSnapshot: contentSnapshot,
    });
    bridge.listen();

    const reply = contentChrome.deliver(
      { channel: CHANNELS.COMMAND, command: { action: 'unblock', mid: '1' } },
      {},
    );

    assert.equal(reply.ok, false);
    assert.equal(reply.reason, 'unsupported');
  });

  it('侧边栏把恢复动作发给当前活动标签', async () => {
    const panelChrome = fakeChrome({
      tabs: [{ id: 5 }],
      tabHandler: () => ({ ok: true }),
    });
    const bridge = messageBridge.create({ transport: messageBridge.chromeTransport(panelChrome.api) });

    const reply = await bridge.sendCommand({ action: 'restore', commentKey: 'r1' });

    assert.deepEqual(panelChrome.sentToTabs, [{
      tabId: 5,
      message: { channel: CHANNELS.COMMAND, command: { action: 'restore', commentKey: 'r1' } },
    }]);
    assert.equal(reply.ok, true);
  });

  it('页面上没有内容脚本时命令安静返回 null', async () => {
    const panelChrome = fakeChrome({ tabs: [{ id: 5 }] });
    const bridge = messageBridge.create({ transport: messageBridge.chromeTransport(panelChrome.api) });

    assert.equal(await bridge.sendCommand({ action: 'restore', commentKey: 'r1' }), null);
  });
});

describe('没有内容脚本时优雅降级', () => {
  it('非视频页标签没有接收方：请求返回 null，面板给空态', async () => {
    const panelChrome = fakeChrome({ tabs: [{ id: 3, url: 'https://example.com/' }] });
    const bridge = messageBridge.create({ transport: messageBridge.chromeTransport(panelChrome.api) });

    const snapshot = await bridge.requestSnapshot();

    assert.equal(snapshot, null);
    assert.equal(panelChrome.sentToTabs.length, 1);
    const view = panel.buildView({ state: null, ruleRecords: [], view: 'records', now: NOW });
    assert.deepEqual(view.records, []);
    assert.equal(view.emptyText.length > 0, true);
  });

  it('没有活动标签时直接返回 null，不报错', async () => {
    const panelChrome = fakeChrome({ tabs: [] });
    const bridge = messageBridge.create({ transport: messageBridge.chromeTransport(panelChrome.api) });

    assert.equal(await bridge.requestSnapshot(), null);
    assert.deepEqual(panelChrome.sentToTabs, []);
  });

  it('侧边栏收到无关消息不触发 onPush', () => {
    const panelChrome = fakeChrome();
    const received = [];
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(panelChrome.api),
      onPush: (snapshot) => received.push(snapshot),
    });
    bridge.listen();

    assert.equal(panelChrome.deliver({ channel: 'dshcc:other' }, {}), undefined);
    assert.deepEqual(received, []);
  });

  it('dispose 后不再应答请求', () => {
    const contentChrome = fakeChrome();
    const bridge = messageBridge.create({
      transport: messageBridge.chromeTransport(contentChrome.api),
      getSnapshot: contentSnapshot,
    });
    bridge.listen();
    bridge.dispose();

    assert.equal(contentChrome.listeners.length, 0);
    assert.equal(contentChrome.deliver({ channel: CHANNELS.REQUEST }, {}), undefined);
  });
});
