/* ══════════════════════════════════════════════════════════
   courses.js — 课程表：网格批量编辑 + 学期设置 + 生成到日历
   ══════════════════════════════════════════════════════════ */

var Courses = (function () {
  'use strict';

  var dlg, gridEl, bulkEl, selCountEl, pickEl, listEl, noteEl;
  var editingId = null;
  var editColor = 'blue';

  // 框选状态
  var sel = null;         // { wd1, wd2, p1, p2 }  0-based
  var dragging = false;

  function init() {
    dlg         = document.getElementById('dlg-courses');
    gridEl      = document.getElementById('ct-grid');
    bulkEl      = document.getElementById('ct-bulk');
    selCountEl  = document.getElementById('ct-selcount');
    pickEl      = document.getElementById('ct-pick');
    listEl      = document.getElementById('course-list');
    noteEl      = document.getElementById('gen-note');

    document.getElementById('btn-courses').addEventListener('click', open);
    document.getElementById('ct-close').addEventListener('click', function () { dlg.close(); });

    document.getElementById('term-start').addEventListener('change', function (ev) {
      var v = ev.target.value;
      if (v) {
        // 吸附到那一周的周一
        v = Sched.ymd(Sched.mondayOf(Sched.parseYmd(v)));
        ev.target.value = v;
      }
      Sched.settings.termStart = v;
      Sched.commit();
      render();
    });

    document.getElementById('ct-new').addEventListener('click', function () { editCourse(null); });

    document.getElementById('ct-apply').addEventListener('click', function () {
      if (!sel) return;
      var cid = pickEl.value;
      if (!cid) { App.toast('先新建一门课程'); return; }
      Sched.setSlotsFor(cid, cellsOfSel());
      clearSel();
      render();
      App.toast('已填入');
    });

    document.getElementById('ct-clear').addEventListener('click', function () {
      if (!sel) return;
      Sched.clearCells(cellsOfSel());
      clearSel();
      render();
    });

    document.getElementById('ct-cancel-sel').addEventListener('click', function () {
      clearSel(); render();
    });

    document.getElementById('ct-generate').addEventListener('click', function () {
      if (!Sched.settings.termStart) { App.toast('请先填「第 1 周周一」'); return; }
      if (!Sched.state.courses.length) { App.toast('课程列表还是空的'); return; }
      var n = Sched.regenerateCourses();
      App.toast('已生成 ' + n + ' 条课程日程');
      render();
      Month.render();
      if (Day.isOpen()) Day.render();
    });

    document.getElementById('ct-wipe').addEventListener('click', function () {
      var n = Sched.clearCourseEvents();
      App.toast(n ? '已清除 ' + n + ' 条课程日程' : '没有课程日程');
      Month.render();
      if (Day.isOpen()) Day.render();
      render();
    });

    document.getElementById('periods-reset').addEventListener('click', function () {
      Sched.state.periods = Sched.DEFAULT_PERIODS.map(function (p) {
        return { start: p.start, end: p.end };
      });
      Sched.commit();
      render();
    });

    /* 框选 */
    gridEl.addEventListener('mousedown', function (ev) {
      var cell = ev.target.closest('.ct-cell');
      if (!cell || ev.button !== 0) return;
      ev.preventDefault();
      if (ev.target.closest('.ct-slot') && !ev.shiftKey) {
        // 直接点已有课块 = 编辑那门课
        var sid = ev.target.closest('.ct-slot').dataset.course;
        if (sid) { editCourse(sid); return; }
      }
      dragging = true;
      var c = cellCoords(cell);
      sel = { wd1: c.wd, wd2: c.wd, p1: c.p, p2: c.p };
      paintSel();
    });

    gridEl.addEventListener('mousemove', function (ev) {
      if (!dragging || !sel) return;
      var cell = ev.target.closest('.ct-cell');
      if (!cell) return;
      var c = cellCoords(cell);
      sel.wd2 = c.wd;
      sel.p2 = c.p;
      paintSel();
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      if (sel) {
        var n = (Math.abs(sel.wd2 - sel.wd1) + 1) * (Math.abs(sel.p2 - sel.p1) + 1);
        bulkEl.hidden = false;
        selCountEl.textContent = n;
      }
    });

    /* 课程属性弹窗 */
    document.getElementById('form-course').addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveCourse();
    });
    document.getElementById('co-cancel').addEventListener('click', function () {
      document.getElementById('dlg-course').close();
    });
    document.getElementById('co-delete').addEventListener('click', function () {
      if (!editingId) return;
      var c = Sched.getCourse(editingId);
      if (!c) return;
      if (!confirm('删除课程「' + c.name + '」？对应的课程日程也会一起删掉。')) return;
      Sched.removeCourse(editingId);
      document.getElementById('dlg-course').close();
      render();
      Month.render();
      if (Day.isOpen()) Day.render();
    });

    buildSwatches(document.getElementById('co-colors'), function (id) { editColor = id; });
    bindPeriods();

    gridEl.style.gridTemplateColumns = '76px repeat(7, minmax(72px, 1fr))';
  }

  /* ── 打开 / 渲染 ── */

  function open() {
    document.getElementById('term-start').value = Sched.settings.termStart || '';
    render();
    dlg.showModal();
  }

  function render() {
    renderTermExcl();
    renderGrid();
    renderList();
    renderPick();
    renderPeriods();
    renderNote();
  }

  function renderTermExcl() {
    var wrap = document.getElementById('excl-wrap');
    var html = Sched.settings.excludeDates.map(function (d) {
      return '<span class="excl-chip">' + Sched.esc(d) +
             '<button data-del-excl="' + Sched.esc(d) + '" title="移除">✕</button></span>';
    }).join('');
    wrap.innerHTML = html + '<input type="date" id="add-excl" title="添加要跳过的日期">';
    wrap.querySelectorAll('[data-del-excl]').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = b.dataset.delExcl;
        Sched.settings.excludeDates = Sched.settings.excludeDates.filter(function (x) {
          return x !== d;
        });
        Sched.commit();
        render();
      });
    });
    var inp = document.getElementById('add-excl');
    inp.addEventListener('change', function () {
      var v = inp.value;
      if (!v) return;
      if (Sched.settings.excludeDates.indexOf(v) === -1) {
        Sched.settings.excludeDates.push(v);
        Sched.settings.excludeDates.sort();
        Sched.commit();
      }
      render();
    });
  }

  /** 找出覆盖 (weekday, period) 的所有 课程 + 槽位 */
  function slotsAt(wd, p) {
    var out = [];
    Sched.state.courses.forEach(function (c) {
      c.slots.forEach(function (s) {
        if (s.weekday === wd && p >= s.from && p <= s.to) {
          out.push({ course: c, slot: s });
        }
      });
    });
    return out;
  }

  function renderGrid() {
    var P = Sched.state.periods.length;
    var html = '<div class="hd corner">节次<br>时间</div>';

    for (var w = 0; w < 7; w++) {
      html += '<div class="hd">周' + Sched.WEEKDAY_CN[w] + '</div>';
    }

    for (var p = 1; p <= P; p++) {
      var per = Sched.state.periods[p - 1];
      html += '<div class="rowlab"><b>' + p + '</b>' +
              '<span>' + Sched.esc(per.start) + '</span>' +
              '<span>' + Sched.esc(per.end) + '</span></div>';

      for (var wd = 1; wd <= 7; wd++) {
        var hits = slotsAt(wd, p);
        var inner = hits.map(function (h) {
          var c = h.course, s = h.slot;
          var top = (p === s.from) ? '' : ' cont-top';
          var bot = (p === s.to) ? '' : ' cont-bot';
          var showMeta = (p === s.from);
          return '<div class="ct-slot' + top + bot + '" data-course="' + c.id + '"' +
                 ' data-color="' + Sched.esc(c.color) + '" title="' +
                 Sched.esc(c.name + (c.teacher ? ' · ' + c.teacher : '') +
                           (c.location ? ' · ' + c.location : '') +
                           '（第' + s.from + '-' + s.to + '节）') + '">' +
                 '<span class="nm">' + Sched.esc(c.name) + '</span>' +
                 (showMeta && c.location ? '<span class="lc">' + Sched.esc(c.location) + '</span>' : '') +
                 '</div>';
        }).join('');

        html += '<div class="ct-cell' + (wd === 7 ? ' last' : '') + '"' +
                ' data-wd="' + wd + '" data-p="' + p + '">' + inner + '</div>';
      }
    }

    gridEl.innerHTML = html;

    // 上色
    var nodes = gridEl.querySelectorAll('.ct-slot');
    for (var i = 0; i < nodes.length; i++) {
      Sched.applyColors(nodes[i], nodes[i].dataset.color);
    }
  }

  function renderPick() {
    var opts = '<option value="">— 选择课程 —</option>';
    Sched.state.courses.forEach(function (c) {
      opts += '<option value="' + c.id + '">' + Sched.esc(c.name) + '</option>';
    });
    pickEl.innerHTML = opts;
  }

  function renderList() {
    var cs = Sched.state.courses;
    if (!cs.length) {
      listEl.innerHTML = '<div class="empty-note">还没有课程。点右上角「+ 新建课程」，' +
                         '然后框选格子批量填入。</div>';
      return;
    }
    listEl.innerHTML = cs.map(function (c) {
      var slots = c.slots.slice().sort(function (a, b) {
        return a.weekday - b.weekday || a.from - b.from;
      }).map(function (s) {
        return '周' + Sched.WEEKDAY_CN[s.weekday - 1] + ' ' + s.from + '-' + s.to + '节';
      }).join('，') || '（未安排时间）';

      var weeks = '第' + c.fromWeek + '-' + c.toWeek + '周' +
                  (c.parity === 'odd' ? ' 单周' : c.parity === 'even' ? ' 双周' : '');

      return '<div class="course-row" data-id="' + c.id + '">' +
               '<span class="dot" data-color="' + Sched.esc(c.color) + '"></span>' +
               '<span><span class="cn">' + Sched.esc(c.name) + '</span> ' +
                 '<span class="meta">' + Sched.esc([c.teacher, c.location].filter(Boolean).join(' · ')) + '</span>' +
               '</span>' +
               '<span class="slots">' + Sched.esc(slots) + '<br>' +
                 '<span class="meta">' + weeks + '</span></span>' +
               '<span class="cnt">' + Sched.countCourse(c) + ' 节</span>' +
             '</div>';
    }).join('');

    listEl.querySelectorAll('.course-row').forEach(function (row) {
      Sched.applyColors(row.querySelector('.dot'), row.querySelector('.dot').dataset.color);
      row.addEventListener('click', function () { editCourse(row.dataset.id); });
    });
  }

  /* 节次表是每次 render 重建的，所以监听器只在 init 里用事件委托挂一次，
     否则每渲染一轮就多叠一个，改一次时间会被处理 N 遍。 */
  function bindPeriods() {
    document.getElementById('periods-grid').addEventListener('change', function (ev) {
      var inp = ev.target.closest('input[data-pi]');
      if (!inp) return;
      var i = +inp.dataset.pi;
      Sched.state.periods[i][inp.dataset.k] = inp.value;
      Sched.commit();
      renderGrid();
      renderNote();
    });
  }

  function renderPeriods() {
    document.getElementById('periods-grid').innerHTML =
      Sched.state.periods.map(function (p, i) {
        return '<label><b>' + (i + 1) + '</b>' +
               '<input type="time" data-pi="' + i + '" data-k="start" value="' + Sched.esc(p.start) + '">' +
               '<input type="time" data-pi="' + i + '" data-k="end" value="' + Sched.esc(p.end) + '">' +
               '</label>';
      }).join('');
  }

  function renderNote() {
    if (!Sched.settings.termStart) {
      noteEl.textContent = '先填「第 1 周周一」才能生成';
      return;
    }
    var n = 0;
    Sched.state.courses.forEach(function (c) { n += Sched.countCourse(c); });
    noteEl.textContent = '按当前设置会生成 ' + n + ' 条课程日程';
  }

  /* ── 框选辅助 ── */

  function cellCoords(cell) {
    return { wd: +cell.dataset.wd, p: +cell.dataset.p };
  }

  function selRect() {
    if (!sel) return null;
    return {
      wd1: Math.min(sel.wd1, sel.wd2), wd2: Math.max(sel.wd1, sel.wd2),
      p1:  Math.min(sel.p1, sel.p2),   p2:  Math.max(sel.p1, sel.p2)
    };
  }

  /** 选区 → 槽位数组：每一列生成一个跨行区间的槽 */
  function cellsOfSel() {
    var r = selRect();
    if (!r) return [];
    var out = [];
    for (var wd = r.wd1; wd <= r.wd2; wd++) {
      out.push({ weekday: wd, from: r.p1, to: r.p2 });
    }
    return out;
  }

  function paintSel() {
    var r = selRect();
    gridEl.querySelectorAll('.ct-cell').forEach(function (cell) {
      var c = cellCoords(cell);
      var inSel = c.wd >= r.wd1 && c.wd <= r.wd2 && c.p >= r.p1 && c.p <= r.p2;
      cell.classList.toggle('in-sel', inSel);
    });
    var n = (r.wd2 - r.wd1 + 1) * (r.p2 - r.p1 + 1);
    bulkEl.hidden = false;
    selCountEl.textContent = n;
  }

  function clearSel() {
    sel = null;
    bulkEl.hidden = true;
    gridEl.querySelectorAll('.ct-cell.in-sel').forEach(function (c) {
      c.classList.remove('in-sel');
    });
  }

  /* ── 课程属性弹窗 ── */

  function editCourse(id) {
    editingId = id;
    var c = id ? Sched.getCourse(id) : null;
    var dlgC = document.getElementById('dlg-course');

    document.getElementById('co-title-h').textContent = c ? '编辑课程' : '新建课程';
    document.getElementById('co-delete').hidden = !c;

    document.getElementById('co-name').value      = c ? c.name : '';
    document.getElementById('co-teacher').value   = c ? c.teacher : '';
    document.getElementById('co-location').value  = c ? c.location : '';
    document.getElementById('co-from').value      = c ? c.fromWeek : 1;
    document.getElementById('co-to').value        = c ? c.toWeek : 16;
    document.getElementById('co-parity').value    = c ? c.parity : 'all';
    document.getElementById('co-excl').value      = c ? (c.excludeDates || []).join(', ') : '';

    editColor = c ? c.color : nextColor();
    paintSwatches(document.getElementById('co-colors'), editColor);

    dlgC.showModal();
    setTimeout(function () { document.getElementById('co-name').focus(); }, 30);
  }

  function nextColor() {
    return Sched.PALETTE[Sched.state.courses.length % Sched.PALETTE.length].id;
  }

  function saveCourse() {
    var name = document.getElementById('co-name').value.trim();
    if (!name) return;

    var excl = document.getElementById('co-excl').value
      .split(/[,，\s]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); });

    var data = {
      name: name,
      teacher: document.getElementById('co-teacher').value.trim(),
      location: document.getElementById('co-location').value.trim(),
      fromWeek: +document.getElementById('co-from').value || 1,
      toWeek: +document.getElementById('co-to').value || 16,
      parity: document.getElementById('co-parity').value,
      excludeDates: excl,
      color: editColor
    };

    if (editingId) {
      Sched.updateCourse(editingId, data);
    } else {
      data.slots = [];
      Sched.addCourse(data);
    }

    document.getElementById('dlg-course').close();
    render();
  }

  /* ── 颜色选择器 ── */

  function buildSwatches(wrap, onPick) {
    wrap.innerHTML = Sched.PALETTE.map(function (p) {
      return '<button type="button" class="sw" data-color="' + p.id + '"' +
             ' title="' + p.name + '" aria-pressed="false"></button>';
    }).join('');

    wrap.querySelectorAll('.sw').forEach(function (b) {
      b.style.background = Sched.colorHex(b.dataset.color);
      b.addEventListener('click', function () {
        onPick(b.dataset.color);
        paintSwatches(wrap, b.dataset.color);
      });
    });
  }

  function paintSwatches(wrap, colorId) {
    wrap.querySelectorAll('.sw').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.color === colorId));
    });
  }

  return { init: init, open: open, render: render, editCourse: editCourse };
})();
