"""
アプリ拡張機能のインスタンスをここで定義する。
循環インポートを避けるため、app.py・routes/*.py の両方からここを参照する。
"""
from flask_caching import Cache

cache = Cache()
