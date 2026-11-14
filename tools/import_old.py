#!/usr/bin/env python3
"""舊寄單系統 Excel → 匯入 SQL（福原 03）
用法：python3 -I tools/import_old.py 舊資料.xlsx sql/import
產出：
  10_import_old_1.sql  建暫存表 + 資料（前半）
  11_import_old_2.sql  資料（後半）
  12_import_old_apply.sql  建人員代碼、轉入寄單/領藥/軌跡、刪暫存表
  匯入檢核清單.xlsx     需要人工核對的資料
"""
import sys, re, json, datetime as dt, collections, openpyxl

SRC, OUT = sys.argv[1], sys.argv[2]
STORE, YEAR, TAG = '03', 2026, 'old-03'
wb = openpyxl.load_workbook(SRC, data_only=True)
raw = [r for r in wb.worksheets[0].iter_rows(min_row=2, values_only=True) if any(v not in (None, '') for v in r)]

def s(v): return '' if v is None else str(v).strip()

def md(t):
    """MMDD → date；不合法回傳 None"""
    if not re.fullmatch(r'\d{4}', t or ''): return None
    try: return dt.date(YEAR, int(t[:2]), int(t[2:]))
    except ValueError: return None

def first_day(v):
    """回傳 (date or None, 是否需要核對)"""
    t = s(v)
    if not t: return None, False
    if t == '退單': return None, True
    m = re.fullmatch(r'(\d{4})-(\d{4})', t)
    if m and md(m[1]): return md(m[1]), False
    if re.fullmatch(r'\d{4}', t) and md(t): return md(t), False
    t2 = t.lstrip('.').replace('+', '-').replace('--', '-')
    m = re.fullmatch(r'(\d{1,2})/(\d{1,2})(?:-.*)?', t2)
    if m:
        try: return dt.date(YEAR, int(m[1]), int(m[2])), True
        except ValueError: pass
    parts = t2.split('-')
    a = parts[0]; b = parts[1] if len(parts) > 1 else ''
    if len(a) == 4 and md(a): return md(a), False      # 例：0926-、0605-615
    cand = None
    if len(a) == 5 and a.startswith('00'): cand = md(a[1:])
    elif len(a) in (5, 8): cand = md(a[:4])
    if cand: return cand, True
    # 起日打錯：用迄日往前 9 天（舊資料區間最常見 9 天）
    end = md(b[:4]) if len(b) >= 4 else None
    if end: return end - dt.timedelta(days=9), True
    if len(a) == 3:                                    # 例：115 → 11/5
        try: return dt.date(YEAR, int(a[:2]), int(a[2])), True
        except ValueError: pass
    return None, True

stats = collections.Counter(); review = []; out = []; staff = collections.Counter()
last_day = None
for i, r in enumerate(raw, start=2):        # i = Excel 列號
    day, name, line, how, memo, hosp, dept = r[0], s(r[1]), s(r[2]), s(r[3]), s(r[4]), s(r[5]), s(r[6])
    notes, flags = [], []
    if memo: notes.append(memo)
    if isinstance(day, dt.datetime): day = day.date(); last_day = day
    elif isinstance(day, dt.date): last_day = day
    else:
        day = last_day; flags.append('寄單日期空白，沿用上一筆日期'); stats['日期空白'] += 1
    if '?' in name: flags.append('姓名有亂碼'); stats['姓名亂碼'] += 1

    phone, methods = '', []
    if line.upper() == 'LINE':
        methods = ['LINE']
        if how: notes.append('原通知方式：' + how)
    elif re.fullmatch(r'\d+', line):
        if '簡訊' in how: methods.append('簡訊')
        if '電話' in how or '簡訊' not in how: methods.append('電話')
        if how and how not in ('簡訊', '簡訊電話'): notes.append(how)
        ok = len(line) <= 10 and len(line) >= 8 and not (line.startswith('09') and len(line) != 10)
        if ok: phone = line
        else:
            flags.append(f'電話位數不符 {line}'); stats['電話位數不符'] += 1
        if len(line) == 9 and line.startswith('02'): flags.append(f'市話僅 9 碼 {line}'); stats['市話9碼'] += 1
    else:
        # 自取／不用通知／診所／藥局…：一律「自取」（不需通知），原文字放備註
        methods = ['自取']
        txt = line or how
        if txt and txt != '自取': notes.append(txt)
        if not txt: flags.append('原通知方式空白')
        stats['自取類'] += 1

    fills = []
    for seq, v in ((1, r[7]), (2, r[8]), (3, r[9])):
        d, chk = first_day(v)
        if chk:
            flags.append(f'第{seq}次日期 {s(v)} → ' + (f'{d.month:02d}/{d.day:02d}' if d else '未建立'))
            stats['日期需核對'] += 1
        if d: fills.append((seq, d.isoformat()))
    if not fills: flags.append('沒有任何領藥日期'); stats['無領藥日期'] += 1

    code = s(r[10]).rstrip('.')
    if code: staff[code] += 1
    dept = dept.strip("'’ ")
    if flags: notes.append('【匯入待核對】' + '、'.join(flags))
    out.append(dict(row=i, day=day.isoformat(), name=name, phone=phone, methods=methods,
                    note='；'.join(dict.fromkeys(n for n in notes if n)), hosp=hosp, dept=dept, staff=code, fills=fills))
    for m in methods: stats['通知_' + m] += 1
    if flags: review.append((i, day.isoformat(), name, line, how, s(r[8]), s(r[9]), '；'.join(flags)))

