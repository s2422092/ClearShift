"""
Google Sheets 同期ユーティリティ

イベントのシフト表を、Excel エクスポートと同じグリッドレイアウト
（時間軸 × メンバー）で Google スプレッドシートに書き出す。

2回目以降は同じスプレッドシートを上書き更新するため、共有した URL は変わらない。

必要な環境変数:
  GOOGLE_SERVICE_ACCOUNT_JSON  - サービスアカウント認証情報のJSON文字列（全体）

API 呼び出しは1回の同期につき2回の batchUpdate に集約している。
（1回目でシート構成の作り直し、2回目で値と書式の一括流し込み）
"""
import json
import os

from utils.shift_grid import _hex_to_rgb, _lighten, build_day_grids

# Google スプレッドシートのシート名の上限
_MAX_SHEET_TITLE = 100


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


# ── 色ユーティリティ ──────────────────────────────────────────────────────────

def _rgb(hex_color):
    """#RRGGBB → Sheets API の color オブジェクト（0.0〜1.0）"""
    r, g, b = _hex_to_rgb(hex_color)
    return {'red': r / 255, 'green': g / 255, 'blue': b / 255}


def _border(hex_color, style='SOLID'):
    return {'style': style, 'color': _rgb(hex_color)}


def _borders(color='#CCCCCC', left=None):
    """四辺の罫線。left だけ別色・太線にしたい場合は left を指定する。"""
    b = {
        'top': _border(color), 'bottom': _border(color),
        'left': _border(color), 'right': _border(color),
    }
    if left:
        b['left'] = left
    return b


# Excel 版（utils/excel_export.py）と同じ配色
_C_TITLE_BG    = '#34609E'
_C_WHITE       = '#FFFFFF'
_C_HOUR_BG     = '#1E3A5F'
_C_HALF_BG     = '#2D5A8E'
_C_HALF_FG     = '#CCDDFF'
_C_DEPT_BG     = '#F3F4F6'
_C_DEPT_FG     = '#6B7280'
_C_LEADER_BG   = '#FEFCE8'
_C_LEADER_LINE = '#EAB308'
_C_EMPTY_BG    = '#F9FAFB'
_C_GRID        = '#DDDDDD'
_C_GRID_LIGHT  = '#EEEEEE'


def _cell(text='', bg=None, fg=None, bold=False, size=10,
          halign='LEFT', borders=None):
    """Sheets API の CellData を組み立てる。"""
    text_format = {'fontSize': size, 'bold': bold}
    if fg:
        text_format['foregroundColor'] = _rgb(fg)

    fmt = {
        'textFormat': text_format,
        'horizontalAlignment': halign,
        'verticalAlignment': 'MIDDLE',
    }
    if bg:
        fmt['backgroundColor'] = _rgb(bg)
    if borders:
        fmt['borders'] = borders

    cell = {'userEnteredFormat': fmt}
    if text:
        cell['userEnteredValue'] = {'stringValue': str(text)}
    return cell


# ── スプレッドシートの取得・作成 ──────────────────────────────────────────────

def _open_or_create(gc, spreadsheet_id, title, owner_email=None):
    """
    既存のスプレッドシートを開く。開けない場合は新規作成する。

    Returns:
        (Spreadsheet, created: bool)
    """
    import gspread

    if spreadsheet_id:
        try:
            return gc.open_by_key(spreadsheet_id), False
        except gspread.exceptions.SpreadsheetNotFound:
            pass  # 削除された → 作り直す
        except gspread.exceptions.APIError as e:
            status = getattr(getattr(e, 'response', None), 'status_code', None)
            if status not in (403, 404):
                raise
            # 権限を失った / 削除された → 作り直す

    sh = gc.create(title)
    # リンクを知っている人が閲覧可能にする。
    # サービスアカウントが所有者なので、これをしないと誰も開けない。
    sh.share(None, perm_type='anyone', role='reader')
    if owner_email:
        try:
            sh.share(owner_email, perm_type='user', role='writer', notify=False)
        except Exception:
            pass  # 共有に失敗しても同期自体は続行する
    return sh, True


def _sheet_title(grid):
    """DayGrid → シートのタブ名（"11-01（大学祭1日目）"）"""
    title = f'{grid.month}-{grid.day}'
    if grid.label:
        title += f'（{grid.label}）'
    return title[:_MAX_SHEET_TITLE]


# ── 本体 ─────────────────────────────────────────────────────────────────────

