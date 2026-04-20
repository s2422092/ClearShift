"""
Google Sheets エクスポートユーティリティ
サービスアカウント認証を使い、イベントのシフト表をスプレッドシートに書き出す。

必要な環境変数:
  GOOGLE_SERVICE_ACCOUNT_JSON  - サービスアカウント認証情報のJSON文字列（全体）
"""
import os
import json
from collections import defaultdict


def _get_gc():
    """gspread クライアントをサービスアカウント認証で取得する。"""
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        raise RuntimeError(
            'Google Sheets 連携には gspread と google-auth が必要です。'
            ' pip install gspread google-auth を実行してください。'
        )

    creds_json = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '').strip()
    if not creds_json:
        raise ValueError(
            'GOOGLE_SERVICE_ACCOUNT_JSON 環境変数が設定されていません。'
            ' Vercel の Environment Variables にサービスアカウントの JSON を貼り付けてください。'
        )

    try:
        creds_dict = json.loads(creds_json)
    except json.JSONDecodeError:
        raise ValueError('GOOGLE_SERVICE_ACCOUNT_JSON の JSON が不正です。')

    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
    ]
    creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
    return gspread.authorize(creds)


# セル背景色定数
_COLOR_HEADER   = {'red': 0.204, 'green': 0.392, 'blue': 0.643}   # #345E9E 相当
_COLOR_SUBHEAD  = {'red': 0.851, 'green': 0.878, 'blue': 0.949}   # 薄青
_COLOR_WHITE    = {'red': 1.0,   'green': 1.0,   'blue': 1.0}
_COLOR_STRIPE   = {'red': 0.961, 'green': 0.961, 'blue': 0.969}   # 薄グレー


def _fmt(color, bold=False, size=10, halign='LEFT', valign='MIDDLE', wrap='CLIP'):
    return {
        'backgroundColor': color,
        'textFormat': {'bold': bold, 'fontSize': size, 'foregroundColor': {'red': 1.0, 'green': 1.0, 'blue': 1.0} if bold and color == _COLOR_HEADER else {}},
        'horizontalAlignment': halign,
        'verticalAlignment': valign,
        'wrapStrategy': wrap,
    }


def export_event_to_sheets(event, slots, members, day_labels):
    """
    Google スプレッドシートを新規作成し、日付ごとにシートを分けてシフト表を書き出す。

    Args:
        event:      Event モデルインスタンス
        slots:      ShiftSlot のリスト（assignments が lazy-loaded 済み）
        members:    EventMember のリスト
        day_labels: {"YYYY-MM-DD": "日程名", ...} の dict

    Returns:
        str: 作成したスプレッドシートの URL
    """
    gc = _get_gc()
    import gspread

    # ── スプレッドシート作成 ──────────────────────────────────────────────
    sh = gc.create(f'{event.title} シフト表')
    sh.share(None, perm_type='anyone', role='reader')   # 誰でも閲覧可能リンク

    # ── データ準備 ────────────────────────────────────────────────────────
    member_map = {m.id: m for m in members}

    slots_by_date = defaultdict(list)
    for s in slots:
        slots_by_date[s.date.isoformat()].append(s)

    all_dates = sorted(slots_by_date.keys())

    if not all_dates:
        # シフトがない場合でも空のシートを残す
        ws = sh.get_worksheet(0)
        ws.update_title('シフトなし')
        ws.update('A1', [['シフト枠が登録されていません。']])
        return sh.url

    # ── 日付ごとにシートを作成 ─────────────────────────────────────────────
    for i, date_str in enumerate(all_dates):
        label = day_labels.get(date_str, '')
        # "MM/DD（日程名）" 形式でシートタブ名を決定
        month, day = date_str[5:7], date_str[8:10]
        sheet_title = f'{month}/{day}'
        if label:
            sheet_title += f'（{label}）'

        if i == 0:
            ws = sh.get_worksheet(0)
            ws.update_title(sheet_title)
        else:
            ws = sh.add_worksheet(title=sheet_title, rows=200, cols=10)

        _write_day_sheet(ws, date_str, label, slots_by_date[date_str], member_map)

    return sh.url