def q(v): return 'null' if v in (None, '') else "'" + str(v).replace("'", "''") + "'"
def row_sql(o):
    arr = "'{" + ','.join(o['methods']) + "}'"
    f = {str(k): v for k, v in o['fills']}
    return (f"({o['row']},{q(o['day'])},{q(o['name'])},{q(o['phone'])},{arr},{q(o['note'])},{q(o['hosp'])},{q(o['dept'])},"
            f"{q(o['staff'])},{q(f.get('1'))},{q(f.get('2'))},{q(f.get('3'))})")

HDR = "-- 舊寄單系統資料匯入（福原 03）—— 由 tools/import_old.py 產生，請依檔名順序在 SQL Editor 執行\n"
COLS = "insert into rx_import_old (row_no, day, name, phone, methods, note, hosp, dept, staff, d1, d2, d3) values\n"
half = (len(out) + 1) // 2
def chunked(lst, n=500):
    for k in range(0, len(lst), n): yield lst[k:k + n]
with open(f'{OUT}/10_import_old_1.sql', 'w') as fh:
    fh.write(HDR + """-- 步驟 1/3：建立暫存表並寫入前半資料
create table if not exists rx_import_old (
  row_no int primary key, day date not null, name text not null, phone text, methods text[] not null,
  note text, hosp text, dept text, staff text, d1 date, d2 date, d3 date
);
alter table rx_import_old enable row level security;   -- 不開放前端讀取
""")
    for c in chunked(out[:half]): fh.write(COLS + ',\n'.join(map(row_sql, c)) + '\non conflict (row_no) do nothing;\n')
with open(f'{OUT}/11_import_old_2.sql', 'w') as fh:
    fh.write(HDR + '-- 步驟 2/3：寫入後半資料\n')
    for c in chunked(out[half:]): fh.write(COLS + ',\n'.join(map(row_sql, c)) + '\non conflict (row_no) do nothing;\n')

