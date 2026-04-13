import os
import time
from flask import Flask, jsonify, request
from flask_login import LoginManager
from flask_compress import Compress
from flask_caching import Cache
from config import Config
from models import db, User

cache = Cache()

APP_START_TIME = str(int(time.time()))


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # 拡張機能の初期化
    db.init_app(app)
    Compress(app)
    cache.init_app(app)

    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    login_manager.login_message = 'ログインが必要です。'
    login_manager.login_message_category = 'warning'

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    # キャッシュバスティング用バージョン + サブパス対応ルートをテンプレートに注入
    @app.context_processor
    def inject_globals():
        return {
            'app_version': APP_START_TIME,
            'app_root': request.script_root,  # サブパスデプロイ時のプレフィックス（通常は空文字）
        }

    # 静的ファイルに長期キャッシュ（バージョンクエリ付き URL を前提）
    @app.after_request
    def set_cache_headers(response):
        if request.path.startswith('/static/'):
            response.cache_control.max_age = 31536000  # 1年
            response.cache_control.public = True
            response.cache_control.immutable = True
        return response

    # Blueprint の登録
    from routes.main import main_bp
    from routes.auth import auth_bp
    from routes.admin import admin_bp
    from routes.viewer import viewer_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(viewer_bp)

    # エラーハンドラー
    @app.errorhandler(400)
    def bad_request(e):
        if request.is_json:
            return jsonify({'error': 'Bad Request'}), 400
        return 'Bad Request', 400

    @app.errorhandler(403)
    def forbidden(e):
        if request.is_json:
            return jsonify({'error': 'Forbidden'}), 403
        return 'Forbidden', 403

    @app.errorhandler(404)
    def not_found(e):
        if request.is_json:
            return jsonify({'error': 'Not Found'}), 404
        return 'Not Found', 404

    @app.errorhandler(500)
    def internal_error(e):
        db.session.rollback()
        if request.is_json:
            return jsonify({'error': 'Internal Server Error'}), 500
        return 'Internal Server Error', 500

    @app.teardown_appcontext
    def shutdown_session(exception=None):
        db.session.remove()

    # テーブルの自動作成 + カラム追加マイグレーション
    with app.app_context():
        db.create_all()
        from sqlalchemy import text
        with db.engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE job_types ADD COLUMN IF NOT EXISTS color VARCHAR(7) NOT NULL DEFAULT '#4DA3FF'"
            ))
            conn.execute(text(
                "ALTER TABLE shift_slots ADD COLUMN IF NOT EXISTS job_type_id INTEGER REFERENCES job_types(id) ON DELETE SET NULL"
            ))
            conn.execute(text(
                "ALTER TABLE event_members ADD COLUMN IF NOT EXISTS is_leader BOOLEAN NOT NULL DEFAULT FALSE"
            ))
            conn.execute(text(
                "ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS reported_at TIMESTAMP"
            ))
            conn.execute(text(
                "ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP"
            ))
            conn.execute(text(
                "ALTER TABLE job_types ADD COLUMN IF NOT EXISTS requirements_json TEXT"
            ))
            conn.execute(text(
                "ALTER TABLE job_types ADD COLUMN IF NOT EXISTS allowed_departments_json TEXT"
            ))
            conn.execute(text(
                "ALTER TABLE events ADD COLUMN IF NOT EXISTS day_labels_json TEXT"
            ))
            conn.execute(text(
                "ALTER TABLE job_types ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES job_categories(id) ON DELETE SET NULL"
            ))
            # 低速回線でも高速に返せるよう主要クエリにインデックスを付与
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_shift_slots_event_date     ON shift_slots (event_id, date)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_shift_assignments_slot      ON shift_assignments (slot_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_shift_assignments_member    ON shift_assignments (member_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_event_members_event         ON event_members (event_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_availabilities_member       ON availabilities (member_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_shift_absences_event        ON shift_absences (event_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_job_types_event             ON job_types (event_id)"))
            conn.commit()

        # 起動時に既存JSONカラムをコンパクト化（ホワイトスペース除去）
        _compact_existing_json(app)

    return app


def _compact_existing_json(app):
    """既存のJSON TEXTカラムから余分な空白を除去してDB容量を削減する"""
    import json as _json
    from models import Event, JobType, ShiftAbsence

    def _rewrite(obj, attr):
        val = getattr(obj, attr)
        if not val:
            return False
        try:
            compact = _json.dumps(_json.loads(val), ensure_ascii=False, separators=(',', ':'))
            if compact != val:
                setattr(obj, attr, compact)
                return True
        except Exception:
            pass
        return False

    with app.app_context():
        changed = False
        for ev in Event.query.filter(Event.day_labels_json.isnot(None)).all():
            changed |= _rewrite(ev, 'day_labels_json')
        for job in JobType.query.filter(
            (JobType.requirements_json.isnot(None)) | (JobType.allowed_departments_json.isnot(None))
        ).all():
            changed |= _rewrite(job, 'requirements_json')
            changed |= _rewrite(job, 'allowed_departments_json')
        for ab in ShiftAbsence.query.filter(ShiftAbsence.absent_times.isnot(None)).all():
            changed |= _rewrite(ab, 'absent_times')
        if changed:
            db.session.commit()


app = create_app()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, port=port)
