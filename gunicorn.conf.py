import multiprocessing
import os

# ── ワーカー設定 ───────────────────────────────────────────────────────────────
# gthread: 1ワーカーあたり複数スレッドで同時リクエストを処理（sync より高効率）
workers     = min(multiprocessing.cpu_count() * 2 + 1, 4)
worker_class = 'gthread'
threads     = int(os.environ.get('WEB_CONCURRENCY_THREADS', 4))  # 1ワーカーあたりのスレッド数

# ── ネットワーク設定 ────────────────────────────────────────────────────────────
bind        = f"0.0.0.0:{os.environ.get('PORT', '5001')}"
backlog     = 2048         # 受付待ちキューの最大数
keepalive   = 65           # Keep-Alive タイムアウト（秒）: CDN/ロードバランサー推奨値
timeout     = 30           # ワーカーがタイムアウトするまでの秒数

# ── リクエスト制限（メモリリーク対策） ─────────────────────────────────────────
max_requests        = 1000  # この数のリクエスト処理後にワーカーを再起動
max_requests_jitter = 100   # 再起動タイミングをランダムにずらして同時停止を防ぐ

# ── プロセス設定 ─────────────────────────────────────────────────────────────────
preload_app     = True   # マスタープロセスでアプリをロード → ワーカー起動を高速化
daemon          = False  # Vercel/コンテナ環境ではフォアグラウンド実行
graceful_timeout = 30    # グレースフルシャットダウン待機時間（リクエスト処理中のワーカーが終わるまで待つ）

# ── ログ ──────────────────────────────────────────────────────────────────────
accesslog  = '-'   # stdout に出力
errorlog   = '-'   # stderr に出力
loglevel   = os.environ.get('LOG_LEVEL', 'warning')
