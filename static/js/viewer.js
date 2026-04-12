/* ClearShift - Viewer Dashboard JS */
'use strict';

const $ = id => document.getElementById(id);

// ─── Shared utils ─────────────────────────────────────────────────────────────
const fmtDate = iso => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
};

const STATUS_LABEL = { scheduled: '予定', absent: '欠席', late: '遅刻' };
const STATUS_COLOR = {
  scheduled: 'bg-primary-light text-primary',
  absent:    'bg-red-50 text-red-500',
  late:      'bg-amber-50 text-amber-600',
};

// API_ROOT はテンプレートから注入（サブパスデプロイ対応）
const _API_ROOT = window.API_ROOT || '';

async function apiFetch(url) {
  const res = await fetch(_API_ROOT + url);
  if (!res.ok) throw new Error('データの取得に失敗しました');
  return res.json();
}

// ─── Board constants / helpers ────────────────────────────────────────────────
const BOARD_START_H = 8;
const BOARD_END_H   = 22;
const CELL_W = { 15: 30, 30: 44, 60: 64 };

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
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
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
function gradeNum(grade) {
  if (!grade) return 0;
  const m = grade.match(/\d+/);
  return m ? parseInt(m[0]) : 0;
}

// ─── State ────────────────────────────────────────────────────────────────────
let myShifts = [];
let allSlots = [];
let allMembers = [];
let viewerCurrentDay = null;
let viewerIntervalMin = 30;
let viewerEventDates = [];

// ─── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.vtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.vtab;
    document.querySelectorAll('.vtab-btn').forEach(b => {
      b.classList.remove('border-primary', 'text-primary');
      b.classList.add('border-transparent', 'text-gray-500');
    });
    btn.classList.add('border-primary', 'text-primary');
    btn.classList.remove('border-transparent', 'text-gray-500');
    document.querySelectorAll('.vtab-content').forEach(c => c.classList.add('hidden'));
    $(`vtab-${tabId}`)?.classList.remove('hidden');

    if (tabId === 'mine')         loadMyShifts();
    if (tabId === 'all')          loadAllShifts();
    if (tabId === 'availability') loadAvailability();
  });
});

