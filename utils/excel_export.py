"""
Excel エクスポートユーティリティ
xlsxwriter を使い、イベントのシフト表を .xlsx ファイルとして高速生成する。
外部API・認証不要でサーバー側のみで完結する。
"""
import io
from collections import defaultdict
from types import SimpleNamespace

import xlsxwriter

from utils.shift_grid import build_day_grids, _lighten


def export_event_to_excel(event, slots, members, day_labels):
    """
    イベントのシフト表を Excel ファイルとして生成し、bytes を返す。

    Args:
        event:      Event モデルインスタンス
        slots:      ShiftSlot のリスト（assignments が joined-load 済み）
        members:    EventMember のリスト
        day_labels: {"YYYY-MM-DD": "日程名", ...} の dict

    Returns:
        bytes: .xlsx ファイルのバイト列
    """
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {'in_memory': True})
    fmts = _make_formats(wb)

    member_map = {m.id: m for m in members}
    slots_by_date = defaultdict(list)
    for s in slots:
        slots_by_date[s.date.isoformat()].append(s)

    all_dates = sorted(slots_by_date.keys())

    if not all_dates:
        ws = wb.add_worksheet('シフトなし')
        ws.write(0, 0, 'シフト枠が登録されていません。')
        wb.close()
        return buf.getvalue()

    for date_str in all_dates:
        label = day_labels.get(date_str, '')
        month, day = date_str[5:7], date_str[8:10]
        sheet_title = f'{month}-{day} {label}'[:31] if label else f'{month}-{day}'
        ws = wb.add_worksheet(sheet_title)
        _write_day_sheet(
            ws, date_str, label,
            sorted(slots_by_date[date_str], key=lambda s: (s.start_time.strftime('%H:%M'), s.end_time.strftime('%H:%M'))),
            member_map, *fmts,
        )

    wb.close()
    return buf.getvalue()


# 列設定: (ヘッダー名, 列幅)
_COLS = [
    ('開始',      9),
    ('終了',      9),
    ('仕事・役割', 22),
    ('場所',      22),
    ('必要人数',   9),
    ('担当者',    48),
]


def _write_day_sheet(ws, date_str, label, day_slots, member_map,
                     fmt_title, fmt_header,
                     fmt_center_white, fmt_center_stripe,
                     fmt_left_white, fmt_left_stripe,
                     fmt_names_white, fmt_names_stripe):
    n_cols = len(_COLS)

    month, day = date_str[5:7], date_str[8:10]
    date_display = f'{date_str[:4]}年{month}月{day}日'
    if label:
        date_display += f'　{label}'

    # 列幅設定
    for ci, (_, w) in enumerate(_COLS):
        ws.set_column(ci, ci, w)

    # 行1: タイトル
    ws.set_row(0, 28)
    ws.merge_range(0, 0, 0, n_cols - 1, date_display, fmt_title)

    # 行2: ヘッダー
    ws.set_row(1, 20)
    for ci, (col_name, _) in enumerate(_COLS):
        ws.write(1, ci, col_name, fmt_header)

    # 行3〜: データ
    for ri, s in enumerate(day_slots):
        row = 2 + ri
        ws.set_row(row, 22)
        is_stripe = ri % 2 == 1
        fmt_c = fmt_center_stripe if is_stripe else fmt_center_white
        fmt_l = fmt_left_stripe   if is_stripe else fmt_left_white
        fmt_n = fmt_names_stripe  if is_stripe else fmt_names_white

        assigned_names = []
        for a in s.assignments:
            m = member_map.get(a.member_id)
            if m:
                name = m.name
                if m.department:
                    name += f'（{m.department}）'
                assigned_names.append(name)

        ws.write(row, 0, s.start_time.strftime('%H:%M'), fmt_c)
        ws.write(row, 1, s.end_time.strftime('%H:%M'),   fmt_c)
        ws.write(row, 2, s.role or '',                    fmt_l)
        ws.write(row, 3, s.location or '',                fmt_l)
        ws.write(row, 4, s.required_count,                fmt_c)
        ws.write(row, 5,
                 '　'.join(assigned_names) if assigned_names else '（未割り当て）',
                 fmt_n)

    # ヘッダー行を固定
    ws.freeze_panes(2, 0)


