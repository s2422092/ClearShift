from flask import Blueprint, render_template, redirect, url_for, request, jsonify, session, Response, abort
from flask_login import login_required, current_user
from models import db, Event, EventMember, ShiftSlot, ShiftAssignment, Availability, EventCollaborator, User, JobType, ShiftAbsence
from datetime import date, datetime, timedelta, time as time_type
from sqlalchemy.orm import joinedload
import csv
import io
import json as _builtin_json
import hashlib
from extensions import cache, limiter

admin_bp = Blueprint('admin', __name__)


def _jdump(obj):
    """空白なしコンパクトJSON文字列を返す（DB保存用）"""
    if obj is None:
        return None
    return _builtin_json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def _user_events():
    """ログインユーザーが作成 or 参加しているイベント一覧を返す（2クエリを1つに統合）"""
    from sqlalchemy import select
    collab_subq = select(EventCollaborator.event_id).where(
        EventCollaborator.user_id == current_user.id
    ).scalar_subquery()
    return Event.query.filter(
        (Event.creator_id == current_user.id) | Event.id.in_(collab_subq)
    ).order_by(Event.created_at.desc()).all()


def _invalidate_event_cache(event_id):
    """シフトデータが変更されたときに管理・ビューアー両方のキャッシュを削除する"""
    cache.delete(f'shift_data_{event_id}')
    cache.delete(f'viewer_shifts_{event_id}')
    cache.delete(f'viewer_members_{event_id}')
    cache.delete(f'viewer_jobs_{event_id}')

    # メンバー個別の my_shifts キャッシュを全員分削除
    # （管理者の編集が閲覧者に即時反映されるよう）
    member_ids = [
        row[0] for row in
        db.session.query(EventMember.id).filter_by(event_id=event_id).all()
    ]
    for mid in member_ids:
        cache.delete(f'viewer_my_shifts_{event_id}_{mid}')

    # 日付別キャッシュも全日程分削除
    from models import Event as _Event
    event = _Event.query.get(event_id)
    if event:
        from datetime import timedelta
        cur = event.start_date
        while cur <= event.end_date:
            cache.delete(f'viewer_shifts_{event_id}_{cur.isoformat()}')
            cur += timedelta(days=1)


def _can_access_event(event_id):
    """ユーザーがそのイベントを編集できるか確認"""
    event = Event.query.get_or_404(event_id)
    if event.creator_id == current_user.id:
        return event
    if EventCollaborator.query.filter_by(event_id=event_id, user_id=current_user.id).first():
        return event
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
    # ヘッダー用：オーナー + 共同編集者リスト
    collab_users = [
        User.query.get(c.user_id) for c in event.collaborators
    ]
    editors = [{'id': event.creator.id, 'name': event.creator.name, 'role': 'オーナー'}] + [
        {'id': u.id, 'name': u.name, 'role': '編集者'} for u in collab_users if u
    ]
    return render_template(
        'admin/event_detail.html',
        event=event, events=events,
        is_owner=is_owner, editors=editors,
    )


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

@admin_bp.route('/api/events/<int:event_id>/editors', methods=['GET'])
@login_required
def api_editors(event_id):
    event = _can_access_event(event_id)
    collab_users = [User.query.get(c.user_id) for c in event.collaborators]
    result = [{'id': event.creator.id, 'name': event.creator.name, 'email': event.creator.email, 'role': 'オーナー'}] + [
        {'id': u.id, 'name': u.name, 'email': u.email, 'role': '編集者'} for u in collab_users if u
    ]
    return jsonify(result)


@admin_bp.route('/api/members/csv-template')
@login_required
def api_csv_template():
    output = io.StringIO()
    writer = csv.writer(output)
    # 説明コメント行（# で始まる行は読み込み時に自動スキップ）
    writer.writerow(['# ClearShift メンバーCSVテンプレート'])
    writer.writerow(['# '])
    writer.writerow(['# 【CSVファイルの形式】'])
    writer.writerow(['# A列（必須）', 'B列', 'C列', 'D列'])
    writer.writerow(['# 名前', 'メールアドレス', '学年', '局・グループ'])
    writer.writerow(['# '])
    writer.writerow(['# ・列の順番は自動で認識します（どの順でもOK）'])
    writer.writerow(['# ・学年は「2」でも「2年」でも可'])
    writer.writerow(['# ・UTF-8 / Shift_JIS どちらも対応'])
    writer.writerow(['# ・この「#」で始まる行は読み込み時に無視されます'])
    writer.writerow(['# '])
    writer.writerow(['# ↓ここからデータを入力してください（この行は削除してOK）'])
    # ヘッダー行
    writer.writerow(['名前', 'メールアドレス', '学年', '局・グループ'])
    # サンプルデータ
    writer.writerow(['山田太郎', 'yamada@gmail.com', '2年', '広報局'])
    writer.writerow(['鈴木花子', 'suzuki@gmail.com', '1', '技術局'])
    content = '\ufeff' + output.getvalue()  # BOM付きUTF-8（Excelで文字化けしない）
    return Response(
        content,
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename="members_template.csv"'},
    )


