/* ClearShift - Admin Event Detail JS */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let members = [];
let slots = [];
let jobs = [];
let currentSlotId = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtDate = iso => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
};
const STATUS_LABEL = { scheduled: '予定', absent: '欠席', late: '遅刻' };
const STATUS_CLASS = { scheduled: 'badge-scheduled', absent: 'badge-absent', late: 'badge-late' };

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'エラーが発生しました');
  return data;
}

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `fixed top-4 right-4 z-[100] px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white flash-msg ${isError ? 'bg-red-500' : 'bg-green-500'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('border-primary', 'text-primary');
      b.classList.add('border-transparent', 'text-gray-500');
    });
    btn.classList.add('border-primary', 'text-primary');
    btn.classList.remove('border-transparent', 'text-gray-500');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    $(`tab-${tabId}`)?.classList.remove('hidden');

    if (tabId === 'members') loadMembers();
    if (tabId === 'shift') loadShifts();
    if (tabId === 'jobs') loadJobs();
  });
});

// ─── New Event Modal ──────────────────────────────────────────────────────────
const modalNewEvent = $('modal-new-event');
$('btn-new-event').addEventListener('click', () => modalNewEvent.classList.remove('hidden'));
$('modal-overlay').addEventListener('click', () => modalNewEvent.classList.add('hidden'));
document.querySelectorAll('.modal-close').forEach(b => {
  b.addEventListener('click', () => modalNewEvent.classList.add('hidden'));
});

$('form-new-event').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('new-event-error');
  errEl.classList.add('hidden');
  try {
    const data = await apiFetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: $('new-event-title').value.trim(),
        start_date: $('new-event-start').value,
        end_date: $('new-event-end').value,
      }),
    });
    window.location.href = `/events/${data.id}`;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Load Members ─────────────────────────────────────────────────────────────
// ─── Member Select Mode ───────────────────────────────────────────────────────
let selectMode = false;
let selectedIds = new Set();

function enterSelectMode() {
  selectMode = true;
  selectedIds.clear();
  $('member-normal-actions').classList.add('hidden');
  $('member-select-actions').classList.remove('hidden');
  $('member-select-actions').classList.add('flex');
  renderMemberList();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  $('member-normal-actions').classList.remove('hidden');
  $('member-select-actions').classList.add('hidden');
  $('member-select-actions').classList.remove('flex');
  renderMemberList();
}

function updateSelectUI() {
  $('select-count-label').textContent = `${selectedIds.size}件選択中`;
  const btn = $('btn-bulk-delete');
  btn.disabled = selectedIds.size === 0;
  // 全選択ボタンのラベル切替
  $('btn-select-all').textContent = selectedIds.size === members.length ? '全解除' : '全選択';
}

// 学年文字列から数値を抽出（ソート用）
function gradeNum(grade) {
  if (!grade) return 0;
  const m = grade.match(/\d+/);
  return m ? parseInt(m[0]) : 0;
}

// グループの開閉状態を保持（dept名 → true=折りたたみ中）
const collapsedDepts = new Set();
const COLLAPSE_THRESHOLD = 10;

function renderMemberList() {
  const list = $('member-list');
  if (!members.length) {
    list.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">メンバーがいません。追加してください。</div>`;
    return;
  }

  // 局でグループ化（学年降順でソート）
  const depts = {};
  [...members]
    .sort((a, b) => (b.is_leader ? 1 : 0) - (a.is_leader ? 1 : 0) || gradeNum(b.grade) - gradeNum(a.grade))
    .forEach(m => {
      const key = m.department || '未分類';
      (depts[key] = depts[key] || []).push(m);
    });

  // 初回ロード時：10人以上のグループをデフォルトで折りたたむ
  Object.entries(depts).forEach(([dept, mems]) => {
    if (!collapsedDepts.has('__init__' + dept)) {
      collapsedDepts.add('__init__' + dept);
      if (mems.length >= COLLAPSE_THRESHOLD) collapsedDepts.add(dept);
    }
  });

  list.innerHTML = Object.entries(depts).map(([dept, mems]) => {
    const collapsed = collapsedDepts.has(dept);
    const allSelected = mems.every(m => selectedIds.has(m.id));
    const someSelected = mems.some(m => selectedIds.has(m.id));

    return `
    <div class="mb-3 rounded-xl overflow-hidden border-2 border-gray-200 shadow-sm">
      <!-- グループヘッダー -->
      <button class="dept-header w-full flex items-center gap-2.5 px-4 py-2.5 bg-gray-100 hover:bg-gray-150 transition-colors text-left"
        data-dept="${dept}">
        ${selectMode ? `
          <input type="checkbox" class="dept-check w-3.5 h-3.5 accent-primary cursor-pointer flex-shrink-0"
            data-dept="${dept}"
            ${allSelected ? 'checked' : ''}
            ${someSelected && !allSelected ? 'indeterminate-marker' : ''} />
        ` : ''}
        <!-- 折りたたみ矢印 -->
        <svg class="w-3.5 h-3.5 flex-shrink-0 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
        </svg>
        <span class="text-xs font-bold text-gray-700 flex-1">${dept}</span>
        <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-white text-gray-500 border border-gray-200">${mems.length}人</span>
      </button>
      <!-- メンバーリスト -->
      <div class="dept-body divide-y divide-gray-100 ${collapsed ? 'hidden' : ''}">
        ${mems.map(m => `
          <div class="member-row flex items-center gap-3 px-4 py-2.5 bg-white transition-colors
            ${selectMode ? `cursor-pointer ${selectedIds.has(m.id) ? 'bg-primary-light' : 'hover:bg-gray-50'}` : 'hover:bg-gray-50 group'}"
            data-id="${m.id}">
            ${selectMode ? `
              <input type="checkbox" class="member-check w-4 h-4 accent-primary cursor-pointer flex-shrink-0"
                data-id="${m.id}" ${selectedIds.has(m.id) ? 'checked' : ''} />
            ` : ''}
            <button class="btn-member-detail w-7 h-7 rounded-full bg-primary-light flex items-center justify-center flex-shrink-0
              hover:ring-2 hover:ring-primary/40 transition-all"
              data-id="${m.id}" title="詳細を見る">
              <span class="text-xs font-bold text-primary pointer-events-none">${m.name[0]}</span>
            </button>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-gray-900">${m.name}</div>
              <div class="flex items-center gap-2 flex-wrap">
                ${m.grade ? `<span class="text-xs text-gray-400">${m.grade}</span>` : ''}
                ${m.email ? `
                  <span class="flex items-center gap-1 text-xs text-gray-400 min-w-0">
                    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                    </svg>
                    <span class="truncate">${m.email}</span>
                  </span>
                ` : ''}
              </div>
            </div>
            ${!selectMode ? `
              <button class="btn-toggle-leader transition-colors opacity-0 group-hover:opacity-100 ${m.is_leader ? 'text-yellow-400 opacity-100' : 'text-gray-300 hover:text-yellow-400'}"
                data-id="${m.id}" title="${m.is_leader ? 'リーダー解除' : 'リーダーに設定'}">
                <svg class="w-4 h-4" fill="${m.is_leader ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                </svg>
              </button>
              <button class="btn-del-member text-gray-300 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                data-id="${m.id}" title="削除">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </div>`;
  }).join('');

  // グループヘッダークリックで開閉トグル
  list.querySelectorAll('.dept-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('dept-check')) return;
      const dept = header.dataset.dept;
      if (collapsedDepts.has(dept)) {
        collapsedDepts.delete(dept);
      } else {
        collapsedDepts.add(dept);
      }
      renderMemberList();
    });
  });

  if (selectMode) {
    // 行クリックで選択トグル
    list.querySelectorAll('.member-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return; // チェックボックス直クリックは後述
        const id = parseInt(row.dataset.id);
        selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
        renderMemberList();
        updateSelectUI();
      });
    });

    // チェックボックス直接操作
    list.querySelectorAll('.member-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id);
        cb.checked ? selectedIds.add(id) : selectedIds.delete(id);
        renderMemberList();
        updateSelectUI();
      });
    });

    // 局単位の全選択チェック
    list.querySelectorAll('.dept-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const dept = cb.dataset.dept;
        const deptMembers = members.filter(m => (m.department || '未分類') === dept);
        deptMembers.forEach(m => cb.checked ? selectedIds.add(m.id) : selectedIds.delete(m.id));
        renderMemberList();
        updateSelectUI();
      });
    });

    updateSelectUI();
  } else {
    // 通常モード：個別削除
    list.querySelectorAll('.btn-del-member').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('このメンバーを削除しますか？')) return;
        try {
          await apiFetch(`/api/events/${EVENT_ID}/members/${btn.dataset.id}`, { method: 'DELETE' });
          await loadMembers();
        } catch (err) { showToast(err.message, true); }
      });
    });

    // リーダートグル
    list.querySelectorAll('.btn-toggle-leader').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const m = members.find(x => x.id === parseInt(btn.dataset.id));
        if (!m) return;
        try {
          const updated = await apiFetch(`/api/events/${EVENT_ID}/members/${m.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_leader: !m.is_leader }),
          });
          const idx = members.findIndex(x => x.id === updated.id);
          if (idx !== -1) members[idx] = updated;
          renderMemberList();
          renderShiftBoard();
        } catch (err) { showToast(err.message, true); }
      });
    });
  }

  // アイコンクリック → メンバー詳細（通常・選択モード共通）
  list.querySelectorAll('.btn-member-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMemberDetail(parseInt(btn.dataset.id));
    });
  });
}

async function loadMembers() {
  const list = $('member-list');
  try {
    members = await apiFetch(`/api/events/${EVENT_ID}/members`);
    renderMemberList();
  } catch (err) {
    list.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

$('btn-select-mode').addEventListener('click', enterSelectMode);
$('btn-cancel-select').addEventListener('click', exitSelectMode);

$('btn-select-all').addEventListener('click', () => {
  if (selectedIds.size === members.length) {
    selectedIds.clear();
  } else {
    members.forEach(m => selectedIds.add(m.id));
  }
  renderMemberList();
  updateSelectUI();
});

$('btn-bulk-delete').addEventListener('click', async () => {
  const count = selectedIds.size;
  if (!confirm(`選択した${count}人のメンバーを削除しますか？`)) return;
  try {
    const res = await apiFetch(`/api/events/${EVENT_ID}/members/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    showToast(`${res.deleted}人を削除しました`);
    exitSelectMode();
    await loadMembers();
  } catch (err) { showToast(err.message, true); }
});

