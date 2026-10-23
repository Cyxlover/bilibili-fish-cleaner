# 判定引擎（engine/）

评论级判定引擎：把「一条评论 + 当前页上下文」折算成三档动作，并给出可展示的线索明细。

- **纯函数**：不读 DOM、不发网络请求、不读设置、不取当前时间。同一份观测 + 同一规则版本，永远得到同一结果（`Object.freeze` 的输出可供面板直接渲染）。
- **规则与引擎分离**：门槛、词表、豁免阈值都在 `rules.js` / `catalog.js` / `longform.js`，`index.js` 只负责归一化、来源折算和引擎级硬约束。
- **只判不删**：引擎返回动作，是否执行由扩展决定；本层不碰任何评论。

---

## 1. 公共 API

```js
import { ACTIONS, DEFAULT_RULES_VERSION, RULE_VERSIONS, judge, listRules, resolveRule } from './engine/index.js';

judge(observation, pageContext?, options?) -> Verdict
resolveRule(rulesVersion?)               -> Rule      // 未知版本抛错，不静默回落
listRules()                              -> RuleInfo[] // 面板/设置页的规则清单
ACTIONS                                  // ['hide', 'suspect', 'none']（冻结）
DEFAULT_RULES_VERSION                    // 'v2b-longform@2026.10.23'
RULE_VERSIONS                            // 全部已注册版本号
```

`options`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `rulesVersion` | `DEFAULT_RULES_VERSION` | 版本号可写 `'v2b'` 或 `'v2b@2026.10.23'`；未知版本直接抛错 |
| `allowBaseline` | `false` | `tier: 'baseline'` 的规则（`v0`）只作回归对照，未显式开启时抛错 |

`Verdict`（全部字段冻结）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `'hide' \| 'suspect' \| 'none'` | 三档动作 |
| `rulesVersion` | `string` | 实际生效的规则版本（存入判定记录，事后可复现） |
| `scope` | `'thread' \| 'reply'` | 一级评论 / 楼中楼回复（决定面板的「单条隐藏」还是「整串讨论」入口） |
| `clues` | `Array<{clueId, source, strength, fragment, label, report, used}>` | 线索明细。`used: true` 的排在前面并参与判档；其余是观测到但未被本规则引用的命中 |
| `sources` | `Array<{source, strength, clueIds, hits}>` | 按来源聚合后的证据份数（同一来源内强度取最大值，`hits` 只做展示） |
| `independentSources` | `number` | 独立来源份数，`hide` 的硬门槛（见 §3） |
| `cappedBy` | `string \| null` | 被哪条判定上限压过档（目前只有 `'long-form-prose'`） |
| `floorApplied` | `boolean` | 是否因来源数不足把 `hide` 降成了 `suspect` |

`listRules()` 每项：`{version, id, tier, title, minSources, caps: string[], clueIds: string[]}`。

---

## 2. 观测契约

调用方按下面的形状传「页面上真实拿得到的东西」；引擎不向上游要额外字段。

| 字段 | 类型 | 缺失时 | 说明 |
| --- | --- | --- | --- |
| `commentId` | `string \| number` | `null` | 评论 rpid |
| `authorMid` | `string \| number` | `null` | 作者 mid（页面上下文按它匹配） |
| `nickname` | `string` | `''` | 昵称原文 |
| `bio` | `string \| {status:'ok',value} \| {status:'failed'} \| null` | 无简介 | 简介。见下方「简介三形态」 |
| `text` | `string` | `''` | 正文原文，**不要预清洗**（去 @、去引号的口径在 `catalog.js` 里） |
| `isReply` | `boolean` | `false` | 是否楼中楼 |
| `rootCommentId` | `string \| number` | `null` | 所属一级评论 rpid（用于整串讨论） |
| `likeCount` | `number` | `null` | 点赞数，仅存档 |
| `publishedAt` | `number`（Unix 秒） | `null` | 发布时间，仅存档 |
| `authorHistory` | `{videoCount?, repeatedAtTarget?}` | `null` | 本机历史摘要；缺失按 0 处理 |

`pageContext`（可省略）

```js
{ sameAccountOnPage: [{ text, isReply? }] }  // 同账号在本页的「其他」评论，调用方负责排除本条
```

- 只放**同账号同视频**的其他评论；别人的评论不会成为你的证据（`test/engine/evidence.test.js` 有专门断言）。
- 上下文只用于两条规则线索：同页复述母题（`source: 'page'`）与同页分享结构。

**简介三形态必须等价**：`''`、`undefined`/`null`、`{status:'failed'}` 归一化后 `sign` 都是空串，动作完全一致；`profileStatus` 只做诊断，判定不得读取它。读取失败既不加线索也不减线索——这是「读取失败/缺失一律视为无该证据」的落地。

