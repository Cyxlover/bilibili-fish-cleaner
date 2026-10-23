// 侧边栏页面的真实装配：在假 DOM + 假 chrome 里跑 sidepanel.js，
// 确认打开面板时会向当前标签索取快照，并把「规则判的」与「我自己点的」都渲染出来。
//
// 侧边面板在 Edge 里需要浏览器才能打开；这里验证的是页面脚本的接线本身，
// 一旦 sidepanel.js 与消息桥、panel 的契约对不上就会红。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

function fakeElement(tag) {
  const node = {
    tag,
    children: [],
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      return child;
    },
    attachShadow() {
      this.shadow = fakeElement('shadow');
      this.shadow.innerHTML = '';
      this.shadow.addEventListener = () => {};
      this.shadow.removeEventListener = () => {};
      return this.shadow;
    },
    addEventListener() {},
    removeEventListener() {},
    closest() { return null; },
    textContent: '',
    innerHTML: '',
  };
  return node;
}

const root = fakeElement('div');
const document = {
  readyState: 'complete',
  getElementById: (id) => (id === 'dshcc-root' ? root : null),
  createElement: (tag) => fakeElement(tag),
  body: fakeElement('body'),
  addEventListener() {},
};

const NOW = Date.now();
const snapshot = {
  videoId: 'BV1xx411c7mD',
  aid: '998877',
  records: [
    {
      commentKey: 'r1',
      mid: '1001',
      scope: 'thread',
      rootCommentKey: 'r1',
      at: NOW - 60000,
      clues: [{ clueId: 'nickFish', label: '昵称含鱼', fragment: '大肥鱼' }],
    },
  ],
  state: {
    manualHidden: ['m1'],
    records: { m1: { commentKey: 'm1', mid: '2002', scope: 'thread', rootCommentKey: 'm1', at: NOW } },
    meta: { comments: { m1: { at: NOW } }, accounts: {} },
    keptException: [],
    accountBlocked: [],
    accountAllowed: [],
  },
  stats: { records: 1, hidden: 2, threads: 4, enabled: true, status: 'ok' },
};

function fakeContentChrome() {
  const listeners = [];
  return {
    api: {
      runtime: {
        lastError: null,
        onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
        // 内容脚本 push 走 runtime.sendMessage：扩展页（侧边栏）是它的接收方。
        sendMessage(message, callback) {
          for (const fn of panelListeners) {
            try {
              fn(message, {}, () => {});
            } catch (error) {
              // 单个接收方出错不影响其余接收方。
            }
          }
          if (callback) callback(undefined);
        },
      },
      tabs: { query: (info, callback) => callback([]), sendMessage() {} },
    },
    receive(message) {
      let reply;
      for (const listener of listeners) listener(message, { tab: { id: 7 } }, (value) => { reply = value; });
      return reply;
    },
  };
}

// 侧边栏页面的 onMessage 监听器：push 要真的能送到这里，才谈得上「推快照」。
const panelListeners = [];

const contentChrome = fakeContentChrome();
const sentToTabs = [];
const panelChrome = {
  runtime: {
    lastError: null,
    onMessage: {
      addListener: (fn) => panelListeners.push(fn),
      removeListener: (fn) => {
        const index = panelListeners.indexOf(fn);
        if (index !== -1) panelListeners.splice(index, 1);
      },
    },
    sendMessage(message, callback) { if (callback) callback(undefined); },
  },
  tabs: {
    query: (info, callback) => callback([{ id: 7, url: 'https://www.bilibili.com/video/BV1xx411c7mD' }]),
    sendMessage(tabId, message, callback) {
      sentToTabs.push({ tabId, message });
      if (callback) callback(contentChrome.receive(message));
    },
  },
};

const DSHCC = await loadExtension(
  'src/lib/purge-state.js',
  'src/lib/purge-settings.js',
  'src/lib/purge-records.js',
  'src/lib/purge-state-store.js',
  'src/lib/message-bridge.js',
  'src/ui/panel.js',
);
const contentBridge = DSHCC.messageBridge.create({
  transport: DSHCC.messageBridge.chromeTransport(contentChrome.api),
  getSnapshot: () => snapshot,
});
contentBridge.listen();

globalThis.document = document;
globalThis.chrome = panelChrome;
await loadExtension('src/sidepanel/sidepanel.js');

describe('侧边栏页面装配', () => {
  it('打开面板即向当前活动标签索取快照', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(sentToTabs.map((item) => item.message.channel), ['dshcc:getSnapshot']);
    assert.equal(sentToTabs[0].tabId, 7);
  });

  it('记录视图同时显示「规则判的」与「我自己点的」，并带原因', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const model = DSHCC.sidepanel.instance.model();
    assert.deepEqual(model.records.map((item) => item.commentKey).sort(), ['m1', 'r1']);
    const rule = model.records.find((item) => item.commentKey === 'r1');
    const manual = model.records.find((item) => item.commentKey === 'm1');
    assert.equal(rule.source, 'rule');
    assert.equal(manual.source, 'manual');
    assert.match(rule.reasonText, /昵称含鱼/);
    assert.match(manual.reasonText, /手动隐藏/);
  });

  it('面板已挂载，页面脚本没有抛错', () => {
    assert.ok(DSHCC.sidepanel.instance);
    assert.equal(typeof DSHCC.sidepanel.refresh, 'function');
  });

  it('连着推两份不同视频的快照，面板记录跟着换', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const instance = DSHCC.sidepanel.instance;

    // 第一支视频：把手动记录的 aid 补上，按 aid 过滤后仍应显示。
    snapshot.aid = '998877';
    snapshot.state.meta.comments.m1.aid = '998877';
    await contentBridge.push();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instance.getAid(), '998877');
    assert.deepEqual(instance.model().records.map((item) => item.commentKey).sort(), ['m1', 'r1']);

    // 换视频：同一份快照带新 aid，上一支视频的手动记录不该再出现。
    snapshot.aid = '111222333';
    snapshot.records = [{
      commentKey: 'r2',
      mid: '1002',
      aid: '111222333',
      scope: 'thread',
      rootCommentKey: 'r2',
      at: NOW - 30000,
    }];
    await contentBridge.push();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instance.getAid(), '111222333');
    assert.deepEqual(instance.model().records.map((item) => item.commentKey).sort(), ['r2']);
  });
});
