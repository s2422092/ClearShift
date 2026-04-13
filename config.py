import os
from dotenv import load_dotenv
from sqlalchemy.pool import NullPool, QueuePool

load_dotenv()

# Vercel 上では環境変数 VERCEL=1 が自動的にセットされる
_SERVERLESS = bool(os.environ.get('VERCEL'))


def _build_database_url():
    """DB_HOST / DB_NAME / DB_USER / DB_PASSWORD から DATABASE_URL を組み立てる。
    Railway などで DATABASE_URL が直接設定されている場合はそちらを優先する。"""
    url = os.environ.get('DATABASE_URL')
    if url:
        # postgres:// → postgresql:// に正規化（Heroku/Railway の古い形式対応）
        if url.startswith('postgres://'):
            url = 'postgresql://' + url[len('postgres://'):]
        return url

    host     = os.environ.get('DB_HOST', '')
    dbname   = os.environ.get('DB_NAME', '')
    user     = os.environ.get('DB_USER', '')
    password = os.environ.get('DB_PASSWORD', '')

    if not all([host, dbname, user]):
        return 'postgresql://localhost/clearshift'  # フォールバック

    port = os.environ.get('DB_PORT', '5432')
    if password:
        return f'postgresql://{user}:{password}@{host}:{port}/{dbname}'
    return f'postgresql://{user}@{host}:{port}/{dbname}'


def _engine_options():
    """Vercel（サーバーレス）と通常サーバーでプール設定を切り替える。
    サーバーレスでは NullPool 必須: 関数終了後もコネクションを保持する
    永続プールはコネクション枯渇を引き起こす。"""
    if _SERVERLESS:
        return {
            'poolclass': NullPool,
            'connect_args': {
                'sslmode': 'require',   # Supabase は SSL 必須
                'connect_timeout': 10,
            },
        }
    return {
        'poolclass': QueuePool,
        'pool_size': 10,
        'max_overflow': 20,
        'pool_timeout': 20,
        'pool_recycle': 280,
        'pool_pre_ping': True,
        'connect_args': {
            'connect_timeout': 10,
        },
    }


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
    SQLALCHEMY_DATABASE_URI = _build_database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = _engine_options()
    # ── Flask-Caching ─────────────────────────────────────────────────────────
    # REDIS_URL が設定されていれば Redis、なければプロセス内メモリキャッシュ
    _redis_url = os.environ.get('REDIS_URL', '')
    if _redis_url:
        CACHE_TYPE = 'RedisCache'
        CACHE_REDIS_URL = _redis_url
    else:
        CACHE_TYPE = 'SimpleCache'   # ローカル開発用フォールバック
    CACHE_DEFAULT_TIMEOUT = 60       # デフォルト60秒

    COMPRESS_MIMETYPES = [
        'text/html', 'text/css', 'text/javascript',
        'application/json', 'application/xml'
    ]
    COMPRESS_LEVEL = 6
    COMPRESS_MIN_SIZE = 100
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB
