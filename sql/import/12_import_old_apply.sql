-- 舊寄單系統資料匯入（福原 03）—— 由 tools/import_old.py 產生，請依檔名順序在 SQL Editor 執行
-- 步驟 3/3：轉入正式資料表（整段同一個交易，失敗會全部還原）
-- ★ 領藥日早於 v_cutoff 的視為舊系統已處理完：一般寄單 → 已通知；只選自取 → 已預作
--   v_cutoff 當天（含）以後的維持「寄放中」，會出現在預作清單。要調整請改下面的日期。
do $$
declare
  v_cutoff date := '2026-11-14';
  v_expect int := 7431;
  v_n int;
begin
  if exists (select 1 from rx_logs where action = 'create' and detail->>'import' = 'old-03') then
    raise exception '這批舊資料已經匯入過了，不可重複匯入';
  end if;
  select count(*) into v_n from rx_import_old;
  if v_n <> v_expect then raise exception '暫存資料筆數 % 筆，應為 % 筆，請確認步驟 1、2 都已執行', v_n, v_expect; end if;

  -- 1. 輸入人員代碼（名稱先填「待補資料」，之後到「系統管理 › 人員代碼」補上）
  insert into rx_staff (store_id, code, name) values
  ('03', '13', '待補資料'),
  ('03', '115', '待補資料'),
  ('03', '150', '待補資料'),
  ('03', '154', '待補資料'),
  ('03', '156', '待補資料'),
  ('03', '161', '待補資料'),
  ('03', '172', '待補資料'),
  ('03', '180', '待補資料')
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
    select order_no, '03', name, phone, methods, note, null, hosp, dept_code, nullif(dept, ''),
           staff, case when staff is null then '舊系統' end, null,
           ((day + time '08:00') at time zone 'Asia/Taipei') + rn * interval '1 minute', now()
    from _imp order by row_no
    returning id, order_no)
  update _imp i set order_id = ins.id from ins where ins.order_no = i.order_no;

  -- 4. 各次領藥（舊資料「第幾次」照原欄位）
  insert into rx_fills (order_id, store_id, seq, due_date)
  select i.order_id, '03', x.seq, x.d
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
  select i.order_id, '03', 'create',
         jsonb_build_object('import', 'old-03', 'note', '舊寄單系統匯入（Excel 第 ' || i.row_no || ' 列）'),
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
where exists (select 1 from rx_logs l where l.order_id = o.id and l.action = 'create' and l.detail->>'import' = 'old-03')
group by o.status order by 1;
