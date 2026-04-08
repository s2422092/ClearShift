import os
from dotenv import load_dotenv

load_dotenv()


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

    if password:
        return f'postgresql://{user}:{password}@{host}/{dbname}'
    return f'postgresql://{user}@{host}/{dbname}'


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
    SQLALCHEMY_DATABASE_URI = _build_database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        'pool_size': 10,
        'max_overflow': 20,
        'pool_timeout': 20,
        'pool_recycle': 280,
        'pool_pre_ping': True,
        'connect_args': {
            'connect_timeout': 10,
        }
    }
    COMPRESS_MIMETYPES = [
        'text/html', 'text/css', 'text/javascript',
        'application/json', 'application/xml'
    ]
    COMPRESS_LEVEL = 6
    COMPRESS_MIN_SIZE = 100
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB
