// Service Worker 的「按需取资料」：内容脚本问一次，后台替它读一次。
//
// 这里断言的是真正接线后的行为，不是引擎内部：
//   - 只问一个域名、只发 GET、不带 cookie；
//   - 不需要资料时一个请求都不发（隐私边界）；
//   - 失败安静降级为 {status:'failed'}，且判定结果与「没有资料」完全一致；
//   - 同一作者只读一次，读到的简介只以 {sign, at} 落缓存。
//
// 假 chrome 复刻 MV3 的回调式 storage 与 onMessage 异步应答；假 fetch 不出网。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

const NOW = new Date(2026, 9, 23, 22, 30, 0).getTime();

/** 内容脚本会发来的请求形状（与 message-bridge 的 profileRequestOf 同构）。 */
const HIT = { authorMid: '1001', nickname: '大肥鱼', text: '路过', isReply: false };
const NO_CLUE = { authorMid: '1002', nickname: '张三', text: '学习了', isReply: false };
const WILL_FAIL = { authorMid: '1003', nickname: '大肥鱼', text: '路过', isReply: false };
const CACHED = { authorMid: '1004', nickname: '大肥鱼', text: '路过', isReply: false };

const SIGN = '我家的鱼';

// ---- 假 chrome / 假网络 -------------------------------------------------
const listeners = [];
const storage = {};
const requests = [];
const calls = [];

let reply = { ok: true, json: async () => ({ data: { card: { sign: SIGN } } }) };

globalThis.chrome = {
  runtime: {
    lastError: null,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      },
    },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: {
    local: {
      get(key, callback) {
        callback(storage[key] === undefined ? {} : { [key]: storage[key] });
      },
      set(patch, callback) {
        for (const [key, value] of Object.entries(patch)) storage[key] = value;
        if (typeof callback === 'function') callback();
      },
    },
  },
};

globalThis.fetch = (url, init) => {
  requests.push({ url, init, at: NOW });
  if (init && init.signal && init.signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  return Promise.resolve(reply);
};

// 引擎包先挂到 globalThis.DSHCC.engine，等价于 Service Worker 里的 importScripts。
await loadExtension('src/lib/message-bridge.js', 'src/lib/engine-bundle.js', 'src/background.js');

const { engine, messageBridge } = globalThis.DSHCC;

// 内容脚本真正用的路径：桥把请求发出去，后台监听到就应答，桥再把应答解包。
// 走这条路径，测试同时覆盖两侧的字段对齐（少一个字段就会在这里露出来）。
const bridge = messageBridge.create({
  transport: {
    send(message) {
      return new Promise((resolve) => {
        let handled = false;
        for (const listener of listeners.slice()) {
          handled = listener(message, {}, resolve) || handled;
        }
        if (!handled) resolve(null);
      });
    },
  },
});

function ask(observation) {
  return bridge.requestProfile(observation);
}

function asBio(profile) {
  // 内容脚本拿到结果后塞进观测的方式：ok 就是 {status,value}，失败原样带过去。
  return profile || null;
}

describe('取资料的后台服务', () => {
  it('只注册一份监听，且只认取资料这条频道', () => {
    assert.equal(listeners.length, 1);
    const message = { channel: 'dshcc:getSnapshot' };
    assert.equal(listeners[0](message, {}, () => {}), false);
  });

  it('需要资料时只朝一个域名发一次 GET，且不带 cookie', async () => {
    const profile = await ask(HIT);
    assert.deepEqual(profile, { status: 'ok', value: SIGN });

    assert.equal(requests.length, 1);
    const [{ url, init }] = requests;
    assert.match(url, /^https:\/\/api\.bilibili\.com\/x\/space\/acc\/info\?mid=1001$/);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    // 引擎包里的 URL 构造与 manifest 的 host_permissions 必须是同一个域名。
    assert.equal(new URL(url).origin, 'https://api.bilibili.com');
  });

  it('读到的简介只以 {sign, at} 落缓存，不落昵称等其他资料', async () => {
    const block = storage['dshcc.profile.cache.v1'];
    assert.ok(block && typeof block === 'object');
    const entry = block['1001'];
    assert.ok(entry, '成功读取后应写入缓存');
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'sign']);
    assert.equal(entry.sign, SIGN);
    assert.equal(typeof entry.at, 'number');
  });

  it('同一作者再问一次走缓存，不再发请求', async () => {
    const before = requests.length;
    const profile = await ask(HIT);
    assert.deepEqual(profile, { status: 'ok', value: SIGN });
    assert.equal(requests.length, before);
  });

  it('没有任何线索的评论不发请求，安静返回 null', async () => {
    // 夹具前提：这条观测在没有简介时判定不到任何线索，否则下面的断言没有意义。
    assert.equal(engine.needsProfile(NO_CLUE).needed, false);
    const before = requests.length;
    const profile = await ask(NO_CLUE);
    assert.equal(profile, null);
    assert.equal(requests.length, before);
  });

  it('请求失败时安静降级，判定结果与没有资料完全相同', async () => {
    reply = { ok: false, status: 412, json: async () => ({}) };
    const failed = await ask(WILL_FAIL);
    assert.deepEqual(failed, { status: 'failed' });

    const without = { ...WILL_FAIL, bio: null };
    const withFailed = { ...WILL_FAIL, bio: asBio(failed) };
    const ctx = { videoTitle: '测试视频' };
    assert.deepEqual(engine.judge(withFailed, ctx), engine.judge(without, ctx));
    // 失败也不该在页面上多出任何线索。
    assert.deepEqual(
      engine.judge(withFailed, ctx).clues,
      engine.judge(without, ctx).clues,
    );
  });

  it('失败过的作者不再重试，第二次问直接返回 null', async () => {
    const before = requests.length;
    const again = await ask(WILL_FAIL);
    assert.equal(again, null);
    assert.equal(requests.length, before);
  });

  it('缓存里的旧结果可以直接复用', async () => {
    reply = { ok: true, json: async () => ({ data: { card: { sign: SIGN } } }) };
    storage['dshcc.profile.cache.v1'] = {
      ...storage['dshcc.profile.cache.v1'],
      1004: { sign: '另一条鱼', at: Date.now() },
    };
    const before = requests.length;
    const profile = await ask(CACHED);
    assert.deepEqual(profile, { status: 'ok', value: '另一条鱼' });
    assert.equal(requests.length, before);
  });
});
