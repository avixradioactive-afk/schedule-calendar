/* ══════════════════════════════════════════════════════════
   day.js — 当日面板（按小时展开的时间轴）
   ══════════════════════════════════════════════════════════ */

var Day = (function () {
  'use strict';

  var panel, bodyEl, hoursEl, eventsEl, nowEl, dateEl, subEl;
  var current = null;       // 当前显示的日期 YYYY-MM-DD
  var HOUR_H = 58;
  var SNAP = 15;            // 点击空白处新建时，时间吸附到 15 分钟
  var nowTimer = null;

  function init() {
    panel    = document.getElementById('daypanel');
    bodyEl   = document.getElementById('dp-body');
    hoursEl  = document.getElementById('tl-hours');
    eventsEl = document.getElementById('tl-events');
    nowEl    = document.getElementById('tl-now');
    dateEl   = document.getElementById('dp-date');
    subEl    = document.getElementById('dp-sub');

    HOUR_H = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--hour-h')
    ) || 58;

    buildHours();

    document.getElementById('dp-close').addEventListener('click', close);
    document.getElementById('dp-add').addEventListener('click', function () {
      if (!current) return;
      var t = suggestTime(current);
      document.dispatchEvent(new CustomEvent('sched:new-event', {
        detail: { date: current, start: t.start, end: t.end }
      }));
    });

    // 点时间轴空白 → 在该时刻新建。
    // 以 eventsEl 的顶边为 0 点，这样不受容器 padding / 滚动的影响。
    bodyEl.addEventListener('click', function (ev) {
      if (ev.target.closest('.ev-block')) return;
      if (!current) return;
      var y = ev.clientY - eventsEl.getBoundingClientRect().top;
      var min = Math.max(0, Math.min(1425, Math.round((y / HOUR_H * 60) / SNAP) * SNAP));
      document.dispatchEvent(new CustomEvent('sched:new-event', {
        detail: { date: current, start: Sched.minToTime(min), end: Sched.minToTime(min + 60) }
      }));
    });

    // 点已有日程 → 编辑
    eventsEl.addEventListener('click', function (ev) {
      var blk = ev.target.closest('.ev-block');
      if (!blk) return;
      ev.stopPropagation();
      document.dispatchEvent(new CustomEvent('sched:edit-event', { detail: blk.dataset.id }));
    });

    eventsEl.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });

    // 每分钟刷新"现在"红线
    nowTimer = setInterval(tickNow, 30000);
  }

  function buildHours() {
    var h = '';
    for (var i = 0; i < 24; i++) {
      h += '<div class="tl-hour"><span>' + Sched.pad(i) + ':00</span></div>';
    }
    hoursEl.innerHTML = h;
    eventsEl.style.height = (24 * HOUR_H) + 'px';
    eventsEl.style.top = '10px';
  }

  /* ── 开关 ── */

  function open(dateStr, opts) {
    panel.hidden = false;
    show(dateStr, opts);
  }

  function close() {
    panel.hidden = true;
  }

  function isOpen() { return !panel.hidden; }

  function show(dateStr, opts) {
    current = dateStr;
    render();
    if (opts && opts.keepScroll) return;
    scrollToSensible();
  }

  function scrollToSensible() {
    var target;
    if (current === Sched.ymd(new Date())) {
      var now = new Date();
      target = (now.getHours() + now.getMinutes() / 60) * HOUR_H - bodyEl.clientHeight * 0.35;
    } else {
      target = 7 * HOUR_H;
    }
    bodyEl.scrollTop = Math.max(0, Math.min(target, bodyEl.scrollHeight));
  }

  /* ── 渲染 ── */

  function render() {
    if (!current) return;

    var d = Sched.parseYmd(current);
    var wd = Sched.weekdayIndex(d);
    var wn = Sched.weekNumber(current);

    dateEl.textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' + Sched.WEEKDAY_CN[wd];

    var subs = [];
    if (current === Sched.ymd(new Date())) subs.push('今天');
    if (wn > 0) subs.push('第 ' + wn + ' 教学周');
    var evs = Sched.eventsOn(current);
    var total = evs.reduce(function (s, e) {
      return s + Math.max(0, Sched.toMin(e.end) - Sched.toMin(e.start));
    }, 0);
    if (evs.length) {
      subs.push(evs.length + ' 项 · 共 ' + (Math.round(total / 6) / 10) + ' 小时');
    }
    subEl.textContent = subs.join(' · ');

    eventsEl.innerHTML = evs.length
      ? renderBlocks(evs)
      : '<div class="dp-empty">这一天还没有安排。<br>点左边任意时刻，或按 N 新建。</div>';

    // 颜色要用元素上的 data-color 解析，所以插进 DOM 之后再上色
    var blocks = eventsEl.querySelectorAll('.ev-block');
    for (var i = 0; i < blocks.length; i++) {
      Sched.applyColors(blocks[i], blocks[i].dataset.color);
    }

    tickNow();
  }

  /**
   * 时间轴上的块。
   * 重叠的日程用「泳道」错开：先按开始时间分组，一组里每条找第一条空泳道。
   */
  function renderBlocks(evs) {
    var items = evs.map(function (e) {
      var s = Sched.toMin(e.start);
      var t = Math.max(Sched.toMin(e.end), s + 15);
      return { e: e, s: s, t: t };
    }).sort(function (a, b) { return a.s - b.s || b.t - a.t; });

    // 分成互相重叠的簇
    var clusters = [], cur = null;
    items.forEach(function (it) {
      if (!cur || it.s >= cur.end) { cur = { end: it.t, items: [] }; clusters.push(cur); }
      cur.items.push(it);
      cur.end = Math.max(cur.end, it.t);
    });

    clusters.forEach(function (cl) {
      var laneEnds = [];
      cl.items.forEach(function (it) {
        var li = -1;
        for (var i = 0; i < laneEnds.length; i++) {
          if (laneEnds[i] <= it.s) { li = i; break; }
        }
        if (li === -1) { li = laneEnds.length; laneEnds.push(0); }
        laneEnds[li] = it.t;
        it.lane = li;
      });
      cl.lanes = laneEnds.length;
    });

    var html = '';
    clusters.forEach(function (cl) {
      cl.items.forEach(function (it) {
        var e = it.e;
        var top = it.s / 60 * HOUR_H;
        var h = Math.max(20, (it.t - it.s) / 60 * HOUR_H - 3);
        var wPct = 100 / cl.lanes;
        var left = it.lane * wPct;
        var cls = 'ev-block' + (h < 46 ? ' short' : '');

        html += '<div class="' + cls + '" data-id="' + e.id + '"' +
                ' style="top:' + top.toFixed(1) + 'px;height:' + h.toFixed(1) + 'px;' +
                'left:calc(' + left.toFixed(3) + '% + ' + (it.lane ? 3 : 0) + 'px);' +
                'width:calc(' + wPct.toFixed(3) + '% - 4px)"' +
                ' data-color="' + Sched.esc(e.color) + '"' +
                ' title="' + Sched.esc(e.start + '–' + e.end + '  ' + e.title + (e.note ? '\n' + e.note : '')) + '">' +
                '<div class="eb-t">' + Sched.esc(e.title) + '</div>' +
                (h >= 46
                  ? '<div class="eb-m">' + Sched.esc(e.start + '–' + e.end) +
                    (e.note ? ' · ' + Sched.esc(e.note) : '') + '</div>'
                  : '<div class="eb-m">' + Sched.esc(e.start) + '</div>') +
                '</div>';
      });
    });

    return html;
  }

  function tickNow() {
    if (!current) { nowEl.hidden = true; return; }
    if (current !== Sched.ymd(new Date())) { nowEl.hidden = true; return; }

    var now = new Date();
    var min = now.getHours() * 60 + now.getMinutes();
    nowEl.hidden = false;
    nowEl.style.top = (10 + min / 60 * HOUR_H) + 'px';
  }

  /** 空白处新建时的建议时间：今天取当前时刻之后，其它日子取 09:00 */
  function suggestTime(dateStr) {
    if (dateStr === Sched.ymd(new Date())) {
      var now = new Date();
      var m = Math.ceil((now.getHours() * 60 + now.getMinutes()) / SNAP) * SNAP;
      m = Math.min(m, 1380);
      return { start: Sched.minToTime(m), end: Sched.minToTime(m + 60) };
    }
    return { start: '09:00', end: '10:00' };
  }

  return {
    init: init, open: open, close: close, show: show,
    render: render, isOpen: isOpen, getDate: function () { return current; }
  };
})();