def _write_day_sheet(ws, date_str, label, day_slots, member_map):
    """1枚のシートにその日のシフト一覧を書き込む。"""
    import gspread

    day_slots = sorted(day_slots, key=lambda s: (s.start_time.strftime('%H:%M'), s.end_time.strftime('%H:%M')))

    # ── ヘッダー行（2行） ──────────────────────────────────────────────────
    month, day = date_str[5:7], date_str[8:10]
    date_display = f'{date_str[:4]}年{month}月{day}日'
    if label:
        date_display += f'　{label}'

    COLS = ['開始', '終了', '仕事・役割', '場所', '必要人数', '担当者']

    rows = []
    rows.append([date_display, '', '', '', '', ''])   # 行1: 日付タイトル
    rows.append(COLS)                                   # 行2: カラムヘッダー

    # ── データ行 ────────────────────────────────────────────────────────────
    for s in day_slots:
        assigned_names = []
        for a in s.assignments:
            m = member_map.get(a.member_id)
            if m:
                name = m.name
                if m.department:
                    name += f'（{m.department}）'
                assigned_names.append(name)

        rows.append([
            s.start_time.strftime('%H:%M'),
            s.end_time.strftime('%H:%M'),
            s.role or '',
            s.location or '',
            str(s.required_count),
            '　'.join(assigned_names) if assigned_names else '（未割り当て）',
        ])

    ws.update('A1', rows)

    # ── 列幅を調整 ──────────────────────────────────────────────────────────
    col_widths = [60, 60, 160, 160, 70, 400]
    requests = []
    for ci, w in enumerate(col_widths):
        requests.append({
            'updateDimensionProperties': {
                'range': {'sheetId': ws.id, 'dimension': 'COLUMNS', 'startIndex': ci, 'endIndex': ci + 1},
                'properties': {'pixelSize': w},
                'fields': 'pixelSize',
            }
        })

    # ── セル書式（タイトル行・ヘッダー行・データ行のストライプ） ──────────────
    n_data = len(day_slots)
    total_rows = 2 + n_data

    format_requests = [
        # タイトル行 (行1)
        {
            'repeatCell': {
                'range': {'sheetId': ws.id, 'startRowIndex': 0, 'endRowIndex': 1, 'startColumnIndex': 0, 'endColumnIndex': 6},
                'cell': {'userEnteredFormat': {
                    'backgroundColor': _COLOR_HEADER,
                    'textFormat': {'bold': True, 'fontSize': 12,
                                   'foregroundColor': {'red': 1.0, 'green': 1.0, 'blue': 1.0}},
                    'verticalAlignment': 'MIDDLE',
                }},
                'fields': 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
            }
        },
        # ヘッダー行 (行2)
        {
            'repeatCell': {
                'range': {'sheetId': ws.id, 'startRowIndex': 1, 'endRowIndex': 2, 'startColumnIndex': 0, 'endColumnIndex': 6},
                'cell': {'userEnteredFormat': {
                    'backgroundColor': _COLOR_SUBHEAD,
                    'textFormat': {'bold': True, 'fontSize': 10},
                    'horizontalAlignment': 'CENTER',
                    'verticalAlignment': 'MIDDLE',
                }},
                'fields': 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
            }
        },
        # タイトル行を結合
        {
            'mergeCells': {
                'range': {'sheetId': ws.id, 'startRowIndex': 0, 'endRowIndex': 1, 'startColumnIndex': 0, 'endColumnIndex': 6},
                'mergeType': 'MERGE_ALL',
            }
        },
        # 行高さ: タイトル行
        {
            'updateDimensionProperties': {
                'range': {'sheetId': ws.id, 'dimension': 'ROWS', 'startIndex': 0, 'endIndex': 1},
                'properties': {'pixelSize': 36},
                'fields': 'pixelSize',
            }
        },
        # 行高さ: データ行
        {
            'updateDimensionProperties': {
                'range': {'sheetId': ws.id, 'dimension': 'ROWS', 'startIndex': 2, 'endIndex': total_rows},
                'properties': {'pixelSize': 28},
                'fields': 'pixelSize',
            }
        },
        # 枠線（全体）
        {
            'updateBorders': {
                'range': {'sheetId': ws.id, 'startRowIndex': 1, 'endRowIndex': total_rows, 'startColumnIndex': 0, 'endColumnIndex': 6},
                'innerHorizontal': {'style': 'SOLID', 'color': {'red': 0.8, 'green': 0.8, 'blue': 0.8}},
                'innerVertical':   {'style': 'SOLID', 'color': {'red': 0.8, 'green': 0.8, 'blue': 0.8}},
                'bottom':          {'style': 'SOLID', 'color': {'red': 0.6, 'green': 0.6, 'blue': 0.6}},
                'right':           {'style': 'SOLID', 'color': {'red': 0.6, 'green': 0.6, 'blue': 0.6}},
            }
        },
    ]

    # データ行のストライプ
    for row_i in range(n_data):
        bg = _COLOR_WHITE if row_i % 2 == 0 else _COLOR_STRIPE
        format_requests.append({
            'repeatCell': {
                'range': {'sheetId': ws.id, 'startRowIndex': 2 + row_i, 'endRowIndex': 3 + row_i, 'startColumnIndex': 0, 'endColumnIndex': 6},
                'cell': {'userEnteredFormat': {'backgroundColor': bg, 'verticalAlignment': 'MIDDLE'}},
                'fields': 'userEnteredFormat(backgroundColor,verticalAlignment)',
            }
        })

    ws.spreadsheet.batch_update({'requests': requests + format_requests})
