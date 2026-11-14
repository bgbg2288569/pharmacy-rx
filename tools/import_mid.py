#!/usr/bin/env python3
"""過渡寄單系統 CSV → 匯入 SQL（福原 03）
用法：python3 -I tools/import_mid.py 過渡系統.csv 舊系統.xlsx sql/import
  舊系統.xlsx 用來比對「兩邊都有登記」的重複寄單
產出：20_import_mid.sql、過渡系統_匯入檢核清單.xlsx
"""
import sys, re, csv, json, datetime as dt, collections, openpyxl

SRC, OLD, OUT = sys.argv[1:4]
STORE, TAG, CUTOFF = '03', 'mid-03', dt.date.today()
NOTIFY = ['LINE', '簡訊', '電話', '自取']
TEST_NAMES = {'test', '測試', '星星', '王小明', '王小名/BBB'}
rows = list(csv.DictReader(open(SRC, encoding='utf-8-sig')))

def d(v):
    try:
        x = dt.date.fromisoformat((v or '').strip())
        return x if x.year >= 2000 else None
    except ValueError: return None

def birth(v):
    t = (v or '').strip().replace('/', '')
    m = re.fullmatch(r'(\d{2,3})(\d{2}|\*\*)(\d{2}|\*\*)', t)
    if not m: return None
    y = int(m[1]) + 1911
    try:
        if '*' not in m[2] + m[3]: dt.date(y, int(m[2]), int(m[3]))
        elif m[2] != '**' and not 1 <= int(m[2]) <= 12: return None
    except ValueError: return None
    return f'{y}-{m[2]}-{m[3]}'

def phone(v):
    """回傳 (電話, 另一支電話, 問題)"""
    t = (v or '').strip().replace('-', '').replace(' ', '')
    parts = [p for p in re.split(r'[/、,]', t) if p]
    if not parts or not re.fullmatch(r'\d+', parts[0]): return '', '', ''
    p, other = parts[0], '/'.join(parts[1:])
    if re.fullmatch(r'0+|0900000000|0+9?0+|1234\d?', p): return '', other, ''   # 佔位用的假號碼
    if p.startswith('09') and len(p) != 10: return '', other, f'電話位數不符 {p}'
    if len(p) < 8 or len(p) > 10: return '', other, f'電話位數不符 {p}'
    if len(p) == 10 and not p.startswith(('09', '02')): return p, other, f'電話疑似有誤 {p}'
    return p, other, ''

# 舊系統（Excel）資料：用來找兩邊重複
old = collections.defaultdict(list)
wb = openpyxl.load_workbook(OLD, data_only=True)
for r in wb.worksheets[0].iter_rows(min_row=2, values_only=True):
    if not r[1]: continue
    ds = set()
    for v in r[7:10]:
        m = re.match(r'(\d{2})(\d{2})', str(v or '').strip())
        if m:
            try: ds.add(dt.date(2026, int(m[1]), int(m[2])))
            except ValueError: pass
    old[str(r[1]).strip()].append(((r[0].date() if r[0] else None), ds))

skipped, items = [], []
for i, r in enumerate(rows, start=2):
    name, st = r['客戶姓名'].strip(), r['狀態'].strip()
    if r['記錄類型'] != '寄放單': skipped.append((i, name, '獨立收費紀錄（非寄單）')); continue
    if st == '已作廢': skipped.append((i, name, '已作廢')); continue
    if name in TEST_NAMES: skipped.append((i, name, '測試資料')); continue
    notes, flags = [], []
    if r['備註'].strip(): notes.append(r['備註'].strip())
    ph, other, pflag = phone(r['客戶電話'])
    if other: notes.append('另一支電話 ' + other)
    if pflag: flags.append(pflag)
    raw_m = r['通知方式'].replace('（不通知）', '').replace('(不通知)', '')
    methods = [m for m in NOTIFY if m in raw_m] or ['自取']
    if not ph and set(methods) & {'簡訊', '電話'}: flags.append('通知方式需要電話，但沒有電話')
    if re.search(r'\s', name) or '/' in name: flags.append('姓名欄有兩個人')
    if '?' in name: flags.append('姓名有亂碼')
    b = birth(r['客戶生日'])
    if r['客戶生日'].strip() and not b: flags.append('生日無法判讀 ' + r['客戶生日'].strip())
    fills = []
    for seq, k in ((2, '第2次預計領取'), (3, '第3次預計領取')):
        v = r[k].strip()
        if not v: continue
        x = d(v)
        if x: fills.append((seq, x))
        else: flags.append(f'第{seq}次日期 {v} 無法判讀，未建立')
    if not fills: flags.append('沒有任何領藥日期')
    if len(fills) == 2 and fills[1][1] < fills[0][1]: flags.append('第3次日期早於第2次')
    day = d(r['寄放日期'])
    created = dt.datetime.fromisoformat(r['建檔/領藥時間'].strip()).replace(tzinfo=dt.timezone.utc)
    items.append(dict(row=i, day=day, created=created, name=name, phone=ph, digits=re.sub(r'\D', '', r['客戶電話']),
                      birth=b, methods=methods, notes=notes, flags=flags, fills=fills, done=(st == '已領藥')))

