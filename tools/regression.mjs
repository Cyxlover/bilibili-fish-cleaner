#!/usr/bin/env node
// 判定引擎回归：一条命令在真实标注样本上复现可行性报告的两个口径。
//
//   A. design 自洽性（对 labels.jsonl）—— 只能证明「规则忠实实现了标注口径」，
//      不能证明识别能力：标签与规则用的是同一批字段的同一批正则（报告 A.4）。
//   B. validation 独立盲标（400 条分层抽样，按层加权到 N=3931）—— 报告 B 段口径。
//   C. 分层原始混淆矩阵（未加权计数，行=动作，列=盲标判定）。
//   D. 长评豁免标定：v2b → v2b-longform 改变了哪些行（design 标定 + validation 一次性复核）。
//   E. 如实披露：盲标非 bot 却被自动隐藏的行（含 3 条已知误隐藏样本）。
//   F. 自检：把报告里已发布的数字钉死，漂移时退出码 1。
//
// 用法：
//   node tools/regression.mjs                  # 完整输出 + 自检
//   node tools/regression.mjs --data <dir>     # 指定数据目录（默认 .scratch/comment-cleanup）
//   node tools/regression.mjs --all            # 打印全部规则的分层混淆矩阵
//   node tools/regression.mjs --no-check       # 跳过自检（仅人工探查）
//
// 纪律：validation 只做一次性评估。本脚本只读样本、只复算，不允许据此调参；
// 任何口径改动都必须回到 design 集上重新标定，并在报告里写明。
//
// 统计口径与 .scratch/comment-cleanup/validation/evaluate.mjs 保持一致（同权重、同
// 自助法种子 20261023、同 Clopper-Pearson 上界算法），因此数字可直接对照报告 B 段。
import path from 'node:path';

import { DEFAULT_RULES_VERSION, judge, listRules } from '../engine/index.js';
import { measureLongForm } from '../engine/longform.js';
import {
  DEFAULT_DATA_DIR,
  buildPages,
  loadBlind,
  hasBlind,
  hasLabels,
  loadLabels,
  observationOf,
  pageContextOf,
  splitByDataset,
} from './lib/dataset.mjs';

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const opts = { dataDir: null, all: false, check: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') {
      opts.dataDir = argv[++i];
      if (!opts.dataDir) throw new Error('--data 需要一个目录参数');
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--no-check') {
      opts.check = false;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return opts;
}

const USAGE = `用法：node tools/regression.mjs [--data <dir>] [--all] [--no-check]

  --data <dir>   标注数据目录（默认 .scratch/comment-cleanup）
  --all          打印全部规则的分层混淆矩阵（默认只打印流水线、v1 与默认规则）
  --no-check     跳过与可行性报告的数字自检（仅人工探查用）
  -h, --help     显示本帮助`;

// ---------------------------------------------------------------- 文本对齐
// 中文按两列宽计算，否则表格在终端里会歪。
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/g;
const width = (s) => String(s).replace(WIDE, '  ').length;
// 列间至少留一个空格：否则变长单元格会与下一列粘在一起（'380' + '45.6%'）。
const padE = (s, n) => String(s) + ' '.repeat(Math.max(1, n - width(s)));
const padS = (s, n) => ' '.repeat(Math.max(1, n - width(s))) + String(s);

const pct = (x) => (100 * x).toFixed(1) + '%';
const div = (a, b) => (b ? a / b : 0);

// ---------------------------------------------------------------- 统计工具
// 与 validation/evaluate.mjs 同实现：分层自助法只重抽每层样本、权重不变；
// 这样 400 条抽样误差被还原成 validation 总体的条数，而不是 400 条里的条数。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(items) {
  const out = {
    hide: 0,
    suspect: 0,
    none: 0,
    bot: 0,
    human: 0,
    unsure: 0,
    hideBot: 0,
    hideHuman: 0,
    hideUnsure: 0,
    suspBot: 0,
    suspHuman: 0,
  };
  for (const it of items) {
    out.bot += it.w * (it.verdict === 'bot');
    out.human += it.w * (it.verdict === 'human');
    out.unsure += it.w * (it.verdict === 'unsure');
    out[it.action] += it.w;
    if (it.action === 'hide') {
      out.hideBot += it.w * (it.verdict === 'bot');
      out.hideHuman += it.w * (it.verdict === 'human');
      out.hideUnsure += it.w * (it.verdict === 'unsure');
    }
    if (it.action === 'suspect') {
      out.suspBot += it.w * (it.verdict === 'bot');
      out.suspHuman += it.w * (it.verdict === 'human');
    }
  }
  return out;
}

