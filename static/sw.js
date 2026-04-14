/**
 * ClearShift Service Worker
 *
 * 静的ファイル : Cache First（超高速・1年キャッシュ）
 * APIレスポンス: Stale-While-Revalidate（キャッシュを即返しつつバックグラウンドで更新）
 *               オフライン時はキャッシュを返してクラッシュを防ぐ
 */

const STATIC_CACHE = 'cs-static-v2';
const API_CACHE    = 'cs-api-v2';
const OLD_CACHES   = ['cs-static-v1', 'cs-api-v1'];

// 起動時にキャッシュするファイル
const PRECACHE_URLS = [
  '/static/css/style.css',
  '/static/js/dashboard.js',
  '/static/js/viewer.js',
];

// ── Install ───────────────────────────────────────────────────────────────────
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
        keys
          .filter(k => OLD_CACHES.includes(k) || (k !== STATIC_CACHE && k !== API_CACHE))
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 別オリジン・非GETは無視
  if (url.origin !== location.origin) return;
  if (request.method !== 'GET') return;

  // ── 静的ファイル: Cache First ──────────────────────────────────────────────
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // ── API: Stale-While-Revalidate ───────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// キャッシュ戦略ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache First
 * キャッシュがあれば即返す。なければネットから取得してキャッシュに保存。
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Stale-While-Revalidate
 * キャッシュがあれば即返す（stale）。同時にバックグラウンドでネット取得して
 * キャッシュを更新する（revalidate）。キャッシュなし & オフラインは空JSONで返す。
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  // バックグラウンドで再取得してキャッシュ更新
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // キャッシュがあれば即返す（最速応答）
  if (cached) return cached;

  // キャッシュなし → ネット結果を待つ
  const networkResponse = await fetchPromise;
  if (networkResponse) return networkResponse;

  // オフライン + キャッシュなし → フォールバック
  return new Response(JSON.stringify({ _offline: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
