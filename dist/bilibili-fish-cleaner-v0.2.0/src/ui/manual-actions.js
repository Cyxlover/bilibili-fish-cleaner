// 悬停手动入口：评论主体上出现「隐藏」，点击后交给控制器执行。
//
// 这里只做三件事：挂按钮、转发动作、显示结果条。判定、DOM 移除与状态写入
// 全部在 purge-controller / purge-state，UI 不复制任何业务规则。
(function (global) {
  'use strict';

  var ns = (global.DSHCC = global.DSHCC || {});
  var VERSION = 'v1';
  var ACTION_ATTR = 'data-dshcc-action';
  var TOAST_ID = 'dshcc-manual-toast';
  // 离开评论到隐藏按钮之间的缓冲：够把指针从评论移到浮层按钮上。
  var LEAVE_DELAY_MS = 400;
  var timerSet = (global && global.setTimeout) || setTimeout;
  var timerClear = (global && global.clearTimeout) || clearTimeout;

  var BUTTON_STYLE = [
    'float:right',
    // 浮在评论右下角时，旁边往往就是下一条评论的可点击区域。抬高一层并相对定位，
    // 保证悬停与点击先落在自己身上。
    'position:relative',
    'z-index:2',
    // 点击目标放大一点，指针不必像素级对准。
    'margin:2px 0 2px 8px',
    'padding:4px 10px',
    'border:1px solid rgba(255,77,79,.45)',
    'border-radius:999px',
    'background:#fff1f0',
    'color:#a8071a',
    'font:12px/18px system-ui,-apple-system,"Microsoft YaHei",sans-serif',
    'cursor:pointer',
    'user-select:none',
  ].join(';');

  var HOST_STYLE = [
    'position:fixed',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'z-index:2147483001',
    'margin:0',
    'padding:0',
    'border:0',
    'background:none',
  ].join(';');

  var BOX_STYLE = [
    'display:flex',
    'align-items:center',
    'gap:10px',
    'padding:8px 12px',
    'border-radius:8px',
    'background:rgba(24,25,28,.94)',
    'box-shadow:0 4px 16px rgba(0,0,0,.3)',
    'color:#fff',
    'font:13px/20px system-ui,-apple-system,"Microsoft YaHei",sans-serif',
  ].join(';');

  var TOAST_BUTTON_STYLE = [
    'padding:2px 9px',
    'border:1px solid rgba(255,255,255,.3)',
    'border-radius:999px',
    'background:rgba(255,255,255,.08)',
    'color:#fff',
    'font:12px/18px inherit',
    'cursor:pointer',
  ].join(';');

  function button(doc, text, act) {
    var el = doc.createElement('button');
    el.setAttribute('type', 'button');
    el.setAttribute('data-act', act);
    el.setAttribute('style', TOAST_BUTTON_STYLE);
    el.textContent = text;
    return el;
  }

  function create(doc, options) {
    var targetDocument = doc || (typeof document === 'undefined' ? null : document);
    var opts = options || {};
    var controller = opts.controller || null;
    var mounted = new Map();
    var toast = null;
    var toastEntry = null;

    function refresh() {
      var last = controller && typeof controller.last === 'function' ? controller.last() : null;
      apply(last && Array.isArray(last.entries) ? last.entries : []);
    }

    function removeToast() {
      if (toast && toast.host.parentNode) toast.host.parentNode.removeChild(toast.host);
      toastEntry = null;
    }

    function buildToast() {
      var host = targetDocument.createElement('div');
      host.setAttribute('id', TOAST_ID);
      host.setAttribute('style', HOST_STYLE);
      host.setAttribute('data-dshcc', 'manual-toast');
      var shadow = host.attachShadow({ mode: 'open' });
      var box = targetDocument.createElement('div');
      box.setAttribute('style', BOX_STYLE);
      var label = targetDocument.createElement('span');
      label.setAttribute('data-act', 'message');
      var undo = button(targetDocument, '撤销', 'undo');
      var block = button(targetDocument, '屏蔽作者', 'block');
      var dismiss = button(targetDocument, '不用了', 'dismiss');
      box.appendChild(label);
      box.appendChild(undo);
      box.appendChild(block);
      box.appendChild(dismiss);
      shadow.appendChild(box);

      undo.addEventListener('click', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        var entry = toastEntry;
        removeToast();
        if (entry && controller && typeof controller.restoreComment === 'function') {
          Promise.resolve(controller.restoreComment(entry.observation.commentKey))
            .then(refresh, refresh);
        }
      });
      block.addEventListener('click', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        var entry = toastEntry;
        removeToast();
        if (entry && controller && typeof controller.blockAccount === 'function') {
          Promise.resolve(controller.blockAccount(entry.observation.mid))
            .then(refresh, refresh);
        }
      });
      dismiss.addEventListener('click', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        removeToast();
      });

      return { host: host, shadow: shadow, label: label };
    }

    function showToast(entry) {
      if (!toast) toast = buildToast();
      toastEntry = entry;
      var nickname = entry.observation.nickname || ('mid ' + entry.observation.mid);
      toast.label.textContent = '已隐藏 ' + nickname + ' 的评论';
      if (!toast.host.parentNode && targetDocument.body) {
        targetDocument.body.appendChild(toast.host);
      }
    }

    function hide(entry) {
      if (!controller || typeof controller.hideComment !== 'function') return;
      Promise.resolve(controller.hideComment(entry)).then(function (ok) {
        if (ok !== false) showToast(entry);
        refresh();
      }, function () {
        // 控制器内部已降级；UI 不弹错误，避免打断浏览。
      });
    }

    function mount(entry) {
      if (!entry || !entry.body || !entry.node || !entry.node.parentNode) return;
      var key = entry.observation && entry.observation.commentKey;
      if (!key) return;
      var existing = mounted.get(key);
      if (existing && existing.body === entry.body) return;
      if (existing) existing.button.parentNode && existing.button.parentNode.removeChild(existing.button);

      var btn = targetDocument.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute(ACTION_ATTR, 'hide');
      btn.setAttribute('style', BUTTON_STYLE);
      btn.setAttribute('title', '隐藏这条评论');
      btn.textContent = '隐藏';
      btn.hidden = true;

      // 按钮浮在评论右下角，紧贴下一条评论。指针从评论移向按钮的途中会先离开评论主体，
      // 若此时立刻隐藏，按钮会在指针到达之前消失——用户根本点不到。
      // 所以离开只「预约隐藏」，留一个延迟窗口；期间移到按钮上或回到评论都取消。
      var hideTimer = null;
      function cancelHide() {
        if (hideTimer === null) return;
        timerClear(hideTimer);
        hideTimer = null;
      }
      function scheduleHide() {
        cancelHide();
        hideTimer = timerSet(function () {
          hideTimer = null;
          btn.hidden = true;
        }, LEAVE_DELAY_MS);
      }
      function within(event) {
        var to = event && event.relatedTarget;
        return !!(to && btn.contains && btn.contains(to));
      }

      function enter(event) {
        if (event && event.preventDefault) event.preventDefault();
        cancelHide();
        btn.hidden = false;
      }
      function leave(event) {
        if (within(event)) return; // 指针进入按钮自身，不算离开
        scheduleHide();
      }
      function click(event) {
        if (event && event.preventDefault) event.preventDefault();
        if (event && event.stopPropagation) event.stopPropagation();
        cancelHide();
        btn.hidden = true;
        hide(entry);
      }

      entry.body.addEventListener('mouseenter', enter);
      entry.body.addEventListener('mouseleave', leave);
      entry.body.addEventListener('focusin', enter);
      entry.body.addEventListener('focusout', leave);
      btn.addEventListener('mouseenter', enter);
      btn.addEventListener('mouseleave', leave);
      btn.addEventListener('click', click);
      entry.body.appendChild(btn);
      mounted.set(key, {
        body: entry.body,
        button: btn,
        dispose: function () {
          cancelHide();
          if (btn.parentNode) btn.parentNode.removeChild(btn);
        },
      });
    }

    function apply(entries) {
      var desired = Object.create(null);
      var list = Array.isArray(entries) ? entries : [];
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i];
        if (!entry || !entry.observation || !entry.body || !entry.node) continue;
        if (!entry.node.parentNode) continue;
        desired[entry.observation.commentKey] = true;
        mount(entry);
      }
      Array.from(mounted.keys()).forEach(function (key) {
        if (desired[key]) return;
        var item = mounted.get(key);
        if (item.dispose) item.dispose();
        else if (item.button.parentNode) item.button.parentNode.removeChild(item.button);
        mounted.delete(key);
      });
    }

    function destroy() {
      Array.from(mounted.values()).forEach(function (item) {
        if (item.dispose) item.dispose();
        else if (item.button.parentNode) item.button.parentNode.removeChild(item.button);
      });
      mounted.clear();
      removeToast();
    }

    return {
      apply: apply,
      refresh: refresh,
      showToast: showToast,
      destroy: destroy,
      buttons: function () {
        return Array.from(mounted.values()).map(function (item) { return item.button; });
      },
    };
  }

  ns.manualActions = {
    VERSION: VERSION,
    ACTION_ATTR: ACTION_ATTR,
    TOAST_ID: TOAST_ID,
    create: create,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