// ─── Add Member Modal ─────────────────────────────────────────────────────────
const modalMember = $('modal-add-member');
$('btn-add-member').addEventListener('click', () => modalMember.classList.remove('hidden'));
document.querySelectorAll('.member-modal-close').forEach(b =>
  b.addEventListener('click', () => modalMember.classList.add('hidden'))
);

$('form-add-member').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('member-error');
  errEl.classList.add('hidden');
  try {
    await apiFetch(`/api/events/${EVENT_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({
        name: $('member-name').value.trim(),
        email: $('member-email').value.trim(),
        grade: $('member-grade').value.trim(),
        department: $('member-dept').value.trim(),
      }),
    });
    modalMember.classList.add('hidden');
    $('form-add-member').reset();
    loadMembers();
    showToast('メンバーを追加しました');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Shift Board ─────────────────────────────────────────────────────────────
let currentDay = null;
let intervalMin = 30;
let eventDates = [];
let boardSelectStart = null;
let boardHoverTime = null;
let pendingBoardSlot = null;  // 新規登録用
let editingSlot = null;       // 編集モード用 { slotId, assignmentId, memberId }
let boardSearchQuery = '';    // 名前検索
let copySourceMemberId = null; // コピー元メンバーID
let bulkDeleteMode = false;   // 一括削除モード
let bulkDeleteSelected = new Set(); // 選択中の assignmentId

const BOARD_START_H = 8;
const BOARD_END_H   = 22;
const CELL_W = { 5: 20, 10: 24, 15: 30, 30: 44, 60: 64 };

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function buildTimeCols(step) {
  const cols = [];
  for (let m = BOARD_START_H * 60; m < BOARD_END_H * 60; m += step) cols.push(minToTime(m));
  return cols;
}
function generateEventDates(startIso, endIso) {
  const dates = [];
  const cur = new Date(startIso + 'T00:00:00');
  const end = new Date(endIso + 'T00:00:00');
  while (cur <= end) { dates.push(cur.toISOString().split('T')[0]); cur.setDate(cur.getDate() + 1); }
  return dates;
}
// hex '#RRGGBB' → rgba with alpha
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function slotColor(jobColor, status) {
  const base = jobColor || '#4DA3FF';
  if (status === 'absent') return hexToRgba('#EF4444', 0.28);
  if (status === 'late')   return hexToRgba('#EAB308', 0.28);
  return hexToRgba(base, 0.3);
}

function jobColorFromSlot(slot) {
  const job = jobs.find(j => j.id === slot.job_type_id);
  return job ? job.color : '#4DA3FF';
}

async function loadShifts() {
  try {
    [slots, members, jobs] = await Promise.all([
      apiFetch(`/api/events/${EVENT_ID}/slots`),
      apiFetch(`/api/events/${EVENT_ID}/members`),
      apiFetch(`/api/events/${EVENT_ID}/jobs`),
    ]);
    eventDates = generateEventDates(EVENT_START, EVENT_END);
    if (!currentDay || !eventDates.includes(currentDay)) currentDay = eventDates[0] || null;
    renderDayTabs();
    renderShiftBoard();
    if (!$('workload-panel').classList.contains('hidden')) renderWorkloadPanel();
  } catch (err) {
    $('shift-board').innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

function renderDayTabs() {
  const container = $('board-day-tabs');
  if (!container) return;
  container.innerHTML = eventDates.map(date => {
    const d = new Date(date + 'T00:00:00');
    const label = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const active = date === currentDay;
    return `<button class="board-day-tab flex-shrink-0 px-3 py-1 text-xs font-medium rounded-lg transition-colors
      ${active ? 'bg-primary text-white' : 'text-gray-600 hover:bg-surface border border-transparent hover:border-gray-200'}"
      data-date="${date}">${label}</button>`;
  }).join('');
  container.querySelectorAll('.board-day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDay = btn.dataset.date;
      boardSelectStart = null; boardHoverTime = null;
      updateBoardHint(); renderDayTabs(); renderShiftBoard();
    });
  });
}

function renderShiftBoard() {
  const board = $('shift-board');
  if (!currentDay || !members.length) {
    board.innerHTML = `<div class="p-10 text-center text-gray-400 text-sm">${!currentDay ? '日付を選択してください' : 'メンバーを追加してシフトを作成してください'}</div>`;
    return;
  }

  const cols = buildTimeCols(intervalMin);
  const cw = CELL_W[intervalMin] || 44;
  const daySlots = slots.filter(s => s.date === currentDay);

  // Build occupancy map: `{memberId}|{timeStr}` → { slotId, role, assignmentId, status, isFirst }
  const cellMap = new Map();
  daySlots.forEach(slot => {
    const startM = timeToMin(slot.start_time);
    const endM   = timeToMin(slot.end_time);
    const jobColor = jobColorFromSlot(slot);
    slot.assignments.forEach(a => {
      cols.forEach((col, i) => {
        const colM = timeToMin(col);
        if (colM >= startM && colM < endM) {
          const prevM = i > 0 ? timeToMin(cols[i - 1]) : -1;
          cellMap.set(`${a.member_id}|${col}`, {
            slotId: slot.id, role: slot.role,
            assignmentId: a.id, status: a.status,
            isFirst: prevM < startM,
            jobColor,
          });
        }
      });
    });
  });

  const sortedMembers = [...members].sort((a, b) => (b.is_leader ? 1 : 0) - (a.is_leader ? 1 : 0) || gradeNum(b.grade) - gradeNum(a.grade));

  // 時間グループ（1段目ヘッダー用）
  const hourGroups = [];
  cols.forEach(col => {
    const h = parseInt(col.split(':')[0]);
    const last = hourGroups[hourGroups.length - 1];
    if (!last || last.hour !== h) hourGroups.push({ hour: h, count: 1 });
    else last.count++;
  });

  // 列の「太さ」を返す: 時境界=太、半時=中、15分=細、その他=なし
  function colBorder(col) {
    const m = parseInt(col.split(':')[1]);
    if (m === 0)  return 'border-l-2 border-l-gray-300';
    if (m === 30) return 'border-l border-l-gray-200';
    if ((m === 15 || m === 45) && intervalMin <= 15) return 'border-l border-l-gray-100';
    return '';
  }

  // 2段目ヘッダーの分ラベル
  function minuteLabel(col) {
    const m = parseInt(col.split(':')[1]);
    if (m === 0) return '00';
    if (intervalMin >= 30) return '30';
    if (intervalMin === 15) return String(m).padStart(2, '0');
    if (intervalMin === 10) return String(m).padStart(2, '0');
    // 5分: 15分刻みのみ表示
    return m % 15 === 0 ? String(m).padStart(2, '0') : '';
  }

  // 1段目: 時間グループ (top-0 sticky)
  const topRowHtml = hourGroups.map(g =>
    `<th colspan="${g.count}" style="min-width:${cw * g.count}px"
      class="sticky top-0 z-10 bg-white border-b-2 border-b-gray-200 border-l-2 border-l-gray-300 py-1.5 text-center text-[11px] font-bold text-gray-700 select-none">
      ${g.hour}<span class="font-normal text-gray-400">:00</span>
    </th>`
  ).join('');

  // 2段目: 分ラベル (top-[29px] sticky)
  const ROW1_H = 29;
  const bottomRowHtml = cols.map(col => {
    const m = parseInt(col.split(':')[1]);
    const label = minuteLabel(col);
    const isHour = m === 0;
    const isHalf = m === 30;
    const textCls = isHour ? 'text-gray-500 font-semibold' : isHalf ? 'text-gray-500' : 'text-gray-400';
    return `<th style="min-width:${cw}px;width:${cw}px;top:${ROW1_H}px"
      class="sticky z-10 bg-gray-50 border-b border-gray-200 py-1 text-center text-[9px] select-none ${colBorder(col)} ${textCls}">
      ${label}
    </th>`;
  }).join('');

  // グループ（局）ごとにソート済みメンバーをグループ化
  const deptOrder = [];
  const deptGroups = {};
  sortedMembers.forEach(m => {
    const d = m.department || '未分類';
    if (!deptGroups[d]) { deptGroups[d] = []; deptOrder.push(d); }
    deptGroups[d].push(m);
  });

  const isCopyMode = copySourceMemberId !== null;

  const rowsHtml = deptOrder.map(dept => {
    const deptMembers = deptGroups[dept];
    const deptSeparator = `
      <tr class="dept-separator">
        <td colspan="${cols.length + 2}" class="bg-gray-100 border-t-2 border-b border-gray-300 px-3 py-1 select-none sticky left-0">
          <span class="text-[10px] font-bold text-gray-500 uppercase tracking-wide">${dept}</span>
          <span class="text-[10px] text-gray-400 ml-1">${deptMembers.length}人</span>
        </td>
      </tr>`;

    const memberRows = deptMembers.map(m => {
      const isSearchMatch = boardSearchQuery && m.name.includes(boardSearchQuery);
      const isSearchDim   = boardSearchQuery && !isSearchMatch;
      const isCopySrc  = copySourceMemberId === m.id;
      const isCopyTgt  = isCopyMode && copySourceMemberId !== m.id;
      const leaderBg   = m.is_leader ? 'background:#FEFCE8;' : '';

      const cellsHtml = cols.map(col => {
        const key = `${m.id}|${col}`;
        const cell = cellMap.get(key);
        const cb = colBorder(col);

        if (cell) {
          const isSelected = bulkDeleteSelected.has(cell.assignmentId);
          let bg = isSelected ? 'rgba(239,68,68,0.35)' : slotColor(cell.jobColor, cell.status);
          if (!isSelected && m.is_leader) bg = slotColor(cell.jobColor === '#4DA3FF' ? '#EAB308' : cell.jobColor, cell.status);
          const border = cell.isFirst
            ? `border-left: 3px solid ${isSelected ? '#EF4444' : cell.jobColor};`
            : '';
          const roleText = cell.isFirst && cell.role
            ? `<span class="absolute inset-0 flex items-center px-1 text-[9px] font-semibold overflow-hidden whitespace-nowrap pointer-events-none" style="color:${isSelected ? '#EF4444' : cell.jobColor}">${cell.role}</span>`
            : '';
          const selectedRing = isSelected ? 'outline:2px solid #EF4444;outline-offset:-2px;' : '';
          return `<td style="min-width:${cw}px;width:${cw}px;background:${bg};${border}${selectedRing}"
            class="board-cell-occupied relative h-9 cursor-pointer border-b border-b-white/30 ${cb}"
            data-slot="${cell.slotId}" data-aid="${cell.assignmentId}" data-member="${m.id}" data-time="${col}">${roleText}</td>`;
        }
        return `<td style="min-width:${cw}px;width:${cw}px"
          class="board-cell h-9 cursor-pointer border-b border-b-gray-50 ${isCopyTgt ? 'hover:bg-green-100' : 'hover:bg-primary/10'} ${cb}"
          data-member="${m.id}" data-time="${col}"></td>`;
      }).join('');

      const dimStyle = isSearchDim ? 'opacity:0.15;' : '';
      const hlStyle  = isSearchMatch ? 'outline:2px solid #4DA3FF;outline-offset:-2px;background:rgba(77,163,255,0.07);' : '';
      const copyStyle = isCopySrc ? 'background:rgba(159,122,234,0.12);outline:2px solid #9F7AEA;outline-offset:-2px;' : '';

      // sticky列の不透明背景色（スクロール時に後ろのセルが透けないよう必ず solid にする）
      const stickyBgColor = isCopySrc    ? '#F0EBFF'
                          : isSearchMatch ? '#EFF6FF'
                          : m.is_leader   ? '#FEFCE8'
                          : '#FFFFFF';

      return `<tr style="${leaderBg}${dimStyle}${hlStyle}${copyStyle}" data-member-row="${m.id}">
        <td class="btn-member-row-action sticky left-0 z-10 border-b border-gray-100 px-2 py-1 whitespace-nowrap select-none cursor-pointer"
          data-mid="${m.id}"
          style="min-width:140px;background:${stickyBgColor};${dimStyle}">
          <div class="flex items-center gap-1.5">
            ${m.is_leader ? '<span class="text-yellow-400 text-xs">★</span>' : ''}
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold truncate ${isCopySrc ? 'text-purple-700' : 'text-gray-800'}">${m.name}</div>
              ${m.grade ? `<div class="text-[9px] text-gray-400">${m.grade}</div>` : ''}
            </div>
            <button class="btn-board-copy flex-shrink-0 transition-colors ${isCopySrc ? 'text-purple-500' : 'text-gray-300 hover:text-purple-400'}"
              data-mid="${m.id}" title="${isCopySrc ? 'コピー元（クリックで解除）' : 'このメンバーのシフトをコピー'}">
              ${isCopySrc
                ? `<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                     <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                   </svg>`
                : `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                   </svg>`}
            </button>
          </div>
        </td>
        <td class="sticky border-b border-gray-100 px-2 py-1 whitespace-nowrap select-none text-[9px] text-gray-500 font-medium"
          style="left:140px;min-width:70px;background:${stickyBgColor};${dimStyle};box-shadow:3px 0 5px rgba(0,0,0,0.08)">
          ${m.department || ''}
        </td>
        ${cellsHtml}
      </tr>`;
    }).join('');

    return deptSeparator + memberRows;
  }).join('');

  const MEMBER_W = 140, DEPT_W = 70;
  const totalW = MEMBER_W + DEPT_W + cols.length * cw;
  board.innerHTML = `
    <table class="border-collapse" style="width:${totalW}px">
      <thead>
        <tr>
          <th rowspan="2" style="min-width:${MEMBER_W}px;top:0"
            class="sticky left-0 z-30 bg-white border-b-2 border-b-gray-200 px-3 text-left text-xs text-gray-500 font-medium select-none">
            メンバー
          </th>
          <th rowspan="2" style="min-width:${DEPT_W}px;top:0;left:${MEMBER_W}px;box-shadow:3px 0 5px rgba(0,0,0,0.08)"
            class="sticky z-30 bg-white border-b-2 border-b-gray-200 px-2 text-left text-xs text-gray-500 font-medium select-none">
            局
          </th>
          ${topRowHtml}
        </tr>
        <tr>${bottomRowHtml}</tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  board.querySelectorAll('.board-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      if (bulkDeleteMode) return; // 一括削除モード中は空セルクリック無効
      if (isCopyMode && copySourceMemberId !== parseInt(cell.dataset.member)) {
        e.stopPropagation();
        handleBoardCopyClick(parseInt(cell.dataset.member));
        return;
      }
      handleBoardCellClick(parseInt(cell.dataset.member), cell.dataset.time, cols);
    });
    cell.addEventListener('mouseenter', () => {
      if (boardSelectStart && boardSelectStart.memberId === parseInt(cell.dataset.member)) {
        boardHoverTime = cell.dataset.time;
        updateBoardHighlight();
      }
    });
  });

  board.querySelectorAll('.board-cell-occupied').forEach(cell => {
    cell.addEventListener('click', (e) => {
      // 一括削除モード：1マスクリックでそのシフト全体を選択/解除
      if (bulkDeleteMode) {
        e.stopPropagation();
        const aid = parseInt(cell.dataset.aid);
        if (bulkDeleteSelected.has(aid)) {
          bulkDeleteSelected.delete(aid);
        } else {
          bulkDeleteSelected.add(aid);
        }
        updateBulkDeleteBanner();
        renderShiftBoard(); // 全セル再描画でシフト全体をハイライト
        return;
      }
      // コピーモード
      if (isCopyMode) {
        const targetMid = parseInt(cell.dataset.member);
        if (targetMid !== copySourceMemberId) {
          e.stopPropagation();
          handleBoardCopyClick(targetMid);
        }
        return;
      }
      openOccupiedCellMenu(parseInt(cell.dataset.slot), parseInt(cell.dataset.aid));
    });
  });

  // 名前・局列（コピーモード時のみ）
  board.querySelectorAll('tr[data-member-row]').forEach(row => {
    row.addEventListener('click', () => {
      if (!isCopyMode) return;
      const targetMid = parseInt(row.dataset.memberRow);
      if (targetMid !== copySourceMemberId) handleBoardCopyClick(targetMid);
    });
  });

  // コピーボタン
  board.querySelectorAll('.btn-board-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mid = parseInt(btn.dataset.mid);
      if (copySourceMemberId === mid) {
        copySourceMemberId = null;
        updateBoardHint();
        renderShiftBoard();
      } else {
        copySourceMemberId = mid;
        boardSelectStart = null;
        updateBoardHint();
        renderShiftBoard();
      }
    });
  });

  // メンバー名セルクリック（コピーモード時のみコピー対象として機能）
  board.querySelectorAll('.btn-member-row-action').forEach(td => {
    td.addEventListener('click', (e) => {
      if (!isCopyMode) return;
      const targetMid = parseInt(td.dataset.mid);
      if (targetMid !== copySourceMemberId) handleBoardCopyClick(targetMid);
    });
  });

  updateBoardHighlight();
}



