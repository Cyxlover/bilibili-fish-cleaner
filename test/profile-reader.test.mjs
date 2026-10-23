// 资料按需读取的「怎么读」：请求 + 会话去重 + 本机缓存 + 节流 + 失败降级。
// 全部注入假 request 与假存储，没有任何真实网络请求，也不碰 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_CACHE_LIMIT,
  PROFILE_TTL_MS,
  createProfileCache,
  createProfileReader,
} from '../engine/profile-reader.js';
import { judge } from '../engine/index.js';
import { hasLabels, loadLabels, observationOf, rowByRpid } from '../tools/lib/dataset.mjs';

// 标注数据是可选的本地研究数据：缺失时整文件跳过（开源仓库的正常状态）。
const DATA = hasLabels();
const SKIP = !DATA && '缺少本地标注数据';
const labels = DATA ? loadLabels() : [];
const clueRow = DATA ? rowByRpid(labels, '321603001488') : null; // 昵称「大肥鱼条鱼」＋ @提及，简介为空
const plainRow = DATA ? rowByRpid(labels, '321605257808') : null; // 昵称/正文/简介都无人设线索
const withoutBio = (row) => ({ ...observationOf(row), bio: null });

function fakeStore(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    load: async () => JSON.parse(JSON.stringify(data)),
    save: async (next) => {
      data = JSON.parse(JSON.stringify(next));
    },
    dump: () => data,
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// 站点返回的形状：卡片里还有很多别的字段，本切片只允许读 sign。
const response = (sign) => ({
  ok: true,
  status: 200,
  json: async () => ({
    code: 0,
    data: { card: { mid: '1', name: '某人的昵称', face: 'http://example.invalid/a.jpg', level: 6, sign } },
  }),
});

test('没有任何线索的评论：不产生任何请求', { skip: SKIP }, async () => {
  const calls = [];
  const reader = createProfileReader({
    request: async (url, init) => {
      calls.push({ url, init });
      return response('简介');
    },
  });
  const bio = await reader.read(withoutBio(plainRow));
  assert.equal(bio, null);
  assert.equal(calls.length, 0, '无线索就不该暴露这次浏览');
});

test('出现线索时才读取：一次只读 GET，只带作者 mid', { skip: SKIP }, async () => {
  const calls = [];
  const reader = createProfileReader({
    request: async (url, init) => {
      calls.push({ url, init });
      return response('大肥鱼本人，程序员');
    },
  });
  const bio = await reader.read(withoutBio(clueRow));
  assert.deepEqual(bio, { status: 'ok', value: '大肥鱼本人，程序员' });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(init.method, 'GET', '全程只读');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('mid'), String(clueRow.mid));
  assert.deepEqual([...parsed.searchParams.keys()], ['mid'], '只读公开简介，不翻页、不抓其他资料');
});

test('同一页面会话内同一作者只读取一次', { skip: SKIP }, async () => {
  let calls = 0;
  const reader = createProfileReader({
    request: async () => {
      calls += 1;
      return response('简介');
    },
  });
  const first = await reader.read(withoutBio(clueRow));
  const second = await reader.read({ ...withoutBio(clueRow), commentId: 'another-comment' });
  assert.deepEqual(first, { status: 'ok', value: '简介' });
  assert.equal(second, null, '已读过就不给证据，也不重复请求');
  assert.equal(calls, 1);
});

test('读取结果落本机缓存：换一次会话也不重复请求，且只落简介与时间', { skip: SKIP }, async () => {
  const store = fakeStore();
  const clock = fakeClock();
  const cache = createProfileCache({ ...store, now: clock.now });
  let calls = 0;
  const reader = createProfileReader({
    request: async () => {
      calls += 1;
      return response('大肥鱼本人');
    },
    cache,
  });
  await reader.read(withoutBio(clueRow));

  const entry = store.dump()[String(clueRow.mid)];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'sign'], '不落昵称、头像、等级、关注关系');
  assert.equal(entry.sign, '大肥鱼本人');

  const nextSession = createProfileReader({
    request: async () => {
      calls += 1;
      return response('不该被请求');
    },
    cache,
  });
  const bio = await nextSession.read(withoutBio(clueRow));
  assert.deepEqual(bio, { status: 'ok', value: '大肥鱼本人' });
  assert.equal(calls, 1, '缓存命中时不发请求');
});

