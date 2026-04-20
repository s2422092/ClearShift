from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
import secrets


db = SQLAlchemy()


class User(UserMixin, db.Model):
    """管理者ユーザー（シフト作成者）"""
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(200), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    events = db.relationship('Event', backref='creator', lazy=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {'id': self.id, 'name': self.name, 'email': self.email}


class Event(db.Model):
    """シフトイベント"""
    __tablename__ = 'events'
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text)
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=False)
    creator_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    share_token = db.Column(db.String(64), unique=True, nullable=True)
    day_labels_json = db.Column(db.Text, nullable=True)  # {"2024-11-01": "大学祭1日目", ...}

    members = db.relationship('EventMember', backref='event', lazy=True, cascade='all, delete-orphan')
    slots = db.relationship('ShiftSlot', backref='event', lazy=True, cascade='all, delete-orphan')
    collaborators = db.relationship('EventCollaborator', backref='event', lazy=True, cascade='all, delete-orphan')

    def generate_share_token(self):
        self.share_token = secrets.token_urlsafe(24)

    def get_day_labels(self):
        import json
        if self.day_labels_json:
            try:
                return json.loads(self.day_labels_json)
            except Exception:
                return {}
        return {}

    def to_dict(self):
        return {
            'id': self.id,
            'title': self.title,
            'description': self.description,
            'start_date': self.start_date.isoformat(),
            'end_date': self.end_date.isoformat(),
            'creator_id': self.creator_id,
            'created_at': self.created_at.isoformat(),
            'member_count': len(self.members),
            'share_token': self.share_token,
            'day_labels': self.get_day_labels(),
        }


class EventCollaborator(db.Model):
    """イベント共同編集者"""
    __tablename__ = 'event_collaborators'
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('events.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)
    __table_args__ = (db.UniqueConstraint('event_id', 'user_id'),)


class EventMember(db.Model):
    """イベントメンバー（シフト閲覧者）"""
    __tablename__ = 'event_members'
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('events.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(200))
    grade = db.Column(db.String(50))    # 学年
    department = db.Column(db.String(100))  # 局
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    is_leader = db.Column(db.Boolean, default=False, nullable=False)
    labels_json = db.Column(db.Text, nullable=True)  # ["飲食代表", "OO代表", ...]

    availabilities = db.relationship('Availability', backref='member', lazy=True, cascade='all, delete-orphan')
    assignments = db.relationship('ShiftAssignment', backref='member', lazy=True, cascade='all, delete-orphan')

    def get_labels(self):
        import json
        if self.labels_json:
            try:
                return json.loads(self.labels_json)
            except Exception:
                return []
        return []

    def to_dict(self):
        return {
            'id': self.id,
            'event_id': self.event_id,
            'name': self.name,
            'email': self.email,
            'grade': self.grade,
            'department': self.department,
            'is_leader': self.is_leader,
            'labels': self.get_labels(),
        }


class ShiftSlot(db.Model):
    """シフト枠"""
    __tablename__ = 'shift_slots'
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('events.id'), nullable=False)
    job_type_id = db.Column(db.Integer, db.ForeignKey('job_types.id', ondelete='SET NULL'), nullable=True)
    date = db.Column(db.Date, nullable=False)
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    role = db.Column(db.String(100))        # 役割・ポジション
    location = db.Column(db.String(200))    # 場所
    required_count = db.Column(db.Integer, default=1)
    note = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    assignments = db.relationship('ShiftAssignment', backref='slot', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'event_id': self.event_id,
            'job_type_id': self.job_type_id,
            'date': self.date.isoformat(),
            'start_time': self.start_time.strftime('%H:%M'),
            'end_time': self.end_time.strftime('%H:%M'),
            'role': self.role,
            'location': self.location,
            'required_count': self.required_count,
            'note': self.note,
            'assignments': [a.to_dict() for a in self.assignments],
        }


class ShiftAssignment(db.Model):
    """シフト割り当て"""
    __tablename__ = 'shift_assignments'
    id = db.Column(db.Integer, primary_key=True)
    slot_id = db.Column(db.Integer, db.ForeignKey('shift_slots.id'), nullable=False)
    member_id = db.Column(db.Integer, db.ForeignKey('event_members.id'), nullable=False)
    status = db.Column(db.String(50), default='scheduled')  # scheduled, absent, late
    note = db.Column(db.Text)
    reported_at = db.Column(db.DateTime, nullable=True)
    resolved_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'slot_id': self.slot_id,
            'member_id': self.member_id,
            'member_name': self.member.name if self.member else None,
            'member_department': self.member.department if self.member else None,
            'status': self.status,
            'note': self.note,
            'reported_at': self.reported_at.isoformat() if self.reported_at else None,
        }


