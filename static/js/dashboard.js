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

// タイムアウト付き fetch（ms 後に AbortError）
// API_ROOT はテンプレートから注入（サブパスデプロイ対応）
// ローカル開発時は空文字列になる
const _API_ROOT = window.API_ROOT || '';

function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

// リトライ付き API クライアント（GET は最大3回、変更系は1回）
async function apiFetch(url, opts = {}) {
  url = _API_ROOT + url;
  const isReadOnly = !opts.method || opts.method === 'GET';
  const maxAttempts = isReadOnly ? 3 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
      // セッション切れなどで HTML が返ってきた場合を検知してリロード促進
      const ct = res.headers.get('Content-Type') || '';
      if (!ct.includes('application/json')) {
        if (res.status === 401 || res.url.includes('/login')) {
          throw new Error('セッションが切れました。ページを再読み込みしてください。');
        }
        throw new Error(`サーバーエラー (${res.status})。ページを再読み込みしてください。`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'エラーが発生しました');
      return data;
    } catch (err) {
      lastErr = err;
      if (!isReadOnly || attempt === maxAttempts) break;
      // 指数バックオフ: 500ms → 1500ms
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  // ネットワーク切断 or タイムアウト時は分かりやすいメッセージに変換
  if (lastErr?.name === 'AbortError') throw new Error('通信がタイムアウトしました。Wi-Fi環境を確認してください。');
  if (!navigator.onLine) throw new Error('オフラインです。接続を確認してください。');
  throw lastErr;
}

function showToast(msg, isError = false) {
  // 既存トーストを上にずらす
  document.querySelectorAll('.cs-toast').forEach((t, i) => {
    t.style.top = `${(i + 1) * 60 + 16}px`;
  });

  const el = document.createElement('div');
  el.className = 'cs-toast fixed right-4 z-[100] flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-xl text-sm font-medium text-white transition-all duration-300 translate-x-full opacity-0';
  el.style.top = '16px';
  el.style.minWidth = '220px';
  el.style.maxWidth = '320px';

  const icon = isError
    ? `<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg>`
    : `<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;

  el.innerHTML = `
    <div class="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${isError ? 'bg-white/20' : 'bg-white/20'}">${icon}</div>
    <span class="flex-1 leading-snug">${msg}</span>
    <div class="w-1 self-stretch rounded-full bg-white/30 flex-shrink-0 overflow-hidden">
      <div class="progress-bar w-full bg-white/60 transition-none" style="height:100%"></div>
    </div>`;
  el.style.background = isError
    ? 'linear-gradient(135deg,#ef4444,#dc2626)'
    : 'linear-gradient(135deg,#22c55e,#16a34a)';

  document.body.appendChild(el);

  // スライドイン
  requestAnimationFrame(() => {
    el.classList.remove('translate-x-full', 'opacity-0');
    el.classList.add('translate-x-0', 'opacity-100');
  });

  // プログレスバーで残り時間を表示
  const bar = el.querySelector('.progress-bar');
  bar.style.transition = 'height 3s linear';
  requestAnimationFrame(() => { bar.style.height = '0%'; });

  const timer = setTimeout(() => {
    el.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => el.remove(), 300);
  }, 3000);

  // クリックで即閉じ
  el.addEventListener('click', () => {
    clearTimeout(timer);
    el.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => el.remove(), 300);
  });
}

// ─── グローバルローディングオーバーレイ ──────────────────────────────────────
let _overlayEl = null;
let _overlayCount = 0;

function showOverlay(msg = '登録中…') {
  _overlayCount++;
  if (_overlayEl) {
    _overlayEl.querySelector('.overlay-msg').textContent = msg;
    return;
  }
  _overlayEl = document.createElement('div');
  _overlayEl.className = 'fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm';
  _overlayEl.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl px-10 py-8 flex flex-col items-center gap-4 min-w-[180px]">
      <div class="relative w-14 h-14">
        <svg class="w-14 h-14 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"/>
          <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
        </svg>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-5 h-5 bg-primary rounded-full opacity-30 animate-ping"></div>
        </div>
      </div>
      <span class="overlay-msg text-sm font-semibold text-gray-700 tracking-wide">${msg}</span>
    </div>`;
  document.body.appendChild(_overlayEl);
}

function hideOverlay() {
  _overlayCount = Math.max(0, _overlayCount - 1);
  if (_overlayCount > 0) return;
  if (_overlayEl) { _overlayEl.remove(); _overlayEl = null; }
}

/**
 * ボタンを無効化しスピナーを表示しながら非同期処理を実行する。
 * 処理完了後にボタンを元の状態に戻す（二重送信防止）。
 */
// 処理中フラグをボタンの data 属性で管理（disabled の上書き競合を防ぐ）
async function withLoading(btn, fn) {
  if (btn.dataset.loading === '1') return;  // 既に処理中なら完全無視
  const originalHTML = btn.innerHTML;
  btn.dataset.loading = '1';
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `
    <svg class="animate-spin w-4 h-4 inline-block mr-1.5 -mt-0.5" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>処理中…`;
  try {
    await fn();
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    delete btn.dataset.loading;
  }
}

// シフト登録専用の排他フラグ（withLoading より上位でブロック）
let _shiftSubmitting = false;

// 楽観的UI用の一時ID（負の整数を使う）
let _tempIdSeq = -1;
function _nextTempId() { return _tempIdSeq--; }

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
    window.location.href = _API_ROOT + `/events/${data.id}`;
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
      <!-- メンバーリスト（学年ごとにグループ化） -->
      <div class="dept-body ${collapsed ? 'hidden' : ''}">
        ${(() => {
          // 学年でグループ化（学年降順 → 未設定は末尾）
          const gradeGroups = [];
          mems.forEach(m => {
            const g = m.grade || '';
            const last = gradeGroups[gradeGroups.length - 1];
            if (last && last.grade === g) {
              last.members.push(m);
            } else {
              gradeGroups.push({ grade: g, members: [m] });
            }
          });

          return gradeGroups.map((group, gi) => `
            <!-- 学年ヘッダー（境界線 + ラベル） -->
            <div class="${gi > 0 ? 'border-t-2 border-gray-200' : ''}">
              ${group.grade ? `
                <div class="flex items-center gap-2 px-4 pt-2 pb-1">
                  <span class="text-[10px] font-bold text-gray-400 tracking-wide">${group.grade}</span>
                  <div class="flex-1 h-px bg-gray-100"></div>
                  <span class="text-[10px] text-gray-300">${group.members.length}人</span>
                </div>
              ` : ''}
              <div class="divide-y divide-gray-100">
                ${group.members.map(m => `
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
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span class="text-sm font-medium text-gray-900 truncate">${m.name}</span>
                        ${m.grade ? `<span class="text-xs text-gray-400 flex-shrink-0">${m.grade}</span>` : ''}
                      </div>
                      <div class="flex items-center gap-2 flex-wrap">
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
            </div>
          `).join('');
        })()}
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
  const body = {
    name:       $('member-name').value.trim(),
    email:      $('member-email').value.trim(),
    grade:      $('member-grade').value.trim(),
    department: $('member-dept').value.trim(),
  };
  if (!body.name) return;

  // 楽観的追加
  const tempId = _nextTempId();
  const tempMember = { id: tempId, ...body, is_leader: false, _pending: true };
  members.push(tempMember);
  renderMemberList();
  modalMember.classList.add('hidden');
  $('form-add-member').reset();
  showToast('メンバーを追加しました');

  // バックグラウンド保存
  try {
    const created = await apiFetch(`/api/events/${EVENT_ID}/members`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const idx = members.findIndex(m => m.id === tempId);
    if (idx !== -1) members[idx] = created;
    renderMemberList();
  } catch (err) {
    members = members.filter(m => m.id !== tempId);
    renderMemberList();
    showToast('メンバーの追加に失敗しました。', true);
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
let copyTargetIds = new Set(); // コピー先メンバーIDセット
let bulkDeleteMode = false;   // 一括削除モード
let bulkDeleteSelected = new Set(); // 選択中の assignmentId
// day -> Set<memberId>  全日欠席
const absentMemberDays = new Map();
// day -> Map<memberId, Set<col>>  範囲欠席
const absentRangeCells = new Map();

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

// 欠席レコード1件をローカル構造に反映（loadAbsences / loadShifts 両方から呼ぶ）
function import_absence_record(rec) {
  if (rec.is_full_day) {
    if (!absentMemberDays.has(rec.date)) absentMemberDays.set(rec.date, new Set());
    absentMemberDays.get(rec.date).add(rec.member_id);
  } else if (rec.absent_times && rec.absent_times.length > 0) {
    if (!absentRangeCells.has(rec.date)) absentRangeCells.set(rec.date, new Map());
    absentRangeCells.get(rec.date).set(rec.member_id, new Set(rec.absent_times));
  }
}

async function loadAbsences() {
  try {
    const data = await apiFetch(`/api/events/${EVENT_ID}/absences`);
    absentMemberDays.clear();
    absentRangeCells.clear();
    data.forEach(import_absence_record);
  } catch (e) {
    console.error('欠席データ読み込み失敗', e);
  }
}

async function saveAbsence(day, memberId) {
  const isFullDay = (absentMemberDays.get(day) || new Set()).has(memberId);
  const rmap = absentRangeCells.get(day);
  const rangeTimes = isFullDay ? [] : [...(rmap?.get(memberId) || [])];
  try {
    if (!isFullDay && rangeTimes.length === 0) {
      await fetch(_API_ROOT + `/api/events/${EVENT_ID}/absences`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId, date: day }),
      });
    } else {
      await fetch(_API_ROOT + `/api/events/${EVENT_ID}/absences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId, date: day, is_full_day: isFullDay, absent_times: rangeTimes }),
      });
    }
  } catch (e) {
    console.error('欠席保存失敗', e);
  }
}

