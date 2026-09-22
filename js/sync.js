/* ══════════════════════════════════════════════════════════
   sync.js — 云同步：整份数据存进一个私有 GitHub 仓库的
   schedule.json，用 Contents API 直接读写。

   这里只管逻辑，不碰 DOM（界面在 syncui.js），这样才能在 node 里
   用假传输层把各种失败场景全测一遍。

   ── 两条不能动的规矩 ────────────────────────────────────

   1. baseSha 只在两种情况下前进：真的采纳了云端内容，或者自己推送
      成功。**扔掉内容的 GET 绝不能动 baseSha**。否则：轮询拿到别人的
      新 sha 却丢了内容，本地随后一推，带的是那个「新的」sha，
      GitHub 认为没问题，直接把对方整份数据覆盖掉——没有冲突提示、
      没有报错。乐观锁只在「你带的 sha 对应你这次改动所基于的内容」
      时才保护你。

   2. 绝不拿时间戳比谁新。两台设备的时钟不可信，而且时钟慢的那台
      会**永远**推不上去（它写的时间戳总小于刚采纳的云端值）。
      判据只有内容身份：cloudSha !== baseSha 就是冲突，
      「本地有没有没推上去的改动」用本机记的 lastSeq 对比，时钟碰不到。
   ══════════════════════════════════════════════════════════ */

