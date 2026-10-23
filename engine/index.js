// 判定引擎的公共入口。引擎只做三件事：
//   1) 归一化观测（缺失资料一律降级为「没有」，不猜不补）
//   2) 把线索命中折成「来源独立的证据份数」（同源不累加）
//   3) 执行规则集的判定 + 引擎级硬约束（hide 来源下限、判定上限/长评豁免）
// 规则本身（门槛、词表、豁免阈值）全在 rules.js / catalog.js / longform.js 里，改规则不动这里。
import { CLUES, HISTORY_CLUES } from './catalog.js';
import { normalizeObservation } from './observation.js';
import { buildProfile } from './profile.js';
import { needsProfile } from './profile-need.js';
import { createProfileCache, createProfileReader } from './profile-reader.js';
import { DEFAULT_RULES_VERSION, RULES, RULE_VERSIONS } from './rules.js';

export const ACTIONS = Object.freeze(['hide', 'suspect', 'none']);

const RANK = { none: 0, suspect: 1, hide: 2 };

/**
 * 判定结果的线索明细：规则引用到的线索在前（used: true），其余观测到的命中线索附在后面（used: false）。
 * 同一条线索既在本条又在同页评论里时只显示一次（按 source 顺序取第一条）。
 * 面板「查看命中原因」只读这一份数据，不需要再回头解析正文。
 */
function detailsFor(profile, clueIds) {
  const used = new Set(clueIds);
  const seen = new Map();
  for (const hit of profile.hits) {
    if (seen.has(hit.clueId)) continue;
    seen.set(hit.clueId, {
      clueId: hit.clueId,
      source: hit.source,
      strength: hit.strength,
      fragment: hit.fragment,
      label: hit.label,
      report: hit.report,
      used: used.has(hit.clueId),
    });
  }
  const all = [...seen.values()];
  return [...all.filter((c) => c.used), ...all.filter((c) => !c.used)];
}

/** 按版本号（'v2b' 或 'v2b@2026.10.23'）取规则集；未知版本直接报错，不静默回落。 */
export function resolveRule(rulesVersion = DEFAULT_RULES_VERSION) {
  const key = Object.keys(RULES).find((k) => RULES[k].version === rulesVersion || k === rulesVersion);
  if (!key) {
    throw new Error(`未知规则版本：${rulesVersion}（可用：${RULE_VERSIONS.join(', ')}）`);
  }
  return RULES[key];
}

/**
 * 判定一条评论。
 * @param {object} observation 观测（见 engine/README.md「观测契约」）
 * @param {{sameAccountOnPage?: Array<{text?: string}>}} [pageContext] 当前页上下文；可缺省
 * @param {{rulesVersion?: string, allowBaseline?: boolean}} [options]
 * @returns {{action: 'hide'|'suspect'|'none', rulesVersion: string, scope: 'thread'|'reply',
 *   clues: Array<{clueId: string, source: string, strength: number, fragment: string}>,
 *   sources: Array<{source: string, strength: number, clueIds: string[], hits: number}>,
 *   independentSources: number, cappedBy: string|null, floorApplied: boolean}}
 */
export function judge(observation, pageContext, options = {}) {
  const rule = resolveRule(options.rulesVersion === undefined ? DEFAULT_RULES_VERSION : options.rulesVersion);
  if (rule.tier === 'baseline' && options.allowBaseline !== true) {
    throw new Error(`规则 ${rule.version} 已被可行性报告否证（tier=baseline），只作回归对照，需显式 allowBaseline: true`);
  }

  const profile = buildProfile(normalizeObservation(observation), pageContext);
  const decided = rule.decide(profile) || { action: 'none', clueIds: [] };
  if (!(decided.action in RANK)) throw new Error(`规则 ${rule.version} 返回了未知动作：${decided.action}`);

  let action = decided.action;
  let floorApplied = false;
  // 引擎级硬约束：hide 必须有 rule.minSources 个独立来源。单一线索（哪怕命中多条同源特征）不够定案。
  if (action === 'hide' && profile.independentSources < rule.minSources) {
    action = 'suspect';
    floorApplied = true;
  }

  let cappedBy = null;
  for (const cap of rule.caps) {
    if (RANK[action] <= RANK[cap.maxAction]) continue;
    if (!cap.when({ profile, observation: profile.observation })) continue;
    action = cap.maxAction;
    cappedBy = cap.id;
  }

  return Object.freeze({
    action,
    rulesVersion: rule.version,
    scope: profile.observation.isReply ? 'reply' : 'thread',
    clues: detailsFor(profile, decided.clueIds || []),
    sources: profile.sources.map((s) => ({
      source: s.source,
      strength: s.strength,
      clueIds: s.clueIds,
      hits: s.hits,
    })),
    independentSources: profile.independentSources,
    cappedBy,
    floorApplied,
  });
}

/** 规则集注册表（面板/设置页用）：版本号、是否可上线、判定上限、可引用的线索标识全集。 */
export function listRules() {
  const clueIds = [...CLUES, ...HISTORY_CLUES].map((c) => c.id);
  return Object.values(RULES).map((r) => ({
    version: r.version,
    id: r.version.split('@')[0],
    tier: r.tier,
    title: r.title,
    minSources: r.minSources,
    caps: r.caps.map((c) => c.id),
    clueIds,
  }));
}

// 资料按需读取：入口一并导出，调用方（扩展、CLI、数据集脚本）不必知道它在哪个文件。
// 注意：bundle 生成器会剥掉这行 `export {}`，所以这里只能写单行、且不能带 from 子句。
export { DEFAULT_RULES_VERSION, RULE_VERSIONS, createProfileCache, createProfileReader, needsProfile };
