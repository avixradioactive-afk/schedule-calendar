/* ══════════════════════════════════════════════════════════
   todo.js — 「一条可以勾掉的事」的公共渲染与交互

   备忘录用 memo: 前缀，日程用 event: 前缀。左侧任务栏（tasks.js）和
   当日面板的备忘录区（day.js）共用这一套，免得勾选 / 改名 / 删除
   三处各写一遍。
   ══════════════════════════════════════════════════════════ */

var Todo = (function () {
  'use strict';

  /**
   * @param {object} it  { ref:'memo:xxx', text, sub, done, color }
   *                     ref 形如 「类型:id」，交给下面的 split 拆
   */
  function rowHTML(it) {
    return '<div class="todo' + (it.done ? ' done' : '') + '"' +
             ' data-todo="' + Sched.esc(it.ref) + '"' +
             (it.color ? ' data-color="' + Sched.esc(it.color) + '"' : '') + '>' +
             '<input type="checkbox" class="todo-chk" data-todo-toggle' +
               (it.done ? ' checked' : '') + ' aria-label="标记完成">' +
             '<div class="todo-body" data-todo-text title="点击修改">' +
               '<span class="todo-t">' + Sched.esc(it.text) + '</span>' +
               (it.sub ? '<span class="todo-sub">' + Sched.esc(it.sub) + '</span>' : '') +
             '</div>' +
             '<button type="button" class="todo-del" data-todo-del title="删除">✕</button>' +
           '</div>';
  }

  function split(ref) {
    var s = String(ref);
    var i = s.indexOf(':');
    return { kind: s.slice(0, i), id: s.slice(i + 1) };
  }

  function byRef(p) {
    return p.kind === 'memo' ? Sched.getMemo(p.id) : Sched.getEvent(p.id);
  }

  function toggle(ref) {
    var p = split(ref);
    return p.kind === 'memo' ? !!Sched.toggleMemo(p.id) : !!Sched.toggleEventDone(p.id);
  }

  function remove(ref) {
    var p = split(ref);
    if (p.kind === 'memo') return Sched.removeMemo(p.id);

    var e = Sched.getEvent(p.id);
    if (!e) return false;
    if (!confirm('删除日程「' + e.title + '」？')) return false;
    return Sched.removeEvent(p.id);
  }

  function rename(ref, text) {
    var p = split(ref);
    if (p.kind === 'memo') return Sched.updateMemo(p.id, { text: text });
    return Sched.updateEvent(p.id, { title: text });
  }

  /** 就地改名：把文字换成输入框。回车/失焦保存，Esc 放弃。
   *  没改动时不 commit，所以得自己把原内容放回去。 */
  function editInline(el) {
    if (el.querySelector('input')) return;

    var row = el.closest('.todo');
    if (!row) return;
    var ref = row.dataset.todo;
    var p = split(ref);
    var o = byRef(p);
    if (!o) return;

    var orig = p.kind === 'memo' ? o.text : o.title;
    var backup = el.innerHTML;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'todo-edit';
    input.value = orig;
    input.maxLength = p.kind === 'memo' ? 300 : 200;

    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();

    var closed = false;
    function finish(save) {
      if (closed) return;
      closed = true;
      var v = input.value.trim();
      // 改了才写盘；写盘会触发重画，这一行整个被换掉
      if (save && v && v !== orig) { rename(ref, v); return; }
      el.innerHTML = backup;
    }

    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();          // 别让全局快捷键吃掉方向键
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
  }

  /** 在容器上挂一次事件委托；容器里面的 HTML 可以随便重画 */
  function bind(container) {
    container.addEventListener('change', function (ev) {
      var chk = ev.target.closest('[data-todo-toggle]');
      if (!chk) return;
      var row = chk.closest('.todo');
      if (row) toggle(row.dataset.todo);
    });

    container.addEventListener('click', function (ev) {
      var del = ev.target.closest('[data-todo-del]');
      if (del) {
        ev.stopPropagation();
        var row = del.closest('.todo');
        if (row && remove(row.dataset.todo)) App.toast('已删除');
        return;
      }
      var txt = ev.target.closest('[data-todo-text]');
      if (txt) { ev.stopPropagation(); editInline(txt); }
    });
  }

  /** 列表上色：日程用自己的颜色，备忘录统一用中性色 */
  function paint(container) {
    var rows = container.querySelectorAll('.todo[data-color]');
    for (var i = 0; i < rows.length; i++) {
      Sched.applyColors(rows[i], rows[i].dataset.color);
    }
  }

  return { rowHTML: rowHTML, bind: bind, paint: paint };
})();
