/* ClearShift - Admin Event Detail JS */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let members = [];
let slots = [];
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
    if (tabId === 'fairness') loadFairness();
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
async function loadMembers() {
  const list = $('member-list');
  try {
    members = await apiFetch(`/api/events/${EVENT_ID}/members`);
    if (!members.length) {
      list.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">メンバーがいません。追加してください。</div>`;
      return;
    }
    // 局でグループ化
    const depts = {};
    members.forEach(m => {
      const key = m.department || '未分類';
      (depts[key] = depts[key] || []).push(m);
    });
    list.innerHTML = Object.entries(depts).map(([dept, mems]) => `
      <div class="bg-white rounded-xl border border-gray-100 overflow-hidden mb-3">
        <div class="px-4 py-2 bg-surface border-b border-gray-100">
          <span class="text-xs font-semibold text-gray-500">${dept}</span>
        </div>
        <div class="divide-y divide-gray-50">
          ${mems.map(m => `
            <div class="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 group">
              <div class="w-7 h-7 rounded-full bg-primary-light flex items-center justify-center flex-shrink-0">
                <span class="text-xs font-bold text-primary">${m.name[0]}</span>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-900">${m.name}</div>
                <div class="text-xs text-gray-400">${[m.grade, m.email].filter(Boolean).join(' · ')}</div>
              </div>
              <button class="btn-del-member text-gray-300 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                data-id="${m.id}" title="削除">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.btn-del-member').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('このメンバーを削除しますか？')) return;
        try {
          await apiFetch(`/api/events/${EVENT_ID}/members/${btn.dataset.id}`, { method: 'DELETE' });
          loadMembers();
        } catch (err) { showToast(err.message, true); }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

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

// ─── Load Shifts ──────────────────────────────────────────────────────────────
async function loadShifts() {
  const table = $('shift-table');
  try {
    [slots, members] = await Promise.all([
      apiFetch(`/api/events/${EVENT_ID}/slots`),
      apiFetch(`/api/events/${EVENT_ID}/members`),
    ]);

    // フィルター日付リスト更新
    const dateFilter = $('filter-date');
    const currentDateVal = dateFilter.value;
    const dates = [...new Set(slots.map(s => s.date))].sort();
    dateFilter.innerHTML = '<option value="">全ての日付</option>' +
      dates.map(d => `<option value="${d}" ${d === currentDateVal ? 'selected' : ''}>${fmtDate(d)}</option>`).join('');

    // 局フィルター
    const deptFilter = $('filter-dept');
    const currentDept = deptFilter.value;
    const depts = [...new Set(members.map(m => m.department).filter(Boolean))];
    deptFilter.innerHTML = '<option value="">全ての局</option>' +
      depts.map(d => `<option value="${d}" ${d === currentDept ? 'selected' : ''}>${d}</option>`).join('');

    renderShifts();
  } catch (err) {
    table.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

function renderShifts() {
  const table = $('shift-table');
  const dateFilter = $('filter-date').value;
  const deptFilter = $('filter-dept').value;

  let filtered = slots;
  if (dateFilter) filtered = filtered.filter(s => s.date === dateFilter);

  if (!filtered.length) {
    table.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">シフト枠がありません。「枠を追加」から作成してください。</div>`;
    return;
  }

  // 日付でグループ化
  const byDate = {};
  filtered.forEach(s => (byDate[s.date] = byDate[s.date] || []).push(s));

  table.innerHTML = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, daySlots]) => `
    <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div class="px-4 py-2.5 bg-surface border-b border-gray-100 flex items-center gap-2">
        <span class="text-sm font-bold text-gray-800">${fmtDate(date)}</span>
        <span class="text-xs text-gray-400">${daySlots.length}枠</span>
      </div>
      <div class="divide-y divide-gray-50">
        ${daySlots.map(slot => {
          const visibleAssignments = deptFilter
            ? slot.assignments.filter(a => members.find(m => m.id === a.member_id)?.department === deptFilter)
            : slot.assignments;
          return `
            <div class="px-4 py-3 shift-card" data-slot="${slot.id}">
              <div class="flex items-start gap-3">
                <div class="flex-shrink-0 text-center min-w-[56px]">
                  <div class="text-xs font-bold text-primary">${slot.start_time}</div>
                  <div class="w-px h-3 bg-gray-200 mx-auto my-0.5"></div>
                  <div class="text-xs text-gray-400">${slot.end_time}</div>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap mb-1.5">
                    ${slot.role ? `<span class="text-sm font-semibold text-gray-800">${slot.role}</span>` : ''}
                    ${slot.location ? `<span class="text-xs text-gray-400">📍 ${slot.location}</span>` : ''}
                    <span class="text-xs text-gray-400 ml-auto">必要人数: ${slot.required_count}人</span>
                  </div>
                  <div class="flex flex-wrap gap-1.5 items-center">
                    ${visibleAssignments.map(a => `
                      <span class="assign-chip ${a.status !== 'scheduled' ? a.status : ''}" title="${STATUS_LABEL[a.status]}">
                        <span>${a.member_name}</span>
                        <button class="btn-update-status text-current opacity-60 hover:opacity-100 ml-1"
                          data-aid="${a.id}" data-status="${a.status}" data-name="${a.member_name}">
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                          </svg>
                        </button>
                        <button class="btn-remove-assignment opacity-40 hover:opacity-100 ml-0.5"
                          data-aid="${a.id}">
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                          </svg>
                        </button>
                      </span>
                    `).join('')}
                    <button class="btn-assign text-xs text-primary hover:text-primary-dark transition-colors flex items-center gap-1"
                      data-slot="${slot.id}">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
                      </svg>
                      追加
                    </button>
                  </div>
                </div>
                <button class="btn-del-slot text-gray-200 hover:text-red-400 transition-colors flex-shrink-0"
                  data-slot="${slot.id}">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  // イベントリスナーを追加
  table.querySelectorAll('.btn-del-slot').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('このシフト枠を削除しますか？')) return;
      try {
        await apiFetch(`/api/events/${EVENT_ID}/slots/${btn.dataset.slot}`, { method: 'DELETE' });
        loadShifts();
        showToast('シフト枠を削除しました');
      } catch (err) { showToast(err.message, true); }
    });
  });

  table.querySelectorAll('.btn-assign').forEach(btn => {
    btn.addEventListener('click', () => openAssignModal(parseInt(btn.dataset.slot)));
  });

  table.querySelectorAll('.btn-remove-assignment').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/assignments/${btn.dataset.aid}`, { method: 'DELETE' });
        loadShifts();
      } catch (err) { showToast(err.message, true); }
    });
  });

  table.querySelectorAll('.btn-update-status').forEach(btn => {
    btn.addEventListener('click', () => {
      const statuses = ['scheduled', 'absent', 'late'];
      const current = btn.dataset.status;
      const next = statuses[(statuses.indexOf(current) + 1) % statuses.length];
      apiFetch(`/api/assignments/${btn.dataset.aid}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      }).then(() => loadShifts()).catch(err => showToast(err.message, true));
    });
  });
}