function clearBoardSearch() {
  if (!boardSearchQuery) return;
  boardSearchQuery = '';
  const el = $('board-search');
  if (el) el.value = '';
  renderShiftBoard();
}

function handleBoardCellClick(memberId, timeStr, cols) {
  clearBoardSearch();
  if (!boardSelectStart) {
    boardSelectStart = { memberId, timeStr };
    boardHoverTime = timeStr;
    updateBoardHint();
    updateBoardHighlight();
    return;
  }
  if (boardSelectStart.memberId !== memberId) {
    boardSelectStart = { memberId, timeStr };
    boardHoverTime = timeStr;
    updateBoardHint();
    updateBoardHighlight();
    return;
  }
  const startIdx = cols.indexOf(boardSelectStart.timeStr);
  const endIdx   = cols.indexOf(timeStr);
  if (startIdx === endIdx) {
    boardSelectStart = null; boardHoverTime = null;
    updateBoardHint();
    updateBoardHighlight();
    return;
  }
  const lo = Math.min(startIdx, endIdx), hi = Math.max(startIdx, endIdx);
  const startTime = cols[lo];
  const endTime   = minToTime(timeToMin(cols[hi]) + intervalMin);
  boardSelectStart = null; boardHoverTime = null;
  updateBoardHint();
  updateBoardHighlight();
  openBoardSlotModal(memberId, startTime, endTime);
}

