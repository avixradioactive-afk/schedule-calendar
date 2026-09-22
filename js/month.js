/* ══════════════════════════════════════════════════════════
   month.js — 月历视图
   ══════════════════════════════════════════════════════════ */

var Month = (function () {
  'use strict';

  var gridEl, titleEl, weekBadgeEl, weekdaysEl;
  var today = new Date();
  var todayStr = Sched.ymd(today);

  var view = { y: today.getFullYear(), m: today.getMonth() };
  var selected = todayStr;
  var onChangeSelect = null;   // 由 app.js 注入：点某天时打开当日面板

  /* ── 初始化 ── */

  function init(opts) {
    gridEl = document.getElementById('grid');
    titleEl = document.getElementById('mtitle');
    weekBadgeEl = document.getElementById('week-badge');
    weekdaysEl = document.getElementById('weekdays');
    onChangeSelect = opts && opts.onSelect;

    renderWeekdays();

    // 窗口/面板尺寸变化时重新计算每格能塞几条
    var ro = new ResizeObserver(function () { fitAll(); });
    ro.observe(gridEl);
    // 主题切换的重绘统一由 app.js 的 initThemeWatch 负责，这里不重复挂
  }

  function renderWeekdays() {
    var html = '';
    for (var i = 0; i < 7; i++) {
      html += '<span class="' + (i >= 5 ? 'we' : '') + '">' +
              Sched.WEEKDAY_CN[i] + '</span>';
    }
    weekdaysEl.innerHTML = html;
  }

  /* ── 渲染 ── */

  function render() {
    var y = view.y, m = view.m;
    titleEl.textContent = y + ' 年 ' + (m + 1) + ' 月';

    var wn = Sched.weekNumber(Sched.ymd(new Date(y, m, 1)));
    weekBadgeEl.textContent = wn > 0 ? '第 ' + wn + ' 周起' : '';

    // 网格范围：本月 1 号所在周的周一开始，铺满整周
    var first = new Date(y, m, 1);
    var start = Sched.mondayOf(first);
    var last = new Date(y, m + 1, 0);
    var end = Sched.addDays(Sched.mondayOf(last), 6);
    var days = Math.round((end - start) / 86400000) + 1;
    var rows = days / 7;

    gridEl.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';

    var onlyImp = Sched.ui.onlyImportant;
    var html = '';
    var d = new Date(start);

    for (var i = 0; i < days; i++) {
      html += cellHTML(d, d.getMonth() === m, Sched.ymd(d) === todayStr, onlyImp);
      d = Sched.addDays(d, 1);
    }

    gridEl.innerHTML = html;

    // 事件条的颜色靠内联 CSS 变量，必须在插进 DOM 之后逐条设置
    var chips = gridEl.querySelectorAll('.chip');
    for (var c = 0; c < chips.length; c++) {
      Sched.applyColors(chips[c], chips[c].dataset.color);
    }

    requestAnimationFrame(fitAll);
  }

  function cellHTML(d, inMonth, isToday, onlyImp) {
    var ds = Sched.ymd(d);
    var evs = Sched.eventsOn(ds);

    if (onlyImp) evs = evs.filter(function (e) { return e.important; });

    // 重要的排前面，其余按时间
    evs = evs.slice().sort(function (a, b) {
      if (a.important !== b.important) return a.important ? -1 : 1;
      return Sched.toMin(a.start) - Sched.toMin(b.start);
    });

    var cls = 'cell' + (inMonth ? '' : ' other') +
              (isToday ? ' today' : '') +
              (ds === selected ? ' selected' : '');

    var chips = evs.map(function (e) {
      return '<div class="chip' + (e.important ? ' important' : '') +
             (e.done ? ' done' : '') + '"' +
             ' data-id="' + e.id + '" data-color="' + Sched.esc(e.color) + '"' +
             ' title="' +
             Sched.esc(e.start + '–' + e.end + '  ' + e.title + (e.note ? '\n' + e.note : '')) + '">' +
             '<span class="t">' + Sched.esc(e.start) + '</span>' +
             '<span class="n">' + Sched.esc(e.title) + '</span>' +
             '<button type="button" class="chip-chk" data-chk="' + e.id + '"' +
               ' title="' + (e.done ? '取消完成' : '标记完成') + '">✓</button>' +
             '</div>';
    }).join('');

    return '<div class="' + cls + '" data-date="' + ds + '">' +
             '<div class="cell-head">' +
               '<span class="dnum">' + d.getDate() + '</span>' +
               '<span class="spacer"></span>' +
               '<button class="add-btn" data-add="' + ds + '" title="快速添加">+</button>' +
             '</div>' +
             '<div class="cell-events">' + chips + '</div>' +
             '<div class="more" hidden></div>' +
           '</div>';
  }

  /* ── 溢出处理：算出每格能显示几条 ── */

  function fitAll() {
    var cells = gridEl.querySelectorAll('.cell');
    for (var i = 0; i < cells.length; i++) fitCell(cells[i]);
  }

  function fitCell(cell) {
    var list = cell.querySelector('.cell-events');
    var more = cell.querySelector('.more');
    var chips = list.querySelectorAll('.chip');

    if (!chips.length) { more.hidden = true; return; }

    var avail = list.clientHeight;
    if (avail <= 0) return;

    var GAP = 3;
    var i;

    // 先把所有小条显示出来，把真实高度量下来缓存住。
    // （隐藏的元素 offsetHeight 是 0，边量边藏会算错。）
    var heights = [];
    for (i = 0; i < chips.length; i++) {
      chips[i].hidden = false;
      heights.push(chips[i].offsetHeight);
    }

    // "+N" 的高度也要先显示才能量到
    more.hidden = false;
    more.textContent = '+0 更多';
    var moreH = more.offsetHeight + GAP;
    more.hidden = true;

    // 第一轮：不留 "+N" 的位置
    var used = 0, hidden = 0;
    for (i = 0; i < chips.length; i++) {
      var h = heights[i] + (used > 0 ? GAP : 0);
      if (used + h <= avail) { used += h; }
      else { chips[i].hidden = true; hidden++; }
    }

    if (hidden === 0) return;

    // 第二轮：腾出一行给 "+N"
    used = 0; hidden = 0;
    for (i = 0; i < chips.length; i++) {
      var h2 = heights[i] + (used > 0 ? GAP : 0);
      if (used + h2 + moreH <= avail) { chips[i].hidden = false; used += h2; }
      else { chips[i].hidden = true; hidden++; }
    }

    if (hidden > 0) {
      more.textContent = '+' + hidden + ' 更多';
      more.hidden = false;
    }
  }

  /* ── 快速添加（在格子里直接输入）── */

  function quickAdd(cell) {
    var list = cell.querySelector('.cell-events');
    if (list.querySelector('.quick')) return;

    var input = document.createElement('input');
    input.className = 'quick';
    input.placeholder = '输入标题，回车保存';
    input.maxLength = 80;
    list.appendChild(input);
    input.focus();

    // 回车提交时 input.remove() 会同步触发 blur，不加锁的话会存两条
    var done = false;
    var commit = function (save) {
      if (done) return;
      done = true;
      var v = input.value.trim();
      input.remove();
      if (save && v) {
        var ds = cell.dataset.date;
        var t = defaultTimeFor(ds);
        Sched.addEvent({
          date: ds, start: t.start, end: t.end, title: v,
          color: 'blue', important: false
        });
      }
      fitAll();
    };

    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
  }

  /** 默认时间：今天取下一个整点，其它日子取 09:00 */
  function defaultTimeFor(ds) {
    var now = new Date();
    if (ds === Sched.ymd(now)) {
      var h = Math.min(now.getHours() + 1, 22);
      return { start: Sched.pad(h) + ':00', end: Sched.pad(h + 1) + ':00' };
    }
    return { start: '09:00', end: '10:00' };
  }

  /* ── 交互 ── */

  function bind() {
    gridEl.addEventListener('click', function (ev) {
      var addBtn = ev.target.closest('[data-add]');
      if (addBtn) {
        ev.stopPropagation();
        quickAdd(addBtn.closest('.cell'));
        return;
      }

      var more = ev.target.closest('.more');
      var chip = ev.target.closest('.chip');

      // 小圈：只切换完成状态，不打开编辑弹窗
      var chk = ev.target.closest('[data-chk]');
      if (chk) {
        ev.stopPropagation();
        Sched.toggleEventDone(chk.dataset.chk);
        return;
      }

      if (chip) {
        ev.stopPropagation();
        var id = chip.dataset.id;
        var e = Sched.getEvent(id);
        if (e) select(e.date);
        document.dispatchEvent(new CustomEvent('sched:edit-event', { detail: id }));
        return;
      }

      var cell = ev.target.closest('.cell');
      if (!cell) return;
      select(cell.dataset.date);
      if (more) return;   // 点 "+N" 只展开，不额外做事
    });

    gridEl.addEventListener('dblclick', function (ev) {
      var cell = ev.target.closest('.cell');
      if (!cell || ev.target.closest('.chip')) return;
      quickAdd(cell);
    });

    bindDrag();
  }

  /* ── 拖拽改期 ────────────────────────────────────────────────

     HTML5 的 dragstart/drop 在触屏上根本不触发，手机上「把日程拖到
     别的日子」一直是死的。这里改用 Pointer Events 自己实现，鼠标和
     手指各按各自的手感：

       鼠标——按住就拎起来（跟原来一样）
       手指——先长按约 0.22 秒才拎起来。一碰就动的话，跟「点开编辑」
             和「滑动」全打架。

     拎起来之后跟手走，松手落在哪个格子就改到哪天。                */

  var HOLD_MS = 220;      // 触屏长按多久算拎起来
  var SLOP = 8;           // 手指移动超过这个距离就不算长按了

  var drag = null;        // { id, chip, ghost, holdTimer, started, moved, touch, pointerId }
  var swallowClick = false;

  function bindDrag() {
    gridEl.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      var chip = ev.target.closest('.chip');
      if (!chip) return;
      // 勾选圈是自己的按钮，别被拖拽抢走
      if (ev.target.closest('[data-chk]')) return;
      if (!Sched.getEvent(chip.dataset.id)) return;

      drag = {
        id: chip.dataset.id, chip: chip, ghost: null,
        startX: ev.clientX, startY: ev.clientY,
        started: false, moved: false,
        touch: ev.pointerType !== 'mouse',
        pointerId: ev.pointerId, holdTimer: null
      };

      if (drag.touch) {
        drag.holdTimer = setTimeout(function () {
          if (drag) startDrag();
        }, HOLD_MS);
      } else {
        startDrag();          // 鼠标不用等
      }
    });

    gridEl.addEventListener('pointermove', function (ev) {
      if (!drag) return;

      if (!drag.started) {
        var far = Math.abs(ev.clientX - drag.startX) > SLOP ||
                  Math.abs(ev.clientY - drag.startY) > SLOP;
        if (far) cancelDrag();      // 手指在滚/在滑，不算长按
        return;
      }

      if (!drag.ghost) {
        // 真的动了才造跟随的替身。不然「点一下打开编辑」也会闪一下
        drag.ghost = makeGhost(drag.chip);
        drag.chip.classList.add('dragging');
      }
      drag.moved = true;
      drag.ghost.style.left = (ev.clientX + 12) + 'px';
      drag.ghost.style.top = (ev.clientY - 14) + 'px';
      highlight(cellAt(ev.clientX, ev.clientY));
    });

    gridEl.addEventListener('pointerup', drop);
    gridEl.addEventListener('pointercancel', cancelDrag);

    // 长按之后浏览器还会补一个 click，别让它顺手把编辑窗打开
    gridEl.addEventListener('click', function (ev) {
      if (!swallowClick) return;
      swallowClick = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
  }

  function startDrag() {
    if (!drag || drag.started) return;
    drag.started = true;
    if (drag.holdTimer) { clearTimeout(drag.holdTimer); drag.holdTimer = null; }
    try { gridEl.setPointerCapture(drag.pointerId); } catch (e) {}
    if (drag.touch && navigator.vibrate) navigator.vibrate(12);   // 拎起来了，给个手感
  }

  /** 拖过之后浏览器还会补一个 click，别让它顺手把编辑窗打开。
      设个会自己过期的标记——不然万一没有 click，它会一直挂着，
      把后面某次无关的点击吃掉。 */
  function swallowNextClick() {
    swallowClick = true;
    setTimeout(function () { swallowClick = false; }, 350);
  }

  function endDrag() {
    var d = drag;
    if (!d) return null;
    if (d.holdTimer) clearTimeout(d.holdTimer);
    if (d.ghost) d.ghost.remove();
    d.chip.classList.remove('dragging');
    drag = null;
    highlight(null);
    return d;
  }

  function cancelDrag() {
    var d = endDrag();
    if (d && d.moved) swallowNextClick();
  }

  function drop(ev) {
    if (!drag) return;
    var wasMoved = drag.moved;
    var id = drag.id;
    var d = endDrag();

    if (!wasMoved) return;                 // 只是点了一下，交给 click 处理
    swallowNextClick();

    var cell = cellAt(ev.clientX, ev.clientY);
    if (!cell) return;
    var e = Sched.getEvent(id);
    if (e && e.date !== cell.dataset.date) {
      Sched.updateEvent(id, { date: cell.dataset.date });
      App.toast('已移到 ' + cell.dataset.date);
    }
  }

  function cellAt(x, y) {
    var el = document.elementFromPoint(x, y);
    return (el && el.closest) ? el.closest('.cell') : null;
  }

  function highlight(cell) {
    var prev = gridEl.querySelector('.cell.dragover');
    if (prev && prev !== cell) prev.classList.remove('dragover');
    if (cell) cell.classList.add('dragover');
  }

  function makeGhost(chip) {
    var g = document.createElement('div');
    g.className = 'drag-ghost';
    g.textContent = chip.textContent.replace('✓', '').trim();
    Sched.applyColors(g, chip.dataset.color);
    document.body.appendChild(g);
    return g;
  }

  /* ── 导航 ── */

  function select(dateStr) {
    selected = dateStr;
    var cells = gridEl.querySelectorAll('.cell');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('selected', cells[i].dataset.date === dateStr);
    }
    if (onChangeSelect) onChangeSelect(dateStr);
  }

  /** 月份可以越界，交给 Date 进位（13 月 = 次年 1 月） */
  function goto(y, m) {
    var d = new Date(y, m, 1);
    view.y = d.getFullYear();
    view.m = d.getMonth();
    render();
  }

  function shift(delta) {
    var d = new Date(view.y, view.m + delta, 1);
    goto(d.getFullYear(), d.getMonth());
  }

  function gotoToday() {
    var n = new Date();
    view.y = n.getFullYear();
    view.m = n.getMonth();
    render();
    select(Sched.ymd(n));
  }

  function gotoDate(dateStr) {
    var d = Sched.parseYmd(dateStr);
    if (d.getFullYear() !== view.y || d.getMonth() !== view.m) {
      goto(d.getFullYear(), d.getMonth());
    }
    select(dateStr);
  }

  function getSelected() { return selected; }
  function getView() { return { y: view.y, m: view.m }; }

  return {
    init: init, render: render, bind: bind,
    select: select, goto: goto, shift: shift,
    gotoToday: gotoToday, gotoDate: gotoDate,
    getSelected: getSelected, getView: getView,
    fitAll: fitAll
  };
})();
