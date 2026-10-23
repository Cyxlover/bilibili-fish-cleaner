// 长评豁免（v2b → v2b-longform）的标定回归。
//
// 这里每个 rpid 都来自 design / validation 两份真实标注样本，没有构造夹具。
// 断言的用途是「标定漂移护栏」：只要有人动了阈值、词表或人设线索，本文件立刻变红，
// 逼他回到 design 集上重做标定、并在报告里写明新数字。
//
// 标定纪律（见 engine/README.md「长评豁免标定」）：
//   - design（3577 行）是标定集，可以反复看；
//   - validation（3931 行）只做一次性复核，本文件只把当时的复核结果钉死，
//     不允许为了让这里变绿而回头调参。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RULES_VERSION, judge, listRules } from '../../engine/index.js';
import { LONG_FORM_POLICY, isLongFormProse, measureLongForm } from '../../engine/longform.js';
import { normalizeObservation } from '../../engine/observation.js';
import { buildProfile } from '../../engine/profile.js';
import { buildPages, hasLabels, loadLabels, observationOf, pageContextOf, rowByRpid, splitByDataset } from '../../tools/lib/dataset.mjs';

// 标注数据是可选的本地研究数据：缺失时整文件跳过（开源仓库的正常状态），有数据时照旧全跑。
const DATA = hasLabels();
const SKIP = !DATA && '缺少本地标注数据';
const labels = DATA ? loadLabels() : [];
const { design, validation } = splitByDataset(labels);
const designPages = buildPages(design);
const validationPages = buildPages(validation);
const v2bVersion = listRules().find((rule) => rule.id === 'v2b').version;
const RANK = { none: 0, suspect: 1, hide: 2 };

const judgeBy = (version, row, pages) =>
  judge(observationOf(row), pageContextOf(pages, row), { rulesVersion: version, allowBaseline: true });

/** 豁免改变的行：v2b 的动作 ≠ 默认规则的动作。 */
function capChanges(rows, pages) {
  const changed = [];
  for (const row of rows) {
    const before = judgeBy(v2bVersion, row, pages);
    const after = judgeBy(DEFAULT_RULES_VERSION, row, pages);
    if (before.action === after.action) continue;
    changed.push({
      rpid: row.rpid,
      label: row.label,
      from: before.action,
      to: after.action,
      cappedBy: after.cappedBy,
      measure: measureLongForm(row.text),
    });
  }
  return changed;
}

test('豁免阈值与词表就是标定时的值（改动必须重做标定）', { skip: SKIP }, () => {
  assert.equal(LONG_FORM_POLICY.minLength, 60);
  assert.equal(LONG_FORM_POLICY.minBreaks, 3);
  assert.equal(LONG_FORM_POLICY.minTerms, 2);
  assert.deepEqual(LONG_FORM_POLICY.personaClues, ['selfDesig', 'master', 'bodyWord'], '人设线索变了，豁免边界就变了');
  assert.ok(LONG_FORM_POLICY.terms instanceof RegExp);
});

test('design 集：豁免只改变 1 行，且是 321554157072 的 hide→suspect', { skip: SKIP }, () => {
  assert.equal(design.length, 3577);
  assert.deepEqual(capChanges(design, designPages), [
    {
      rpid: '321554157072',
      label: 'unsure',
      from: 'hide',
      to: 'suspect',
      cappedBy: 'long-form-prose',
      measure: { length: 114, breaks: 3, terms: 2 },
    },
  ]);
});

test('validation 集：豁免只改变 2 行（一次性复核结果，不得据此调参）', { skip: SKIP }, () => {
  assert.equal(validation.length, 3931);
  assert.deepEqual(capChanges(validation, validationPages), [
    {
      rpid: '321585796048',
      label: 'bot',
      from: 'hide',
      to: 'suspect',
      cappedBy: 'long-form-prose',
      measure: { length: 109, breaks: 4, terms: 3 },
    },
    {
      rpid: '317848865873',
      label: 'bot',
      from: 'hide',
      to: 'suspect',
      cappedBy: 'long-form-prose',
      measure: { length: 112, breaks: 3, terms: 4 },
    },
  ]);
});

test('两个集合里被长评豁免命中的行就是标定记录里的 3 条', { skip: SKIP }, () => {
  const capped = (rows, pages) => rows.filter((row) => judgeBy(DEFAULT_RULES_VERSION, row, pages).cappedBy !== null).map((row) => row.rpid);
  assert.deepEqual(capped(design, designPages), ['321554157072']);
  assert.deepEqual(capped(validation, validationPages), ['321585796048', '317848865873']);
});

test('阈值达标但含人设线索的长评不享受豁免（317864107409 仍判隐藏）', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '317864107409');
  assert.ok(row, '样本必须存在：317864107409 是 design 集里带人设的机器人长评');
  // 先确认它确实越过三条阈值——否则这条断言证明不了「人设线索挡下了豁免」。
  assert.deepEqual(measureLongForm(row.text), { length: 74, breaks: 3, terms: 2 });
  const profile = buildProfile(normalizeObservation(observationOf(row)), pageContextOf(designPages, row));
  assert.equal(profile.has('selfDesig'), true, '正文自称鱼/机器人，属于人设线索');
  assert.equal(isLongFormProse(profile), false);

  const verdict = judgeBy(DEFAULT_RULES_VERSION, row, designPages);
  assert.equal(verdict.action, 'hide');
  assert.equal(verdict.cappedBy, null, '人设长评不应被豁免降档');
});

test('豁免只降不升：两个集合里默认规则的动作一律不严格于 v2b', { skip: SKIP }, () => {
  for (const [name, rows, pages] of [
    ['design', design, designPages],
    ['validation', validation, validationPages],
  ]) {
    for (const row of rows) {
      const before = judgeBy(v2bVersion, row, pages);
      const after = judgeBy(DEFAULT_RULES_VERSION, row, pages);
      assert.ok(RANK[after.action] <= RANK[before.action], `${name} ${row.rpid}：豁免把 ${before.action} 升成了 ${after.action}`);
      if (before.action !== after.action) {
        assert.equal(before.action, 'hide', `${name} ${row.rpid}：豁免只应作用于 hide`);
        assert.equal(after.action, 'suspect');
        assert.equal(after.cappedBy, 'long-form-prose');
      }
    }
  }
});
