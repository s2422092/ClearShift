"""
アプリ拡張機能のインスタンスをここで定義する。
循環インポートを避けるため、app.py・routes/*.py の両方からここを参照する。
"""
from flask_caching import Cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

cache = Cache()
limiter = Limiter(key_func=get_remote_address, default_limits=["200 per minute"])
