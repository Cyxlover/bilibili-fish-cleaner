// 简介按需读取的客户端（内容脚本侧）。
//
// 引擎只回答「这条观测该不该去读作者简介」（needsProfile）与「读到了怎么判定」，
// 真正发请求的是 Service Worker。这个文件负责把它们接起来：
//   1) 判定时先把已知简介塞进观测（字段名与引擎契约一致：observation.bio）；
//   2) 缺资料且值得读的作者排进请求队列，一次扫描最多取 limit 个（默认 5）；
//   3) 结果回来写进本页的 mid→bio 表，并回调通知调用方重扫一次；
//   4) 同一作者一个页面会话只问一次（失败也算问过），不重试。
//
// 读到的简介只在本页内存里存活，不落存储；也不碰 DOM、不发请求。
(function (root) {
  'use strict';

  var NS = root.DSHCC = root.DSHCC || {};

  // 一次扫描最多取几个作者的名片：连点页面时也不会变成抓取风暴。
  var DEFAULT_LIMIT = 5;

  function clone(observation) {
    var out = {};
    var source = observation && typeof observation === 'object' ? observation : {};
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    }
    return out;
  }

  function midOf(observation) {
    if (!observation || typeof observation !== 'object') return '';
    var mid = observation.authorMid;
    if (mid === null || mid === undefined) mid = observation.mid;
    if (mid === null || mid === undefined) return '';
    return String(mid).trim();
  }

  // Service Worker 的应答只有三种形态，统一折成引擎认的 bio：
  //   ok → {status:'ok', value}；failed → {status:'failed'}；其余 → null（当作没有资料）。
  function bioOf(profile) {
    if (!profile || typeof profile !== 'object') return null;
    if (profile.status === 'ok' && typeof profile.value === 'string') {
      return { status: 'ok', value: profile.value };
    }
    if (profile.status === 'failed') return { status: 'failed' };
    return null;
  }

  function create(options) {
    var opts = options || {};
    var engine = opts.engine || NS.engine || null;
    // request(observation) → Promise<profile|null>；由调用方接到消息桥上。
    var request = typeof opts.request === 'function' ? opts.request : null;
    // 简介回来时通知调用方：调用方据此重扫一次（读到的资料会改变判定）。
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    var limit = typeof opts.limit === 'number' && opts.limit >= 0 ? opts.limit : DEFAULT_LIMIT;

    var bios = Object.create(null);      // mid → bio
    var asked = Object.create(null);     // mid → 已经问过（含失败）
    var pending = Object.create(null);   // mid → 请求在飞
    var budget = limit;                  // 本次扫描还剩几个名额

    // 把已知简介塞进观测。没读过就显式给 null，与引擎「缺资料」的默认一致。
    function enrich(observation) {
      var out = clone(observation);
      var mid = midOf(out);
      out.bio = (mid && bios[mid]) || null;
      return out;
    }

    function bioFor(mid) {
      return (mid && bios[mid]) || null;
    }

    // 记录一次「值得读」的缺口，并在名额内真的去读。
    function schedule(observation, pageContext) {
      if (!request || !engine || typeof engine.needsProfile !== 'function') return null;
      var mid = midOf(observation);
      if (!mid || asked[mid] || pending[mid] || budget <= 0) return null;

      var outcome;
      try {
        outcome = engine.needsProfile(enrich(observation), pageContext);
      } catch (error) {
        return null;
      }
      if (!outcome || outcome.needed !== true) return null;

      asked[mid] = true;
      budget -= 1;
      pending[mid] = true;
      Promise.resolve()
        .then(function () {
          // 只把判定需要的字段交出去：简介请求用不到 commentKey、节点引用等页面结构。
          return request({
            authorMid: mid,
            nickname: typeof observation.nickname === 'string' ? observation.nickname : '',
            text: typeof observation.text === 'string' ? observation.text : '',
            isReply: observation.isReply === true,
          });
        })
        .then(function (profile) {
          pending[mid] = false;
          var bio = bioOf(profile);
          // 没读到（失败 / 超时 / 没有接收方）：只记下「问过了」，不触发重扫。
          // 失败在引擎里等价于「没有资料」，判定结果一个字段都不会变，重扫纯属浪费。
          if (!bio) return;
          bios[mid] = bio;
          if (bio.status === 'ok' && onChange) onChange(mid, bio);
        }, function () {
          pending[mid] = false;
        });
      return mid;
    }

    return {
      limit: limit,

      /** 每次扫描开始调一次：重置本次扫描的取资料名额。 */
      beginScan: function () {
        budget = limit;
      },

      /** 判定入口：同步给出判定，缺口在后台补，补到了再触发重扫。 */
      judge: function (observation, pageContext) {
        if (!engine || typeof engine.judge !== 'function') throw new Error('判定引擎不可用');
        schedule(observation, pageContext);
        return engine.judge(enrich(observation), pageContext);
      },

      /** 观测是否需要资料（不产生请求）：面板与调试用。 */
      needs: function (observation, pageContext) {
        if (!engine || typeof engine.needsProfile !== 'function') return false;
        try {
          return engine.needsProfile(enrich(observation), pageContext).needed === true;
        } catch (error) {
          return false;
        }
      },

      enrich: enrich,
      bioFor: bioFor,
    };
  }

  NS.profileClient = {
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    create: create,
    bioOf: bioOf,
    midOf: midOf,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