function showBoardSkeleton() {
  $('shift-board').innerHTML = `
    <div class="p-6 animate-pulse space-y-3">
      <div class="h-8 bg-gray-100 rounded-lg w-full"></div>
      ${Array.from({length: 6}, () =>
        `<div class="flex gap-2">
          <div class="h-7 bg-gray-100 rounded w-24 flex-shrink-0"></div>
          <div class="h-7 bg-gray-50 rounded flex-1"></div>
        </div>`
      ).join('')}
    </div>`;
}

async function loadShifts() {
  showBoardSkeleton();
  try {
    // 1リクエストで全データ取得（slots + members + jobs + absences）
    const data = await apiFetch(`/api/events/${EVENT_ID}/shift-data`);
    slots   = data.slots;
    members = data.members;
    jobs    = data.jobs;

    // absences をローカル構造に展開
    absentMemberDays.clear();
    absentRangeCells.clear();
    data.absences.forEach(rec => {
      import_absence_record(rec);
    });

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
    const dateStr = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const customLabel = DAY_LABELS[date] || '';
    const active = date === currentDay;
    const editBtn = active ? `
      <span class="day-tab-edit ml-1 opacity-60 hover:opacity-100 transition-opacity" data-date="${date}" title="日程名を編集">
        <svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-1.414A2 2 0 019.414 13z"/>
        </svg>
      </span>` : '';
    const inner = customLabel
      ? `<span class="flex flex-col items-start leading-tight">
           <span>${customLabel}${editBtn}</span>
           <span class="${active ? 'opacity-60' : 'text-gray-400'}" style="font-size:9px;font-weight:400">${dateStr}</span>
         </span>`
      : `<span>${dateStr}${editBtn}</span>`;
    return `<button class="board-day-tab flex-shrink-0 flex items-center px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
      ${active ? 'bg-primary text-white' : 'text-gray-600 hover:bg-surface border border-transparent hover:border-gray-200'}"
      data-date="${date}">${inner}</button>`;
  }).join('');

  container.querySelectorAll('.board-day-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.day-tab-edit')) return; // 編集ボタンはこちらで処理
      currentDay = btn.dataset.date;
      boardSelectStart = null; boardHoverTime = null;
      updateBoardHint(); renderDayTabs(); renderShiftBoard();
      if (!$('workload-panel').classList.contains('hidden')) renderWorkloadPanel();
      if (!$('job-dist-panel').classList.contains('hidden')) renderJobDistPanel();
    });
  });

  container.querySelectorAll('.day-tab-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDayLabelEditor(btn.dataset.date);
    });
  });
}

function openDayLabelEditor(date) {
  // 既存のポップオーバーを閉じる
  document.getElementById('day-label-popover')?.remove();

  const tabEl = document.querySelector(`.board-day-tab[data-date="${date}"]`);
  if (!tabEl) return;

  const d = new Date(date + 'T00:00:00');
  const dateStr = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const current = DAY_LABELS[date] || '';

  const pop = document.createElement('div');
  pop.id = 'day-label-popover';
  pop.className = 'fixed z-[90] bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-64';

  const rect = tabEl.getBoundingClientRect();
  pop.style.top  = (rect.bottom + 6) + 'px';
  pop.style.left = Math.min(rect.left, window.innerWidth - 272) + 'px';

  pop.innerHTML = `
    <p class="text-xs text-gray-400 mb-1.5">${dateStr} の日程名</p>
    <input id="day-label-input" type="text" value="${current}"
      placeholder="例: 大学祭1日目"
      maxlength="30"
      class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary mb-2"/>
    <div class="flex gap-2">
      <button id="day-label-clear" class="flex-1 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">クリア</button>
      <button id="day-label-save" class="flex-1 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary-dark transition-colors">保存</button>
    </div>`;
  document.body.appendChild(pop);

  const input = document.getElementById('day-label-input');
  input.focus();
  input.select();

  const saveDayLabel = async (value) => {
    const newLabels = { ...DAY_LABELS };
    if (value.trim()) {
      newLabels[date] = value.trim();
    } else {
      delete newLabels[date];
    }
    try {
      await apiFetch(`/api/events/${EVENT_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ day_labels: newLabels }),
      });
      DAY_LABELS = newLabels;
      pop.remove();
      renderDayTabs();
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('day-label-save').addEventListener('click', () => saveDayLabel(input.value));
  document.getElementById('day-label-clear').addEventListener('click', () => saveDayLabel(''));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveDayLabel(input.value);
    if (e.key === 'Escape') pop.remove();
  });

  // ポップオーバー外クリックで閉じる
  setTimeout(() => {
    const onOutside = (e) => {
      if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', onOutside); }
    };
    document.addEventListener('click', onOutside);
  }, 0);
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
    const spanPx = Math.round((endM - startM) / intervalMin) * cw;
    slot.assignments.forEach(a => {
      cols.forEach((col, i) => {
        const colM = timeToMin(col);
        if (colM >= startM && colM < endM) {
          const prevM = i > 0 ? timeToMin(cols[i - 1]) : -1;
          cellMap.set(`${a.member_id}|${col}`, {
            slotId: slot.id, role: slot.role,
            assignmentId: a.id, status: a.status,
            isFirst: prevM < startM,
            spanPx,
            jobColor,
            pending: !!slot._pending,
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

  // 欠席状態を取得
  const dayAbsentSet = absentMemberDays.get(currentDay) || new Set();
  const dayRangeMap  = absentRangeCells.get(currentDay) || new Map();

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

      const isFullAbsent = dayAbsentSet.has(m.id);
      const memberRangeSet = dayRangeMap.get(m.id);

      const cellsHtml = cols.map(col => {
        const key = `${m.id}|${col}`;
        const cell = cellMap.get(key);
        const cb = colBorder(col);

        // 欠席セル（全日 or 範囲）
        if (isFullAbsent || (memberRangeSet && memberRangeSet.has(col))) {
          return `<td style="min-width:${cw}px;width:${cw}px;background:#1a1a1a"
            class="board-absent-cell h-10 cursor-pointer ${cb}"
            data-member="${m.id}" data-time="${col}"></td>`;
        }

        if (cell) {
          const isSelected = bulkDeleteSelected.has(cell.assignmentId);
          let bg = isSelected ? 'rgba(239,68,68,0.35)' : slotColor(cell.jobColor, cell.status);
          if (!isSelected && m.is_leader) bg = slotColor(cell.jobColor === '#4DA3FF' ? '#EAB308' : cell.jobColor, cell.status);
          const border = cell.isFirst
            ? `border-left: 3px solid ${isSelected ? '#EF4444' : cell.jobColor};`
            : '';
          const roleText = cell.isFirst && cell.role
            ? `<span class="absolute top-0 left-0 flex items-center px-1 text-[9px] font-semibold whitespace-nowrap pointer-events-none z-[1]" style="height:100%;width:${cell.spanPx}px;color:${isSelected ? '#EF4444' : cell.jobColor}">${cell.role}</span>`
            : '';
          const selectedRing = isSelected ? 'outline:2px solid #EF4444;outline-offset:-2px;' : '';
          const pendingCls = cell.pending ? 'animate-pulse opacity-60' : '';
          return `<td style="min-width:${cw}px;width:${cw}px;background:${bg};${border}${selectedRing}"
            class="board-cell-occupied relative h-10 cursor-pointer border-b border-b-white/30 ${pendingCls} ${cb}"
            data-slot="${cell.slotId}" data-aid="${cell.assignmentId}" data-member="${m.id}" data-time="${col}">${roleText}</td>`;
        }
        return `<td style="min-width:${cw}px;width:${cw}px"
          class="board-cell h-10 cursor-pointer border-b border-b-gray-50 ${isCopyTgt ? 'hover:bg-green-100' : 'hover:bg-primary/10'} ${cb}"
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
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 0;color:${isCopySrc ? '#6D28D9' : '#1f2937'};font-size:12px;font-weight:600">
                ${m.name}${m.grade ? `<span style="margin-left:4px;font-size:9px;font-weight:400;color:#9ca3af">${m.grade}</span>` : ''}
              </div>
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
            <button class="btn-member-absent flex-shrink-0 transition-colors ${isFullAbsent ? 'text-white' : 'text-gray-300 hover:text-gray-700'}"
              data-mid="${m.id}" title="全日欠席"
              style="${isFullAbsent ? 'background:#1a1a1a;border-radius:3px;padding:1px 2px' : ''}">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
              </svg>
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

  // 欠席セルクリック（クリックで解除）
  board.querySelectorAll('.board-absent-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const mid = parseInt(cell.dataset.member);
      const day = currentDay;
      const set = absentMemberDays.get(day);
      if (set && set.has(mid)) {
        // 全日欠席 → 解除
        set.delete(mid);
        if (set.size === 0) absentMemberDays.delete(day);
      } else {
        // 範囲欠席 → そのセルだけ解除
        const rmap = absentRangeCells.get(day);
        if (rmap) {
          const rset = rmap.get(mid);
          if (rset) {
            rset.delete(cell.dataset.time);
            if (rset.size === 0) rmap.delete(mid);
            if (rmap.size === 0) absentRangeCells.delete(day);
          }
        }
      }
      renderShiftBoard();
      saveAbsence(day, mid);
    });
  });

  // ⊘ 欠席ボタン（全日トグル）
  board.querySelectorAll('.btn-member-absent').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mid = parseInt(btn.dataset.mid);
      const day = currentDay;
      if (!absentMemberDays.has(day)) absentMemberDays.set(day, new Set());
      const set = absentMemberDays.get(day);
      if (set.has(mid)) {
        set.delete(mid);
        if (set.size === 0) absentMemberDays.delete(day);
      } else {
        set.add(mid);
        // 範囲欠席があれば削除（全日に統合）
        const rmap = absentRangeCells.get(day);
        if (rmap) { rmap.delete(mid); if (rmap.size === 0) absentRangeCells.delete(day); }
      }
      renderShiftBoard();
      saveAbsence(day, mid);
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
    td.addEventListener('click', () => {
      if (!isCopyMode) return;
      const targetMid = parseInt(td.dataset.mid);
      if (targetMid !== copySourceMemberId) handleBoardCopyClick(targetMid);
    });
  });

  updateBoardHighlight();
}



function clearBoardSearch() {
  if (!boardSearchQuery) return;
  const el = $('board-search');
  if (el) el.value = '';
  applyBoardSearch('');
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
    if ($('copy-target-input')) $('copy-target-input').value = '';
    $('copy-target-dropdown')?.classList.add('hidden');
    copyTargetIds.clear();
    renderCopyTargetChips();
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
    closeCopyTargetDropdown();
    await loadShifts();
    const skippedMsg = res.skipped ? `・${res.skipped}件は時間帯重複のためスキップ` : '';
    showToast(`「${src?.name || ''}」→「${tgt?.name || ''}」にシフトをコピーしました（${res.copied}件${skippedMsg}）`);
  } catch (err) {
    showToast(err.message, true);
  }
}

function openBoardSlotModal(memberId, startTime, endTime) {
  const m = members.find(x => x.id === memberId);
  pendingBoardSlot = { memberId, startTime, endTime };
  editingSlot = null;

  $('board-slot-title').textContent = 'シフトを登録';
  $('btn-board-slot-delete').classList.add('hidden');
  $('btn-board-slot-submit').textContent = '登録する';

  $('board-slot-info').innerHTML = `
    <div class="flex justify-between text-xs"><span class="text-gray-500">メンバー</span><span class="font-semibold text-gray-800">${m?.name || ''}</span></div>
    <div class="flex justify-between text-xs"><span class="text-gray-500">日付</span><span class="font-semibold text-gray-800">${fmtDate(currentDay)}</span></div>
    <div class="flex justify-between text-xs"><span class="text-gray-500">時間</span><span class="font-semibold text-gray-800">${startTime} 〜 ${endTime}</span></div>
    <button id="btn-absent-range"
      class="mt-2 w-full py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors flex items-center justify-center gap-1">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
      </svg>
      この時間帯を欠席にする
    </button>`;

  // 欠席ボタンのイベント
  document.getElementById('btn-absent-range')?.addEventListener('click', () => {
    const { memberId, startTime: st, endTime: et } = pendingBoardSlot;
    const day = currentDay;
    if (!absentRangeCells.has(day)) absentRangeCells.set(day, new Map());
    const rmap = absentRangeCells.get(day);
    if (!rmap.has(memberId)) rmap.set(memberId, new Set());
    const rset = rmap.get(memberId);
    const cols = buildTimeCols(intervalMin);
    const startM = timeToMin(st), endM = timeToMin(et);
    cols.forEach(col => {
      if (timeToMin(col) >= startM && timeToMin(col) < endM) rset.add(col);
    });
    closeBoardSlotModal();
    renderShiftBoard();
    saveAbsence(day, memberId);
  });

  // 前回の範囲削除ボタンが残っていれば除去
  $('btn-range-delete-trigger')?.remove();

  populateJobSelect(null, m?.id || null);
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
// memberId: 担当メンバーID（局制限チェック用）
function populateJobSelect(currentJobTypeId, memberId = null) {
  const sel = $('board-slot-job');
  const member = memberId ? members.find(m => m.id === memberId) : null;
  sel.innerHTML = '<option value="">仕事を選択してください...</option>' +
    jobs.map(j => {
      const countStr = j.requirements?.interval ? `${j.requirements.interval}分ごと設定` : `目安 ${j.required_count}人`;
      const allowed = j.allowed_departments || [];
      const restricted = allowed.length > 0 && member && !allowed.includes(member.department);
      const label = restricted ? `⛔ ${j.title}（${countStr}）` : `${j.title}（${countStr}）`;
      return `<option value="${j.id}" ${j.id === currentJobTypeId ? 'selected' : ''} ${restricted ? 'disabled' : ''}>${label}</option>`;
    }).join('');

  const updateDetail = () => {
    const job = jobs.find(j => j.id === parseInt(sel.value));
    const detail = $('board-slot-job-detail');
    if (job) {
      const allowed = job.allowed_departments || [];
      const restricted = allowed.length > 0 && member && !allowed.includes(member.department);
      const deptLine = allowed.length > 0
        ? (restricted
            ? `<div class="text-red-500 font-medium">⛔ ${allowed.join('・')}以外は担当不可</div>`
            : `<div class="text-blue-600">担当局: ${allowed.join('・')}</div>`)
        : '';
      detail.innerHTML = [
        `<div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${job.color}"></span><span class="font-semibold" style="color:${job.color}">${job.title}</span></div>`,
        deptLine,
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

  populateJobSelect(slot.job_type_id, member?.id || null);
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
  copyTargetIds.clear();
  closeCopyTargetDropdown();
  renderCopyTargetChips();
  updateCopyExecuteBtn();
  updateBoardHint();
  renderShiftBoard();
});

// ─── コピー先名前入力（複数選択対応）────────────────────────────────────────
function closeCopyTargetDropdown() {
  $('copy-target-dropdown')?.classList.add('hidden');
  if ($('copy-target-input')) $('copy-target-input').value = '';
}

function updateCopyExecuteBtn() {
  const btn = $('btn-execute-copy');
  if (btn) btn.disabled = copyTargetIds.size === 0;
}

function renderCopyTargetChips() {
  const area = $('copy-targets-area');
  if (!area) return;
  if (copyTargetIds.size === 0) {
    area.classList.add('hidden');
    area.innerHTML = '';
    return;
  }
  area.classList.remove('hidden');
  area.innerHTML = [...copyTargetIds].map(mid => {
    const m = members.find(x => x.id === mid);
    if (!m) return '';
    return `
      <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-purple-200 text-purple-700 rounded-full text-xs font-medium">
        ${m.name}
        <button class="copy-chip-remove w-3.5 h-3.5 flex items-center justify-center text-purple-400 hover:text-purple-700 transition-colors" data-mid="${mid}">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </span>`;
  }).join('');
  area.querySelectorAll('.copy-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      copyTargetIds.delete(parseInt(btn.dataset.mid));
      renderCopyTargetChips();
      updateCopyExecuteBtn();
    });
  });
}

