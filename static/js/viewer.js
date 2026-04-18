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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── State ────────────────────────────────────────────────────────────────────
let myShifts = [];

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

// ─── Init ─────────────────────────────────────────────────────────────────────
loadMyShifts();
