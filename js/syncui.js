/* ══════════════════════════════════════════════════════════
   syncui.js — 云同步的界面：设置弹窗、状态显示、冲突选择

   逻辑都在 sync.js 里，这里只负责把它的话翻译成人看的。
   ══════════════════════════════════════════════════════════ */

var SyncUI = (function () {
  'use strict';

  var dlg, repoEl, tokenEl, stateEl, errEl, conflictEl, backupEl;
  var localFactsEl, cloudFactsEl;

  function $(id) { return document.getElementById(id); }

  function init() {
    dlg          = $('dlg-sync');
    repoEl       = $('sy-repo');
    tokenEl      = $('sy-token');
    stateEl      = $('sy-state');
    errEl        = $('sy-err');
    conflictEl   = $('sy-conflict');
    backupEl     = $('sy-backup');
    localFactsEl = $('sy-cf-local');
    cloudFactsEl = $('sy-cf-cloud');

    $('bd-sy-close').addEventListener('click', function () { dlg.close(); });

    $('bd-sy-save').addEventListener('click', function () {
      var parts = splitRepo(repoEl.value);
      if (!parts) { App.toast('仓库要写成 用户名/仓库名 的形式'); return; }
      var token = tokenEl.value.trim();
      var cfg = Sync.config;
      if (!token && !(cfg && cfg.token)) { App.toast('还要填 Token'); return; }
      var patch = { owner: parts[0], repo: parts[1] };
      if (token) patch.token = token;      // 留空表示不改原来那个
      Sync.configure(patch);
      tokenEl.value = '';
      App.toast('已保存，开始同步');
      Sync.start();
      Sync.pull();
      paint();
    });

    $('bd-sy-test').addEventListener('click', function () {
      var parts = splitRepo(repoEl.value);
      var token = tokenEl.value.trim() || (Sync.config && Sync.config.token);
      if (!parts || !token) { App.toast('先填仓库和 Token'); return; }
      // 用当前填的这组凭据临时试一下，不写进配置
      var keep = Sync.config;
      Sync.configure({ owner: parts[0], repo: parts[1], token: token });
      stateEl.textContent = '正在测试…';
      errEl.hidden = true;
      Sync.probeRepo().then(function () {
        var f = '连接正常' + (Sync.status.state === 'off' ? '' : '');
        errEl.hidden = false;
        errEl.className = 'sy-line ok';
        errEl.textContent = f;
      }).catch(function (e) {
        errEl.hidden = false;
        errEl.className = 'sy-line bad';
        errEl.textContent = e.message || String(e);
      });
    });

    $('bd-sy-now').addEventListener('click', function () {
      var dirty = Sched.state.lastSeq !== (Sync.config && Sync.config.syncedSeq);
      if (!Sync.isConfigured()) { App.toast('先填好仓库和 Token'); return; }
      stateEl.textContent = '同步中…';
      // 空数据要不要推，交给用户点头——这一步会清掉云端的
      var empty = countItems(Sched.state) === 0;
      if (empty && !dirty) { Sync.syncNow(); return; }
      if (empty && !confirm('本机的日程、提醒、课程都是空的。\n继续会把云端那份也清空。确定吗？')) return;
      Sync.syncNow();
    });

    $('bd-sy-off').addEventListener('click', function () {
      if (!confirm('断开同步？本机数据会保留，云端那份也会留着，只是不再互相同步。')) return;
      Sync.disconnect();
      repoEl.value = '';
      tokenEl.value = '';
      paint();
    });

    $('bd-cf-cloud').addEventListener('click', function () { resolve('cloud'); });
    $('bd-cf-local').addEventListener('click', function () { resolve('local'); });
    $('bd-cf-both').addEventListener('click', function () { resolve('both'); });

    $('bd-sy-download').addEventListener('click', function () {
      var b = Sync.lastBackup();
      if (!b) return;
      download('schedule-backup-' + new Date(b.data.at).toISOString().slice(0, 10) + '.json',
               JSON.stringify(b.data.state, null, 2));
    });

    Sync.onStatus(function () { paint(); });
  }

  function resolve(choice) {
    Sync.resolveConflict(choice).then(function (r) {
      if (r === 'error') return;
      App.toast(choice === 'both' ? '已用云端的，本地那份进了备份'
               : choice === 'cloud' ? '已用云端的' : '已用本地的');
      paint();
    });
  }

  function open() {
    if (Sync.isConfigured()) {
      repoEl.value = Sync.config.owner + '/' + Sync.config.repo;
      $('sy-path').value = Sync.FILE;
    }
    paint();
    dlg.showModal();
  }

  /* ── 渲染 ── */

  function paint() {
    var st = Sync.status;
    var cfg = Sync.config;

    // ⋯ 菜单上的那一行 + 小圆点
    var label = $('sy-menu-label');
    var dot = $('sync-dot');
    if (label) label.textContent = menuLabel(st);
    if (dot) {
      dot.hidden = (st.state === 'off' || st.state === 'idle');
      dot.className = 'sync-dot' +
        (st.state === 'conflict' ? ' warn' : st.state === 'syncing' ? ' busy' : ' bad');
    }

    if (!dlg) return;

    stateEl.className = 'sy-line';
    if (st.state === 'off') {
      stateEl.textContent = '未开启。数据只存在这台设备上。';
    } else if (st.state === 'syncing') {
      stateEl.textContent = st.message || '同步中…';
    } else if (st.state === 'idle') {
      // 只有一切正常时才报「上次同步」——出错或冲突的时候，
      // 那是干扰信息，用户要看的是下面那段
      var when = cfg && cfg.lastSyncAt ? '，上次同步 ' + ago(cfg.lastSyncAt) : '';
      stateEl.textContent = (st.message || '已连接') + when;
    } else {
      stateEl.textContent = st.message || '已连接';
    }

    var err = cfg && cfg.lastError;
    errEl.hidden = !err;
    if (err) {
      errEl.className = 'sy-line bad';
      errEl.textContent = err;
    }

    // 冲突
    var cf = Sync.conflict;
    conflictEl.hidden = !cf;
    if (cf) {
      localFactsEl.textContent = facts(Sched.state);
      cloudFactsEl.textContent = facts(cf.cloud.state);
    }

    // 备份
    var b = Sync.lastBackup();
    backupEl.hidden = !b;
    if (b) {
      $('sy-bak-info').textContent = ago(b.data.at) + '（' + b.data.reason + '）';
    }

    $('bd-sy-off').hidden = !cfg;
    $('bd-sy-now').hidden = !cfg;
    $('bd-sy-test').hidden = !cfg;
  }

  function menuLabel(st) {
    if (st.state === 'off') return '云同步 · 未开启';
    if (st.state === 'syncing') return '云同步 · 同步中…';
    if (st.state === 'conflict') return '云同步 · 有冲突，需要处理';
    if (st.state === 'error') return '云同步 · 出错了';
    if (st.state === 'blocked') return '云同步 · 已暂停';
    return '云同步 · ' + (st.message || '已连接');
  }

  /** 冲突弹窗里那一行事实。哪一边由前面的标签负责，这里只报数字，
      不然会写成「本机 · 本机 · 刚刚 · …」。 */
  function facts(s) {
    var when = s.savedAt ? ago(s.savedAt) : '时间未知';
    var n = countItems(s);
    var ev = (s.events || []).length, me = (s.memos || []).length, co = (s.courses || []).length;
    return when + ' · 共 ' + n + ' 项' +
           '（日程 ' + ev + ' / 提醒 ' + me + ' / 课程 ' + co + '）';
  }

  function countItems(s) {
    return (s.events || []).length + (s.memos || []).length + (s.courses || []).length;
  }

  function ago(ts) {
    var d = Date.now() - ts;
    if (d < 0) d = 0;
    var m = Math.floor(d / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  function splitRepo(v) {
    var m = /^\s*([^\/\s]+)\s*\/\s*([^\/\s]+)\s*$/.exec(v || '');
    return m ? [m[1], m[2]] : null;
  }

  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  return { init: init, open: open, paint: paint, countItems: countItems };
})();
