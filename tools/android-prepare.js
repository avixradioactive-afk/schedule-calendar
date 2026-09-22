/* 往 `cap add android` 生成出来的安卓工程里补两样东西：
 *
 *   1. 应用图标 —— tools/android-res/ 下的一套矢量自适应图标
 *   2. 中文应用名 —— 覆盖 strings.xml 里的 app_name / title_activity_main
 *
 * 为什么不在 capacitor.config.json 里直接写中文 appName：
 * 那个值会被 Capacitor 写进生成的文件，中文有可能在写读路径上被
 * 按平台默认编码处理而出岔子。这里最后一步显式覆盖，结果是自己控制的。
 *
 * 图标只加 anydpi-v26（自适应图标，Android 8+）。模板自带的那些
 * mipmap-*dpi PNG 保持不动 —— API 24/25 会回落到它们，不会出现
 * 「找不到图标」的情况。用矢量而不是 PNG：各分辨率都清晰，
 * 仓库里也不用放二进制素材。
 *
 * 用法（在 cap add android 之后）：
 *     node tools/android-prepare.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'android-res');
const ANDROID_APP = path.join(ROOT, 'android', 'app', 'src', 'main');
const RES = path.join(ANDROID_APP, 'res');

const APP_NAME = '日程';

function fail(msg) {
  console.error('android-prepare: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(ANDROID_APP)) {
  fail('找不到 android/app/src/main，请先跑 npx cap add android');
}

/* 1. 图标：把 tools/android-res 下的资源树原样铺进 res/ */
let copied = 0;
(function walk(from, to) {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      walk(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      copied++;
      console.log('  图标 ' + path.relative(ROOT, dst).replace(/\\/g, '/'));
    }
  }
})(SRC, RES);

/* 2. 干掉模板里的 drawable-v24/ic_launcher_foreground.xml。
      资源限定符是「更具体的赢」，而 minSdk 就是 24 —— 只要它还
      在那儿，@drawable/ic_launcher_foreground 永远解析到模板那份，
      我们画的图标根本不会出现（而这是本地看不出来的）。 */
for (const rel of ['drawable-v24/ic_launcher_foreground.xml',
                   'drawable-v26/ic_launcher_foreground.xml']) {
  const p = path.join(RES, rel);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('  删掉会盖住我们的旧版本：res/' + rel);
  }
}

/* 3. 中文应用名。只改字符串的内容，不动 strings.xml 里的其他条目
      （package_name / custom_url_scheme 还被清单文件引用着）。 */
const stringsPath = path.join(RES, 'values', 'strings.xml');
if (!fs.existsSync(stringsPath)) {
  fail('找不到 res/values/strings.xml，模板结构跟预期不一样，先人工看一眼');
}
let strings = fs.readFileSync(stringsPath, 'utf8');
let renamed = 0;
strings = strings.replace(
  /(<string\s+name="(app_name|title_activity_main)"\s*>)([\s\S]*?)(<\/string>)/g,
  (m, open, key, old, close) => {
    renamed++;
    console.log('  应用名 ' + key + '：' + old.trim() + ' → ' + APP_NAME);
    return open + APP_NAME + close;
  }
);
if (!renamed) {
  fail('strings.xml 里没找到 app_name，模板结构跟预期不一样，先人工看一眼');
}
fs.writeFileSync(stringsPath, strings, 'utf8');

/* 4. 自查：我加进去的文件里引用的资源，在 res/ 下都得真有定义。
      这类引用写错（名字错了、类型写错）在本地完全看不出来，
      但 aapt2 会让 Android 构建直接失败。与其等 CI 报错再猜，
      不如在这里先对一遍。 */
const refs = new Set();
(function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { scan(p); continue; }
    if (!name.endsWith('.xml')) continue;
    const text = fs.readFileSync(p, 'utf8');
    const re = /@(drawable|color|mipmap)\/([A-Za-z0-9_]+)/g;
    let m;
    while ((m = re.exec(text))) refs.add(m[1] + '/' + m[2]);
  }
})(SRC);

function defined(type, name) {
  const roots = fs.readdirSync(RES).filter(d => d.startsWith(type) || d.startsWith('values'));
  for (const d of roots) {
    const dir = path.join(RES, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      // drawable/x → drawable*/x.xml|png；color/x → values*/*.xml 里的 <color name="x">
      if (d.startsWith('values')) {
        if (type === 'color' && new RegExp('name="' + name + '"').test(fs.readFileSync(path.join(dir, f), 'utf8'))
            && /<color\b/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) return true;
      } else if (f === name + '.xml' || f === name + '.png' || f === name + '.webp') {
        return true;
      }
    }
  }
  return false;
}

const missing = [];
for (const ref of refs) {
  const [type, name] = ref.split('/');
  if (!defined(type, name)) missing.push('@' + ref);
}
if (missing.length) {
  fail('下面这些资源被引用了但 res/ 里没有定义，安卓构建会失败：\n  ' + missing.join('\n  '));
}
console.log('  自查：' + refs.size + ' 处资源引用都有定义');

console.log('\n准备好了：' + copied + ' 个图标资源，' + renamed + ' 处应用名。');