var Sync = (function () {
  'use strict';

  var CFGKEY  = 'schedule.sync';        // 同步配置 + 同步进度（含 token，绝不进 state）
  var DEVKEY  = 'schedule.device';      // 本机标识，断开同步也不该丢
  var LOCKKEY = 'schedule.sync.lock';   // 多标签页选主
  var BAKKEY  = 'schedule.backup.';     // 覆盖前的备份
  var FILE    = 'schedule.json';
  var API     = 'https://api.github.com';
  var APIVER  = '2022-11-28';

  var POLL_MS      = 5 * 60 * 1000;   // 页面开着时的轮询间隔
  var PUSH_IDLE_MS = 20 * 1000;       // 停手这么久才推，免得几百个 commit
  var PUSH_MIN_MS  = 60 * 1000;       // 两次推送之间至少隔这么久
  var LOCK_MS      = 90 * 1000;       // 多标签页选主的租约
  var MAX_BACKUP   = 5;               // 本地最多留几份备份

  /* ── 运行时状态 ──────────────────────────────────────────── */

  var cfg = null;          // { owner, repo, token, baseSha, syncedSeq, pushedSeq, lastSyncAt, lastError }
  var writerId = '';       // 本机标识
  var tabId = uid();       // 本次页面加载的标识（只用于选主）
  var status = { state: 'off', message: '' };
  var watchers = [];       // 状态变化回调，给界面用
  var transport = httpFetch;
  var canAdopt = function () { return true; };
  var selfWrite = false;   // 正在采纳云端内容，别把自己的写入当成用户改动
  var busy = false;        // 一次只跑一个同步动作
  var pending = null;      // 悬而未决的冲突：{ cloud }
  var lastPushAt = 0;
  var failures = 0;        // 连续失败次数，用来退避
  var timers = [];         // 轮询等周期性定时器
  var pushTimer = null;    // 「停手一会儿再推」的延时器
  var started = false;

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /* ── 状态对外播报 ────────────────────────────────────────── */

  function setStatus(state, message) {
    status = { state: state, message: message || '' };
    for (var i = 0; i < watchers.length; i++) {
      try { watchers[i](status); } catch (e) { console.warn(e); }
    }
  }

  function onStatus(fn) { watchers.push(fn); fn(status); }

  /** 出错了：冻结同步，别再后台轮询里一遍遍撞墙 */
  function fail(e) {
    var msg = (e && e.message) || String(e);
    cfg.lastError = msg;
    saveCfg();
    // 认证类错误是「你不改好就永远不会好」，直接停掉自动同步
    var fatal = e && (e.kind === 'auth' || e.kind === 'scope' || e.kind === 'app-older');
    setStatus(fatal ? 'blocked' : 'error', msg);
    if (fatal) stopTimers();
    return e;
  }

  /* ── 配置读写 ────────────────────────────────────────────── */

  function readJSON(key) {
    try {
      var raw = (typeof localStorage !== 'undefined') && localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeJSON(key, val) {
    try {
      if (typeof localStorage === 'undefined') return true;
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) { return false; }
  }

  function saveCfg() {
    if (!cfg) return true;
    return writeJSON(CFGKEY, cfg);
  }

  function isConfigured() {
    return !!(cfg && cfg.owner && cfg.repo && cfg.token);
  }

  /** 设备 id：一次生成，之后一直用。放在自己的键里，断开同步也不重置——
      它不是凭据，它是「这台设备是谁」，换了会让云端认不出自己写的记录。 */
  function initDevice() {
    var d = readJSON(DEVKEY);
    if (!d || !d.writerId) {
      d = { writerId: uid() + uid() };
      writeJSON(DEVKEY, d);
    }
    writerId = d.writerId;
    if (Sched.setWriter) Sched.setWriter(writerId);
    return writerId;
  }

  function configure(opts) {
    cfg = cfg || {};
    if ('owner' in opts) cfg.owner = String(opts.owner || '').trim();
    if ('repo' in opts)  cfg.repo  = String(opts.repo  || '').trim();
    if ('token' in opts) cfg.token = String(opts.token || '').trim();
    if (cfg.syncedSeq === undefined) cfg.syncedSeq = null;
    if (cfg.baseSha === undefined)   cfg.baseSha = '';
    if (cfg.pushedSeq === undefined) cfg.pushedSeq = '';
    cfg.lastError = '';
    failures = 0;
    saveCfg();
    if (isConfigured()) setStatus('idle', '已连接');
    else setStatus('off', '');
    return cfg;
  }

  function disconnect() {
    stopTimers();
    cfg = null;
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(CFGKEY); localStorage.removeItem(LOCKKEY); } catch (e) {}
    }
    pending = null;
    setStatus('off', '');
  }

  /* ── base64（UTF-8 安全）─────────────────────────────────────
     btoa(JSON.stringify(state)) 是错的：只要有一个中文字符就会抛
     InvalidCharacterError，而这个应用里必然有。          */

  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [], i, c, c2;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xD800 && c <= 0xDBFF) {
        c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          i++;
          out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63),
                   0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        } else out.push(0xEF, 0xBF, 0xBD);
      } else if (c >= 0xDC00 && c <= 0xDFFF) out.push(0xEF, 0xBF, 0xBD);
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /** 按 3 字节一组手写，不用 apply、不建大数组，1MB 也不会爆栈 */
  function bytesToB64(bytes) {
    var out = '', i, n = bytes.length, rem = n % 3, main = n - rem, a, b, x;
    for (i = 0; i < main; i += 3) {
      x = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64C[(x >> 18) & 63] + B64C[(x >> 12) & 63] +
             B64C[(x >> 6) & 63] + B64C[x & 63];
    }
    if (rem === 1) {
      a = bytes[main];
      out += B64C[a >> 2] + B64C[(a & 3) << 4] + '==';
    } else if (rem === 2) {
      b = (bytes[main] << 8) | bytes[main + 1];
      out += B64C[b >> 10] + B64C[(b >> 4) & 63] + B64C[(b & 15) << 2] + '=';
    }
    return out;
  }

  function strToB64(str) { return bytesToB64(utf8Bytes(str)); }

  function b64ToStr(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var i, n = bin.length, bytes = new Uint8Array(n);
    for (i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    // TextDecoder 默认会把 BOM 吃掉；手写分支就得自己剥，
    // 否则 JSON.parse 会在 ﻿ 上抛错
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '', c, c2, c3, c4, cp;
    i = 0;
    if (n >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;
    while (i < n) {
      c = bytes[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xE0) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else if (c < 0xF0) {
        c2 = bytes[i++];
        s += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (bytes[i++] & 63));
      } else {
        c2 = bytes[i++]; c3 = bytes[i++]; c4 = bytes[i++];
        cp = ((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63);
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
      }
    }
    return s;
  }

  /* ── 传输层 ──────────────────────────────────────────────── */

  function httpFetch(req) {
    return fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (text) {
        return { status: res.status, text: text };
      });
    });
  }

  function useTransport(fn) { transport = fn; }

  function err(kind, message, status) {
    var e = new Error(message);
    e.kind = kind;
    e.status = status;
    return e;
  }

  function apiUrl() {
    return API + '/repos/' + encodeURIComponent(cfg.owner) + '/' +
           encodeURIComponent(cfg.repo) + '/contents/' + FILE;
  }

  function repoUrl() {
    return API + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);
  }

  function headers() {
    return {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': APIVER,
      'Content-Type': 'application/json'
    };
  }

  /**
   * 把 HTTP 状态翻译成人话。
   * 这里的每个分支都有实际来历：
   *  - 私有仓库**没权限时 GitHub 也返回 404**（故意不区分「不存在」和「没权限」）
   *  - 仓库还没有任何提交时，PUT 会返回 409 + "Git Repository is empty."
   *  - 文件不存在却带了 sha 去 PUT，返回的是 422，不是 409
   *  - 权限给少了（只读）GET 正常、只有 PUT 才 403
   */
  function classify(res, body) {
    var msg = (body && body.message) || '';
    var s = res.status;

    if (s === 200 || s === 201) return null;
    if (s === 401) return err('auth', 'Token 无效或已过期，请重新生成一个填进来', s);
    if (s === 403) {
      if (/rate limit/i.test(msg)) return err('rate', 'GitHub 接口调用次数超了，稍后会自动重试', s);
      return err('scope', 'Token 权限不够：需要对该仓库的 Contents 读写权限', s);
    }
    if (s === 404) return err('missing', '找不到仓库或文件——私有仓库没授权时 GitHub 也会返回 404，请检查仓库名和 Token 的授权范围', s);
    if (s === 409) {
      if (/empty/i.test(msg)) {
        // 没有任何提交的仓库，Contents API 建不了文件——不是权限也不是网络问题，
        // 得先有一个提交。让提示直接指向那个动作，别让用户去猜。
        return err('repo-empty', '仓库还没有任何提交，这样的仓库没法直接写文件。' +
          '去 GitHub 仓库页面点 Add file → Create new file，名字填 README.md，' +
          '提交一次，再回来同步就好了。', s);
      }
      return err('conflict', '云端文件在你操作期间被改过', s);
    }
    if (s === 422) return err('stale-sha', '本地记录的版本对不上云端文件', s);
    if (s === 304) return err('not-modified', '', s);
    return err('http', 'GitHub 返回了 ' + s + (msg ? '：' + msg : ''), s);
  }

  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function request(method, url, payload) {
    return transport({
      method: method,
      url: url,
      headers: headers(),
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (res) {
      var body = parse(res.text) || {};
      var e = classify(res, body);
      if (e) throw e;
      return body;
    });
  }

  /* ── 仓库探测 / 拉取 / 推送 ───────────────────────────────── */

  /** 仓库本身能不能访问到——用来把「文件还没建」和「根本进不去」分开 */
  function probeRepo() {
    return transport({ method: 'GET', url: repoUrl(), headers: headers() })
      .then(function (res) {
        if (res.status === 200) return true;
        if (res.status === 404) {
          throw err('missing', '访问不到仓库 ' + cfg.owner + '/' + cfg.repo +
            '。两种可能：名字写错了，或者 Token 没有授权到这个仓库（私有仓库没授权时 GitHub 也返回 404）。');
        }
        var e = classify(res, parse(res.text) || {});
        throw e || err('http', '仓库探测失败');
      });
  }

  /** @returns Promise<null|{sha,state,text}> */
  function fetchCloud() {
    return transport({ method: 'GET', url: apiUrl(), headers: headers() })
      .then(function (res) {
        if (res.status === 404) return null;          // 文件还没建，属于正常情况
        var body = parse(res.text) || {};
        var e = classify(res, body);
        if (e) throw e;

        // 内容超出内联上限时 GitHub 返回 encoding:"none" 且 content 为空。
        // 这里**绝不能**把它当成空数据——那会直接抹掉一整个日历。
        if (body.encoding === 'none' || (!body.content && body.size > 0)) {
          throw err('too-big', '云端的 schedule.json 太大（' +
            Math.round((body.size || 0) / 1024) + ' KB），超出接口能内联的上限，同步先停住。');
        }

        var text = b64ToStr(body.content || '');
        var obj;
        try { obj = JSON.parse(text); }
        catch (e2) {
          throw err('bad-cloud', '云端文件不是合法的 JSON，同步停住，没有动它——' +
            '你可以去仓库的历史记录里找回上一版。');
        }
        return { sha: body.sha, state: obj, text: text };
      });
  }

  function countItems(s) {
    if (!s) return 0;
    return (s.events ? s.events.length : 0) +
           (s.memos ? s.memos.length : 0) +
           (s.courses ? s.courses.length : 0);
  }

  /** 推送。sha 为空表示「新建文件」。 */
  function sendCloud(text, sha, message) {
    var payload = {
      message: message || ('日程同步 ' + new Date().toISOString().slice(0, 16).replace('T', ' ')),
      content: strToB64(text)
    };
    if (sha) payload.sha = sha;

    return request('PUT', apiUrl(), payload).then(function (body) {
      return (body.content && body.content.sha) || '';
    });
  }

  /* ── 备份：任何「要丢掉一份数据」的动作之前都得先留一份 ────── */

  function backupKeys() {
    var out = [];
    if (typeof localStorage === 'undefined') return out;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(BAKKEY) === 0) out.push(k);
    }
    out.sort();
    return out;
  }

  /**
   * 备份一份状态。写不进去就返回 false——调用方**必须**因此中止
   * 破坏性操作（fail closed），不能因为备份失败反而继续覆盖。
   */
  function stash(reason, snapshot) {
    var key = BAKKEY + Date.now();
    var ok = writeJSON(key, { reason: reason, at: Date.now(), state: snapshot });
    if (!ok) return null;
    var keys = backupKeys();
    while (keys.length > MAX_BACKUP) {
      try { localStorage.removeItem(keys.shift()); } catch (e) {}
    }
    return key;
  }

  /** 最近一份备份，给界面提供「下载备份」用 */
  function lastBackup() {
    var keys = backupKeys();
    if (!keys.length) return null;
    return { key: keys[keys.length - 1], data: readJSON(keys[keys.length - 1]) };
  }

  /* ── 判定 ────────────────────────────────────────────────── */

  /**
   * 云端这份和本地这份，该怎么办。判据只有两项：
   *   cloud.sha === cfg.baseSha  → 云端就是我同步过的那份，本地推上去即可
   *   dirty（本机记录的 lastSeq 对不上）→ 本地有没推上去的改动
   * 没有时间戳参与，时钟错乱也影响不到。
   */
  function decide(cloud) {
    var clean = !!cloud && cloud.sha === cfg.baseSha;
    var localHasData = countItems(Sched.state) > 0;
    // 「本地有没推上去的改动」= 本机记的 lastSeq 对不上 + 本地确实有东西。
    // 后半个条件不能少：新设备本地是空的、lastSeq 是空串，跟 syncedSeq
    // 的 null 一比就成了「有改动」，于是永远采纳不了云端。
    var dirty = Sched.state.lastSeq !== cfg.syncedSeq && localHasData;

    if (!cloud) {
      // 文件还没有。本地有东西就建，没有就等
      return localHasData ? 'push-create' : 'nothing';
    }
    if (clean) {
      return dirty ? 'push' : 'nothing';
    }
    if (dirty) {
      // 两边都变了。永远不自动选谁赢——由人来看清楚再决定。
      return 'conflict';
    }
    // 本地没有未同步的改动，采纳云端丢不了东西
    if ((+cloud.state.version || 1) > Sched.VERSION) return 'app-older';
    if (countItems(cloud.state) === 0 && localHasData) return 'suspect-empty';
    return 'adopt';
  }

  function adoptCloud(cloud) {
    selfWrite = true;
    try { Sched.adopt(cloud.state); }
    finally { selfWrite = false; }
    cfg.baseSha = cloud.sha;
    cfg.syncedSeq = cloud.state.lastSeq || null;
    saveCfg();
  }

  /* ── 拉取 ────────────────────────────────────────────────── */

  function pull() {
    if (!isConfigured()) return Promise.resolve('off');
    if (!canAdopt()) return Promise.resolve('busy-dialog');

    setStatus('syncing', '正在检查云端…');
    return probeRepo()
      .then(fetchCloud)
      .then(function (cloud) {
        var act = decide(cloud);

        if (act === 'nothing') { done('已是最新'); return 'nothing'; }

        // 云端还没有文件、本地有东西：直接把文件建出来。
        // 不能只挂个「待推送」了事——新设备配好之后往往不会再改任何东西，
        // 光等「改动触发推送」的话，文件永远建不出来。
        if (act === 'push-create') return createCloud();
        if (act === 'push') { setStatus('idle', '有本地改动待推送'); return 'pending-push'; }

        if (act === 'app-older') {
          throw err('app-older', '云端数据是这个页面还不认识的新版本。' +
            '请先更新应用（手机上的 APK 也需要重装），再同步——' +
            '现在推上去会把新版本才有的字段抹掉。');
        }
        if (act === 'suspect-empty') {
          throw err('suspect-empty', '云端那份是空的，本地却有数据。' +
            '没有自动覆盖——请确认云端仓库里的 schedule.json 是不是被清过。');
        }
        if (act === 'conflict') {
          pending = { cloud: cloud };
          failures = 0;
          setStatus('conflict', '两边都改过，需要你选一下');
          return 'conflict';
        }

        adoptCloud(cloud);
        done('已从云端拉取');
        return 'adopt';
      })
      .catch(function (e) { fail(e); return 'error'; });
  }

  function done(msg) {
    failures = 0;
    cfg.lastError = '';
    cfg.lastSyncAt = Date.now();
    saveCfg();
    setStatus('idle', msg);
  }

  /* ── 推送 ────────────────────────────────────────────────── */

  /** 云端还没有文件：建出来（不带 sha） */
  function createCloud() {
    var text = Sched.serialize();
    var sentSeq = Sched.state.lastSeq;
    setStatus('syncing', '正在上传…');
    return sendCloud(text, '')
      .then(function (newSha) {
        cfg.baseSha = newSha;
        cfg.syncedSeq = sentSeq;
        lastPushAt = Date.now();
        done('已同步到云端');
        return 'pushed';
      })
      .catch(function (e) { fail(e); return 'error'; });
  }

  /**
   * 云端不再是我基于的那一版：先看清它到底是什么，再决定怎么办。
   * 不直接重试推送——拿着旧 sha 重试只会又撞一次，然后弹一个
   * 「自己跟自己」的冲突窗。
   */
  function resyncThenMaybePush() {
    cfg.baseSha = '';
    saveCfg();
    return fetchCloud().then(function (cloud) {
      var localHasData = countItems(Sched.state) > 0;

      // 文件被人删了：直接重建
      if (!cloud) return localHasData ? createCloud() : Promise.resolve('nothing');

      var act = decide(cloud);
      if (act === 'conflict') {
        pending = { cloud: cloud };
        setStatus('conflict', '两边都改过，需要你选一下');
        return 'conflict';
      }
      if (act === 'adopt') {
        adoptCloud(cloud);
        done('已从云端拉取');
        return 'adopt';
      }
      if (act === 'app-older') {
        throw err('app-older', '云端数据是这个页面还不认识的新版本，请先更新应用再同步。');
      }
      if (act === 'suspect-empty') {
        throw err('suspect-empty', '云端那份是空的，本地却有数据。没有自动覆盖——' +
          '请确认仓库里的 schedule.json 是不是被清过。');
      }
      return 'nothing';   // 云端的版本和我这次要写的对不上，但没有本地改动，等下次
    }).catch(function (e) { fail(e); return 'error'; });
  }

  function push(isManual) {
    if (!isConfigured()) return Promise.resolve('off');
    if (!canAdopt()) return Promise.resolve('busy-dialog');

    var text = Sched.serialize();
    var sentSeq = Sched.state.lastSeq;
    var items = countItems(Sched.state);

    // 「把整个日历清空」这种事不该自动推上去——多半是误操作。
    // 手动点「立即同步」仍然可以，那时用户是清醒的。
    if (!isManual && items === 0 && cfg.syncedSeq) {
      setStatus('idle', '本地是空的，没有自动推送（要清空云端请点「立即同步」）');
      return Promise.resolve('skip-empty');
    }

    setStatus('syncing', '正在上传…');
    var sha = cfg.baseSha || '';

    // 先把这次要写的 seq 记下来：万一响应丢了但其实写成功了，
    // 下次能凭它认出「那是我的写入」而不是别人的改动
    cfg.pushedSeq = sentSeq;
    saveCfg();

    return sendCloud(text, sha)
      .then(function (newSha) {
        cfg.baseSha = newSha;
        cfg.syncedSeq = sentSeq;
        lastPushAt = Date.now();
        done('已同步到云端');
        return 'pushed';
      })
      .catch(function (e) {
        // 仓库一次提交都没有：不带 sha 再发一次就好
        if (e.kind === 'repo-empty') {
          return sendCloud(text, '')
            .then(function (newSha) {
              cfg.baseSha = newSha;
              cfg.syncedSeq = sentSeq;
              lastPushAt = Date.now();
              done('已同步到云端');
              return 'pushed';
            })
            .catch(function (e2) { fail(e2); return 'error'; });
        }

        var retryable = e.kind === 'http' || e.kind === 'conflict' || e.kind === 'stale-sha';
        if (retryable) {
          // 请求发出去了但没收到回应：服务端可能其实已经写成功了。
          // 先认一下云端那份是不是我自己刚发的，别自己跟自己报冲突。
          return recoverAfterFailedPush(sentSeq, text).then(function (recovered) {
            if (recovered) { done('已同步到云端'); return 'pushed'; }
            if (e.kind === 'http') { fail(e); return 'error'; }
            return resyncThenMaybePush();
          });
        }

        fail(e);
        return 'error';
      });
  }

  /** 推送失败后：云端那份是不是恰好就是我自己刚发的那次？ */
  function recoverAfterFailedPush(sentSeq, text) {
    return fetchCloud().then(function (cloud) {
      if (!cloud) return false;
      if (cloud.state.lastWriter === writerId && cloud.state.lastSeq === sentSeq) {
        cfg.baseSha = cloud.sha;
        cfg.syncedSeq = sentSeq;
        lastPushAt = Date.now();
        return true;
      }
      // 内容一模一样也算成功（比如另一个标签页替我推了同一份）
      if (cloud.text === text) {
        cfg.baseSha = cloud.sha;
        cfg.syncedSeq = sentSeq;
        lastPushAt = Date.now();
        return true;
      }
      return false;
    }).catch(function () { return false; });
  }

  /* ── 冲突处理 ────────────────────────────────────────────── */

  /**
   * @param {string} choice 'cloud' 用云端的 / 'local' 用本地的 / 'both' 都要
   *   'both' = 采纳云端，同时把本地那份备份下来并提示下载（唯一不会丢数据的选项）
   */
  function resolveConflict(choice) {
    if (!pending) return Promise.resolve('none');
    var cloud = pending.cloud;
    pending = null;

    var localSnapshot = JSON.parse(Sched.serialize());

    if (choice === 'cloud' || choice === 'both') {
      var key = stash(choice === 'both' ? '冲突：保留了本地那份' : '冲突：选择了云端', localSnapshot);
      if (!key) {
        // 备份都写不下，就别再覆盖了
        pending = { cloud: cloud };
        var e = err('stash', '本地存储写不进去，没法备份，所以没有覆盖任何东西。请先清理浏览器存储再试。');
        fail(e);
        return Promise.resolve('error');
      }
      adoptCloud(cloud);
      // 采纳之后本地那份要推上去吗？'both' 的语义是「别丢」，
      // 而本地那份已经安全地躺在备份里了，云端保持原样即可。
      failures = 0;
      setStatus('idle', choice === 'both' ? '已用云端的，本地那份已备份' : '已用云端的');
      cfg.lastSyncAt = Date.now();
      saveCfg();
      return Promise.resolve('resolved-cloud');
    }

    // 用本地的：带上云端的 sha 推上去，覆盖它
    var key2 = stash('冲突：用本地覆盖了云端', cloud.state);
    if (!key2) {
      pending = { cloud: cloud };
      fail(err('stash', '本地存储写不进去，没法备份云端那份，所以什么都没做。'));
      return Promise.resolve('error');
    }
    cfg.baseSha = cloud.sha;    // 关键：对准「我刚否掉的那一版」，
                                // 否则 PUT 会 412，然后又弹一遍同一个冲突
    saveCfg();
    return push(true);
  }

  /* ── 同步入口 ────────────────────────────────────────────── */

  /** 先把手头没推的改动推上去，再拉。顺序反了会拿云端盖掉本地没推的改动。 */
  function syncNow() {
    if (!isConfigured()) return Promise.resolve('off');
    if (busy) return Promise.resolve('busy');
    busy = true;
    var had = pending;
    pending = null;
    return Promise.resolve()
      .then(function () { return had ? 'conflict-pending' : null; })
      .then(function (x) {
        if (x) { pending = had; setStatus('conflict', '有冲突还没处理'); return x; }
        var dirty = Sched.state.lastSeq !== cfg.syncedSeq;
        return dirty ? push(true) : null;
      })
      .then(function () { return pull(); })
      .then(function (r) { busy = false; return r; })
      .catch(function (e) { busy = false; fail(e); return 'error'; });
  }

  /* ── 定时器 / 多标签页 ───────────────────────────────────── */

  /** 只有拿到租约的标签页才轮询和推送，免得两个标签页各推各的 */
  function hasLease() {
    var lock = readJSON(LOCKKEY);
    var now = Date.now();
    if (!lock || !lock.tab || lock.expires < now || lock.tab === tabId) {
      writeJSON(LOCKKEY, { tab: tabId, expires: now + LOCK_MS });
      return true;
    }
    return false;
  }

  function every(ms, fn) {
    var t = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!hasLease()) return;
      fn();
    }, ms);
    timers.push(t);
    return t;
  }

  function stopTimers() {
    timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    timers = [];
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    started = false;
  }

  /** 本地改了东西：停手一段时间后再推，避免几百个 commit */
  function schedulePush() {
    if (!isConfigured()) return;
    if (pushTimer) clearTimeout(pushTimer);
    var wait = Math.max(PUSH_IDLE_MS, lastPushAt + PUSH_MIN_MS - Date.now());
    pushTimer = setTimeout(function () {
      pushTimer = null;
      if (!hasLease()) return;
      push(false);
    }, wait);
  }

  function flushPush() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!isConfigured()) return Promise.resolve('off');
    if (Sched.state.lastSeq === cfg.syncedSeq) return Promise.resolve('clean');
    if (!hasLease()) return Promise.resolve('no-lease');
    return push(false);
  }

  function start() {
    if (started || !isConfigured()) return;
    started = true;
    every(POLL_MS, function () { pull(); });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { flushPush(); return; }   // 切走前先把改动送出去
        if (hasLease()) pull();
      });
    }
  }

  function init(opts) {
    opts = opts || {};
    if (opts.transport) useTransport(opts.transport);
    if (opts.canAdopt) canAdopt = opts.canAdopt;
    initDevice();
    cfg = readJSON(CFGKEY);
    if (cfg) {
      if (cfg.syncedSeq === undefined) cfg.syncedSeq = null;
      if (cfg.baseSha === undefined) cfg.baseSha = '';
      if (cfg.pushedSeq === undefined) cfg.pushedSeq = '';
      setStatus('idle', '已连接');
      Sched.onChange(function () { if (!selfWrite) schedulePush(); });
    } else {
      setStatus('off', '');
    }
    return cfg;
  }

  /* ── 对外 ────────────────────────────────────────────────── */

  return {
    FILE: FILE,
    CFGKEY: CFGKEY,
    BAKKEY: BAKKEY,

    init: init,
    start: start,
    stop: stopTimers,
    useTransport: useTransport,

    configure: configure,
    disconnect: disconnect,
    isConfigured: isConfigured,
    get config() { return cfg; },
    get status() { return status; },
    get conflict() { return pending; },
    get myWriterId() { return writerId; },
    onStatus: onStatus,

    pull: pull,
    push: push,
    syncNow: syncNow,
    resolveConflict: resolveConflict,
    flushPush: flushPush,

    probeRepo: probeRepo,
    lastBackup: lastBackup,
    stash: stash,

    // 给测试用的内部件
    _decide: decide,
    _b64: { strToB64: strToB64, b64ToStr: b64ToStr, utf8Bytes: utf8Bytes, bytesToB64: bytesToB64 }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