function addCopyTarget(mid) {
  if (mid === copySourceMemberId || copyTargetIds.has(mid)) return;
  copyTargetIds.add(mid);
  closeCopyTargetDropdown();
  renderCopyTargetChips();
  updateCopyExecuteBtn();
  $('copy-target-input')?.focus();
}

async function executeCopyToTargets() {
  if (copySourceMemberId === null || copyTargetIds.size === 0) return;
  const src = members.find(x => x.id === copySourceMemberId);
  let totalCopied = 0;
  const names = [];
  for (const targetMid of copyTargetIds) {
    const tgt = members.find(x => x.id === targetMid);
    try {
      const res = await apiFetch(`/api/events/${EVENT_ID}/members/${copySourceMemberId}/copy-to/${targetMid}`, {
        method: 'POST',
      });
      totalCopied += res.copied || 0;
      names.push(tgt?.name || '');
    } catch (err) {
      showToast(`${tgt?.name || ''}: ${err.message}`, true);
    }
  }
  copySourceMemberId = null;
  copyTargetIds.clear();
  closeCopyTargetDropdown();
  renderCopyTargetChips();
  updateCopyExecuteBtn();
  updateBoardHint();
  await loadShifts();
  if (names.length > 0) showToast(`「${src?.name || ''}」→「${names.join('・')}」にコピーしました（${totalCopied}件）` + (totalCopied === 0 ? '・時間帯重複のためすべてスキップされました' : ''));
}

$('copy-target-input').addEventListener('input', function() {
  const q = this.value.trim();
  const dropdown = $('copy-target-dropdown');
  if (!q || copySourceMemberId === null) {
    dropdown.classList.add('hidden');
    return;
  }
  const matches = members.filter(m =>
    m.id !== copySourceMemberId && !copyTargetIds.has(m.id) && m.name.includes(q)
  );
  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="px-3 py-2 text-xs text-gray-400">該当するメンバーがいません</div>';
    dropdown.classList.remove('hidden');
    return;
  }
  dropdown.innerHTML = matches.map(m => `
    <button type="button" class="copy-target-item w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-purple-50 transition-colors" data-mid="${m.id}">
      <span class="w-5 h-5 rounded-full bg-purple-100 flex items-center justify-center font-bold text-purple-600 flex-shrink-0">${m.name[0]}</span>
      <span class="font-medium text-gray-800">${m.name}</span>
      ${m.department ? `<span class="text-gray-400">${m.department}</span>` : ''}
      <span class="ml-auto text-purple-400 text-[10px]">追加</span>
    </button>`).join('');
  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.copy-target-item').forEach(btn => {
    btn.addEventListener('click', () => addCopyTarget(parseInt(btn.dataset.mid)));
  });
});

$('copy-target-input').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeCopyTargetDropdown();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const dropdown = $('copy-target-dropdown');
    // ドロップダウンの先頭候補を追加
    const first = dropdown?.querySelector('.copy-target-item');
    if (first) {
      addCopyTarget(parseInt(first.dataset.mid));
    } else if (copyTargetIds.size > 0 && !this.value.trim()) {
      // 入力が空でターゲットがある → コピー実行
      executeCopyToTargets();
    }
  }
});

$('btn-execute-copy').addEventListener('click', () => executeCopyToTargets());

