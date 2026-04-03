import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL', 'postgresql://localhost/clearshift')
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
