-- =============================================================================
-- ClearShift Schema
-- PostgreSQL用 CREATE TABLE定義
-- 使用方法: psql -U <user> -d <dbname> -f schema.sql
-- =============================================================================

-- ユーザー（管理者・シフト作成者）
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100)  NOT NULL,
    email         VARCHAR(200)  NOT NULL UNIQUE,
    password_hash VARCHAR(256)  NOT NULL,
    created_at    TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- イベント（シフト全体）
CREATE TABLE IF NOT EXISTS events (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(200) NOT NULL,
    description     TEXT,
    start_date      DATE         NOT NULL,
    end_date        DATE         NOT NULL,
    creator_id      INTEGER      NOT NULL REFERENCES users(id),
    created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
    share_token     VARCHAR(64)  UNIQUE,
    day_labels_json TEXT                              -- {"YYYY-MM-DD": "日程名", ...}
);

-- 共同編集者
CREATE TABLE IF NOT EXISTS event_collaborators (
    id         SERIAL PRIMARY KEY,
    event_id   INTEGER   NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    INTEGER   NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    joined_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, user_id)
);

-- イベントメンバー
CREATE TABLE IF NOT EXISTS event_members (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(200),
    grade       VARCHAR(50),
    department  VARCHAR(100),
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    is_leader   BOOLEAN      NOT NULL DEFAULT FALSE,
    labels_json TEXT                              -- ["飲食代表", "OO代表", ...]
);

-- 仕事カテゴリー（メンバーグループ定義）
CREATE TABLE IF NOT EXISTS job_categories (
    id         SERIAL PRIMARY KEY,
    event_id   INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- カテゴリー ↔ メンバー 中間テーブル
CREATE TABLE IF NOT EXISTS job_category_members (
    id          SERIAL PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES job_categories(id) ON DELETE CASCADE,
    member_id   INTEGER NOT NULL REFERENCES event_members(id)  ON DELETE CASCADE,
    UNIQUE (category_id, member_id)
);

-- 仕事定義（シフト枠に紐づく仕事種別）
CREATE TABLE IF NOT EXISTS job_types (
    id                      SERIAL PRIMARY KEY,
    event_id                INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    category_id             INTEGER               REFERENCES job_categories(id) ON DELETE SET NULL,
    title                   VARCHAR(100) NOT NULL,
    description             TEXT,
    location                VARCHAR(200),
    required_count          INTEGER      NOT NULL DEFAULT 1,
    color                   VARCHAR(7)   NOT NULL DEFAULT '#4DA3FF',
    requirements_json       TEXT,                 -- {"interval": 30, "counts": {"09:00": 2, ...}}
    allowed_departments_json TEXT,                -- ["音響局", "技術局"]
    created_at              TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- シフト枠
CREATE TABLE IF NOT EXISTS shift_slots (
    id             SERIAL PRIMARY KEY,
    event_id       INTEGER      NOT NULL REFERENCES events(id)    ON DELETE CASCADE,
    job_type_id    INTEGER               REFERENCES job_types(id) ON DELETE SET NULL,
    date           DATE         NOT NULL,
    start_time     TIME         NOT NULL,
    end_time       TIME         NOT NULL,
    role           VARCHAR(100),
    location       VARCHAR(200),
    required_count INTEGER      NOT NULL DEFAULT 1,
    note           TEXT,
    created_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- シフト割り当て
CREATE TABLE IF NOT EXISTS shift_assignments (
    id          SERIAL PRIMARY KEY,
    slot_id     INTEGER     NOT NULL REFERENCES shift_slots(id)   ON DELETE CASCADE,
    member_id   INTEGER     NOT NULL REFERENCES event_members(id) ON DELETE CASCADE,
    status      VARCHAR(50) NOT NULL DEFAULT 'scheduled',         -- scheduled | absent | late
    note        TEXT,
    reported_at TIMESTAMP,
    resolved_at TIMESTAMP,
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- 欠席マーク（シフトボード表示用）
CREATE TABLE IF NOT EXISTS shift_absences (
    id           SERIAL PRIMARY KEY,
    event_id     INTEGER   NOT NULL REFERENCES events(id)       ON DELETE CASCADE,
    member_id    INTEGER   NOT NULL REFERENCES event_members(id) ON DELETE CASCADE,
    date         DATE      NOT NULL,
    is_full_day  BOOLEAN   NOT NULL DEFAULT FALSE,
    absent_times TEXT,                                           -- JSON list ["HH:MM", ...]
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, member_id, date)
);

-- 参加希望（メンバー提出）
CREATE TABLE IF NOT EXISTS availabilities (
    id           SERIAL PRIMARY KEY,
    member_id    INTEGER   NOT NULL REFERENCES event_members(id) ON DELETE CASCADE,
    date         DATE      NOT NULL,
    available    BOOLEAN   NOT NULL DEFAULT TRUE,
    note         TEXT,
    submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- インデックス（低速回線でも高速にレスポンスを返すためのクエリ最適化）
-- =============================================================================

-- シフト枠：イベント+日付での絞り込み（管理画面・ビューアー共通の最重要クエリ）
CREATE INDEX IF NOT EXISTS idx_shift_slots_event_date    ON shift_slots      (event_id, date);
-- シフト枠：イベント単体での全件取得（shift-data エンドポイント）
CREATE INDEX IF NOT EXISTS idx_shift_slots_event_id      ON shift_slots      (event_id);

-- シフト割り当て：スロットへの JOIN（最も頻繁に使われる結合）
CREATE INDEX IF NOT EXISTS idx_shift_assignments_slot    ON shift_assignments (slot_id);
-- シフト割り当て：メンバーのシフト一覧取得（ビューアーの my-shifts）
CREATE INDEX IF NOT EXISTS idx_shift_assignments_member  ON shift_assignments (member_id);
-- シフト割り当て：スロット+メンバーの複合（重複チェック・idempotent 処理）
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_assignments_slot_member ON shift_assignments (slot_id, member_id);

-- メンバー：イベント所属検索
CREATE INDEX IF NOT EXISTS idx_event_members_event       ON event_members     (event_id);
-- メンバー：名前・メールでのビューアーログイン検索
CREATE INDEX IF NOT EXISTS idx_event_members_name        ON event_members     (event_id, name);
CREATE INDEX IF NOT EXISTS idx_event_members_email       ON event_members     (event_id, email);

-- 仕事定義：イベント所属検索
CREATE INDEX IF NOT EXISTS idx_job_types_event           ON job_types         (event_id);

-- 参加希望：メンバー+日付での絞り込み
CREATE INDEX IF NOT EXISTS idx_availabilities_member     ON availabilities    (member_id);
CREATE INDEX IF NOT EXISTS idx_availabilities_member_date ON availabilities   (member_id, date);

-- 欠席マーク：イベント・日付での絞り込み
CREATE INDEX IF NOT EXISTS idx_shift_absences_event      ON shift_absences    (event_id);
CREATE INDEX IF NOT EXISTS idx_shift_absences_event_date ON shift_absences    (event_id, date);
