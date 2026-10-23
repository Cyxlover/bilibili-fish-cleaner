// 可移植性自检：开源仓库不含 .scratch/comment-cleanup 本地研究数据。
//
// 三个判定函数（hasLabels / hasBlind / hasSnapshots）是「跳过而不是报错」的唯一开关：
// 它们必须在数据缺失时返回 false、在数据齐全时返回 true，否则测试会误跳过或误报错。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DATA_DIR,
  hasBlind,
  hasLabels,
  loadBlind,
  loadLabels,
} from '../tools/lib/dataset.mjs';
import { hasSnapshots } from './support/fixtures.mjs';

const REAL_LABELS = hasLabels(DEFAULT_DATA_DIR);
const REAL_BLIND = hasBlind(DEFAULT_DATA_DIR);
const REAL_SNAPSHOTS = hasSnapshots();

/** 造一个用完即删的临时目录。 */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dshcc-portable-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('临时空目录：三个判定都返回 false，且不抛异常', () => {
  withTempDir((dir) => {
    assert.equal(hasLabels(dir), false, '空目录不该被当成有标注数据');
    assert.equal(hasBlind(dir), false, '空目录不该被当成有盲标数据');
    assert.equal(hasSnapshots(dir), false, '空目录不该被当成有快照');
  });
});

test('labels.jsonl 存在但为空：仍然判定为无数据', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'samples'), { recursive: true });
    writeFileSync(join(dir, 'samples/labels.jsonl'), '');
    assert.equal(hasLabels(dir), false, '空文件不能当样本用');
  });
});

test('文件齐全：三个判定都返回 true', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'samples/_blind'), { recursive: true });
    writeFileSync(join(dir, 'samples/labels.jsonl'), '{}\n');
    writeFileSync(join(dir, 'samples/_blind/blind-input.jsonl'), '{}\n');
    writeFileSync(join(dir, 'samples/_blind/blind-labels.jsonl'), '{}\n');
    writeFileSync(join(dir, 'samples/_blind-mapping.json'), '{}\n');
    for (const name of ['01-initial.comments.html', '02-after-scroll.comments.html', '03-after-expand-replies.comments.html']) {
      writeFileSync(join(dir, name), '<html></html>');
    }
    assert.equal(hasLabels(dir), true);
    assert.equal(hasBlind(dir), true);
    assert.equal(hasSnapshots(dir), true);
    // 只有 labels 没有盲标：两个判定必须独立。
    rmSync(join(dir, 'samples/_blind/blind-labels.jsonl'));
    assert.equal(hasLabels(dir), true, '盲标缺失不影响 labels 判定');
    assert.equal(hasBlind(dir), false, '缺一件盲标不得算齐全');
  });
});

test('缺数据时 loadLabels / loadBlind 仍然抛错（判定函数只负责事前判断）', () => {
  withTempDir((dir) => {
    assert.throws(() => loadLabels(dir), /ENOENT|no such file/i);
    assert.throws(() => loadBlind(dir), /ENOENT|no such file/i);
  });
});

test('仓库内真实标注数据存在时判定为 true', { skip: !(REAL_LABELS && REAL_BLIND) && '缺少本地标注数据' }, () => {
  assert.equal(hasLabels(DEFAULT_DATA_DIR), true);
  assert.equal(hasBlind(DEFAULT_DATA_DIR), true);
});

test('仓库内真实快照存在时判定为 true', { skip: !REAL_SNAPSHOTS && '缺少本地页面快照' }, () => {
  assert.equal(hasSnapshots(), true);
});