function updateBoardHighlight() {
  document.querySelectorAll('.board-cell').forEach(cell => {
    const memberId = parseInt(cell.dataset.member);
    if (!boardSelectStart || memberId !== boardSelectStart.memberId) {
      cell.style.backgroundColor = '';
      return;
    }
    const startM = timeToMin(boardSelectStart.timeStr);
    const endM   = boardHoverTime ? timeToMin(boardHoverTime) : startM;
    const lo = Math.min(startM, endM), hi = Math.max(startM, endM);
    const colM = timeToMin(cell.dataset.time);
    if (colM === startM) {
      cell.style.backgroundColor = 'rgba(77,163,255,0.45)';
    } else if (colM > lo && colM <= hi) {
      cell.style.backgroundColor = 'rgba(77,163,255,0.22)';
    } else {
      cell.style.backgroundColor = '';
    }
  });
}

function updateBoardHint() {
  const hint   = $('board-hint');
  const banner = $('copy-mode-banner');
  if (!hint || !banner) return;

  if (copySourceMemberId !== null) {
    // コピーモード → 専用バナーを表示
    const m = members.find(x => x.id === copySourceMemberId);
    $('copy-banner-avatar').textContent = m?.name[0] || '?';
    $('copy-banner-name').textContent   = m?.name || '';
    hint.classList.add('hidden');
    banner.classList.remove('hidden');
  } else if (boardSelectStart) {
    // 通常選択モード → ヒントバーを表示
    const m = members.find(x => x.id === boardSelectStart.memberId);
    $('board-hint-text').textContent = `${m?.name || ''} — ${boardSelectStart.timeStr} を開始時間として選択中。終了時間のセルをクリックしてください。`;
    banner.classList.add('hidden');
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    banner.classList.add('hidden');
  }
}

async function handleBoardCopyClick(targetMemberId) {
  if (copySourceMemberId === null || copySourceMemberId === targetMemberId) return;
  const src = members.find(x => x.id === copySourceMemberId);
  const tgt = members.find(x => x.id === targetMemberId);
  try {
    const res = await apiFetch(`/api/events/${EVENT_ID}/members/${copySourceMemberId}/copy-to/${targetMemberId}`, {
      method: 'POST',
    });
    copySourceMemberId = null;
    await loadShifts();
    showToast(`「${src?.name || ''}」→「${tgt?.name || ''}」にシフトをコピーしました（${res.copied}件）`);
  } catch (err) {
    showToast(err.message, true);
  }
}

function openBoardSlotModal(memberId, startTime, endTime) {
  const m = members.find(x => x.id === memberId);
  pendingBoardSlot = { memberId, startTime, endTime };
  editingSlot = null;

  // 選択範囲内に既存シフトがあるか確認
  const startM = timeToMin(startTime);
  const endM   = timeToMin(endTime);
  const rangeSlots = slots.filter(s =>
    s.date === currentDay &&
    s.assignments.some(a => a.member_id === memberId) &&
    timeToMin(s.start_time) < endM && timeToMin(s.end_time) > startM
  );
  const hasShiftsInRange = rangeSlots.length > 0;

  $('board-slot-title').textContent = 'シフトを登録';
  $('btn-board-slot-delete').classList.add('hidden');
  $('btn-board-slot-submit').textContent = '登録する';

  $('board-slot-info').innerHTML = `
    <div class="flex justify-between text-xs"><span class="text-gray-500">メンバー</span><span class="font-semibold text-gray-800">${m?.name || ''}</span></div>
    <div class="flex justify-between text-xs"><span class="text-gray-500">日付</span><span class="font-semibold text-gray-800">${fmtDate(currentDay)}</span></div>
    <div class="flex justify-between text-xs"><span class="text-gray-500">時間</span><span class="font-semibold text-gray-800">${startTime} 〜 ${endTime}</span></div>`;

  // 前回の範囲削除ボタンが残っていれば除去
  $('btn-range-delete-trigger')?.remove();

  populateJobSelect(null);
  $('board-slot-error').classList.add('hidden');
  $('modal-board-slot').classList.remove('hidden');
}

function closeBoardSlotModal() {
  $('modal-board-slot').classList.add('hidden');
  pendingBoardSlot = null;
  editingSlot = null;
  showBoardSlotMain();
}

