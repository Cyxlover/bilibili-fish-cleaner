// 资料按需读取的「该不该读」策略：没有任何疑似线索的评论，不为其作者产生请求。
// 这里只测纯策略；真实的请求、缓存、节流在 test/profile-reader.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';

import { needsProfile } from '../../engine/profile-need.js';
import { judge } from '../../engine/index.js';
import { hasLabels, loadLabels, observationOf, rowByRpid } from '../../tools/lib/dataset.mjs';

// 标注数据是可选的本地研究数据：缺失时整文件跳过（开源仓库的正常状态），有数据时照旧全跑。
const DATA = hasLabels();
const SKIP = !DATA && '缺少本地标注数据';
const labels = DATA ? loadLabels() : [];
const withoutBio = (row) => ({ ...observationOf(row), bio: null });

test('无任何线索的真人评论：不需要读取简介', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321605257808'); // 昵称/正文/简介都无人设线索
  const need = needsProfile(withoutBio(row));
  assert.equal(need.needed, false);
  assert.deepEqual(need.clueIds, []);
  assert.equal(judge(withoutBio(row)).clues.length, 0, '前提：这条评论确实没有任何线索命中');
});

test('昵称或正文已出现线索：需要读取该评论作者的简介', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321603001488'); // 昵称大肥鱼 + @提及
  const need = needsProfile(withoutBio(row));
  assert.equal(need.needed, true);
  assert.ok(need.clueIds.length > 0, '应带上触发的线索标识，供请求侧记录与去重');
  assert.ok(need.clueIds.includes('nickFish'));
});

test('已有可用简介或没有作者 mid：不重复读取', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321603001488');
  assert.equal(needsProfile({ ...withoutBio(row), bio: '大肥鱼本人，程序员' }).needed, false, '简介已就绪时不该再发请求');
  assert.equal(needsProfile({ ...withoutBio(row), bio: '' }).needed, true, '空简介不算已就绪');
  assert.equal(needsProfile({ ...withoutBio(row), authorMid: null }).needed, false, '没有 mid 时无从读取');
});

test('简介读取失败：策略上仍可再读（是否重复由请求侧的会话去重决定）', { skip: SKIP }, () => {
  const row = rowByRpid(labels, '321603001488');
  const need = needsProfile({ ...withoutBio(row), bio: { status: 'failed' } });
  assert.equal(need.needed, true);
});
