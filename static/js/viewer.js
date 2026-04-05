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

async function apiFetch(url) {
  const res = await fetch(url);
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
      return `
        <button class="my-shift-card w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors"
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
            ${s.colleagues && s.colleagues.length ? `
              <div class="text-[11px] text-gray-400 mt-0.5 truncate">
                一緒に: ${s.colleagues.slice(0, 3).map(c => c.name).join('、')}${s.colleagues.length > 3 ? ` 他${s.colleagues.length - 3}人` : ''}
              </div>` : ''}
          </div>
          <div class="flex flex-col items-end gap-1 flex-shrink-0">
            <span class="text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLOR[s.status] || STATUS_COLOR.scheduled}">
              ${STATUS_LABEL[s.status] || s.status}
            </span>
            <svg class="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
          </div>
        </button>`;
    }).join('<div class="border-t border-gray-50 mx-4"></div>');

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
  } catch (err) {
    board.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

function renderViewerDayTabs() {
  const container = $('board-day-tabs');
  if (!container) return;
  container.innerHTML = viewerEventDates.map(date => {
    const d = new Date(date + 'T00:00:00');
    const label = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const active = date === viewerCurrentDay;
    return `<button class="viewer-day-tab flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-lg transition-colors
      ${active ? 'bg-primary text-white' : 'text-gray-600 hover:bg-surface border border-transparent hover:border-gray-200'}"
      data-date="${date}">${label}</button>`;
  }).join('');
  container.querySelectorAll('.viewer-day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      viewerCurrentDay = btn.dataset.date;
      renderViewerDayTabs();
      renderViewerBoard();
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
            ? `<span class="absolute inset-0 flex items-center px-1 text-[9px] font-semibold overflow-hidden whitespace-nowrap pointer-events-none" style="color:${cell.jobColor}">${cell.role}</span>`
            : '';
          return `<td style="min-width:${cw}px;width:${cw}px;background:${bg};${border}"
            class="relative h-9 border-b border-b-white/30 ${cb}">${roleText}</td>`;
        }

        if (isGap) {
          // 休憩の最初のセルかどうか判定
          const prevCol = cols[cols.indexOf(col) - 1];
          const isFirstGap = !prevCol || !gapMap.get(`${m.id}|${prevCol}`);
          return `<td style="min-width:${cw}px;width:${cw}px;background:rgba(156,163,175,0.1)"
            class="relative h-9 border-b border-b-gray-50 ${cb}">
            ${isFirstGap ? `<span class="absolute inset-0 flex items-center px-1 text-[9px] text-gray-400 whitespace-nowrap select-none">休憩</span>` : ''}
          </td>`;
        }

        return `<td style="min-width:${cw}px;width:${cw}px"
          class="h-9 border-b border-b-gray-50 ${cb}"></td>`;
      }).join('');

      return `<tr style="${rowBg}">
        <td class="sticky left-0 z-10 border-r border-b border-gray-100 px-2 py-1 whitespace-nowrap select-none"
          style="min-width:${MEMBER_W}px;${rowBg}">
          <div class="flex items-center gap-1">
            ${m.is_leader ? '<span class="text-yellow-400 text-[11px] flex-shrink-0">★</span>' : ''}
            ${isMe ? '<span class="text-primary text-[11px] font-bold flex-shrink-0">▶</span>' : ''}
            <div class="min-w-0">
              <div class="text-xs font-semibold truncate ${isMe ? 'text-primary' : 'text-gray-800'}">${m.name}</div>
              ${m.grade ? `<div class="text-[9px] text-gray-400">${m.grade}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="sticky border-r border-b border-gray-100 px-1.5 py-1 whitespace-nowrap select-none text-[9px] text-gray-400"
          style="left:${MEMBER_W}px;min-width:${DEPT_W}px;${rowBg}">
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
            class="sticky left-0 z-30 bg-white border-r border-b-2 border-b-gray-200 border-gray-100 px-3 text-left text-xs text-gray-500 font-medium select-none">
            メンバー
          </th>
          <th rowspan="2" style="min-width:${DEPT_W}px;top:0;left:${MEMBER_W}px"
            class="sticky z-30 bg-white border-r border-b-2 border-b-gray-200 border-gray-100 px-2 text-left text-xs text-gray-500 font-medium select-none">
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

// ─── Init ─────────────────────────────────────────────────────────────────────
loadMyShifts();
