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

  /* 北航作息。可在课程表弹窗里改。 */
  var DEFAULT_PERIODS = [
    { start: '08:00', end: '08:45' }, { start: '08:55', end: '09:40' },
    { start: '10:10', end: '10:55' }, { start: '11:05', end: '11:50' },
    { start: '14:00', end: '14:45' }, { start: '14:55', end: '15:40' },
    { start: '16:10', end: '16:55' }, { start: '17:05', end: '17:50' },
    { start: '19:00', end: '19:45' }, { start: '19:55', end: '20:40' },
    { start: '20:50', end: '21:35' }
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
      courses: [],
      periods: DEFAULT_PERIODS.map(function (p) { return { start: p.start, end: p.end }; }),
      settings: {
        termStart: '',        // 第 1 周的周一，YYYY-MM-DD
        excludeDates: [],     // 全局排除（节假日）
        skipped: [],          // 手动删掉的课程事件 originKey，重新生成时跳过
        onlyImportant: false
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
        onlyImportant: !!(s.settings && s.settings.onlyImportant)
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
      important: !!e.important
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
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) ev[k] = patch[k];
    // 课程事件被手动改过：保留 courseId 用于去重，但标记 overridden 防止被覆盖
    if (ev.courseId) ev.overridden = true;
    var fixed = normEvent(ev);
    for (var k2 in fixed) ev[k2] = fixed[k2];
    commit();
    return ev;
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

    var from = Math.min(course.fromWeek, course.toWeek);
    var to = Math.max(course.fromWeek, course.toWeek);

    course.slots.forEach(function (slot) {
      for (var w = from; w <= to; w++) {
        if (course.parity === 'odd' && w % 2 === 0) continue;
        if (course.parity === 'even' && w % 2 === 1) continue;

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
          originKey: key,
          week: w
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
    state.events.forEach(function (e) {
      if (e.courseId && e.overridden) keep[e.originKey] = 1;
    });

    state.events = state.events.filter(function (e) {
      return !e.courseId || e.overridden;
    });

    var added = 0;
    state.courses.forEach(function (c) {
      expandCourse(c).forEach(function (ev) {
        if (keep[ev.originKey]) return;
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
    colorHex: colorHex, rgba: rgba, applyColors: applyColors, isDark: isDark,

    load: load, save: save, commit: commit, onChange: onChange,
    normalize: normalize, defaultState: defaultState,

    eventsOn: eventsOn, getEvent: getEvent, addEvent: addEvent,
    updateEvent: updateEvent, removeEvent: removeEvent,

    periodRange: periodRange, weekNumber: weekNumber,
    expandCourse: expandCourse, regenerateCourses: regenerateCourses,
    clearCourseEvents: clearCourseEvents, countCourse: countCourse,

    getCourse: getCourse, addCourse: addCourse, updateCourse: updateCourse,
    removeCourse: removeCourse, setSlotsFor: setSlotsFor,
    removeSlots: removeSlots, clearCells: clearCells,

    exportJSON: exportJSON, importJSON: importJSON, replaceAll: replaceAll
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sched;
