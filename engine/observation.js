// 观测归一化：引擎只认这一层，缺字段一律降级为「没有这份资料」，不猜、不补。
// 资料缺失（简介为空 / 读取失败）既不加线索也不减线索 —— 见 normalizeBio。
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 简介归一化：三种「没有简介」的形态必须得到完全相同的结果。
 *   undefined / null / ''            → 空
 *   { status: 'failed' }             → 读取失败
 *   { status: 'ok', value: '...' }   → 正常
 * 所有非正常形态都归一成 sign = ''，状态只做诊断，不参与判定。
 */
function normalizeBio(bio) {
  if (typeof bio === 'string') return { sign: bio, status: bio.trim() ? 'ok' : 'empty' };
  if (bio && typeof bio === 'object') {
    if (bio.status === 'ok' && typeof bio.value === 'string') {
      return { sign: bio.value, status: bio.value.trim() ? 'ok' : 'empty' };
    }
    return { sign: '', status: bio.status === 'failed' ? 'failed' : 'missing' };
  }
  return { sign: '', status: 'missing' };
}

function normalizeHistory(history) {
  if (!history || typeof history !== 'object') return null;
  return Object.freeze({
    videoCount: isFiniteNumber(history.videoCount) ? history.videoCount : 0,
    repeatedAtTarget: isFiniteNumber(history.repeatedAtTarget) ? history.repeatedAtTarget : 0,
  });
}

/**
 * 观测 → 归一化观测。纯函数：不读外部状态、不改写入参、不产生时间戳。
 * @param {object} observation 页面可得字段（见 engine/README.md「观测契约」）
 */
export function normalizeObservation(observation) {
  const o = observation && typeof observation === 'object' ? observation : {};
  const bio = normalizeBio(o.bio);
  return Object.freeze({
    commentId: o.commentId == null ? null : String(o.commentId),
    authorMid: o.authorMid == null ? null : String(o.authorMid),
    nickname: typeof o.nickname === 'string' ? o.nickname : '',
    sign: bio.sign,
    // 诊断用：判定不得读取它（测试断言三种缺失形态动作完全一致）
    profileStatus: bio.status,
    text: typeof o.text === 'string' ? o.text : '',
    isReply: !!o.isReply,
    rootCommentId: o.rootCommentId == null ? null : String(o.rootCommentId),
    likeCount: isFiniteNumber(o.likeCount) ? o.likeCount : null,
    publishedAt: isFiniteNumber(o.publishedAt) ? o.publishedAt : null,
    authorHistory: normalizeHistory(o.authorHistory),
  });
}
