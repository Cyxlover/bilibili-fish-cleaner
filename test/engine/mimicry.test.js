// 真人「玩梗」的回归：自称鱼、叫主人、复读口癖、引用机器人台词、@ 别人玩梗。
//
// 这些评论与被判隐藏的评论共享同一批表面特征（昵称带鱼、正文有「主人/白饭/口癖」），
// 用来看住一件事：规则不能把「说话像鱼」直接当成「是鱼」。夹具全部是 design 集里
// 真实标注为 human 的样本（rpid 来自 labels.jsonl），断言值是该样本在默认规则下的实测结果。
//
// 最后一条是性质测试，属于回归护栏：它保证「design 的 human 行一条都不会被隐藏」这一
// 构造约束没有被破坏，但它证明不了识别能力——标签与规则同源，真误隐藏只能靠盲标量
// （`node tools/regression.mjs` 的 B 段：8.3 条 / 95% 上界 16.8 条）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RULES_VERSION, judge, listRules } from '../../engine/index.js';
import { buildPages, hasLabels, loadLabels, observationOf, pageContextOf, rowByRpid, splitByDataset } from '../../tools/lib/dataset.mjs';

// 标注数据是可选的本地研究数据：缺失时整文件跳过（开源仓库的正常状态），有数据时照旧全跑。
const DATA = hasLabels();
const SKIP = !DATA && '缺少本地标注数据';
const labels = DATA ? loadLabels() : [];
const { design } = splitByDataset(labels);
const designPages = buildPages(design);
const v2bVersion = listRules().find((rule) => rule.id === 'v2b').version;

const judgeBy = (version, row) => judge(observationOf(row), pageContextOf(designPages, row), { rulesVersion: version, allowBaseline: true });
const humanRow = (rpid) => {
  const row = rowByRpid(design, rpid);
  assert.ok(row, `样本必须存在：${rpid}`);
  assert.equal(row.dataset, 'design', `${rpid} 应属于 design 标定集`);
  assert.equal(row.label, 'human', `${rpid} 应标注为 human`);
  return row;
};

test('真人玩梗（自称鱼、叫主人、白饭）最多判疑似，不判隐藏', { skip: SKIP }, () => {
  const cases = [
    // 单来源：正文里既是「主人」又是「白饭」，同源折算后只有 1 份证据。
    { rpid: '321567765296', independentSources: 1, clues: ['master', 'rice'] },
    // 三来源：昵称、主人、白饭各算一份，但仍不足以定案。
    { rpid: '321552274240', independentSources: 3, clues: ['master', 'rice', 'nickLoose'] },
  ];
  for (const { rpid, independentSources, clues } of cases) {
    const row = humanRow(rpid);
    const verdict = judgeBy(DEFAULT_RULES_VERSION, row);
    assert.equal(verdict.action, 'suspect', `${rpid}：真人玩梗应停在疑似`);
    assert.equal(verdict.independentSources, independentSources, `${rpid}：来源折算数`);
    assert.equal(verdict.cappedBy, null, `${rpid}：不是长评豁免救下来的，是真的证据不足`);
    for (const clueId of clues) {
      assert.ok(verdict.clues.some((clue) => clue.clueId === clueId), `${rpid}：应命中 ${clueId}`);
    }
  }
});

test('复读机器人口号（chant）单凭口癖不构成证据', { skip: SKIP }, () => {
  for (const rpid of ['321496973952', '321591531088']) {
    const row = humanRow(rpid);
    const verdict = judgeBy(DEFAULT_RULES_VERSION, row);
    assert.equal(verdict.action, 'none', `${rpid}：复读口号不该被判疑似`);
    assert.equal(verdict.independentSources, 1, `${rpid}：只有口癖一份证据`);
    assert.deepEqual(verdict.clues.map((clue) => clue.clueId), ['chant'], `${rpid}：只应命中 chant`);
    assert.equal(verdict.clues[0].used, false, `${rpid}：口癖不参与任何判档`);
  }
});

test('引用机器人台词、@ 别人的玩法评论不判隐藏', { skip: SKIP }, () => {
  // 317654015425 把机器人台词原样引了一遍（带 @ 前缀），表面特征最多。
  // 321598032176 同时命中昵称、主人、转述结构与 @ —— 折算后仍不达隐藏。
  // 317877865521 有两份来源（昵称 + 隐含人设），但没有任何一条进入规则。
  for (const rpid of ['317654015425', '321598032176', '317877865521']) {
    const row = humanRow(rpid);
    const verdict = judgeBy(DEFAULT_RULES_VERSION, row);
    assert.equal(verdict.action, 'none', `${rpid}：引用/复述不该被判隐藏或疑似`);
    assert.equal(verdict.cappedBy, null);
  }
  // 单独把「来源多」那一例点出来：2 份来源仍然可以是 none，说明动作不是按线索条数堆出来的。
  assert.equal(judgeBy(DEFAULT_RULES_VERSION, humanRow('317877865521')).independentSources, 2);
});

test('性质测试（回归护栏）：design 集全部 human 行在 v2b 下 hide 数量为 0', { skip: SKIP }, () => {
  // 这是护栏，不是能力证明：design 的 human 标签与规则取自同一批字段，规则在标定时
  // 就是照着「human 行不隐藏」的约束长出来的，所以这里恒为 0 是构造使然。
  // 它能挡住的是「有人把阈值调松到连 design 的真人行都开始隐藏」这种回归。
  // 真实的误隐藏量必须看盲标：默认规则 8.3 条（95% 上界 16.8），见 engine/README.md。
  const offenders = [];
  for (const row of design) {
    if (row.label !== 'human') continue;
    if (judgeBy(v2bVersion, row).action === 'hide') offenders.push(row.rpid);
  }
  assert.deepEqual(offenders, [], 'v2b 把 design 的真人行判成了隐藏');
  assert.equal(offenders.length, 0);

  // 默认规则（v2b-longform）只能更宽松，同样必须是 0。
  const defaultOffenders = design.filter((row) => row.label === 'human' && judgeBy(DEFAULT_RULES_VERSION, row).action === 'hide').map((row) => row.rpid);
  assert.deepEqual(defaultOffenders, []);
});