def export_event_to_excel_fast(event_title, slot_rows, assignment_rows, member_rows, day_labels):
    """
    軽量なクエリ結果（タプル列）から Excel ファイルを高速生成する。

    Args:
        event_title:      イベントタイトル（文字列）
        slot_rows:        (id, date, start_time, end_time, role, location, required_count) のリスト
        assignment_rows:  (slot_id, member_id) のリスト
        member_rows:      (id, name, department) のリスト
        day_labels:       {"YYYY-MM-DD": "日程名", ...} の dict

    Returns:
        bytes: .xlsx ファイルのバイト列
    """
    # Python側で結合（DB JOINより高速）
    # member_id -> (name, department)
    member_map = {mid: (name, dept) for mid, name, dept in member_rows}

    # slot_id -> [member_id, ...]
    slot_members: dict = defaultdict(list)
    for slot_id, member_id in assignment_rows:
        slot_members[slot_id].append(member_id)

    # date_str -> [slot namespace, ...]
    slots_by_date: dict = defaultdict(list)
    for sid, date, start_time, end_time, role, location, required_count in slot_rows:
        # _write_day_sheet が期待するインターフェースを SimpleNamespace で模倣
        s = SimpleNamespace(
            id=sid,
            date=date,
            start_time=start_time,
            end_time=end_time,
            role=role,
            location=location,
            required_count=required_count,
            # assignments は (member_id,) を持つ軽量オブジェクトのリスト
            assignments=[SimpleNamespace(member_id=mid) for mid in slot_members.get(sid, [])],
        )
        slots_by_date[date.isoformat()].append(s)

    # member_map を _write_day_sheet 向けに変換: id -> オブジェクト
    member_obj_map = {
        mid: SimpleNamespace(name=name, department=dept)
        for mid, (name, dept) in member_map.items()
    }

    # 以降は既存の export_event_to_excel と同じワークブック生成処理
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {'in_memory': True})
    fmts = _make_formats(wb)

    all_dates = sorted(slots_by_date.keys())
    if not all_dates:
        ws = wb.add_worksheet('シフトなし')
        ws.write(0, 0, 'シフト枠が登録されていません。')
    else:
        for date_str in all_dates:
            label = day_labels.get(date_str, '')
            month, day = date_str[5:7], date_str[8:10]
            sheet_title = f'{month}-{day} {label}'[:31] if label else f'{month}-{day}'
            ws = wb.add_worksheet(sheet_title)
            day_slots = sorted(slots_by_date[date_str],
                               key=lambda s: (s.start_time.strftime('%H:%M'), s.end_time.strftime('%H:%M')))
            _write_day_sheet(ws, date_str, label, day_slots, member_obj_map, *fmts)

    wb.close()
    return buf.getvalue()


def export_from_raw_rows(event_title, rows, day_labels):
    """
    単一SQL JOIN の結果行から直接 Excel を生成する（最速版）。

    rows の各行は以下の列を持つ:
      slot_id, slot_date, start_time, end_time, role, location,
      required_count, member_id, member_name, member_dept

    Returns:
        bytes: .xlsx ファイルのバイト列
    """
    # Python側で集約（1パスで完結）
    from collections import OrderedDict

    # slot_id -> slot情報 (OrderedDict でDBのORDER BY を維持)
    slot_info = OrderedDict()
    # slot_id -> [(member_name, member_dept), ...]
    slot_members: dict = defaultdict(list)

    for row in rows:
        sid       = row[0]
        slot_date = row[1]
        start_time = row[2]
        end_time   = row[3]
        role       = row[4]
        location   = row[5]
        req_count  = row[6]
        member_id  = row[7]
        member_name = row[8]
        member_dept = row[9]

        if sid not in slot_info:
            slot_info[sid] = (slot_date, start_time, end_time, role, location, req_count)
        if member_id is not None:
            slot_members[sid].append((member_name or '', member_dept or ''))

    # date_str -> [slot_id, ...]
    slots_by_date: dict = defaultdict(list)
    for sid, (slot_date, *_) in slot_info.items():
        slots_by_date[slot_date.isoformat()].append(sid)

    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {'in_memory': True})
    fmts = _make_formats(wb)
    (fmt_title, fmt_header,
     fmt_c_w, fmt_c_s,
     fmt_l_w, fmt_l_s,
     fmt_n_w, fmt_n_s) = fmts

    all_dates = sorted(slots_by_date.keys())

    if not all_dates:
        ws = wb.add_worksheet('シフトなし')
        ws.write(0, 0, 'シフト枠が登録されていません。')
        wb.close()
        return buf.getvalue()

    n_cols = len(_COLS)

    for date_str in all_dates:
        label = day_labels.get(date_str, '')
        month, day_s = date_str[5:7], date_str[8:10]
        sheet_title = f'{month}-{day_s} {label}'[:31] if label else f'{month}-{day_s}'
        ws = wb.add_worksheet(sheet_title)

        # 列幅
        for ci, (_, w) in enumerate(_COLS):
            ws.set_column(ci, ci, w)

        # タイトル行
        date_display = f'{date_str[:4]}年{month}月{day_s}日'
        if label:
            date_display += f'　{label}'
        ws.set_row(0, 28)
        ws.merge_range(0, 0, 0, n_cols - 1, date_display, fmt_title)

        # ヘッダー行
        ws.set_row(1, 20)
        for ci, (col_name, _) in enumerate(_COLS):
            ws.write(1, ci, col_name, fmt_header)

        # データ行
        day_slot_ids = sorted(
            slots_by_date[date_str],
            key=lambda s: (slot_info[s][1].strftime('%H:%M'), slot_info[s][2].strftime('%H:%M'))
        )
        for ri, sid in enumerate(day_slot_ids):
            row_idx = 2 + ri
            ws.set_row(row_idx, 22)
            _, start_time, end_time, role, location, req_count = slot_info[sid]
            is_stripe = ri % 2 == 1
            fmt_c = fmt_c_s if is_stripe else fmt_c_w
            fmt_l = fmt_l_s if is_stripe else fmt_l_w
            fmt_n = fmt_n_s if is_stripe else fmt_n_w

            members = slot_members.get(sid, [])
            names_str = '　'.join(
                f'{n}（{d}）' if d else n for n, d in members
            ) if members else '（未割り当て）'

            ws.write(row_idx, 0, start_time.strftime('%H:%M'), fmt_c)
            ws.write(row_idx, 1, end_time.strftime('%H:%M'),   fmt_c)
            ws.write(row_idx, 2, role or '',                    fmt_l)
            ws.write(row_idx, 3, location or '',                fmt_l)
            ws.write(row_idx, 4, req_count,                     fmt_c)
            ws.write(row_idx, 5, names_str,                     fmt_n)

        ws.freeze_panes(2, 0)

    wb.close()
    return buf.getvalue()