@admin_bp.route('/api/events', methods=['GET'])
@login_required
def api_events():
    events = _user_events()
    return jsonify([e.to_dict() for e in events])


@admin_bp.route('/api/events', methods=['POST'])
@login_required
@limiter.limit("60 per minute")
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
    if 'day_labels' in data:
        labels = data['day_labels']
        event.day_labels_json = _jdump(labels) if labels else None
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
    page = request.args.get('page', type=int)
    if page:
        per_page = request.args.get('per_page', 100, type=int)
        pag = EventMember.query.filter_by(event_id=event_id).order_by(EventMember.name).paginate(
            page=page, per_page=per_page, error_out=False
        )
        return jsonify({
            'members': [m.to_dict() for m in pag.items],
            'total': pag.total,
            'pages': pag.pages,
            'page': page,
        })
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

    NAME_KEYS  = {'名前', '氏名', '名称', 'name', 'fullname', '姓名', '氏　名'}
    EMAIL_KEYS = {'メール', 'メールアドレス', 'mail', 'email', 'gmail', 'gamil', 'アドレス', 'メアド', 'mail address'}
    GRADE_KEYS = {'学年', '年次', '年齢', 'grade', 'year', '学年・年次'}
    DEPT_KEYS  = {'局', 'グループ', '部', '部署', '班', 'department', 'dept', 'group', '局・グループ', '所属'}
    ALL_KEYS   = NAME_KEYS | EMAIL_KEYS | GRADE_KEYS | DEPT_KEYS

    def detect_col(header_row, keywords):
        for i, h in enumerate(header_row):
            if h.strip().lower() in {k.lower() for k in keywords}:
                return i
        return None

    def normalize_grade(val):
        v = val.strip()
        return (v + '年') if (v and v.isdigit()) else v

    reader = csv.reader(io.StringIO(text))
    all_rows = list(reader)
    added = 0
    skipped = 0
    errors = []

    if not all_rows:
        return jsonify({'ok': True, 'added': 0, 'skipped': 0, 'errors': []})

    # ── ① 空行・コメント行（#始まり）を除外しつつ元インデックスを保持 ──
    non_empty = [(i, row) for i, row in enumerate(all_rows)
                 if any(cell.strip() for cell in row)
                 and not next((c.strip() for c in row if c.strip()), '').startswith('#')]

    if not non_empty:
        return jsonify({'ok': True, 'added': 0, 'skipped': 0, 'errors': []})

    # ── ② 全行を走査してヘッダー行を探す ──
    header_orig_idx = None
    header_row = None
    for orig_i, row in non_empty:
        cells_lower = {c.strip().lower() for c in row}
        if cells_lower & {k.lower() for k in ALL_KEYS}:
            header_orig_idx = orig_i
            header_row = row
            break

    def detect_email_col_by_data(rows):
        """ヘッダーで判定できない場合、データ行の @ を含むセルからメール列を推定する"""
        col_counts = {}
        for row in rows:
            for i, cell in enumerate(row):
                if '@' in cell.strip():
                    col_counts[i] = col_counts.get(i, 0) + 1
        return max(col_counts, key=col_counts.get) if col_counts else None

    if header_row is not None:
        col_name  = detect_col(header_row, NAME_KEYS)
        col_email = detect_col(header_row, EMAIL_KEYS)
        col_grade = detect_col(header_row, GRADE_KEYS)
        col_dept  = detect_col(header_row, DEPT_KEYS)
        data_rows = [row for orig_i, row in non_empty if orig_i > header_orig_idx]
        # ヘッダーでメール列が見つからなかった場合はデータから推定
        if col_email is None:
            col_email = detect_email_col_by_data(data_rows)
    else:
        # ヘッダーなし → 最初の非空行の最初の非空セルを起点に固定順
        first_row = non_empty[0][1]
        start = next((i for i, c in enumerate(first_row) if c.strip()), 0)
        col_name  = start
        col_email = start + 1
        col_grade = start + 2
        col_dept  = start + 3
        data_rows = [row for _, row in non_empty]

    if col_name is None:
        return jsonify({'error': '「名前」列が見つかりません。ヘッダー行を確認してください。'}), 400

    for row in data_rows:
        def get(col):
            return row[col].strip() if col is not None and col < len(row) else ''

        name = get(col_name)
        if not name:
            skipped += 1
            continue

        member = EventMember(
            event_id=event_id,
            name=name,
            email=get(col_email).lower() or None,
            grade=normalize_grade(get(col_grade)) or None,
            department=get(col_dept) or None,
        )
        db.session.add(member)
        added += 1

    db.session.commit()
    return jsonify({'ok': True, 'added': added, 'skipped': skipped, 'errors': errors})


