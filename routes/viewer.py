from flask import Blueprint, render_template, redirect, url_for, request, jsonify, session
from models import db, Event, EventMember, ShiftSlot, ShiftAssignment, Availability
from datetime import date

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

    result = []
    for a in assignments:
        slot = a.slot
        result.append({
            'date': slot.date.isoformat(),
            'start_time': slot.start_time.strftime('%H:%M'),
            'end_time': slot.end_time.strftime('%H:%M'),
            'role': slot.role,
            'location': slot.location,
            'status': a.status,
            'note': a.note,
        })
    return jsonify(result)


@viewer_bp.route('/event/<int:event_id>/api/all-shifts')
def api_all_shifts(event_id):
    event = Event.query.get_or_404(event_id)
    member = get_current_viewer(event_id)
    if not member:
        return jsonify({'error': 'ログインしてください。'}), 401

    slots = ShiftSlot.query.filter_by(event_id=event_id).order_by(ShiftSlot.date, ShiftSlot.start_time).all()
    return jsonify([s.to_dict() for s in slots])


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
