// 简介按需读取的客户端：缺口判定 → 请求 → 塞回观测 → 线索命中。
//
// 这条链是 B1 的全部意义所在：引擎和读取纪律早就写好了，但内容脚本从没把
// 「要不要读」和「读到了塞哪」接起来，bioFish/bioOper 两类高权重线索因此线上永不命中。
// 这里用假 request 复刻 Service Worker 的三种应答，断言接线是对的。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

await loadExtension('src/lib/profile-client.js');
const { profileClient } = globalThis.DSHCC;

// 引擎用真包（与内容脚本同一份）：判定与缺口判定都不该在测试里再实现一遍。
const engine = await import('../engine/index.js');

/** 昵称命中「大肥鱼」：没有简介时就已经有线索，属于「值得读」的那一类。 */
function observation(mid, extra) {
  return {
    commentKey: `c-${mid}`,
    mid: String(mid),
    authorMid: String(mid),
    nickname: '大肥鱼',
    text: '路过',
    isReply: false,
    ...extra,
  };
}

/** 一个记账用的假请求：按需返回成功/失败，并记下被请求的 mid。 */
function fakeRequest(answer) {
  const asked = [];
  const request = (payload) => {
    asked.push(payload.authorMid);
    return Promise.resolve(typeof answer === 'function' ? answer(payload) : answer);
  };
  return { request, asked };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('简介按需读取的客户端', () => {
  it('没有线索的评论不产生任何请求', async () => {
    const { request, asked } = fakeRequest({ status: 'failed' });
    const client = profileClient.create({ engine, request });
    const quiet = { commentKey: 'c-1', mid: '7', authorMid: '7', nickname: '路人甲', text: '学习了' };

    const verdict = client.judge(quiet, {});
    await tick();

    assert.equal(asked.length, 0);
    assert.deepEqual(verdict, engine.judge(quiet, {}));
  });

  it('资料还没回来时先按没有资料判定，与引擎原判定一致', async () => {
    const { request } = fakeRequest({ status: 'ok', value: '屏幕底边' });
    const client = profileClient.create({ engine, request });
    const obs = observation('1001');

    const verdict = client.judge(obs, {});
    assert.deepEqual(verdict, engine.judge(obs, {}));
  });

  it('读到的简介塞回观测后，bioFish 线索才命中，并通知调用方重扫', async () => {
    const { request, asked } = fakeRequest({ status: 'ok', value: '住在屏幕底边的赛博鱼' });
    const changed = [];
    const client = profileClient.create({
      engine,
      request,
      onChange: (mid, bio) => changed.push([mid, bio]),
    });
    const obs = observation('1002');

    const before = client.judge(obs, {});
    assert.equal(before.clues.some((clue) => clue.clueId === 'bioFish'), false);

    await tick();
    assert.deepEqual(asked, ['1002']);
    assert.deepEqual(changed, [['1002', { status: 'ok', value: '住在屏幕底边的赛博鱼' }]]);

    // 重扫时同一份观测已经带着简介：bioFish 上线，证据份数随之增加。
    const after = client.judge(obs, {});
    const hit = after.clues.find((clue) => clue.clueId === 'bioFish');
    assert.ok(hit, '读到简介后 bioFish 必须命中');
    assert.equal(hit.used, true);
    assert.equal(hit.strength, 3);
    assert.equal(client.bioFor('1002').value, '住在屏幕底边的赛博鱼');
  });

  it('简介声明账号被占用时命中 bioOper', async () => {
    const { request } = fakeRequest({ status: 'ok', value: '账号给主人刷视频用' });
    const client = profileClient.create({ engine, request });
    const obs = observation('1003');

    client.judge(obs, {});
    await tick();

    const after = client.judge(obs, {});
    assert.ok(after.clues.some((clue) => clue.clueId === 'bioOper'));
  });

  it('请求失败时安静降级：不通知重扫，判定与没有资料完全相同', async () => {
    const { request } = fakeRequest({ status: 'failed' });
    const changed = [];
    const client = profileClient.create({
      engine,
      request,
      onChange: () => changed.push(1),
    });
    const obs = observation('1004');

    const before = client.judge(obs, {});
    await tick();

    // 失败会记成 {status:'failed'}（只用来拦住重试），但不触发重扫、也不改判定。
    assert.deepEqual(changed, []);
    assert.deepEqual(client.bioFor('1004'), { status: 'failed' });
    assert.deepEqual(client.judge(obs, {}), before);
    assert.deepEqual(before, engine.judge(obs, {}));
  });

  it('同一个作者一个页面会话只问一次，失败也不重试', async () => {
    let calls = 0;
    const client = profileClient.create({
      engine,
      request: () => {
        calls += 1;
        return Promise.reject(new Error('网络断了'));
      },
    });
    const obs = observation('1005');

    client.judge(obs, {});
    await tick();
    client.judge(obs, {});
    client.beginScan();
    client.judge(obs, {});
    await tick();

    assert.equal(calls, 1);
  });

  it('一次扫描最多取 5 个作者，重开扫描才继续', async () => {
    const { request, asked } = fakeRequest({ status: 'failed' });
    const client = profileClient.create({ engine, request });
    const people = [1, 2, 3, 4, 5, 6].map((n) => observation(`200${n}`));

    client.beginScan();
    for (const person of people) client.judge(person, {});
    await tick();
    assert.deepEqual(asked, ['2001', '2002', '2003', '2004', '2005']);

    // 新一次扫描：名额重发，第六个作者这时才被问。
    client.beginScan();
    for (const person of people) client.judge(person, {});
    await tick();
    assert.deepEqual(asked, ['2001', '2002', '2003', '2004', '2005', '2006']);
  });

  it('limit 可以调小，0 表示本次页面完全不取资料', async () => {
    const { request, asked } = fakeRequest({ status: 'ok', value: '屏幕底边' });
    const client = profileClient.create({ engine, request, limit: 0 });

    client.judge(observation('3001'), {});
    await tick();
    assert.deepEqual(asked, []);
  });
});
