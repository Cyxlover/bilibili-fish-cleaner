// 侧边面板：当前视频的隐藏记录 + 账号名单。
//
// 面板不判断「该不该隐藏」，也不自己维护互斥规则：状态来自 purge-state，
// 规则记录来自 purge-records，动作一律转发给 purge-controller。这里只做
// 三件事——把状态摊成可读的视图模型、渲染、把点击转成动作。

(function (global) {
  'use strict';

  var NS = (global.DSHCC = global.DSHCC || {});
  var VERSION = 'v1';

  var VIEW_RECORDS = 'records';
  var VIEW_ACCOUNTS = 'accounts';
  var VIEW_KEPT = 'kept';

  function viewOf(value) {
    if (value === VIEW_ACCOUNTS) return VIEW_ACCOUNTS;
    if (value === VIEW_KEPT) return VIEW_KEPT;
    return VIEW_RECORDS;
  }

  var HOST_ID = 'dshcc-panel';
  var HOST_ATTR = 'data-dshcc';
  var HOST_STYLE = [
    'position:fixed',
    'top:0',
    'right:0',
    'width:360px',
    'height:100%',
    'z-index:2147483002',
    'margin:0',
    'padding:0',
    'border:0',
    'background:#fff',
    'box-shadow:-2px 0 16px rgba(0,0,0,.18)',
  ].join(';');

  var SHADOW_STYLE = [
    ':host { all: initial; }',
    '.panel { box-sizing:border-box; height:100%; display:flex; flex-direction:column;',
    '  background:#fff; color:#18191c;',
    '  font:13px/20px system-ui,-apple-system,"Microsoft YaHei",sans-serif; }',
    '.head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #e5e6eb; }',
    '.head h1 { flex:1; margin:0; font-size:14px; font-weight:600; }',
    '.tabs { display:flex; gap:6px; padding:8px 12px; border-bottom:1px solid #e5e6eb; }',
    '.tab { padding:3px 10px; border:1px solid #d0d3d9; border-radius:999px; background:#fff;',
    '  color:#18191c; font:12px/18px inherit; cursor:pointer; }',
    '.tab[aria-selected="true"] { border-color:#ff4d4f; color:#a8071a; background:#fff1f0; }',
    '.body { flex:1; overflow:auto; padding:8px 12px 16px; }',
    '.group { margin:0 0 14px; }',
    '.group h2 { margin:8px 0 6px; font-size:12px; font-weight:600; color:#61666d; }',
    '.note { margin:6px 0; color:#86909c; font-size:12px; }',
    'ul { list-style:none; margin:0; padding:0; }',
    '.row { padding:8px 0; border-bottom:1px solid #f2f3f5; }',
    '.summary { margin:0 0 4px; word-break:break-word; }',
    '.meta { color:#86909c; font-size:12px; }',
    '.tag { display:inline-block; margin-right:6px; padding:0 6px; border-radius:999px; font-size:11px;',
    '  line-height:16px; }',
    '.tag-rule { background:#fff1f0; color:#a8071a; }',
    '.tag-manual { background:#e8f3ff; color:#1d4ed8; }',
    '.act { margin-top:6px; padding:3px 10px; border:1px solid #d0d3d9; border-radius:999px;',
    '  background:#fff; color:#18191c; font:12px/18px inherit; cursor:pointer; }',
    '.act-danger { border-color:#ffccc7; color:#a8071a; }',
    '.empty { padding:24px 0; color:#86909c; text-align:center; }',
  ].join('\n');

  var SOURCE_LABEL = { rule: '规则隐藏', manual: '手动隐藏' };
  var MANUAL_REASON = '我在页面上手动隐藏了这条';
  var RULE_REASON = '规则命中后自动隐藏';

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function escapeHTML(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function startOfDay(time) {
    var date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  // 时间只用于「刚才发生了什么」，按天给出就够；跨天用日期，跨年也仍是 MM-DD。
  function formatTime(at, now) {
    if (typeof at !== 'number' || !isFinite(at) || at <= 0) return '';
    var stamp = new Date(at);
    var clock = pad(stamp.getHours()) + ':' + pad(stamp.getMinutes());
    var days = Math.round((startOfDay(now) - startOfDay(at)) / 86400000);
    if (days === 0) return '今天 ' + clock;
    if (days === 1) return '昨天 ' + clock;
    return pad(stamp.getMonth() + 1) + '-' + pad(stamp.getDate()) + ' ' + clock;
  }

  // 线索强度只做展示：引擎给的是 1–4 档数字，旧记录与夹具里是字符串，两种都要能显示；
  // 缺失或空串则不加任何后缀，避免拼出「强度 undefined」。
  function strengthText(strength) {
    if (typeof strength === 'number' && isFinite(strength)) return '强度 ' + strength;
    if (typeof strength === 'string' && strength !== '') return strength;
    return '';
  }

  function clueList(record) {
    var clues = record && Array.isArray(record.clues) ? record.clues : [];
    var out = [];
    for (var i = 0; i < clues.length; i += 1) {
      var clue = clues[i];
      if (!clue || typeof clue !== 'object') continue;
      out.push({
        label: text(clue.label || clue.clueId),
        fragment: text(clue.fragment),
        strengthText: strengthText(clue.strength),
      });
    }
    return out;
  }

  function summaryOf(record, reasons) {
    var direct = [record && record.text, record && record.excerpt, record && record.summary];
    for (var i = 0; i < direct.length; i += 1) {
      if (typeof direct[i] === 'string' && direct[i] !== '') return direct[i];
    }
    for (var j = 0; j < reasons.length; j += 1) {
      if (reasons[j].fragment) return reasons[j].fragment;
    }
    var key = text(record && record.commentKey);
    return key ? '评论 ' + key.slice(0, 8) : '评论';
  }

  function reasonTextOf(source, reasons) {
    if (source === 'manual') return MANUAL_REASON;
    var labels = reasons.map(function (item) { return item.label; }).filter(Boolean);
    return labels.length ? '规则命中：' + labels.join('、') : RULE_REASON;
  }

  function describe(record, source, now) {
    var reasons = clueList(record);
    var scope = record && record.scope === 'reply' ? 'reply' : 'thread';
    return {
      commentKey: text(record && record.commentKey),
      mid: text(record && record.mid),
      source: source,
      sourceLabel: SOURCE_LABEL[source],
      temporary: source === 'rule',
      scope: scope,
      rootCommentKey: text((record && record.rootCommentKey) || (record && record.commentKey)),
      summary: summaryOf(record, reasons),
      reasons: reasons,
      reasonText: reasonTextOf(source, reasons),
      rulesVersion: text(record && record.rulesVersion),
      at: record && typeof record.at === 'number' ? record.at : 0,
      timeText: formatTime(record && record.at, now),
      canRestore: true,
    };
  }

  // 视频切换后只展示当前视频的记录；aid 缺失时保持宽容，不排除任何记录，
  // 免得旧数据或没带 aid 的写入路径让面板整片变空。
  function belongsToVideo(recordAid, aid) {
    if (!aid) return true;
    if (recordAid === null || recordAid === undefined || recordAid === '') return true;
    return String(recordAid) === String(aid);
  }

  function metaAidOf(state, key) {
    var meta = state && state.meta && state.meta.comments;
    if (!meta || typeof meta !== 'object') return '';
    var entry = meta[key];
    return entry && typeof entry === 'object' ? entry.aid : '';
  }

  function manualRecordsOf(state, aid) {
    var source = state || {};
    var hidden = Array.isArray(source.manualHidden) ? source.manualHidden : [];
    var records = source.records && typeof source.records === 'object' ? source.records : {};
    var out = [];
    for (var i = 0; i < hidden.length; i += 1) {
      var key = hidden[i];
      if (typeof key !== 'string' || key === '') continue;
      if (!belongsToVideo(metaAidOf(source, key), aid)) continue;
      out.push(records[key] || { commentKey: key, scope: 'thread', rootCommentKey: key, at: 0 });
    }
    return out;
  }

  function sortByTimeDesc(items) {
    return items
      .map(function (item, index) { return { item: item, index: index }; })
      .sort(function (a, b) {
        if (b.item.at !== a.item.at) return b.item.at - a.item.at;
        return a.index - b.index;
      })
      .map(function (wrapper) { return wrapper.item; });
  }

  // 整串记录会吞掉它内部的楼中楼记录：恢复外层不应把刻意隐藏的回复一起放出来，
  // 面板也就不该为它们提供单独的恢复入口。
  function collapseThreads(records) {
    var threadHidden = Object.create(null);
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].scope !== 'thread') continue;
      threadHidden[records[i].commentKey] = true;
    }
    return records.filter(function (record) {
      if (record.scope !== 'reply') return true;
      return !threadHidden[record.rootCommentKey];
    });
  }

  function buildRecords(state, ruleRecords, entries, now, aid) {
    var byKey = Object.create(null);
    var manual = manualRecordsOf(state, aid);
    for (var i = 0; i < manual.length; i += 1) {
      byKey[text(manual[i].commentKey)] = describe(manual[i], 'manual', now);
    }
    var rules = Array.isArray(ruleRecords) ? ruleRecords : [];
    for (var j = 0; j < rules.length; j += 1) {
      var key = text(rules[j] && rules[j].commentKey);
      if (!key || byKey[key]) continue; // 手动记录优先：它解释了用户自己的动作
      if (!belongsToVideo(rules[j].aid, aid)) continue; // 规则记录同样跟着视频切换
      byKey[key] = describe(rules[j], 'rule', now);
    }
    var list = Object.keys(byKey).map(function (item) { return byKey[item]; });
    var withText = list.map(function (record) {
      var entry = entries && entries[record.commentKey];
      if (typeof entry === 'string' && entry !== '') record.summary = entry;
      return record;
    });
    return collapseThreads(sortByTimeDesc(withText));
  }

  function accountList(mids, meta, now) {
    var list = [];
    var source = Array.isArray(mids) ? mids : [];
    for (var i = 0; i < source.length; i += 1) {
      var mid = text(source[i]);
      if (!mid) continue;
      var stamp = meta && meta.accounts && meta.accounts[mid] ? meta.accounts[mid].at : 0;
      list.push({
        mid: mid,
        at: typeof stamp === 'number' ? stamp : 0,
        timeText: formatTime(stamp, now),
      });
    }
    return list;
  }

  function keptList(state, now) {
    var source = state || {};
    var kept = Array.isArray(source.keptException) ? source.keptException : [];
    var comments = source.meta && source.meta.comments ? source.meta.comments : {};
    var out = [];
    for (var i = 0; i < kept.length; i += 1) {
      var key = text(kept[i]);
      if (!key) continue;
      var stamp = comments[key] ? comments[key].at : 0;
      out.push({
        commentKey: key,
        summary: '评论 ' + key.slice(0, 8),
        at: typeof stamp === 'number' ? stamp : 0,
        timeText: formatTime(stamp, now),
      });
    }
    return out;
  }

  function buildView(options) {
    var opts = options || {};
    var state = opts.state || null;
    var view = viewOf(opts.view);
    var now = typeof opts.now === 'number' ? opts.now : Date.now();
    var records = buildRecords(state, opts.ruleRecords, opts.entries, now, opts.aid);
    var blocked = accountList(state && state.accountBlocked, state && state.meta, now);
    var allowed = accountList(state && state.accountAllowed, state && state.meta, now);
    var kept = keptList(state, now);

    return {
      view: view,
      aid: typeof opts.aid === 'string' ? opts.aid : '',
      title: view === VIEW_ACCOUNTS ? '账号名单' : view === VIEW_KEPT ? '保留例外' : '当前视频',
      records: view === VIEW_RECORDS ? records : [],
      accounts: { blocked: blocked, allowed: allowed },
      kept: kept,
      counts: {
        records: records.length,
        blocked: blocked.length,
        allowed: allowed.length,
        kept: kept.length,
      },
      emptyText: view === VIEW_ACCOUNTS ? '名单还是空的'
        : view === VIEW_KEPT ? '还没有保留例外' : '当前视频还没有隐藏记录',
    };
  }

  function entryText(body) {
    if (!body || typeof body !== 'object') return '';
    return typeof body.textContent === 'string' ? body.textContent.trim() : '';
  }

  function collectEntries(entries) {
    var out = Object.create(null);
    var list = Array.isArray(entries) ? entries : [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      var key = entry && entry.observation && entry.observation.commentKey;
      if (!key) continue;
      var body = entryText(entry.body);
      if (body) out[key] = body;
    }
    return out;
  }

  function tag(source) {
    return '<span class="tag ' + (source === 'manual' ? 'tag-manual' : 'tag-rule') + '">'
      + escapeHTML(SOURCE_LABEL[source]) + '</span>';
  }

  function renderRecord(record) {
    var parts = [
      '<li class="row" data-key="' + escapeHTML(record.commentKey) + '">',
      '<p class="summary">' + tag(record.source) + escapeHTML(record.summary) + '</p>',
      '<p class="meta">' + escapeHTML(record.reasonText) + '</p>',
    ];
    if (record.reasons.length) {
      var clues = record.reasons.map(function (clue) {
        return escapeHTML(clue.label)
          + (clue.fragment ? '「' + escapeHTML(clue.fragment) + '」' : '')
          + (clue.strengthText ? ' · ' + escapeHTML(clue.strengthText) : '');
      }).join('、');
      parts.push('<p class="meta">线索：' + clues + '</p>');
    }
    parts.push('<p class="meta">规则版本：' + escapeHTML(record.rulesVersion || '未记录')
      + ' · ' + escapeHTML(record.timeText) + '</p>');
    if (record.temporary) {
      parts.push('<p class="meta">只在本次页面加载生效，不会跨刷新保留</p>');
    }
    parts.push('<button type="button" class="act" data-act="restore" data-key="'
      + escapeHTML(record.commentKey) + '">恢复这条</button>');
    parts.push('</li>');
    return parts.join('');
  }

  function renderRecords(model) {
    if (!model.records.length) return '<p class="empty">' + escapeHTML(model.emptyText) + '</p>';
    return '<ul class="list">' + model.records.map(renderRecord).join('') + '</ul>';
  }

  function renderAccounts(model) {
    var groups = [
      { title: '账号屏蔽', items: model.accounts.blocked, act: 'unblock', label: '取消屏蔽' },
      { title: '保留账号', items: model.accounts.allowed, act: 'unallow', label: '取消保留' },
    ];
    var html = '';
    for (var i = 0; i < groups.length; i += 1) {
      var group = groups[i];
      html += '<div class="group" data-group="' + escapeHTML(group.act) + '"><h2>'
        + escapeHTML(group.title) + '（' + group.items.length + '）</h2>';
      if (!group.items.length) {
        html += '<p class="note">暂无</p>';
      } else {
        html += '<ul>';
        for (var j = 0; j < group.items.length; j += 1) {
          var item = group.items[j];
          html += '<li class="row" data-mid="' + escapeHTML(item.mid) + '">'
            + '<p class="summary">mid ' + escapeHTML(item.mid) + '</p>'
            + '<p class="meta">' + escapeHTML(item.timeText) + '</p>'
            + '<button type="button" class="act act-danger" data-act="' + group.act
            + '" data-mid="' + escapeHTML(item.mid) + '">' + escapeHTML(group.label) + '</button>'
            + '</li>';
        }
        html += '</ul>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // 保留例外单独成一个视图：这些评论是被「恢复」过的，页面里本来就该看得见，
  // 所以只做查阅，不给恢复入口（恢复入口属于被隐藏的记录）。
  function renderKept(model) {
    if (!model.kept.length) return '<p class="empty">' + escapeHTML(model.emptyText) + '</p>';
    return '<ul class="list">' + model.kept.map(function (item) {
      return '<li class="row" data-key="' + escapeHTML(item.commentKey) + '">'
        + '<p class="summary">' + escapeHTML(item.summary) + '</p>'
        + '<p class="meta">' + escapeHTML(item.timeText) + '</p></li>';
    }).join('') + '</ul>';
  }

  function render(model) {
    var tabs = [
      { view: VIEW_RECORDS, label: '当前视频（' + model.counts.records + '）' },
      { view: VIEW_ACCOUNTS, label: '账号名单（' + (model.counts.blocked + model.counts.allowed) + '）' },
      { view: VIEW_KEPT, label: '保留例外（' + model.counts.kept + '）' },
    ].map(function (tab) {
      return '<button type="button" class="tab" role="tab" data-act="view" data-view="'
        + tab.view + '" aria-selected="' + (model.view === tab.view ? 'true' : 'false') + '">'
        + escapeHTML(tab.label) + '</button>';
    }).join('');

    var body = model.view === VIEW_ACCOUNTS ? renderAccounts(model)
      : model.view === VIEW_KEPT ? renderKept(model)
        : renderRecords(model);

    return [
      '<style>', SHADOW_STYLE, '</style>',
      '<div class="panel" data-view="' + model.view + '">',
      '<div class="head"><h1>' + escapeHTML(model.title) + '</h1>',
      '<button type="button" class="act" data-act="close">关闭</button></div>',
      '<div class="tabs" role="tablist">', tabs, '</div>',
      '<div class="body">',
      model.view === VIEW_RECORDS
        ? '<button type="button" class="act act-danger" data-act="clear-records">清空规则记录</button>'
        : '',
      body,
      '</div></div>',
    ].join('');
  }

  function create(options) {
    var opts = options || {};
    var doc = opts.doc || (typeof document === 'undefined' ? null : document);
    var controller = opts.controller || null;
    var records = opts.records
      || (controller && controller.records)
      || { list: function () { return []; }, clear: function () {} };
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var view = viewOf(opts.view);
    var aid = typeof opts.aid === 'string' ? opts.aid : '';
    var open = false;
    var host = null;
    var shadow = null;

    function stateOf() {
      if (opts.state) return opts.state;
      if (controller && typeof controller.getState === 'function') return controller.getState();
      return null;
    }

    function entriesOf() {
      var last = controller && typeof controller.last === 'function' ? controller.last() : null;
      return collectEntries(last && last.entries);
    }

    function model() {
      return buildView({
        state: stateOf(),
        ruleRecords: records && typeof records.list === 'function' ? records.list() : [],
        entries: entriesOf(),
        view: view,
        aid: aid,
        now: now(),
      });
    }

    // 切视频时由 content 侧或 sidepanel 推入当前 aid，面板据此只渲染本视频的记录。
    function setContext(next) {
      var source = next || {};
      if (source.aid !== undefined) aid = typeof source.aid === 'string' ? source.aid : '';
      return aid;
    }

    function paint() {
      if (!shadow) return null;
      shadow.innerHTML = render(model());
      return shadow;
    }

    function build() {
      host = doc.createElement('div');
      host.setAttribute('id', HOST_ID);
      host.setAttribute(HOST_ATTR, 'panel');
      host.setAttribute('style', HOST_STYLE);
      shadow = host.attachShadow({ mode: 'open' });
      shadow.addEventListener('click', onClick);
      return host;
    }

    function call(fn) {
      try {
        return fn();
      } catch (error) {
        return false;
      }
    }

    function onClick(event) {
      var target = event && event.target ? event.target : null;
      var button = target && typeof target.closest === 'function'
        ? target.closest('[data-act]')
        : null;
      if (!button) return;
      if (event && event.preventDefault) event.preventDefault();
      var act = button.getAttribute('data-act');
      var done = null;
      if (act === 'restore') {
        var key = button.getAttribute('data-key');
        if (controller && typeof controller.restoreComment === 'function' && key) {
          done = call(function () { return controller.restoreComment(key); });
        }
      } else if (act === 'unblock') {
        var mid = button.getAttribute('data-mid');
        if (controller && typeof controller.unblockAccount === 'function' && mid) {
          done = call(function () { return controller.unblockAccount(mid); });
        }
      } else if (act === 'unallow') {
        var allowedMid = button.getAttribute('data-mid');
        if (controller && typeof controller.removeAllowedAccount === 'function' && allowedMid) {
          done = call(function () { return controller.removeAllowedAccount(allowedMid); });
        }
      } else if (act === 'clear-records') {
        if (records && typeof records.clear === 'function') {
          done = call(function () { return records.clear(); });
        }
      } else if (act === 'view') {
        setView(button.getAttribute('data-view'));
        return;
      } else if (act === 'close') {
        close();
        return;
      }
      paint();
      if (done && typeof done.then === 'function') {
        done.then(paint, paint);
      }
    }

    function setView(next) {
      var value = viewOf(next);
      view = value;
      paint();
      return view;
    }

    function openPanel() {
      if (!doc || !doc.body) return null;
      if (!host) build();
      if (!host.parentNode) doc.body.appendChild(host);
      open = true;
      paint();
      return host;
    }

    function close() {
      open = false;
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    function toggle() {
      if (open) {
        close();
        return false;
      }
      openPanel();
      return true;
    }

    return {
      open: openPanel,
      close: close,
      toggle: toggle,
      isOpen: function () { return open; },
      setView: setView,
      getView: function () { return view; },
      setContext: setContext,
      getAid: function () { return aid; },
      render: paint,
      model: model,
      root: function () { return shadow; },
      destroy: function () {
        if (shadow) shadow.removeEventListener('click', onClick);
        close();
        shadow = null;
        host = null;
      },
    };
  }

  NS.panel = {
    VERSION: VERSION,
    VIEWS: [VIEW_RECORDS, VIEW_ACCOUNTS, VIEW_KEPT],
    HOST_ID: HOST_ID,
    SOURCE_LABEL: SOURCE_LABEL,
    formatTime: formatTime,
    buildView: buildView,
    create: create,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