function pointStats(items) {
  const a = weighted(items);
  return {
    ...a,
    recall: div(a.hideBot, a.bot),
    precision: div(a.hideBot, a.hide),
    falseHide: a.hideHuman,
    suspectBotCovered: div(a.hideBot + a.suspBot, a.bot),
  };
}

function bootStats(items, B = 10000, seed = 20261023) {
  const rand = mulberry32(seed);
  const strata = new Map();
  for (const it of items) {
    if (!strata.has(it.stratum)) strata.set(it.stratum, []);
    strata.get(it.stratum).push(it);
  }
  const need = ['recall', 'falseHide', 'hideBot', 'precision'];
  const acc = Object.fromEntries(need.map((k) => [k, []]));
  const groups = [...strata.values()];
  for (let it = 0; it < B; it++) {
    const sample = [];
    for (const g of groups) for (let i = 0; i < g.length; i++) sample.push(g[Math.floor(rand() * g.length)]);
    const p = pointStats(sample);
    for (const k of need) acc[k].push(p[k]);
  }
  const q = (arr, p) => {
    const s = arr.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const ci = (k) => [q(acc[k], 0.025), q(acc[k], 0.975)];
  const pHalf = acc.recall.filter((x) => x < 0.5).length / B;
  return { recallCI: ci('recall'), falseHideCI: ci('falseHide'), hideBotCI: ci('hideBot'), precisionCI: ci('precision'), pHalf };
}

// 二项分布尾概率（Clopper-Pearson 上界用）
function betaBinomCdf(k, n, p) {
  if (p <= 0) return k >= 0 ? 1 : 0;
  if (p >= 1) return k >= n ? 1 : 0;
  const lgamma = (z) => {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let x = z;
    let y = z;
    let t = x + 5.5;
    t -= (x + 0.5) * Math.log(t);
    let s = 1.000000000190015;
    for (let j = 0; j < 6; j++) s += g[j] / ++y;
    return -t + Math.log((2.5066282746310005 * s) / x);
  };
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}

// 观测到 k/n 例时，真实率的 95% 单侧上界
function cpUpper(k, n, alpha = 0.05) {
  if (n === 0) return 1;
  if (k >= n) return 1;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaBinomCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// 隐藏集里未观测到盲标 human 时，误隐藏总数的单侧上界 ≈ 隐藏总数 × 上界率
function falseHideUpper(sampledHide, sampledHideHuman, hideTotal) {
  return hideTotal * cpUpper(sampledHideHuman, sampledHide);
}

// ---------------------------------------------------------------- 数据
const pageKey = (row) => row.mid + '|' + row.bvid;

function loadDataset(dataDir) {
  const labels = loadLabels(dataDir);
  const blind = loadBlind(dataDir);
  const { design, validation } = splitByDataset(labels);
  return { labels, blind, design, validation };
}

/** design / validation 的自洽性口径：把一行的规则动作与 labels 的标签对照。 */
function selfConsistency(version, rows, pages) {
  let hideBot = 0;
  let hideHuman = 0;
  let hideUnsure = 0;
  let suspectBot = 0;
  let suspectHuman = 0;
  let totalBot = 0;
  let totalHuman = 0;
  for (const row of rows) {
    const verdict = judge(observationOf(row), pageContextOf(pages, row), { rulesVersion: version, allowBaseline: true });
    if (row.label === 'bot') totalBot++;
    if (row.label === 'human') totalHuman++;
    if (verdict.action === 'hide') {
      if (row.label === 'bot') hideBot++;
      else if (row.label === 'human') hideHuman++;
      else hideUnsure++;
    }
    if (verdict.action === 'suspect' && row.label === 'bot') suspectBot++;
    if (verdict.action === 'suspect' && row.label === 'human') suspectHuman++;
  }
  return {
    hide: hideBot + hideHuman + hideUnsure,
    hideBot,
    hideHuman,
    hideUnsure,
    precision: div(hideBot, hideBot + hideHuman + hideUnsure),
    recall: div(hideBot, totalBot),
    humanHidden: hideHuman,
    humanSuspect: suspectHuman,
    suspectBot,
    suspectCoverage: div(suspectBot, totalBot),
    totalBot,
    totalHuman,
  };
}

/**
 * 盲标条目：观测只用 blind-input 里的裸字段（正文/昵称/简介/是否回复），
 * 页面上下文按 _blind-mapping.json 映射回 validation 的真实 rpid 取同账号同视频的其他评论。
 * 盲标输入不含规则字段，因此这是一次独立测量；本机历史在标注数据里没有，一律不提供。
 */
function buildBlindItems(blind, validationPages, labelByRpid) {
  const mapById = new Map(blind.mapping.mapping.map((m) => [m.blindId, m]));
  const verdictById = new Map(blind.labels.map((r) => [r.blindId, r.verdict]));
  const S = blind.strataSizes;
  const W = Object.fromEntries(Object.entries(S).map(([k, n]) => [k, n / blind.sampled[k]]));
  const items = blind.input.map((row) => {
    const mapping = mapById.get(row.blindId);
    const labelRow = mapping ? labelByRpid.get(mapping.rpid) : null;
    const observation = {
      commentId: mapping ? mapping.rpid : null,
      authorMid: mapping ? mapping.mid : null,
      nickname: row.uname,
      bio: row.sign,
      text: row.text,
      isReply: !!row.isReply,
      rootCommentId: null,
      likeCount: null,
      publishedAt: null,
      authorHistory: null,
    };
    const context = labelRow
      ? { sameAccountOnPage: (validationPages.get(pageKey(labelRow)) || []).filter((p) => p.rpid !== labelRow.rpid) }
      : { sameAccountOnPage: [] };
    return {
      blindId: row.blindId,
      rpid: mapping ? mapping.rpid : null,
      stratum: mapping ? mapping.ruleLabel : null,
      w: mapping ? W[mapping.ruleLabel] : 0,
      verdict: verdictById.get(row.blindId) || null,
      label: labelRow ? labelRow.label : null,
      text: row.text,
      observation,
      context,
    };
  });
  return { items, S, sampled: blind.sampled, N: Object.values(S).reduce((a, b) => a + b, 0) };
}

/** 默认规则相对 v2b 改变了哪些行（长评豁免的标定记录）。 */
function capDiff(rows, pages, v2bVersion, defaultVersion) {
  const changed = [];
  for (const row of rows) {
    const context = pageContextOf(pages, row);
    const before = judge(observationOf(row), context, { rulesVersion: v2bVersion, allowBaseline: true });
    const after = judge(observationOf(row), context, { rulesVersion: defaultVersion, allowBaseline: true });
    if (before.action === after.action) continue;
    changed.push({
      rpid: row.rpid,
      label: row.label,
      from: before.action,
      to: after.action,
      cappedBy: after.cappedBy,
      measure: measureLongForm(row.text),
      independentSources: before.independentSources,
    });
  }
  return changed;
}

// ---------------------------------------------------------------- 输出
const SECTION = '='.repeat(100);

function printSelfConsistency(title, rows, pages, rules, defaultId) {
  console.log(`\n[${title}]`);
  console.log('  ' + padE('规则', 26) + padS('隐藏数', 7) + padS('精确率', 8) + padS('召回', 8) + padS('真人被隐藏', 11) + padS('机器人落入疑似', 13));
  for (const rule of rules) {
    const m = selfConsistency(rule.version, rows, pages);
    const mark = rule.id === defaultId ? ' ← 默认' : '';
    console.log(
      '  ' +
        padE(rule.version, 26) +
        padS(String(m.hide), 7) +
        padS(pct(m.precision), 8) +
        padS(pct(m.recall), 8) +
        padS(String(m.humanHidden), 11) +
        padS(pct(m.suspectCoverage), 13) +
        mark,
    );
  }
}

function printBlindTable(statsByKey) {
  console.log('  ' + padE('规则', 34) + padS('隐藏', 7) + padS('召回[95%CI]', 19) + padS('P(召回<50%)', 13) + padS('精确率', 8) + padS('误隐藏[95%CI]', 17) + padS('误隐藏上界', 11) + padS('疑似覆盖', 10));
  for (const [key, stats] of statsByKey) {
    const { title, point: p, boot: b, upper } = stats;
    console.log(
      '  ' +
        padE(title, 34) +
        padS(String(Math.round(p.hide)), 7) +
        padS(`${pct(p.recall)} [${pct(b.recallCI[0])}–${pct(b.recallCI[1])}]`, 19) +
        padS(pct(b.pHalf), 13) +
        padS(pct(p.precision), 8) +
        padS(`${p.falseHide.toFixed(1)} [${b.falseHideCI[0].toFixed(1)}–${b.falseHideCI[1].toFixed(1)}]`, 17) +
        padS(upper.toFixed(1), 11) +
        padS(pct(p.suspectBotCovered), 10) +
        (key === 'pipeline' ? '  （已发布流水线，对照基线）' : ''),
    );
  }
}

function printMatrix(title, items, strata) {
  console.log(`\n[${title}]`);
  console.log('  ' + padE('层', 8) + padE('动作', 9) + padS('盲标 bot', 9) + padS('盲标 human', 11) + padS('盲标 unsure', 12));
  for (const stratum of Object.keys(strata)) {
    for (const action of ['hide', 'suspect', 'none']) {
      const rows = items.filter((i) => i.stratum === stratum && i.action === action);
      if (!rows.length) continue;
      const c = { bot: 0, human: 0, unsure: 0 };
      for (const r of rows) c[r.verdict] = (c[r.verdict] || 0) + 1;
      console.log('  ' + padE(stratum, 8) + padE(action, 9) + padS(String(c.bot), 9) + padS(String(c.human), 11) + padS(String(c.unsure), 12));
    }
  }
}

// ---------------------------------------------------------------- 主流程
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;
  // 标注与研究数据是可选的本地资产：开源仓库默认没有它。缺数据时没有可回归的样本，
  // 按「跳过」处理（退出码 0），否则干净的仓库永远红。
  if (!hasLabels(dataDir) || !hasBlind(dataDir)) {
    console.log(`\n  跳过规则回归：${dataDir} 下没有标注数据（labels.jsonl / blind）。`);
    console.log('  这是开源仓库的正常状态；要从样本复算可行性报告的数字，请把研究数据放回该目录或加 --data <dir>。');
    return 0;
  }
  const { labels, blind, design, validation } = loadDataset(dataDir);
  const rules = listRules();
  const defaultId = rules.find((r) => r.version === DEFAULT_RULES_VERSION)?.id;
  if (!defaultId) throw new Error(`默认规则版本 ${DEFAULT_RULES_VERSION} 不在规则集里`);
  const versionOf = (id) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error(`规则集里没有 ${id}`);
    return rule.version;
  };
  const v2bVersion = versionOf('v2b');
  const defaultVersion = versionOf(defaultId);

  const designPages = buildPages(design);
  const validationPages = buildPages(validation);
  const labelByRpid = new Map(labels.map((r) => [r.rpid, r]));

  const blindSet = buildBlindItems(blind, validationPages, labelByRpid);
  const blindItems = blindSet.items;

  console.log(SECTION);
  console.log('大肥鱼清除计划 · 判定引擎回归（ticket-02）');
  console.log(`数据目录：${dataDir}`);
  console.log(`design ${design.length} 行（bot ${design.filter((r) => r.label === 'bot').length} / human ${design.filter((r) => r.label === 'human').length} / unsure ${design.filter((r) => r.label === 'unsure').length}）`);
  console.log(`validation ${validation.length} 行（bot ${validation.filter((r) => r.label === 'bot').length} / human ${validation.filter((r) => r.label === 'human').length} / unsure ${validation.filter((r) => r.label === 'unsure').length}）`);
  console.log(`盲标 ${blindItems.length} 条（抽样 bot ${blindSet.sampled.bot} / human ${blindSet.sampled.human} / unsure ${blindSet.sampled.unsure}；层规模 N=${blindSet.N}）`);
  console.log(SECTION);

  // ------------------------------------------------------------ A
  console.log('\n' + SECTION);
  console.log('A. 自洽性口径（对 labels.jsonl —— 标签与规则同源，只能证明「规则忠实实现标注口径」，不能证明识别能力）');
  console.log(SECTION);
  printSelfConsistency('design（标定集）', design, designPages, rules, defaultId);
  printSelfConsistency('validation（一次性评估，禁止据此调参）', validation, validationPages, rules, defaultId);

  // ------------------------------------------------------------ B
  console.log('\n' + SECTION);
  console.log('B. 独立盲标口径（400 条分层抽样，按层加权到 validation 总体 N=' + blindSet.N + '）');
  console.log('   加权公式：X = Σ_层 N_层 × (该层盲标样本中满足条件的比例)');
  console.log('   层规模：' + Object.entries(blindSet.S).map(([k, v]) => `${k}=${v}`).join(' / ') + '；抽样量：' + Object.entries(blindSet.sampled).map(([k, v]) => `${k}=${v}`).join(' / '));
  console.log('   误隐藏 = 盲标判 human 却被自动隐藏的加权条数；上界 = 隐藏总数 × Clopper-Pearson 单侧 95% 上界率');
  console.log(SECTION);

  const deciders = [
    {
      key: 'pipeline',
      title: '已发布标注流水线(labels)',
      decide: (_item, stratum) => (stratum === 'bot' ? 'hide' : stratum === 'unsure' ? 'suspect' : 'none'),
    },
    ...rules.map((rule) => ({
      key: rule.id,
      title: `${rule.version}${rule.id === defaultId ? ' ← 默认' : ''}`,
      decide: (item) => judge(item.observation, item.context, { rulesVersion: rule.version, allowBaseline: true }).action,
    })),
  ];

  const blindStats = new Map();
  const blindItemsByKey = new Map();
  for (const decider of deciders) {
    const items = blindItems.map((item) => ({ ...item, action: decider.decide(item, item.stratum) }));
    const point = pointStats(items);
    const boot = bootStats(items);
    const hideItems = items.filter((i) => i.action === 'hide');
    const upper = falseHideUpper(hideItems.length, hideItems.filter((i) => i.verdict === 'human').length, point.hide);
    blindStats.set(decider.key, { title: decider.title, point, boot, upper });
    blindItemsByKey.set(decider.key, items);
  }
  printBlindTable(blindStats);

  // ------------------------------------------------------------ C
  console.log('\n' + SECTION);
  console.log('C. 分层原始混淆矩阵（未加权计数，行=动作，列=盲标判定）');
  console.log(SECTION);
  const matrixKeys = opts.all ? deciders.map((d) => d.key) : ['pipeline', 'v1', defaultId].filter((k, i, arr) => arr.indexOf(k) === i);
  for (const key of matrixKeys) {
    printMatrix(blindStats.get(key).title, blindItemsByKey.get(key), blindSet.S);
  }

  // ------------------------------------------------------------ D
  console.log('\n' + SECTION);
  console.log('D. 长评豁免标定（v2b → v2b-longform；design 用于标定，validation 只做一次性复核）');
  console.log(SECTION);
  const capDesign = capDiff(design, designPages, v2bVersion, defaultVersion);
  const capValidation = capDiff(validation, validationPages, v2bVersion, defaultVersion);
  for (const [name, rows, pages, changed] of [
    ['design', design, designPages, capDesign],
    ['validation', validation, validationPages, capValidation],
  ]) {
    const humanV2b = rows.filter((r) => r.label === 'human' && judge(observationOf(r), pageContextOf(pages, r), { rulesVersion: v2bVersion, allowBaseline: true }).action === 'hide').length;
    const humanDefault = rows.filter((r) => r.label === 'human' && judge(observationOf(r), pageContextOf(pages, r), { rulesVersion: defaultVersion, allowBaseline: true }).action === 'hide').length;
    console.log(`\n[${name}] ${rows.length} 行：豁免改变 ${changed.length} 行；human 行被隐藏 v2b=${humanV2b} / 默认=${humanDefault}`);
    for (const c of changed) {
      console.log(`  ${c.label.padEnd(7)} ${c.rpid}  ${c.from} → ${c.to}  cappedBy=${c.cappedBy}  measure=${JSON.stringify(c.measure)}  src=${c.independentSources}`);
    }
  }

  // ------------------------------------------------------------ E
  console.log('\n' + SECTION);
  console.log('E. 如实披露：盲标判非 bot 却被自动隐藏的行（默认规则）');
  console.log(SECTION);
  const defaultItems = blindItemsByKey.get(defaultId);
  const disagreements = defaultItems.filter((i) => i.action === 'hide' && i.verdict !== 'bot');
  const measuredFalseHide = blindStats.get(defaultId).point.falseHide;
  console.log(`  抽样 ${blindItems.length} 条里有 ${disagreements.length} 条：`);
  for (const item of disagreements) {
    console.log(`  ${item.blindId} ${item.rpid}  层=${item.stratum}  labels=${item.label}  盲标=${item.verdict}  权重=${item.w.toFixed(2)}  正文「${item.text.slice(0, 38)}${item.text.length > 38 ? '…' : ''}」`);
  }
  console.log(`  其中盲标判 human 的加权条数（误隐藏）= ${measuredFalseHide.toFixed(1)}，95% 上界 ≈ ${blindStats.get(defaultId).upper.toFixed(1)} 条。`);
  console.log('  自洽口径下（labels=human）被隐藏的行数：design=0、validation=0 —— 这 8.3 条全部是 label=unsure、盲标却判 human 的行。');
  console.log('  上述条目属于 validation 集，只用于一次性评估；不得据此调整规则或口径。');

  // ------------------------------------------------------------ F
  console.log('\n' + SECTION);
  console.log('F. 与可行性报告的数字自检（报告 B 段 / A.2 / E.1 / F.2）');
  console.log(SECTION);

  const checks = [];
  const asPct = (ratio) => 100 * ratio;
  const checkEq = (name, actual, expected) => checks.push({ name, pass: actual === expected, detail: `${actual}（期望 ${expected}）` });
  const checkPct = (name, ratio, expected, tol = 0.051) => {
    const actual = asPct(ratio);
    checks.push({ name, pass: Math.abs(actual - expected) <= tol, detail: `${actual.toFixed(2)}%（期望 ${expected}%）` });
  };
  const checkNum = (name, actual, expected, tol = 0.051) => checks.push({ name, pass: Math.abs(actual - expected) <= tol, detail: `${actual.toFixed(2)}（期望 ${expected}）` });
  const checkJson = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    checks.push({ name, pass: a === e, detail: a === e ? '一致' : `实际 ${a}\n      期望 ${e}` });
  };
  const ruleMetric = (set, id) => selfConsistency(versionOf(id), set, set === design ? designPages : validationPages);
  const blindMetric = (key) => blindStats.get(key);

  checkEq('design 行数', design.length, 3577);
  checkEq('design bot 数', design.filter((r) => r.label === 'bot').length, 296);
  checkEq('validation 行数', validation.length, 3931);

  for (const [id, expected] of [
    ['v0', { hide: 579, precision: 48.5, recall: 94.9, humanHidden: 1 }],
    ['v1', { hide: 181, precision: 87.3, recall: 53.4, humanHidden: 0 }],
    ['v1Safe', { hide: 122, precision: 86.1, recall: 35.5, humanHidden: 0 }],
    ['v2a', { hide: 260, recall: 77.0 }],
    ['v2b', { hide: 289, recall: 80.4, humanHidden: 0 }],
    ['v2c', { hide: 250, recall: 63.9 }],
  ]) {
    const m = ruleMetric(design, id);
    checkEq(`A design ${id} 隐藏数`, m.hide, expected.hide);
    if (expected.precision !== undefined) checkPct(`A design ${id} 精确率`, m.precision, expected.precision);
    checkPct(`A design ${id} 召回`, m.recall, expected.recall);
    if (expected.humanHidden !== undefined) checkEq(`A design ${id} 真人被隐藏`, m.humanHidden, expected.humanHidden);
  }
  for (const [id, expected] of [
    ['v0', { hide: 647, precision: 52.6, recall: 89.5, humanHidden: 2 }],
    ['v1', { hide: 202, precision: 83.2, recall: 44.2, humanHidden: 0 }],
    ['v1Safe', { hide: 141, precision: 83.0, recall: 30.8, humanHidden: 0 }],
    ['v2a', { hide: 349, recall: 74.7 }],
    ['v2b', { hide: 384, recall: 79.2, humanHidden: 0 }],
    ['v2c', { hide: 318, recall: 68.2 }],
  ]) {
    const m = ruleMetric(validation, id);
    checkEq(`A validation ${id} 隐藏数`, m.hide, expected.hide);
    if (expected.precision !== undefined) checkPct(`A validation ${id} 精确率`, m.precision, expected.precision);
    checkPct(`A validation ${id} 召回`, m.recall, expected.recall);
    if (expected.humanHidden !== undefined) checkEq(`A validation ${id} 真人被隐藏`, m.humanHidden, expected.humanHidden);
  }

  const b = blindMetric('pipeline');
  checkEq('B 流水线 加权隐藏数', Math.round(b.point.hide), 380);
  checkPct('B 流水线 召回', b.point.recall, 45.6);
  checkPct('B 流水线 召回 CI 下界', b.boot.recallCI[0], 40.2);
  checkPct('B 流水线 召回 CI 上界', b.boot.recallCI[1], 51.7);
  checkPct('B 流水线 P(召回<50%)', b.boot.pHalf, 92.0);
  checkPct('B 流水线 精确率', b.point.precision, 98.7);
  checkNum('B 流水线 误隐藏', b.point.falseHide, 0.0);
  checkNum('B 流水线 误隐藏上界', b.upper, 7.5);
  checkPct('B 流水线 疑似覆盖', b.point.suspectBotCovered, 84.7);

  const bv0 = blindMetric('v0');
  checkEq('B v0 加权隐藏数', Math.round(bv0.point.hide), 635);
  checkPct('B v0 召回', bv0.point.recall, 69.6);
  checkPct('B v0 召回 CI 下界', bv0.boot.recallCI[0], 60.5);
  checkPct('B v0 召回 CI 上界', bv0.boot.recallCI[1], 79.2);
  checkPct('B v0 精确率', bv0.point.precision, 90.0);
  checkNum('B v0 误隐藏', bv0.point.falseHide, 37.5);
  checkNum('B v0 误隐藏 CI 上界', bv0.boot.falseHideCI[1], 62.6);
  checkNum('B v0 误隐藏上界', bv0.upper, 47.6);
  checkPct('B v0 疑似覆盖', bv0.point.suspectBotCovered, 88.7);

  const bv1 = blindMetric('v1');
  checkEq('B v1 加权隐藏数', Math.round(bv1.point.hide), 197);
  checkPct('B v1 召回', bv1.point.recall, 22.7);
  checkPct('B v1 召回 CI 下界', bv1.boot.recallCI[0], 18.3);
  checkPct('B v1 召回 CI 上界', bv1.boot.recallCI[1], 27.7);
  checkPct('B v1 P(召回<50%)', bv1.boot.pHalf, 100);
  checkPct('B v1 精确率', bv1.point.precision, 94.5);
  checkNum('B v1 误隐藏', bv1.point.falseHide, 4.2);
  checkNum('B v1 误隐藏 CI 上界', bv1.boot.falseHideCI[1], 12.5);
  checkNum('B v1 误隐藏上界', bv1.upper, 12.0);
  checkPct('B v1 疑似覆盖', bv1.point.suspectBotCovered, 77.5);

  const bv1s = blindMetric('v1Safe');
  checkEq('B v1Safe 加权隐藏数', Math.round(bv1s.point.hide), 144);
  checkPct('B v1Safe 召回', bv1s.point.recall, 16.5);
  checkPct('B v1Safe 召回 CI 下界', bv1s.boot.recallCI[0], 12.5);
  checkPct('B v1Safe 召回 CI 上界', bv1s.boot.recallCI[1], 21.0);
  checkPct('B v1Safe 精确率', bv1s.point.precision, 94.2);
  checkNum('B v1Safe 误隐藏', bv1s.point.falseHide, 4.2);
  checkNum('B v1Safe 误隐藏上界', bv1s.upper, 12.0);
  checkPct('B v1Safe 疑似覆盖', bv1s.point.suspectBotCovered, 23.5);

  const bv2a = blindMetric('v2a');
  checkPct('B v2a 召回', bv2a.point.recall, 41.4);
  checkNum('B v2a 误隐藏', bv2a.point.falseHide, 8.3);
  checkNum('B v2a 误隐藏上界', bv2a.upper, 16.5);

  const bv2b = blindMetric('v2b');
  checkPct('B v2b 召回', bv2b.point.recall, 44.6);
  checkPct('B v2b 召回 CI 下界', bv2b.boot.recallCI[0], 38.1);
  checkPct('B v2b 召回 CI 上界', bv2b.boot.recallCI[1], 51.9);
  checkNum('B v2b 误隐藏', bv2b.point.falseHide, 8.3);
  checkNum('B v2b 误隐藏 CI 上界', bv2b.boot.falseHideCI[1], 20.9);
  checkNum('B v2b 误隐藏上界', bv2b.upper, 16.8);

  const bv2c = blindMetric('v2c');
  checkPct('B v2c 召回', bv2c.point.recall, 39.3);
  checkNum('B v2c 误隐藏', bv2c.point.falseHide, 4.2);

  const bDefault = blindMetric(defaultId);
  checkEq('B 默认规则 加权隐藏数', Math.round(bDefault.point.hide), 379);
  checkPct('B 默认规则 召回', bDefault.point.recall, 44.3);
  checkNum('B 默认规则 误隐藏', bDefault.point.falseHide, 8.3);

  // 长评豁免标定：design 1 行、validation 2 行，全部 hide → suspect
  checkJson(
    'D design 豁免改变行',
    capDesign.map((c) => ({ rpid: c.rpid, label: c.label, from: c.from, to: c.to, cappedBy: c.cappedBy, measure: c.measure })),
    [{ rpid: '321554157072', label: 'unsure', from: 'hide', to: 'suspect', cappedBy: 'long-form-prose', measure: { length: 114, breaks: 3, terms: 2 } }],
  );
  checkJson(
    'D validation 豁免改变行（一次性复核）',
    capValidation.map((c) => ({ rpid: c.rpid, label: c.label, from: c.from, to: c.to, cappedBy: c.cappedBy, measure: c.measure })),
    [
      { rpid: '321585796048', label: 'bot', from: 'hide', to: 'suspect', cappedBy: 'long-form-prose', measure: { length: 109, breaks: 4, terms: 3 } },
      { rpid: '317848865873', label: 'bot', from: 'hide', to: 'suspect', cappedBy: 'long-form-prose', measure: { length: 112, breaks: 3, terms: 4 } },
    ],
  );
  checkEq('D design human 行被隐藏（v2b）', design.filter((r) => r.label === 'human' && judge(observationOf(r), pageContextOf(designPages, r), { rulesVersion: v2bVersion, allowBaseline: true }).action === 'hide').length, 0);
  checkEq('D validation human 行被隐藏（v2b）', validation.filter((r) => r.label === 'human' && judge(observationOf(r), pageContextOf(validationPages, r), { rulesVersion: v2bVersion, allowBaseline: true }).action === 'hide').length, 0);

  let failed = 0;
  for (const check of checks) {
    if (!check.pass) failed++;
    console.log(`  ${check.pass ? '[PASS]' : '[FAIL]'} ${check.name}：${check.detail}`);
  }
  console.log(`\n  合计 ${checks.length} 项：${checks.length - failed} 通过、${failed} 失败。`);

  if (!opts.check) {
    console.log('  （--no-check：跳过失败退出码）');
    return 0;
  }
  if (failed) {
    console.log('\n  数字与可行性报告不一致：口径或规则被改动过，请先核对此表再提交。');
    return 1;
  }
  console.log('  与报告 B 段 / A.2 / E.1 / F.2 一致。');
  return 0;
}

process.exitCode = main();
