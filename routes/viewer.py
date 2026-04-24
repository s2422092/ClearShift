from flask import Blueprint, render_template, redirect, url_for, request, jsonify, session
from models import db, Event, EventMember, ShiftSlot, ShiftAssignment, Availability, JobType
from sqlalchemy.orm import joinedload
from datetime import date, datetime
from extensions import cache

viewer_bp = Blueprint('viewer', __name__)

VIEWER_SESSION_KEY = 'viewer_member_id'

# キャッシュ TTL（秒）
_CACHE_TTL = 300  # 5分


def get_current_viewer(event_id):
    """セッションから現在のビューアーメンバーを取得"""
    member_id = session.get(f'{VIEWER_SESSION_KEY}_{event_id}')
    if not member_id:
        return None
    return EventMember.query.filter_by(id=member_id, event_id=event_id).first()


@viewer_bp.route('/event/<int:event_id>/login', methods=['GET', 'POST'])
def login(event_id):
    event = Event.query.get_or_404(event_id)
    if request.method == 'POST':
        identifier = (request.form.get('identifier') or '').strip()
        if not identifier:
            return render_template('viewer/login.html', event=event, error='名前またはメールアドレスを入力してください。')

        member = EventMember.query.filter_by(event_id=event_id).filter(
            (EventMember.name == identifier) |
            (EventMember.email == identifier.lower())
        ).first()

        if not member:
            return render_template('viewer/login.html', event=event, error='このイベントに登録されていない名前・メールアドレスです。')

        session[f'{VIEWER_SESSION_KEY}_{event_id}'] = member.id
        return redirect(url_for('viewer.dashboard', event_id=event_id))

    return render_template('viewer/login.html', event=event)


@viewer_bp.route('/event/<int:event_id>/logout')
def logout(event_id):
    session.pop(f'{VIEWER_SESSION_KEY}_{event_id}', None)
    return redirect(url_for('viewer.login', event_id=event_id))