// ─── My Shifts (タイムライン) ──────────────────────────────────────────────────
async function loadMyShifts() {
  const list = $('my-shifts-list');
  try {
    myShifts = await apiFetch(`/event/${EVENT_ID}/api/my-shifts`);
    renderMyShifts();
  } catch (err) {
    list.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

function renderMyShifts() {
  const list = $('my-shifts-list');
  if (!myShifts.length) {
    list.innerHTML = `
      <div class="text-center py-14">
        <div class="w-14 h-14 bg-surface rounded-2xl flex items-center justify-center mx-auto mb-3">
          <svg class="w-7 h-7 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
          </svg>
        </div>
        <p class="text-gray-400 text-sm">割り当てられたシフトはありません</p>
      </div>`;
    return;
  }

  // 日付でグループ化
  const byDate = {};
  myShifts.forEach(s => (byDate[s.date] = byDate[s.date] || []).push(s));

  list.innerHTML = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, dayShifts]) => {
    const sorted = [...dayShifts].sort((a, b) => a.start_time.localeCompare(b.start_time));

    // タイムラインアイテムを構築（シフト前後・間の全空き時間を休憩として挿入）
    const items = [];
    const DAY_START = '08:00';
    const DAY_END   = '22:00';
    let cursor = DAY_START;

    sorted.forEach(s => {
      if (cursor < s.start_time) {
        items.push({ type: 'break', from: cursor, to: s.start_time });
      }
      items.push({ type: 'shift', shift: s });
      cursor = s.end_time;
    });

    if (cursor < DAY_END) {
      items.push({ type: 'break', from: cursor, to: DAY_END });
    }

    const timelineHtml = items.map(item => {
      if (item.type === 'break') {
        return `
          <div class="flex items-center gap-3 px-4 py-1.5">
            <div class="text-center" style="min-width:52px">
              <div class="text-[10px] text-gray-400 leading-tight">${item.from}</div>
              <div class="text-[10px] text-gray-300 leading-none">⋮</div>
              <div class="text-[10px] text-gray-400 leading-tight">${item.to}</div>
            </div>
            <div class="flex-1 flex items-center gap-2">
              <div class="flex-1 h-px bg-gray-100"></div>
              <span class="text-[11px] text-gray-400 font-medium px-2.5 py-0.5 bg-gray-50 rounded-full border border-gray-100">休憩</span>
              <div class="flex-1 h-px bg-gray-100"></div>
            </div>
          </div>`;
      }

      const s = item.shift;
      const color = s.job_color || '#4DA3FF';
      const colleaguesHtml = (s.colleagues && s.colleagues.length)
        ? `<div class="mt-2 space-y-1">
            <div class="text-[10px] text-gray-400 font-medium mb-1">同じシフトのメンバー</div>
            ${s.colleagues.map(c => `
              <div class="flex items-center gap-2 py-1 px-2 bg-gray-50 rounded-lg">
                <div class="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span class="text-[10px] font-bold text-primary">${c.name[0]}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-xs font-medium text-gray-800">${c.name}</span>
                  ${c.department ? `<span class="text-[10px] text-gray-400 ml-1">${c.department}</span>` : ''}
                </div>
                <button class="partner-absent-btn flex-shrink-0 text-[10px] font-medium px-2 py-1 rounded-md border transition-colors
                  ${c.status === 'absent' ? 'bg-red-500 text-white border-red-500' : 'bg-white text-red-400 border-red-200 hover:bg-red-50'}"
                  data-slot="${s.slot_id}" data-member="${c.member_id}" data-name="${c.name}">
                  ${c.status === 'absent' ? '報告済み' : 'いない'}
                </button>
              </div>`).join('')}
          </div>`
        : '';
      return `
        <div class="px-4 py-3">
          <button class="my-shift-card w-full text-left flex items-center gap-3 hover:bg-gray-50 active:bg-gray-100 transition-colors rounded-xl px-2 py-1.5"
            data-slot="${s.slot_id}">
            <div class="w-1 self-stretch rounded-full flex-shrink-0" style="background:${color}"></div>
            <div class="text-center flex-shrink-0" style="min-width:48px">
              <div class="text-sm font-bold" style="color:${color}">${s.start_time}</div>
              <div class="text-[11px] text-gray-400">${s.end_time}</div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold text-gray-900">${s.role || '（役割未設定）'}</div>
              ${s.location ? `
                <div class="flex items-center gap-1 mt-0.5">
                  <svg class="w-3 h-3 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                  </svg>
                  <span class="text-xs text-gray-400 truncate">${s.location}</span>
                </div>` : ''}
            </div>
            <div class="flex-shrink-0">
              <span class="text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLOR[s.status] || STATUS_COLOR.scheduled}">
                ${STATUS_LABEL[s.status] || s.status}
              </span>
            </div>
          </button>
          ${colleaguesHtml}
        </div>`;
    }).join('<div class="border-t border-gray-50 mx-4 my-0"></div>');

    return `
      <div class="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
        <div class="px-4 py-2.5 bg-surface border-b border-gray-100 flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0"></div>
          <span class="text-sm font-bold text-gray-800">${fmtDate(date)}</span>
          <span class="text-xs text-gray-400 ml-auto">${sorted.length}シフト</span>
        </div>
        ${timelineHtml}
      </div>`;
  }).join('');

  // クリックでシフト詳細モーダルを開く
  list.querySelectorAll('.my-shift-card').forEach(card => {
    card.addEventListener('click', () => {
      const slotId = parseInt(card.dataset.slot);
      const shift = myShifts.find(s => s.slot_id === slotId);
      if (shift) openShiftDetailModal(shift);
    });
  });

  // ペア欠席報告ボタン
  list.querySelectorAll('.partner-absent-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.textContent.trim() === '報告済み') return;
      showAbsentConfirm(
        btn.dataset.name,
        parseInt(btn.dataset.slot),
        parseInt(btn.dataset.member),
      );
    });
  });
}

// ── 欠席確認モーダル ──────────────────────────────────────────────────────────
let _absentConfirmCallback = null;

