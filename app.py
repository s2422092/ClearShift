import os
import time
from flask import Flask, jsonify, request
from flask_login import LoginManager
from flask_compress import Compress
from config import Config
from models import db, User
from extensions import cache, limiter

APP_START_TIME = str(int(time.time()))


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # 拡張機能の初期化
    db.init_app(app)
    Compress(app)
    cache.init_app(app)

    # レートリミッター: Redis が設定されていればそちらを使用、なければメモリ
    _redis_url = app.config.get('CACHE_REDIS_URL', '')
    app.config['RATELIMIT_STORAGE_URI'] = _redis_url if _redis_url else 'memory://'
    limiter.init_app(app)

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
    from routes.cron import cron_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(viewer_bp)
    app.register_blueprint(cron_bp)

    def _is_api_request():
        """API パスへのリクエストかどうかを判定（パス優先・Content-Type 不問）"""
        return request.path.startswith('/api/')

    # Flask-Login: セッション切れ時、API なら HTML リダイレクトではなく JSON 401 を返す
    @login_manager.unauthorized_handler
    def unauthorized():
        if _is_api_request():
            return jsonify({'error': 'ログインが必要です。ページを再読み込みしてください。'}), 401
        from flask import redirect, url_for
        return redirect(url_for('auth.login', next=request.url))

    # エラーハンドラー
    @app.errorhandler(429)
    def rate_limit_exceeded(e):
        if _is_api_request():
            return jsonify({'error': 'リクエストが多すぎます。しばらくお待ちください。'}), 429
        return 'Too Many Requests', 429

    @app.errorhandler(400)
    def bad_request(e):
        if _is_api_request():
            return jsonify({'error': 'リクエストが不正です。'}), 400
        return 'Bad Request', 400

    @app.errorhandler(403)
    def forbidden(e):
        if _is_api_request():
            return jsonify({'error': 'アクセス権がありません。'}), 403
        return 'Forbidden', 403

    @app.errorhandler(404)
    def not_found(e):
        if _is_api_request():
            return jsonify({'error': 'リソースが見つかりません。'}), 404
        return 'Not Found', 404

    @app.errorhandler(500)
    def internal_error(e):
        db.session.rollback()
        if _is_api_request():
            return jsonify({'error': 'サーバーエラーが発生しました。しばらく後に再試行してください。'}), 500
        return 'Internal Server Error', 500

    @app.teardown_appcontext
    def shutdown_session(exception=None):
        db.session.remove()

    # ローカル開発時のみ db.create_all() を実行する。
    # Vercel（サーバーレス）では毎回 DB 接続が発生して冷間起動が遅くなるためスキップ。
    # Vercel 本番では schema.sql を Supabase に直接適用してスキーマを管理する。
    if not os.environ.get('VERCEL'):
        with app.app_context():
            db.create_all()
            # labels_json カラムが未存在なら追加（既存 DB への後付けマイグレーション）
            try:
                db.session.execute(db.text(
                    "ALTER TABLE event_members ADD COLUMN labels_json TEXT"
                ))
                db.session.commit()
            except Exception:
                db.session.rollback()
            try:
                db.session.execute(db.text(
                    "ALTER TABLE events ADD COLUMN custom_link_url VARCHAR(1000)"
                ))
                db.session.execute(db.text(
                    "ALTER TABLE events ADD COLUMN custom_link_label VARCHAR(100)"
                ))
                db.session.commit()
            except Exception:
                db.session.rollback()  # 既に存在する場合は無視

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
