"""
シフト表グリッド（時間軸 × メンバー）の共通集計ロジック。

Excel エクスポートと Google Sheets 同期の両方がこのモジュールを使い、
DBから取得した生の行を日付ごとの描画しやすい構造へ変換する。
両者で同じ並び順・同じ時間軸になることを保証するのが目的。
"""
import re
from collections import defaultdict

DEFAULT_JOB_COLOR = '#4DA3FF'


def _grade_num(grade):
    """学年文字列を数値化（ソート用）"""
    if not grade:
        return 0
    m = re.search(r'\d+', grade)
    return int(m.group()) if m else 0


def _hex_to_rgb(hex_color):
    """#RRGGBB → (R, G, B) 0-255"""
    h = (hex_color or '').lstrip('#')
    if len(h) != 6:
        h = DEFAULT_JOB_COLOR.lstrip('#')
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        h = DEFAULT_JOB_COLOR.lstrip('#')
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _normalize_color(color):
    """
    job_color を "#RRGGBB" 形式に正規化する。

    不正な値をそのまま描画層へ渡すと xlsxwriter が例外を投げるため、
    ここで既定色にフォールバックさせる。大文字小文字は変換しない。
    """
    h = (color or '').lstrip('#')
    if len(h) == 6:
        try:
            int(h, 16)
            return f'#{h}'
        except ValueError:
            pass
    return DEFAULT_JOB_COLOR


def _lighten(hex_color, factor=0.25):
    """カラーを薄くして塗り色用に返す（先頭の # は付けない）"""
    r, g, b = _hex_to_rgb(hex_color)
    r2 = int(r + (255 - r) * (1 - factor))
    g2 = int(g + (255 - g) * (1 - factor))
    b2 = int(b + (255 - b) * (1 - factor))
    return f'{r2:02X}{g2:02X}{b2:02X}'


class DayGrid:
    """1日分のシフト表グリッド。

    属性:
        date_str      "YYYY-MM-DD"
        label         日程名（"大学祭1日目" など。無ければ空文字）
        month, day    "MM", "DD"
        date_display  "2024年11月01日　大学祭1日目"
        day_start     その日の表示開始時刻（0時からの分）
        interval_min  1列あたりの分数
        time_cols     列に対応する分のリスト
        dept_order    局名の表示順
        dept_groups   {局名: [(member_id, name, grade, is_leader), ...]}
        member_slots  {member_id: [(slot_id, start_time, end_time, role, job_color), ...]}
    """

    def __init__(self, date_str, label, day_start, interval_min, time_cols,
                 dept_order, dept_groups, member_slots):
        self.date_str = date_str
        self.label = label
        self.day_start = day_start
        self.interval_min = interval_min
        self.time_cols = time_cols
        self.dept_order = dept_order
        self.dept_groups = dept_groups
        self.member_slots = member_slots

        self.month = date_str[5:7]
        self.day = date_str[8:10]
        self.date_display = f'{date_str[:4]}年{self.month}月{self.day}日'
        if label:
            self.date_display += f'　{label}'

    @property
    def n_time(self):
        """時間列の数（メンバー名列は含まない）"""
        return len(self.time_cols)

    @property
    def member_count(self):
        return sum(len(v) for v in self.dept_groups.values())

    def col_index(self, minutes):
        """0時からの分 → 時間列のインデックス（0始まり、メンバー名列は含まない）"""
        return (minutes - self.day_start) // self.interval_min

    def time_label(self, minutes):
        """時間ヘッダーの表示文字列。正時は "9:00"、それ以外は ":30" 形式。"""
        h, m = divmod(minutes, 60)
        return f'{h}:00' if m == 0 else f':{m:02d}'


