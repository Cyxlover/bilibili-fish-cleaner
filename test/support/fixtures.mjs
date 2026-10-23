// 测试夹具：真实页面快照（保存在 .scratch/comment-cleanup/research/dom-snapshot/）。
//
// 快照含真实用户内容，仅本地测试使用，不复制进仓库源码目录。
// 开源仓库不含该数据目录：用 hasSnapshots() 先判断，快照缺失时相关测试跳过
// （这是预期行为，不是失败）。

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHTML } from './mini-dom.mjs';

const REPO_ROOT = new URL('../../', import.meta.url);
const SNAPSHOT_DIR = new URL('.scratch/comment-cleanup/research/dom-snapshot/', REPO_ROOT);

export const SNAPSHOTS = {
  initial: '01-initial.comments.html',
  afterScroll: '02-after-scroll.comments.html',
  afterExpand: '03-after-expand-replies.comments.html',
};

/** 三个真实快照是否都在；缺失时依赖快照的测试跳过。
 *  @param {string} [dir] 快照目录，默认仓库内的 dom-snapshot（测试可传临时目录）。 */
export function hasSnapshots(dir = fileURLToPath(SNAPSHOT_DIR)) {
  return Object.values(SNAPSHOTS).every((name) => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

export function snapshotPath(name) {
  return fileURLToPath(new URL(SNAPSHOTS[name] || name, SNAPSHOT_DIR));
}

export function readSnapshotHTML(name) {
  return readFileSync(snapshotPath(name), 'utf8');
}

export function loadSnapshot(name) {
  return parseHTML(readSnapshotHTML(name));
}