@viewer_bp.route('/event/<int:event_id>/view')
def dashboard(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return redirect(url_for('viewer.login', event_id=event_id))
    return render_template('viewer/dashboard.html', event=event, member=member)


# ── API: Viewer ───────────────────────────────────────────────────────────────

@viewer_bp.route('/event/<int:event_id>/api/my-shifts')
def api_my_shifts(event_id):
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    cache_key = f'viewer_my_shifts_v2_{event_id}_{member.id}'
    cached = cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    # クエリ1: 自分のアサインメント + スロット（同僚はまだ取得しない）
    assignments = (
        ShiftAssignment.query
        .filter_by(member_id=member.id)
        .join(ShiftSlot)
        .filter(ShiftSlot.event_id == event_id)
        .options(joinedload(ShiftAssignment.slot))
        .order_by(ShiftSlot.date, ShiftSlot.start_time)
        .all()
    )

    slot_ids = [a.slot_id for a in assignments]

    # クエリ2: ジョブタイプ（小テーブル）
    jobs = {j.id: j for j in JobType.query.filter_by(event_id=event_id).all()}

    # クエリ3: 同じイベントの全スロット＋割り当てを取得し、Python側で条件判定
    # 条件: job_type_id が一致（両方非NULL）かつ同じ日付かつ時間帯が少しでも重なる
    #       job_type_id が NULL の場合は同一 slot_id のみ
    colleagues_by_slot: dict = {}
    if assignments:
        # イベント全体の他メンバーの割り当てを一括取得
        all_other = (
            db.session.query(ShiftAssignment, EventMember, ShiftSlot)
            .join(ShiftSlot, ShiftAssignment.slot_id == ShiftSlot.id)
            .join(EventMember, ShiftAssignment.member_id == EventMember.id)
            .filter(
                ShiftSlot.event_id == event_id,
                ShiftAssignment.member_id != member.id,
            )
            .all()
        )

        for a in assignments:
            s = a.slot
            bucket = colleagues_by_slot.setdefault(s.id, [])
            for ca, cm, cs in all_other:
                # job_type_id あり：同じ仕事 × 同じ日 × 時間帯が少しでも重なる
                if s.job_type_id is not None and cs.job_type_id == s.job_type_id:
                    overlaps = (
                        cs.date == s.date and
                        cs.start_time < s.end_time and
                        cs.end_time > s.start_time
                    )
                # job_type_id なし：完全に同じスロット
                else:
                    overlaps = (cs.id == s.id)

                if overlaps and not any(c['member_id'] == cm.id for c in bucket):
                    bucket.append({
                        'member_id': cm.id,
                        'name': cm.name,
                        'department': cm.department,
                        'grade': cm.grade,
                        'status': ca.status,
                    })

    result = []
    for a in assignments:
        slot = a.slot
        job = jobs.get(slot.job_type_id)
        result.append({
            'slot_id': slot.id,
            'date': slot.date.isoformat(),
            'start_time': slot.start_time.strftime('%H:%M'),
            'end_time': slot.end_time.strftime('%H:%M'),
            'role': slot.role,
            'location': slot.location,
            'status': a.status,
            'note': a.note,
            'job_color': job.color if job else '#4DA3FF',
            'job_description': job.description if job else None,
            'colleagues': colleagues_by_slot.get(slot.id, []),
        })

    cache.set(cache_key, result, timeout=_CACHE_TTL)
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/all-shifts')
def api_all_shifts(event_id):
    """
    ?date=YYYY-MM-DD を渡すと1日分のみ返す（高速・推奨）。
    date 未指定時は全日程を返す（後方互換）。
    """
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    date_str = request.args.get('date')

    # date 指定あり → 1日分のみ（キャッシュキーに日付を含める）
    cache_key = f'viewer_shifts_{event_id}_{date_str}' if date_str else f'viewer_shifts_{event_id}'
    cached = cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    # クエリ: date 指定があればその日だけ取得（DB転送量を大幅削減）
    query = (
        ShiftSlot.query
        .filter_by(event_id=event_id)
        .options(joinedload(ShiftSlot.assignments))
        .order_by(ShiftSlot.date, ShiftSlot.start_time)
    )
    if date_str:
        try:
            query = query.filter(ShiftSlot.date == date.fromisoformat(date_str))
        except ValueError:
            return jsonify({'error': '日付の形式が正しくありません。'}), 400

    slots = query.all()
    jobs = {j.id: j for j in JobType.query.filter_by(event_id=event_id).all()}
    members = {m.id: m for m in EventMember.query.filter_by(event_id=event_id).all()}

    result = []
    for s in slots:
        job = jobs.get(s.job_type_id)
        result.append({
            'id': s.id,
            'event_id': s.event_id,
            'job_type_id': s.job_type_id,
            'date': s.date.isoformat(),
            'start_time': s.start_time.strftime('%H:%M'),
            'end_time': s.end_time.strftime('%H:%M'),
            'role': s.role,
            'location': s.location,
            'required_count': s.required_count,
            'note': s.note,
            'job_color': job.color if job else '#4DA3FF',
            'assignments': [
                {
                    'member_id': a.member_id,
                    'member_name': members[a.member_id].name if a.member_id in members else '',
                    'member_department': members[a.member_id].department if a.member_id in members else '',
                    'is_leader': members[a.member_id].is_leader if a.member_id in members else False,
                    'status': a.status,
                }
                for a in s.assignments
            ],
        })

    cache.set(cache_key, result, timeout=_CACHE_TTL)
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/members')
def api_viewer_members(event_id):
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    cache_key = f'viewer_members_{event_id}'
    cached = cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    members = EventMember.query.filter_by(event_id=event_id).all()
    result = [m.to_dict() for m in members]
    cache.set(cache_key, result, timeout=_CACHE_TTL)
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/jobs')
def api_viewer_jobs(event_id):
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    cache_key = f'viewer_jobs_{event_id}'
    cached = cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    jobs = JobType.query.filter_by(event_id=event_id).all()
    result = [j.to_dict() for j in jobs]
    cache.set(cache_key, result, timeout=_CACHE_TTL)
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/availability', methods=['GET'])
def api_get_availability(event_id):
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    avails = Availability.query.filter_by(member_id=member.id).all()
    return jsonify([a.to_dict() for a in avails])


@viewer_bp.route('/event/<int:event_id>/api/availability', methods=['POST'])
def api_submit_availability(event_id):
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    data = request.get_json()
    availabilities = data.get('availabilities', [])

    for item in availabilities:
        avail_date = date.fromisoformat(item['date'])
        existing = Availability.query.filter_by(member_id=member.id, date=avail_date).first()
        if existing:
            existing.available = item.get('available', True)
            existing.note = item.get('note', '')
        else:
            db.session.add(Availability(
                member_id=member.id,
                date=avail_date,
                available=item.get('available', True),
                note=item.get('note', ''),
            ))

    db.session.commit()
    return jsonify({'ok': True})


@viewer_bp.route('/event/<int:event_id>/api/report-status', methods=['POST'])
def api_report_status(event_id):
    Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    data = request.get_json()
    slot_id = data.get('slot_id')
    status = data.get('status')
    note = data.get('note', '')

    if status not in ('absent', 'late', 'scheduled'):
        return jsonify({'error': '無効なステータスです。'}), 400

    assignment = ShiftAssignment.query.filter_by(slot_id=slot_id, member_id=member.id).first()
    if not assignment:
        return jsonify({'error': '割り当てが見つかりません。'}), 404

    assignment.status = status
    assignment.note = note
    assignment.reported_at = datetime.utcnow() if status in ('absent', 'late') else None
    db.session.commit()

    # ステータス変更時はビューアーキャッシュを無効化
    cache.delete(f'viewer_my_shifts_v2_{event_id}_{member.id}')
    cache.delete(f'viewer_shifts_{event_id}')

    return jsonify({'ok': True, 'status': status})


@viewer_bp.route('/event/<int:event_id>/api/report-partner-absent', methods=['POST'])
def api_report_partner_absent(event_id):
    """現場にいるメンバーが、同じシフトのペアが来ていないことを報告する"""
    Event.query.get_or_404(event_id)
    reporter = get_current_viewer(event_id)
    if not reporter:
        return jsonify({'error': 'ログインしてください。'}), 401

    data = request.get_json()
    slot_id = data.get('slot_id')
    target_member_id = data.get('member_id')

    reporter_assignment = ShiftAssignment.query.filter_by(
        slot_id=slot_id, member_id=reporter.id
    ).first()
    if not reporter_assignment:
        return jsonify({'error': '報告者がこのシフトに割り当てられていません。'}), 403

    target_assignment = ShiftAssignment.query.filter_by(
        slot_id=slot_id, member_id=target_member_id
    ).first()
    if not target_assignment:
        return jsonify({'error': '対象メンバーが見つかりません。'}), 404

    target_assignment.status = 'absent'
    target_assignment.reported_at = datetime.utcnow()
    target_assignment.note = f'{reporter.name} が報告'
    db.session.commit()

    # ステータス変更時はビューアーキャッシュを無効化
    cache.delete(f'viewer_my_shifts_v2_{event_id}_{target_member_id}')
    cache.delete(f'viewer_shifts_{event_id}')

    return jsonify({'ok': True})
