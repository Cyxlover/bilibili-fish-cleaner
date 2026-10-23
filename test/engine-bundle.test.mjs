// 内容脚本只能加载经典脚本：engine-bundle.js 必须与 engine/ 的 ESM 行为一致，
// 且不能是手工改出来的旧副本（--check 防漂移）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadExtension } from './support/load-extension.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

await loadExtension('src/lib/engine-bundle.js');
const bundle = globalThis.DSHCC.engine;
const real = await import('../engine/index.js');

const SAMPLES = [
  {
    commentId: '1',
    authorMid: '42',
    nickname: '大肥鱼',
    text: '主人，白饭好了',
    isReply: false,
  },
  {
    commentId: '2',
    authorMid: '43',
    nickname: '普通用户',
    text: '这个教程写得不错，收藏了',
    isReply: false,
  },
  {
    commentId: '3',
    authorMid: '44',
    nickname: '鱼',
    text: '主人说得对',
    isReply: true,
    rootCommentId: '1',
  },
  {
    commentId: '4',
    authorMid: '45',
    nickname: '路人',
    text: '楼上说得有道理，我也这么觉得',
    isReply: true,
    rootCommentId: '2',
  },
];

describe('engine bundle：与 ESM 判定引擎一致', () => {
  it('规则版本与规则清单一致', () => {
    assert.equal(bundle.DEFAULT_RULES_VERSION, real.DEFAULT_RULES_VERSION);
    assert.deepEqual(bundle.RULE_VERSIONS, real.RULE_VERSIONS);
    assert.deepEqual(bundle.listRules(), real.listRules());
  });

  it('同一批观测输出完全一致（含楼中楼与 pageContext）', () => {
    for (const observation of SAMPLES) {
      const pageContext = { sameAccountOnPage: [{ text: '同页另一条评论' }] };
      assert.deepEqual(
        JSON.parse(JSON.stringify(bundle.judge(observation, pageContext))),
        JSON.parse(JSON.stringify(real.judge(observation, pageContext))),
        `观测 ${observation.commentId} 判定不一致`,
      );
    }
  });

  it('未知规则版本两边都抛错', () => {
    assert.throws(() => bundle.judge(SAMPLES[0], undefined, { rulesVersion: 'nope' }));
    assert.throws(() => real.judge(SAMPLES[0], undefined, { rulesVersion: 'nope' }));
  });

  // 资料按需读取必须真的被打进内容脚本可用的 bundle：
  // 只存在于 engine/ 的 ESM 里而没进 bundle，线上就等于没接。
  it('bundle 导出资料按需读取的两个入口，行为与 ESM 一致', async () => {
    assert.equal(typeof bundle.needsProfile, 'function');
    assert.equal(typeof bundle.createProfileReader, 'function');

    const withClue = { authorMid: '42', nickname: '大肥鱼', text: '主人，白饭好了' };
    const noClue = { authorMid: '43', nickname: '普通用户', text: '这个教程写得不错，收藏了' };
    assert.deepEqual(bundle.needsProfile(withClue), real.needsProfile(withClue));
    assert.deepEqual(bundle.needsProfile(noClue), real.needsProfile(noClue));
    assert.equal(bundle.needsProfile(noClue).needed, false);

    const urls = [];
    const fakeRequest = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ data: { card: { sign: '我家的鱼' } } }) };
    };
    const fromBundle = await bundle.createProfileReader({ request: fakeRequest }).read(withClue);
    const fromReal = await real.createProfileReader({ request: fakeRequest }).read(withClue);
    assert.deepEqual(fromBundle, fromReal);
    assert.deepEqual(fromBundle, { status: 'ok', value: '我家的鱼' });
  });

  it('生成的 bundle 没有漂移（node scripts/build-engine.mjs --check）', () => {
    const output = execFileSync('node', ['scripts/build-engine.mjs', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.match(output, /一致/);
  });
});
