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

  await page.evaluate(() => {
    const ev = document.getElementById('tl-events');
    const r = ev.getBoundingClientRect();
    document.getElementById('dp-body').dispatchEvent(new MouseEvent('click', {
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
    S.replaceAll(S.defaultState());
    const cleared = S.state.events.length;
    S.importJSON(dump);
    return { n, cleared, back: S.state.events.length, term: S.settings.termStart };
  });
  ok('清空后事件为 0', roundTrip.cleared === 0);
  ok('导入后条数一致', roundTrip.back === roundTrip.n, roundTrip);
  ok('学期起始一并还原', roundTrip.term === '2026-09-07', roundTrip.term);

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
  console.log('\n【控制台】');
  ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 5));

  await browser.close();
  console.log('\n' + '─'.repeat(46));
  console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(1); });