@admin_bp.route('/api/events/<int:event_id>/members/<int:member_id>', methods=['DELETE'])
@login_required
def api_delete_member(event_id, member_id):
    _can_access_event(event_id)
    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()
    ShiftAssignment.query.filter_by(member_id=member.id).delete(synchronize_session=False)
    db.session.delete(member)
    db.session.commit()
    return jsonify({'ok': True})


@admin_bp.route('/api/events/<int:event_id>/members/bulk-delete', methods=['POST'])
@login_required
def api_bulk_delete_members(event_id):
    _can_access_event(event_id)
    data = request.get_json()
    ids = data.get('ids', [])
    if not ids:
        return jsonify({'error': '削除するメンバーを選択してください。'}), 400
    # 対象メンバーのIDを確定（イベント所属チェック込み）
    valid_ids = [
        m.id for m in EventMember.query.filter(
            EventMember.id.in_(ids),
            EventMember.event_id == event_id,
        ).all()
    ]
    if not valid_ids:
        return jsonify({'error': '削除対象のメンバーが見つかりません。'}), 400

    # 関連するシフト割り当てを先に削除（外部キー制約対策）
    ShiftAssignment.query.filter(
        ShiftAssignment.member_id.in_(valid_ids)
    ).delete(synchronize_session=False)

    # メンバー削除
    deleted = EventMember.query.filter(
        EventMember.id.in_(valid_ids),
    ).delete(synchronize_session=False)
    db.session.commit()
    return jsonify({'ok': True, 'deleted': deleted})


@admin_bp.route('/api/events/<int:event_id>/members/<int:member_id>', methods=['PATCH'])
@login_required
def api_update_member(event_id, member_id):
    _can_access_event(event_id)
    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()
    data = request.get_json()
    if 'is_leader' in data:
        member.is_leader = bool(data['is_leader'])
    if 'labels' in data:
        labels = data['labels']
        member.labels_json = _jdump(labels) if labels else None
    if 'name' in data:
        member.name = (data['name'] or '').strip() or member.name
    if 'grade' in data:
        member.grade = (data['grade'] or '').strip() or None
    if 'department' in data:
        member.department = (data['department'] or '').strip() or None
    if 'email' in data:
        member.email = (data['email'] or '').strip() or None
    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify(member.to_dict())


@admin_bp.route('/api/events/<int:event_id>/members/<int:member_id>/shifts', methods=['DELETE'])
@login_required
def api_delete_member_shifts(event_id, member_id):
    """メンバーのシフト割り当てを一括削除（日付・時間範囲でフィルタ可能）"""
    _can_access_event(event_id)
    EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()

    data = request.get_json() or {}
    date_str       = data.get('date')
    start_time_str = data.get('start_time')
    end_time_str   = data.get('end_time')

    query = ShiftAssignment.query.filter_by(member_id=member_id).join(ShiftSlot).filter(
        ShiftSlot.event_id == event_id
    )
    if date_str:
        query = query.filter(ShiftSlot.date == date.fromisoformat(date_str))
    if start_time_str and end_time_str:
        sp = start_time_str.split(':')
        ep = end_time_str.split(':')
        start_t = time_type(int(sp[0]), int(sp[1]))
        end_t   = time_type(int(ep[0]), int(ep[1]))
        # 指定範囲と重なるスロット（開始 < end_t かつ 終了 > start_t）
        query = query.filter(ShiftSlot.start_time < end_t, ShiftSlot.end_time > start_t)

    assignments = query.all()
    for a in assignments:
        db.session.delete(a)
    db.session.commit()
    return jsonify({'ok': True, 'deleted': len(assignments)})


@admin_bp.route('/api/events/<int:event_id>/members/<int:src_id>/copy-to/<int:dst_id>', methods=['POST'])
@login_required
def api_copy_shifts(event_id, src_id, dst_id):
    """src メンバーのシフトを dst メンバーに複製する"""
    _can_access_event(event_id)
    src = EventMember.query.filter_by(id=src_id, event_id=event_id).first_or_404()
    dst = EventMember.query.filter_by(id=dst_id, event_id=event_id).first_or_404()

    src_assignments = (
        ShiftAssignment.query
        .filter_by(member_id=src_id)
        .join(ShiftSlot)
        .filter(ShiftSlot.event_id == event_id)
        .options(joinedload(ShiftAssignment.slot))
        .all()
    )

    copied = 0
    skipped = 0
    for a in src_assignments:
        slot = a.slot
        # 同一スロットへの重複割り当てチェック
        if ShiftAssignment.query.filter_by(slot_id=slot.id, member_id=dst_id).first():
            skipped += 1
            continue
        # 同日・時間帯重複チェック
        overlap = (
            db.session.query(ShiftAssignment)
            .join(ShiftSlot, ShiftAssignment.slot_id == ShiftSlot.id)
            .filter(
                ShiftAssignment.member_id == dst_id,
                ShiftSlot.event_id == event_id,
                ShiftSlot.date == slot.date,
                ShiftSlot.start_time < slot.end_time,
                ShiftSlot.end_time > slot.start_time,
                ShiftSlot.id != slot.id,
            )
            .first()
        )
        if overlap:
            skipped += 1
            continue
        db.session.add(ShiftAssignment(slot_id=slot.id, member_id=dst_id))
        copied += 1

    db.session.commit()
    if copied:
        _invalidate_event_cache(event_id)
    return jsonify({'ok': True, 'copied': copied, 'skipped': skipped})


