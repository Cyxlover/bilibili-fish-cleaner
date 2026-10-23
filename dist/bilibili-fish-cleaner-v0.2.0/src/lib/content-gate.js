// 注入范围闸门：只在哔哩哔哩普通视频播放页生效。
//
// manifest 的 matches 已经限定到 https://www.bilibili.com/video/*，
// 这里再按路径确认一次「真的是一个视频播放页」，让「非视频播放页不注入任何行为」
// 这条要求有独立、可离线测试的实现，而不是只依赖清单。

(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});

  // BV 号固定 12 位（BV + 10 位）；av 号为纯数字。
  var VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)(?:\/|$)/;

  // 调用方多数时候传 location.pathname（本来就不含查询串与片段），
  // 但也可能拿 href 之类的完整串来问；统一截到路径部分再判，避免那种情况下误判为「非视频页」。
  function videoIdFromPath(pathname) {
    var path = String(pathname == null ? '' : pathname).split(/[?#]/)[0];
    var match = VIDEO_PATH.exec(path);
    return match ? match[1] : null;
  }

  function isVideoPage(pathname) {
    return videoIdFromPath(pathname) !== null;
  }

  ns.contentGate = {
    isVideoPage: isVideoPage,
    videoIdFromPath: videoIdFromPath,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