function showBoardSlotMain() {
  $('board-slot-main').classList.remove('hidden');
  $('board-slot-delete-confirm').classList.add('hidden');
  $('board-slot-range-confirm').classList.add('hidden');
}

function showBoardSlotDeleteConfirm(desc) {
  $('board-slot-delete-desc').textContent = desc;
  $('board-slot-main').classList.add('hidden');
  $('board-slot-delete-confirm').classList.remove('hidden');
  $('board-slot-range-confirm').classList.add('hidden');
}

function showBoardSlotRangeConfirm(desc) {
  $('board-slot-range-desc').textContent = desc;
  $('board-slot-main').classList.add('hidden');
  $('board-slot-delete-confirm').classList.add('hidden');
  $('board-slot-range-confirm').classList.remove('hidden');
}

// 共通：仕事ドロップダウンを更新し、選択済みの job をハイライト
function populateJobSelect(currentJobTypeId) {
  const sel = $('board-slot-job');
  sel.innerHTML = '<option value="">仕事を選択してください...</option>' +
    jobs.map(j => `<option value="${j.id}" ${j.id === currentJobTypeId ? 'selected' : ''}>${j.title}（目安 ${j.required_count}人）</option>`).join('');

  const updateDetail = () => {
    const job = jobs.find(j => j.id === parseInt(sel.value));
    const detail = $('board-slot-job-detail');
    if (job) {
      detail.innerHTML = [
        `<div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${job.color}"></span><span class="font-semibold" style="color:${job.color}">${job.title}</span></div>`,
        job.description ? `<div><span class="text-gray-400">内容:</span> ${job.description}</div>` : '',
        job.location    ? `<div><span class="text-gray-400">集合場所:</span> ${job.location}</div>` : '',
        `<div><span class="text-gray-400">担当目安:</span> ${job.required_count}人</div>`,
      ].filter(Boolean).join('');
      detail.classList.remove('hidden');
    } else {
      detail.classList.add('hidden');
    }
  };

  sel.onchange = updateDetail;
  updateDetail(); // 初期表示
}

function openOccupiedCellMenu(slotId, assignmentId) {
  clearBoardSearch();
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;

  const assignment = slot.assignments.find(a => a.id === assignmentId);
  const member = members.find(m => m.id === assignment?.member_id);
  const job = jobs.find(j => j.id === slot.job_type_id);

  editingSlot = { slotId, assignmentId, memberId: assignment?.member_id };
  pendingBoardSlot = null;

  // タイトル・削除ボタンを編集モードに切替
  $('board-slot-title').textContent = 'シフトの詳細・変更';
  $('btn-board-slot-delete').classList.add('hidden'); // 削除は一括削除モードで行う
  $('btn-board-slot-submit').textContent = '変更を保存';

  // シフト情報表示
  $('board-slot-info').innerHTML = [
    `<div class="flex justify-between text-xs"><span class="text-gray-500">メンバー</span><span class="font-semibold text-gray-800">${member?.name || '不明'}</span></div>`,
    `<div class="flex justify-between text-xs"><span class="text-gray-500">日付</span><span class="font-semibold text-gray-800">${fmtDate(slot.date)}</span></div>`,
    `<div class="flex justify-between text-xs"><span class="text-gray-500">時間</span><span class="font-semibold text-gray-800">${slot.start_time} 〜 ${slot.end_time}</span></div>`,
  ].join('');

  populateJobSelect(slot.job_type_id);
  $('board-slot-error').classList.add('hidden');
  $('modal-board-slot').classList.remove('hidden');
}

$('btn-board-slot-cancel').addEventListener('click', closeBoardSlotModal);
$('board-slot-overlay').addEventListener('click', closeBoardSlotModal);

$('btn-board-slot-delete').addEventListener('click', () => {
  if (!editingSlot) return;
  const slot = slots.find(s => s.id === editingSlot.slotId);
  const member = members.find(m => m.id === editingSlot.memberId);
  const desc = `${member?.name || ''} / ${slot?.start_time || ''} 〜 ${slot?.end_time || ''}`;
  showBoardSlotDeleteConfirm(desc);
});

$('btn-delete-cancel').addEventListener('click', showBoardSlotMain);
$('btn-range-delete-cancel').addEventListener('click', showBoardSlotMain);

$('btn-range-delete-confirm').addEventListener('click', async () => {
  if (!pendingBoardSlot) return;
  const { memberId, startTime, endTime } = pendingBoardSlot;
  try {
    const res = await apiFetch(`/api/events/${EVENT_ID}/members/${memberId}/shifts`, {
      method: 'DELETE',
      body: JSON.stringify({ date: currentDay, start_time: startTime, end_time: endTime }),
    });
    closeBoardSlotModal();
    await loadShifts();
    showToast(`${res.deleted}件のシフトを削除しました`);
  } catch (err) { showToast(err.message, true); }
});

$('btn-delete-confirm').addEventListener('click', async () => {
  if (!editingSlot) return;
  try {
    await apiFetch(`/api/assignments/${editingSlot.assignmentId}`, { method: 'DELETE' });
    closeBoardSlotModal();
    await loadShifts();
    showToast('シフトを削除しました');
  } catch (err) { showToast(err.message, true); }
});
$('btn-cancel-board-select').addEventListener('click', () => {
  boardSelectStart = null; boardHoverTime = null;
  updateBoardHint(); updateBoardHighlight();
});
$('btn-cancel-copy').addEventListener('click', () => {
  copySourceMemberId = null;
  updateBoardHint();
  renderShiftBoard();
});

// ─── 一括削除モード ───────────────────────────────────────────────────────────
function updateBulkDeleteBanner() {
  const n = bulkDeleteSelected.size;
  $('bulk-delete-count').textContent = `${n}件`;
  const btn = $('btn-bulk-delete-exec');
  btn.disabled = n === 0;
}

function enterBulkDeleteMode() {
  bulkDeleteMode = true;
  bulkDeleteSelected.clear();
  copySourceMemberId = null;
  boardSelectStart = null;
  $('bulk-delete-banner').classList.remove('hidden');
  $('btn-bulk-delete-mode').classList.add('bg-red-50', 'text-red-500', 'border-red-300');
  $('btn-bulk-delete-mode').classList.remove('text-gray-500', 'border-gray-200');
  updateBulkDeleteBanner();
  renderShiftBoard();
}

function exitBulkDeleteMode() {
  bulkDeleteMode = false;
  bulkDeleteSelected.clear();
  $('bulk-delete-banner').classList.add('hidden');
  $('btn-bulk-delete-mode').classList.remove('bg-red-50', 'text-red-500', 'border-red-300');
  $('btn-bulk-delete-mode').classList.add('text-gray-500', 'border-gray-200');
  renderShiftBoard();
}

$('btn-bulk-delete-mode').addEventListener('click', () => {
  bulkDeleteMode ? exitBulkDeleteMode() : enterBulkDeleteMode();
});

$('btn-bulk-delete-cancel').addEventListener('click', exitBulkDeleteMode);

$('btn-bulk-delete-exec').addEventListener('click', async () => {
  if (!bulkDeleteSelected.size) return;
  const ids = [...bulkDeleteSelected];
  try {
    await Promise.all(ids.map(aid =>
      apiFetch(`/api/assignments/${aid}`, { method: 'DELETE' })
    ));
    exitBulkDeleteMode();
    await loadShifts();
    showToast(`${ids.length}件のシフトを削除しました`);
  } catch (err) { showToast(err.message, true); }
});

