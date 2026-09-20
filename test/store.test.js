/* 数据层自测：node test/store.test.js */
var S = require('../js/store.js');

var pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function eq(name, a, b) {
  ok(name, a === b, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

function reset() {
  S.replaceAll(S.defaultState());
  S.state.settings.termStart = '2026-09-07';   // 周一
}

console.log('\n【日期工具】');
var d = S.parseYmd('2026-09-07');
eq('2026-09-07 是周一', S.weekdayIndex(d), 0);
eq('周一归属自身', S.ymd(S.mondayOf(d)), '2026-09-07');
eq('周日的周一回退 6 天', S.ymd(S.mondayOf(S.parseYmd('2026-09-13'))), '2026-09-07');
eq('跨月加天数', S.ymd(S.addDays(S.parseYmd('2026-09-30'), 1)), '2026-10-01');
eq('时间转分钟', S.toMin('08:45'), 525);
eq('分钟转时间', S.minToTime(525), '08:45');

reset();   // weekNumber 依赖学期起始日
eq('weekNumber 第1周', S.weekNumber('2026-09-07'), 1);
eq('weekNumber 第2周', S.weekNumber('2026-09-14'), 2);
eq('weekNumber 周中同为第2周', S.weekNumber('2026-09-20'), 2);

console.log('\n【课程展开】');
reset();
var c1 = S.addCourse({
  name: '高等数学', teacher: '张老师', location: '教三-201', color: 'blue',
  fromWeek: 1, toWeek: 16, parity: 'all',
  slots: [{ weekday: 1, from: 1, to: 2 }]     // 周一 1-2 节
});
eq('每周 · 1-16 周 = 16 节', S.countCourse(c1), 16);

var evs = S.expandCourse(c1);
eq('首节日期', evs[0].date, '2026-09-07');
eq('首节开始时间', evs[0].start, '08:00');
eq('首节结束时间（1-2 节合并）', evs[0].end, '09:35');
eq('末节日期', evs[15].date, '2026-12-21');
eq('备注含老师与地点', evs[0].note, '张老师 · 教三-201');
ok('带 originKey', !!evs[0].originKey);

reset();
var c2 = S.addCourse({
  name: '大学英语', color: 'green', fromWeek: 1, toWeek: 16, parity: 'odd',
  slots: [{ weekday: 3, from: 1, to: 2 }]
});
eq('单周 · 16 周 = 8 节', S.countCourse(c2), 8);
eq('单周首节在第 1 周', S.expandCourse(c2)[0].date, '2026-09-09');
eq('单周次节在第 3 周', S.expandCourse(c2)[1].date, '2026-09-23');

reset();
var c3 = S.addCourse({
  name: '程序设计', color: 'teal', fromWeek: 2, toWeek: 4, parity: 'all',
  slots: [{ weekday: 5, from: 11, to: 12 }]     // 晚上第 11-12 节
});
eq('2-4 周 · 周五 = 3 节', S.countCourse(c3), 3);
eq('晚课时间正确', S.expandCourse(c3)[0].start, '19:00');
eq('晚课结束时间正确', S.expandCourse(c3)[0].end, '20:35');

console.log('\n【排除日期】');
reset();
S.addCourse({
  name: '大学物理', color: 'orange', fromWeek: 1, toWeek: 4, parity: 'all',
  slots: [{ weekday: 1, from: 3, to: 4 }]
});
S.state.settings.excludeDates = ['2026-09-14'];
eq('排除第 2 周后剩 3 节', S.countCourse(S.state.courses[0]), 3);

reset();
S.addCourse({
  name: '体育', color: 'red', fromWeek: 1, toWeek: 4, parity: 'all',
  excludeDates: ['2026-09-07', '2026-09-21'],
  slots: [{ weekday: 1, from: 1, to: 2 }]
});
eq('课程自己的排除日期生效', S.countCourse(S.state.courses[0]), 2);

console.log('\n【指定周次（weeks）】');
eq('解析逗号分隔', S.parseWeeks('1,3,5').join(','), '1,3,5');
eq('解析区间', S.parseWeeks('5-9').join(','), '5,6,7,8,9');
eq('混合写法', S.parseWeeks('1, 3, 5-9, 11').join(','), '1,3,5,6,7,8,9,11');
eq('顿号与「至」', S.parseWeeks('2、5至7').join(','), '2,5,6,7');
eq('去重并排序', S.parseWeeks('9,2,2,5-7').join(','), '2,5,6,7,9');
eq('倒序区间自动翻转', S.parseWeeks('9-7').join(','), '7,8,9');
eq('无法解析的片段忽略', S.parseWeeks('2,abc,5').join(','), '2,5');
eq('空串得到空数组', S.parseWeeks('').length, 0);
eq('格式化合并连续段', S.formatWeeks([1, 3, 5, 6, 7, 8, 9, 11]), '1,3,5-9,11');
eq('格式化单个', S.formatWeeks([4]), '4');
eq('往返一致', S.formatWeeks(S.parseWeeks('2,5-7,9-15,17')), '2,5-7,9-15,17');

reset();
var cw = S.addCourse({
  name: '习概论', color: 'pink',
  fromWeek: 1, toWeek: 20, parity: 'all',     // 故意写成会被 weeks 覆盖的值
  weeks: [2, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 17],
  slots: [{ weekday: 2, from: 6, to: 7 }]
});
eq('weeks 覆盖 fromWeek/toWeek/parity', S.countCourse(cw), 12);
eq('activeWeeks 原样返回', S.activeWeeks(cw).join(','), '2,5,6,7,9,10,11,12,13,14,15,17');
eq('第 1 周没有课', S.expandCourse(cw).filter(function (e) { return e.date === '2026-09-08'; }).length, 0);
eq('第 2 周周二有课', S.expandCourse(cw)[0].date, '2026-09-15');

// 没有 weeks 的课仍按老逻辑走
reset();
var cn = S.addCourse({
  name: '普通课', color: 'blue', fromWeek: 1, toWeek: 4, parity: 'odd',
  slots: [{ weekday: 1, from: 1, to: 2 }]
});
eq('未指定 weeks 时回落到周次范围', S.countCourse(cn), 2);
eq('单双周仍然生效',
   S.expandCourse(cn).map(function (e) { return S.weekNumber(e.date); }).join(','), '1,3');

// weeks 要能挺过导出/导入
reset();
S.addCourse({ name: 'W', color: 'blue', weeks: [3, 9], slots: [{ weekday: 1, from: 1, to: 1 }] });
S.regenerateCourses();
var dumpW = S.exportJSON();
S.replaceAll(S.defaultState());
S.importJSON(dumpW);
eq('导入后 weeks 保留', S.state.courses[0].weeks.join(','), '3,9');
eq('导入后仍然只上这两周', S.state.events.length, 2);

console.log('\n【生成 / 覆盖保护】');
reset();
S.addCourse({
  name: '线性代数', color: 'violet', fromWeek: 1, toWeek: 4, parity: 'all',
  slots: [{ weekday: 2, from: 1, to: 2 }]
});
var n1 = S.regenerateCourses();
eq('生成 4 条', n1, 4);
eq('事件总数', S.state.events.length, 4);
eq('事件带 courseId', S.state.events[0].courseId, S.state.courses[0].id);

// 调课：把第 2 周那次挪到周四 14:00
var target = S.state.events[1];
eq('待调整的是第 2 周', target.date, '2026-09-15');
S.updateEvent(target.id, { date: '2026-09-17', start: '14:00', end: '15:40' });
ok('被标记为 overridden', S.getEvent(target.id).overridden === true);

S.regenerateCourses();
eq('重新生成不会复活旧的、也不重复', S.state.events.length, 4);
ok('调课后仍在周四 14:00',
   S.state.events.some(function (e) { return e.date === '2026-09-17' && e.start === '14:00'; }));
ok('原周二那次没被加回来',
   !S.state.events.some(function (e) { return e.date === '2026-09-15'; }));

// 删除某一次课
var victim = S.state.events.filter(function (e) { return !e.overridden; })[0];
var vdate = victim.date;
S.removeEvent(victim.id);
eq('删除后剩 3 条', S.state.events.length, 3);
S.regenerateCourses();
eq('重新生成不会复活已删除的那次', S.state.events.length, 3);
ok('确实没有 ' + vdate + ' 那条',
   !S.state.events.some(function (e) { return e.date === vdate; }));

console.log('\n【批量编辑格子】');
reset();
var c4 = S.addCourse({ name: '大学物理', color: 'orange', fromWeek: 1, toWeek: 2,
                       slots: [{ weekday: 1, from: 1, to: 2 }] });
S.setSlotsFor(c4.id, [{ weekday: 3, from: 5, to: 6 }, { weekday: 5, from: 5, to: 6 }]);
eq('批量填入后共 3 个时段', c4.slots.length, 3);
S.removeSlots(c4.id, [{ weekday: 3, from: 5, to: 6 }]);
eq('批量移除后剩 2 个时段', c4.slots.length, 2);
S.clearCells([{ weekday: 1, from: 1, to: 2 }, { weekday: 5, from: 5, to: 6 }]);
eq('清空格子后课程无时段', c4.slots.length, 0);

console.log('\n【导入导出 / 脏数据】');
reset();
S.addCourse({ name: 'X', color: 'blue', fromWeek: 1, toWeek: 2, slots: [{ weekday: 1, from: 1, to: 1 }] });
S.regenerateCourses();
var dump = S.exportJSON();
var before = S.state.events.length;
S.replaceAll(S.defaultState());
eq('清空后无事件', S.state.events.length, 0);
S.importJSON(dump);
eq('导入后事件数一致', S.state.events.length, before);
eq('导入后学期起始保留', S.settings.termStart, '2026-09-07');

var dirty = S.normalize({
  events: [{ date: '2026-09-20', start: '10:00', title: '无结束时间' },
           { nope: 1 }, null],
  courses: [{ name: '课', slots: [{ weekday: 9, from: 1, to: 2 }] }],
  periods: []
});
eq('脏事件被过滤/补全', dirty.events.length, 1);
eq('结束时间自动补 1 小时', dirty.events[0].end, '11:00');
eq('非法 weekday 被丢掉', dirty.courses[0].slots.length, 0);
eq('空节次表回落到默认', dirty.periods.length, 14);

console.log('\n' + '─'.repeat(46));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