# ── API: Shift Slots ─────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/shift-data', methods=['GET'])
@login_required
def api_shift_data(event_id):
    """slots + members + jobs + absences を1回のリクエストで返す統合エンドポイント（60秒キャッシュ）"""
    _can_access_event(event_id)
    cache_key = f'shift_data_{event_id}'
    cached = cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    slots = (
        ShiftSlot.query
        .filter_by(event_id=event_id)
        .options(joinedload(ShiftSlot.assignments).joinedload(ShiftAssignment.member))
        .order_by(ShiftSlot.date, ShiftSlot.start_time)
        .all()
    )
    members  = EventMember.query.filter_by(event_id=event_id).order_by(EventMember.created_at).all()
    jobs     = JobType.query.filter_by(event_id=event_id).order_by(JobType.created_at).all()
    absences = ShiftAbsence.query.filter_by(event_id=event_id).all()
    data = {
        'slots':    [s.to_dict() for s in slots],
        'members':  [m.to_dict() for m in members],
        'jobs':     [j.to_dict() for j in jobs],
        'absences': [a.to_dict() for a in absences],
    }
    cache.set(cache_key, data, timeout=300)  # 5分キャッシュ（編集後は即無効化される）
    return jsonify(data)


@admin_bp.route('/api/events/<int:event_id>/slots', methods=['GET'])
@login_required
def api_slots(event_id):
    _can_access_event(event_id)
    slots = ShiftSlot.query.filter_by(event_id=event_id).order_by(ShiftSlot.date, ShiftSlot.start_time).all()
    return jsonify([s.to_dict() for s in slots])


