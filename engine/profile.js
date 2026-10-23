// 线索命中 → 证据剖面：把「命中的线索条数」折成「来源独立的证据份数」。
// 这是引擎对规则集的硬约束之一：同一人设模板在昵称/简介里反复留下的表面特征，
// 都只是同一个来源（account）的一份证据，不能按命中条数累加。
import { CLUES, HISTORY_CLUES, surfaceOf, trimFragment } from './catalog.js';
import { normalizeObservation } from './observation.js';

/** 证据来源的规范顺序（面板展示顺序也按它）。 */
export const SOURCES = ['account', 'text', 'share', 'structure', 'page', 'history'];

/** 同账号在本页其他评论里只用正文类线索：身份线索属于账号，本条已经记过一次。 */
const PEER_CLUES = CLUES.filter((c) => (c.source === 'text' || c.source === 'share') && c.evidence);

function pushHit(hits, clue, source, fragment) {
  if (!fragment) return;
  hits.push({
    clueId: clue.id,
    source,
    strength: clue.strength,
    evidence: clue.evidence,
    report: clue.report,
    label: clue.label,
    fragment: trimFragment(fragment),
  });
}

/**
 * 构造证据剖面。
 * @param {object} observation 归一化观测（engine/observation.js）
 * @param {{sameAccountOnPage?: Array<{text?: string}>}} [pageContext] 当前页上下文；可缺省
 */
export function buildProfile(observation, pageContext) {
  const surface = surfaceOf(observation);
  const hits = [];

  for (const clue of CLUES) {
    pushHit(hits, clue, clue.source, clue.detect({ nickname: observation.nickname, sign: observation.sign, surface }));
  }

  const peers = Array.isArray(pageContext && pageContext.sameAccountOnPage) ? pageContext.sameAccountOnPage : [];
  for (const peer of peers) {
    // 同账号的昵称/简介与本条相同，已在 account 里计过一次；这里只看这一条评论自己的正文
    const peerObs = normalizeObservation({ text: peer && peer.text });
    const peerSurface = surfaceOf(peerObs);
    for (const clue of PEER_CLUES) {
      pushHit(hits, clue, 'page', clue.detect({ nickname: '', sign: '', surface: peerSurface }));
    }
  }

  const history = observation.authorHistory;
  if (history) {
    for (const clue of HISTORY_CLUES) {
      pushHit(hits, clue, 'history', clue.detect(history));
    }
  }

  const bySource = new Map();
  for (const hit of hits) {
    if (!hit.evidence) continue;
    if (!bySource.has(hit.source)) bySource.set(hit.source, []);
    bySource.get(hit.source).push(hit);
  }
  const sources = SOURCES.filter((s) => bySource.has(s)).map((source) => {
    const list = bySource.get(source);
    return {
      source,
      strength: Math.max(...list.map((h) => h.strength)),
      clueIds: [...new Set(list.map((h) => h.clueId))],
      // 同源内命中了几条特征：只是展示用，强度不按条数累加
      hits: list.length,
    };
  });

  const clueIds = new Set(hits.map((h) => h.clueId));
  const ordered = (list) => list.filter((id) => clueIds.has(id));

  return {
    observation,
    hits,
    sources,
    independentSources: sources.length,

    has: (clueId) => clueIds.has(clueId),
    /** 按分组顺序取「落在指定来源里的线索标识」。sources 可以是单个来源或来源数组。 */
    ids(sources, group) {
      const allow = Array.isArray(sources) ? sources : [sources];
      const inSource = new Set(hits.filter((h) => allow.includes(h.source)).map((h) => h.clueId));
      return ordered(group).filter((id) => inSource.has(id));
    },
  };
}
