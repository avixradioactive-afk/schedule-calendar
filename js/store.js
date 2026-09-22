/* ══════════════════════════════════════════════════════════
   store.js — 数据模型 / 本地存储 / 课程展开
   全部挂在全局 Sched 上，供其它脚本使用。
   ══════════════════════════════════════════════════════════ */

var Sched = (function () {
  'use strict';

  var KEY = 'schedule.v1';

  /* 数据结构版本。云同步靠它挡住「旧客户端把新字段写坏」：
     云端版本高于本机认识的就拒绝推送。加字段时 +1。
     注意 localStorage 的键名 KEY 不带版本号，是故意的——
     升级靠 normalize 就地兼容，不换键，免得老数据读不到。 */
  var VERSION = 2;

  /* 纯界面偏好，跟数据本身无关，所以单独存、也不参与同步：
     不然在电脑上点一下「只看重要」就会把手机上一整天的排课顶掉。 */
  var UIKEY = 'schedule.ui';

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

  /** 浅拷贝。normalize 系函数全靠它保住「这个版本还不认识的字段」。 */
  function copy(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
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
      version: VERSION,
      events: [],
      memos: [],          // 每天的小提醒：没有时间，只有「做没做」
      courses: [],
      periods: DEFAULT_PERIODS.map(function (p) { return { start: p.start, end: p.end }; }),

      // 下面三个字段是给云同步认「这份数据是谁、什么时候写的」用的。
      // savedAt 只用来在冲突弹窗里显示「云端是 3 小时前的」，
      // 绝不用来判谁更新——两台设备的时钟不可信，比大小会让
      // 时钟慢的那台永远推不上去。真正的判据是 blob 的 sha。
      savedAt: 0,         // 0 = 从没被任何设备写过
      lastWriter: '',     // 最后一次写的设备 id
      lastSeq: '',        // 最后一次写的随机数，用来认「这次写是不是我发的」

      settings: {
        termStart: '',        // 第 1 周的周一，YYYY-MM-DD
        excludeDates: [],     // 全局排除（节假日）
        skipped: []           // 手动删掉的课程事件 originKey，重新生成时跳过
      }
    };
  }

  var state = defaultState();
  var listeners = [];
  var writerId = '';        // 本机 id，由 sync 注入；纯 node 环境下为空

  function onChange(fn) { listeners.push(fn); }
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](); }

  /** 本机标识，只影响 lastWriter 字段 */
  function setWriter(id) { writerId = String(id == null ? '' : id); }

  /** 每次本地改动都盖一个「谁、什么时候、哪一次」的戳 */
  function stampWrite() {
    state.savedAt = Date.now();
    state.lastWriter = writerId;
    state.lastSeq = uid() + uid();
  }

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
    loadUi();
    return state;
  }

  function save() {
    try {
      if (typeof localStorage === 'undefined') return true;
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      // 配额爆了或 Safari 无痕模式下会走到这里。以前只 console.warn，
      // 于是用户看得见改动、刷新就没了。现在让上层能知道并提示。
      console.warn('保存失败', e);
      return false;
    }
  }

  function commit() { stampWrite(); save(); emit(); }

  /**
   * 采纳云端内容：原样收下，**绝不刷新** savedAt / lastWriter / lastSeq。
   * 它们描述的是「这份数据是谁什么时候写的」，在这条路径上改了，
   * 两台设备就会你推我我推你地互相覆盖个没完。
   */
  function adopt(s) {
    state = normalize(s);
    save();
    emit();
    return state;
  }

  /* ── 本机界面偏好 ──────────────────────────────────────────
     和一些「设置」长得像，但性质完全不同：它们描述的是这台设备
     怎么看，不是日程本身。所以单独存一份，也不参与同步。      */

  var ui = { onlyImportant: false, showTasks: roomForTaskPanel() };

  function loadUi() {
    try {
      var raw = (typeof localStorage !== 'undefined') && localStorage.getItem(UIKEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && typeof s === 'object') {
          ui.onlyImportant = !!s.onlyImportant;
          ui.showTasks = s.showTasks !== false;
        }
      }
    } catch (e) {
      console.warn('读取界面偏好失败，用默认值', e);
    }
    return ui;
  }

  function saveUi() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(UIKEY, JSON.stringify(ui));
    } catch (e) {
      console.warn('保存界面偏好失败', e);
    }
  }

  /**
   * 兼容缺字段 / 脏数据。
   *
   * 关键：这里是**从输入复制一份、再覆盖已知字段**，而不是从空白对象重建。
   * 重建会把不认识的字段直接丢掉——以后版本加了新字段，旧客户端一读一写
   * 就把它们抹平了，而且看起来像是旧客户端「改」的。云端一并被带坏。
   * APK 装上去是不会自己更新的，所以「旧客户端」不是边缘情况，是常态。
   */
  function normalize(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object') return d;

    var out = copy(s);

    out.version = +s.version || 1;
    out.savedAt = +s.savedAt || 0;      // 0 = 从没被写过，不是「很久以前」
    out.lastWriter = String(s.lastWriter || '');
    out.lastSeq = String(s.lastSeq || '');

    out.events = Array.isArray(s.events)
      ? s.events.filter(function (e) { return e && e.date && e.start; }).map(normEvent) : [];
    out.memos = Array.isArray(s.memos)
      ? s.memos.filter(function (m) { return m && m.date && m.text; }).map(normMemo) : [];
    out.courses = Array.isArray(s.courses)
      ? s.courses.filter(function (c) { return c && c.name; }).map(normCourse) : [];

    out.periods = (Array.isArray(s.periods) && s.periods.length)
      ? s.periods.filter(function (p) { return p && p.start && p.end; })
                 .map(function (p) { return { start: p.start, end: p.end }; })
      : d.periods;
    if (!out.periods.length) out.periods = d.periods;

    out.settings = copy(s.settings || {});
    out.settings.termStart = (s.settings && s.settings.termStart) || '';
    out.settings.excludeDates = (s.settings && Array.isArray(s.settings.excludeDates))
      ? s.settings.excludeDates : [];
    out.settings.skipped = (s.settings && Array.isArray(s.settings.skipped))
      ? s.settings.skipped : [];
    // 这两个是纯界面偏好，已经挪到本机（见 UIKEY）。老数据带的就删掉，
    // 别再跟着同步跑——不然在电脑上点一下「只看重要」就能顶掉手机上的排课。
    delete out.settings.onlyImportant;
    delete out.settings.showTasks;

    return out;
  }

  function normEvent(e) {
    var o = copy(e);              // 不认识的字段一律留着，见 normalize
    o.id = e.id || uid();
    o.date = String(e.date).slice(0, 10);
    o.start = String(e.start).slice(0, 5);
    o.end = String(e.end || '').slice(0, 5);
    o.title = String(e.title || '未命名').slice(0, 200);
    o.note = String(e.note || '').slice(0, 500);
    o.color = e.color || 'blue';
    o.important = !!e.important;
    o.done = !!e.done;
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
    var o = copy(m);              // 不认识的字段一律留着，见 normalize
    o.id = m.id || uid();
    o.date = String(m.date == null ? '' : m.date).slice(0, 10);
    o.text = String(m.text == null ? '' : m.text).trim().slice(0, 300);
    o.done = !!m.done;
    o.createdAt = +m.createdAt || 0;   // 只用来排序，不显示
    return o;
  }

  function normCourse(c) {
    var o = copy(c);              // 不认识的字段一律留着，见 normalize
    o.id = c.id || uid();
    o.name = String(c.name).slice(0, 60);
    o.teacher = String(c.teacher || '').slice(0, 40);
    o.location = String(c.location || '').slice(0, 60);
    o.color = c.color || 'blue';
    o.fromWeek = Math.max(1, +c.fromWeek || 1);
    o.toWeek = Math.max(1, +c.toWeek || 16);
    o.parity = (c.parity === 'odd' || c.parity === 'even') ? c.parity : 'all';
    // 显式周次列表，非空时优先于 fromWeek/toWeek/parity。
    // 课表里大量出现「第2周」「7-9周(单)」「2周,5-15周」这种写法，区间表达不了。
    o.weeks = Array.isArray(c.weeks) ? parseWeeks(c.weeks.join(',')) : [];
    o.excludeDates = Array.isArray(c.excludeDates) ? c.excludeDates : [];
    o.slots = Array.isArray(c.slots) ? c.slots.filter(function (s) {
      return s && s.weekday >= 1 && s.weekday <= 7 && s.from >= 1;
    }).map(function (s) {
      var t = copy(s);
      t.weekday = +s.weekday;
      t.from = +s.from;
      t.to = Math.max(+s.from, +s.to);
      return t;
    }) : [];
    return o;
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

  /** 给人看的备份：带缩进，好读好改 */
  function exportJSON() { return JSON.stringify(state, null, 2); }

  /** 发给云端的：不带缩进。一份学期数据 91KB → 64KB，
     而且远程看 diff 时也还看得懂，不用为了省字节转成 ASCII 转义。 */
  function serialize() { return JSON.stringify(state); }

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
    UIKEY: UIKEY,
    VERSION: VERSION,

    get state() { return state; },
    get settings() { return state.settings; },
    get ui() { return ui; },

    pad: pad, ymd: ymd, parseYmd: parseYmd, addDays: addDays,
    mondayOf: mondayOf, weekdayIndex: weekdayIndex,
    toMin: toMin, minToTime: minToTime, uid: uid, esc: esc,
    parseWeeks: parseWeeks, formatWeeks: formatWeeks,
    colorHex: colorHex, rgba: rgba, applyColors: applyColors, isDark: isDark,

    load: load, save: save, commit: commit, onChange: onChange,
    adopt: adopt, setWriter: setWriter,
    loadUi: loadUi, saveUi: saveUi,
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

    exportJSON: exportJSON, importJSON: importJSON, replaceAll: replaceAll,
    serialize: serialize
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sched;
