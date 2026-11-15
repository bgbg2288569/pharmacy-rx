-- v1.17 資安修補（可重複執行）
-- 1. 內部函式（rx_create_order_core、rx_intake_result 等）不再開放給登入者；同專案其他系統帳號無法呼叫
-- 2. rx_search：非管理員一定要有門市，避免查到全部門市
-- 3. rx_resolve_staff：只能查自己門市的人員代碼
-- 4. 門市、醫院、科別、系統設定、人員、片語：只有寄單系統帳號讀得到
-- 5. 藥局系統連線網址只允許 localhost / 127.0.0.1
-- 6. anon 不能讀任何 rx_ 資料表；寄單資料不能直接寫入（只能透過 RPC）
-- 7. 刪除殘留的匯入暫存表
-- 最後會列出資安檢核結果，應該是「沒有資料列」

create or replace function rx_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rx_users where id = auth.uid() and active);
$$;

create or replace function rx_resolve_staff(p_store text, p_code text)
returns table (code text, name text)
language sql stable security definer set search_path = public as $$
  select s.code, s.name from rx_staff s
  where s.active and s.code = trim(p_code) and (s.store_id = p_store or s.store_id is null)
    -- 登入者只能查自己門市的人員；調劑系統串接（anon、無 auth.uid）由 rx_intake 先以 API 金鑰驗證門市
    and (auth.uid() is null or rx_can_store(p_store))
  order by s.store_id nulls last limit 1;
$$;

create or replace function rx_search(p jsonb) returns setof jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_store text := nullif(p->>'store_id', ''); v_limit int := least(coalesce((p->>'limit')::int, 300), 2000);
        kw text := nullif(trim(coalesce(p->>'keyword', '')), '');
begin
  if v_store is null and not rx_is_admin() then v_store := rx_my_store(); end if;
  -- 非管理員一定要有門市（避免未指定門市或其他系統的帳號查到全部門市）
  if v_store is null and not rx_is_admin() then raise exception '沒有此門市的權限'; end if;
  if v_store is not null and not rx_can_store(v_store) then raise exception '沒有此門市的權限'; end if;

  return query
  select to_jsonb(o) || jsonb_build_object(
           'store_name', s.short_name,
           'fills', coalesce((select jsonb_agg(to_jsonb(f) order by f.seq) from rx_fills f where f.order_id = o.id), '[]'::jsonb))
  from rx_orders o join rx_stores s on s.id = o.store_id
  where (v_store is null or o.store_id = v_store)
    and (kw is null or o.patient_name ilike '%' || kw || '%' or o.phone like '%' || kw || '%'
         or o.order_no like kw || '%' or o.note ilike '%' || kw || '%')
    and (nullif(p->>'order_no', '') is null or o.order_no like '%' || (p->>'order_no') || '%')
    and (nullif(p->>'name', '') is null or o.patient_name ilike '%' || (p->>'name') || '%')
    and (nullif(p->>'phone', '') is null or o.phone like '%' || (p->>'phone') || '%')
    and (nullif(p->>'hospital', '') is null or o.hospital_code like (p->>'hospital') || '%' or o.hospital_name ilike '%' || (p->>'hospital') || '%')
    and (case when nullif(p->>'dept_code', '') is not null
              then o.dept_code = p->>'dept_code' or (o.dept_code is null and o.dept_name = p->>'dept_name')
              when nullif(p->>'dept_name', '') is not null
              then o.dept_name ilike '%' || (p->>'dept_name') || '%'
              else true end)
    and (nullif(p->>'staff', '') is null or o.created_staff_code = p->>'staff' or o.created_staff_name ilike '%' || (p->>'staff') || '%')
    and (nullif(p->>'notify', '') is null or (p->>'notify') = any(o.notify_methods))
    and (nullif(p->>'order_status', '') is null or o.status = p->>'order_status')
    and (nullif(p->>'created_from', '') is null or o.created_at >= ((p->>'created_from')::date)::timestamp at time zone 'Asia/Taipei')
    and (nullif(p->>'created_to', '') is null or o.created_at < ((p->>'created_to')::date + 1)::timestamp at time zone 'Asia/Taipei')
    and (
      (nullif(p->>'due_from', '') is null and nullif(p->>'due_to', '') is null and nullif(p->>'fill_status', '') is null)
      or exists (select 1 from rx_fills f where f.order_id = o.id
                 and (nullif(p->>'due_from', '') is null or f.due_date >= (p->>'due_from')::date)
                 and (nullif(p->>'due_to', '') is null or f.due_date <= (p->>'due_to')::date)
                 and (nullif(p->>'fill_status', '') is null or f.status = p->>'fill_status'))
    )
  order by o.created_at desc
  limit v_limit;
end $$;

create or replace function rx_update_store_settings(p_store text, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare allowed text[] := array['notify_template','bridge_url','prep_days_ahead','receipt_footer',
                                'default_notify','default_hospital_code','default_hospital_name','default_dept_code','quick_depts',
                                'cancel_reasons','last_prep_date','bridge_print'];
        clean jsonb := '{}'::jsonb; k text;
begin
  if not rx_can_store(p_store) then raise exception '沒有此門市的權限'; end if;
  -- 藥局系統連線只允許本機（RxBridge 只在櫃台電腦本機執行），避免病人查詢被導到外部網址
  if coalesce(p_settings->>'bridge_url', '') <> ''
     and (p_settings->>'bridge_url') !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{2,5})?/?$' then
    raise exception '藥局系統連線網址只能是 http://localhost:埠號 或 http://127.0.0.1:埠號';
  end if;
  for k in select jsonb_object_keys(p_settings) loop
    if rx_is_admin() or k = any(allowed) then clean := clean || jsonb_build_object(k, p_settings->k); end if;
  end loop;
  update rx_stores set settings = settings || clean where id = p_store;
  return (select settings from rx_stores where id = p_store);