$('btn-board-slot-submit').addEventListener('click', async () => {
  const errEl = $('board-slot-error');
  errEl.classList.add('hidden');

  const jobId = parseInt($('board-slot-job').value);
  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    errEl.textContent = '仕事を選択してください。';
    errEl.classList.remove('hidden');
    return;
  }

  // ── 編集モード：既存スロットの仕事を差し替え ──────────────────────
  if (editingSlot) {
    try {
      const { slotId, assignmentId, memberId } = editingSlot;
      // 1. 古い割り当て削除
      await apiFetch(`/api/assignments/${assignmentId}`, { method: 'DELETE' });
      // 2. 既存スロット削除
      await apiFetch(`/api/events/${EVENT_ID}/slots/${slotId}`, { method: 'DELETE' });
      // 3. 新しい仕事でスロット作成（元の時間帯を slots から取得済み）
      const oldSlot = slots.find(s => s.id === slotId);
      const newSlot = await apiFetch(`/api/events/${EVENT_ID}/slots`, {
        method: 'POST',
        body: JSON.stringify({
          date: oldSlot.date,
          start_time: oldSlot.start_time,
          end_time: oldSlot.end_time,
          role: job.title,
          location: job.location || '',
          required_count: job.required_count,
          job_type_id: job.id,
        }),
      });
      // 4. 再割り当て
      await apiFetch(`/api/events/${EVENT_ID}/slots/${newSlot.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ member_id: memberId }),
      });
      closeBoardSlotModal();
      await loadShifts();
      showToast('シフトを変更しました');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
    return;
  }

  // ── 新規登録モード ────────────────────────────────────────────────
  if (!pendingBoardSlot) return;
  try {
    const slot = await apiFetch(`/api/events/${EVENT_ID}/slots`, {
      method: 'POST',
      body: JSON.stringify({
        date: currentDay,
        start_time: pendingBoardSlot.startTime,
        end_time: pendingBoardSlot.endTime,
        role: job.title,
        location: job.location || '',
        required_count: job.required_count,
        job_type_id: job.id,
      }),
    });
    await apiFetch(`/api/events/${EVENT_ID}/slots/${slot.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ member_id: pendingBoardSlot.memberId }),
    });
    closeBoardSlotModal();
    await loadShifts();
    showToast('シフトを登録しました');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.querySelectorAll('.interval-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    intervalMin = parseInt(btn.dataset.min);
    document.querySelectorAll('.interval-btn').forEach(b => {
      const active = b === btn;
      b.classList.toggle('bg-primary', active);
      b.classList.toggle('text-white', active);
      b.classList.toggle('bg-white', !active);
      b.classList.toggle('text-gray-600', !active);
    });
    boardSelectStart = null; boardHoverTime = null;
    updateBoardHint(); renderShiftBoard();
  });
});

// ─── Jobs ────────────────────────────────────────────────────────────────────
const JOB_PALETTE = [
  '#4DA3FF', '#FF6B6B', '#48BB78', '#F6AD55', '#9F7AEA',
  '#4FD1C5', '#F687B3', '#FC8181', '#667EEA', '#38B2AC',
];

let colorPopupJobId = null;

function closeColorPopup() {
  document.querySelectorAll('.job-color-popup').forEach(el => el.remove());
  colorPopupJobId = null;
}

function openColorPopup(anchorEl, jobId) {
  closeColorPopup();
  colorPopupJobId = jobId;

  const popup = document.createElement('div');
  popup.className = 'job-color-popup absolute z-50 bg-white rounded-xl shadow-xl border border-gray-100 p-3';
  popup.style.cssText = 'width:176px';

  const job = jobs.find(j => j.id === jobId);
  popup.innerHTML = `
    <div class="text-[10px] font-medium text-gray-400 mb-2">カラーを選択</div>
    <div class="grid grid-cols-5 gap-2">
      ${JOB_PALETTE.map(c => `
        <button class="palette-swatch w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none
          ${job && job.color === c ? 'border-gray-700 scale-110' : 'border-transparent'}"
          style="background:${c}" data-color="${c}"></button>
      `).join('')}
    </div>
  `;

  // anchorEl の位置に配置
  const rect = anchorEl.getBoundingClientRect();
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  popup.style.position = 'fixed';
  popup.style.top  = `${rect.bottom + 6}px`;
  popup.style.left = `${rect.left}px`;

  document.body.appendChild(popup);

  popup.querySelectorAll('.palette-swatch').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const color = btn.dataset.color;
      try {
        const updated = await apiFetch(`/api/events/${EVENT_ID}/jobs/${jobId}`, {
          method: 'PATCH',
          body: JSON.stringify({ color }),
        });
        const idx = jobs.findIndex(j => j.id === updated.id);
        if (idx !== -1) jobs[idx] = updated;
        closeColorPopup();
        renderJobList();
        renderShiftBoard();
        showToast('カラーを変更しました');
      } catch (err) { showToast(err.message, true); }
    });
  });

  // 外クリックで閉じる
  setTimeout(() => {
    document.addEventListener('click', closeColorPopup, { once: true });
  }, 0);
}
async function loadJobs() {
  const list = $('job-list');
  try {
    jobs = await apiFetch(`/api/events/${EVENT_ID}/jobs`);
    renderJobList();
  } catch (err) {
    if (list) list.innerHTML = `<div class="text-center py-8 text-red-400 text-sm">${err.message}</div>`;
  }
}

function renderJobList() {
  const list = $('job-list');
  if (!list) return;
  if (!jobs.length) {
    list.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">仕事が登録されていません。「追加」から登録してください。</div>`;
    return;
  }
  list.innerHTML = jobs.map(j => `
    <div class="bg-white rounded-xl border border-gray-100 p-4 flex items-start gap-3 group">
      <button class="btn-job-color w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 hover:opacity-80 transition-opacity"
        style="background:${j.color}28;border:2px solid ${j.color}"
        data-jid="${j.id}" title="クリックして色を変更">
        <svg class="w-4 h-4 pointer-events-none" style="color:${j.color}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
        </svg>
      </button>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-gray-900">${j.title}</div>
        ${j.description ? `<div class="text-xs text-gray-500 mt-0.5 leading-relaxed">${j.description}</div>` : ''}
        <div class="flex flex-wrap gap-3 mt-1.5">
          ${j.location ? `
            <span class="flex items-center gap-1 text-xs text-gray-400">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              ${j.location}
            </span>` : ''}
          <span class="flex items-center gap-1 text-xs text-gray-400">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            目安 ${j.required_count}人
          </span>
        </div>
      </div>
      <button class="btn-del-job text-gray-200 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
        data-jid="${j.id}" title="削除">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.btn-del-job').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('この仕事を削除しますか？')) return;
      try {
        await apiFetch(`/api/events/${EVENT_ID}/jobs/${btn.dataset.jid}`, { method: 'DELETE' });
        await loadJobs();
        showToast('仕事を削除しました');
      } catch (err) { showToast(err.message, true); }
    });
  });

  list.querySelectorAll('.btn-job-color').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPopup(btn, parseInt(btn.dataset.jid));
    });
  });
}

const modalAddJob = $('modal-add-job');
$('btn-add-job').addEventListener('click', () => {
  $('form-add-job').reset();
  $('job-error').classList.add('hidden');
  modalAddJob.classList.remove('hidden');
});
document.querySelectorAll('.job-modal-close').forEach(b =>
  b.addEventListener('click', () => modalAddJob.classList.add('hidden'))
);

$('form-add-job').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('job-error');
  errEl.classList.add('hidden');
  try {
    await apiFetch(`/api/events/${EVENT_ID}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        title: $('job-title').value.trim(),
        description: $('job-description').value.trim(),
        location: $('job-location').value.trim(),
        required_count: parseInt($('job-count').value) || 1,
      }),
    });
    modalAddJob.classList.add('hidden');
    $('form-add-job').reset();
    await loadJobs();
    showToast('仕事を追加しました');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Add Slot Modal ───────────────────────────────────────────────────────────
const modalSlot = $('modal-add-slot');
$('btn-add-slot').addEventListener('click', () => modalSlot.classList.remove('hidden'));
document.querySelectorAll('.slot-modal-close').forEach(b =>
  b.addEventListener('click', () => modalSlot.classList.add('hidden'))
);