**没有本机历史 = 首次安装**：`authorHistory` 缺失时 `videoCount` / `repeatedAtTarget` 记 0，跨视频复读（`crossVideo`, C13）与反复 @ 同一对象（`shareConsistent`, C15）自然不命中。不带历史既不放宽也不收紧判定，只是少两条线索。

---

## 3. 三档动作与强度折算

| 动作 | 含义 | 面板 |
| --- | --- | --- |
| `hide` | 自动本地隐藏（不删评论、不通知对方） | 默认执行 |
| `suspect` | 只标记疑似，等人看 | 折叠/浮层提示 |
| `none` | 不动 | — |

**强度（strength）**：线索自带 1–4 的强度，只用于「强母题」判断和面板展示，**不按条数累加**——`bioOper`（简介声明账号被鱼占用）是唯一的 4。

**同源折算**：18 条线索分属 `account` / `text` / `share` / `structure` / `history` 五个来源（同页上下文另记 `page`）。同一来源内：

```
sources[source].strength = max(该来源命中的 strength)
sources[source].hits     = 命中条数
independentSources       = sources.size        // 有几份「来源独立」的证据
```

于是「昵称带鱼 + 正文叫主人 + 白饭」这类真人玩梗最多算 3 份证据，而「同一条正文里既叫主人又提白饭」只算 1 份（`test/engine/mimicry.test.js` 用两条真实样本把这两个数字钉死）。

**引擎级硬约束**（不属于任何单条规则，改规则也绕不过）：

1. `hide` 要求 `independentSources >= rule.minSources`（候选规则一律 2，`v0` 为 1）；不足则降为 `suspect` 并置 `floorApplied: true`。单一线索哪怕命中多条同源特征也不够定案。
2. 判定上限 `caps`：当前只有长评豁免一条，`maxAction: 'suspect'`，命中即 `cappedBy: 'long-form-prose'`（§5）。

---

## 4. 规则版本

版本号 = `id@revision`，`revision` 是冻结日期；规则集在 `rules.js` 里 `Object.freeze`，**已发布版本不可改写**——判定记录里存 `rulesVersion`，事后能原样复现。

| 版本 | tier | 门槛 | 判定 | 说明 |
| --- | --- | --- | --- | --- |
| `v0@2026.10.23` | baseline | 1 | 身份元数据 → hide | 已被可行性报告否证，只作回归对照 |
| `v1@2026.10.23` | candidate | 2 | 身份 ∧ 正文母题 → hide | 报告里的主对照 |
| `v1Safe@2026.10.23` | candidate | 2 | 身份 ∧ 强母题 → hide | 去掉 `master` 的保守版 |
| `v2a@2026.10.23` | candidate | 2 | 身份 ∧ 母题（含同页） → hide | 页面聚合 |
| `v2b@2026.10.23` | candidate | 2 | 身份 ∧ (母题 ∨ 分享结构)（含同页） → hide | 报告 E 段最优候选 |
| `v2c@2026.10.23` | candidate | 2 | v1 底 + 身份 ∧ 隐含人设词 → hide | 误伤更低、召回更低 |
| `v2b-longform@2026.10.23` | candidate | 2 | `v2b` + 长评豁免 cap | **默认** |

`v0` 是唯一 `tier: 'baseline'` 的版本，`judge()` 默认拒绝执行，只有回归脚本会传 `allowBaseline: true`。新增规则的做法：在 `rules.js` 的 `FROZEN` 里注册（版本号带新 revision），确认 `test/engine/judge.test.js` 的版本号与 tier 断言仍然成立，再重跑 `node tools/regression.mjs` 把新数字写进本文件。

---

## 5. 长评豁免标定

**动机**：可行性报告 F.2 指出，纯 `v2b` 会把「人类写的长教程/技术讨论」误藏（`317822061249` 那类）。豁免的作用是给「完整人类叙事」留一条上限：**最多判疑似**。它不增加任何新线索，只压档。

**阈值**（`LONG_FORM_POLICY`，改任何一个都必须重做标定）：

| 项 | 值 | 含义 |
| --- | --- | --- |
| `minLength` | 60 | 去掉空白后的正文字数 |
| `minBreaks` | 3 | 句读/换行切分出的段落数（`。！？；!?;\n…`） |
| `minTerms` | 2 | 去重后的技术/操作词数（插件、部署、缓存、报错、版本……） |
| `terms` | 37 个词的正则 | 见 `longform.js` |
| `personaClues` | `selfDesig` / `master` / `bodyWord` | 命中任一即**不豁免**（带人设的「长评」是鱼写的） |

**方法**：只在 design（3577 行）上标定，阈值定死后在 validation（3931 行）上做**一次性**复核，此后不得回改。看两个量：豁免改变了哪些行、human 行被隐藏的数量。