# 1) 與舊系統（Excel）重複：同姓名，且任一次領藥日差 3 天以內 → 不匯入
keep = []
for it in items:
    hit = None
    for oday, ods in old.get(it['name'], []):
        if any(abs((f - o).days) <= 3 for _, f in it['fills'] for o in ods): hit = oday; break
    if hit: skipped.append((it['row'], it['name'], f'舊系統已有（{hit} 寄單，領藥日相同）'))
    else: keep.append(it)

# 2) 過渡系統自己重複：姓名、電話、兩次領藥日都相同，且備註相同或其中一筆沒寫 → 合併成一筆（保留最新建檔）
groups = collections.OrderedDict()
for it in keep:
    k = (it['name'], it['digits'], tuple(it['fills']))
    groups.setdefault(k, []).append(it)
final = []
for k, g in groups.items():
    g.sort(key=lambda x: x['created'], reverse=True)
    base = g[0]
    for x in g[1:]:
        a, b = '；'.join(base['notes']), '；'.join(x['notes'])
        if a and b and a != b: final.append(x); continue           # 備註不同 → 視為不同處方，分開保留
        base['notes'] = list(dict.fromkeys(base['notes'] + x['notes']))
        base['methods'] = [m for m in NOTIFY if m in base['methods'] or m in x['methods']]
        base['birth'] = base['birth'] or x['birth']
        skipped.append((x['row'], x['name'], f'重複登記，已合併到第 {base["row"]} 列'))
    final.append(base)

# 3) 疑似重複（只標記，照樣匯入）
for a in final:
    for b in final:
        if a is b or a['digits'] != b['digits'] or not a['digits']: continue
        fa, fb = dict(a['fills']), dict(b['fills'])
        if a['name'] == b['name']:
            if fa != fb and any(fa.get(k) and fa.get(k) == fb.get(k) for k in (2, 3)) and abs((a['day'] - b['day']).days) <= 3:
                a['flags'].append(f'疑似與第 {b["row"]} 列重複（同人、其中一次領藥日相同）')
        elif fa == fb and not (a['birth'] and b['birth'] and a['birth'] != b['birth']) and len(a['name']) == len(b['name']) and sum(x != y for x, y in zip(a['name'], b['name'])) == 1:
            a['flags'].append(f'疑似與第 {b["row"]} 列「{b["name"]}」為同一人（姓名差一字）')

final.sort(key=lambda x: x['created'])
for it in final:
    it['note'] = '；'.join(dict.fromkeys(n for n in it['notes'] + (['【匯入待核對】' + '、'.join(dict.fromkeys(it['flags']))] if it['flags'] else []) if n))

def q(v): return 'null' if v in (None, '') else "'" + str(v).replace("'", "''") + "'"
def row_sql(o):
    f = dict(o['fills'])
    return (f"({o['row']},{q(o['day'].isoformat())},{q(o['created'].isoformat())},{q(o['name'])},{q(o['phone'])},{q(o['birth'])},"
            f"'{{{','.join(o['methods'])}}}',{q(o['note'])},{q(f.get(2) and f[2].isoformat())},{q(f.get(3) and f[3].isoformat())},{'true' if o['done'] else 'false'})")