test('缓存过期后重新读取', { skip: SKIP }, async () => {
  const store = fakeStore();
  const clock = fakeClock();
  const cache = createProfileCache({ ...store, now: clock.now });
  let calls = 0;
  const session = () =>
    createProfileReader({
      request: async () => {
        calls += 1;
        return response(`简介${calls}`);
      },
      cache,
    });

  await session().read(withoutBio(clueRow));
  clock.advance(PROFILE_TTL_MS - 1);
  assert.equal((await session().read(withoutBio(clueRow))).value, '简介1', '未过期仍走缓存');
  clock.advance(2);
  assert.equal((await session().read(withoutBio(clueRow))).value, '简介2', '过期后重新读取');
  assert.equal(calls, 2);
});

test('读取失败或字段缺失：一律当作没有这条证据，且不写缓存', { skip: SKIP }, async () => {
  const store = fakeStore();
  const cache = createProfileCache({ ...store, now: () => Date.now() });
  const failures = [
    () => ({ ok: false, status: 412, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => ({ code: -404, data: null }) }),
    async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { card: { mid: '1' } } }) }),
    async () => {
      throw new Error('boom');
    },
  ];
  for (const request of failures) {
    const bio = await createProfileReader({ request, cache }).read(withoutBio(clueRow));
    assert.deepEqual(bio, { status: 'failed' });
  }
  assert.deepEqual(store.dump(), {}, '失败不落缓存，下一次会话可以再读');
});

test('请求超时：当作没有这条证据，不写缓存', { skip: SKIP }, async () => {
  const store = fakeStore();
  const cache = createProfileCache({ ...store, now: () => Date.now() });
  const reader = createProfileReader({ request: () => new Promise(() => {}), cache, timeoutMs: 5 });
  const bio = await reader.read(withoutBio(clueRow));
  assert.deepEqual(bio, { status: 'failed' });
  assert.deepEqual(store.dump(), {});
});

test('多个作者依次读取：请求之间保持间隔，不并发轰炸', { skip: SKIP }, async () => {
  const started = [];
  const reader = createProfileReader({
    minIntervalMs: 25,
    request: async (url) => {
      started.push({ mid: new URL(url).searchParams.get('mid'), at: Date.now() });
      return response('简介');
    },
  });
  const observe = (mid) => ({ authorMid: mid, nickname: '大肥鱼', text: '路过' });
  await Promise.all([reader.read(observe('1001')), reader.read(observe('1002')), reader.read(observe('1003'))]);

  assert.equal(started.length, 3);
  for (let i = 1; i < started.length; i += 1) {
    const gap = started[i].at - started[i - 1].at;
    assert.ok(gap >= 20, `第 ${i} 个请求只隔了 ${gap}ms，节流没生效`);
  }
});

test('缓存有条数上限：超出后清掉最旧的，不会无限增长', { skip: SKIP }, async () => {
  const store = fakeStore();
  const clock = fakeClock();
  const cache = createProfileCache({ ...store, now: clock.now, limit: 3 });
  for (let i = 0; i < 5; i += 1) {
    await cache.set(`mid${i}`, `简介${i}`);
    clock.advance(1000);
  }
  assert.deepEqual(Object.keys(store.dump()).sort(), ['mid2', 'mid3', 'mid4']);
});

test('默认上限就是 PROFILE_CACHE_LIMIT 条', { skip: SKIP }, async () => {
  const store = fakeStore();
  const clock = fakeClock();
  const cache = createProfileCache({ ...store, now: clock.now });
  for (let i = 0; i <= PROFILE_CACHE_LIMIT; i += 1) {
    await cache.set(`mid${i}`, `简介${i}`);
    clock.advance(1000);
  }
  assert.equal(Object.keys(store.dump()).length, PROFILE_CACHE_LIMIT);
});

test('读取失败不改变判定：与从未读过简介完全一致', { skip: SKIP }, () => {
  const observation = withoutBio(clueRow);
  const baseline = judge(observation);
  const failed = judge({ ...observation, bio: { status: 'failed' } });
  assert.equal(failed.action, baseline.action);
  assert.deepEqual(
    failed.clues.map((clue) => clue.clueId),
    baseline.clues.map((clue) => clue.clueId),
  );
});