| 集合 | 行数 | 改变行 | rpid | 标签 | 动作 | `measureLongForm` |
| --- | --- | --- | --- | --- | --- | --- |
| design | 3577 | 1 | `321554157072` | unsure | hide → suspect | `{length:114, breaks:3, terms:2}` |
| validation | 3931 | 2 | `321585796048` | bot | hide → suspect | `{length:109, breaks:4, terms:3}` |
| validation | 3931 | 2 | `317848865873` | bot | hide → suspect | `{length:112, breaks:3, terms:4}` |

- 三条的 `cappedBy` 都是 `'long-form-prose'`；两个集合里 **human 行被隐藏都是 0**。
- 豁免只降不升：默认规则的动作在任何一行都不会比 `v2b` 更严（`test/engine/longform.test.js` 全量断言）。
- 代价：validation 里 2 条 bot（都是长技术评论）从 hide 掉到 suspect，各让一条召回。收益是「完整人类叙事」不再被直接隐藏——但本次标定在 design 上实际只改变了 1 条（`321554157072`，label=unsure），说明这条豁免在现有样本里只影响长评里的边缘行，不是靠它抬指标。
- 越过三条阈值的正文：design 34 条、validation 52 条（合计 86）。其中 22 条因命中 `personaClues` 不享受豁免（design 10 / validation 12），其余 64 条具备豁免资格——但只有本来会判 `hide` 的 3 条真正被压档，豁免不会把 `suspect` / `none` 再往下压。
- 边界样本 `317864107409`（bot，`{length:74, breaks:3, terms:2}`，含 `selfDesig`）仍判 `hide` 且 `cappedBy: null`。

---

## 6. 回归命令

```bash
npm test                                     # 全部测试（206 个）
node tools/regression.mjs                    # 真实标注样本全量回归（约 2 秒）
node tools/regression.mjs --data <dir>       # 换数据目录
node tools/regression.mjs --all              # 打印全部规则的分层混淆矩阵
node tools/regression.mjs --no-check         # 跳过与报告的数字自检（仅人工探查）
```

`regression.mjs` 输出六段：

- **A 自洽性**：把规则动作与 `labels.jsonl` 对照（design + validation 各一张表）。**只证明规则忠实实现了标注口径，不能证明识别能力**——标签与规则取自同一批字段。
- **B 盲标加权**：400 条分层抽样（bot 150 / human 150 / unsure 100）按层加权回 N=3931，给出隐藏数、召回及 95% CI、`P(召回<50%)`、隐藏集精确率、误隐藏及 CI、Clopper-Pearson 单侧上界、疑似覆盖。自助法 10000 次、种子 20261023，与 `validation/evaluate.mjs` 同算法。
- **C 分层矩阵**：未加权原始计数，行=动作、列=盲标判定。
- **D 长评豁免标定**：v2b → 默认规则的改变行与 human 隐藏数（§5 那张表）。
- **E 如实披露**：盲标判非 bot 却被隐藏的每一条（含 rpid、层、盲标、权重、正文摘要）。
- **F 自检**：95 项数字与报告 B 段 / A.2 / E.1 / F.2 对齐，漂移则退出码 1。

关键对照（本次全绿）：

| 口径 | 数字 |
| --- | --- |
| 自洽 design，`v2b` | 隐藏 289，精确率 82.4%，召回 80.4%，human 被隐藏 0 |
| 盲标，已发布流水线 | 召回 45.6% [40.2–51.7]，`P(召回<50%)` 92.0%，误隐藏 0.0 [0.0–0.0]，上界 7.5 |
| 盲标，默认规则 | 隐藏 379，召回 44.3% [37.8–51.5]，`P(召回<50%)` 93.9%，隐藏集精确率 96.0%，误隐藏 8.3 [0.0–20.9]，上界 16.8，疑似覆盖 70.4% |

**纪律**：validation 只做一次性评估。`regression.mjs` 只读样本、只复算；任何口径改动都必须回 design 重新标定并更新本文件。

---

## 7. 已知局限（必须如实披露）

