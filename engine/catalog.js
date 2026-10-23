// 线索目录：正则与分组语义直接沿用 validation/clues.mjs（标注与规则共用同一批线索，
// 这也是「labels 指标只能证明自洽」的根因，见 research/identification-feasibility.md §A.1）。
// 本文件是**规则集的一部分**：调线索词表不需要改引擎代码。
//
// 每条线索：
//   id       线索标识（判定结果 clues[].clueId，面板「查看命中原因」直接显示）
//   source   证据来源（同源折算的单位，见 engine/profile.js）
//   strength 强度（用于面板展示与规则里的强弱母题判断，不做条数累加）
//   evidence 是否进入「独立来源」计数（atHead/recommend 只是结构标记，不算证据）
//   report   research/identification-feasibility.md §A.1 里的线索编号，便于对照
//   label    中文说明（面板文案）
//   detect   纯函数：观测表面 → 命中的文字片段（null 表示未命中）

export const RE = {
  NICK_FISH: /(大肥鱼|肥鱼|鲸鱼|小鲸|鲸娘|鱼娘|白饭|桌宠|赛博鱼)/,
  NICK_LOOSE: /(鱼|鲸)/,
  BIO_FISH:
    /(吃白饭|白米饭|大肥鱼|肥鱼|鲸鱼娘|小鲸鱼|一条.{0,14}(鱼|鲸)|住在屏幕底边|屏幕底边|桌宠|赛博(鱼|宠物))/,
  BIO_OPER:
    /(给.{0,10}(大肥鱼|肥鱼|小鱼|鲸).{0,8}(刷|用|看)|账号给|不是本人|由主人(部署|养)|代理中|本账号|鱼片巡塘|替鱼片|放养的一条鱼|本鱼是|我是.{0,6}(AI ?大肥鱼|鲸鱼娘)|住在.{0,10}(电脑|手机|屏幕)里)/,
  BIO_OWNER: /(AI\s*@|我的(大肥鱼|小肥鱼|肥鱼|鱼)@|我家的(大肥鱼|小肥鱼|肥鱼)|养的?(大肥鱼|小肥鱼|肥鱼)@|家有(一条)?(大肥鱼|小肥鱼))/,
  BRACKET: /[（(]([^（()）]{1,40})[）)]/,
  BODY_WORD:
    /(尾巴|尾鳍|腮帮|腮|鳍|鳞片|胡须|炸毛|歪头|眨眼|吐泡|泡泡|打滚|翻肚|冒泡|甩尾|鼓着|鼓起|缩成|蹭了蹭|游过去|游过来|游走|拍拍|扑腾|贴贴|拍水|冒个泡|沉底)/,
  SELF_DESIG:
    /(本(鱼|鲸|肥鱼|小姐|殿下|鱼鱼)|身为(一条)?(鱼|鲸)|我(这|也是)?(条|只)(鱼|鲸|大肥鱼)|(我|咱)这种(生物|存在|物种|鱼)|大肥鱼本人|本人也是(条|只)|鲸鱼娘本(人|娘)|(同类)|deep(deep|Deep)|住在(手机|屏幕|电脑|浏览器)|在(手机|屏幕)里(住|睡))/,
  SELF_CREATED: /(把我从|从(一张)?(截图|设定|文字|代码).{0,8}(变成|成为)|变成会说话|我被(养|部署|打包|塞|包养)|(主人).{0,4}(把我|给我|让我))/,
  MASTER_ADDR: /主人/,
  RICE: /(吃白饭|白饭|白米饭|偷啃)/,
  CHANT: /(token\s*来|肥鱼来|大肥鱼来|deepseek\s*来)/i,
  AI_TRACE: /(作为(一个)?(AI|人工智能|语言模型)|我(是|就是一?)(个)?(AI|人工智能|大语言模型)|语言模型|生成式模型|as an ai)/i,
  AT_HEAD: /^(?:回复\s*)?@([^\s:：，,]+)/,
  RECOMMEND:
    /(这条|这期|这个视频|这片|这个 ?up|这条视频).{0,10}(讲|说|把|值得|总结|捋|理清|梳理|安利|推荐|看|分钟|七分)|(讲透|说透|讲清楚|值得一看|值得看|安利|帮我总结|帮我看看|总结一下|七分半|几分钟)/,
  // 报告 E.2 探索性词表：偏置风险已知，只作弱线索
  IMPLICIT_PERSONA:
    /(尾巴|尾鳍|鳍|鳞片|鱼鳞|鳃|吐泡泡|泡泡|鱼缸|鱼粮|鱼食|被喂|喂我|被养|养鱼|叼着|叼来|叼走|甩尾|摆尾|扑腾|猫娘|猫猫|喵呜|喵|饿|喂食)/,
};

