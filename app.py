import os
import time
from flask import Flask, jsonify, request
from flask_login import LoginManager
from flask_compress import Compress
from config import Config
from models import db, User

APP_START_TIME = str(int(time.time()))


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # 拡張機能の初期化
    db.init_app(app)
    Compress(app)

    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    login_manager.login_message = 'ログインが必要です。'
    login_manager.login_message_category = 'warning'

    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    # キャッシュバスティング用バージョンをテンプレートに注入
    @app.context_processor
    def inject_version():
        return {'app_version': APP_START_TIME}

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
            conn.commit()

    return app


app = create_app()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, port=port)
