// 资料缺口清单：判定需要、但观测里还没有的那几项资料（例如作者简介）。
// 这个文件不碰 DOM、不判定、也不发请求，只说明「还缺什么、为什么值得去取」；
// 真正去读资料的是引擎之外的 profile-reader。
// 隐私边界：只取 data.card.sign 一个字段；缓存只落 {sign, at}，不落昵称、头像、等级、关注关系等。
// 只读：只有 GET，没有任何写操作。
import { normalizeObservation } from './observation.js';
import { buildProfile } from './profile.js';


function bioStatus(bio) {
  return normalizeObservation({ bio }).profileStatus;
}

/**
 * 这条评论是否值得为作者读取简介。
 * 判据是「当前已可得信息里已经命中至少一条线索」，而不是预先假定谁是机器人：
 * 没有任何线索的评论不产生请求，也就不会无谓地暴露浏览行为。
 *
 * @param {object} observation 页面可得观测（bio 可为空/失败）
 * @param {object} [pageContext] 当前页上下文，参与线索判定
 * @returns {{needed: boolean, clueIds: string[]}}
 */
export function needsProfile(observation, pageContext) {
  const o = observation && typeof observation === 'object' ? observation : {};
  if (o.authorMid == null || String(o.authorMid).trim() === '') {
    return { needed: false, clueIds: [] };
  }
  // 简介已在手上（读取成功且非空）时不再请求；失败/空简介不算「已有」。
  if (bioStatus(o.bio) === 'ok') {
    return { needed: false, clueIds: [] };
  }

  // 用「没有简介」的观测判一次：简介本身不参与「要不要读简介」的决定。
  const profile = buildProfile(normalizeObservation({ ...o, bio: null }), pageContext);
  const clueIds = [...new Set(profile.hits.map((hit) => hit.clueId))];
  return { needed: clueIds.length > 0, clueIds };
}