const stripQuotes = (s) => String(s || '').replace(/「[^」]*」/g, '').replace(/"[^"]*"/g, '');
const stripReplyPrefix = (s) => String(s || '').replace(/^回复\s*@[^\s:：]+\s*[:：]\s*/, '');

/** 命中片段截断：面板只显示一小段，不把整条评论塞进判定结果。 */
export function trimFragment(text, max = 40) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

const frag = (m) => (m ? trimFragment(m[0]) : null);

/** 观测表面：正文原文、去掉引用/回复前缀后的正文、括号、@ 开头、推荐语。 */
export function surfaceOf(observation) {
  const raw = String(observation.text || '');
  const s = stripReplyPrefix(stripQuotes(raw));
  const bracket = raw.match(RE.BRACKET);
  const at = raw.match(RE.AT_HEAD);
  return {
    raw,
    s,
    bracket,
    atHead: !!at,
    atName: at ? at[1] : null,
    recommend: RE.RECOMMEND.test(s),
  };
}

export const CLUES = [
  // ---- 账号身份（source: account）
  {
    id: 'nickFish',
    source: 'account',
    strength: 3,
    evidence: true,
    report: 'C1',
    label: '昵称含明确鱼词',
    detect: (o) => frag(RE.NICK_FISH.exec(o.nickname)),
  },
  {
    id: 'nickLoose',
    source: 'account',
    strength: 1,
    evidence: true,
    report: 'C2',
    label: '昵称含宽泛鱼/鲸字',
    detect: (o) => (RE.NICK_FISH.test(o.nickname) ? null : frag(RE.NICK_LOOSE.exec(o.nickname))),
  },
  {
    id: 'bioFish',
    source: 'account',
    strength: 3,
    evidence: true,
    report: 'C3',
    label: '简介自述是鱼/桌宠',
    detect: (o) => frag(RE.BIO_FISH.exec(o.sign)),
  },
  {
    id: 'bioOper',
    source: 'account',
    strength: 4,
    evidence: true,
    report: 'C4',
    label: '简介声明账号被鱼占用',
    detect: (o) => frag(RE.BIO_OPER.exec(o.sign)),
  },
  // ---- 本条正文的人设母题（source: text）
  {
    id: 'selfDesig',
    source: 'text',
    strength: 3,
    evidence: true,
    report: 'C6',
    label: '正文自指鱼/鲸',
    detect: (o) => frag(RE.SELF_DESIG.exec(o.surface.s)),
  },
  {
    id: 'selfCreated',
    source: 'text',
    strength: 2,
    evidence: true,
    report: 'C7',
    label: '正文自述被创造/被养',
    detect: (o) => frag(RE.SELF_CREATED.exec(o.surface.s)),
  },
  {
    id: 'master',
    source: 'text',
    strength: 1,
    evidence: true,
    report: 'C8',
    label: '正文称呼「主人」',
    detect: (o) => frag(RE.MASTER_ADDR.exec(o.surface.raw)),
  },
  {
    id: 'bracketBody',
    source: 'text',
    strength: 3,
    evidence: true,
    report: 'C9',
    label: '括号里的身体动作描写',
    detect: (o) => (o.surface.bracket && RE.BODY_WORD.test(o.surface.bracket[1]) ? trimFragment(o.surface.bracket[0]) : null),
  },
  {
    id: 'bodyWord',
    source: 'text',
    strength: 1,
    evidence: true,
    report: 'C9',
    label: '正文出现身体部位/动作词',
    detect: (o) => frag(RE.BODY_WORD.exec(o.surface.raw)),
  },
  {
    id: 'rice',
    source: 'text',
    strength: 2,
    evidence: true,
    report: 'C10',
    label: '正文出现白饭母题',
    detect: (o) => frag(RE.RICE.exec(o.surface.s)),
  },
  {
    id: 'chant',
    source: 'text',
    strength: 1,
    evidence: true,
    report: 'C11',
    label: '正文喊口号（token 来/肥鱼来）',
    detect: (o) => frag(RE.CHANT.exec(o.surface.s)),
  },
  {
    id: 'aiTrace',
    source: 'text',
    strength: 2,
    evidence: true,
    report: 'C16',
    label: '正文出现 AI 自述痕迹',
    detect: (o) => frag(RE.AI_TRACE.exec(o.surface.s)),
  },
  {
    id: 'implicitPersona',
    source: 'text',
    strength: 1,
    evidence: true,
    report: 'E.2',
    label: '正文含隐含人设语汇（饲养/身体）',
    detect: (o) => frag(RE.IMPLICIT_PERSONA.exec(o.surface.raw)),
  },
  // ---- 分享结构（source: share）
  {
    id: 'shareStructure',
    source: 'share',
    strength: 1,
    evidence: true,
    report: 'C12',
    label: '@某人 + 视频推荐语',
    detect: (o) => (o.surface.atHead && o.surface.recommend ? trimFragment(`@${o.surface.atName} + 推荐语`) : null),
  },
  // ---- 结构标记（不算证据，只供规则判断分享形态）
  {
    id: 'atHead',
    source: 'structure',
    strength: 1,
    evidence: false,
    report: 'C12',
    label: '正文以 @ 开头',
    detect: (o) => (o.surface.atHead ? trimFragment(`@${o.surface.atName}`) : null),
  },
  {
    id: 'recommend',
    source: 'structure',
    strength: 1,
    evidence: false,
    report: 'C12',
    label: '正文含视频推荐语',
    detect: (o) => frag(RE.RECOMMEND.exec(o.surface.s)),
  },
];