// ドロップダウン外クリックで閉じる
document.addEventListener('click', e => {
  if (!$('copy-target-input')?.contains(e.target) && !$('copy-target-dropdown')?.contains(e.target)) {
    $('copy-target-dropdown')?.classList.add('hidden');
  }
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
  copyTargetIds.clear();
  closeCopyTargetDropdown();
  renderCopyTargetChips();
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

$('btn-board-slot-submit').addEventListener('click', async function() {
  if (_shiftSubmitting) return;
  const errEl = $('board-slot-error');
  errEl.classList.add('hidden');

  const jobId = parseInt($('board-slot-job').value);
  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    errEl.textContent = '仕事を選択してください。';
    errEl.classList.remove('hidden');
    return;
  }

  _shiftSubmitting = true;

  // ── 編集モード：既存スロットの仕事を差し替え ────────────────────
  if (editingSlot) {
    const { slotId, assignmentId, memberId } = editingSlot;
    const oldSlot = slots.find(s => s.id === slotId);
    if (!oldSlot) { _shiftSubmitting = false; return; }

    // 旧スロットに残る他メンバーのアサインメント
    const otherAssignments = oldSlot.assignments.filter(a => a.id !== assignmentId);
    const m = members.find(x => x.id === memberId);

    // ① 楽観的UI：
    //   - 旧スロットから編集メンバーだけ除く（他メンバーのアサインは守る）
    //   - 仮の新スロットを追加して即表示
    const tempSlotId  = _nextTempId();
    const tempAssignId = _nextTempId();
    const optimisticNewSlot = {
      id: tempSlotId,
      event_id: EVENT_ID,
      job_type_id: job.id,
      date: oldSlot.date,
      start_time: oldSlot.start_time,
      end_time: oldSlot.end_time,
      role: job.title,
      location: job.location || '',
      required_count: job.required_count,
      note: null,
      assignments: [{
        id: tempAssignId,
        slot_id: tempSlotId,
        member_id: memberId,
        member_name: m?.name || '',
        member_department: m?.department || '',
        status: 'scheduled',
        note: null,
        reported_at: null,
      }],
      _pending: true,
    };

    if (otherAssignments.length > 0) {
      // 旧スロットに他メンバーが残る → アサイン一覧だけ更新して保持
      slots = slots.map(s =>
        s.id === slotId ? { ...oldSlot, assignments: otherAssignments } : s
      );
    } else {
      // 旧スロットが空になる → ローカルから除去
      slots = slots.filter(s => s.id !== slotId);
    }
    slots.push(optimisticNewSlot);
    closeBoardSlotModal();
    renderShiftBoard();

    // ② バックグラウンドで1リクエストに統合して送信
    try {
      const newSlot = await apiFetch(`/api/events/${EVENT_ID}/slot-with-assignment/replace`, {
        method: 'POST',
        body: JSON.stringify({
          old_assignment_id: assignmentId,
          old_slot_id: slotId,
          date: oldSlot.date,
          start_time: oldSlot.start_time,
          end_time: oldSlot.end_time,
          role: job.title,
          location: job.location || '',
          required_count: job.required_count,
          job_type_id: job.id,
          member_id: memberId,
        }),
      });
      // ③ 仮スロットを実スロットに差し替え
      //   実スロットIDが既に slots にある（既存スロットを再利用した場合）なら
      //   そちらを上書きマージし、tempスロットは除去
      slots = slots.filter(s => s.id !== tempSlotId);
      const existingReal = slots.find(s => s.id === newSlot.id);
      if (existingReal) {
        slots = slots.map(s => s.id === newSlot.id ? newSlot : s);
      } else {
        slots.push(newSlot);
      }
      renderShiftBoard();
      showToast('シフトを変更しました');
    } catch (err) {
      // ④ 失敗時：仮スロット除去 & 旧スロットを元に戻す
      slots = slots.filter(s => s.id !== tempSlotId);
      if (!slots.find(s => s.id === slotId)) slots.push(oldSlot);
      renderShiftBoard();
      showToast(err.message, true);
    }
    _shiftSubmitting = false;
    return;
  }

  // ── 新規登録モード ──────────────────────────────────────────────
  if (!pendingBoardSlot) { _shiftSubmitting = false; return; }
  const { memberId, startTime, endTime } = pendingBoardSlot;

  // ① 楽観的UI：仮スロットを即時追加してボードに表示
  const tempSlotId = _nextTempId();
  const tempAssignId = _nextTempId();
  const m = members.find(x => x.id === memberId);
  const tempSlot = {
    id: tempSlotId,
    event_id: EVENT_ID,
    job_type_id: job.id,
    date: currentDay,
    start_time: startTime,
    end_time: endTime,
    role: job.title,
    location: job.location || '',
    required_count: job.required_count,
    note: null,
    assignments: [{
      id: tempAssignId,
      slot_id: tempSlotId,
      member_id: memberId,
      member_name: m?.name || '',
      member_department: m?.department || '',
      status: 'scheduled',
      note: null,
      reported_at: null,
    }],
    _pending: true,
  };
  slots.push(tempSlot);
  closeBoardSlotModal();
  renderShiftBoard();

  // ② バックグラウンドで1リクエストに統合して送信
  try {
    const realSlot = await apiFetch(`/api/events/${EVENT_ID}/slot-with-assignment`, {
      method: 'POST',
      body: JSON.stringify({
        date: currentDay,
        start_time: startTime,
        end_time: endTime,
        role: job.title,
        location: job.location || '',
        required_count: job.required_count,
        job_type_id: job.id,
        member_id: memberId,
      }),
    });
    // ③ 仮データを実データに差し替え（ほぼ視覚変化なし）
    slots = slots.filter(s => s.id !== tempSlotId);
    slots.push(realSlot);
    renderShiftBoard();
    showToast('シフトを登録しました');
  } catch (err) {
    // ④ 失敗時は仮スロットを削除してロールバック
    slots = slots.filter(s => s.id !== tempSlotId);
    renderShiftBoard();
    showToast(err.message, true);
  }
  _shiftSubmitting = false;
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
    <div class="job-card bg-white rounded-xl border border-gray-100 p-4 flex items-start gap-3 group cursor-pointer hover:border-gray-300 hover:shadow-sm transition-all"
      data-jid="${j.id}">
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
            ${j.requirements?.interval ? `${j.requirements.interval}分ごとに設定` : `目安 ${j.required_count}人`}
          </span>
          ${(j.allowed_departments || []).length > 0 ? `<span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">${j.allowed_departments.join('・')}のみ</span>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 flex-shrink-0">
        <button class="btn-edit-job text-gray-300 hover:text-primary transition-colors"
          data-jid="${j.id}" title="編集">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
          </svg>
        </button>
        <button class="btn-del-job text-gray-200 hover:text-red-400 transition-colors"
          data-jid="${j.id}" title="削除">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');

  // カード全体クリック → 編集モーダル
  list.querySelectorAll('.job-card').forEach(card => {
    card.addEventListener('click', () => {
      const job = jobs.find(j => j.id === parseInt(card.dataset.jid));
      if (job) openJobModal(job);
    });
  });

  list.querySelectorAll('.btn-del-job').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('この仕事を削除しますか？')) return;
      try {
        await apiFetch(`/api/events/${EVENT_ID}/jobs/${btn.dataset.jid}`, { method: 'DELETE' });
        await loadJobs();
        showToast('仕事を削除しました');
      } catch (err) { showToast(err.message, true); }
    });
  });

  list.querySelectorAll('.btn-edit-job').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const job = jobs.find(j => j.id === parseInt(btn.dataset.jid));
      if (job) openJobModal(job);
    });
  });

  list.querySelectorAll('.btn-job-color').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPopup(btn, parseInt(btn.dataset.jid));
    });
  });
}

// ─── Job Modal ────────────────────────────────────────────────────────────────
const modalAddJob = $('modal-add-job');
let editingJobId = null;
let jobReqIntervalMin = null; // null=全時間同じ、数値=分間隔

function buildJobTimeCols(intervalMin) {
  const cols = [];
  for (let h = BOARD_START_H; h < BOARD_END_H; h++) {
    for (let m = 0; m < 60; m += intervalMin) {
      cols.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return cols;
}

function setJobReqInterval(min, existingCounts = {}) {
  jobReqIntervalMin = min ? parseInt(min) : null;
  document.querySelectorAll('.job-req-interval').forEach(btn => {
    const active = String(btn.dataset.min) === String(min ?? '');
    btn.style.background = active ? '#4DA3FF' : '';
    btn.style.color      = active ? '#fff' : '';
    btn.style.borderColor = active ? '#4DA3FF' : '';
  });
  const uniform = $('job-req-uniform');
  const timed   = $('job-req-timed');
  if (!jobReqIntervalMin) {
    uniform.classList.remove('hidden');
    timed.classList.add('hidden');
  } else {
    uniform.classList.add('hidden');
    timed.classList.remove('hidden');
    const cols = buildJobTimeCols(jobReqIntervalMin);
    $('job-req-timed-inputs').innerHTML = cols.map(t => `
      <div class="flex items-center gap-1.5 py-0.5">
        <span class="text-[11px] text-gray-500 w-10 flex-shrink-0">${t}</span>
        <input type="number" min="0" max="99" value="${existingCounts[t] ?? 0}"
          class="w-14 px-1.5 py-1 border border-gray-200 rounded text-xs text-center focus:outline-none focus:border-primary"
          data-req-time="${t}"/>
        <span class="text-[11px] text-gray-400">人</span>
      </div>`).join('');

    // 一括適用ボタン
    $('job-req-bulk').value = '';
    $('btn-job-req-bulk').onclick = () => {
      const v = parseInt($('job-req-bulk').value);
      if (isNaN(v) || v < 0) return;
      document.querySelectorAll('[data-req-time]').forEach(inp => { inp.value = v; });
    };
  }
}

function openJobModal(job = null) {
  editingJobId = job ? job.id : null;
  $('modal-job-title').textContent = job ? '仕事を編集' : '仕事を追加';
  $('btn-job-submit').textContent  = job ? '保存する' : '追加する';
  $('job-title').value       = job ? (job.title || '') : '';
  $('job-description').value = job ? (job.description || '') : '';
  $('job-location').value    = job ? (job.location || '') : '';
  $('job-error').classList.add('hidden');

  const req = job?.requirements;
  if (req && req.interval) {
    setJobReqInterval(req.interval, req.counts || {});
  } else {
    setJobReqInterval(null);
    $('job-count').value = job ? (job.required_count ?? 1) : 1;
  }

  // 担当局の制限UI
  const allowedDepts = job?.allowed_departments || [];
  const deptRestrict = $('job-dept-restrict');
  const deptList = $('job-dept-list');
  deptRestrict.checked = allowedDepts.length > 0;
  deptList.classList.toggle('hidden', allowedDepts.length === 0);

  // 局一覧をメンバーから収集
  const allDepts = [...new Set(members.map(m => m.department).filter(Boolean))].sort();
  deptList.innerHTML = allDepts.map(dept =>
    `<label class="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
      <input type="checkbox" name="job-dept" value="${dept}"
        class="rounded border-gray-300 text-primary focus:ring-primary/30"
        ${allowedDepts.includes(dept) ? 'checked' : ''}/>
      ${dept}
    </label>`
  ).join('');

  deptRestrict.onchange = () => deptList.classList.toggle('hidden', !deptRestrict.checked);
  modalAddJob.classList.remove('hidden');
}

$('btn-add-job').addEventListener('click', () => openJobModal(null));

document.querySelectorAll('.job-req-interval').forEach(btn =>
  btn.addEventListener('click', () => setJobReqInterval(btn.dataset.min || null))
);

document.querySelectorAll('.job-modal-close').forEach(b =>
  b.addEventListener('click', () => modalAddJob.classList.add('hidden'))
);

$('form-add-job').addEventListener('submit', async e => {
  e.preventDefault();

  let requirements = null;
  if (jobReqIntervalMin) {
    const counts = {};
    document.querySelectorAll('[data-req-time]').forEach(inp => {
      const v = parseInt(inp.value) || 0;
      if (v > 0) counts[inp.dataset.reqTime] = v;
    });
    requirements = { interval: jobReqIntervalMin, counts };
  }

  const deptRestrict = $('job-dept-restrict');
  const allowed_departments = deptRestrict.checked
    ? [...document.querySelectorAll('input[name="job-dept"]:checked')].map(el => el.value)
    : [];

  const body = {
    title:          $('job-title').value.trim(),
    description:    $('job-description').value.trim(),
    location:       $('job-location').value.trim(),
    color:          $('job-color').value || '#4DA3FF',
    required_count: jobReqIntervalMin ? 1 : (parseInt($('job-count').value) || 1),
    requirements,
    allowed_departments,
  };
  if (!body.title) return;

  const isEdit = !!editingJobId;
  const targetId = editingJobId;

  if (isEdit) {
    // 楽観的更新
    const idx = jobs.findIndex(j => j.id === targetId);
    const prev = idx !== -1 ? { ...jobs[idx] } : null;
    if (idx !== -1) jobs[idx] = { ...jobs[idx], ...body, _pending: true };
    renderJobList();
    modalAddJob.classList.add('hidden');
    showToast('仕事を更新しました');

    try {
      const updated = await apiFetch(`/api/events/${EVENT_ID}/jobs/${targetId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      const i = jobs.findIndex(j => j.id === targetId);
      if (i !== -1) jobs[i] = updated;
      renderJobList();
    } catch (err) {
      if (prev && idx !== -1) jobs[idx] = prev;
      renderJobList();
      showToast('仕事の更新に失敗しました。', true);
    }
  } else {
    // 楽観的追加
    const tempId = _nextTempId();
    const tempJob = { id: tempId, ...body, _pending: true };
    jobs.push(tempJob);
    renderJobList();
    modalAddJob.classList.add('hidden');
    showToast('仕事を追加しました');

    try {
      const created = await apiFetch(`/api/events/${EVENT_ID}/jobs`, {
        method: 'POST', body: JSON.stringify(body),
      });
      const i = jobs.findIndex(j => j.id === tempId);
      if (i !== -1) jobs[i] = created;
      renderJobList();
    } catch (err) {
      jobs = jobs.filter(j => j.id !== tempId);
      renderJobList();
      showToast('仕事の追加に失敗しました。', true);
    }
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
  const body = {
    date:           $('slot-date').value,
    start_time:     $('slot-start').value,
    end_time:       $('slot-end').value,
    role:           $('slot-role').value.trim(),
    location:       $('slot-location').value.trim(),
    required_count: parseInt($('slot-count').value) || 1,
  };
  if (!body.date || !body.start_time || !body.end_time) return;

  // 楽観的追加
  const tempId = _nextTempId();
  const tempSlot = { id: tempId, ...body, assignments: [], _pending: true };
  slots.push(tempSlot);
  renderShiftBoard();
  modalSlot.classList.add('hidden');
  $('form-add-slot').reset();
  showToast('シフト枠を追加しました');

  // バックグラウンド保存
  try {
    const created = await apiFetch(`/api/events/${EVENT_ID}/slots`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const idx = slots.findIndex(s => s.id === tempId);
    if (idx !== -1) slots[idx] = { ...created, assignments: [] };
    renderShiftBoard();
  } catch (err) {
    slots = slots.filter(s => s.id !== tempId);
    renderShiftBoard();
    showToast('シフト枠の追加に失敗しました。', true);
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
        await withLoading(btn, async () => {
          try {
            await apiFetch(`/api/events/${EVENT_ID}/slots/${currentSlotId}/assign`, {
              method: 'POST',
              body: JSON.stringify({ member_id: parseInt(btn.dataset.mid) }),
            });
            modalAssign.classList.add('hidden');
            showToast('メンバーを割り当てました');
            loadShifts();
          } catch (err) {
            $('assign-error').textContent = err.message;
            $('assign-error').classList.remove('hidden');
          }
        });
      });
    });
  }

  modalAssign.classList.remove('hidden');
}



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
    window.location.href = _API_ROOT + '/dashboard';
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
    const res = await fetch(_API_ROOT + `/api/events/${EVENT_ID}/members/csv`, {
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
function applyBoardSearch(query) {
  boardSearchQuery = query;
  renderShiftBoard();

  if (!query) return;

  // ヒットした最初の行を画面中央へスクロール
  const container = $('shift-board-container');
  const matchedIds = members
    .filter(m => m.name.includes(query))
    .map(m => `[data-member-row="${m.id}"]`);
  if (!matchedIds.length || !container) return;

  const firstMatch = container.querySelector('tr' + matchedIds[0]);
  if (firstMatch) {
    const offset = firstMatch.offsetTop - container.scrollTop;
    const target = container.scrollTop + offset - container.clientHeight / 2 + firstMatch.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

$('board-search')?.addEventListener('input', e => {
  applyBoardSearch(e.target.value.trim());
});
$('board-search')?.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.target.value = '';
    applyBoardSearch('');
  } else if (e.key === 'Enter') {
    applyBoardSearch(e.target.value.trim());
  }
});

// ─── Workload Panel ───────────────────────────────────────────────────────────
let workloadScope = 'day'; // 'day' | 'all'

const DAY_TOTAL_MIN = (22 - 8) * 60; // 8:00〜22:00 = 840分

function calcWorkload(scope) {
  const workMin = {};
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

  // 1日あたりの総時間（スコープに応じた日数分）
  const dayCount = scope === 'day' ? 1 : Math.max(eventDates.length, 1);
  const totalAvailMin = DAY_TOTAL_MIN * dayCount;

  return members.map(m => ({
    id: m.id,
    name: m.name,
    is_leader: m.is_leader,
    workMin: workMin[m.id] || 0,
    breakMin: Math.max(0, totalAvailMin - (workMin[m.id] || 0)),
    totalAvailMin,
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

  const totalAvailMin = data[0]?.totalAvailMin || 1;

  list.innerHTML = `
    <div class="space-y-2">
    ${data.map(d => {
      const workPct  = Math.round((d.workMin  / totalAvailMin) * 100);
      const breakPct = Math.round((d.breakMin / totalAvailMin) * 100);
      return `
        <div class="bg-surface rounded-lg px-2 py-1.5">
          <div class="flex items-center gap-1 mb-1.5">
            ${d.is_leader ? '<span class="text-yellow-400 text-[9px]">★</span>' : ''}
            <span class="text-[10px] font-semibold text-gray-800 truncate flex-1">${d.name}</span>
          </div>
          <div class="w-full flex rounded-full overflow-hidden h-2 bg-gray-100">
            ${workPct > 0  ? `<div class="h-2 bg-blue-400" style="width:${workPct}%"></div>` : ''}
            ${breakPct > 0 ? `<div class="h-2 bg-gray-300" style="width:${breakPct}%"></div>` : ''}
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-[9px] font-medium text-blue-400">仕事 ${fmtMin(d.workMin)}</span>
            <span class="text-[9px] text-gray-400">休憩 ${fmtMin(d.breakMin)}</span>
          </div>
        </div>`;
    }).join('')}
    </div>`;
}

// ─── 仕事分担パネル ビュー状態 ───────────────────────────────────────────────
let jobDistView = 'coverage'; // 'coverage' | 'members'

// 公平性パネルと仕事分担パネルは排他（同時に表示不可）
function showWorkloadPanel() {
  hideJobDistPanel(true);   // 仕事分担ボタンを表示したまま閉じる
  $('workload-panel').classList.remove('hidden');
  $('workload-panel').classList.add('flex');
  $('btn-open-workload').classList.add('hidden');
  renderWorkloadPanel();
}

function hideWorkloadPanel(showBtn = true) {
  $('workload-panel').classList.add('hidden');
  $('workload-panel').classList.remove('flex');
  if (showBtn) $('btn-open-workload').classList.remove('hidden');
}

function showJobDistPanel() {
  hideWorkloadPanel(true);  // 公平性ボタンを表示したまま閉じる
  $('job-dist-panel').classList.remove('hidden');
  $('job-dist-panel').classList.add('flex');
  $('btn-open-job-dist').classList.add('hidden');
  renderJobDistPanel();
}

function hideJobDistPanel(showBtn = true) {
  $('job-dist-panel').classList.add('hidden');
  $('job-dist-panel').classList.remove('flex');
  if (showBtn) $('btn-open-job-dist').classList.remove('hidden');
}

function renderJobDistPanel() {
  const list = $('job-dist-list');
  if (!list) return;
  if (!currentDay) {
    list.innerHTML = '<div class="py-6 text-center text-gray-400 text-xs">日付を選択してください</div>';
    return;
  }

  if (jobDistView === 'members') {
    renderJobDistMembersView(list);
  } else {
    renderJobDistCoverageView(list);
  }
}

function renderJobDistCoverageView(list) {
  if (!jobs.length) {
    list.innerHTML = '<div class="py-6 text-center text-gray-400 text-xs leading-relaxed">仕事が登録されていません<br><span class="text-[10px]">仕事タブから追加してください</span></div>';
    return;
  }

  // 全仕事の requirements から時刻を収集
  const allTimesSet = new Set();
  jobs.forEach(job => {
    Object.entries(job.requirements?.counts || {}).forEach(([t, v]) => {
      if (v > 0) allTimesSet.add(t);
    });
  });

  if (!allTimesSet.size) {
    list.innerHTML = '<div class="py-6 text-center text-gray-400 text-xs leading-relaxed">時間ごとの必要人数が設定されていません<br><span class="text-[10px]">仕事タブから設定してください</span></div>';
    return;
  }

  const daySlots = slots.filter(s => s.date === currentDay);
  const times = [...allTimesSet].sort();

  list.innerHTML = times.map(time => {
    const timeM = timeToMin(time);

    // 全仕事について assigned / required を計算
    const entries = jobs.map(job => {
      const required = job.requirements?.counts?.[time] ?? 0;
      let assigned = 0;
      daySlots.forEach(slot => {
        if (slot.job_type_id !== job.id) return;
        const sM = timeToMin(slot.start_time), eM = timeToMin(slot.end_time);
        if (timeM >= sM && timeM < eM) {
          assigned += slot.assignments.filter(a => a.status !== 'absent').length;
        }
      });
      return { job, required, assigned };
    });

    // 充足バッジは required > 0 のものだけで判定
    const configured = entries.filter(e => e.required > 0);
    const hasShortage = configured.some(e => e.assigned < e.required);

    return `
      <div class="mb-2">
        <div class="flex items-center gap-1.5 px-1 mb-1">
          <span class="text-[10px] font-bold text-gray-500 w-10">${time}</span>
          ${configured.length > 0
            ? (hasShortage
                ? `<span class="text-[9px] font-bold text-red-400 bg-red-50 px-1 rounded">不足あり</span>`
                : `<span class="text-[9px] text-green-500 bg-green-50 px-1 rounded">充足</span>`)
            : ''}
        </div>
        ${entries.map(e => {
          const unset = e.required === 0;
          const ok = !unset && e.assigned >= e.required;
          const pct = unset ? 0 : Math.min(100, e.assigned / e.required * 100);
          const barColor = ok ? '#10B981' : '#EF4444';
          const countLabel = `<span class="text-[10px] font-bold tabular-nums min-w-[36px] text-center" style="color:${unset ? '#D1D5DB' : barColor}">${e.assigned}/${e.required}人</span>`;
          return `
            <div class="mb-1.5 px-1">
              <div class="flex items-center gap-1 mb-0.5">
                <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${e.job.color}"></span>
                <span class="text-[10px] font-medium flex-1 truncate" style="color:${e.job.color}">${e.job.title}</span>
                <div class="flex items-center gap-0.5 flex-shrink-0">
                  <button class="job-req-dec w-4 h-4 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors leading-none"
                    data-job="${e.job.id}" data-time="${time}">−</button>
                  ${countLabel}
                  <button class="job-req-inc w-4 h-4 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors leading-none"
                    data-job="${e.job.id}" data-time="${time}">＋</button>
                </div>
              </div>
              ${!unset ? `
              <div class="h-1 rounded-full bg-gray-100 overflow-hidden ml-3">
                <div class="h-full rounded-full transition-all" style="width:${pct}%;background:${barColor}"></div>
              </div>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }).join('<div class="border-t border-gray-50 my-1"></div>');

  // +/- ボタンのイベント
  list.querySelectorAll('.job-req-inc, .job-req-dec').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const jobId = parseInt(btn.dataset.job);
      const time  = btn.dataset.time;
      const delta = btn.classList.contains('job-req-inc') ? 1 : -1;
      await updateJobRequiredCount(jobId, time, delta);
    });
  });
}

// 必要人数を変更して即時反映 → バックグラウンドで保存
async function updateJobRequiredCount(jobId, time, delta) {
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;
  if (!job.requirements) job.requirements = { counts: {} };
  if (!job.requirements.counts) job.requirements.counts = {};

  const prev = job.requirements.counts[time] ?? 0;
  const next = Math.max(0, prev + delta);
  // 0 → 1 のとき（未設定から設定）、または 1 → 0 のとき（削除）は許可
  // 既に 0 でさらに − しようとした場合は何もしない
  if (next === prev) return;

  if (next === 0) {
    delete job.requirements.counts[time];
  } else {
    job.requirements.counts[time] = next;
  }
  renderJobDistPanel();

  try {
    await apiFetch(`/api/events/${EVENT_ID}/jobs/${jobId}`, {
      method: 'PATCH',
      body: JSON.stringify({ requirements: job.requirements }),
    });
  } catch {
    // ロールバック
    if (prev === 0) {
      delete job.requirements.counts[time];
    } else {
      job.requirements.counts[time] = prev;
    }
    renderJobDistPanel();
    showToast('保存に失敗しました。', 'error');
  }
}

function renderJobDistMembersView(list) {
  const daySlots = slots.filter(s => s.date === currentDay);

  if (!daySlots.length) {
    list.innerHTML = '<div class="py-6 text-center text-gray-400 text-xs">この日のシフトがありません</div>';
    return;
  }

  // 仕事ごとにメンバーをまとめる
  const jobMap = new Map(); // job_type_id → { job, entries: [{name, start_time, end_time, status}] }
  daySlots.forEach(slot => {
    const job = jobs.find(j => j.id === slot.job_type_id);
    const jobKey = slot.job_type_id ?? '__none__';
    if (!jobMap.has(jobKey)) {
      jobMap.set(jobKey, {
        job: job || { title: '仕事なし', color: '#9CA3AF' },
        entries: [],
      });
    }
    const bucket = jobMap.get(jobKey);
    slot.assignments.forEach(a => {
      if (a.status === 'absent') return; // 欠席は除外
      bucket.entries.push({
        name: a.member_name || '?',
        start_time: slot.start_time,
        end_time: slot.end_time,
        isLeader: a.is_leader,
      });
    });
  });

  // 担当者がいる仕事のみ表示
  const filled = [...jobMap.values()].filter(b => b.entries.length > 0);
  if (!filled.length) {
    list.innerHTML = '<div class="py-6 text-center text-gray-400 text-xs">担当者が割り当てられていません</div>';
    return;
  }

  // 仕事ごとにブロック描画
  list.innerHTML = filled.map(({ job, entries }) => {
    // 同じ時間帯でグループ化
    const timeGroups = new Map();
    entries.forEach(e => {
      const key = `${e.start_time}〜${e.end_time}`;
      if (!timeGroups.has(key)) timeGroups.set(key, []);
      timeGroups.get(key).push(e);
    });
    const timeBlocks = [...timeGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    return `
      <div class="mb-3">
        <div class="flex items-center gap-1.5 px-1 mb-1.5">
          <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${job.color}"></span>
          <span class="text-[11px] font-bold truncate" style="color:${job.color}">${job.title}</span>
          <span class="text-[9px] text-gray-400 ml-auto flex-shrink-0">${entries.length}人</span>
        </div>
        <div class="space-y-1 ml-1">
          ${timeBlocks.map(([timeLabel, es]) => `
            <div class="bg-gray-50 rounded-lg px-2 py-1.5">
              <div class="text-[9px] text-gray-400 font-medium mb-1">${timeLabel}</div>
              <div class="space-y-0.5">
                ${es.map(e => `
                  <div class="flex items-center gap-1">
                    ${e.isLeader ? `<svg class="w-2.5 h-2.5 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>` : `<span class="w-2.5 h-2.5 flex-shrink-0"></span>`}
                    <span class="text-[10px] text-gray-700 font-medium truncate">${e.name}</span>
                  </div>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('<div class="border-t border-gray-100 my-2"></div>');
}

// シフトタブ切り替え時のパネル制御
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'shift') {
      $('btn-open-workload').classList.remove('hidden');
      $('btn-open-job-dist').classList.remove('hidden');
    } else {
      $('btn-open-workload').classList.add('hidden');
      $('btn-open-job-dist').classList.add('hidden');
      hideWorkloadPanel();
      hideJobDistPanel();
    }
  });
});

$('btn-open-workload').addEventListener('click', showWorkloadPanel);
$('btn-close-workload').addEventListener('click', hideWorkloadPanel);
$('btn-open-job-dist').addEventListener('click', showJobDistPanel);
$('btn-close-job-dist').addEventListener('click', hideJobDistPanel);

document.querySelectorAll('.job-dist-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    jobDistView = btn.dataset.view;
    document.querySelectorAll('.job-dist-view-btn').forEach(b => {
      const active = b === btn;
      b.classList.toggle('bg-primary', active);
      b.classList.toggle('text-white', active);
      b.classList.toggle('text-gray-500', !active);
    });
    renderJobDistPanel();
  });
});

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

// ─── PDF Download ─────────────────────────────────────────────────────────────
async function downloadShiftBoardPDF() {
  const btn = $('btn-download-pdf');
  const board = $('shift-board');
  const container = $('shift-board-container');
  if (!board) return;

  const original = btn.textContent;
  btn.textContent = '生成中...';
  btn.disabled = true;

  // スクロールコンテナを一時的に解除して全体を見えるようにする
  const prevContainerStyle = container ? {
    overflow: container.style.overflow,
    width: container.style.width,
    height: container.style.height,
  } : null;
  const prevBoardStyle = {
    position: board.style.position,
    width: board.style.width,
  };
  const scrollLeft = container?.scrollLeft || 0;
  const scrollTop  = container?.scrollTop  || 0;

  try {
    if (container) {
      container.style.overflow = 'visible';
      container.style.width = 'max-content';
      container.style.height = 'auto';
    }
    board.style.position = 'relative';
    board.style.width = 'max-content';

    // ボードの実際のサイズで全体をキャプチャ
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
    // 常にランドスケープA4（横長シフト表に適している）
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();  // 297mm
    const pageH = pdf.internal.pageSize.getHeight(); // 210mm

    // 画像を mm に換算（96dpi → mm: 1px = 25.4/96 mm、scale=1.5 考慮）
    const pxPerMm = (96 * 1.5) / 25.4;
    const imgW_mm = canvas.width  / pxPerMm;
    const imgH_mm = canvas.height / pxPerMm;

    // ページ幅に合わせてスケール
    const scale = pageW / imgW_mm;
    const scaledW = imgW_mm * scale;  // = pageW
    const scaledH = imgH_mm * scale;

    const imgData = canvas.toDataURL('image/png');

    if (scaledH <= pageH) {
      // 1ページに収まる
      pdf.addImage(imgData, 'PNG', 0, 0, scaledW, scaledH);
    } else {
      // 縦に複数ページ
      let y = 0;
      while (y < scaledH) {
        if (y > 0) pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, -y, scaledW, scaledH);
        y += pageH;
      }
    }

    const dateLabel = currentDay || 'シフト表';
    pdf.save(`シフト表_${dateLabel}.pdf`);
  } catch (e) {
    console.error(e);
    alert('PDFの生成に失敗しました。');
  } finally {
    // スタイルを元に戻す
    if (container && prevContainerStyle) {
      container.style.overflow = prevContainerStyle.overflow;
      container.style.width    = prevContainerStyle.width;
      container.style.height   = prevContainerStyle.height;
      container.scrollLeft = scrollLeft;
      container.scrollTop  = scrollTop;
    }
    board.style.position = prevBoardStyle.position;
    board.style.width    = prevBoardStyle.width;

    btn.textContent = original;
    btn.disabled = false;
  }
}