staff_vals = ',\n'.join(f"  ('{STORE}', {q(c)}, '待補資料')" for c in sorted(staff, key=lambda x: (len(x), x)))
with open(f'{OUT}/12_import_old_apply.sql', 'w') as fh:
    fh.write(HDR + f"""-- 步驟 3/3：轉入正式資料表（整段同一個交易，失敗會全部還原）
-- ★ 領藥日早於 v_cutoff 的視為舊系統已處理完：一般寄單 → 已通知；只選自取 → 已預作
--   v_cutoff 當天（含）以後的維持「寄放中」，會出現在預作清單。要調整請改下面的日期。
do $$
declare
  v_cutoff date := '{dt.date.today().isoformat()}';
  v_expect int := {len(out)};
  v_n int;
begin
  if exists (select 1 from rx_logs where action = 'create' and detail->>'import' = '{TAG}') then
    raise exception '這批舊資料已經匯入過了，不可重複匯入';
  end if;
  select count(*) into v_n from rx_import_old;
  if v_n <> v_expect then raise exception '暫存資料筆數 % 筆，應為 % 筆，請確認步驟 1、2 都已執行', v_n, v_expect; end if;

  -- 1. 輸入人員代碼（名稱先填「待補資料」，之後到「系統管理 › 人員代碼」補上）
  insert into rx_staff (store_id, code, name) values
{staff_vals}
  on conflict do nothing;

  -- 2. 編號：每天流水號接在該日現有編號之後
  create temp table _imp on commit drop as
  select t.*, d.code as dept_code,
         coalesce(c.last, 0) + row_number() over (partition by t.day order by t.row_no) as serial,
         row_number() over (partition by t.day order by t.row_no) as rn
  from rx_import_old t
  left join lateral (select code from rx_departments x where x.name = t.dept and x.active order by sort limit 1) d on true
  left join rx_counters c on c.day = t.day;

  if exists (select 1 from _imp where serial > 9999) then raise exception '有日期的編號超過 9999'; end if;

  alter table _imp add column order_no text, add column order_id bigint;
  update _imp set order_no = to_char(day, 'YYMMDD') || lpad(serial::text, 4, '0')
                          || rx_luhn(to_char(day, 'YYMMDD') || lpad(serial::text, 4, '0'))::text;

  -- 3. 寄單主檔
  with ins as (
    insert into rx_orders (order_no, store_id, patient_name, phone, notify_methods, note, hospital_code, hospital_name,
                           dept_code, dept_name, created_staff_code, created_staff_name, created_by, created_at, updated_at)
    select order_no, '{STORE}', name, phone, methods, note, null, hosp, dept_code, nullif(dept, ''),
           staff, case when staff is null then '舊系統' end, null,
           ((day + time '08:00') at time zone 'Asia/Taipei') + rn * interval '1 minute', now()
    from _imp order by row_no
    returning id, order_no)
  update _imp i set order_id = ins.id from ins where ins.order_no = i.order_no;

  -- 4. 各次領藥（舊資料「第幾次」照原欄位）
  insert into rx_fills (order_id, store_id, seq, due_date)
  select i.order_id, '{STORE}', x.seq, x.d
  from _imp i cross join lateral (values (1, i.d1), (2, i.d2), (3, i.d3)) x(seq, d)
  where x.d is not null;

  -- 5. 早於 v_cutoff 的領藥：視為已處理
  update rx_fills f set status = 'notified', notified_at = (f.due_date + time '12:00') at time zone 'Asia/Taipei',
         notified_by = '舊系統', notified_via = '舊系統匯入'
  from _imp i where f.order_id = i.order_id and f.due_date < v_cutoff and not (i.methods <@ array['自取']);
  update rx_fills f set status = 'prepared', prepared_at = (f.due_date + time '12:00') at time zone 'Asia/Taipei',
         prepared_by = '舊系統'
  from _imp i where f.order_id = i.order_id and f.due_date < v_cutoff and i.methods <@ array['自取'];

  -- 6. 軌跡
  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name, user_id, created_at)
  select i.order_id, '{STORE}', 'create',
         jsonb_build_object('import', '{TAG}', 'note', '舊寄單系統匯入（Excel 第 ' || i.row_no || ' 列）'),
         i.staff, case when i.staff is null then '舊系統' end, null,
         ((i.day + time '08:00') at time zone 'Asia/Taipei') + i.rn * interval '1 minute'
  from _imp i;

  -- 7. 狀態、編號計數器
  perform rx_refresh_order_status(order_id) from _imp;
  insert into rx_counters (day, last) select day, max(serial) from _imp group by day
  on conflict (day) do update set last = greatest(rx_counters.last, excluded.last);

  raise notice '匯入完成：寄單 % 筆', (select count(*) from _imp);
end $$;

drop table if exists rx_import_old;

-- 匯入結果（應與說明的數字相同）
select o.status, count(*) from rx_orders o
where exists (select 1 from rx_logs l where l.order_id = o.id and l.action = 'create' and l.detail->>'import' = '{TAG}')
group by o.status order by 1;
""")

# 檢核清單
rw = openpyxl.Workbook(); ws = rw.active; ws.title = '需核對'
ws.append(['Excel列號', '寄單日期', '姓名', 'LINE欄', '通知方式欄', '第二次', '第三次', '處理方式／需核對原因'])
for x in review: ws.append(list(x))
for col, w in zip('ABCDEFGH', (9, 11, 10, 14, 10, 12, 12, 60)): ws.column_dimensions[col].width = w
ws.freeze_panes = 'A2'
ws2 = rw.create_sheet('人員代碼')
ws2.append(['代碼', '筆數'])
for c, n in staff.most_common(): ws2.append([c, n])
rw.save(f'{OUT}/匯入檢核清單.xlsx')

stats['總筆數'] = len(out); stats['領藥筆數'] = sum(len(o['fills']) for o in out)
stats['人員空白'] = sum(1 for o in out if not o['staff']); stats['科別'] = len(set(o['dept'] for o in out))
print(json.dumps(dict(stats), ensure_ascii=False, indent=1)); print('staff', dict(staff)); print('review rows', len(review))
