/* 把 css/ 与 js/ 内联进 index.html，产出一个自包含的单文件版本。
 *
 *   npm run build   →  dist/schedule.html
 *
 * 单文件版可以在任何地方双击打开，也能直接发给别人，
 * 不必带上整个目录。源码这边依然保持分文件，方便维护。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'schedule.html');

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 内联内容里如果出现 </script> 或 </style>，浏览器会提前结束标签，
   把 < 转义掉即可（对 JS/CSS 语义无影响）。 */
const guard = s => s.replace(/<\/(script|style)/gi, '<\\/$1');

let html = read('index.html');
const inlined = [];

/* <link rel="stylesheet" href="css/styles.css"> → <style>…</style> */
html = html.replace(
  /[ \t]*<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>\s*/gi,
  (m, href) => {
    inlined.push(href);
    return '<style>\n' + guard(read(href)) + '\n</style>\n';
  }
);

/* <script src="js/x.js"></script> → <script>…</script> */
html = html.replace(
  /[ \t]*<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>\s*/gi,
  (m, src) => {
    inlined.push(src);
    return '<script>\n' + guard(read(src)) + '\n</script>\n';
  }
);

/* 确认没有漏掉的外部引用，否则单文件版会静默失效 */
const leftover = html.match(/(?:src|href)=["'](?!#|data:|https?:)([^"']+)["']/gi) || [];
if (leftover.length) {
  console.error('构建失败：还有没内联的外部引用 →');
  leftover.forEach(l => console.error('  ' + l));
  process.exit(1);
}

html = html.replace(
  '<title>日程 · 日历</title>',
  '<title>日程 · 日历</title>\n<!-- 由 tools/build.js 自动生成，请勿直接修改；改动请改源码后重新 npm run build -->'
);

fs.mkdirSync(OUT_DIR, { recursive: true });

/* --check：只校验已提交的单文件版是否和源码一致，不写盘。
   防止改了源码却忘了重新构建，导致 dist/ 悄悄过期。 */
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (cur === html) {
    console.log('dist/schedule.html 与源码一致。');
    process.exit(0);
  }
  console.error(cur === null
    ? 'dist/schedule.html 不存在，请先 npm run build'
    : 'dist/schedule.html 已过期——源码改过了，请重新 npm run build 并提交');
  process.exit(1);
}

fs.writeFileSync(OUT_FILE, html, 'utf8');

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log('已内联 ' + inlined.length + ' 个文件：');
inlined.forEach(f => console.log('  ' + f));
console.log('\n输出 ' + path.relative(ROOT, OUT_FILE).replace(/\\/g, '/') +
            '  （' + kb(Buffer.byteLength(html, 'utf8')) + '）');