@admin_bp.route('/api/events/<int:event_id>/slots', methods=['POST'])
@login_required
@limiter.limit("60 per minute")
def api_create_slot(event_id):
    _can_access_event(event_id)
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

    job_type_id = data.get('job_type_id')

    # 同一イベント・日付・開始時刻・終了時刻・仕事の重複スロット作成を防ぐ
    duplicate = ShiftSlot.query.filter_by(
        event_id=event_id,
        date=slot_date,
        start_time=start_time,
        end_time=end_time,
        job_type_id=int(job_type_id) if job_type_id else None,
    ).first()
    if duplicate:
        return jsonify(duplicate.to_dict()), 200  # 既存スロットをそのまま返す

    slot = ShiftSlot(
        event_id=event_id,
        job_type_id=int(job_type_id) if job_type_id else None,
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
    _invalidate_event_cache(event_id)
    return jsonify(slot.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/slot-with-assignment', methods=['POST'])
@login_required
@limiter.limit("60 per minute")
def api_create_slot_with_assignment(event_id):
    """スロット作成＋メンバー割り当てを1トランザクションで実行（2往復→1往復）"""
    _can_access_event(event_id)
    data = request.get_json() or {}

    try:
        slot_date = date.fromisoformat(data['date'])
        sp = data['start_time'].split(':')
        ep = data['end_time'].split(':')
        start_t = time_type(int(sp[0]), int(sp[1]))
        end_t   = time_type(int(ep[0]), int(ep[1]))
    except (KeyError, ValueError):
        return jsonify({'error': '日付・時間の形式が正しくありません。'}), 400

    member_id = data.get('member_id')
    if not member_id:
        return jsonify({'error': 'member_id が必要です。'}), 400
    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()

    job_type_id = data.get('job_type_id')
    if job_type_id:
        job = JobType.query.get(job_type_id)
        if job:
            allowed = job.get_allowed_departments()
            if allowed and member.department not in allowed:
                return jsonify({'error': f'この仕事は {", ".join(allowed)} のメンバーのみ担当できます。'}), 400

    # 重複スロット → 再利用
    slot = ShiftSlot.query.filter_by(
        event_id=event_id, date=slot_date,
        start_time=start_t, end_time=end_t,
        job_type_id=int(job_type_id) if job_type_id else None,
    ).first()
    if not slot:
        slot = ShiftSlot(
            event_id=event_id,
            job_type_id=int(job_type_id) if job_type_id else None,
            date=slot_date, start_time=start_t, end_time=end_t,
            role=(data.get('role') or '').strip() or None,
            location=(data.get('location') or '').strip() or None,
            required_count=int(data.get('required_count', 1)),
        )
        db.session.add(slot)
        db.session.flush()  # slot.id を確定

    # 時間帯重複チェック
    overlap = (
        db.session.query(ShiftAssignment)
        .join(ShiftSlot, ShiftAssignment.slot_id == ShiftSlot.id)
        .filter(
            ShiftAssignment.member_id == member_id,
            ShiftSlot.event_id == event_id,
            ShiftSlot.date == slot_date,
            ShiftSlot.start_time < end_t,
            ShiftSlot.end_time > start_t,
            ShiftSlot.id != slot.id,
        ).first()
    )
    if overlap:
        db.session.rollback()
        return jsonify({'error': 'この時間帯には既に別のシフトが割り当て済みです。'}), 409

    existing = ShiftAssignment.query.filter_by(slot_id=slot.id, member_id=member_id).first()
    if not existing:
        db.session.add(ShiftAssignment(slot_id=slot.id, member_id=member_id))

    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify(slot.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/slot-with-assignment/replace', methods=['POST'])
@login_required
@limiter.limit("60 per minute")
def api_replace_slot_with_assignment(event_id):
    """既存スロット＋割り当てを削除して新スロット＋割り当てを1トランザクションで作成（編集: 4往復→1往復）"""
    _can_access_event(event_id)
    data = request.get_json() or {}

    old_assignment_id = data.get('old_assignment_id')
    old_slot_id       = data.get('old_slot_id')

    try:
        slot_date = date.fromisoformat(data['date'])
        sp = data['start_time'].split(':')
        ep = data['end_time'].split(':')
        start_t = time_type(int(sp[0]), int(sp[1]))
        end_t   = time_type(int(ep[0]), int(ep[1]))
    except (KeyError, ValueError):
        return jsonify({'error': '日付・時間の形式が正しくありません。'}), 400

    member_id = data.get('member_id')
    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()

    job_type_id = data.get('job_type_id')
    if job_type_id:
        job = JobType.query.get(job_type_id)
        if job:
            allowed = job.get_allowed_departments()
            if allowed and member.department not in allowed:
                return jsonify({'error': f'この仕事は {", ".join(allowed)} のメンバーのみ担当できます。'}), 400

    # 旧アサインメントのみ削除（同じスロットに他メンバーが居ればスロット自体は残す）
    old_a = ShiftAssignment.query.get(old_assignment_id)
    if old_a:
        db.session.delete(old_a)
    db.session.flush()

    # 旧スロットに残アサインメントがなくなった場合のみスロットも削除
    old_s = ShiftSlot.query.filter_by(id=old_slot_id, event_id=event_id).first()
    if old_s:
        remaining = ShiftAssignment.query.filter_by(slot_id=old_slot_id).count()
        if remaining == 0:
            db.session.delete(old_s)
    db.session.flush()

    # 新スロット作成（重複スロット再利用）
    slot = ShiftSlot.query.filter_by(
        event_id=event_id, date=slot_date,
        start_time=start_t, end_time=end_t,
        job_type_id=int(job_type_id) if job_type_id else None,
    ).first()
    if not slot:
        slot = ShiftSlot(
            event_id=event_id,
            job_type_id=int(job_type_id) if job_type_id else None,
            date=slot_date, start_time=start_t, end_time=end_t,
            role=(data.get('role') or '').strip() or None,
            location=(data.get('location') or '').strip() or None,
            required_count=int(data.get('required_count', 1)),
        )
        db.session.add(slot)
        db.session.flush()

    # 時間帯重複チェック
    overlap = (
        db.session.query(ShiftAssignment)
        .join(ShiftSlot, ShiftAssignment.slot_id == ShiftSlot.id)
        .filter(
            ShiftAssignment.member_id == member_id,
            ShiftSlot.event_id == event_id,
            ShiftSlot.date == slot_date,
            ShiftSlot.start_time < end_t,
            ShiftSlot.end_time > start_t,
            ShiftSlot.id != slot.id,
        ).first()
    )
    if overlap:
        db.session.rollback()
        return jsonify({'error': 'この時間帯には既に別のシフトが割り当て済みです。'}), 409

    existing = ShiftAssignment.query.filter_by(slot_id=slot.id, member_id=member_id).first()
    if not existing:
        db.session.add(ShiftAssignment(slot_id=slot.id, member_id=member_id))

    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify(slot.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/slots/<int:slot_id>', methods=['DELETE'])
@login_required
def api_delete_slot(event_id, slot_id):
    _can_access_event(event_id)
    slot = ShiftSlot.query.filter_by(id=slot_id, event_id=event_id).first_or_404()
    db.session.delete(slot)
    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify({'ok': True})


# ── API: Jobs ────────────────────────────────────────────────────────────────

JOB_COLOR_PALETTE = [
    '#4DA3FF', '#FF6B6B', '#48BB78', '#F6AD55', '#9F7AEA',
    '#4FD1C5', '#F687B3', '#FC8181', '#667EEA', '#38B2AC',
]


def _pick_job_color(event_id):
    used = {j.color for j in JobType.query.filter_by(event_id=event_id).all()}
    for color in JOB_COLOR_PALETTE:
        if color not in used:
            return color
    # 全色使用済みの場合は先頭から再利用
    return JOB_COLOR_PALETTE[0]


@admin_bp.route('/api/events/<int:event_id>/jobs', methods=['GET'])
@login_required
def api_jobs(event_id):
    _can_access_event(event_id)
    jobs = JobType.query.filter_by(event_id=event_id).order_by(JobType.created_at).all()
    return jsonify([j.to_dict() for j in jobs])


@admin_bp.route('/api/events/<int:event_id>/jobs', methods=['POST'])
@login_required
def api_create_job(event_id):
    _can_access_event(event_id)
    data = request.get_json()
    title = (data.get('title') or '').strip()
    if not title:
        return jsonify({'error': '仕事タイトルを入力してください。'}), 400
    color = _pick_job_color(event_id)
    job = JobType(
        event_id=event_id,
        title=title,
        description=(data.get('description') or '').strip() or None,
        location=(data.get('location') or '').strip() or None,
        required_count=int(data.get('required_count') or 1),
        color=color,
    )
    db.session.add(job)
    db.session.commit()
    return jsonify(job.to_dict()), 201


@admin_bp.route('/api/events/<int:event_id>/jobs/<int:job_id>', methods=['PATCH'])
@login_required
def api_update_job(event_id, job_id):
    _can_access_event(event_id)
    job = JobType.query.filter_by(id=job_id, event_id=event_id).first_or_404()
    data = request.get_json()
    if 'color' in data:
        color = (data['color'] or '').strip()
        if not color.startswith('#') or len(color) not in (4, 7):
            return jsonify({'error': '無効なカラーコードです。'}), 400
        job.color = color
    if 'title' in data:
        title = (data['title'] or '').strip()
        if not title:
            return jsonify({'error': '仕事タイトルを入力してください。'}), 400
        job.title = title
    if 'description' in data:
        job.description = (data.get('description') or '').strip() or None
    if 'location' in data:
        job.location = (data.get('location') or '').strip() or None
    if 'required_count' in data:
        job.required_count = int(data.get('required_count') or 1)
    if 'requirements' in data:
        req = data['requirements']
        job.requirements_json = _jdump(req) if req else None
    if 'allowed_departments' in data:
        depts = data['allowed_departments']
        job.allowed_departments_json = _jdump(depts) if depts else None
    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify(job.to_dict())


@admin_bp.route('/api/events/<int:event_id>/jobs/<int:job_id>', methods=['DELETE'])
@login_required
def api_delete_job(event_id, job_id):
    _can_access_event(event_id)
    job = JobType.query.filter_by(id=job_id, event_id=event_id).first_or_404()
    db.session.delete(job)
    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify({'ok': True})


# ── API: Assignments ──────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/slots/<int:slot_id>/assign', methods=['POST'])
@login_required
@limiter.limit("120 per minute")
def api_assign(event_id, slot_id):
    _can_access_event(event_id)
    slot = ShiftSlot.query.filter_by(id=slot_id, event_id=event_id).first_or_404()
    data = request.get_json() or {}
    member_id = data.get('member_id')
    if not member_id:
        return jsonify({'error': 'member_id が必要です。'}), 400

    member = EventMember.query.filter_by(id=member_id, event_id=event_id).first_or_404()

    # 局制限チェック
    if slot.job_type_id:
        job = JobType.query.get(slot.job_type_id)
        if job:
            allowed = job.get_allowed_departments()
            if allowed and member.department not in allowed:
                return jsonify({'error': f'この仕事（{job.title}）は {", ".join(allowed)} のメンバーのみ担当できます。'}), 400

    # 重複チェック（冪等: 既に割り当て済みなら既存データをそのまま返す）
    existing = ShiftAssignment.query.filter_by(slot_id=slot_id, member_id=member_id).first()
    if existing:
        return jsonify(existing.to_dict()), 200

    # 同日・時間帯重複チェック（同一人物が同じ時間帯に複数シフトを持てないようにする）
    overlap = (
        db.session.query(ShiftAssignment)
        .join(ShiftSlot, ShiftAssignment.slot_id == ShiftSlot.id)
        .filter(
            ShiftAssignment.member_id == member_id,
            ShiftSlot.event_id == event_id,
            ShiftSlot.date == slot.date,
            ShiftSlot.start_time < slot.end_time,
            ShiftSlot.end_time > slot.start_time,
            ShiftSlot.id != slot_id,
        )
        .first()
    )
    if overlap:
        overlap_slot = overlap.slot
        return jsonify({
            'error': f'この時間帯（{slot.date} {slot.start_time.strftime("%H:%M")}〜{slot.end_time.strftime("%H:%M")}）には既に別のシフトが割り当て済みです。'
        }), 409

    assignment = ShiftAssignment(slot_id=slot_id, member_id=member_id)
    db.session.add(assignment)
    db.session.commit()
    _invalidate_event_cache(event_id)
    return jsonify(assignment.to_dict()), 201


@admin_bp.route('/api/assignments/<int:assignment_id>', methods=['DELETE'])
@login_required
def api_delete_assignment(assignment_id):
    assignment = ShiftAssignment.query.get_or_404(assignment_id)
    slot = db.session.get(ShiftSlot, assignment.slot_id)
    if not slot:
        abort(404)
    _can_access_event(slot.event_id)
    db.session.delete(assignment)
    db.session.commit()
    _invalidate_event_cache(slot.event_id)
    return jsonify({'ok': True})


@admin_bp.route('/api/assignments/<int:assignment_id>', methods=['PATCH'])
@login_required
def api_update_assignment(assignment_id):
    assignment = ShiftAssignment.query.get_or_404(assignment_id)
    slot = db.session.get(ShiftSlot, assignment.slot_id)
    if not slot:
        abort(404)
    _can_access_event(slot.event_id)
    data = request.get_json() or {}
    if 'status' in data:
        assignment.status = data['status']
    if 'note' in data:
        assignment.note = data['note']
    db.session.commit()
    _invalidate_event_cache(slot.event_id)
    return jsonify(assignment.to_dict())


# ── API: Maintenance ──────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/maintenance', methods=['POST'])
@login_required
def api_maintenance(event_id):
    """
    DBサイズ削減メンテナンス（オーナーのみ実行可）:
      1. availabilities の重複排除（同 member+date は最新1件だけ残す）
      2. イベント日程外の availabilities / shift_absences を削除
      3. JSON TEXT カラムのホワイトスペースをコンパクト化
      4. VACUUM ANALYZE で物理領域を最適化
    """
    from sqlalchemy import text
    event = Event.query.filter_by(id=event_id, creator_id=current_user.id).first()
    if not event:
        return jsonify({'error': 'オーナーのみ実行できます。'}), 403

    stats = {'dedup_avail': 0, 'out_of_range': 0, 'json_compacted': 0, 'vacuum': False}

    member_ids = [m.id for m in EventMember.query.filter_by(event_id=event_id).with_entities(EventMember.id).all()]
    if not member_ids:
        return jsonify({'ok': True, **stats})

    # 1. availabilities 重複排除
    #    同 member_id + date で複数行ある場合、id が最大（最新）のもの以外を削除
    avails = Availability.query.filter(
        Availability.member_id.in_(member_ids)
    ).order_by(Availability.member_id, Availability.date, Availability.id).all()

    seen = {}  # (member_id, date) -> keep_id
    delete_ids = []
    for a in avails:
        key = (a.member_id, a.date)
        if key in seen:
            # 古い方を削除対象に
            delete_ids.append(seen[key])
        seen[key] = a.id

    if delete_ids:
        deleted = Availability.query.filter(Availability.id.in_(delete_ids)).delete(synchronize_session=False)
        stats['dedup_avail'] = deleted

    # 2. イベント日程外の行を削除
    start, end = event.start_date, event.end_date
    out_avail = Availability.query.filter(
        Availability.member_id.in_(member_ids),
        (Availability.date < start) | (Availability.date > end)
    ).delete(synchronize_session=False)

    out_abs = ShiftAbsence.query.filter(
        ShiftAbsence.event_id == event_id,
        (ShiftAbsence.date < start) | (ShiftAbsence.date > end)
    ).delete(synchronize_session=False)

    stats['out_of_range'] = out_avail + out_abs

    db.session.flush()

    # 3. JSON TEXT カラムのコンパクト化（既存データ）
    compacted = 0

    def compact_col(obj, attr):
        nonlocal compacted
        val = getattr(obj, attr)
        if not val:
            return
        try:
            parsed = _builtin_json.loads(val)
            compact = _jdump(parsed)
            if compact != val:
                setattr(obj, attr, compact)
                compacted += 1
        except Exception:
            pass

    compact_col(event, 'day_labels_json')

    for job in JobType.query.filter_by(event_id=event_id).all():
        compact_col(job, 'requirements_json')
        compact_col(job, 'allowed_departments_json')

    for absence in ShiftAbsence.query.filter_by(event_id=event_id).all():
        compact_col(absence, 'absent_times')

    stats['json_compacted'] = compacted

    db.session.commit()

    # 4. VACUUM ANALYZE（テーブル単位）
    try:
        tables = ['availabilities', 'shift_absences', 'shift_assignments',
                  'shift_slots', 'event_members', 'job_types']
        with db.engine.connect().execution_options(isolation_level='AUTOCOMMIT') as conn:
            for t in tables:
                conn.execute(text(f'VACUUM ANALYZE {t}'))
        stats['vacuum'] = True
    except Exception:
        pass  # VACUUM は権限不足でも他の処理は完了済み

    return jsonify({'ok': True, **stats})


# ── API: Stats ────────────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/stats', methods=['GET'])
@login_required
def api_stats(event_id):
    event = _can_access_event(event_id)
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
    _can_access_event(event_id)
    members = EventMember.query.filter_by(event_id=event_id).all()
    result = {}
    for m in members:
        result[m.id] = [a.to_dict() for a in m.availabilities]
    return jsonify(result)


# ── API: Notifications ────────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/notifications', methods=['GET'])
@login_required
def api_notifications(event_id):
    _can_access_event(event_id)
    today = date.today()
    hide_resolved_before = datetime.utcnow() - timedelta(minutes=15)
    assignments = (
        ShiftAssignment.query
        .join(ShiftSlot)
        .filter(
            ShiftSlot.event_id == event_id,
            ShiftSlot.date >= today,
            ShiftAssignment.status.in_(['absent', 'late']),
            ShiftAssignment.reported_at.isnot(None),
            db.or_(
                ShiftAssignment.resolved_at.is_(None),
                ShiftAssignment.resolved_at >= hide_resolved_before,
            ),
        )
        .order_by(ShiftAssignment.resolved_at.asc().nullsfirst(), ShiftAssignment.reported_at.desc())
        .all()
    )
    jobs = {j.id: j for j in JobType.query.filter_by(event_id=event_id).all()}
    members = {m.id: m for m in EventMember.query.filter_by(event_id=event_id).all()}
    result = []
    for a in assignments:
        slot = a.slot
        m = members.get(a.member_id)
        job = jobs.get(slot.job_type_id)
        result.append({
            'assignment_id': a.id,
            'member_name': m.name if m else '',
            'member_department': m.department if m else '',
            'date': slot.date.isoformat(),
            'start_time': slot.start_time.strftime('%H:%M'),
            'end_time': slot.end_time.strftime('%H:%M'),
            'role': slot.role or '',
            'location': slot.location or '',
            'status': a.status,
            'note': a.note or '',
            'reported_at': a.reported_at.isoformat() if a.reported_at else None,
            'resolved': a.resolved_at is not None,
            'job_color': job.color if job else '#4DA3FF',
        })
    return jsonify(result)


@admin_bp.route('/api/events/<int:event_id>/notifications/<int:assignment_id>/resolve', methods=['POST'])
@login_required
def api_resolve_notification(event_id, assignment_id):
    _can_access_event(event_id)
    a = ShiftAssignment.query.join(ShiftSlot).filter(
        ShiftAssignment.id == assignment_id,
        ShiftSlot.event_id == event_id,
    ).first_or_404()
    a.resolved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({'ok': True})


# ── API: Shift Absences ───────────────────────────────────────────────────────

@admin_bp.route('/api/events/<int:event_id>/absences', methods=['GET'])
@login_required
def api_get_absences(event_id):
    _can_access_event(event_id)
    absences = ShiftAbsence.query.filter_by(event_id=event_id).all()
    return jsonify([a.to_dict() for a in absences])


@admin_bp.route('/api/events/<int:event_id>/absences', methods=['POST'])
@login_required
def api_set_absence(event_id):
    _can_access_event(event_id)
    data = request.get_json()
    member_id = data.get('member_id')
    is_full_day = bool(data.get('is_full_day', False))
    absent_times = data.get('absent_times', [])
    try:
        absence_date = date.fromisoformat(data.get('date', ''))
    except (ValueError, TypeError):
        return jsonify({'error': '日付の形式が正しくありません'}), 400

    absence = ShiftAbsence.query.filter_by(
        event_id=event_id, member_id=member_id, date=absence_date
    ).first()
    if absence is None:
        absence = ShiftAbsence(event_id=event_id, member_id=member_id, date=absence_date)
        db.session.add(absence)
    absence.is_full_day = is_full_day
    absence.absent_times = _jdump(absent_times) if absent_times else None
    db.session.commit()
    return jsonify(absence.to_dict())


@admin_bp.route('/api/events/<int:event_id>/absences', methods=['DELETE'])
@login_required
def api_delete_absence(event_id):
    _can_access_event(event_id)
    data = request.get_json()
    member_id = data.get('member_id')
    try:
        absence_date = date.fromisoformat(data.get('date', ''))
    except (ValueError, TypeError):
        return jsonify({'error': '日付の形式が正しくありません'}), 400

    absence = ShiftAbsence.query.filter_by(
        event_id=event_id, member_id=member_id, date=absence_date
    ).first()
    if absence:
        db.session.delete(absence)
        db.session.commit()
    return jsonify({'ok': True})
