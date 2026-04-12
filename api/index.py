"""
Vercel Serverless Functions エントリポイント
Vercel の Python ランタイムはこのファイルの `app` 変数を
WSGI アプリとして使用する。
"""
import sys
import os

# プロジェクトルート（api/ の一つ上）を Python パスに追加
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: F401  ← Vercel が WSGI として読み込む