$('form-add-slot').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('slot-error');
  errEl.classList.add('hidden');
  try {
    await apiFetch(`/api/events/${EVENT_ID}/slots`, {
      method: 'POST',
      body: JSON.stringify({
        date: $('slot-date').value,
        start_time: $('slot-start').value,
        end_time: $('slot-end').value,
        role: $('slot-role').value.trim(),
        location: $('slot-location').value.trim(),
        required_count: parseInt($('slot-count').value) || 1,
      }),
    });
    modalSlot.classList.add('hidden');
    $('form-add-slot').reset();
    loadShifts();
    showToast('シフト枠を追加しました');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Assign Modal ─────────────────────────────────────────────────────────────
const modalAssign = $('modal-assign');
document.querySelectorAll('.assign-modal-close').forEach(b =>
  b.addEventListener('click', () => modalAssign.classList.add('hidden'))
);

function openAssignModal(slotId) {
  currentSlotId = slotId;
  const slot = slots.find(s => s.id === slotId);
  const assigned = new Set(slot.assignments.map(a => a.member_id));
  const list = $('assign-member-list');
  $('assign-error').classList.add('hidden');

  if (!members.length) {
    list.innerHTML = '<div class="text-sm text-gray-400 py-4 text-center">メンバーを先に追加してください。</div>';
  } else {
    list.innerHTML = members.map(m => `
      <button class="btn-do-assign w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface transition-colors text-left
        ${assigned.has(m.id) ? 'opacity-40 cursor-not-allowed' : ''}"
        data-mid="${m.id}" ${assigned.has(m.id) ? 'disabled' : ''}>
        <div class="w-7 h-7 rounded-full bg-primary-light flex items-center justify-center flex-shrink-0">
          <span class="text-xs font-bold text-primary">${m.name[0]}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-gray-900">${m.name}</div>
          ${m.department ? `<div class="text-xs text-gray-400">${m.department}</div>` : ''}
        </div>
        ${assigned.has(m.id) ? '<span class="text-xs text-gray-400">割り当て済み</span>' : ''}
      </button>
    `).join('');

    list.querySelectorAll('.btn-do-assign:not([disabled])').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/events/${EVENT_ID}/slots/${currentSlotId}/assign`, {
            method: 'POST',
            body: JSON.stringify({ member_id: parseInt(btn.dataset.mid) }),
          });
          modalAssign.classList.add('hidden');
          loadShifts();
        } catch (err) {
          $('assign-error').textContent = err.message;
          $('assign-error').classList.remove('hidden');
        }
      });
    });
  }

  modalAssign.classList.remove('hidden');
}

// ─── Auto Generate ────────────────────────────────────────────────────────────
const modalAutoGen = $('modal-auto-gen');
$('btn-auto-gen').addEventListener('click', () => modalAutoGen.classList.remove('hidden'));
document.querySelectorAll('.autogen-close').forEach(b =>
  b.addEventListener('click', () => modalAutoGen.classList.add('hidden'))
);

$('btn-do-autogen').addEventListener('click', async () => {
  try {
    const clearExisting = $('autogen-clear').checked;
    const res = await apiFetch(`/api/events/${EVENT_ID}/auto-generate`, {
      method: 'POST',
      body: JSON.stringify({ clear_existing: clearExisting }),
    });
    modalAutoGen.classList.add('hidden');
    loadShifts();
    showToast(`自動生成完了: ${res.assigned}件割り当てました`);
  } catch (err) { showToast(err.message, true); }
});


// ─── Settings ─────────────────────────────────────────────────────────────────
// ─── Share Link ───────────────────────────────────────────────────────────────
function renderShareLink(token) {
  const area = $('share-link-area');
  if (!area) return;
  const url = token ? `${location.origin}/join/${token}` : null;
  area.innerHTML = token ? `
    <div class="flex gap-2">
      <input id="share-link-input" type="text" readonly value="${url}"
        class="flex-1 px-3 py-2 bg-surface border border-gray-200 rounded-lg text-xs text-gray-600 focus:outline-none cursor-text" />
      <button id="btn-copy-share-link"
        class="px-3 py-2 text-sm text-primary border border-primary rounded-lg hover:bg-primary-light transition-colors flex-shrink-0">
        コピー
      </button>
    </div>
    <button id="btn-revoke-share" class="text-xs text-gray-400 hover:text-red-500 transition-colors">
      リンクを無効化する
    </button>
  ` : `
    <button id="btn-gen-share"
      class="flex items-center gap-1.5 px-4 py-2 text-sm text-primary border border-primary rounded-lg hover:bg-primary-light transition-colors">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
      </svg>
      共有リンクを発行する
    </button>
  `;
  bindShareButtons();
}

function bindShareButtons() {
  $('btn-gen-share')?.addEventListener('click', async () => {
    try {
      const d = await apiFetch(`/api/events/${EVENT_ID}/share-token`, { method: 'POST' });
      renderShareLink(d.share_token);
      showToast('共有リンクを発行しました');
    } catch (err) { showToast(err.message, true); }
  });

  $('btn-copy-share-link')?.addEventListener('click', () => {
    const val = $('share-link-input')?.value;
    if (val) navigator.clipboard.writeText(val).then(() => showToast('リンクをコピーしました'));
  });

  $('btn-revoke-share')?.addEventListener('click', async () => {
    if (!confirm('共有リンクを無効化しますか？既にリンクを知っているユーザーはアクセスできなくなります。')) return;
    try {
      await apiFetch(`/api/events/${EVENT_ID}/share-token`, { method: 'DELETE' });
      renderShareLink(null);
      showToast('共有リンクを無効化しました');
    } catch (err) { showToast(err.message, true); }
  });
}

// 初期バインド（Jinja2でレンダリングされたボタン用）
bindShareButtons();

$('btn-save-settings').addEventListener('click', async () => {
  try {
    await apiFetch(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: $('settings-title').value.trim(),
        start_date: $('settings-start').value,
        end_date: $('settings-end').value,
        description: $('settings-desc').value.trim(),
      }),
    });
    showToast('設定を保存しました');
  } catch (err) { showToast(err.message, true); }
});

$('btn-delete-event').addEventListener('click', async () => {
  if (!confirm('イベントを削除しますか？この操作は取り消せません。')) return;
  try {
    await apiFetch(`/api/events/${EVENT_ID}`, { method: 'DELETE' });
    window.location.href = '/dashboard';
  } catch (err) { showToast(err.message, true); }
});

// ─── Member Detail Modal ──────────────────────────────────────────────────────
const modalMemberDetail = $('modal-member-detail');
document.querySelectorAll('.member-detail-close').forEach(b =>
  b.addEventListener('click', () => modalMemberDetail.classList.add('hidden'))
);

function openMemberDetail(memberId) {
  const m = members.find(x => x.id === memberId);
  if (!m) return;

  // シフト担当回数を集計
  let shiftCount = 0;
  slots.forEach(s => {
    if (s.assignments.some(a => a.member_id === memberId)) shiftCount++;
  });

  const infoRows = [
    { label: '学年',         value: m.grade || '未設定', isEmail: false },
    { label: '局・グループ', value: m.department || '未設定', isEmail: false },
    { label: 'Gmail',        value: m.email || '未設定', isEmail: !!m.email },
    { label: 'シフト担当数', value: `${shiftCount}回`, isEmail: false },
  ];

  $('member-detail-body').innerHTML = `
    <div class="flex flex-col items-center mb-5">
      <div class="w-14 h-14 rounded-full bg-primary-light flex items-center justify-center mb-3">
        <span class="text-2xl font-bold text-primary">${m.name[0]}</span>
      </div>
      <div class="text-base font-bold text-gray-900">${m.name}</div>
      ${m.department ? `<div class="text-xs text-gray-400 mt-0.5">${m.department}${m.grade ? ' · ' + m.grade : ''}</div>` : ''}
    </div>
    <div class="space-y-2">
      ${infoRows.map(f => `
        <div class="flex items-center justify-between px-3 py-2 bg-surface rounded-lg gap-3">
          <span class="text-xs text-gray-500 flex-shrink-0">${f.label}</span>
          ${f.isEmail
            ? `<a href="mailto:${f.value}" class="text-sm font-medium text-primary hover:underline truncate">${f.value}</a>`
            : `<span class="text-sm font-medium text-gray-800 truncate">${f.value}</span>`
          }
        </div>
      `).join('')}
    </div>
  `;

  modalMemberDetail.classList.remove('hidden');
}

// ─── Copy URL ─────────────────────────────────────────────────────────────────
$('btn-copy-url').addEventListener('click', () => {
  const url = `${location.origin}/event/${EVENT_ID}/login`;
  navigator.clipboard.writeText(url).then(() => showToast('URLをコピーしました'));
});

// ─── Editors Modal ───────────────────────────────────────────────────────────
const modalEditors = $('modal-editors');
$('btn-show-editors')?.addEventListener('click', () => modalEditors.classList.remove('hidden'));
document.querySelectorAll('.editors-modal-close').forEach(b =>
  b.addEventListener('click', () => modalEditors.classList.add('hidden'))
);

// ─── CSV Import ───────────────────────────────────────────────────────────────
const modalCsv = $('modal-csv');
$('btn-import-csv').addEventListener('click', () => {
  $('csv-error').classList.add('hidden');
  $('csv-result').classList.add('hidden');
  $('form-csv').reset();
  $('csv-file-label').textContent = 'クリックまたはドラッグ&ドロップ';
  modalCsv.classList.remove('hidden');
});
document.querySelectorAll('.csv-modal-close').forEach(b =>
  b.addEventListener('click', () => modalCsv.classList.add('hidden'))
);

// ファイル選択エリアのクリック
$('csv-drop-area').addEventListener('click', () => $('csv-file').click());

// ファイル名表示
$('csv-file').addEventListener('change', e => {
  const file = e.target.files[0];
  $('csv-file-label').textContent = file ? file.name : 'クリックまたはドラッグ&ドロップ';
});

// ドラッグ&ドロップ
const dropArea = $('csv-drop-area');
dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('border-primary', 'bg-primary-light'); });
dropArea.addEventListener('dragleave', () => dropArea.classList.remove('border-primary', 'bg-primary-light'));
dropArea.addEventListener('drop', e => {
  e.preventDefault();
  dropArea.classList.remove('border-primary', 'bg-primary-light');
  const file = e.dataTransfer.files[0];
  if (file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    $('csv-file').files = dt.files;
    $('csv-file-label').textContent = file.name;
  }
});

$('form-csv').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('csv-error');
  const resultEl = $('csv-result');
  errEl.classList.add('hidden');
  resultEl.classList.add('hidden');

  const file = $('csv-file').files[0];
  if (!file) {
    errEl.textContent = 'CSVファイルを選択してください。';
    errEl.classList.remove('hidden');
    return;
  }

  const submitBtn = $('btn-csv-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = '読み込み中...';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`/api/events/${EVENT_ID}/members/csv`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'エラーが発生しました。';
      errEl.classList.remove('hidden');
      return;
    }
    modalCsv.classList.add('hidden');
    $('form-csv').reset();
    $('csv-file-label').textContent = 'クリックまたはドラッグ&ドロップ';
    showToast(`${data.added}人を追加しました${data.skipped ? `（${data.skipped}行スキップ）` : ''}`);
    loadMembers();
  } catch (err) {
    errEl.textContent = 'ネットワークエラーが発生しました。';
    errEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'インポート';
  }
});

// ─── Board Search ─────────────────────────────────────────────────────────────
$('board-search')?.addEventListener('input', e => {
  if (!e.target.value.trim()) { boardSearchQuery = ''; renderShiftBoard(); }
});
$('board-search')?.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const query = e.target.value.trim();
  boardSearchQuery = query;
  renderShiftBoard();

  if (!query) return;

  // ヒットした最初の行を画面中央へスクロール
  const container = $('shift-board-container');
  const firstMatch = container?.querySelector(`tr[data-member-row]`
    + `:is(${
      members
        .filter(m => m.name.includes(query))
        .map(m => `[data-member-row="${m.id}"]`)
        .join(',') || '[data-member-row="-1"]'
    })`);

  if (firstMatch && container) {
    const trRect  = firstMatch.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const offset  = firstMatch.offsetTop - container.scrollTop;
    const target  = container.scrollTop + offset - (container.clientHeight / 2) + (trRect.height / 2);
    container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
});

// ─── Workload Panel ───────────────────────────────────────────────────────────
let workloadScope = 'day'; // 'day' | 'all'

function calcWorkload(scope) {
  // メンバーごとの仕事時間(分)を集計
  const workMin = {}; // memberId → 仕事分数
  members.forEach(m => { workMin[m.id] = 0; });

  const targetSlots = scope === 'day'
    ? slots.filter(s => s.date === currentDay)
    : slots;

  targetSlots.forEach(slot => {
    const dur = timeToMin(slot.end_time) - timeToMin(slot.start_time);
    slot.assignments.forEach(a => {
      if (workMin[a.member_id] !== undefined) workMin[a.member_id] += dur;
    });
  });

  // 全体の最大値（バー幅の基準）
  const maxMin = Math.max(...Object.values(workMin), 1);

  return members.map(m => ({
    id: m.id,
    name: m.name,
    department: m.department || '',
    grade: m.grade || '',
    is_leader: m.is_leader,
    workMin: workMin[m.id] || 0,
    maxMin,
  })).sort((a, b) => b.workMin - a.workMin);
}

function fmtMin(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}時間${m > 0 ? m + '分' : ''}` : `${m}分`;
}

function renderWorkloadPanel() {
  const panel = $('workload-panel');
  const list  = $('workload-list');
  if (!panel || !list) return;

  const data = calcWorkload(workloadScope);
  if (!data.length) {
    list.innerHTML = '<div class="text-center py-8 text-gray-400 text-[11px]">メンバーがいません</div>';
    return;
  }

  const maxMin = data[0].maxMin;
  // 平均と最大・最小
  const total = data.reduce((s, d) => s + d.workMin, 0);
  const avg   = Math.round(total / data.length);
  const maxWork = data[0].workMin;
  const minWork = data[data.length - 1].workMin;

  // 不均衡度（最大 - 最小）
  const diff = maxWork - minWork;
  const fairColor = diff <= 30 ? '#48BB78' : diff <= 90 ? '#F6AD55' : '#F87171';
  const fairLabel = diff <= 30 ? '均等' : diff <= 90 ? 'やや偏り' : '偏り大';

  list.innerHTML = `
    <div class="mb-2 px-1">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[10px] text-gray-400">公平性</span>
        <span class="text-[10px] font-bold" style="color:${fairColor}">${fairLabel}</span>
      </div>
      <div class="flex justify-between text-[9px] text-gray-400">
        <span>平均: ${fmtMin(avg)}</span>
        <span>差: ${fmtMin(diff)}</span>
      </div>
    </div>
    <div class="space-y-1.5">
    ${data.map(d => {
      const pct  = maxMin > 0 ? Math.round((d.workMin / maxMin) * 100) : 0;
      const over = avg > 0 && d.workMin > avg * 1.3;
      const under = avg > 0 && d.workMin < avg * 0.7 && d.workMin > 0;
      const barColor = over ? '#F87171' : under ? '#60A5FA' : '#4DA3FF';
      const diffFromAvg = d.workMin - avg;
      const sign = diffFromAvg >= 0 ? '+' : '';
      return `
        <div class="bg-surface rounded-lg px-2 py-1.5">
          <div class="flex items-center gap-1 mb-1">
            ${d.is_leader ? '<span class="text-yellow-400 text-[9px]">★</span>' : ''}
            <span class="text-[10px] font-semibold text-gray-800 truncate flex-1">${d.name}</span>
            <span class="text-[9px] font-bold flex-shrink-0" style="color:${barColor}">${fmtMin(d.workMin)}</span>
          </div>
          <div class="w-full bg-gray-100 rounded-full h-1.5 mb-0.5">
            <div class="h-1.5 rounded-full transition-all" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <div class="text-[9px] text-gray-400 text-right">${sign}${fmtMin(Math.abs(diffFromAvg))}</div>
        </div>`;
    }).join('')}
    </div>`;
}

function showWorkloadPanel() {
  $('workload-panel').classList.remove('hidden');
  $('workload-panel').classList.add('flex');
  $('btn-open-workload').classList.add('hidden');
  renderWorkloadPanel();
}

function hideWorkloadPanel() {
  $('workload-panel').classList.add('hidden');
  $('workload-panel').classList.remove('flex');
  $('btn-open-workload').classList.remove('hidden');
}

// シフトタブを表示したとき自動で開く
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'shift') {
      $('btn-open-workload').classList.remove('hidden');
    } else {
      $('btn-open-workload').classList.add('hidden');
      hideWorkloadPanel();
    }
  });
});

$('btn-open-workload').addEventListener('click', showWorkloadPanel);
$('btn-close-workload').addEventListener('click', hideWorkloadPanel);

document.querySelectorAll('.workload-scope-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    workloadScope = btn.dataset.scope;
    document.querySelectorAll('.workload-scope-btn').forEach(b => {
      const active = b === btn;
      b.classList.toggle('bg-primary', active);
      b.classList.toggle('text-white', active);
      b.classList.toggle('text-gray-500', !active);
    });
    renderWorkloadPanel();
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadShifts();
