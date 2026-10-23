// 长评豁免：正文是「完整的人类叙事 / 技术讨论」时，即便规则聚合命中，也最多判 suspect。
// 出处：research/identification-feasibility.md §F.2 —— v2b 作默认隐藏规则时必须同时带这条豁免，
// 否则会隐藏 317822061249 这类人类口吻的插件教程长评。
//
// 这是**规则集的一部分**（阈值、词表都在这里），改它不需要动引擎。
// 标定记录见 engine/README.md「长评豁免标定」：阈值与词表只用 design 集标定，
// validation 只做一次性最终评估，未参与任何阈值选择。
export const LONG_FORM_POLICY = {
  // 去空白后的正文长度下限
  minLength: 60,
  // 句读数量下限（。！？；换行……）
  minBreaks: 3,
  // 不重复的术语数量下限
  minTerms: 2,
  // 技术/产品讨论词汇（报告 F.2「术语特征」）
  terms:
    /(插件|接口|部署|配置|参数|版本|实测|缓存|源码|文档|依赖|报错|安装|日志|token|模型|提示词|脚本|教程|设置|代码|浏览器|数据库|压缩|性能|测试|登录|保存|功能|更新|工具|权限|账号|开关|误伤|审核|规则)/gi,
  // 出现任何一条人设标记就不再算「人类叙事」：这是豁免与角色扮演的分界线
  personaClues: ['selfDesig', 'master', 'bodyWord'],
};

const BREAKS = /[。！？；!?;\n…]+/g;

export function measureLongForm(text) {
  const raw = String(text || '');
  const length = raw.replace(/\s+/g, '').length;
  const breaks = (raw.match(BREAKS) || []).length;
  const terms = new Set((raw.match(LONG_FORM_POLICY.terms) || []).map((t) => t.toLowerCase())).size;
  return { length, breaks, terms };
}

/** 正文是否像「完整的人类叙事/技术讨论」。纯看文本，不看账号身份。 */
export function isLongFormProse(profile) {
  const { length, breaks, terms } = measureLongForm(profile.observation.text);
  if (length < LONG_FORM_POLICY.minLength) return false;
  if (breaks < LONG_FORM_POLICY.minBreaks) return false;
  if (terms < LONG_FORM_POLICY.minTerms) return false;
  return !LONG_FORM_POLICY.personaClues.some((id) => profile.has(id));
}

export const LONG_FORM_CAP = {
  id: 'long-form-prose',
  maxAction: 'suspect',
  describe: '长评豁免：正文为完整人类叙事/技术讨论，最多判疑似',
  when: ({ profile }) => isLongFormProse(profile),
};
