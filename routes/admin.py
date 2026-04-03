from flask import Blueprint, render_template, redirect, url_for, request, jsonify, session
from flask_login import login_required, current_user
from models import db, Event, EventMember, ShiftSlot, ShiftAssignment, Availability, EventCollaborator
from datetime import date, datetime, timedelta
import csv
import io

admin_bp = Blueprint('admin', __name__)


def _user_events():
    """ログインユーザーが作成 or 参加しているイベント一覧を返す"""
    own = Event.query.filter_by(creator_id=current_user.id)
    collab_ids = [c.event_id for c in EventCollaborator.query.filter_by(user_id=current_user.id).all()]
    shared = Event.query.filter(Event.id.in_(collab_ids)) if collab_ids else Event.query.filter(False)
    return own.union(shared).order_by(Event.created_at.desc()).all()


def _can_access_event(event_id):
    """ユーザーがそのイベントを編集できるか確認"""
    event = Event.query.get_or_404(event_id)
    if event.creator_id == current_user.id:
        return event
    if EventCollaborator.query.filter_by(event_id=event_id, user_id=current_user.id).first():
        return event
    from flask import abort
    abort(403)


@admin_bp.route('/dashboard')
@login_required
def dashboard():
    events = _user_events()
    return render_template('admin/dashboard.html', events=events)


@admin_bp.route('/events/<int:event_id>')
@login_required
def event_detail(event_id):
    event = _can_access_event(event_id)
    events = _user_events()
    is_owner = event.creator_id == current_user.id
    return render_template('admin/event_detail.html', event=event, events=events, is_owner=is_owner)


@admin_bp.route('/join/<token>')
@login_required
def join_event(token):
    event = Event.query.filter_by(share_token=token).first_or_404()
    if event.creator_id == current_user.id:
        return redirect(url_for('admin.event_detail', event_id=event.id))
    existing = EventCollaborator.query.filter_by(event_id=event.id, user_id=current_user.id).first()
    if not existing:
        db.session.add(EventCollaborator(event_id=event.id, user_id=current_user.id))
        db.session.commit()
    return redirect(url_for('admin.event_detail', event_id=event.id))


# ── API: Events ──────────────────────────────────────────────────────────────

@admin_bp.route('/api/events', methods=['GET'])
@login_required
def api_events():
    events = _user_events()
    return jsonify([e.to_dict() for e in events])