end $$;

-- 參照資料（門市、醫院、科別、系統設定、人員、片語）只開放給寄單系統帳號；同專案其他系統的登入者讀不到
drop policy if exists rx_stores_r on rx_stores;
create policy rx_stores_r on rx_stores for select to authenticated using (rx_is_member());
drop policy if exists rx_staff_r on rx_staff;
create policy rx_staff_r on rx_staff for select to authenticated using (rx_is_member() and (store_id is null or rx_can_store(store_id)));
drop policy if exists rx_hosp_r on rx_hospitals;
create policy rx_hosp_r on rx_hospitals for select to authenticated using (rx_is_member());
drop policy if exists rx_dept_r on rx_departments;
create policy rx_dept_r on rx_departments for select to authenticated using (rx_is_member());
drop policy if exists rx_settings_r on rx_settings;
create policy rx_settings_r on rx_settings for select to authenticated using (rx_is_member());
drop policy if exists rx_phr_r on rx_phrases;
create policy rx_phr_r on rx_phrases for select to authenticated using (rx_is_member() and (store_id is null or rx_can_store(store_id)));

-- RPC 權限：先把所有 rx_ 函式從 public / anon / authenticated 收回，再只開放前端需要的
-- （Supabase 預設會把新函式直接授權給 authenticated；同專案其他系統的登入者也是 authenticated，
--   所以內部函式如 rx_create_order_core、rx_intake_result 一定要收回，否則可跨門市讀寫）
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'rx\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
grant execute on function rx_create_order(jsonb, text), rx_update_order(bigint, jsonb, text),
  rx_cancel_order(bigint, text, text), rx_log_print(bigint, text), rx_fill_action(bigint, text, text, jsonb),
  rx_scan(text, text, date, date, text), rx_search(jsonb), rx_patient_suggest(text, text), rx_patient_match(text, text, text[], text[]),
  rx_dashboard(text, date, date, int), rx_update_store_settings(text, jsonb), rx_due_counts(text, date, date),
  rx_link_family(bigint, bigint, text), rx_unlink_family(bigint, text),
  rx_resolve_staff(text, text), rx_is_admin(), rx_is_member(), rx_my_store(), rx_can_store(text),
  rx_luhn(text), rx_valid_order_no(text), rx_api_key_create(text, text)
to authenticated;
-- 調劑系統（anon key）只能呼叫 rx_intake，函式內部以門市 API 金鑰驗證
grant execute on function rx_intake(text, jsonb, boolean) to anon, authenticated;

-- 資料表權限：anon（未登入）完全不能碰 rx_ 資料表；寄單資料只能經由 RPC 寫入
do $$
declare r record;
begin
  for r in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'rx\_%' and c.relkind in ('r','v','m','S') loop
    if r.relkind = 'S' then
      execute format('revoke all on sequence %I from anon', r.relname);
    else
      execute format('revoke all on table %I from anon', r.relname);
      execute format('revoke truncate, references, trigger on table %I from authenticated', r.relname);
    end if;
  end loop;
end $$;
revoke insert, update, delete on rx_orders, rx_fills, rx_logs, rx_counters from authenticated;
revoke insert, delete on rx_api_keys from authenticated;
grant select on rx_fill_view to authenticated;

-- 匯入用的暫存表（含病人資料）用完就刪掉
drop table if exists rx_import_old;
drop table if exists rx_import_mid;

-- ---------------------------------------------------------------------
-- 資安檢核：執行完應該「沒有任何一列」；有列出來的就是還有問題
-- ---------------------------------------------------------------------
select '資料表未開啟 RLS' as 問題, c.relname as 物件
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname like 'rx\_%' and c.relkind = 'r' and not c.relrowsecurity
union all
select '未登入（anon）可執行的函式', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'rx\_%' and p.proname <> 'rx_intake' and has_function_privilege('anon', p.oid, 'execute')
union all
select '內部函式開放給登入者', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('rx_create_order_core','rx_intake_result','rx_next_order_no','rx_refresh_order_status',
       'rx_staff_or_raise','rx_on_auth_user','rx_validate_payload','rx_parse_date','rx_short_hosp')
   and has_function_privilege('authenticated', p.oid, 'execute')
union all
select 'security definer 未固定 search_path', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'rx\_%' and p.prosecdef and not coalesce(array_to_string(p.proconfig, ',') like '%search_path%', false)
union all
select '未登入（anon）可讀資料表', c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname like 'rx\_%' and c.relkind in ('r','v') and has_table_privilege('anon', c.oid, 'select')
union all
select '登入者可直接寫入寄單資料', c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('rx_orders','rx_fills','rx_logs') and
       (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
union all
select 'view 未設定 security_invoker', c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname like 'rx\_%' and c.relkind = 'v' and not coalesce(c.reloptions::text like '%security_invoker=true%', false)
union all
select '殘留匯入暫存表', c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname like 'rx\_import%';
