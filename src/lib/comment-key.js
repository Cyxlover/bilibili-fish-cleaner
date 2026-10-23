// 合成评论标识：页面 DOM 不提供 rpid，只能由页面可得字段合成稳定标识。
//
// 组成：一级评论 = 视频 aid + 作者 mid + 正文归一化后的哈希；
//       楼中楼   = 所属一级评论的标识 + 作者 mid + 正文归一化后的哈希。
// 已知代价：同一作者在同一视频下发出完全同文的多条评论会被视为同一条。

(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});

  var KEY_VERSION = 'v1';
  var SEPARATOR = ':';

  function toText(value) {
    return value == null ? '' : String(value);
  }

  // 归一化只消除「渲染差异」：Unicode 兼容形式、零宽字符、各类空白。
  function normalizeText(text) {
    return toText(text)
      .normalize('NFKC')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hex8(value) {
    return (value >>> 0).toString(16).padStart(8, '0');
  }

  // 两轮 FNV-1a（不同种子）拼成 16 位十六进制，避免单轮 32 位哈希在评论量
  // 累积后过早碰撞；纯 JS 整数运算，浏览器与 Node 结果一致。
  function hashText(text) {
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ code, 2246822519) >>> 0;
    }
    return hex8(h1) + hex8(h2);
  }

  function buildKey(input) {
    var fields = input || {};
    var aid = toText(fields.aid).trim();
    var mid = toText(fields.mid).trim();
    var textHash = hashText(normalizeText(fields.text));

    if (!aid || !mid) {
      throw new TypeError('合成评论标识需要 aid 与 mid');
    }

    if (fields.rootCommentKey) {
      return [KEY_VERSION, 'r', fields.rootCommentKey, mid, textHash].join(SEPARATOR);
    }
    return [KEY_VERSION, 't', aid, mid, textHash].join(SEPARATOR);
  }

  ns.commentKey = {
    VERSION: KEY_VERSION,
    buildKey: buildKey,
    normalizeText: normalizeText,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