class JobCategory(db.Model):
    """仕事カテゴリー（メンバーグループ定義）"""
    __tablename__ = 'job_categories'
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('events.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    category_members = db.relationship(
        'JobCategoryMember', backref='category', lazy=True, cascade='all, delete-orphan'
    )

    def get_member_ids(self):
        return [cm.member_id for cm in self.category_members]

    def to_dict(self):
        return {
            'id': self.id,
            'event_id': self.event_id,
            'name': self.name,
            'member_ids': self.get_member_ids(),
        }


class JobCategoryMember(db.Model):
    """カテゴリー ↔ メンバー の中間テーブル"""
    __tablename__ = 'job_category_members'
    id = db.Column(db.Integer, primary_key=True)
    category_id = db.Column(db.Integer, db.ForeignKey('job_categories.id', ondelete='CASCADE'), nullable=False)
    member_id = db.Column(db.Integer, db.ForeignKey('event_members.id', ondelete='CASCADE'), nullable=False)
    __table_args__ = (db.UniqueConstraint('category_id', 'member_id'),)


class JobType(db.Model):
    """仕事定義（シフト枠に紐づくカテゴリ）"""
    __tablename__ = 'job_types'
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('events.id'), nullable=False)
    category_id = db.Column(db.Integer, db.ForeignKey('job_categories.id', ondelete='SET NULL'), nullable=True)
    title = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text)
    location = db.Column(db.String(200))
    required_count = db.Column(db.Integer, default=1)
    color = db.Column(db.String(7), nullable=False, default='#4DA3FF')
    requirements_json = db.Column(db.Text, nullable=True)
    allowed_departments_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def get_requirements(self):
        import json
        if self.requirements_json:
            try:
                return json.loads(self.requirements_json)
            except Exception:
                return None
        return None

    def get_allowed_departments(self):
        """担当可能な局リストを返す（空リスト=制限なし）"""
        import json
        if self.allowed_departments_json:
            try:
                return json.loads(self.allowed_departments_json)
            except Exception:
                return []
        return []

    def to_dict(self):
        return {
            'id': self.id,
            'event_id': self.event_id,
            'title': self.title,
            'description': self.description,
            'location': self.location,
            'required_count': self.required_count,
            'color': self.color,
            'requirements': self.get_requirements(),
            'allowed_departments': self.get_allowed_departments(),
        }


class ShiftAbsence(db.Model):
    """シフトボードの欠席マーク（管理画面表示用）"""
    __tablename__ = 'shift_absences'
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('events.id'), nullable=False)
    member_id = db.Column(db.Integer, db.ForeignKey('event_members.id'), nullable=False)
    date = db.Column(db.Date, nullable=False)
    is_full_day = db.Column(db.Boolean, default=False, nullable=False)
    absent_times = db.Column(db.Text, nullable=True)  # JSON list of "HH:MM"
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    __table_args__ = (db.UniqueConstraint('event_id', 'member_id', 'date'),)

    def to_dict(self):
        import json
        return {
            'member_id': self.member_id,
            'date': self.date.isoformat(),
            'is_full_day': self.is_full_day,
            'absent_times': json.loads(self.absent_times) if self.absent_times else [],
        }


class Availability(db.Model):
    """参加可否（希望提出）"""
    __tablename__ = 'availabilities'
    id = db.Column(db.Integer, primary_key=True)
    member_id = db.Column(db.Integer, db.ForeignKey('event_members.id'), nullable=False)
    date = db.Column(db.Date, nullable=False)
    available = db.Column(db.Boolean, default=True)
    note = db.Column(db.Text)
    submitted_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'member_id': self.member_id,
            'date': self.date.isoformat(),
            'available': self.available,
            'note': self.note,
        }
