from flask import Blueprint, render_template, redirect, url_for, request, jsonify, session
from models import db, Event, EventMember, ShiftSlot, ShiftAssignment, Availability, JobType
from datetime import date, datetime

viewer_bp = Blueprint('viewer', __name__)

VIEWER_SESSION_KEY = 'viewer_member_id'


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

        # 名前またはメールで検索
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
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    assignments = ShiftAssignment.query.filter_by(member_id=member.id).join(ShiftSlot).filter(
        ShiftSlot.event_id == event_id
    ).order_by(ShiftSlot.date, ShiftSlot.start_time).all()

    jobs = {j.id: j for j in JobType.query.filter_by(event_id=event_id).all()}
    # 同じスロットの同僚取得用に全メンバーをキャッシュ（N+1クエリを防ぐ）
    all_members = {m.id: m for m in EventMember.query.filter_by(event_id=event_id).all()}

    result = []
    for a in assignments:
        slot = a.slot
        job = jobs.get(slot.job_type_id)
        # 同じスロットに入っている他のメンバー
        colleagues = []
        for other_a in slot.assignments:
            if other_a.member_id != member.id:
                m = all_members.get(other_a.member_id)
                if m:
                    colleagues.append({
                        'member_id': m.id,
                        'name': m.name,
                        'department': m.department,
                        'grade': m.grade,
                        'status': other_a.status,
                    })
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
            'colleagues': colleagues,
        })
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/all-shifts')
def api_all_shifts(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    slots = ShiftSlot.query.filter_by(event_id=event_id).order_by(ShiftSlot.date, ShiftSlot.start_time).all()
    jobs = {j.id: j for j in JobType.query.filter_by(event_id=event_id).all()}
    members = {m.id: m for m in EventMember.query.filter_by(event_id=event_id).all()}

    result = []
    for s in slots:
        job = jobs.get(s.job_type_id)
        d = s.to_dict()
        d['job_color'] = job.color if job else '#4DA3FF'
        d['assignments'] = [{
            'member_id': a.member_id,
            'member_name': members[a.member_id].name if a.member_id in members else '',
            'member_department': members[a.member_id].department if a.member_id in members else '',
            'is_leader': members[a.member_id].is_leader if a.member_id in members else False,
            'status': a.status,
        } for a in s.assignments]
        result.append(d)
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/members')
def api_viewer_members(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401
    members = EventMember.query.filter_by(event_id=event_id).all()
    return jsonify([m.to_dict() for m in members])


@viewer_bp.route('/event/<int:event_id>/api/jobs')
def api_viewer_jobs(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401
    jobs = JobType.query.filter_by(event_id=event_id).all()
    return jsonify([j.to_dict() for j in jobs])


@viewer_bp.route('/event/<int:event_id>/api/availability', methods=['GET'])
def api_get_availability(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    avails = Availability.query.filter_by(member_id=member.id).all()
    return jsonify([a.to_dict() for a in avails])


@viewer_bp.route('/event/<int:event_id>/api/availability', methods=['POST'])
def api_submit_availability(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    data = request.get_json()
    availabilities = data.get('availabilities', [])  # [{date, available, note}]

    for item in availabilities:
        avail_date = date.fromisoformat(item['date'])
        existing = Availability.query.filter_by(member_id=member.id, date=avail_date).first()
        if existing:
            existing.available = item.get('available', True)
            existing.note = item.get('note', '')
        else:
            avail = Availability(
                member_id=member.id,
                date=avail_date,
                available=item.get('available', True),
                note=item.get('note', ''),
            )
            db.session.add(avail)

    db.session.commit()
    return jsonify({'ok': True})


@viewer_bp.route('/event/<int:event_id>/api/report-status', methods=['POST'])
def api_report_status(event_id):
    event = Event.query.get_or_404(event_id)
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
    return jsonify({'ok': True, 'status': status})


@viewer_bp.route('/event/<int:event_id>/api/report-partner-absent', methods=['POST'])
def api_report_partner_absent(event_id):
    """現場にいるメンバーが、同じシフトのペアが来ていないことを報告する"""
    event = Event.query.get_or_404(event_id)
    reporter = get_current_viewer(event_id)
    if not reporter:
        return jsonify({'error': 'ログインしてください。'}), 401

    data = request.get_json()
    slot_id = data.get('slot_id')
    target_member_id = data.get('member_id')

    # 報告者が該当スロットにいることを確認
    reporter_assignment = ShiftAssignment.query.filter_by(
        slot_id=slot_id, member_id=reporter.id
    ).first()
    if not reporter_assignment:
        return jsonify({'error': '報告者がこのシフトに割り当てられていません。'}), 403

    # 対象メンバーの割り当てを取得
    target_assignment = ShiftAssignment.query.filter_by(
        slot_id=slot_id, member_id=target_member_id
    ).first()
    if not target_assignment:
        return jsonify({'error': '対象メンバーが見つかりません。'}), 404

    target_assignment.status = 'absent'
    target_assignment.reported_at = datetime.utcnow()
    target_assignment.note = f'{reporter.name} が報告'
    db.session.commit()
    return jsonify({'ok': True})
