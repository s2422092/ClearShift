from flask import Blueprint, render_template, redirect, url_for, request, flash, session
from flask_login import login_user, logout_user, login_required, current_user
from models import db, User
from extensions import limiter

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['GET', 'POST'])
@limiter.limit("10 per minute")
def login():
    if current_user.is_authenticated:
        return redirect(url_for('admin.dashboard'))
    if request.method == 'POST':
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        user = User.query.filter_by(email=email).first()
        if user and user.check_password(password):
            login_user(user)
            next_page = request.args.get('next')
            return redirect(next_page or url_for('admin.dashboard'))
        flash('メールアドレスまたはパスワードが正しくありません。', 'error')
    return render_template('auth/login.html')


@auth_bp.route('/register', methods=['GET', 'POST'])
@limiter.limit("5 per minute")
def register():
    if current_user.is_authenticated:
        return redirect(url_for('admin.dashboard'))
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        email = request.form.get('email', '').strip().lower()
        email_confirm = request.form.get('email_confirm', '').strip().lower()
        password = request.form.get('password', '')

        if not name or not email or not password:
            flash('全ての項目を入力してください。', 'error')
            return render_template('auth/register.html')

        if email != email_confirm:
            flash('メールアドレスが一致しません。', 'error')
            return render_template('auth/register.html')

        if User.query.filter_by(email=email).first():
            flash('このメールアドレスは既に登録されています。', 'error')
            return render_template('auth/register.html')

        user = User(name=name, email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        login_user(user)
        return redirect(url_for('admin.dashboard'))
    return render_template('auth/register.html')


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('main.landing'))