function showAbsentConfirm(name, slotId, memberId) {
  $('confirm-absent-msg').textContent = `${name} さんが来ていないことを報告しますか？`;
  $('modal-confirm-absent').classList.remove('hidden');
  _absentConfirmCallback = async () => {
    $('modal-confirm-absent').classList.add('hidden');
    try {
      const res = await fetch(`/event/${EVENT_ID}/api/report-partner-absent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_id: slotId, member_id: memberId }),
      });
      if (!res.ok) throw new Error();
      const shift = myShifts.find(s => s.slot_id === slotId);
      if (shift && shift.colleagues) {
        const col = shift.colleagues.find(c => c.member_id === memberId);
        if (col) col.status = 'absent';
      }
      renderMyShifts();
      showReportToast('partner');
    } catch {
      alert('送信に失敗しました。');
    }
  };
}

$('btn-confirm-absent-ok')?.addEventListener('click', () => {
  if (_absentConfirmCallback) { _absentConfirmCallback(); _absentConfirmCallback = null; }
});

function closeAbsentConfirm() {
  $('modal-confirm-absent').classList.add('hidden');
  _absentConfirmCallback = null;
}

$('btn-confirm-absent-cancel')?.addEventListener('click', closeAbsentConfirm);
$('confirm-absent-overlay')?.addEventListener('click', closeAbsentConfirm);

function showReportToast(status) {
  const msg = status === 'partner' ? '不在を管理者に報告しました' : status === 'absent' ? '欠席を報告しました' : status === 'late' ? '遅刻を報告しました' : '報告を取り消しました';
  const bg  = status === 'partner' ? '#EF4444' : status === 'absent' ? '#EF4444' : status === 'late' ? '#F59E0B' : '#6B7280';
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium text-white shadow-lg transition-opacity';
  toast.style.background = bg;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2500);
}

// ─── シフト詳細モーダル ────────────────────────────────────────────────────────
function openShiftDetailModal(shift) {
  const color = shift.job_color || '#4DA3FF';

  $('shift-detail-header').innerHTML = `
    <div class="flex items-center gap-2 mb-0.5">
      <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></div>
      <div class="text-base font-bold text-gray-900 truncate">${shift.role || '（役割未設定）'}</div>
    </div>
    <div class="text-xs text-gray-400 ml-[18px]">${fmtDate(shift.date)} &nbsp;${shift.start_time} 〜 ${shift.end_time}</div>`;

  const rows = [];

  // ステータス
  rows.push(`
    <div class="flex items-center justify-between bg-surface rounded-xl px-3 py-2.5">
      <span class="text-xs text-gray-500">ステータス</span>
      <span class="text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLOR[shift.status] || STATUS_COLOR.scheduled}">
        ${STATUS_LABEL[shift.status] || shift.status}
      </span>
    </div>`);

  // 仕事内容
  if (shift.job_description) {
    rows.push(`
      <div class="rounded-xl p-3.5" style="background:${hexToRgba(color, 0.09)}">
        <div class="text-xs font-semibold mb-1.5" style="color:${color}">仕事内容</div>
        <div class="text-sm text-gray-700 leading-relaxed">${shift.job_description}</div>
      </div>`);
  }

  // 集合場所
  if (shift.location) {
    rows.push(`
      <div class="flex items-center gap-3 bg-surface rounded-xl px-3 py-2.5">
        <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        <div>
          <div class="text-[10px] text-gray-400">集合場所</div>
          <div class="text-sm font-medium text-gray-800">${shift.location}</div>
        </div>
      </div>`);
  }

  // メモ
  if (shift.note) {
    rows.push(`
      <div class="bg-amber-50 rounded-xl px-3 py-2.5">
        <div class="text-[10px] font-semibold text-amber-600 mb-1">メモ</div>
        <div class="text-sm text-amber-800">${shift.note}</div>
      </div>`);
  }

  // 一緒のメンバー
  if (shift.colleagues && shift.colleagues.length > 0) {
    rows.push(`
      <div>
        <div class="text-xs font-semibold text-gray-500 mb-2">同じシフトのメンバー <span class="font-normal text-gray-400">${shift.colleagues.length}人</span></div>
        <div class="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
          ${shift.colleagues.map(c => `
            <div class="flex items-center gap-3 px-3 py-2.5">
              <div class="w-8 h-8 rounded-full bg-primary-light flex items-center justify-center flex-shrink-0">
                <span class="text-xs font-bold text-primary">${c.name[0]}</span>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-800">${c.name}</div>
                ${(c.department || c.grade) ? `<div class="text-xs text-gray-400">${[c.department, c.grade].filter(Boolean).join(' · ')}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>`);
  } else {
    rows.push(`<div class="text-xs text-gray-400 text-center py-2">このシフトは一人担当です</div>`);
  }

  $('shift-detail-body').innerHTML = rows.join('');
  $('modal-shift-detail').classList.remove('hidden');
}

$('btn-shift-detail-close').addEventListener('click', () => $('modal-shift-detail').classList.add('hidden'));
$('shift-detail-overlay').addEventListener('click',  () => $('modal-shift-detail').classList.add('hidden'));

// ─── All Shifts Board ─────────────────────────────────────────────────────────
async function loadAllShifts() {
  const board = $('all-shifts-board');
  try {
    [allSlots, allMembers] = await Promise.all([
      apiFetch(`/event/${EVENT_ID}/api/all-shifts`),
      apiFetch(`/event/${EVENT_ID}/api/members`),
    ]);
    viewerEventDates = generateEventDates(EVENT_START, EVENT_END);
    if (!viewerCurrentDay || !viewerEventDates.includes(viewerCurrentDay)) {
      viewerCurrentDay = viewerEventDates[0] || null;
    }
    renderViewerDayTabs();
    renderViewerBoard();
    renderViewerWorkload();
  } catch (err) {
    board.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

function renderViewerDayTabs() {
  const container = $('board-day-tabs');
  if (!container) return;
  container.innerHTML = viewerEventDates.map(date => {
    const d = new Date(date + 'T00:00:00');
    const dateStr = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const customLabel = (typeof DAY_LABELS !== 'undefined' && DAY_LABELS[date]) || '';
    const active = date === viewerCurrentDay;
    const inner = customLabel
      ? `<span class="flex flex-col items-start leading-tight">
           <span>${customLabel}</span>
           <span class="${active ? 'opacity-60' : 'text-gray-400'}" style="font-size:9px;font-weight:400">${dateStr}</span>
         </span>`
      : dateStr;
    return `<button class="viewer-day-tab flex-shrink-0 flex items-center px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors
      ${active ? 'bg-primary text-white' : 'text-gray-600 hover:bg-surface border border-transparent hover:border-gray-200'}"
      data-date="${date}">${inner}</button>`;
  }).join('');
  container.querySelectorAll('.viewer-day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      viewerCurrentDay = btn.dataset.date;
      renderViewerDayTabs();
      renderViewerBoard();
      renderViewerWorkload();
    });
  });
}

function renderViewerBoard() {
  const board = $('all-shifts-board');
  if (!viewerCurrentDay || !allMembers.length) {
    board.innerHTML = `<div class="p-10 text-center text-gray-400 text-sm">データがありません</div>`;
    return;
  }

  const cols = buildTimeCols(viewerIntervalMin);
  const cw   = CELL_W[viewerIntervalMin] || 44;
  const daySlots = allSlots.filter(s => s.date === viewerCurrentDay);

  // cellMap: memberId|timeStr → { slotId, role, status, isFirst, jobColor }
  const cellMap = new Map();
  // memberShiftRanges: memberId → [{startM, endM}]（休憩計算用）
  const memberShiftRanges = new Map();

  daySlots.forEach(slot => {
    const startM   = timeToMin(slot.start_time);
    const endM     = timeToMin(slot.end_time);
    const jobColor = slot.job_color || '#4DA3FF';

    const spanPx = Math.round((endM - startM) / viewerIntervalMin) * cw;
    slot.assignments.forEach(a => {
      if (!memberShiftRanges.has(a.member_id)) memberShiftRanges.set(a.member_id, []);
      memberShiftRanges.get(a.member_id).push({ startM, endM });

      cols.forEach((col, i) => {
        const colM = timeToMin(col);
        if (colM >= startM && colM < endM) {
          const prevM = i > 0 ? timeToMin(cols[i - 1]) : -1;
          cellMap.set(`${a.member_id}|${col}`, {
            slotId: slot.id, role: slot.role,
            status: a.status, isFirst: prevM < startM,
            spanPx,
            jobColor,
          });
        }
      });
    });
  });

  // gapMap: memberId|timeStr → true（シフト間の休憩時間）
  const gapMap = new Map();
  memberShiftRanges.forEach((ranges, memberId) => {
    const sorted = [...ranges].sort((a, b) => a.startM - b.startM);
    for (let i = 0; i < sorted.length - 1; i++) {
      const gapStart = sorted[i].endM;
      const gapEnd   = sorted[i + 1].startM;
      cols.forEach(col => {
        const colM = timeToMin(col);
        if (colM >= gapStart && colM < gapEnd) gapMap.set(`${memberId}|${col}`, true);
      });
    }
  });

  // メンバーソート: リーダー優先 → 学年降順
  const sortedMembers = [...allMembers].sort(
    (a, b) => (b.is_leader ? 1 : 0) - (a.is_leader ? 1 : 0) || gradeNum(b.grade) - gradeNum(a.grade)
  );

  // 局でグループ化
  const deptOrder = [];
  const deptGroups = {};
  sortedMembers.forEach(m => {
    const d = m.department || '未分類';
    if (!deptGroups[d]) { deptGroups[d] = []; deptOrder.push(d); }
    deptGroups[d].push(m);
  });

  // 時間グループ（1段目ヘッダー）
  const hourGroups = [];
  cols.forEach(col => {
    const h = parseInt(col.split(':')[0]);
    const last = hourGroups[hourGroups.length - 1];
    if (!last || last.hour !== h) hourGroups.push({ hour: h, count: 1 });
    else last.count++;
  });

  function colBorder(col) {
    const m = parseInt(col.split(':')[1]);
    if (m === 0)  return 'border-l-2 border-l-gray-300';
    if (m === 30) return 'border-l border-l-gray-200';
    return '';
  }

  const ROW1_H = 29;
  const MEMBER_W = 120, DEPT_W = 56;

  const topRowHtml = hourGroups.map(g =>
    `<th colspan="${g.count}" style="min-width:${cw * g.count}px"
      class="sticky top-0 z-10 bg-white border-b-2 border-b-gray-200 border-l-2 border-l-gray-300 py-1.5 text-center text-[11px] font-bold text-gray-700 select-none">
      ${g.hour}<span class="font-normal text-gray-400">:00</span>
    </th>`
  ).join('');

  const bottomRowHtml = cols.map(col => {
    const m = parseInt(col.split(':')[1]);
    const label = m === 0 ? '00' : viewerIntervalMin >= 30 ? '30' : String(m).padStart(2, '0');
    const textCls = m === 0 ? 'text-gray-500 font-semibold' : 'text-gray-400';
    return `<th style="min-width:${cw}px;width:${cw}px;top:${ROW1_H}px"
      class="sticky z-10 bg-gray-50 border-b border-gray-200 py-1 text-center text-[9px] select-none ${colBorder(col)} ${textCls}">
      ${label}
    </th>`;
  }).join('');

  const rowsHtml = deptOrder.map(dept => {
    const deptMembers = deptGroups[dept];
    const sep = `
      <tr>
        <td colspan="${cols.length + 2}" class="bg-gray-100 border-t-2 border-b border-gray-300 px-3 py-1 select-none">
          <span class="text-[10px] font-bold text-gray-500 uppercase tracking-wide">${dept}</span>
          <span class="text-[10px] text-gray-400 ml-1">${deptMembers.length}人</span>
        </td>
      </tr>`;

    const memberRows = deptMembers.map(m => {
      const isMe     = m.id === MY_MEMBER_ID;
      const leaderBg = m.is_leader ? 'background:#FEFCE8;' : '';
      const rowBg    = isMe ? 'background:#EFF6FF;' : leaderBg;

      const cellsHtml = cols.map(col => {
        const key  = `${m.id}|${col}`;
        const cell = cellMap.get(key);
        const isGap = gapMap.get(key);
        const cb = colBorder(col);

        if (cell) {
          const bg     = slotColor(cell.jobColor, cell.status);
          const border = cell.isFirst ? `border-left:3px solid ${cell.jobColor};` : '';
          const roleText = (cell.isFirst && cell.role)
            ? `<span class="absolute top-0 left-0 flex items-center px-1 text-[9px] font-semibold whitespace-nowrap pointer-events-none z-[1]" style="height:100%;width:${cell.spanPx}px;color:${cell.jobColor}">${cell.role}</span>`
            : '';
          return `<td style="min-width:${cw}px;width:${cw}px;background:${bg};${border}"
            class="relative h-10 border-b border-b-white/30 ${cb}">${roleText}</td>`;
        }

        if (isGap) {
          // 休憩の最初のセルかどうか判定
          const prevCol = cols[cols.indexOf(col) - 1];
          const isFirstGap = !prevCol || !gapMap.get(`${m.id}|${prevCol}`);
          return `<td style="min-width:${cw}px;width:${cw}px;background:rgba(156,163,175,0.1)"
            class="relative h-10 border-b border-b-gray-50 ${cb}">
            ${isFirstGap ? `<span class="absolute top-0 left-0 flex items-center px-1 text-[9px] text-gray-400 whitespace-nowrap select-none pointer-events-none z-[1]" style="height:100%">休憩</span>` : ''}
          </td>`;
        }

        return `<td style="min-width:${cw}px;width:${cw}px"
          class="h-10 border-b border-b-gray-50 ${cb}"></td>`;
      }).join('');

      // sticky列は必ず不透明な背景色（スクロール時に後ろが透けないよう）
      const solidBg = isMe        ? '#EFF6FF'
                    : m.is_leader ? '#FEFCE8'
                    : '#FFFFFF';

      return `<tr style="${rowBg}">
        <td class="sticky left-0 z-10 border-b border-gray-100 px-2 py-1 whitespace-nowrap select-none"
          style="min-width:${MEMBER_W}px;background:${solidBg}">
          <div class="flex items-center gap-1">
            ${m.is_leader ? '<span class="text-yellow-400 text-[11px] flex-shrink-0">★</span>' : ''}
            ${isMe ? '<span class="text-primary text-[11px] font-bold flex-shrink-0">▶</span>' : ''}
            <div class="min-w-0">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 0;color:${isMe ? '#4DA3FF' : '#1f2937'};font-size:12px;font-weight:600">
                ${m.name}${m.grade ? `<span style="margin-left:4px;font-size:9px;font-weight:400;color:#9ca3af">${m.grade}</span>` : ''}
              </div>
            </div>
          </div>
        </td>
        <td class="sticky border-b border-gray-100 px-1.5 py-1 whitespace-nowrap select-none text-[9px] text-gray-500 font-medium"
          style="left:${MEMBER_W}px;min-width:${DEPT_W}px;background:${solidBg};box-shadow:3px 0 5px rgba(0,0,0,0.08)">
          ${m.department || ''}
        </td>
        ${cellsHtml}
      </tr>`;
    }).join('');

    return sep + memberRows;
  }).join('');

  const totalW = MEMBER_W + DEPT_W + cols.length * cw;
  board.innerHTML = `
    <table class="border-collapse" style="width:${totalW}px;min-width:100%">
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
}

// インターバルボタン
document.querySelectorAll('.viewer-interval-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    viewerIntervalMin = parseInt(btn.dataset.min);
    document.querySelectorAll('.viewer-interval-btn').forEach(b => {
      const active = b === btn;
      b.classList.toggle('bg-primary',    active);
      b.classList.toggle('text-white',    active);
      b.classList.toggle('text-gray-500', !active);
    });
    renderViewerBoard();
  });
});

// ─── Availability ─────────────────────────────────────────────────────────────
let availData = {};

async function loadAvailability() {
  const form      = $('availability-form');
  const submitBtn = $('btn-submit-avail');
  try {
    const [allShiftsForDates, existingAvail] = await Promise.all([
      apiFetch(`/event/${EVENT_ID}/api/all-shifts`),
      apiFetch(`/event/${EVENT_ID}/api/availability`),
    ]);

    existingAvail.forEach(a => {
      availData[a.date] = { available: a.available, note: a.note || '' };
    });

    const slotDates = new Set(allShiftsForDates.map(s => s.date));
    if (!slotDates.size) {
      form.innerHTML = '<div class="text-center py-10 text-gray-400 text-sm">シフト枠がまだありません。</div>';
      return;
    }

    const dates = [...slotDates].sort();
    form.innerHTML = dates.map(d => {
      const av = availData[d];
      const isAvail = av ? av.available : null;
      return `
        <div class="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-gray-800 min-w-0 truncate">${fmtDate(d)}</span>
            <div class="flex gap-2 flex-shrink-0" data-date="${d}">
              <button class="avail-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                ${isAvail === true ? 'bg-primary text-white border-primary' : 'bg-white text-gray-500 border-gray-200 hover:border-primary hover:text-primary'}"
                data-date="${d}" data-val="true">参加可</button>
              <button class="avail-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                ${isAvail === false ? 'bg-red-500 text-white border-red-500' : 'bg-white text-gray-500 border-gray-200 hover:border-red-400 hover:text-red-500'}"
                data-date="${d}" data-val="false">参加不可</button>
            </div>
          </div>
        </div>`;
    }).join('');

    submitBtn.classList.remove('hidden');

    form.querySelectorAll('.avail-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const date = btn.dataset.date;
        const val  = btn.dataset.val === 'true';
        availData[date] = { available: val, note: '' };
        const group = form.querySelector(`[data-date="${date}"]`);
        group.querySelectorAll('.avail-btn').forEach(b => {
          const bVal = b.dataset.val === 'true';
          if (bVal === val) {
            b.className = `avail-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              val ? 'bg-primary text-white border-primary' : 'bg-red-500 text-white border-red-500'}`;
          } else {
            b.className = `avail-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors bg-white text-gray-500 border-gray-200 ${
              bVal ? 'hover:border-primary hover:text-primary' : 'hover:border-red-400 hover:text-red-500'}`;
          }
        });
      });
    });
  } catch (err) {
    form.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

$('btn-submit-avail').addEventListener('click', async () => {
  const successEl = $('avail-success');
  try {
    const payload = Object.entries(availData).map(([date, av]) => ({
      date,
      available: av.available,
      note: av.note || '',
    }));
    const res = await fetch(`/event/${EVENT_ID}/api/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ availabilities: payload }),
    });
    if (!res.ok) throw new Error('送信に失敗しました');
    successEl.classList.remove('hidden');
    setTimeout(() => successEl.classList.add('hidden'), 3000);
  } catch (err) {
    alert(err.message);
  }
});

// ─── Viewer Workload Panel ────────────────────────────────────────────────────
let viewerWorkloadScope = 'day';

function fmtMin(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}時間${m > 0 ? m + '分' : ''}` : `${m}分`;
}

const DAY_TOTAL_MIN = (22 - 8) * 60; // 840分

function renderViewerWorkload() {
  const list = $('viewer-workload-list');
  if (!list || !allMembers.length) return;

  const isAll = viewerWorkloadScope === 'all';
  const targetDates = isAll ? viewerEventDates : (viewerCurrentDay ? [viewerCurrentDay] : []);
  const dayCount = targetDates.length || 1;
  const totalAvailMin = DAY_TOTAL_MIN * dayCount;

  const targetSlots = isAll ? allSlots : allSlots.filter(s => s.date === viewerCurrentDay);

  const workMinMap = {};
  allMembers.forEach(m => { workMinMap[m.id] = 0; });
  targetSlots.forEach(slot => {
    const dur = timeToMin(slot.end_time) - timeToMin(slot.start_time);
    slot.assignments.forEach(a => {
      if (workMinMap[a.member_id] !== undefined) workMinMap[a.member_id] += dur;
    });
  });

  const sorted = [...allMembers]
    .map(m => ({
      ...m,
      workMin: workMinMap[m.id] || 0,
      breakMin: Math.max(0, totalAvailMin - (workMinMap[m.id] || 0)),
    }))
    .sort((a, b) => b.workMin - a.workMin);

  list.innerHTML = `
    <div class="space-y-1.5">
    ${sorted.map(d => {
      const isMe = d.id === MY_MEMBER_ID;
      const workPct  = totalAvailMin > 0 ? Math.round((d.workMin  / totalAvailMin) * 100) : 0;
      const breakPct = totalAvailMin > 0 ? Math.round((d.breakMin / totalAvailMin) * 100) : 0;
      return `
        <div class="rounded-lg px-2 py-1.5 ${isMe ? 'bg-blue-50' : 'bg-surface'}">
          <div class="flex items-center gap-1 mb-1">
            ${d.is_leader ? '<span class="text-yellow-400 text-[9px]">★</span>' : ''}
            ${isMe ? '<span class="text-primary text-[9px] font-bold">▶</span>' : ''}
            <span class="text-[10px] font-semibold truncate flex-1 ${isMe ? 'text-primary' : 'text-gray-800'}">${d.name}</span>
          </div>
          <div class="flex w-full h-2 rounded-full overflow-hidden bg-gray-100 mb-0.5">
            ${workPct > 0  ? `<div class="h-full bg-blue-400" style="width:${workPct}%"></div>` : ''}
            ${breakPct > 0 ? `<div class="h-full bg-gray-300" style="width:${breakPct}%"></div>` : ''}
          </div>
          <div class="flex justify-between text-[9px]">
            <span class="text-blue-400 font-medium">仕事 ${fmtMin(d.workMin)}</span>
            <span class="text-gray-400">休憩 ${fmtMin(d.breakMin)}</span>
          </div>
        </div>`;
    }).join('')}
    </div>`;
}

document.querySelectorAll('.viewer-workload-scope').forEach(btn => {
  btn.addEventListener('click', () => {
    viewerWorkloadScope = btn.dataset.scope;
    document.querySelectorAll('.viewer-workload-scope').forEach(b => {
      const active = b === btn;
      b.classList.toggle('bg-primary',    active);
      b.classList.toggle('text-white',    active);
      b.classList.toggle('text-gray-500', !active);
    });
    renderViewerWorkload();
  });
});

// ─── PDF Download ─────────────────────────────────────────────────────────────

// 通常用（マイシフトなど縦スクロールのみの要素）
async function captureAsPDF(targetEl, filename, landscape) {
  const fullW = targetEl.scrollWidth;
  const fullH = targetEl.scrollHeight;
  const canvas = await html2canvas(targetEl, {
    scale: 1.5,
    useCORS: true,
    backgroundColor: '#ffffff',
    width: fullW,
    height: fullH,
    windowWidth: fullW,
    windowHeight: fullH,
    scrollX: 0,
    scrollY: 0,
  });
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const pxPerMm = (96 * 1.5) / 25.4;
  const imgW_mm = canvas.width  / pxPerMm;
  const imgH_mm = canvas.height / pxPerMm;
  const scale = pageW / imgW_mm;
  const scaledW = imgW_mm * scale;
  const scaledH = imgH_mm * scale;
  const imgData = canvas.toDataURL('image/png');
  if (scaledH <= pageH) {
    pdf.addImage(imgData, 'PNG', 0, 0, scaledW, scaledH);
  } else {
    let y = 0;
    while (y < scaledH) {
      if (y > 0) pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, -y, scaledW, scaledH);
      y += pageH;
    }
  }
  pdf.save(filename);
}

// 全体シフトボード用（横スクロールコンテナを一時展開してフル幅キャプチャ）
async function captureShiftBoardPDF(filename) {
  const board   = $('all-shifts-board');
  const wrapper = $('board-wrapper');
  if (!board) return;

  const prevWrapperOverflow = wrapper ? wrapper.style.overflow : null;
  const prevWrapperW        = wrapper ? wrapper.style.width    : null;
  const prevWrapperH        = wrapper ? wrapper.style.height   : null;
  const prevBoardW          = board.style.width;
  const scrollLeft          = wrapper?.scrollLeft || 0;
  const scrollTop           = wrapper?.scrollTop  || 0;

  try {
    // スクロールコンテナを解除して全体を表示
    if (wrapper) {
      wrapper.style.overflow = 'visible';
      wrapper.style.width    = 'max-content';
      wrapper.style.height   = 'auto';
    }
    board.style.width = 'max-content';

    const fullW = board.scrollWidth;
    const fullH = board.scrollHeight;

    const canvas = await html2canvas(board, {
      scale: 1.5,
      useCORS: true,
      backgroundColor: '#ffffff',
      width: fullW,
      height: fullH,
      windowWidth: fullW,
      windowHeight: fullH,
      scrollX: 0,
      scrollY: 0,
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const pxPerMm = (96 * 1.5) / 25.4;
    const imgW_mm = canvas.width  / pxPerMm;
    const imgH_mm = canvas.height / pxPerMm;
    const scale = pageW / imgW_mm;
    const scaledW = imgW_mm * scale;
    const scaledH = imgH_mm * scale;
    const imgData = canvas.toDataURL('image/png');

    if (scaledH <= pageH) {
      pdf.addImage(imgData, 'PNG', 0, 0, scaledW, scaledH);
    } else {
      let y = 0;
      while (y < scaledH) {
        if (y > 0) pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, -y, scaledW, scaledH);
        y += pageH;
      }
    }
    pdf.save(filename);
  } finally {
    if (wrapper) {
      wrapper.style.overflow = prevWrapperOverflow;
      wrapper.style.width    = prevWrapperW;
      wrapper.style.height   = prevWrapperH;
      wrapper.scrollLeft = scrollLeft;
      wrapper.scrollTop  = scrollTop;
    }
    board.style.width = prevBoardW;
  }
}

$('btn-download-myshift-pdf')?.addEventListener('click', async function () {
  const target = $('my-shifts-list');
  if (!target) return;
  this.textContent = '生成中...';
  this.disabled = true;
  try {
    await captureAsPDF(target, `マイシフト_${MEMBER_NAME}.pdf`, false);
  } catch (e) {
    alert('PDFの生成に失敗しました。');
  } finally {
    this.textContent = 'PDF';
    this.disabled = false;
  }
});

$('btn-download-allshift-pdf')?.addEventListener('click', async function () {
  this.textContent = '生成中...';
  this.disabled = true;
  try {
    const dateLabel = viewerCurrentDay || '全体シフト';
    await captureShiftBoardPDF(`全体シフト_${dateLabel}.pdf`);
  } catch (e) {
    alert('PDFの生成に失敗しました。');
  } finally {
    this.textContent = 'PDF';
    this.disabled = false;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadMyShifts();