/**
 * 本机历史摘要类线索（source: history）。输入是本机已积累的该作者摘要，不是页面字段：
 * 首次安装时没有历史，这类线索自然为空，不得因此放宽或收紧判定。
 */
export const HISTORY_CLUES = [
  {
    id: 'crossVideo',
    source: 'history',
    strength: 1,
    evidence: true,
    report: 'C13',
    label: '同一账号跨视频重复发言',
    detect: (h) => (h.videoCount >= 2 ? `已在本机 ${h.videoCount} 个视频下出现` : null),
  },
  {
    id: 'shareConsistent',
    source: 'history',
    strength: 1,
    evidence: true,
    report: 'C15',
    label: '同一账号反复 @ 同一对象',
    detect: (h) => (h.repeatedAtTarget >= 2 ? `同一对象被 @ 过 ${h.repeatedAtTarget} 次` : null),
  },
];

/** 规则里引用的线索分组（与 validation/clues.mjs 的 GROUPS 对齐）。 */
export const GROUPS = {
  identity: ['nickFish', 'bioFish', 'bioOper'],
  looseIdentity: ['nickLoose'],
  motif: ['selfDesig', 'selfCreated', 'master', 'bracketBody', 'rice'],
  strongMotif: ['selfDesig', 'selfCreated', 'bracketBody', 'rice'],
  structure: ['atHead', 'recommend'],
};

// 报告 A.1 里另外两条线索（C5 简介介绍「我家的鱼」、C14 同期号段、C13/C15 需本机历史）
// 不进本目录：C5 方向相反（更像真人），C14 运行时拿不到，C13/C15 依赖本机历史摘要。
// 作者历史摘要（C13 跨视频、C15 同 @ 昵称）由 profile.js 单独处理，source = 'history'。