def build_day_grids(rows, day_labels, all_members=None, interval_min=30):
    """
    DBの生の行から日付ごとの DayGrid を組み立てる。

    Args:
        rows: 各行が以下の列を持つシーケンス
              slot_id, slot_date, start_time, end_time, role, job_color,
              member_id, member_name, member_dept, member_grade, is_leader
        day_labels:   {"YYYY-MM-DD": "日程名", ...}
        all_members:  [(id, name, department, grade, is_leader), ...]
                      シフト未割り当てのメンバーも表に出すために使う。
                      名前順で渡すと、同順位のタイブレークが名前順になる。
        interval_min: 1列あたりの分数

    Returns:
        list[DayGrid]: 日付昇順
    """
    # date_str → {slot_id: (start_time, end_time, role, job_color)}
    slot_info_by_date = defaultdict(dict)
    # date_str → {member_id: (name, dept, grade, is_leader)}
    member_info_by_date = defaultdict(dict)
    # date_str → {member_id: [(slot_id, start_time, end_time, role, job_color), ...]}
    member_slots_by_date = defaultdict(lambda: defaultdict(list))

    for row in rows:
        (slot_id, slot_date, start_time, end_time, role,
         job_color, member_id, member_name, member_dept,
         member_grade, is_leader) = row

        date_str = slot_date.isoformat()

        if slot_id not in slot_info_by_date[date_str]:
            slot_info_by_date[date_str][slot_id] = (
                start_time, end_time, role or '', _normalize_color(job_color)
            )

        if member_id is not None:
            if member_id not in member_info_by_date[date_str]:
                member_info_by_date[date_str][member_id] = (
                    member_name or '', member_dept or '', member_grade or '', bool(is_leader)
                )
            member_slots_by_date[date_str][member_id].append(
                (slot_id, start_time, end_time, role or '', _normalize_color(job_color))
            )

    all_dates = sorted(slot_info_by_date.keys())

    # 全メンバーをシフトがある全日付に追加（未割り当て・欠席者も含めて全員表示）
    # all_members は名前順で渡されるので、挿入順 = 名前順 になる
    # → sorted() の安定ソートでタイブレーク時に名前順が維持される
    if all_members:
        for date_str in all_dates:
            for mid, name, dept, grade, is_leader in all_members:
                # 既に割り当てデータで登録済みの場合は上書きしない
                if mid not in member_info_by_date[date_str]:
                    member_info_by_date[date_str][mid] = (
                        name or '', dept or '', grade or '', bool(is_leader)
                    )

    return [
        _build_one_day(
            date_str,
            day_labels.get(date_str, ''),
            slot_info_by_date[date_str],
            member_info_by_date[date_str],
            member_slots_by_date[date_str],
            interval_min,
        )
        for date_str in all_dates
    ]


def _build_one_day(date_str, label, slot_infos, member_infos, member_slots, interval_min):
    # ── 時間軸の構築 ──────────────────────────────────────────────────────────
    if slot_infos:
        day_start = min((st.hour * 60 + st.minute) for st, _, _, _ in slot_infos.values())
        day_end = max((et.hour * 60 + et.minute) for _, et, _, _ in slot_infos.values())
        # interval_min 単位に丸める
        day_start = (day_start // interval_min) * interval_min
        day_end = ((day_end + interval_min - 1) // interval_min) * interval_min
    else:
        day_start, day_end = 8 * 60, 22 * 60

    time_cols = list(range(day_start, day_end, interval_min))

    # ── メンバーをソートしてグループ化 ────────────────────────────────────────
    # is_leader desc → grade desc → name asc
    sorted_members = sorted(
        member_infos.items(),
        key=lambda x: (
            not x[1][3],           # is_leader desc
            -_grade_num(x[1][2]),  # grade desc
            x[1][0],               # name asc（同学年・同リーダー区分のタイブレーク）
        )
    )

    dept_order = []
    dept_groups = {}
    for mid, (name, dept, grade, is_leader) in sorted_members:
        d = dept or '（未分類）'
        if d not in dept_groups:
            dept_groups[d] = []
            dept_order.append(d)
        dept_groups[d].append((mid, name, grade, is_leader))

    return DayGrid(
        date_str=date_str,
        label=label,
        day_start=day_start,
        interval_min=interval_min,
        time_cols=time_cols,
        dept_order=dept_order,
        dept_groups=dept_groups,
        member_slots=member_slots,
    )