def export_board_style(event_title, rows, day_labels, interval_min=30, all_members=None):
    """
    シフト表と同じグリッドレイアウト（時間軸×メンバー）で Excel を生成する。

    rows の各行は以下の列を持つ:
      slot_id, slot_date, start_time, end_time, role, job_color,
      member_id, member_name, member_dept, member_grade, is_leader

    Returns:
        bytes: .xlsx ファイルのバイト列
    """
    grids = build_day_grids(rows, day_labels, all_members, interval_min)

    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {'in_memory': True})

    # ── 共通フォーマット ──────────────────────────────────────────────────────
    fmt_title = wb.add_format({
        'bold': True, 'font_size': 13, 'font_color': '#FFFFFF',
        'bg_color': '#34609E', 'align': 'center', 'valign': 'vcenter', 'border': 0,
    })
    fmt_time_hour = wb.add_format({
        'bold': True, 'font_size': 9, 'bg_color': '#1E3A5F', 'font_color': '#FFFFFF',
        'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC',
    })
    fmt_time_half = wb.add_format({
        'font_size': 8, 'bg_color': '#2D5A8E', 'font_color': '#CCDDFF',
        'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC',
    })
    fmt_member_name = wb.add_format({
        'bold': True, 'font_size': 10, 'bg_color': '#FFFFFF',
        'align': 'left', 'valign': 'vcenter',
        'border': 1, 'border_color': '#DDDDDD', 'left': 2, 'left_color': '#AAAAAA',
    })
    fmt_member_leader = wb.add_format({
        'bold': True, 'font_size': 10, 'bg_color': '#FEFCE8',
        'align': 'left', 'valign': 'vcenter',
        'border': 1, 'border_color': '#DDDDDD', 'left': 2, 'left_color': '#EAB308',
    })
    fmt_dept = wb.add_format({
        'bold': True, 'font_size': 9, 'bg_color': '#F3F4F6', 'font_color': '#6B7280',
        'align': 'left', 'valign': 'vcenter',
        'border': 1, 'border_color': '#DDDDDD',
    })
    fmt_empty = wb.add_format({
        'bg_color': '#F9FAFB', 'border': 1, 'border_color': '#EEEEEE',
    })
    fmt_empty_hour = wb.add_format({
        'bg_color': '#F3F4F6', 'border': 1, 'border_color': '#DDDDDD',
        'left': 2, 'left_color': '#BBBBBB',
    })

    if not grids:
        ws = wb.add_worksheet('シフトなし')
        ws.write(0, 0, 'シフト枠が登録されていません。')
        wb.close()
        return buf.getvalue()

    for g in grids:
        sheet_title = f'{g.month}-{g.day} {g.label}'[:31] if g.label else f'{g.month}-{g.day}'
        ws = wb.add_worksheet(sheet_title)

        time_cols = g.time_cols
        n_time = g.n_time

        NAME_COL_W = 18
        TIME_COL_W = 4.5 if interval_min <= 15 else 6

        # 列幅設定
        ws.set_column(0, 0, NAME_COL_W)
        ws.set_column(1, n_time, TIME_COL_W)

        # ── 行0: 日付タイトル ─────────────────────────────────────────────────
        ws.set_row(0, 24)
        ws.merge_range(0, 0, 0, n_time, g.date_display, fmt_title)

        # ── 行1: 時間ヘッダー ─────────────────────────────────────────────────
        ws.set_row(1, 18)
        ws.write(1, 0, 'メンバー', fmt_dept)
        for ci, tm in enumerate(time_cols):
            fmt_t = fmt_time_hour if tm % 60 == 0 else fmt_time_half
            ws.write(1, ci + 1, g.time_label(tm), fmt_t)

        # ── データ行 ─────────────────────────────────────────────────────────
        row_idx = 2
        for dept in g.dept_order:
            # 局区切り行
            ws.set_row(row_idx, 14)
            ws.merge_range(row_idx, 0, row_idx, n_time,
                           f'  {dept}  ({len(g.dept_groups[dept])}人)', fmt_dept)
            row_idx += 1

            for mid, name, grade, is_leader in g.dept_groups[dept]:
                ws.set_row(row_idx, 20)
                name_str = f'★ {name}' if is_leader else name
                if grade:
                    name_str += f'  {grade}'
                fmt_nm = fmt_member_leader if is_leader else fmt_member_name
                ws.write(row_idx, 0, name_str, fmt_nm)

                # 空セルをデフォルト塗り
                for ci, tm in enumerate(time_cols):
                    fmt_e = fmt_empty_hour if tm % 60 == 0 else fmt_empty
                    ws.write(row_idx, ci + 1, '', fmt_e)

                # シフトセルを描画
                for _, s_time, e_time, role, job_color in g.member_slots.get(mid, []):
                    s_min = s_time.hour * 60 + s_time.minute
                    e_min = e_time.hour * 60 + e_time.minute
                    col_start = g.col_index(s_min) + 1
                    col_end   = g.col_index(e_min)  # exclusive

                    if col_start > n_time or col_end < 1:
                        continue
                    col_start = max(col_start, 1)
                    col_end   = min(col_end, n_time)

                    # セル色: job_color を薄く
                    bg_hex = _lighten(job_color, 0.35)
                    text_hex = job_color.lstrip('#')
                    fmt_shift_first = wb.add_format({
                        'font_size': 8, 'bold': True,
                        'bg_color': f'#{bg_hex}',
                        'font_color': f'#{text_hex}',
                        'align': 'left', 'valign': 'vcenter',
                        'border': 1, 'border_color': f'#{text_hex}',
                        'left': 3, 'left_color': f'#{text_hex}',
                        'text_wrap': False,
                    })
                    fmt_shift_cont = wb.add_format({
                        'bg_color': f'#{bg_hex}',
                        'border': 1, 'border_color': f'#{text_hex}',
                        'left': 0,
                    })

                    # セル結合せず個別書き込み（重なりシフトがあっても安全）
                    for ci2 in range(col_start, col_end + 1):
                        if ci2 < 1 or ci2 > n_time:
                            continue
                        if ci2 == col_start:
                            ws.write(row_idx, ci2, role, fmt_shift_first)
                        else:
                            ws.write(row_idx, ci2, '', fmt_shift_cont)

                row_idx += 1

        ws.freeze_panes(2, 1)

    wb.close()
    return buf.getvalue()


def _make_formats(wb):
    """ワークブック共通フォーマットを生成してタプルで返す。"""
    return (
        wb.add_format({'bold': True, 'font_size': 13, 'font_color': '#FFFFFF',
                       'bg_color': '#34609E', 'align': 'center', 'valign': 'vcenter', 'border': 0}),
        wb.add_format({'bold': True, 'font_size': 10, 'bg_color': '#D9E2F3',
                       'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC'}),
        wb.add_format({'font_size': 10, 'bg_color': '#FFFFFF',
                       'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC'}),
        wb.add_format({'font_size': 10, 'bg_color': '#F5F5F8',
                       'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC'}),
        wb.add_format({'font_size': 10, 'bg_color': '#FFFFFF',
                       'align': 'left', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC'}),
        wb.add_format({'font_size': 10, 'bg_color': '#F5F5F8',
                       'align': 'left', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC'}),
        wb.add_format({'font_size': 10, 'bg_color': '#FFFFFF',
                       'align': 'left', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC', 'text_wrap': True}),
        wb.add_format({'font_size': 10, 'bg_color': '#F5F5F8',
                       'align': 'left', 'valign': 'vcenter', 'border': 1, 'border_color': '#CCCCCC', 'text_wrap': True}),
    )