def sync_event_to_sheets(event_title, rows, day_labels, all_members=None,
                         spreadsheet_id=None, interval_min=30, owner_email=None):
    """
    イベントのシフト表を Google スプレッドシートへ同期する。

    spreadsheet_id を渡すと同じスプレッドシートを上書き更新し、URL を維持する。
    渡さない（または開けない）場合は新規作成する。

    Args:
        event_title:    イベント名
        rows:           build_day_grids と同じ形式の行（admin.api_export_excel と同じクエリ結果）
        day_labels:     {"YYYY-MM-DD": "日程名", ...}
        all_members:    [(id, name, department, grade, is_leader), ...]（名前順）
        spreadsheet_id: 既存の同期先スプレッドシートID
        interval_min:   1列あたりの分数
        owner_email:    新規作成時に編集権限を付与するメールアドレス

    Returns:
        dict: {'spreadsheet_id', 'url', 'created', 'sheet_count'}
    """
    gc = _get_gc()
    doc_title = f'{event_title} シフト表'
    sh, created = _open_or_create(gc, spreadsheet_id, doc_title, owner_email)

    grids = build_day_grids(rows, day_labels, all_members, interval_min)

    # ── 1回目の batchUpdate: シート構成を作り直す ─────────────────────────────
    # 既存シートを一時名にリネーム → 新シートを追加 → 既存シートを削除、を
    # 1リクエストにまとめる。リネームを挟まないとシート名が衝突する。
    old_sheets = sh.worksheets()
    layouts = _plan_layouts(grids)

    requests = [{
        'updateSpreadsheetProperties': {
            'properties': {'title': doc_title},
            'fields': 'title',
        }
    }]
    for i, ws in enumerate(old_sheets):
        requests.append({
            'updateSheetProperties': {
                'properties': {'sheetId': ws.id, 'title': f'_old_{i}_{ws.id}'},
                'fields': 'title',
            }
        })
    for index, lay in enumerate(layouts):
        requests.append({
            'addSheet': {
                'properties': {
                    'title': lay['title'],
                    'index': index,
                    'gridProperties': {
                        'rowCount': max(lay['n_rows'], 2),
                        'columnCount': max(lay['n_cols'], 1),
                        'frozenRowCount': 2 if lay['grid'] else 0,
                        'frozenColumnCount': 1 if lay['grid'] else 0,
                    },
                }
            }
        })
    for ws in old_sheets:
        requests.append({'deleteSheet': {'sheetId': ws.id}})

    resp = sh.batch_update({'requests': requests})
    new_ids = [
        r['addSheet']['properties']['sheetId']
        for r in resp.get('replies', []) if 'addSheet' in r
    ]

    # ── 2回目の batchUpdate: 値と書式を流し込む ───────────────────────────────
    content_requests = []
    for sheet_id, lay in zip(new_ids, layouts):
        if lay['grid'] is None:
            content_requests.extend(_empty_sheet_requests(sheet_id))
        else:
            content_requests.extend(_day_sheet_requests(sheet_id, lay['grid'], interval_min))

    if content_requests:
        sh.batch_update({'requests': content_requests})

    return {
        'spreadsheet_id': sh.id,
        'url': sh.url,
        'created': created,
        'sheet_count': len(layouts),
    }


def _plan_layouts(grids):
    """作成するシートの一覧（タイトルとサイズ）を先に決める。"""
    if not grids:
        return [{'title': 'シフトなし', 'n_rows': 2, 'n_cols': 1, 'grid': None}]

    layouts = []
    for g in grids:
        n_rows = 2 + len(g.dept_order) + g.member_count
        layouts.append({
            'title': _sheet_title(g),
            'n_rows': n_rows,
            'n_cols': g.n_time + 1,
            'grid': g,
        })
    return layouts


def _empty_sheet_requests(sheet_id):
    return [{
        'updateCells': {
            'range': {'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': 1,
                      'startColumnIndex': 0, 'endColumnIndex': 1},
            'rows': [{'values': [_cell('シフト枠が登録されていません。')]}],
            'fields': 'userEnteredValue,userEnteredFormat',
        }
    }]


