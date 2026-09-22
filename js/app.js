/* ══════════════════════════════════════════════════════════
   app.js — 装配：工具栏、日程弹窗、导入导出、快捷键
   ══════════════════════════════════════════════════════════ */

var App = (function () {
  'use strict';

  var dlgEv, editingId = null, evColor = 'blue';
  var toastEl, toastTimer = null;

  /* ── 启动 ────────────────────────────────────────────────── */

  function boot() {
    Sched.load();

    // 数据一变就重画。放在这里而不是各处手动调用，是为了保证
    // 任何改动路径（格子里的快速输入、拖拽改期、导入、课表生成…）
    // 都不会漏掉刷新。
    Sched.onChange(refresh);

    initSync();
    initStorageWatch();

    Month.init({ onSelect: onSelectDay });
    Month.bind();
    Month.render();
    Day.init();
    Tasks.init();
    Courses.init();

    initEventDialog();
    initToolbar();
    initShortcuts();
    initThemeWatch();

    document.addEventListener('sched:edit-event', function (e) { openEvent(e.detail); });
    document.addEventListener('sched:new-event', function (e) {
      openEvent(null, e.detail);
    });

    // 打开时默认展开今天
    onSelectDay(Sched.ymd(new Date()));
  }

  function onSelectDay(dateStr) {
    Day.open(dateStr);
    Tasks.show(dateStr);
  }

  /* ── 云同步 ──────────────────────────────────────────────── */

  function initSync() {
    Sync.init({
      // 编辑弹窗开着的时候别用云端内容盖掉本地：弹窗里还攥着
      // editingId 和一堆旧字段值，盖掉之后用户一保存就把旧值写回去了。
      // 云同步自己的弹窗不算——用户正在里面点「保存并同步」呢，
      // 一挡就变成「点了没反应」。
      canAdopt: function () {
        var open = document.querySelector('dialog[open]');
        return !open || open.id === 'dlg-sync';
      }
    });
    SyncUI.init();
    if (Sync.isConfigured()) {
      Sync.start();
      Sync.pull();
    }
  }

  /**
   * 同一个浏览器开两个标签页时，另一页写的数据这里收得到。
   * 不管的话，两个标签页各凭内存里那份旧的 state 覆盖 localStorage，
   * 后写的把先写的整份抹掉——这个问题在加同步之前就存在了，
   * 而加了同步会被原样搬到云端。
   */
  function initStorageWatch() {
    window.addEventListener('storage', function (ev) {
      if (ev.key !== Sched.KEY) return;
      var dirty = Sched.state.lastSeq !== (Sync.config && Sync.config.syncedSeq);
      if (dirty) {
        toast('另一个标签页改了数据，本页也有没同步的改动，建议刷新');
        return;
      }
      Sched.load();                 // 重新读一遍 localStorage
      if (Sync.config) Sync.config.syncedSeq = Sched.state.lastSeq;
      refresh();
    });
  }

  /* ── 日程编辑弹窗 ────────────────────────────────────────── */

  function initEventDialog() {
    dlgEv = document.getElementById('dlg-event');
    buildSwatches();

    document.getElementById('ev-cancel').addEventListener('click', function () { dlgEv.close(); });

    document.getElementById('ev-delete').addEventListener('click', function () {
      if (!editingId) return;
      var e = Sched.getEvent(editingId);
      if (!e) return;
      if (!confirm('删除「' + e.title + '」？')) return;
      Sched.removeEvent(editingId);
      dlgEv.close();
      refresh();
    });

    document.getElementById('form-event').addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveEvent();
    });

    // 改开始时间时，结束时间不早于开始
    document.getElementById('ev-start').addEventListener('change', function () {
      var s = document.getElementById('ev-start').value;
      var e = document.getElementById('ev-end').value;
      if (!e || Sched.toMin(e) <= Sched.toMin(s)) {
        document.getElementById('ev-end').value = Sched.minToTime(Sched.toMin(s) + 60);
      }
    });
  }

  /**
   * @param {string|null} id      要编辑的日程 id
   * @param {object}      preset  新建时的预填 { date, start, end }
   */
  function openEvent(id, preset) {
    editingId = id || null;
    var e = id ? Sched.getEvent(id) : null;

    document.getElementById('ev-title-h').textContent = e ? '编辑日程' : '新建日程';
    document.getElementById('ev-delete').hidden = !e;

    var date, start, end;
    if (e) {
      date = e.date; start = e.start; end = e.end;
      document.getElementById('ev-title').value = e.title;
      document.getElementById('ev-note').value = e.note || '';
      document.getElementById('ev-important').checked = !!e.important;
      document.getElementById('ev-done').checked = !!e.done;
      evColor = e.color;
    } else {
      var p = preset || {};
      date  = p.date || Month.getSelected() || Sched.ymd(new Date());
      start = p.start || '09:00';
      end   = p.end || Sched.minToTime(Sched.toMin(start) + 60);
      document.getElementById('ev-title').value = '';
      document.getElementById('ev-note').value = '';
      document.getElementById('ev-important').checked = false;
      document.getElementById('ev-done').checked = false;
      evColor = 'blue';
    }

    document.getElementById('ev-date').value  = date;
    document.getElementById('ev-start').value = start;
    document.getElementById('ev-end').value   = end;
    paintSwatches();

    dlgEv.showModal();
    setTimeout(function () { document.getElementById('ev-title').focus(); }, 30);
  }

  function saveEvent() {
    var title = document.getElementById('ev-title').value.trim();
    if (!title) return;

    var date  = document.getElementById('ev-date').value;
    var start = document.getElementById('ev-start').value;
    var end   = document.getElementById('ev-end').value;
    if (!date || !start) { toast('日期和开始时间是必填的'); return; }
    if (!end || Sched.toMin(end) <= Sched.toMin(start)) {
      end = Sched.minToTime(Sched.toMin(start) + 60);
    }

    var data = {
      date: date, start: start, end: end, title: title,
      note: document.getElementById('ev-note').value.trim(),
      color: evColor,
      important: document.getElementById('ev-important').checked,
      done: document.getElementById('ev-done').checked
    };

    if (editingId) Sched.updateEvent(editingId, data);
    else Sched.addEvent(data);

    dlgEv.close();
    Month.gotoDate(date);
    refresh();
    toast(editingId ? '已保存' : '已添加');
  }

  /* ── 颜色选择器 ──────────────────────────────────────────── */

  function buildSwatches() {
    var wrap = document.getElementById('ev-colors');
    wrap.innerHTML = Sched.PALETTE.map(function (p) {
      return '<button type="button" class="sw" data-color="' + p.id + '"' +
             ' title="' + p.name + '" aria-pressed="false"></button>';
    }).join('');

    wrap.querySelectorAll('.sw').forEach(function (b) {
      b.style.background = Sched.colorHex(b.dataset.color);
      b.addEventListener('click', function () {
        evColor = b.dataset.color;
        paintSwatches();
      });
    });
  }

  function paintSwatches() {
    document.querySelectorAll('#ev-colors .sw').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.color === evColor));
    });
  }

  /* ── 工具栏 ──────────────────────────────────────────────── */

  function initToolbar() {
    document.getElementById('btn-prev').addEventListener('click', function () { Month.shift(-1); });
    document.getElementById('btn-next').addEventListener('click', function () { Month.shift(1); });

    document.getElementById('btn-today').addEventListener('click', goToday);

    document.getElementById('btn-month').addEventListener('click', function () {
      jumpMonth();
    });

    // 界面偏好，不是数据：存本机、不 commit，免得触发一次云同步推送
    var chk = document.getElementById('chk-important');
    chk.checked = Sched.ui.onlyImportant;
    chk.addEventListener('change', function () {
      Sched.ui.onlyImportant = chk.checked;
      Sched.saveUi();
      Month.render();
    });

    document.getElementById('btn-tasks').addEventListener('click', function () {
      Tasks.toggle();
    });

    /* ⋯ 菜单 */
    var menu = document.getElementById('menu');
    document.getElementById('btn-menu').addEventListener('click', function (ev) {
      ev.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', function () { menu.hidden = true; });

    menu.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (!b) return;
      menu.hidden = true;
      doAction(b.dataset.act);
    });

    /* 导入 */
    var file = document.getElementById('file-import');
    document.getElementById('file-import').addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          // 导入会整份替换，把现在这份先存下来——导入的若是半年前的备份，
          // 不备份就再也找不回来了（而且它还会顺着同步推上云端）
          Sync.stash('导入之前', JSON.parse(Sched.serialize()));
          Sched.importJSON(String(reader.result));
          refresh();
          Courses.render();
          toast(Sync.isConfigured() ? '导入成功，稍后会同步到云端' : '导入成功');
        } catch (err) {
          toast('导入失败：文件格式不对');
          console.error(err);
        }
      };
      reader.readAsText(f);
      file.value = '';
    });
  }

  /** 「今天」按钮和 ⋯ 菜单里的那一项共用 */
  function goToday() {
    Month.gotoToday();
    Day.open(Month.getSelected());
  }

  function doAction(act) {
    if (act === 'sync') {
      SyncUI.open();
    } else if (act === 'today') {
      goToday();
    } else if (act === 'courses') {
      Courses.open();
    } else if (act === 'export') {
      var blob = new Blob([Sched.exportJSON()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'schedule-' + Sched.ymd(new Date()) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已导出');
    } else if (act === 'import') {
      document.getElementById('file-import').click();
    } else if (act === 'demo') {
      loadDemo();
    } else if (act === 'clear') {
      var synced = Sync.isConfigured();
      var msg = '清空全部日程、提醒和课程？此操作不可撤销。';
      if (synced) msg += '\n\n云同步开着，云端那份也会一起清空。' +
                         '（云端是 git 仓库，历史记录里还能翻回上一版。）';
      if (!confirm(msg)) return;
      // 先留一份本机的，万一清错了还能捞回来
      Sync.stash('清空全部数据之前', JSON.parse(Sched.serialize()));
      Sched.replaceAll(Sched.defaultState());
      refresh();
      Courses.render();
      if (synced) Sync.push(true);      // 手动推，绕过「空数据不自动推」的保护
      else toast('已清空');
    }
  }

  /** 月份快速跳转 */
  function jumpMonth() {
    var cur = Month.getView();
    var s = prompt('跳到哪个月？（格式 2026-09）', cur.y + '-' + Sched.pad(cur.m + 1));
    if (!s) return;
    var m = /^(\d{4})\D+(\d{1,2})$/.exec(s.trim());
    if (!m) { toast('格式不对，示例：2026-09'); return; }
    Month.goto(+m[1], +m[2] - 1);
  }

  /* ── 示例数据 ────────────────────────────────────────────── */

  function loadDemo() {
    if (!confirm('载入一组示例课程？会覆盖当前的课程设置（日程保留）。')) return;

    var thisMonday = Sched.mondayOf(new Date());
    var demo = [
      { name: '高等数学',   teacher: '张老师', location: '教三-201', color: 'blue',
        fromWeek: 1, toWeek: 16, parity: 'all',
        slots: [{ weekday: 1, from: 1, to: 2 }, { weekday: 3, from: 3, to: 4 }] },
      { name: '线性代数',   teacher: '李老师', location: '主楼-315', color: 'violet',
        fromWeek: 1, toWeek: 16, parity: 'all',
        slots: [{ weekday: 2, from: 1, to: 2 }, { weekday: 4, from: 5, to: 6 }] },
      { name: '大学英语',   teacher: 'Smith',  location: '外语楼-108', color: 'green',
        fromWeek: 1, toWeek: 12, parity: 'odd',
        slots: [{ weekday: 3, from: 1, to: 2 }] },
      { name: '大学物理',   teacher: '王老师', location: '理科楼-402', color: 'orange',
        fromWeek: 1, toWeek: 16, parity: 'all',
        slots: [{ weekday: 5, from: 3, to: 4 }] },
      { name: '程序设计',   teacher: '陈老师', location: '机房-6', color: 'teal',
        fromWeek: 2, toWeek: 14, parity: 'all',
        slots: [{ weekday: 4, from: 9, to: 10 }, { weekday: 5, from: 9, to: 10 }] }
    ];

    Sched.state.courses = [];
    demo.forEach(function (d) { Sched.addCourse(d); });
    Sched.settings.termStart = Sched.ymd(thisMonday);
    Sched.settings.skipped = [];
    Sched.commit();

    var n = Sched.regenerateCourses();
    refresh();
    Courses.render();
    toast('已载入 ' + demo.length + ' 门示例课程，生成 ' + n + ' 条日程');
  }

  /* ── 快捷键 ──────────────────────────────────────────────── */

  /* 会吞掉按键的输入类控件。注意只列「真的在输入文字」的类型：
     复选框/单选框上按方向键本来就没事干，那种情况应该让快捷键照常生效。 */
  var TYPING_TYPES = {
    text: 1, search: 1, url: 1, tel: 1, email: 1, password: 1, number: 1,
    date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1
  };

  function isTyping(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT') return !!TYPING_TYPES[(el.type || 'text').toLowerCase()];
    return false;
  }

  function initShortcuts() {
    document.addEventListener('keydown', function (ev) {
      if (isTyping(ev.target)) return;
      if (document.querySelector('dialog[open]')) return;

      if (ev.key === 'ArrowLeft')  { ev.preventDefault(); Month.shift(-1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); Month.shift(1); }
      else if (ev.key === 't' || ev.key === 'T') {
        Month.gotoToday(); Day.open(Month.getSelected());
      }
      else if (ev.key === 'n' || ev.key === 'N') {
        var d = Month.getSelected() || Sched.ymd(new Date());
        document.dispatchEvent(new CustomEvent('sched:new-event', {
          detail: { date: d, start: '09:00', end: '10:00' }
        }));
      }
      else if (ev.key === 'm' || ev.key === 'M') { Tasks.focusInput(); }
      else if (ev.key === 'c' || ev.key === 'C') { Courses.open(); }
      else if (ev.key === 'Escape') { Day.close(); }
    });
  }

  function initThemeWatch() {
    if (typeof matchMedia === 'undefined') return;
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var fn = function () {
      Month.render();
      if (Day.isOpen()) Day.render();
      if (document.getElementById('dlg-courses').open) Courses.render();
    };
    if (mq.addEventListener) mq.addEventListener('change', fn);
    else if (mq.addListener) mq.addListener(fn);
  }

  /* ── 杂项 ────────────────────────────────────────────────── */

  function refresh() {
    Month.render();
    if (Day.isOpen()) Day.render();
    Tasks.render();
    if (document.getElementById('dlg-courses').open) Courses.render();
  }

  function toast(msg) {
    toastEl = toastEl || document.getElementById('toast');
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { toast: toast, refresh: refresh, openEvent: openEvent };
})();