with open(f'{OUT}/20_import_mid.sql', 'w') as fh:
    fh.write(f"""-- 過渡寄單系統資料匯入（福原 {STORE}）—— 由 tools/import_mid.py 產生，整個檔案貼到 SQL Editor 執行一次即可
-- ★ 領藥日早於 v_cutoff 的視為已處理完：一般寄單 → 已通知；只選自取 → 已預作。之後的維持「寄放中」。
create temp table _mid (row_no int, day date, created timestamptz, name text, phone text, birth text,
                        methods text[], note text, d2 date, d3 date, done boolean) on commit drop;
begin;
create temp table if not exists _mid (row_no int, day date, created timestamptz, name text, phone text, birth text,
                        methods text[], note text, d2 date, d3 date, done boolean) on commit drop;
insert into _mid values
{',\n'.join(map(row_sql, final))};

do $$
declare v_cutoff date := '{CUTOFF.isoformat()}'; v_n int;
begin
  if exists (select 1 from rx_logs where action = 'create' and detail->>'import' = '{TAG}') then
    raise exception '這批過渡系統資料已經匯入過了，不可重複匯入';
  end if;

  create temp table _imp on commit drop as
  select t.*, coalesce(c.last, 0) + row_number() over (partition by t.day order by t.created, t.row_no) as serial,
         null::text as order_no, null::bigint as order_id
  from _mid t left join rx_counters c on c.day = t.day;
  if exists (select 1 from _imp where serial > 9999) then raise exception '有日期的編號超過 9999'; end if;
  update _imp set order_no = to_char(day, 'YYMMDD') || lpad(serial::text, 4, '0')
                          || rx_luhn(to_char(day, 'YYMMDD') || lpad(serial::text, 4, '0'))::text;

  with ins as (
    insert into rx_orders (order_no, store_id, patient_name, phone, birth_date, notify_methods, note,
                           created_staff_code, created_staff_name, created_by, created_at, updated_at)
    select order_no, '{STORE}', name, phone, birth, methods, note, null, '過渡系統', null, created, now()
    from _imp order by created, row_no
    returning id, order_no)
  update _imp i set order_id = ins.id from ins where ins.order_no = i.order_no;

  insert into rx_fills (order_id, store_id, seq, due_date)
  select i.order_id, '{STORE}', x.seq, x.d from _imp i
  cross join lateral (values (2, i.d2), (3, i.d3)) x(seq, d) where x.d is not null;

  update rx_fills f set status = 'notified', notified_at = (f.due_date + time '12:00') at time zone 'Asia/Taipei',
         notified_by = '過渡系統', notified_via = '過渡系統匯入'
  from _imp i where f.order_id = i.order_id and (f.due_date < v_cutoff or i.done) and not (i.methods <@ array['自取']);
  update rx_fills f set status = 'prepared', prepared_at = (f.due_date + time '12:00') at time zone 'Asia/Taipei',
         prepared_by = '過渡系統'
  from _imp i where f.order_id = i.order_id and (f.due_date < v_cutoff or i.done) and i.methods <@ array['自取'];

  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name, user_id, created_at)
  select order_id, '{STORE}', 'create',
         jsonb_build_object('import', '{TAG}', 'note', '過渡寄單系統匯入（CSV 第 ' || row_no || ' 列）'),
         null, '過渡系統', null, created
  from _imp;

  perform rx_refresh_order_status(order_id) from _imp;
  insert into rx_counters (day, last) select day, max(serial) from _imp group by day
  on conflict (day) do update set last = greatest(rx_counters.last, excluded.last);
  select count(*) into v_n from _imp;
  raise notice '匯入完成：寄單 % 筆', v_n;
end $$;
commit;

select o.status, count(*) from rx_orders o
where exists (select 1 from rx_logs l where l.order_id = o.id and l.action = 'create' and l.detail->>'import' = '{TAG}')
group by o.status order by 1;
""".replace("""create temp table _mid (row_no int, day date, created timestamptz, name text, phone text, birth text,
                        methods text[], note text, d2 date, d3 date, done boolean) on commit drop;
begin;
create temp table if not exists""", """begin;
create temp table"""))

rw = openpyxl.Workbook(); ws = rw.active; ws.title = '匯入但需核對'
ws.append(['CSV列號', '寄放日期', '姓名', '電話', '通知', '第2次', '第3次', '需核對原因'])
for it in sorted(final, key=lambda x: x['row']):
    if it['flags']:
        f = dict(it['fills'])
        ws.append([it['row'], it['day'].isoformat(), it['name'], it['phone'], '、'.join(it['methods']),
                   f.get(2) and f[2].isoformat(), f.get(3) and f[3].isoformat(), '、'.join(dict.fromkeys(it['flags']))])
ws2 = rw.create_sheet('未匯入')
ws2.append(['CSV列號', '姓名', '原因'])
for x in sorted(skipped): ws2.append(list(x))
for w in (ws, ws2):
    for col in 'ABCDEFGH': w.column_dimensions[col].width = 12
    w.column_dimensions['H' if w is ws else 'C'].width = 60; w.freeze_panes = 'A2'
rw.save(f'{OUT}/過渡系統_匯入檢核清單.xlsx')

c = collections.Counter(re.sub(r'（.*|，.*| \d.*|第 \d+ 列', '', s[2]) for s in skipped)
print('csv rows', len(rows), 'import', len(final), 'skipped', len(skipped), dict(c))
print('flagged', sum(1 for x in final if x['flags']), collections.Counter(re.sub(r' \S*\d\S*|第 \d+ 列.*|「.*', '', f) for x in final for f in set(x['flags'])))
for s in sorted(skipped):
    if '已作廢' not in s[2]: print('  skip', s)
