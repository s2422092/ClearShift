#!/bin/bash
set -e

cd "$(dirname "$0")"

# .env がなければ .env.example をコピー
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  .env ファイルを作成しました。SECRET_KEY を変更してください。"
fi

# 仮想環境
if [ ! -d venv ]; then
  echo "仮想環境を作成中..."
  python3 -m venv venv
fi

source venv/bin/activate
pip install -r requirements.txt -q

echo ""
echo "======================================"
echo "  ClearShift を起動中..."
echo "  http://localhost:5001"
echo "======================================"
echo ""

python3 app.py