$('filter-date').addEventListener('change', renderShifts);
$('filter-dept').addEventListener('change', renderShifts);

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

// ─── Fairness ─────────────────────────────────────────────────────────────────
async function loadFairness() {
  const content = $('fairness-content');
  try {
    const stats = await apiFetch(`/api/events/${EVENT_ID}/stats`);
    const maxCount = Math.max(...stats.member_stats.map(m => m.shift_count), 1);

    content.innerHTML = stats.member_stats.length
      ? stats.member_stats.map(m => `
        <div class="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-7 h-7 rounded-full bg-primary-light flex items-center justify-center flex-shrink-0">
              <span class="text-xs font-bold text-primary">${m.name[0]}</span>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-gray-900">${m.name}</span>
                <span class="text-sm font-bold text-primary">${m.shift_count}回</span>
              </div>
              ${m.department ? `<div class="text-xs text-gray-400">${m.department}${m.grade ? ' · ' + m.grade : ''}</div>` : ''}
            </div>
          </div>
          <div class="fairness-bar">
            <div class="fairness-bar-fill" style="width: ${(m.shift_count / maxCount * 100).toFixed(1)}%"></div>
          </div>
          ${!m.submitted_availability ? '<div class="text-xs text-amber-500 mt-1">希望未提出</div>' : ''}
        </div>
      `).join('')
      : '<div class="text-center py-10 text-gray-400 text-sm">メンバーを追加してください。</div>';

    // 未提出セクション
    const unsubmitted = stats.unsubmitted || [];
    const sect = $('unsubmitted-section');
    if (unsubmitted.length) {
      sect.classList.remove('hidden');
      $('unsubmitted-list').innerHTML = unsubmitted.map(m => `
        <div class="flex items-center gap-2 px-3 py-2 bg-amber-50 rounded-lg text-sm text-amber-700">
          <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          ${m.name}
        </div>
      `).join('');
    } else {
      sect.classList.add('hidden');
    }
  } catch (err) {
    content.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${err.message}</div>`;
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
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

// ─── Copy URL ─────────────────────────────────────────────────────────────────
$('btn-copy-url').addEventListener('click', () => {
  const url = `${location.origin}/event/${EVENT_ID}/login`;
  navigator.clipboard.writeText(url).then(() => showToast('URLをコピーしました'));
});

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
    resultEl.innerHTML = `
      <p class="text-green-700 font-medium">${data.added}人を追加しました。</p>
      ${data.skipped ? `<p class="text-gray-500">スキップ: ${data.skipped}行</p>` : ''}
      ${data.errors.length ? `<p class="text-amber-600">${data.errors.join('<br/>')}</p>` : ''}
    `;
    resultEl.classList.remove('hidden');
    loadMembers();
  } catch (err) {
    errEl.textContent = 'ネットワークエラーが発生しました。';
    errEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'インポート';
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadShifts();
