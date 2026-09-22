/* 端到端测试：用真实浏览器打开页面，模拟点击。
 *
 *   npm run test:ui
 *
 * 需要本机已装 Chrome / Edge（puppeteer-core 不自带浏览器）。
 * 找不到时可以用环境变量指定：CHROME_PATH="C:\...\chrome.exe" npm run test:ui
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(__dirname, 'screenshots');

/* 默认测源码版 index.html；
   传参数（node test/ui.test.js dist/schedule.html）或设 PAGE 环境变量可测别的入口 */
const TARGET = process.argv[2] || process.env.PAGE || 'index.html';
const TARGET_PATH = path.resolve(ROOT, TARGET);
const PAGE_URL = 'file:///' + TARGET_PATH.replace(/\\/g, '/');

/* 找一个能用的 Chromium 内核浏览器 */
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，请设置环境变量 CHROME_PATH');
}

/* 「今天」写死成 2026-09-20（周日），测试才能稳定断言 */
const FAKE_NOW = new Date('2026-09-20T10:30:00');

let pass = 0, fail = 0;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 断言某个界面元素的文本正好等于期望值 */
function eq_(name, got, want) {
  ok(name, got === want, { got: got, want: want });
}

(async () => {
  if (!fs.existsSync(TARGET_PATH)) {
    console.error('找不到测试目标：' + TARGET_PATH + '\n（单文件版请先 npm run build）');
    process.exit(1);
  }
  console.log('测试目标：' + TARGET + '\n');

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'],
    defaultViewport: { width: 1440, height: 900 }
  });

  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 时间冻结，否则「今天」相关的断言会随日期漂移
  await page.evaluateOnNewDocument(now => {
    const Real = Date;
    const fixed = new Real(now).getTime();
    function Fake(...a) {
      if (a.length === 0) return new Real(fixed);
      return new Real(...a);
    }
    Fake.prototype = Real.prototype;
    Fake.now = () => fixed;
    Fake.parse = Real.parse;
    Fake.UTC = Real.UTC;
    window.Date = Fake;
  }, FAKE_NOW.toISOString());

  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await sleep(400);

  const shot = n => page.screenshot({ path: path.join(SHOT_DIR, n) });
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('schedule.v1')));

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【首屏：一个月的大格子日历】');

  ok('渲染出 35 个格子（2026 年 9 月跨 5 周）',
     await page.$$eval('.cell', e => e.length) === 35);
  ok('今天（9/20 周日）被高亮并选中',
     await page.$eval('.cell.today', el => el.dataset.date) === '2026-09-20');
  ok('当日面板自动展开到今天',
     await page.$eval('#dp-date', el => el.textContent.trim()) === '9 月 20 日 · 周日');
  ok('时间轴有 24 个小时刻度',
     await page.$$eval('.tl-hour', e => e.length) === 24);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【在日历里直接记当天的事】');

  await page.evaluate(() => {
    document.querySelector('.cell[data-date="2026-09-23"]')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(150);
  ok('双击格子就地弹出输入框',
     await page.$('.cell[data-date="2026-09-23"] input.quick') !== null);

  await page.type('.cell[data-date="2026-09-23"] input.quick', '和导师讨论开题');
  await page.keyboard.press('Enter');
  await sleep(300);

  let s = await store();
  ok('日程已落盘', s.events.length === 1, s.events.length);
  ok('标题正确', s.events[0] && s.events[0].title === '和导师讨论开题');
  ok('日期正确', s.events[0] && s.events[0].date === '2026-09-23');
  ok('没有因为 blur 重复插入一条', s.events.length === 1, s.events.length);
  ok('格子里出现了这条日程',
     (await page.$eval('.cell[data-date="2026-09-23"] .chip', el => el.textContent))
       .includes('和导师讨论开题'));

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【点开某日 → 按时间展开】');

  await page.click('.cell[data-date="2026-09-23"]');
  await sleep(300);
  ok('面板切到 9 月 23 日',
     await page.$eval('#dp-date', el => el.textContent.trim()) === '9 月 23 日 · 周三');
  ok('时间轴上有日程块', await page.$('.ev-block') !== null);

  const geom = await page.$eval('.ev-block', el => ({
    top: parseFloat(el.style.top), h: parseFloat(el.style.height),
    title: el.querySelector('.eb-t').textContent
  }));
  ok('块落在 09:00 刻度上', Math.abs(geom.top - 9 * 58) < 1, geom);
  ok('块高 = 1 小时', Math.abs(geom.h - (58 - 3)) < 1, geom);
  ok('块上显示标题', geom.title === '和导师讨论开题');

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【点时间轴空白处按时段新建】');

  // 点 #dp-tl（时间轴的滚动层）——真实点击落在的就是它或它的子元素
  await page.evaluate(() => {
    const ev = document.getElementById('tl-events');
    const r = ev.getBoundingClientRect();
    document.getElementById('dp-tl').dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientY: r.top + 14 * 58 + 4, clientX: r.left + 40
    }));
  });
  await sleep(300);
  ok('弹出新建窗口', await page.$eval('#dlg-event', el => el.open));
  ok('开始时间预填 14:00', await page.$eval('#ev-start', el => el.value) === '14:00');
  ok('日期预填 2026-09-23', await page.$eval('#ev-date', el => el.value) === '2026-09-23');

  await page.type('#ev-title', '线性代数');
  await page.click('#ev-important');
  await page.click('#ev-save');
  await sleep(350);

  s = await store();
  const imp = s.events.find(e => e.title === '线性代数');
  ok('第二条日程已保存', s.events.length === 2, s.events.length);
  ok('「重要」标记生效', imp && imp.important === true);
  ok('结束时间自动补 1 小时', imp && imp.end === '15:00', imp && imp.end);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【课程表：批量编辑】');

  await page.click('#btn-courses');
  await sleep(350);
  ok('课程表弹窗打开', await page.$eval('#dlg-courses', el => el.open));

  await page.$eval('#term-start', el => {
    el.value = '2026-09-09';   // 故意填周三，看能不能吸附到周一
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  ok('学期起始自动吸附到该周周一',
     await page.$eval('#term-start', el => el.value) === '2026-09-07',
     await page.$eval('#term-start', el => el.value));

  await page.click('#ct-new');
  await sleep(300);
  ok('课程属性弹窗打开', await page.$eval('#dlg-course', el => el.open));
  await page.type('#co-name', '高等数学');
  await page.type('#co-teacher', '张老师');
  await page.type('#co-location', '教三-201');
  await page.$eval('#co-from', el => { el.value = '1'; });
  await page.$eval('#co-to', el => { el.value = '16'; });
  await page.click('#form-course button[type=submit]');
  await sleep(350);
  ok('课程列表里出现 1 门课', await page.$$eval('.course-row', e => e.length) === 1);

  // 框选 周一~周三 × 第 1-2 节
  const box = await page.evaluate(() => {
    const a = document.querySelector('.ct-cell[data-wd="1"][data-p="1"]').getBoundingClientRect();
    const b = document.querySelector('.ct-cell[data-wd="3"][data-p="2"]').getBoundingClientRect();
    return { x1: a.left + 5, y1: a.top + 5, x2: b.left + 5, y2: b.top + 5 };
  });
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 8 });
  await page.mouse.up();
  await sleep(250);

  ok('拖拽框选到 6 格（3 天 × 2 节）',
     await page.$eval('#ct-selcount', el => el.textContent) === '6');

  await page.select('#ct-pick',
    await page.$eval('#ct-pick option:nth-child(2)', e => e.value));
  await page.click('#ct-apply');
  await sleep(300);
  ok('批量填入后出现 6 个课块', await page.$$eval('.ct-slot', e => e.length) === 6);
  ok('预告生成 48 条（16 周 × 3 天）',
     (await page.$eval('#gen-note', el => el.textContent)).includes('48'));

  await page.click('.ct-cell[data-wd="1"][data-p="1"] .ct-slot');
  await sleep(300);
  ok('点已有课块打开该课编辑',
     await page.$eval('#co-name', el => el.value) === '高等数学');
  await page.click('#co-cancel');
  await sleep(200);

  await page.click('#ct-generate');
  await sleep(450);

  s = await store();
  const courseEvs = s.events.filter(e => e.courseId);
  ok('生成 48 条课程日程', courseEvs.length === 48, courseEvs.length);
  ok('手动加的两条没被冲掉', s.events.length === 50, s.events.length);
  ok('课程日程带上了老师与地点',
     courseEvs[0].note === '张老师 · 教三-201', courseEvs[0].note);

  const first = s.events.find(e => e.date === '2026-09-07' && e.courseId);
  ok('9/7（第 1 周周一）有课', !!first);
  ok('时间是第 1-2 节的 08:00–09:35',
     first && first.start === '08:00' && first.end === '09:35',
     first && (first.start + '–' + first.end));

  await page.click('#ct-close');
  await sleep(300);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【格子再多也不会撑破】');

  const overflow = await page.evaluate(async () => {
    const S = window.Sched;
    for (let i = 0; i < 9; i++) {
      S.addEvent({ date: '2026-09-25',
        start: String(7 + i).padStart(2, '0') + ':00',
        end: String(8 + i).padStart(2, '0') + ':00',
        title: '测试' + i, color: 'blue' });
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cell = document.querySelector('.cell[data-date="2026-09-25"]');
    const all = [...cell.querySelectorAll('.chip')];
    const shown = all.filter(c => !c.hidden);
    const more = cell.querySelector('.more');
    return {
      shown: shown.length,
      hidden: all.length - shown.length,
      moreText: more.hidden ? null : more.textContent,
      used: shown.reduce((n, c) => n + c.offsetHeight + 3, 0),
      avail: cell.querySelector('.cell-events').clientHeight
    };
  });
  ok('9 条里只显示一部分，其余收起',
     overflow.shown > 0 && overflow.hidden > 0, overflow);
  ok('显示了「+N 更多」', /^\+\d+ 更多$/.test(overflow.moreText || ''), overflow.moreText);
  ok('显示的内容没有超出格子高度', overflow.used <= overflow.avail + 4, overflow);
  ok('显示数 + 隐藏数 = 9', overflow.shown + overflow.hidden === 9, overflow);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【导航与快捷键】');

  await page.click('#chk-important');
  await sleep(300);
  ok('「只看重要」筛出 1 条', await page.$$eval('.cell .chip', e => e.length) === 1);
  await page.click('#chk-important');
  await sleep(300);

  await page.keyboard.press('ArrowRight');
  await sleep(250);
  ok('→ 翻到下个月',
     await page.$eval('#mtitle', el => el.textContent) === '2026 年 10 月');
  await page.keyboard.press('ArrowLeft');
  await sleep(250);
  ok('← 翻回上个月',
     await page.$eval('#mtitle', el => el.textContent) === '2026 年 9 月');
  await page.keyboard.press('t');
  await sleep(300);
  ok('T 回到今天并展开当日面板',
     !(await page.$eval('#daypanel', el => el.hidden)));

  await page.keyboard.press('Escape');
  await sleep(250);
  ok('Esc 收起当日面板', await page.$eval('#daypanel', el => el.hidden));

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【拖拽改期】');

  await page.evaluate(() => {
    const S = window.Sched;
    const e = S.state.events.find(x => x.title === '和导师讨论开题');
    S.updateEvent(e.id, { date: '2026-09-24' });
  });
  await sleep(300);
  ok('改期后落到 9/24',
     (await store()).events.find(e => e.title === '和导师讨论开题').date === '2026-09-24');

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【持久化】');

  const before = (await store()).events.length;
  await page.reload({ waitUntil: 'load' });
  await sleep(600);
  ok('刷新后数据还在', (await store()).events.length === before, { before });
  ok('刷新后日历重新画出来了', await page.$$eval('.chip', e => e.length) > 0);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【左侧任务栏：当天的任务】');

  await page.keyboard.press('t');          // 回到今天 2026-09-20（周日）
  await sleep(350);
  ok('任务栏默认展开', !(await page.$eval('#taskpanel', el => el.hidden)));
  ok('任务栏跟着选中日走',
     (await page.$eval('#tp-date', el => el.textContent.trim())) === '9 月 20 日 · 周日');
  ok('这天没安排时给出提示',
     (await page.$eval('#tp-body', el => el.textContent)).includes('这天没有日程'));

  await page.type('#tp-input', '记得交实验报告');
  await page.keyboard.press('Enter');
  await sleep(400);

  let st = await store();
  ok('提醒落进 memos', st.memos.length === 1 && st.memos[0].text === '记得交实验报告', st.memos);
  ok('提醒记在 9/20', st.memos[0].date === '2026-09-20', st.memos[0]);
  ok('提醒没有被当成日程', st.events.filter(e => e.date === '2026-09-20').length === 0);
  ok('任务栏里出现了这条提醒',
     (await page.$eval('#tp-body', el => el.textContent)).includes('记得交实验报告'));
  ok('加完自动清空输入框', await page.$eval('#tp-input', el => el.value) === '');

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【点开日期就能看到备忘录】');

  ok('当日面板里也有这条提醒',
     (await page.$eval('#dp-memo-list', el => el.textContent)).includes('记得交实验报告'));
  eq_('备忘录区标出还剩几件',
      await page.$eval('#dp-memo-c', el => el.textContent.trim()), '1 件没做');

  await page.type('#memo-input', '给家里打电话');
  await page.click('#form-memo button[type=submit]');
  await sleep(400);
  st = await store();
  ok('当日面板里也能加提醒', st.memos.length === 2, st.memos.length);
  ok('两条都列在面板里', await page.$$eval('#dp-memo-list .todo', e => e.length) === 2);
  eq_('计数跟着涨', await page.$eval('#dp-memo-c', el => el.textContent.trim()), '2 件没做');

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【勾掉完成的任务】');

  await page.click('#dp-memo-list .todo:first-child .todo-chk');
  await sleep(400);
  st = await store();
  ok('勾选写回了 done', st.memos.filter(m => m.done).length === 1, st.memos.map(m => m.done));
  ok('勾掉的那条划了横线', await page.$('#dp-memo-list .todo.done .todo-t') !== null);
  eq_('没做的少了一件', await page.$eval('#dp-memo-c', el => el.textContent.trim()), '1 件没做');
  eq_('任务栏把已完成的收进折叠区',
      await page.$eval('#taskpanel', el => {
        const s = el.querySelector('.tp-done summary');
        return s ? s.textContent.trim() : null;
      }), '已完成 1 件');

  await page.click('#dp-memo-list .todo.done .todo-chk');
  await sleep(400);
  ok('再点一下可以取消勾选', (await store()).memos.filter(m => m.done).length === 0);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【日程也能勾掉】');

  const chipId = await page.$eval('.cell[data-date="2026-09-23"] .chip', el => el.dataset.id);
  await page.click('.cell[data-date="2026-09-23"] .chip .chip-chk');
  await sleep(400);

  ok('月历格子里点一下圈就勾掉了，没打开编辑弹窗',
     !(await page.$eval('#dlg-event', el => el.open)));
  st = await store();
  ok('日程的 done 写回了', st.events.find(e => e.id === chipId).done === true);
  ok('格子里的那条变灰划线',
     await page.$eval('.cell[data-date="2026-09-23"] .chip', el => el.classList.contains('done')));

  await page.click('.cell[data-date="2026-09-23"]');
  await sleep(400);
  eq_('任务栏跟着切到 9 月 23 日',
      await page.$eval('#tp-date', el => el.textContent.trim()), '9 月 23 日 · 周三');

  const doneBefore = (await store()).events.filter(e => e.date === '2026-09-23' && e.done).length;
  await page.click('#tp-body .tp-sec:nth-child(2) .todo .todo-chk');
  await sleep(400);
  const doneAfter = (await store()).events.filter(e => e.date === '2026-09-23' && e.done).length;
  ok('任务栏里也能勾掉日程', doneAfter === doneBefore + 1, { doneBefore, doneAfter });
  ok('勾掉日程时同样不弹编辑窗口', !(await page.$eval('#dlg-event', el => el.open)));

  // 勾掉一节课之后再生成一遍课表，那一节不该被复活成「没做」
  const courseGuard = await page.evaluate(() => {
    const S = window.Sched;
    const ev = S.state.events.find(e => e.courseId && e.date === '2026-09-07');
    S.toggleEventDone(ev.id);
    const before = S.state.events.length;
    S.regenerateCourses();
    return {
      before: before,
      after: S.state.events.length,
      stillDone: S.state.events.filter(e => e.date === '2026-09-07' && e.done).length
    };
  });
  ok('勾掉一节高数后重新生成课表，条数不变',
     courseGuard.after === courseGuard.before, courseGuard);
  ok('那一节仍然是勾着的', courseGuard.stillDone === 1, courseGuard);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【配色】');

  const light = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.cell .chip'));
    return { color: cs.color, bg: cs.backgroundColor, border: cs.borderLeftColor };
  });
  ok('浅色主题下用深蓝 #2563eb', light.color === 'rgb(37, 99, 235)', light);
  ok('左边框同色', light.border === 'rgb(37, 99, 235)', light);
  ok('背景是淡蓝半透明', light.bg === 'rgba(37, 99, 235, 0.1)', light.bg);

  const dotBg = await page.evaluate(async () => {
    document.getElementById('btn-courses').click();
    await new Promise(r => setTimeout(r, 300));
    const c = getComputedStyle(document.querySelector('.course-row .dot')).backgroundColor;
    document.getElementById('ct-close').click();
    await new Promise(r => setTimeout(r, 250));
    return c;
  });
  ok('课程列表的色点有颜色', /^rgb\(/.test(dotBg), dotBg);

  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await sleep(500);
  const dark = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.cell .chip'));
    return { color: cs.color, page: getComputedStyle(document.body).backgroundColor };
  });
  ok('暗色主题下换成浅蓝 #60a5fa', dark.color === 'rgb(96, 165, 250)', dark);
  ok('暗色主题下页面底色变深', dark.page === 'rgb(15, 17, 21)', dark);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【导入 / 导出】');

  const roundTrip = await page.evaluate(() => {
    const S = window.Sched;
    const dump = S.exportJSON();
    const n = S.state.events.length;
    const nm = S.state.memos.length;
    S.replaceAll(S.defaultState());
    const cleared = S.state.events.length;
    S.importJSON(dump);
    return {
      n: n, cleared: cleared, back: S.state.events.length,
      nm: nm, memosBack: S.state.memos.length,
      term: S.settings.termStart
    };
  });
  ok('清空后事件为 0', roundTrip.cleared === 0);
  ok('导入后条数一致', roundTrip.back === roundTrip.n, roundTrip);
  ok('提醒也一起导入导出', roundTrip.nm > 0 && roundTrip.memosBack === roundTrip.nm, roundTrip);
  ok('学期起始一并还原', roundTrip.term === '2026-09-07', roundTrip.term);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【云同步：界面接线】');

  // 在页面里假装一个 GitHub：拦下 api.github.com 的请求，用一个内存文件顶上。
  // 这样走的还是真实的 Sync 代码路径（fetch → 编解码 → 判定 → 采纳/推送）。
  await page.reload({ waitUntil: 'load' });
  await sleep(600);
  await page.evaluate(async () => {
    const enc = s => { const b = new TextEncoder().encode(s); let t = ''; for (const x of b) t += String.fromCharCode(x); return btoa(t); };
    const dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, '')), c => c.charCodeAt(0)));
    const real = window.fetch;
    window.__cloud = { file: null, n: 0, puts: 0, offline: false };
    window.__setCloud = function (state, sha) {
      window.__cloud.file = { text: JSON.stringify(state), sha: sha || 'ext' + (++window.__cloud.n) };
    };
    window.fetch = function (url, opts) {
      const u = String(url);
      if (u.indexOf('https://api.github.com/') !== 0) return real.apply(this, arguments);
      const c = window.__cloud;
      const mk = (status, obj) => Promise.resolve(new Response(JSON.stringify(obj), {
        status, headers: { 'content-type': 'application/json' }
      }));
      if (c.offline) return Promise.reject(new TypeError('Failed to fetch'));
      if (!/\/contents\//.test(u)) return mk(200, { full_name: 'me/schedule-data' });
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        c.puts++;
        const body = JSON.parse(opts.body);
        if (body.sha && !c.file) return mk(422, { message: 'Invalid request.' });
        if (c.file && body.sha !== c.file.sha) return mk(409, { message: 'sha does not match' });
        c.file = { text: dec(body.content), sha: 'sha' + (++c.n) };
        return mk(200, { content: { sha: c.file.sha } });
      }
      if (!c.file) return mk(404, { message: 'Not Found' });
      return mk(200, { sha: c.file.sha, size: c.file.text.length, encoding: 'base64', content: enc(c.file.text) });
    };
  });

  await page.click('#btn-menu');
  await sleep(200);
  eq_('没配置时菜单上写着未开启',
      await page.$eval('#sy-menu-label', el => el.textContent.trim()), '云同步 · 未开启');

  await page.click('[data-act="sync"]');
  await sleep(350);
  ok('云同步弹窗打开', await page.$eval('#dlg-sync', el => el.open));

  await page.type('#sy-repo', 'me/schedule-data');
  await page.type('#sy-token', 'github_pat_fake');
  await page.click('#bd-sy-save');
  await sleep(700);

  const pushed = await page.evaluate(() => ({
    file: window.__cloud.file ? JSON.parse(window.__cloud.file.text) : null,
    puts: window.__cloud.puts,
    label: document.getElementById('sy-menu-label').textContent.trim()
  }));
  ok('本地数据被推到云端了', !!pushed.file, pushed);
  ok('推上去的内容不是空的',
     pushed.file && (pushed.file.events.length + pushed.file.memos.length) > 0,
     pushed.file && pushed.file.events.length);
  eq_('菜单上显示已同步', pushed.label, '云同步 · 已同步到云端');
  ok('云端文件里没有 token', JSON.stringify(pushed.file).indexOf('github_pat') === -1);

  // 另一台设备往云端写了东西 → 本机拉取时应该自动采纳
  const adopted = await page.evaluate(async () => {
    const me = window.Sched.state;
    const other = JSON.parse(JSON.stringify(me));
    other.events.push({ id: 'from-other', date: '2026-09-28', start: '09:00', end: '10:00',
                        title: '另一台设备加的', note: '', color: 'blue', important: false, done: false });
    other.lastWriter = 'someone-else';
    other.lastSeq = 'seq-from-other';
    window.__setCloud(other);
    await window.Sync.pull();
    return { has: window.Sched.state.events.some(e => e.title === '另一台设备加的'),
             status: window.Sync.status.state };
  });
  ok('云端的新内容被自动采纳了', adopted.has, adopted);
  eq_('采纳后状态是 idle', adopted.status, 'idle');

  // 两边都改 → 弹冲突，两个选项都要摆出事实
  const conflict = await page.evaluate(async () => {
    window.Sched.addEvent({ date: '2026-09-29', start: '09:00', end: '10:00', title: '本机加的' });
    const cloud = JSON.parse(JSON.stringify(window.Sched.state));
    cloud.events.push({ id: 'x2', date: '2026-09-30', start: '09:00', end: '10:00',
                        title: '云端那份', note: '', color: 'blue', important: false, done: false });
    cloud.lastSeq = 'another-seq';
    cloud.lastWriter = 'other-device';
    window.__setCloud(cloud);
    const r = await window.Sync.pull();
    window.SyncUI.paint();
    return {
      r: r,
      status: window.Sync.status.state,
      shown: !document.getElementById('sy-conflict').hidden,
      local: document.getElementById('sy-cf-local').textContent,
      cloud: document.getElementById('sy-cf-cloud').textContent
    };
  });
  eq_('两边都改过 → 判为冲突', conflict.r, 'conflict');
  ok('冲突区块显示出来了', conflict.shown, conflict);
  eq_('两边的标签分别是本机 / 云端',
      await page.$$eval('.sy-cf-tag', els => els.map(e => e.textContent.trim()).join(',')),
      '本机,云端');
  ok('本机那份列出了项数', /共 \d+ 项（日程 \d+ \/ 提醒 \d+ \/ 课程 \d+）/.test(conflict.local), conflict.local);
  ok('云端那份列出了项数', /共 \d+ 项（日程 \d+ \/ 提醒 \d+ \/ 课程 \d+）/.test(conflict.cloud), conflict.cloud);
  ok('两边的数字不一样，说明确实是两份不同的数据',
     conflict.local !== conflict.cloud, conflict);
  eq_('菜单上也提示有冲突',
      await page.$eval('#sy-menu-label', el => el.textContent.trim()), '云同步 · 有冲突，需要处理');
  ok('⋯ 上出现了警示小圆点', !(await page.$eval('#sync-dot', el => el.hidden)));

  // 选「都保留」：采纳云端的同时把本机那份备份下来
  await page.click('#bd-cf-both');
  await sleep(600);
  const resolved = await page.evaluate(() => ({
    status: window.Sync.status.state,
    hasCloud: window.Sched.state.events.some(e => e.title === '云端那份'),
    hasLocal: window.Sched.state.events.some(e => e.title === '本机加的'),
    backup: !!window.Sync.lastBackup(),
    hidden: document.getElementById('sy-conflict').hidden
  }));
  ok('采纳了云端那份', resolved.hasCloud, resolved);
  ok('本机那份进了备份而不是被丢掉', resolved.backup, resolved);
  ok('冲突区块收起来了', resolved.hidden, resolved);

  // 备份能下载出来
  const bak = await page.evaluate(() => {
    const b = window.Sync.lastBackup();
    return b.data.state.events.some(e => e.title === '本机加的');
  });
  ok('备份里确实是本机被放弃的那份', bak);

  // 断网不能把界面搞崩，也不能把本地数据弄丢
  const offline = await page.evaluate(async () => {
    window.__cloud.offline = true;
    const before = window.Sched.state.events.length;
    await window.Sync.pull();
    return { status: window.Sync.status.state, before: before, after: window.Sched.state.events.length,
             msg: window.Sync.status.message };
  });
  ok('断网时状态是 error', offline.status === 'error', offline);
  eq_('断网时本地数据不动', offline.after, offline.before);
  ok('断网时给出了提示', /Failed to fetch|fetch/i.test(offline.msg), offline.msg);

  await page.evaluate(() => {
    window.__cloud.offline = false;
    window.Sync.disconnect();
    window.SyncUI.paint();
  });
  await sleep(250);
  eq_('断开后菜单回到未开启',
      await page.$eval('#sy-menu-label', el => el.textContent.trim()), '云同步 · 未开启');
  await page.click('#bd-sy-close');
  await sleep(250);

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【截图】');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.reload({ waitUntil: 'load' });
  await sleep(700);

  await page.click('.cell[data-date="2026-09-07"]');
  await sleep(400);
  await shot('day.png');
  await page.keyboard.press('Escape');
  await sleep(300);
  await shot('month.png');

  await page.click('#btn-courses');
  await sleep(500);
  await shot('courses.png');
  await page.click('#ct-close');
  await sleep(250);

  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await sleep(500);
  await shot('dark.png');
  console.log('  已输出到 test/screenshots/');

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【窄屏：任务栏变成抽屉】');

  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 700, height: 900 });
  await page.reload({ waitUntil: 'load' });
  await sleep(700);

  ok('窄屏下不自动占位，先收起',
     await page.$eval('#taskpanel', el => el.hidden));
  ok('但大屏时的展开偏好留着（存在本机，不跟着数据同步）',
     await page.evaluate(() => window.Sched.ui.showTasks) === true);

  // 顶栏此刻被当日面板（固定定位的抽屉）盖着，先收起来再点
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.click('#btn-tasks');
  await sleep(400);
  ok('点「任务」把抽屉拉出来', !(await page.$eval('#taskpanel', el => el.hidden)));
  ok('抽屉浮在日历左边',
     await page.$eval('#taskpanel', el => {
       const r = el.getBoundingClientRect();
       return getComputedStyle(el).position === 'fixed' && Math.round(r.left) === 0;
     }));

  await page.click('#btn-tasks');
  await sleep(400);
  ok('再点一下收回去', await page.$eval('#taskpanel', el => el.hidden));
  ok('这一下是用户主动关的，偏好也跟着记下来',
     await page.evaluate(() => window.Sched.ui.showTasks) === false);

  await page.setViewport({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'load' });
  await sleep(700);
  ok('主动关掉之后，换到大屏也不会自己冒出来',
     await page.$eval('#taskpanel', el => el.hidden));

  await page.click('#btn-tasks');
  await sleep(400);
  ok('在大屏上点一下就恢复成常驻的一栏',
     !(await page.$eval('#taskpanel', el => el.hidden)));

  /* ─────────────────────────────────────────────────────── */
  console.log('\n【控制台】');
  ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 5));

  await browser.close();
  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(1); });
