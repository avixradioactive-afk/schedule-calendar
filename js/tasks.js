/* ══════════════════════════════════════════════════════════
   tasks.js — 左侧任务栏：这一天要做的所有事
   提醒（备忘录）+ 当天的日程，都能直接勾掉。
   ══════════════════════════════════════════════════════════ */

var Tasks = (function () {
  'use strict';

  var panel, dateEl, subEl, bodyEl, inputEl;
  var current = null;      // 当前显示的日期，跟着月历选中日走
  var tucked = false;      // 窄屏上临时收起（不动设置里的偏好）

  /* 和 CSS 里的 @media (max-width: 900px) 是同一个断点；
     CSS 媒体查询没法跟 JS 共用常量，改一处记得改另一处。 */
  function isNarrow() {
    return typeof matchMedia !== 'undefined' && matchMedia('(max-width: 900px)').matches;
  }

  function init() {
    panel   = document.getElementById('taskpanel');
    dateEl  = document.getElementById('tp-date');
    subEl   = document.getElementById('tp-sub');
    bodyEl  = document.getElementById('tp-body');
    inputEl = document.getElementById('tp-input');

    // 委托挂一次就够，render 只换 innerHTML
    Todo.bind(bodyEl);

    document.getElementById('tp-hide').addEventListener('click', function () {
      Sched.ui.showTasks = false;
      Sched.saveUi();
      render();
    });

    document.getElementById('form-tpadd').addEventListener('submit', function (ev) {
      ev.preventDefault();
      addMemo();
    });
    // 输入框里敲字时别触发全局快捷键
    inputEl.addEventListener('keydown', function (ev) { ev.stopPropagation(); });

    render();
  }

  function show(dateStr) {
    current = dateStr || Sched.ymd(new Date());
    // 窄屏上这一栏是盖住日历的抽屉，选完日子就自动让开。
    // 只是临时收起，设置里的偏好留着——回到大屏还要原样展开。
    if (isNarrow()) tucked = true;
    render();
  }

  function toggle() {
    // 看的是「现在实际显示没有」，而不是存下来的值：
    // 窄屏上可能已经被自动收起了，存着的却还是 true。
    Sched.ui.showTasks = panel.hidden;
    tucked = false;
    Sched.saveUi();
    render();
    if (Sched.ui.showTasks && inputEl) inputEl.focus();
  }

  /* ── 渲染 ── */

  function render() {
    applyVisible();
    if (!current) return;

    var d = Sched.parseYmd(current);
    var isToday = current === Sched.ymd(new Date());
    dateEl.textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' +
                         Sched.WEEKDAY_CN[Sched.weekdayIndex(d)];

    var open = [], done = [];
    Sched.memosOn(current).forEach(function (m) {
      (m.done ? done : open).push({ kind: 'memo', o: m });
    });
    Sched.eventsOn(current).forEach(function (e) {
      (e.done ? done : open).push({ kind: 'event', o: e });
    });

    var memos = open.filter(function (x) { return x.kind === 'memo'; });
    var evs   = open.filter(function (x) { return x.kind === 'event'; });

    var left = Sched.openCount(current);   // 提醒 + 日程里没做的
    var subs = [];
    if (isToday) subs.push('今天');
    if (left) subs.push('还有 ' + left + ' 件没做');
    else if (done.length) subs.push('已全部完成');
    else subs.push('暂无安排');
    subEl.textContent = subs.join(' · ');

    var html = '';

    html += section('提醒', memos.length,
      memos.map(function (x) { return Todo.rowHTML(memoItem(x.o)); }).join(''),
      '还没有提醒，在下面加一条');

    html += section('日程', evs.length,
      evs.map(function (x) { return Todo.rowHTML(evItem(x.o)); }).join(''),
      '这天没有日程');

    if (done.length) {
      html += '<details class="tp-done">' +
                '<summary>已完成 ' + done.length + ' 件</summary>' +
                '<div class="tp-list">' +
                  done.map(function (x) {
                    return Todo.rowHTML(x.kind === 'memo' ? memoItem(x.o) : evItem(x.o));
                  }).join('') +
                '</div>' +
              '</details>';
    }

    bodyEl.innerHTML = html;
    Todo.paint(bodyEl);
  }

  function section(title, n, rows, emptyHint) {
    return '<section class="tp-sec">' +
             '<h3 class="tp-h">' + title +
               (n ? ' <span class="tp-n">' + n + '</span>' : '') + '</h3>' +
             (rows
               ? '<div class="tp-list">' + rows + '</div>'
               : '<p class="tp-empty">' + emptyHint + '</p>') +
           '</section>';
  }

  function memoItem(m) {
    return { ref: 'memo:' + m.id, text: m.text, done: m.done };
  }

  function evItem(e) {
    return {
      ref: 'event:' + e.id,
      text: e.title,
      sub: e.start + '–' + e.end + (e.note ? ' · ' + e.note : ''),
      done: e.done,
      color: e.color
    };
  }

  function applyVisible() {
    var on = Sched.ui.showTasks !== false && !tucked;
    panel.hidden = !on;
    var btn = document.getElementById('btn-tasks');
    if (btn) {
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? '收起任务栏' : '展开任务栏 (M)';
    }
  }

  /* ── 添加提醒 ── */

  function addMemo() {
    var v = inputEl.value.trim();
    if (!v) return;
    if (!current) current = Sched.ymd(new Date());
    Sched.addMemo({ date: current, text: v });
    inputEl.value = '';
    App.toast('已添加提醒');
  }

  /** 快捷键 M：展开任务栏并把光标放进输入框 */
  function focusInput() {
    if (Sched.ui.showTasks === false || tucked) {
      Sched.ui.showTasks = true;
      tucked = false;
      Sched.saveUi();
      render();
    }
    inputEl.focus();
  }

  return {
    init: init, render: render, show: show,
    toggle: toggle, focusInput: focusInput
  };
})();