1. **validation 有 3 条非 bot 行会被默认规则隐藏**：`321226625824`（盲标 human，玩梗回复「得吃不少白饭，先生」，被账号级线索连坐）、`317893225489`（盲标 human，人类写的插件使用长评，同样被账号级线索连坐）、`317608830881`（盲标 unsure，「白饭也是饭」）。加权误隐藏 **8.3 条**，95% 上界 **16.8 条**。
2. **两个口径的差距要说清**：自洽口径下 `label=human` 被隐藏是 0（design 与 validation 都是）；加权误隐藏 8.3 条来自 2 条「label=unsure、盲标者却判 human」的行（`321226625824`、`317893225489`）；第 3 条 `317608830881` 同在 unsure 层，但盲标判 unsure，不计入 8.3。面板/报告引用 8.3 时必须同时说明这一点，不能写成「藏了 8 个真人」。
3. **样本量**：hidden 集只抽到 150 条、其中盲标 human 仅 2 条，所以只能排除「误伤率 ≥2%」这类大偏差（报告 F.2/F.3）；要收窄区间得把盲标扩到 1500 条以上。
4. **盲标是单标注者**，且可见粉丝数/等级等引擎拿不到的信息，存在系统性差异（报告 B.6）。
5. **首次安装没有历史**：`crossVideo` / `shareConsistent` 两条线索为空，跨视频复读抓不到；这不是 bug，是「先能用起来」的取舍。
6. **简介读取失败即无简介**：账号级线索可能漏，不会误加。

以上任何一条都不构成「达标」的证明：默认规则只是候选，可行性报告 F 段要求的长评豁免量化到此为止，是否上线由后续工单决定。

---

## 8. 资料按需读取（增强切片）

简介不在评论区页面里，只能按需请求。读取**不进入判定链路**：判定仍只吃 `bio` 三形态，读不到就按「没有这条证据」处理（见 §2）。

```js
import { needsProfile } from './engine/profile-need.js';
import { createProfileCache, createProfileReader } from './engine/profile-reader.js';

needsProfile(observation, pageContext?) -> {needed, clueIds}
createProfileCache({load, save, now?, ttlMs?, limit?})    -> {get, set, size}
createProfileReader({request, cache?, now?, minIntervalMs?, timeoutMs?, endpoint?}) -> {read}
await reader.read(observation, pageContext?) -> {status:'ok', value} | {status:'failed'} | null
```

| 约束 | 落地 |
| --- | --- |
| 只有已出现线索才读 | `needsProfile` 用「无简介」的观测先判一次；无线索返回 `needed:false`，不产生请求 |
| 一页会话同一作者只读一次 | `createProfileReader` 的会话内 `seen` 集合（失败也算读过，避免重试风暴） |
| 缓存 + 过期 | `createProfileCache`，默认 `PROFILE_TTL_MS` 7 天；命中不发请求 |
| 失败 / 超时 / 字段缺失 | 一律 `{status:'failed'}`：不加线索也不减线索，且**不写缓存**（下次会话可以再读） |
| 节流 | 串行排队，相邻请求间隔 ≥ `PROFILE_MIN_INTERVAL_MS`（800ms），不并发轰炸 |
| 只读一项、只读操作 | 只 `GET …/x/space/acc/info?mid=`，只解析 `data.card.sign`；无翻页、无点赞/关注/评论 |
| 缓存有上限 | 最多 `PROFILE_CACHE_LIMIT`（50）条，超出按写入时间清最旧的 |
| 隐私 | 缓存只落 `{sign, at}`，不落昵称、头像、等级、关注关系 |

依赖全部注入（`request` / `load`+`save` / `now`）：本层自身不发真实请求、不取当前时间，测试用假 `request` 与内存存储，没有真实网络。

---

## 9. 文件清单

| 文件 | 职责 |
| --- | --- |
| `engine/index.js` | 公共入口：`judge` / `resolveRule` / `listRules`、来源折算、来源下限与判定上限 |
| `engine/rules.js` | 规则集 `FROZEN`、版本号与基线守卫、`CANDIDATE_MIN_SOURCES` |
| `engine/catalog.js` | 18 条线索（16 + 2 条历史）的正则、强度、报告编号与来源分组 |
| `engine/profile.js` | 观测 → 线索命中 → 按来源聚合（同源取 max，不累加） |
| `engine/observation.js` | 观测归一化：简介三形态等价、历史缺省为 0 |
| `engine/longform.js` | 长评度量、豁免策略与 `long-form-prose` 判定上限 |
| `engine/profile-need.js` | 「该不该为这条评论读作者简介」：只有已命中的线索才算，纯策略 |
| `engine/profile-reader.js` | 按需读取：GET + 会话去重 + 本机缓存（TTL/上限）+ 节流 + 失败降级 |
| `test/profile-reader.test.mjs` | §8 的假 request/假存储回归（无线索不请求、缓存、失败、超时、节流、上限） |
| `test/engine/evidence.test.js` | 单来源不定案、同源折算、简介失败等价、页面上下文边界 |
| `test/engine/judge.test.js` | 三档动作、版本号、线索明细、纯函数、动作集合 |
| `test/engine/longform.test.js` | §5 标定数字与「只降不升」 |
| `test/engine/mimicry.test.js` | 真人玩梗/复读/引用不判隐藏 + design human 隐藏为 0 的护栏 |
| `tools/lib/dataset.mjs` | 标注样本读取（labels / blind / 页面上下文） |
| `tools/regression.mjs` | §6 全量回归 |