def _day_sheet_requests(sheet_id, g, interval_min):
    """1日分のシートに対する値・書式・レイアウトのリクエスト列を組み立てる。"""
    n_time = g.n_time
    n_cols = n_time + 1

    grid_border = _borders(_C_GRID)
    light_border = _borders(_C_GRID_LIGHT)

    matrix = []          # 全セルの CellData
    merges = []          # 結合するセル範囲
    dept_row_indices = []

    # ── 行0: 日付タイトル ────────────────────────────────────────────────────
    title_cells = [_cell(g.date_display, bg=_C_TITLE_BG, fg=_C_WHITE,
                         bold=True, size=13, halign='CENTER')]
    title_cells += [_cell(bg=_C_TITLE_BG) for _ in range(n_time)]
    matrix.append(title_cells)
    merges.append((0, 0, 1, n_cols))

    # ── 行1: 時間ヘッダー ────────────────────────────────────────────────────
    header = [_cell('メンバー', bg=_C_DEPT_BG, fg=_C_DEPT_FG, bold=True, size=9,
                    borders=grid_border)]
    for tm in g.time_cols:
        on_hour = tm % 60 == 0
        header.append(_cell(
            g.time_label(tm),
            bg=_C_HOUR_BG if on_hour else _C_HALF_BG,
            fg=_C_WHITE if on_hour else _C_HALF_FG,
            bold=on_hour, size=9 if on_hour else 8,
            halign='CENTER', borders=grid_border,
        ))
    matrix.append(header)

    # ── データ行 ─────────────────────────────────────────────────────────────
    row_idx = 2
    for dept in g.dept_order:
        # 局区切り行
        dept_cells = [_cell(f'  {dept}  ({len(g.dept_groups[dept])}人)',
                            bg=_C_DEPT_BG, fg=_C_DEPT_FG, bold=True, size=9,
                            borders=grid_border)]
        dept_cells += [_cell(bg=_C_DEPT_BG) for _ in range(n_time)]
        matrix.append(dept_cells)
        merges.append((row_idx, 0, row_idx + 1, n_cols))
        dept_row_indices.append(row_idx)
        row_idx += 1

        for mid, name, grade, is_leader in g.dept_groups[dept]:
            name_str = f'★ {name}' if is_leader else name
            if grade:
                name_str += f'  {grade}'

            name_borders = _borders(_C_GRID)
            if is_leader:
                name_borders['left'] = _border(_C_LEADER_LINE, 'SOLID_MEDIUM')
            else:
                name_borders['left'] = _border('#AAAAAA', 'SOLID_MEDIUM')

            row = [_cell(name_str, bg=_C_LEADER_BG if is_leader else _C_WHITE,
                         bold=True, borders=name_borders)]

            # 空セルで初期化
            for tm in g.time_cols:
                if tm % 60 == 0:
                    row.append(_cell(bg=_C_DEPT_BG,
                                     borders=_borders(_C_GRID,
                                                      left=_border('#BBBBBB', 'SOLID_MEDIUM'))))
                else:
                    row.append(_cell(bg=_C_EMPTY_BG, borders=light_border))

            # シフトセルを上書き
            for _, s_time, e_time, role, job_color in g.member_slots.get(mid, []):
                s_min = s_time.hour * 60 + s_time.minute
                e_min = e_time.hour * 60 + e_time.minute
                col_start = g.col_index(s_min) + 1
                col_end = g.col_index(e_min)  # exclusive

                if col_start > n_time or col_end < 1:
                    continue
                col_start = max(col_start, 1)
                col_end = min(col_end, n_time)

                bg = f'#{_lighten(job_color, 0.35)}'
                shift_borders = _borders(job_color)
                for ci in range(col_start, col_end + 1):
                    if ci == col_start:
                        b = dict(shift_borders)
                        b['left'] = _border(job_color, 'SOLID_THICK')
                        row[ci] = _cell(role, bg=bg, fg=job_color, bold=True,
                                        size=8, borders=b)
                    else:
                        row[ci] = _cell(bg=bg, borders=shift_borders)

            matrix.append(row)
            row_idx += 1

    n_rows = len(matrix)

    requests = [{
        'updateCells': {
            'range': {'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': n_rows,
                      'startColumnIndex': 0, 'endColumnIndex': n_cols},
            'rows': [{'values': r} for r in matrix],
            'fields': 'userEnteredValue,userEnteredFormat',
        }
    }]

    for r0, c0, r1, c1 in merges:
        requests.append({
            'mergeCells': {
                'range': {'sheetId': sheet_id, 'startRowIndex': r0, 'endRowIndex': r1,
                          'startColumnIndex': c0, 'endColumnIndex': c1},
                'mergeType': 'MERGE_ALL',
            }
        })

    # 列幅（Excel 版の文字数指定に対応するピクセル値）
    time_col_px = 34 if interval_min <= 15 else 46
    requests.append(_dimension(sheet_id, 'COLUMNS', 0, 1, 150))
    requests.append(_dimension(sheet_id, 'COLUMNS', 1, n_cols, time_col_px))

    # 行高さ
    requests.append(_dimension(sheet_id, 'ROWS', 0, 1, 32))
    requests.append(_dimension(sheet_id, 'ROWS', 1, 2, 24))
    if n_rows > 2:
        requests.append(_dimension(sheet_id, 'ROWS', 2, n_rows, 26))
    for ri in dept_row_indices:
        requests.append(_dimension(sheet_id, 'ROWS', ri, ri + 1, 20))

    return requests


def _dimension(sheet_id, dimension, start, end, pixels):
    return {
        'updateDimensionProperties': {
            'range': {'sheetId': sheet_id, 'dimension': dimension,
                      'startIndex': start, 'endIndex': end},
            'properties': {'pixelSize': pixels},
            'fields': 'pixelSize',
        }
    }
