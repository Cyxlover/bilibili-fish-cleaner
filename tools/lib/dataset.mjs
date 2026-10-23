// 回归夹具加载：只读仓库里已有的真实标注样本，不生成、不编造任何样本。
// 数据目录默认是 .scratch/comment-cleanup（可用 --data 覆盖）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DATA_DIR = path.resolve(import.meta.dirname, '../../.scratch/comment-cleanup');

/** 文件存在且非空：开源仓库不带本地研究数据，调用方据此跳过而不是报错。 */
function isNonEmptyFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** 本地标注样本是否可用（samples/labels.jsonl 存在且非空）。 */
export function hasLabels(dataDir = DEFAULT_DATA_DIR) {
  return isNonEmptyFile(path.join(dataDir, 'samples/labels.jsonl'));
}

/** 盲标三件套是否齐全：输入、标注、映射。 */
export function hasBlind(dataDir = DEFAULT_DATA_DIR) {
  return [
    'samples/_blind/blind-input.jsonl',
    'samples/_blind/blind-labels.jsonl',
    'samples/_blind-mapping.json',
  ].every((file) => isNonEmptyFile(path.join(dataDir, file)));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function loadLabels(dataDir = DEFAULT_DATA_DIR) {
  return readJsonl(path.join(dataDir, 'samples/labels.jsonl'));
}

/** 盲标样本：输入（标注者看到的字段）+ 判定（verdict/confidence/reason）+ 映射（blindId → rpid/层）。 */
export function loadBlind(dataDir = DEFAULT_DATA_DIR) {
  const input = readJsonl(path.join(dataDir, 'samples/_blind/blind-input.jsonl'));
  const labels = readJsonl(path.join(dataDir, 'samples/_blind/blind-labels.jsonl'));
  const mapping = JSON.parse(fs.readFileSync(path.join(dataDir, 'samples/_blind-mapping.json'), 'utf8'));
  return { input, labels, mapping, strataSizes: mapping.strataSizes, sampled: mapping.sampled };
}

/** 把 labels.jsonl 的一行映射成引擎观测（运行时页面可得字段）。 */
export function observationOf(row) {
  return {
    commentId: row.rpid,
    authorMid: row.mid,
    nickname: row.uname,
    bio: row.sign,
    text: row.text,
    isReply: !!row.isSub,
    rootCommentId: row.parent ?? null,
    likeCount: null,
    publishedAt: row.ctime ?? null,
    // 本机历史摘要：标注数据里没有运行时历史，回归中一律不提供（提供与否不影响任何候选规则的动作）
    authorHistory: null,
  };
}

/** 同一视频（bvid）下同一账号（mid）的评论构成一个「页面」。 */
export const pageKey = (row) => row.mid + '|' + row.bvid;

export function buildPages(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(pageKey(r))) m.set(pageKey(r), []);
    m.get(pageKey(r)).push(r);
  }
  return m;
}

/** 当前页上下文：同账号在本页的其他评论（不含本条）。 */
export function pageContextOf(pages, row, selfRpid = row.rpid) {
  const peers = pages.get(pageKey(row)) || [];
  return { sameAccountOnPage: peers.filter((p) => p.rpid !== selfRpid) };
}

export function splitByDataset(rows) {
  return {
    design: rows.filter((r) => r.dataset === 'design'),
    validation: rows.filter((r) => r.dataset === 'validation'),
  };
}

export const rowByRpid = (rows, rpid) => rows.find((r) => r.rpid === String(rpid));
