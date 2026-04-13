/**
 * ClearShift Service Worker
 * - 静的ファイル（CSS/JS/フォント）をキャッシュして高速ロード
 * - APIレスポンスをキャッシュして低速・オフライン時に前回データを表示
 */

const STATIC_CACHE  = 'cs-static-v1';
const API_CACHE     = 'cs-api-v1';

// 起動時にキャッシュするファイル
const PRECACHE_URLS = [
  '/',
  '/static/css/style.css',
  '/static/js/dashboard.js',
  '/static/js/viewer.js',
];

// ── Install: 静的ファイルを事前キャッシュ ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: 古いキャッシュを削除 ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== API_CACHE)
            .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: リクエストを横断してキャッシュ戦略を適用 ──────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 別オリジンは無視
  if (url.origin !== location.origin) return;

  // GET のみ対象
  if (request.method !== 'GET') return;

  // ── 静的ファイル: Cache First（キャッシュを優先、なければネット）
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(request, clone));
          return res;
        });
      })
    );
    return;
  }

  // ── APIエンドポイント: Network First（ネット優先、失敗時は前回キャッシュ）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          // 200 OK のときだけキャッシュに保存
          if (res.ok) {
            caches.open(API_CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() =>
          // オフライン・タイムアウト時は前回のキャッシュを返す
          caches.match(request).then(cached => {
            if (cached) return cached;
            // キャッシュもなければ空の JSON を返してクラッシュを防ぐ
            return new Response(JSON.stringify({ _offline: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          })
        )
    );
    return;
  }
});
