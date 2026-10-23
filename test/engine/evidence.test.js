// 证据折算与门槛：单一线索不足定案、同源特征折算成一份证据、资料缺失保持中立、页面上下文缺省不放宽。
// 全部用真实标注样本做性质检验，不造数据。
import test from 'node:test';
import assert from 'node:assert/strict';

import { judge } from '../../engine/index.js';
import { buildPages, hasLabels, loadLabels, observationOf, pageContextOf, rowByRpid, splitByDataset } from '../../tools/lib/dataset.mjs';

// 标注数据是可选的本地研究数据：缺失时整文件跳过（开源仓库的正常状态），有数据时照旧全跑。
const DATA = hasLabels();
const SKIP = !DATA && '缺少本地标注数据';
const labels = DATA ? loadLabels() : [];
const { design, validation } = splitByDataset(labels);
const RANK = { none: 0, suspect: 1, hide: 2 };

test('单一线索不足以定案：只有一个独立来源的观测绝不会判 hide', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321599301904'); // 昵称 + 简介都是鱼，正文没有母题
  const verdict = judge(observationOf(row));
  assert.equal(verdict.independentSources, 1);
  assert.equal(verdict.action, 'suspect');
  assert.ok(verdict.clues.length >= 2, '面板仍应看到两条命中线索');

  for (const r of labels) {
    const v = judge(observationOf(r));
    if (v.independentSources < 2) assert.notEqual(v.action, 'hide', `rpid=${r.rpid} 单来源却判了 hide`);
  }
});

test('同源证据折算：同一账号在昵称/简介里命中多条特征，只算一份证据', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321596872320'); // nickFish + bioFish + selfDesig
  const v = judge(observationOf(row));
  const account = v.sources.find((s) => s.source === 'account');
  assert.ok(account, '账号来源应记为一份证据');
  assert.ok(account.hits >= 2, '账号来源内应能看到多条命中特征');
  assert.equal(account.clueIds.length, account.hits);
  // 命中 2 条账号特征 + 1 条正文母题 → 证据份数是 2，不是 3
  assert.equal(v.independentSources, 2);
  assert.equal(v.sources.reduce((n, s) => n + s.hits, 0), 3);
});

test('证据份数按来源计，不按命中的线索条数累加（全量样本性质检验）', { skip: SKIP }, () => {
  for (const r of labels) {
    const v = judge(observationOf(r));
    const sources = new Set(v.sources.map((s) => s.source));
    assert.equal(v.independentSources, sources.size, `rpid=${r.rpid} 证据份数与来源数不一致`);
    assert.ok(v.independentSources <= v.clues.length, `rpid=${r.rpid} 证据份数不该超过命中线索条数`);
    if (v.action === 'hide') assert.ok(v.independentSources >= 2, `rpid=${r.rpid} hide 却只有 ${v.independentSources} 份证据`);
    // 线索明细里同一条线索只出现一次（同源多条命中不重复刷屏）
    assert.equal(new Set(v.clues.map((c) => c.clueId)).size, v.clues.length);
  }
});

test('资料缺失不增强也不削弱：空简介、读取失败、没有简介字段三种形态判定完全一致', { skip: SKIP }, () => {
  const forms = [(o) => ({ ...o, bio: '' }), (o) => ({ ...o, bio: { status: 'failed' } }), (o) => ({ ...o, bio: null })];
  for (const r of [...design, ...validation]) {
    const obs = observationOf(r);
    const base = judge(forms[0](obs));
    for (const form of forms.slice(1)) {
      assert.deepEqual(judge(form(obs)), base, `rpid=${r.rpid} 简介缺失形态影响了判定`);
    }
  }
});

test('简介读取失败不被当证据：靠简介判 hide 的观测，简介缺失后不再判 hide', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321587296832'); // 昵称不是鱼，靠简介（bioFish）+ 正文母题才 hide
  const withBio = judge(observationOf(row));
  const withoutBio = judge({ ...observationOf(row), bio: { status: 'failed' } });
  assert.equal(withBio.action, 'hide');
  assert.notEqual(withoutBio.action, 'hide');
  assert.equal(withoutBio.sources.some((s) => s.clueIds.includes('bioFish')), false);
});

test('未提供页面上下文时正常运行，且不会凭空放宽判定（全量样本）', { skip: SKIP }, () => {
  for (const set of [design, validation]) {
    const pages = buildPages(set);
    for (const r of set) {
      const obs = observationOf(r);
      const withoutCtx = judge(obs);
      const withCtx = judge(obs, pageContextOf(pages, r));
      assert.ok(
        RANK[withoutCtx.action] <= RANK[withCtx.action],
        `rpid=${r.rpid} 无上下文判得比有上下文更严：${withoutCtx.action} > ${withCtx.action}`,
      );
    }
  }
});

test('页面上下文只看同账号在本页的其他评论：别人的评论不会成为你的证据', { skip: SKIP }, () => {
  const set = design;
  const pages = buildPages(set);
  const row = rowByRpid(set, '321599301904');
  const others = (pages.get(row.mid + '|' + row.bvid) || []).filter((p) => p.mid !== row.mid);
  const ctxFromOthers = { sameAccountOnPage: others };
  assert.deepEqual(judge(observationOf(row), ctxFromOthers), judge(observationOf(row)));
});