@admin_bp.route('/api/events', methods=['POST'])
@login_required
def api_create_event():
    data = request.get_json()
    title = (data.get('title') or '').strip()
    start_date_str = data.get('start_date')
    end_date_str = data.get('end_date')

    if not title or not start_date_str or not end_date_str:
        return jsonify({'error': 'タイトルと期間を入力してください。'}), 400

    try:
        start_date = date.fromisoformat(start_date_str)
        end_date = date.fromisoformat(end_date_str)
    except ValueError:
        return jsonify({'error': '日付の形式が正しくありません。'}), 400

    if end_date < start_date:
        return jsonify({'error': '終了日は開始日以降にしてください。'}), 400

    event = Event(
        title=title,
        description=(data.get('description') or '').strip(),
        start_date=start_date,
        end_date=end_date,
        creator_id=current_user.id,
    )
    db.session.add(event)
    db.session.commit()
    return jsonify(event.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/share-token', methods=['POST'])
@login_required
def api_share_token(event_id):
    event = Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    event.generate_share_token()
    db.session.commit()
    return jsonify({'share_token': event.share_token})


@admin_bp.route('/api/events/<int:event_id>/share-token', methods=['DELETE'])
@login_required
def api_revoke_share_token(event_id):
    event = Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    event.share_token = None
    db.session.commit()
    return jsonify({'ok': True})


@admin_bp.route('/api/events/<int:event_id>', methods=['PATCH'])
@login_required
def api_update_event(event_id):
    event = _can_access_event(event_id)
    data = request.get_json()
    if 'title' in data:
        event.title = data['title'].strip()
    if 'description' in data:
        event.description = data['description'].strip()
    if 'start_date' in data:
        event.start_date = date.fromisoformat(data['start_date'])
    if 'end_date' in data:
        event.end_date = date.fromisoformat(data['end_date'])
    db.session.commit()
    return jsonify(event.to_dict())


@admin_bp.route('/api/events/<int:event_id>', methods=['DELETE'])
@login_required
def api_delete_event(event_id):
    event = Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()  # オーナーのみ削除可
    db.session.delete(event)
    db.session.commit()
    return jsonify({'ok': True})


# ── API: Members ─────────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/members', methods=['GET'])
@login_required
def api_members(event_id):
    _can_access_event(event_id)
    members = EventMember.query.filter_by(event_id=event_id).order_by(EventMember.name).all()
    return jsonify([m.to_dict() for m in members])


@admin_bp.route('/api/events/<int:event_id>/members', methods=['POST'])
@login_required
def api_add_member(event_id):
    _can_access_event(event_id)
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': '名前を入力してください。'}), 400

    member = EventMember(
        event_id=event_id,
        name=name,
        email=(data.get('email') or '').strip().lower() or None,
        grade=(data.get('grade') or '').strip() or None,
        department=(data.get('department') or '').strip() or None,
    )
    db.session.add(member)
    db.session.commit()
    return jsonify(member.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/members/csv', methods=['POST'])
@login_required
def api_import_members_csv(event_id):
    _can_access_event(event_id)

    if 'file' not in request.files:
        return jsonify({'error': 'ファイルが選択されていません。'}), 400

    f = request.files['file']
    if not f.filename or not f.filename.lower().endswith('.csv'):
        return jsonify({'error': 'CSVファイルを選択してください。'}), 400

    # BOM付きUTF-8とShift_JISに対応
    raw = f.read()
    for encoding in ('utf-8-sig', 'utf-8', 'shift_jis', 'cp932'):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        return jsonify({'error': 'ファイルのエンコーディングを認識できません。UTF-8またはShift_JISで保存してください。'}), 400

    reader = csv.reader(io.StringIO(text))
    added = 0
    skipped = 0
    errors = []

    for i, row in enumerate(reader, start=1):
        # ヘッダー行をスキップ（1行目が「名前」「氏名」「name」で始まる場合）
        if i == 1 and row and row[0].strip().lower() in ('名前', '氏名', 'name'):
            continue
        if not row or not row[0].strip():
            continue

        name = row[0].strip()
        email = row[1].strip().lower() if len(row) > 1 else ''
        grade = row[2].strip() if len(row) > 2 else ''
        department = row[3].strip() if len(row) > 3 else ''

        if not name:
            errors.append(f'{i}行目: 名前が空です')
            skipped += 1
            continue

        member = EventMember(
            event_id=event_id,
            name=name,
            email=email or None,
            grade=grade or None,
            department=department or None,
        )
        db.session.add(member)
        added += 1

    db.session.commit()
    return jsonify({'ok': True, 'added': added, 'skipped': skipped, 'errors': errors})


@admin_bp.route('/api/events/<int:event_id>/members/<int:member_id>', methods=['DELETE'])
@login_required
def api_delete_member(event_id, member_id):
    Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()
    db.session.delete(member)
    db.session.commit()
    return jsonify({'ok': True})


# ── API: Shift Slots ─────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/slots', methods=['GET'])
@login_required
def api_slots(event_id):
    Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    slots = ShiftSlot.query.filter_by(event_id=event_id).order_by(ShiftSlot.date, ShiftSlot.start_time).all()
    return jsonify([s.to_dict() for s in slots])


@admin_bp.route('/api/events/<int:event_id>/slots', methods=['POST'])
@login_required
def api_create_slot(event_id):
    Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    data = request.get_json()

    try:
        slot_date = date.fromisoformat(data['date'])
        from datetime import time as time_type
        start_parts = data['start_time'].split(':')
        end_parts = data['end_time'].split(':')
        start_time = time_type(int(start_parts[0]), int(start_parts[1]))
        end_time = time_type(int(end_parts[0]), int(end_parts[1]))
    except (KeyError, ValueError):
        return jsonify({'error': '日付・時間の形式が正しくありません。'}), 400

    slot = ShiftSlot(
        event_id=event_id,
        date=slot_date,
        start_time=start_time,
        end_time=end_time,
        role=(data.get('role') or '').strip() or None,
        location=(data.get('location') or '').strip() or None,
        required_count=int(data.get('required_count', 1)),
        note=(data.get('note') or '').strip() or None,
    )
    db.session.add(slot)
    db.session.commit()
    return jsonify(slot.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/slots/<int:slot_id>', methods=['DELETE'])
@login_required
def api_delete_slot(event_id, slot_id):
    Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    slot = ShiftSlot.query.filter_by(id=slot_id, event_id=event_id).first_or_404()
    db.session.delete(slot)
    db.session.commit()
    return jsonify({'ok': True})


# ── API: Assignments ──────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/slots/<int:slot_id>/assign', methods=['POST'])
@login_required
def api_assign(event_id, slot_id):
    Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    slot = ShiftSlot.query.filter_by(id=slot_id, event_id=event_id).first_or_404()
    data = request.get_json()
    member_id = data.get('member_id')

    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()

    # 重複チェック
    existing = ShiftAssignment.query.filter_by(slot_id=slot_id, member_id=member_id).first()
    if existing:
        return jsonify({'error': 'このメンバーは既に割り当て済みです。'}), 400

    assignment = ShiftAssignment(slot_id=slot_id, member_id=member_id)
    db.session.add(assignment)
    db.session.commit()
    return jsonify(assignment.to_dict()), 201


@admin_bp.route('/api/assignments/<int:assignment_id>', methods=['DELETE'])
@login_required
def api_delete_assignment(assignment_id):
    assignment = ShiftAssignment.query.get_or_404(assignment_id)
    # 権限確認
    slot = ShiftSlot.query.get(assignment.slot_id)
    Event.query.filter_by(id=slot.event_id, creator_id=current_user.id).first_or_404()
    db.session.delete(assignment)
    db.session.commit()
    return jsonify({'ok': True})


@admin_bp.route('/api/assignments/<int:assignment_id>', methods=['PATCH'])
@login_required
def api_update_assignment(assignment_id):
    assignment = ShiftAssignment.query.get_or_404(assignment_id)
    slot = ShiftSlot.query.get(assignment.slot_id)
    Event.query.filter_by(id=slot.event_id, creator_id=current_user.id).first_or_404()
    data = request.get_json()
    if 'status' in data:
        assignment.status = data['status']
    if 'note' in data:
        assignment.note = data['note']
    db.session.commit()
    return jsonify(assignment.to_dict())


# ── API: Auto Generate ────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/auto-generate', methods=['POST'])
@login_required
def api_auto_generate(event_id):
    event = Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    clear_existing = data.get('clear_existing', False)

    slots = ShiftSlot.query.filter_by(event_id=event_id).order_by(ShiftSlot.date, ShiftSlot.start_time).all()
    members = EventMember.query.filter_by(event_id=event_id).all()

    if not slots or not members:
        return jsonify({'error': 'スロットとメンバーが必要です。'}), 400

    if clear_existing:
        for slot in slots:
            ShiftAssignment.query.filter_by(slot_id=slot.id).delete()
        db.session.flush()

    # 希望日程の収集
    avail_map = {}  # member_id -> set of dates
    for a in Availability.query.filter(
        Availability.member_id.in_([m.id for m in members]),
        Availability.available == True
    ).all():
        avail_map.setdefault(a.member_id, set()).add(a.date)

    # 担当回数カウント（公平性）
    assignment_count = {m.id: 0 for m in members}
    for slot in slots:
        for a in slot.assignments:
            assignment_count[a.member_id] = assignment_count.get(a.member_id, 0) + 1

    assigned_total = 0
    for slot in slots:
        current_assigned = {a.member_id for a in slot.assignments}
        needed = slot.required_count - len(current_assigned)
        if needed <= 0:
            continue

        # 利用可能なメンバーをフィルタ（希望あり、または希望未提出）
        candidates = []
        for m in members:
            if m.id in current_assigned:
                continue
            has_avail_data = m.id in avail_map
            if has_avail_data and slot.date not in avail_map[m.id]:
                continue  # 参加不可
            candidates.append(m)

        # 担当回数の少ない順にソート
        candidates.sort(key=lambda m: assignment_count.get(m.id, 0))

        for m in candidates[:needed]:
            assignment = ShiftAssignment(slot_id=slot.id, member_id=m.id)
            db.session.add(assignment)
            assignment_count[m.id] = assignment_count.get(m.id, 0) + 1
            assigned_total += 1

    db.session.commit()
    return jsonify({'ok': True, 'assigned': assigned_total})


# ── API: Stats ────────────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/stats', methods=['GET'])
@login_required
def api_stats(event_id):
    event = Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    members = EventMember.query.filter_by(event_id=event_id).all()
    slots = ShiftSlot.query.filter_by(event_id=event_id).all()

    # 担当回数集計
    count_map = {m.id: 0 for m in members}
    for slot in slots:
        for a in slot.assignments:
            if a.member_id in count_map:
                count_map[a.member_id] += 1

    member_stats = []
    for m in members:
        # 希望提出確認
        avail_count = Availability.query.filter_by(member_id=m.id).count()
        member_stats.append({
            'id': m.id,
            'name': m.name,
            'department': m.department,
            'grade': m.grade,
            'shift_count': count_map.get(m.id, 0),
            'submitted_availability': avail_count > 0,
        })

    member_stats.sort(key=lambda x: x['shift_count'], reverse=True)

    return jsonify({
        'member_stats': member_stats,
        'total_slots': len(slots),
        'unsubmitted': [m for m in member_stats if not m['submitted_availability']],
    })


# ── API: Availabilities ───────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/availabilities', methods=['GET'])
@login_required
def api_availabilities(event_id):
    Event.query.filter_by(id=event_id, creator_id=current_user.id).first_or_404()
    members = EventMember.query.filter_by(event_id=event_id).all()
    result = {}
    for m in members:
        result[m.id] = [a.to_dict() for a in m.availabilities]
    return jsonify(result)
