// 规则集：判定门槛写在这里，引擎代码不动就能换规则。
// 每个规则集是一个数据对象：
//   version   版本号（判定结果里的 rulesVersion，形如 id@YYYY.MM.DD）
//   tier      'candidate'（可上线）/ 'baseline'（已被报告否证，只作回归对照，必须显式放行）
//   minSources 允许判 hide 的最少独立来源数（candidate 一律 ≥ 2：单一线索不足以定案）
//   caps      判定上限（例如长评豁免）：{id, maxAction, when({profile, observation})}
//   decide(profile) → {action, clueIds}
//
// 三个门槛的量级关系是硬要求：hide 比 suspect 严格，suspect 比 none 严格。
import { GROUPS } from './catalog.js';
import { LONG_FORM_CAP } from './longform.js';

const IDENTITY = GROUPS.identity;
const MOTIF = GROUPS.motif;
const STRONG = GROUPS.strongMotif;

const MOTIF_ANY_SOURCE = ['text', 'page'];

/** v0：单线索基线。只要元数据像就隐藏 —— 报告 A.2/B.2 已否证，仅保留作回归对照。 */
const v0 = {
  tier: 'baseline',
  minSources: 1,
  decide(profile) {
    const meta = profile.ids('account', IDENTITY);
    if (meta.length) return { action: 'hide', clueIds: meta };
    const loose = profile.ids('account', GROUPS.looseIdentity);
    if (loose.length) return { action: 'suspect', clueIds: loose };
    return { action: 'none', clueIds: [] };
  },
};

/** v1：身份元数据 ∧ 至少一条文本母题 → hide；其余只有元数据/分享结构/≥2 母题 → suspect。 */
const v1 = {
  tier: 'candidate',
  decide(profile) {
    const meta = profile.ids('account', IDENTITY);
    const motif = profile.ids('text', MOTIF);
    // 分享结构只看本条自己的正文（source=share）。v1 是不带页面上下文的逐条规则，
    // 同页其他评论的分享结构属于 v2 系列的证据，不能让 v1 在拿到 ctx 时悄悄变严。
    const share = profile.ids('share', ['shareStructure']);
    if (meta.length && motif.length) return { action: 'hide', clueIds: [...meta, ...motif] };
    if (share.length && (meta.length || profile.has('atHead'))) {
      return { action: 'suspect', clueIds: [...meta, ...motif, 'shareStructure'] };
    }
    if (meta.length) return { action: 'suspect', clueIds: meta };
    if (motif.length >= 2) return { action: 'suspect', clueIds: motif };
    return { action: 'none', clueIds: [] };
  },
};

/** v1Safe：hide 要求强母题（不含「主人」这种泛用称呼）。 */
const v1Safe = {
  tier: 'candidate',
  decide(profile) {
    const meta = profile.ids('account', IDENTITY);
    const strong = profile.ids('text', STRONG);
    const motif = profile.ids('text', MOTIF);
    if (meta.length && strong.length) return { action: 'hide', clueIds: [...meta, ...strong] };
    if (meta.length && motif.length) return { action: 'suspect', clueIds: [...meta, ...motif] };
    if (motif.length >= 2) return { action: 'suspect', clueIds: motif };
    return { action: 'none', clueIds: [] };
  },
};

/** v2a：身份元数据 ∧（本条或同页同账号任一条）有文本母题 → hide。 */
const v2a = {
  tier: 'candidate',
  decide(profile) {
    const meta = profile.ids('account', IDENTITY);
    const motifAny = profile.ids(MOTIF_ANY_SOURCE, MOTIF);
    const motifThis = profile.ids('text', MOTIF);
    if (meta.length && motifAny.length) return { action: 'hide', clueIds: [...meta, ...motifAny] };
    if (meta.length) return { action: 'suspect', clueIds: meta };
    if (motifThis.length >= 2) return { action: 'suspect', clueIds: motifThis };
    return { action: 'none', clueIds: [] };
  },
};

/** v2b：v2a 基础上，把「本条或同页同账号的分享结构」也算行为证据 → hide。 */
const v2b = {
  tier: 'candidate',
  decide(profile) {
    const meta = profile.ids('account', IDENTITY);
    const motifAny = profile.ids(MOTIF_ANY_SOURCE, MOTIF);
    const motifThis = profile.ids('text', MOTIF);
    const share = profile.ids(['share', 'page'], ['shareStructure']);
    if (meta.length && (motifAny.length || share.length)) {
      return { action: 'hide', clueIds: [...meta, ...motifAny, ...share] };
    }
    if (meta.length) return { action: 'suspect', clueIds: meta };
    if (motifThis.length >= 2) return { action: 'suspect', clueIds: motifThis };
    return { action: 'none', clueIds: [] };
  },
};

/** v2c：v1 为底；身份元数据 ∧（本条或同页）隐含人设语汇 → hide。 */
const v2c = {
  tier: 'candidate',
  decide(profile) {
    const base = v1.decide(profile);
    if (base.action === 'hide') return base;
    const meta = profile.ids('account', IDENTITY);
    const bodyAny = profile.ids(MOTIF_ANY_SOURCE, ['implicitPersona']);
    if (meta.length && bodyAny.length) return { action: 'hide', clueIds: [...base.clueIds, ...meta, ...bodyAny] };
    return base;
  },
};

/**
 * v2b + 长评豁免（报告 F.2 建议的默认隐藏规则）：
 * 正文是完整人类叙事/技术讨论时，即便页面聚合命中，最多判 suspect。
 */
const v2bLongform = {
  tier: 'candidate',
  caps: [LONG_FORM_CAP],
  decide: v2b.decide,
};

const RULESETS = {
  v0: { id: 'v0', revision: '2026.10.23', title: 'v0 单线索（已否证，仅对照）', ...v0 },
  v1: { id: 'v1', revision: '2026.10.23', title: 'v1 多线索', ...v1 },
  v1Safe: { id: 'v1Safe', revision: '2026.10.23', title: 'v1Safe 多线索（强母题）', ...v1Safe },
  v2a: { id: 'v2a', revision: '2026.10.23', title: 'v2a 页面聚合（母题）', ...v2a },
  v2b: { id: 'v2b', revision: '2026.10.23', title: 'v2b 页面聚合（+分享结构）', ...v2b },
  v2c: { id: 'v2c', revision: '2026.10.23', title: 'v2c 页面聚合（+隐含人设词）', ...v2c },
  'v2b-longform': {
    id: 'v2b-longform',
    revision: '2026.10.23',
    title: 'v2b + 长评豁免',
    ...v2bLongform,
  },
};

/** candidate 规则的默认独立来源下限；单一线索（1 个来源）永远不够定案。 */
export const CANDIDATE_MIN_SOURCES = 2;

const FROZEN = Object.fromEntries(
  Object.entries(RULESETS).map(([key, rule]) => [
    key,
    Object.freeze({
      version: `${rule.id}@${rule.revision}`,
      tier: rule.tier,
      title: rule.title,
      caps: Object.freeze(rule.caps || []),
      minSources: rule.minSources ?? (rule.tier === 'baseline' ? 1 : CANDIDATE_MIN_SOURCES),
      decide: rule.decide,
    }),
  ]),
);

export const RULES = FROZEN;
export const RULE_VERSIONS = Object.values(FROZEN).map((r) => r.version);
/** 产品默认规则：报告 F.2 推荐的 v2b，且必须带长评豁免。 */
export const DEFAULT_RULES_VERSION = FROZEN['v2b-longform'].version;
