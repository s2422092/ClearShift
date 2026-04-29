"""
Vercel Cron Jobs エンドポイント
vercel.json の "crons" セクションから定期的に呼び出される。
Cron リクエストには Vercel が自動付与する Authorization ヘッダーが含まれる。
"""
import os
from flask import Blueprint, jsonify, request
from sqlalchemy.orm import joinedload
from models import db, Event, EventMember, ShiftSlot, ShiftAssignment, JobType, ShiftAbsence
from extensions import cache

cron_bp = Blueprint('cron', __name__)

_CRON_SECRET = os.environ.get('CRON_SECRET', '')


def _verify_cron():
    """Vercel Cron または手動呼び出しを認証する"""
    auth = request.headers.get('Authorization', '')
    # Vercel は "Bearer <VERCEL_AUTOMATION_BYPASS_SECRET>" を付与する
    if _CRON_SECRET and auth == f'Bearer {_CRON_SECRET}':
        return True
    # Vercel 内部からの呼び出し（x-vercel-cron ヘッダーが存在する）
    if request.headers.get('x-vercel-cron'):
        return True
    return False


@cron_bp.route('/api/cron/warmup', methods=['GET'])
def warmup():
    """
    アクティブなイベントのシフトデータを事前にキャッシュへ格納する。
    5分毎に実行して Redis キャッシュを温め続ける。
    """
    if not _verify_cron():
        return jsonify({'error': 'Unauthorized'}), 401

    # 直近 90 日以内に終了日があるイベントを対象にする
    from datetime import date, timedelta
    cutoff = date.today() - timedelta(days=90)
    events = Event.query.filter(Event.end_date >= cutoff).all()

    warmed = 0
    for event in events:
        cache_key = f'shift_data_{event.id}'
        if cache.get(cache_key) is not None:
            continue  # 既にキャッシュ済み → スキップ

        slots = (
            ShiftSlot.query
            .filter_by(event_id=event.id)
            .options(joinedload(ShiftSlot.assignments).joinedload(ShiftAssignment.member))
            .order_by(ShiftSlot.date, ShiftSlot.start_time)
            .all()
        )
        members  = EventMember.query.filter_by(event_id=event.id).order_by(EventMember.created_at).all()
        jobs     = JobType.query.filter_by(event_id=event.id).order_by(JobType.created_at).all()
        absences = ShiftAbsence.query.filter_by(event_id=event.id).all()
        data = {
            'slots':    [s.to_dict() for s in slots],
            'members':  [m.to_dict() for m in members],
            'jobs':     [j.to_dict() for j in jobs],
            'absences': [a.to_dict() for a in absences],
        }
        cache.set(cache_key, data, timeout=300)  # Cron 間隔と合わせて5分キャッシュ
        warmed += 1

    return jsonify({'ok': True, 'warmed': warmed, 'total': len(events)})


@cron_bp.route('/ping', methods=['GET'])
def ping():
    """
    Supabase プロジェクトの自動一時停止を防ぐための keep-alive エンドポイント。
    GitHub Actions の定期 cron から毎日呼び出して DB アクティビティを維持する。
    """
    try:
        db.session.execute(db.text('SELECT 1'))
        return jsonify({'ok': True, 'db': 'alive'})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500