$('btn-download-pdf')?.addEventListener('click', downloadShiftBoardPDF);

// ─── Notifications ────────────────────────────────────────────────────────────
const STATUS_JP = { absent: '不在', late: '遅刻' };
const STATUS_COLOR_NOTIF = { absent: '#EF4444', late: '#F59E0B' };

async function loadNotifications() {
  try {
    const raw = await apiFetch(`/api/events/${EVENT_ID}/notifications`);
    // 未対応を上、対応済みを下に並べる
    const data = [
      ...raw.filter(n => !n.resolved),
      ...raw.filter(n =>  n.resolved),
    ];
    const unresolved = data.filter(n => !n.resolved);
    const badge = $('notif-badge');
    if (unresolved.length > 0) {
      badge.textContent = unresolved.length > 99 ? '99+' : unresolved.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    renderNotifList(data);
  } catch (_) {}
}

function renderNotifList(items) {
  const list = $('notif-list');
  if (!items.length) {
    list.innerHTML = '<div class="py-8 text-center text-gray-400 text-sm">報告はありません</div>';
    return;
  }
  list.innerHTML = items.map(n => {
    const color = n.resolved ? '#9CA3AF' : (STATUS_COLOR_NOTIF[n.status] || '#6B7280');
    const label = STATUS_JP[n.status] || n.status;
    const d = new Date(n.date + 'T00:00:00');
    const dateStr = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const reportedAt = n.reported_at
      ? new Date(n.reported_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    return `
      <div class="px-4 py-3 ${n.resolved ? 'opacity-50' : ''}">
        <div class="flex items-start gap-3">
          <div class="w-2 h-2 rounded-full flex-shrink-0 mt-1.5" style="background:${color}"></div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-gray-800">${n.member_name}</span>
              ${n.member_department ? `<span class="text-xs text-gray-400">${n.member_department}</span>` : ''}
              <span class="text-xs font-bold px-1.5 py-0.5 rounded-full text-white" style="background:${color}">${label}</span>
            </div>
            <div class="text-xs text-gray-600 mt-0.5">${dateStr}&nbsp;${n.start_time}〜${n.end_time}${n.role ? '&nbsp;' + n.role : ''}${n.location ? '&nbsp;@' + n.location : ''}</div>
            ${n.note ? `<div class="text-xs text-gray-400 mt-0.5">${n.note}</div>` : ''}
            ${reportedAt ? `<div class="text-[10px] text-gray-300 mt-0.5">${reportedAt} 報告</div>` : ''}
            ${n.resolved
              ? `<div class="text-[10px] text-green-500 font-medium mt-1.5">✓ 対応済み</div>`
              : `<button class="btn-resolve mt-2 w-full py-1.5 text-xs font-semibold rounded-lg border border-green-300 text-green-600 hover:bg-green-50 transition-colors"
                  data-aid="${n.assignment_id}">✓ 対応完了</button>`}
          </div>
        </div>
      </div>`;
  }).join('<div class="border-t border-gray-50 mx-4"></div>');

  list.querySelectorAll('.btn-resolve').forEach(btn => {
    btn.addEventListener('click', async () => {
      const aid = btn.dataset.aid;
      btn.disabled = true;
      btn.textContent = '処理中...';
      try {
        await fetch(_API_ROOT + `/api/events/${EVENT_ID}/notifications/${aid}/resolve`, { method: 'POST' });
        await loadNotifications();
      } catch {
        btn.disabled = false;
        btn.textContent = '✓ 対応完了';
      }
    });
  });
}

const btnNotif  = $('btn-notifications');
const notifPanel = $('notif-panel');
const btnNotifClose = $('btn-notif-close');

btnNotif?.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !notifPanel.classList.contains('hidden');
  notifPanel.classList.toggle('hidden', isOpen);
  if (!isOpen) loadNotifications();
});

btnNotifClose?.addEventListener('click', () => notifPanel.classList.add('hidden'));

document.addEventListener('click', (e) => {
  if (!notifPanel?.contains(e.target) && !btnNotif?.contains(e.target)) {
    notifPanel?.classList.add('hidden');
  }
});

setInterval(loadNotifications, 30000);
loadNotifications();

// ─── Init ─────────────────────────────────────────────────────────────────────
// 初期表示はシフトタブなのでフローティングボタンを表示
$('btn-open-workload')?.classList.remove('hidden');
$('btn-open-job-dist')?.classList.remove('hidden');
loadShifts();
