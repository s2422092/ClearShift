/* ClearShift - Viewer Dashboard JS */

'use strict';

const $ = id => document.getElementById(id);

const fmtDate = iso => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
};

const STATUS_LABEL = { scheduled: '予定', absent: '欠席', late: '遅刻' };
const STATUS_COLOR = {
  scheduled: 'bg-primary-light text-primary',
  absent: 'bg-red-50 text-red-500',
  late: 'bg-amber-50 text-amber-600',
};

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('データの取得に失敗しました');
  return res.json();
}

// ─── Tab switching ────────────────────────────────────────────────────────────
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

    if (tabId === 'mine') loadMyShifts();
    if (tabId === 'all') loadAllShifts();
    if (tabId === 'availability') loadAvailability();
  });
});

// ─── My Shifts ────────────────────────────────────────────────────────────────
async function loadMyShifts() {
  const list = $('my-shifts-list');
  try {
    const shifts = await apiFetch(`/event/${EVENT_ID}/api/my-shifts`);
    if (!shifts.length) {
      list.innerHTML = `
        <div class="text-center py-12">
          <div class="w-12 h-12 bg-surface rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
    shifts.forEach(s => (byDate[s.date] = byDate[s.date] || []).push(s));

    list.innerHTML = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, dayShifts]) => `
      <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div class="px-4 py-2.5 bg-surface border-b border-gray-100">
          <span class="text-sm font-bold text-gray-800">${fmtDate(date)}</span>
        </div>
        ${dayShifts.map(s => `
          <div class="px-4 py-3 flex items-center gap-3">
            <div class="text-center min-w-[56px]">
              <div class="text-sm font-bold text-primary">${s.start_time}</div>
              <div class="text-xs text-gray-400">${s.end_time}</div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                ${s.role ? `<span class="text-sm font-semibold text-gray-800">${s.role}</span>` : ''}
                ${s.location ? `<span class="text-xs text-gray-400">📍 ${s.location}</span>` : ''}
              </div>
            </div>
            <span class="text-xs font-medium px-2 py-1 rounded-full ${STATUS_COLOR[s.status] || STATUS_COLOR.scheduled}">
              ${STATUS_LABEL[s.status] || s.status}
            </span>
          </div>
        `).join('<div class="border-t border-gray-50"></div>')}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

// ─── All Shifts ───────────────────────────────────────────────────────────────
async function loadAllShifts() {
  const list = $('all-shifts-list');
  try {
    const slots = await apiFetch(`/event/${EVENT_ID}/api/all-shifts`);

    // 日付フィルターオプション更新
    const dateFilter = $('all-filter-date');
    const dates = [...new Set(slots.map(s => s.date))].sort();
    dateFilter.innerHTML = '<option value="">全ての日付</option>' +
      dates.map(d => `<option value="${d}">${fmtDate(d)}</option>`).join('');

    const render = () => {
      const filterDate = dateFilter.value;
      const filtered = filterDate ? slots.filter(s => s.date === filterDate) : slots;

      if (!filtered.length) {
        list.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">シフトがありません</div>`;
        return;
      }

      const byDate = {};
      filtered.forEach(s => (byDate[s.date] = byDate[s.date] || []).push(s));

      list.innerHTML = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, daySlots]) => `
        <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div class="px-4 py-2.5 bg-surface border-b border-gray-100">
            <span class="text-sm font-bold text-gray-800">${fmtDate(date)}</span>
          </div>
          ${daySlots.map(slot => `
            <div class="px-4 py-3 border-b border-gray-50 last:border-0">
              <div class="flex items-start gap-3">
                <div class="text-center min-w-[56px]">
                  <div class="text-xs font-bold text-primary">${slot.start_time}</div>
                  <div class="text-xs text-gray-400">${slot.end_time}</div>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1.5 flex-wrap">
                    ${slot.role ? `<span class="text-sm font-semibold text-gray-800">${slot.role}</span>` : ''}
                    ${slot.location ? `<span class="text-xs text-gray-400">📍 ${slot.location}</span>` : ''}
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    ${slot.assignments.length
                      ? slot.assignments.map(a => {
                          const isMe = a.member_name === MEMBER_NAME;
                          return `<span class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full
                            ${isMe ? 'bg-primary text-white' : STATUS_COLOR[a.status] || STATUS_COLOR.scheduled}">
                            ${isMe ? '★ ' : ''}${a.member_name}
                          </span>`;
                        }).join('')
                      : '<span class="text-xs text-gray-400">未割り当て</span>'
                    }
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('');
    };

    dateFilter.addEventListener('change', render);
    render();
  } catch (err) {
    list.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

// ─── Availability ─────────────────────────────────────────────────────────────
let availData = {};  // date -> { available, note }

async function loadAvailability() {
  const form = $('availability-form');
  const submitBtn = $('btn-submit-avail');
  try {
    // イベントの日付範囲を全体シフトから取得（またはAPIから）
    const allShifts = await apiFetch(`/event/${EVENT_ID}/api/all-shifts`);
    const existingAvail = await apiFetch(`/event/${EVENT_ID}/api/availability`);

    // 既存の希望データをマップに
    existingAvail.forEach(a => {
      availData[a.date] = { available: a.available, note: a.note || '' };
    });

    // 日付リスト（全シフトの日付 + イベント期間）
    const slotDates = new Set(allShifts.map(s => s.date));

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
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-gray-800">${fmtDate(d)}</span>
            <div class="flex gap-2" data-date="${d}">
              <button class="avail-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                ${isAvail === true ? 'bg-primary text-white border-primary' : 'bg-white text-gray-500 border-gray-200 hover:border-primary hover:text-primary'}"
                data-date="${d}" data-val="true">参加可</button>
              <button class="avail-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                ${isAvail === false ? 'bg-red-500 text-white border-red-500' : 'bg-white text-gray-500 border-gray-200 hover:border-red-400 hover:text-red-500'}"
                data-date="${d}" data-val="false">参加不可</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    submitBtn.classList.remove('hidden');

    form.querySelectorAll('.avail-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const date = btn.dataset.date;
        const val = btn.dataset.val === 'true';
        availData[date] = { available: val, note: '' };

        // ボタンスタイル更新
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
