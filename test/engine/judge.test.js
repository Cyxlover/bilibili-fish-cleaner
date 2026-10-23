// 判定引擎的公共接缝：judge(观测, 页面上下文, 选项) → 判定结果。
// 这里只通过引擎导出的公共 API 断言「外部可观察行为」，不触碰内部实现。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RULES_VERSION, judge, listRules } from '../../engine/index.js';
import { hasLabels, loadLabels, observationOf, rowByRpid } from '../../tools/lib/dataset.mjs';

// 标注数据是可选的本地研究数据：缺失时整文件跳过（开源仓库的正常状态），有数据时照旧全跑。
const DATA = hasLabels();
const SKIP = !DATA && '缺少本地标注数据';
const labels = DATA ? loadLabels() : [];

/** 用真实标注样本构造观测（不编造样本）。 */
function observation(rpid, patch = {}) {
  const row = rowByRpid(labels, rpid);
  assert.ok(row, `labels.jsonl 里找不到 rpid=${rpid}`);
  return { ...observationOf(row), ...patch };
}

test('三档动作：账号身份 + 正文母题 → hide；只有身份元数据 → suspect；无任何线索 → none', { skip: SKIP }, () => {
  assert.equal(judge(observation('317911973777')).action, 'hide');
  assert.equal(judge(observation('321599301904')).action, 'suspect');
  assert.equal(judge(observation('321605257808')).action, 'none');
});

test('判定结果携带规则版本号，且版本号来自规则集注册表', { skip: SKIP }, () => {
  const verdict = judge(observation('317911973777'));
  assert.equal(verdict.rulesVersion, DEFAULT_RULES_VERSION);
  assert.match(verdict.rulesVersion, /^[a-z0-9-]+@\d{4}\.\d{2}\.\d{2}(-r\d+)?$/i);

  const versions = listRules().map((r) => r.version);
  assert.ok(versions.includes(DEFAULT_RULES_VERSION));
  assert.ok(listRules().every((r) => r.version && r.tier === 'candidate' || r.tier === 'baseline'));
});

test('判定带线索明细：每条线索有标识、来源、强度、命中片段', { skip: SKIP }, () => {
  const verdict = judge(observation('317911973777'));
  assert.ok(Array.isArray(verdict.clues) && verdict.clues.length > 0, '隐藏判定必须给出命中线索');
  for (const clue of verdict.clues) {
    assert.equal(typeof clue.clueId, 'string');
    assert.equal(typeof clue.source, 'string');
    assert.ok(Number.isFinite(clue.strength) && clue.strength > 0, '强度必须是正数');
    assert.equal(typeof clue.fragment, 'string');
    assert.ok(clue.fragment.length > 0, `线索 ${clue.clueId} 缺命中片段`);
    assert.ok(clue.fragment.length <= 60, '命中片段要截断，避免把整条评论塞进面板');
  }
  // 判定自身不额外携带「无法解释」的线索：clues 的 clueId 必须是注册过的线索标识
  const known = new Set(listRules()[0].clueIds);
  for (const clue of verdict.clues) assert.ok(known.has(clue.clueId), `未注册的线索 ${clue.clueId}`);
});

test('纯函数：输入被冻结也能判定，重复调用结果一致，且不改写观测', { skip: SKIP }, () => {
  const obs = observation('317911973777');
  const frozen = Object.freeze({ ...obs, authorHistory: null });
  const first = judge(frozen);
  const second = judge(frozen);
  assert.deepEqual(second, first);
  assert.deepEqual(judge(obs), first);
});

test('动作只有 hide / suspect / none 三种', { skip: SKIP }, () => {
  const actions = new Set(['hide', 'suspect', 'none']);
  for (const rpid of ['317911973777', '321599301904', '321605257808']) {
    assert.ok(actions.has(judge(observation(rpid)).action));
  }
});
