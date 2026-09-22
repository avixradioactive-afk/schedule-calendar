/* ══════════════════════════════════════════════════════════
   store.js — 数据模型 / 本地存储 / 课程展开
   全部挂在全局 Sched 上，供其它脚本使用。
   ══════════════════════════════════════════════════════════ */

var Sched = (function () {
  'use strict';

  var KEY = 'schedule.v1';

  /* ── 调色板 ────────────────────────────────────────────────
     每个颜色给亮/暗两套 hex：亮色主题用深一点的，暗色主题用浅一点的，
     这样两种主题下文字对比度都够。                            */
  var PALETTE = [
    { id: 'blue',   name: '蓝', light: '#2563eb', dark: '#60a5fa' },
    { id: 'violet', name: '紫', light: '#7c3aed', dark: '#a78bfa' },
    { id: 'pink',   name: '粉', light: '#db2777', dark: '#f472b6' },
    { id: 'red',    name: '红', light: '#dc2626', dark: '#f87171' },
    { id: 'orange', name: '橙', light: '#ea580c', dark: '#fb923c' },
    { id: 'amber',  name: '黄', light: '#b45309', dark: '#fbbf24' },
    { id: 'green',  name: '绿', light: '#059669', dark: '#34d399' },
    { id: 'teal',   name: '青', light: '#0d9488', dark: '#2dd4bf' },
    { id: 'slate',  name: '灰', light: '#475569', dark: '#94a3b8' }
  ];

  /* 北航作息，共 14 节：上午 1-5、下午 6-10、晚上 11-14。
     可在课程表弹窗的「节次时间设置」里改。 */
  var DEFAULT_PERIODS = [
    { start: '08:00', end: '08:45' },  // 1
    { start: '08:50', end: '09:35' },  // 2
    { start: '09:50', end: '10:35' },  // 3
    { start: '10:40', end: '11:25' },  // 4
    { start: '11:30', end: '12:15' },  // 5
    { start: '14:00', end: '14:45' },  // 6
    { start: '14:50', end: '15:35' },  // 7
    { start: '15:50', end: '16:35' },  // 8
    { start: '16:40', end: '17:25' },  // 9
    { start: '17:30', end: '18:15' },  // 10
    { start: '19:00', end: '19:45' },  // 11
    { start: '19:50', end: '20:35' },  // 12
    { start: '20:40', end: '21:25' },  // 13
    { start: '21:30', end: '22:15' }   // 14
  ];

  var WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

  /* ── 日期小工具（全部按本地时区，日期用 YYYY-MM-DD 字符串表示）── */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function parseYmd(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  /** 该日期所在周的周一 */
  function mondayOf(d) {
    return addDays(d, -((d.getDay() + 6) % 7));
  }

  /** 0=周一 … 6=周日 */
  function weekdayIndex(d) { return (d.getDay() + 6) % 7; }

  function toMin(hhmm) {
    var p = String(hhmm || '00:00').split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }

  function minToTime(m) {
    m = Math.max(0, Math.min(1439, Math.round(m)));
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /** 左侧任务栏在窄屏上默认收起，免得一进页面就盖住日历 */
  function roomForTaskPanel() {
    return typeof matchMedia === 'undefined' || matchMedia('(min-width: 901px)').matches;
  }

  /**
   * "1,3,5-9" → [1,3,5,6,7,8,9]
   * 分隔符逗号/顿号/分号/空格都认，区间可以用 - ~ 至。无法解析的片段直接跳过。
   */
  function parseWeeks(str) {
    var out = [], seen = {};
    String(str == null ? '' : str).split(/[,，、;；\s]+/).forEach(function (part) {
      if (!part) return;
      var m = /^(\d+)\s*[-~至]\s*(\d+)$/.exec(part);
      if (m) {
        var a = +m[1], b = +m[2];
        if (a > b) { var t = a; a = b; b = t; }
        for (var w = a; w <= b; w++) {
          if (w >= 1 && !seen[w]) { seen[w] = 1; out.push(w); }
        }
      } else if (/^\d+$/.test(part)) {
        var v = +part;
        if (v >= 1 && !seen[v]) { seen[v] = 1; out.push(v); }
      }
    });
    out.sort(function (x, y) { return x - y; });
    return out;
  }

  /** [1,3,5,6,7] → "1,3,5-7" */
  function formatWeeks(weeks) {
    if (!weeks || !weeks.length) return '';
    var s = weeks.slice().sort(function (a, b) { return a - b; });
    var parts = [], i = 0;
    while (i < s.length) {
      var j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      parts.push(i === j ? String(s[i]) : s[i] + '-' + s[j]);
      i = j + 1;
    }
    return parts.join(',');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── 颜色解析 ────────────────────────────────────────────── */

  function isDark() {
    return typeof matchMedia !== 'undefined' &&
           matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function colorHex(id) {
    var p = null;
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i].id === id) p = PALETTE[i];
    if (!p) p = PALETTE[0];
    return isDark() ? p.dark : p.light;
  }

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  /**
   * 给元素挂上配色变量：
   *   --c     主题色（文字 / 左边框）
   *   --c-bg  淡背景
   *   --c-bd  边框
   */
  function applyColors(el, colorId) {
    var hex = colorHex(colorId);
    el.style.setProperty('--c', hex);
    el.style.setProperty('--c-bg', rgba(hex, isDark() ? 0.18 : 0.10));
    el.style.setProperty('--c-bd', rgba(hex, 0.22));
    return hex;
  }

  /* ── 状态 ────────────────────────────────────────────────── */

  function defaultState() {
    return {
      version: 1,
      events: [],
      memos: [],          // 每天的小提醒：没有时间，只有「做没做」
      courses: [],
      periods: DEFAULT_PERIODS.map(function (p) { return { start: p.start, end: p.end }; }),
      settings: {
        termStart: '',        // 第 1 周的周一，YYYY-MM-DD
        excludeDates: [],     // 全局排除（节假日）
        skipped: [],          // 手动删掉的课程事件 originKey，重新生成时跳过
        onlyImportant: false,
        showTasks: roomForTaskPanel()   // 左侧任务栏是否展开
      }
    };
  }

  var state = defaultState();
  var listeners = [];

  function onChange(fn) { listeners.push(fn); }
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](); }

  function load() {
    try {
      var raw = (typeof localStorage !== 'undefined') && localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        state = normalize(s);
      }
    } catch (e) {
      console.warn('读取本地数据失败，已使用空白数据', e);
    }
    return state;
  }

  function save() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('保存失败', e);
    }
  }

  function commit() { save(); emit(); }

  /** 兼容缺字段 / 脏数据 */
  function normalize(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object') return d;

    var out = {
      version: 1,
      events: Array.isArray(s.events) ? s.events.filter(function (e) { return e && e.date && e.start; })
                                                   .map(normEvent) : [],
      memos: Array.isArray(s.memos) ? s.memos.filter(function (m) { return m && m.date && m.text; })
                                                 .map(normMemo) : [],
      courses: Array.isArray(s.courses) ? s.courses.filter(function (c) { return c && c.name; })
                                                     .map(normCourse) : [],
      periods: (Array.isArray(s.periods) && s.periods.length) ? s.periods
                 .filter(function (p) { return p && p.start && p.end; })
                 .map(function (p) { return { start: p.start, end: p.end }; })
                 : d.periods,
      settings: {
        termStart: (s.settings && s.settings.termStart) || '',
        excludeDates: (s.settings && Array.isArray(s.settings.excludeDates)) ? s.settings.excludeDates : [],
        skipped: (s.settings && Array.isArray(s.settings.skipped)) ? s.settings.skipped : [],
        onlyImportant: !!(s.settings && s.settings.onlyImportant),
        // 老数据里没有这个字段，按屏幕宽度给个默认值
        showTasks: (s.settings && typeof s.settings.showTasks === 'boolean')
          ? s.settings.showTasks : d.settings.showTasks
      }
    };
    if (!out.periods.length) out.periods = d.periods;
    return out;
  }

  function normEvent(e) {
    var o = {
      id: e.id || uid(),
      date: String(e.date).slice(0, 10),
      start: String(e.start).slice(0, 5),
      end: String(e.end || '').slice(0, 5),
      title: String(e.title || '未命名').slice(0, 200),
      note: String(e.note || '').slice(0, 500),
      color: e.color || 'blue',
      important: !!e.important,
      done: !!e.done
    };
    if (!o.end || toMin(o.end) <= toMin(o.start)) o.end = minToTime(toMin(o.start) + 60);
    if (e.courseId) {
      o.courseId = e.courseId;
      o.slotKey = e.slotKey || '';
      o.originKey = e.originKey || (e.courseId + '|' + o.date + '|' + o.start);
      o.overridden = !!e.overridden;
    }
    return o;
  }

  function normMemo(m) {
    return {
      id: m.id || uid(),
      date: String(m.date == null ? '' : m.date).slice(0, 10),
      text: String(m.text == null ? '' : m.text).trim().slice(0, 300),
      done: !!m.done,
      createdAt: +m.createdAt || 0     // 只用来排序，不显示
    };
  }

  function normCourse(c) {
    return {
      id: c.id || uid(),
      name: String(c.name).slice(0, 60),
      teacher: String(c.teacher || '').slice(0, 40),
      location: String(c.location || '').slice(0, 60),
      color: c.color || 'blue',
      fromWeek: Math.max(1, +c.fromWeek || 1),
      toWeek: Math.max(1, +c.toWeek || 16),
      parity: (c.parity === 'odd' || c.parity === 'even') ? c.parity : 'all',
      // 显式周次列表，非空时优先于 fromWeek/toWeek/parity。
      // 课表里大量出现「第2周」「7-9周(单)」「2周,5-15周」这种写法，区间表达不了。
      weeks: Array.isArray(c.weeks)
        ? parseWeeks(c.weeks.join(','))
        : [],
      excludeDates: Array.isArray(c.excludeDates) ? c.excludeDates : [],
      slots: Array.isArray(c.slots) ? c.slots.filter(function (s) {
        return s && s.weekday >= 1 && s.weekday <= 7 && s.from >= 1;
      }).map(function (s) {
        return { weekday: +s.weekday, from: +s.from, to: Math.max(+s.from, +s.to) };
      }) : []
    };
  }

  /* ── 事件读写 ────────────────────────────────────────────── */

  function byStart(a, b) { return toMin(a.start) - toMin(b.start); }

  /** 某天的日程，按开始时间排序 */
  function eventsOn(dateStr) {
    return state.events.filter(function (e) { return e.date === dateStr; }).sort(byStart);
  }

  function getEvent(id) {
    for (var i = 0; i < state.events.length; i++) if (state.events[i].id === id) return state.events[i];
    return null;
  }

  function addEvent(data) {
    var ev = normEvent(data);
    state.events.push(ev);
    commit();
    return ev;
  }

  function updateEvent(id, patch) {
    var ev = getEvent(id);
    if (!ev) return null;
    var onlyDone = true;
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      // 比的是「值有没有变」，不是「有没有传这个字段」——
      // 编辑弹窗保存时会把所有字段原样再传一遍。
      if (k !== 'done' && ev[k] !== patch[k]) onlyDone = false;
      ev[k] = patch[k];
    }
    // 课程事件被手动改过：保留 courseId 用于去重，但标记 overridden 防止被覆盖。
    // 单纯勾掉「完成」不算改过——否则勾一节高数就会让它脱离课程表。
    if (ev.courseId && !onlyDone) ev.overridden = true;
    var fixed = normEvent(ev);
    for (var k2 in fixed) ev[k2] = fixed[k2];
    commit();
    return ev;
  }

  /** 只改完成状态，绕开 overridden 那套（勾掉一节课不该让它脱离课程表） */
  function setEventDone(id, done) {
    var ev = getEvent(id);
    if (!ev) return null;
    ev.done = !!done;
    commit();
    return ev;
  }

  function toggleEventDone(id) {
    var ev = getEvent(id);
    if (!ev) return null;
    return setEventDone(id, !ev.done);
  }

  function removeEvent(id) {
    var ev = getEvent(id);
    if (!ev) return false;
    // 删掉课程生成的事件时记一笔，避免「生成到日历」又把它加回来
    if (ev.courseId && !ev.overridden) {
      var key = ev.originKey || (ev.courseId + '|' + ev.date + '|' + ev.start);
      if (state.settings.skipped.indexOf(key) === -1) state.settings.skipped.push(key);
    }
    state.events = state.events.filter(function (e) { return e.id !== id; });
    commit();
    return true;
  }

  /* ── 备忘录（每天的小提醒）────────────────────────────────
     和日程的区别：没有时间、不进月历格子、不参与课程表生成。
     只是一句话 + 一个「做没做」，所以单独存一份。            */

  /** 某天的备忘录：未完成的在前，同组按创建先后 */
  function memosOn(dateStr) {
    return state.memos.filter(function (m) { return m.date === dateStr; })
      .sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
  }

  function getMemo(id) {
    for (var i = 0; i < state.memos.length; i++) if (state.memos[i].id === id) return state.memos[i];
    return null;
  }

  function addMemo(data) {
    var m = normMemo(data);
    if (!m.date || !m.text) return null;
    if (!m.createdAt) m.createdAt = Date.now();
    state.memos.push(m);
    commit();
    return m;
  }

  function updateMemo(id, patch) {
    var m = getMemo(id);
    if (!m) return null;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) m[k] = patch[k];
    var fixed = normMemo(m);
    fixed.id = id;
    for (var k2 in fixed) m[k2] = fixed[k2];
    commit();
    return m;
  }

  function removeMemo(id) {
    var before = state.memos.length;
    state.memos = state.memos.filter(function (m) { return m.id !== id; });
    if (state.memos.length === before) return false;
    commit();
    return true;
  }

  function toggleMemo(id) {
    var m = getMemo(id);
    if (!m) return null;
    m.done = !m.done;
    commit();
    return m;
  }

  /** 某天还剩几件没做（提醒 + 日程一起算） */
  function openCount(dateStr) {
    var n = 0;
    state.memos.forEach(function (m) { if (m.date === dateStr && !m.done) n++; });
    state.events.forEach(function (e) { if (e.date === dateStr && !e.done) n++; });
    return n;
  }

  /* ── 节次 ────────────────────────────────────────────────── */

  /** 第 from..to 节合并后的起止时间 */
  function periodRange(from, to) {
    var ps = state.periods;
    var a = ps[from - 1], b = ps[(to || from) - 1];
    if (!a || !b) return null;
    return { start: a.start, end: b.end };
  }

  /* ── 课程 → 事件 ─────────────────────────────────────────── */

  /** 某日期属于第几教学周；未设学期起始则返回 0 */
  function weekNumber(dateStr) {
    var ts = state.settings.termStart;
    if (!ts) return 0;
    var base = mondayOf(parseYmd(ts));
    var d = parseYmd(dateStr);
    return Math.floor((d - base) / 86400000 / 7) + 1;
  }

  /** 这门课实际要上的教学周列表（已排序去重） */
  function activeWeeks(course) {
    if (course.weeks && course.weeks.length) return course.weeks;

    var from = Math.min(course.fromWeek, course.toWeek);
    var to = Math.max(course.fromWeek, course.toWeek);
    var arr = [];
    for (var w = from; w <= to; w++) {
      if (course.parity === 'odd' && w % 2 === 0) continue;
      if (course.parity === 'even' && w % 2 === 1) continue;
      arr.push(w);
    }
    return arr;
  }

  /** 把一门课展开成事件数组（不写入 state） */
  function expandCourse(course) {
    var out = [];
    var ts = state.settings.termStart;
    if (!ts || !course.slots.length) return out;

    var base = mondayOf(parseYmd(ts));
    var excluded = {};
    state.settings.excludeDates.forEach(function (d) { excluded[d] = 1; });
    (course.excludeDates || []).forEach(function (d) { excluded[d] = 1; });
    var skipped = {};
    state.settings.skipped.forEach(function (k) { skipped[k] = 1; });

    var weeks = activeWeeks(course);

    course.slots.forEach(function (slot) {
      for (var i = 0; i < weeks.length; i++) {
        var w = weeks[i];
        var date = addDays(base, (w - 1) * 7 + (slot.weekday - 1));
        var ds = ymd(date);
        if (excluded[ds]) continue;

        var key = course.id + '|' + ds + '|' + slot.weekday + '-' + slot.from + '-' + slot.to;
        if (skipped[key]) continue;

        var rng = periodRange(slot.from, slot.to);
        if (!rng) continue;

        out.push({
          id: uid(),
          date: ds,
          start: rng.start,
          end: rng.end,
          title: course.name,
          note: [course.teacher, course.location].filter(Boolean).join(' · '),
          color: course.color,
          important: false,
          courseId: course.id,
          slotKey: slot.weekday + '-' + slot.from + '-' + slot.to,
          originKey: key
          // 不存教学周号：它由 date + termStart 推算（见 weekNumber），
          // 存下来反而会在改学期起点后悄无声息地变旧。
        });
      }
    });
    return out;
  }

  /**
   * 重新生成全部课程事件。
   * 规则：课程产生的事件随身携带 originKey；被手动改过的（overridden）
   * 原样保留，同 originKey 的新事件不再插入——这样「调课」不会被冲掉。
   */
  function regenerateCourses() {
    var keep = {};
    var done = {};   // originKey → 已勾掉，重新生成时原样带回来
    state.events.forEach(function (e) {
      if (!e.courseId) return;
      if (e.overridden) { keep[e.originKey] = 1; return; }
      if (e.done) done[e.originKey] = 1;
    });

    state.events = state.events.filter(function (e) {
      return !e.courseId || e.overridden;
    });

    var added = 0;
    state.courses.forEach(function (c) {
      expandCourse(c).forEach(function (ev) {
        if (keep[ev.originKey]) return;
        if (done[ev.originKey]) ev.done = true;
        state.events.push(ev);
        added++;
      });
    });

    commit();
    return added;
  }

  /** 清空所有由课程表生成的日程（保留手动加的） */
  function clearCourseEvents() {
    var before = state.events.length;
    state.events = state.events.filter(function (e) { return !e.courseId; });
    commit();
    return before - state.events.length;
  }

  /** 生成后再算一遍：某门课在整个学期会产生多少节课 */
  function countCourse(course) {
    return expandCourse(course).length;
  }

  /* ── 课程读写 ────────────────────────────────────────────── */

  function getCourse(id) {
    for (var i = 0; i < state.courses.length; i++) if (state.courses[i].id === id) return state.courses[i];
    return null;
  }

  function addCourse(data) {
    var c = normCourse(data);
    if (!c.id || getCourse(c.id)) c.id = uid();
    state.courses.push(c);
    commit();
    return c;
  }

  function updateCourse(id, patch) {
    var c = getCourse(id);
    if (!c) return null;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) c[k] = patch[k];
    var fixed = normCourse(c);
    fixed.id = id;
    for (var k2 in fixed) c[k2] = fixed[k2];
    commit();
    return c;
  }

  function removeCourse(id) {
    state.courses = state.courses.filter(function (c) { return c.id !== id; });
    state.events = state.events.filter(function (e) { return e.courseId !== id; });
    commit();
  }

  /** 把若干格子（weekday + 节次范围）批量写进课程 */
  function setSlotsFor(courseId, newSlots) {
    var c = getCourse(courseId);
    if (!c) return;
    var map = {};
    c.slots.forEach(function (s) { map[s.weekday + '-' + s.from + '-' + s.to] = s; });
    newSlots.forEach(function (s) { map[s.weekday + '-' + s.from + '-' + s.to] = s; });
    c.slots = Object.keys(map).map(function (k) { return map[k]; });
    commit();
  }

  function removeSlots(courseId, slots) {
    var c = getCourse(courseId);
    if (!c) return;
    var kill = {};
    slots.forEach(function (s) { kill[s.weekday + '-' + s.from + '-' + s.to] = 1; });
    c.slots = c.slots.filter(function (s) { return !kill[s.weekday + '-' + s.from + '-' + s.to]; });
    commit();
  }

  /** 清掉某一格上的所有课程 */
  function clearCells(cells) {
    var kill = {};
    cells.forEach(function (c) { kill[c.weekday + '-' + c.from + '-' + c.to] = 1; });
    state.courses.forEach(function (course) {
      course.slots = course.slots.filter(function (s) {
        return !kill[s.weekday + '-' + s.from + '-' + s.to];
      });
    });
    commit();
  }

  /* ── 导入 / 导出 ─────────────────────────────────────────── */

  function exportJSON() { return JSON.stringify(state, null, 2); }

  function importJSON(text) {
    var s = JSON.parse(text);
    state = normalize(s);
    commit();
    return state;
  }

  function replaceAll(s) { state = normalize(s); commit(); return state; }

  /* ── 导出 API ────────────────────────────────────────────── */

  return {
    PALETTE: PALETTE,
    DEFAULT_PERIODS: DEFAULT_PERIODS,
    WEEKDAY_CN: WEEKDAY_CN,
    KEY: KEY,

    get state() { return state; },
    get settings() { return state.settings; },

    pad: pad, ymd: ymd, parseYmd: parseYmd, addDays: addDays,
    mondayOf: mondayOf, weekdayIndex: weekdayIndex,
    toMin: toMin, minToTime: minToTime, uid: uid, esc: esc,
    parseWeeks: parseWeeks, formatWeeks: formatWeeks,
    colorHex: colorHex, rgba: rgba, applyColors: applyColors, isDark: isDark,

    load: load, save: save, commit: commit, onChange: onChange,
    normalize: normalize, defaultState: defaultState,

    eventsOn: eventsOn, getEvent: getEvent, addEvent: addEvent,
    updateEvent: updateEvent, removeEvent: removeEvent,
    setEventDone: setEventDone, toggleEventDone: toggleEventDone,

    memosOn: memosOn, getMemo: getMemo, addMemo: addMemo,
    updateMemo: updateMemo, removeMemo: removeMemo, toggleMemo: toggleMemo,
    openCount: openCount,

    periodRange: periodRange, weekNumber: weekNumber,
    activeWeeks: activeWeeks,
    expandCourse: expandCourse, regenerateCourses: regenerateCourses,
    clearCourseEvents: clearCourseEvents, countCourse: countCourse,

    getCourse: getCourse, addCourse: addCourse, updateCourse: updateCourse,
    removeCourse: removeCourse, setSlotsFor: setSlotsFor,
    removeSlots: removeSlots, clearCells: clearCells,

    exportJSON: exportJSON, importJSON: importJSON, replaceAll: replaceAll
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sched;
