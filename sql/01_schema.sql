-- =====================================================================
-- 處方寄單系統 RX Deposit — Supabase Schema v1
-- 凌曜醫療 · Designed by Tom 蔡育霖藥師
-- 所有物件皆以 rx_ 為前綴，可與既有 Supabase 專案（調撥/盤點）共用而不衝突。
-- 於 Supabase SQL Editor 依序執行：01_schema.sql → 02_seed_departments.sql → 03_seed_hospitals_*.sql
-- 本檔可重複執行（create if not exists / create or replace）。
-- =====================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- 1. 基本資料
-- ---------------------------------------------------------------------
create table if not exists rx_stores (
  id          text primary key,                 -- 門市代碼，例：03
  name        text not null,                    -- 福原藥局
  short_name  text,                             -- 福原
  settings    jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
comment on column rx_stores.settings is
  '{"prep_days_ahead":7,"overdue_days":7,"bridge_url":"http://localhost:5880","notify_template":"..."}';

create table if not exists rx_users (
  id            uuid primary key references auth.users(id) on delete cascade,
  account       text unique,
  display_name  text,
  role          text not null default 'store' check (role in ('admin','store')),
  store_id      text references rx_stores(id),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- 操作人員代碼（存檔/預作/通知時輸入，用於 track log 記錄是誰做的）
create table if not exists rx_staff (
  id          bigserial primary key,
  store_id    text references rx_stores(id),    -- null = 全門市通用
  code        text not null,
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists rx_staff_uq on rx_staff (coalesce(store_id,'*'), code);

create table if not exists rx_hospitals (
  code        text primary key,                 -- 健保院所代號
  name        text not null,
  short_name  text,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
create index if not exists rx_hospitals_name_trgm on rx_hospitals using gin (name gin_trgm_ops);

create table if not exists rx_departments (
  code    text primary key,
  name    text not null,
  sort    int not null default 0,
  active  boolean not null default true
);

-- 門市常用醫院：輸入兩位代碼快速帶入
create table if not exists rx_hospital_quick (
  store_id       text not null references rx_stores(id) on delete cascade,
  quick_code     text not null check (quick_code ~ '^[0-9A-Za-z]{1,2}$'),
  hospital_code  text not null references rx_hospitals(code),
  label          text,                          -- 顯示用簡稱（空白則用醫院名稱）
  default_dept   text references rx_departments(code),
  sort           int not null default 0,
  primary key (store_id, quick_code)
);

-- 常用片語標籤（store_id null = 全門市共用，由管理員維護）
create table if not exists rx_phrases (
  id        bigserial primary key,
  store_id  text references rx_stores(id) on delete cascade,
  text      text not null,
  sort      int not null default 0
);

-- 全域參數
create table if not exists rx_settings (
  key         text primary key,
  value       jsonb not null,
  note        text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. 寄單主檔 / 各次領藥 / 軌跡
-- ---------------------------------------------------------------------
create table if not exists rx_orders (
  id                  bigserial primary key,
  order_no            text not null unique,      -- YYMMDD + 4碼流水號 + 1碼檢核碼（Luhn）
  store_id            text not null references rx_stores(id),
  patient_name        text not null,
  phone               text,
  notify_methods      text[] not null default '{}',
  note                text,
  hospital_code       text,
  hospital_name       text,
  dept_code           text,
  dept_name           text,
  ext_patient_id      text,                      -- 藥局系統病歷號（由本地橋接帶入）
  status              text not null default 'active' check (status in ('active','closed','cancelled')),
  created_staff_code  text,
  created_staff_name  text,
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists rx_orders_store_created on rx_orders (store_id, created_at desc);
create index if not exists rx_orders_name_trgm on rx_orders using gin (patient_name gin_trgm_ops);
create index if not exists rx_orders_phone on rx_orders (phone);
-- v1.1：生日（同名同姓辨識）、同行家人（合併通知）
alter table rx_orders add column if not exists birth_date text;   -- 1986-03-12；醫院隱碼存成 1986-**-12
-- v1.14：寄單來源（web 網頁、dispensing 調劑系統）與調劑系統送單識別碼（防重複建立）
alter table rx_orders add column if not exists source text not null default 'web';
alter table rx_orders add column if not exists client_ref text;
create unique index if not exists rx_orders_client_ref on rx_orders (store_id, client_ref) where client_ref is not null;
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'rx_orders' and column_name = 'birth_date' and data_type = 'date') then
    drop view if exists rx_fill_view;
    alter table rx_orders alter column birth_date type text using to_char(birth_date, 'YYYY-MM-DD');
  end if;
end $$;
alter table rx_orders add column if not exists family_no text;   -- 同行家人群組：第一位家人的寄單編號
create index if not exists rx_orders_family on rx_orders (family_no) where family_no is not null;

-- 每一次領藥獨立一筆，各自有狀態：pending 寄放中 → prepared 已預作 → notified 已通知（寄單流程到此結束，領藥回歸藥局系統）
-- 只選「自取」的寄單，預作完成即視為完成；picked 保留相容，介面不再使用
create table if not exists rx_fills (
  id            bigserial primary key,
  order_id      bigint not null references rx_orders(id) on delete cascade,
  store_id      text not null references rx_stores(id),
  seq           smallint not null check (seq between 1 and 3),
  due_date      date not null,
  status        text not null default 'pending'
                check (status in ('pending','prepared','notified','picked','cancelled')),
  prepared_at   timestamptz, prepared_by text,
  notified_at   timestamptz, notified_by text, notified_via text,
  picked_at     timestamptz, picked_by text,
  unique (order_id, seq)
);
create index if not exists rx_fills_store_due on rx_fills (store_id, due_date, status);

create table if not exists rx_logs (
  id          bigserial primary key,
  order_id    bigint not null references rx_orders(id) on delete cascade,
  fill_id     bigint references rx_fills(id) on delete set null,
  store_id    text not null,
  action      text not null,   -- create / edit / print / prepare / unprepare / notify / unnotify / pickup / unpickup / cancel / restore
  detail      jsonb,
  staff_code  text,
  staff_name  text,
  user_id     uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists rx_logs_order on rx_logs (order_id, created_at);

create table if not exists rx_counters (
  day   date primary key,
  last  int not null default 0
);

-- ---------------------------------------------------------------------
-- 3. 權限 helper
-- ---------------------------------------------------------------------
create or replace function rx_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rx_users where id = auth.uid() and active and role = 'admin');
$$;

create or replace function rx_my_store() returns text
language sql stable security definer set search_path = public as $$
  select store_id from rx_users where id = auth.uid() and active;
$$;

-- 是否為寄單系統的有效帳號（同一個 Supabase 專案的其他系統使用者不算）
create or replace function rx_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rx_users where id = auth.uid() and active);
$$;

create or replace function rx_can_store(p_store text) returns boolean
language sql stable security definer set search_path = public as $$
  select rx_is_admin() or (p_store is not null and p_store = rx_my_store());
$$;

-- 新的 auth 使用者（@rx.linyao.local）自動建立 rx_users（預設 store、未指定門市，由管理員指派）
create or replace function rx_on_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 只處理寄單系統的帳號（與其他系統共用專案時，不會把別的系統使用者帶進來）
  if new.email is null or new.email not like '%@rx.linyao.local' then
    return new;
  end if;
  -- 角色一律先設為門市、不指定門市（無法使用任何資料），由管理員在管理頁指派；
  -- 不採用註冊時自帶的 role／store_id，避免有人透過公開註冊把自己設成管理員
  insert into rx_users (id, account, display_name, role, store_id)
  values (new.id,
          split_part(new.email, '@', 1),
          coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
          'store', null)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists rx_on_auth_user on auth.users;
create trigger rx_on_auth_user after insert on auth.users
for each row execute function rx_on_auth_user();

-- ---------------------------------------------------------------------
-- 4. 寄單編號：YYMMDD(台北時區) + 4碼流水號 + Luhn 檢核碼 = 11 碼純數字
-- ---------------------------------------------------------------------
create or replace function rx_luhn(p text) returns int
language plpgsql immutable as $$
declare s int := 0; d int; i int; dbl boolean := true;
begin
  for i in reverse length(p)..1 loop
    d := substr(p, i, 1)::int;
    if dbl then d := d * 2; if d > 9 then d := d - 9; end if; end if;
    s := s + d;
    dbl := not dbl;
  end loop;
  return (10 - s % 10) % 10;
end $$;

create or replace function rx_valid_order_no(p text) returns boolean
language sql immutable as $$
  select p ~ '^\d{11}$' and rx_luhn(substr(p, 1, 10)) = substr(p, 11, 1)::int;
$$;

create or replace function rx_next_order_no() returns text
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Taipei')::date; n int; base text;
begin
  insert into rx_counters (day, last) values (d, 1)
  on conflict (day) do update set last = rx_counters.last + 1
  returning last into n;
  if n > 9999 then raise exception '今日寄單編號已用完'; end if;
  base := to_char(d, 'YYMMDD') || lpad(n::text, 4, '0');
  return base || rx_luhn(base)::text;
end $$;

create or replace function rx_resolve_staff(p_store text, p_code text)
returns table (code text, name text)
language sql stable security definer set search_path = public as $$
  select s.code, s.name from rx_staff s
  where s.active and s.code = trim(p_code) and (s.store_id = p_store or s.store_id is null)
    -- 登入者只能查自己門市的人員；調劑系統串接（anon、無 auth.uid）由 rx_intake 先以 API 金鑰驗證門市
    and (auth.uid() is null or rx_can_store(p_store))
  order by s.store_id nulls last limit 1;
$$;

-- 內部：取得人員，錯誤時拋例外
create or replace function rx_staff_or_raise(p_store text, p_code text, out code text, out name text)
language plpgsql stable security definer set search_path = public as $$
begin
  select r.code, r.name into code, name from rx_resolve_staff(p_store, p_code) r;
  if code is null then raise exception '人員代碼錯誤或未啟用：%', coalesce(p_code, ''); end if;
end $$;

-- 寄單是否全部完成 → 自動結案
create or replace function rx_refresh_order_status(p_order bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update rx_orders o set
    status = case
      when o.status = 'cancelled' then 'cancelled'
      when exists (select 1 from rx_fills f where f.order_id = o.id)
       and not exists (select 1 from rx_fills f where f.order_id = o.id and f.status <> 'cancelled') then 'cancelled'
      when not exists (select 1 from rx_fills f where f.order_id = o.id
                         and (f.status = 'pending' or (f.status = 'prepared' and not (o.notify_methods <@ array['自取'])))) then 'closed'
      else 'active' end,
    updated_at = now()
  where o.id = p_order;
end $$;

-- ---------------------------------------------------------------------
-- 5. 寄單新增 / 修改 / 取消
-- p: { store_id, patient_name, phone, notify_methods[], note, hospital_code, hospital_name,
--      dept_code, dept_name, ext_patient_id, fills:[{seq, due_date}] }
-- ---------------------------------------------------------------------
create or replace function rx_validate_payload(p jsonb) returns void
language plpgsql stable set search_path = public as $$
declare m text[]; f jsonb; seqs int[] := '{}';
begin
  if coalesce(trim(p->>'patient_name'), '') = '' then raise exception '請輸入姓名'; end if;
  select coalesce(array_agg(x), '{}') into m from jsonb_array_elements_text(coalesce(p->'notify_methods', '[]')) x;
  if cardinality(m) = 0 then raise exception '請選擇通知方式'; end if;
  if coalesce(p->>'phone', '') <> '' and (p->>'phone') !~ '^\d{1,10}$' then raise exception '電話只能輸入數字，最多 10 碼'; end if;
  if coalesce(p->>'phone', '') like '09%' and length(p->>'phone') <> 10 then raise exception '手機（09 開頭）須為 10 碼'; end if;
  if (m && array['簡訊','電話']) and coalesce(p->>'phone', '') = '' then raise exception '通知方式含簡訊或電話時，電話必填'; end if;
  if jsonb_array_length(coalesce(p->'fills', '[]')) = 0 then raise exception '請至少輸入一次領藥日期'; end if;
  if coalesce(p->>'birth_date', '') <> '' and (p->>'birth_date') !~ '^\d{4}-(\d{2}|\*\*)-(\d{2}|\*\*)$' then
    raise exception '生日格式錯誤';
  end if;
  for f in select * from jsonb_array_elements(p->'fills') loop
    if (f->>'seq')::int not between 1 and 3 then raise exception '領藥次數錯誤'; end if;
    if (f->>'seq')::int = any(seqs) then raise exception '領藥次數重複'; end if;
    seqs := seqs || (f->>'seq')::int;
    perform (f->>'due_date')::date;
  end loop;
end $$;

-- 建立寄單（核心）：網頁 rx_create_order 與調劑系統 rx_intake 共用；權限與人員由呼叫端先確認
create or replace function rx_create_order_core(p jsonb, v_store text, v_code text, v_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_no text; f jsonb; v_hname text; v_dname text;
begin
  perform rx_validate_payload(p);
  select name into v_hname from rx_hospitals where code = nullif(p->>'hospital_code', '');
  select name into v_dname from rx_departments where code = nullif(p->>'dept_code', '');

  v_no := rx_next_order_no();
  if nullif(p->>'family_no', '') is not null and not exists
     (select 1 from rx_orders where order_no = p->>'family_no' and store_id = v_store) then
    raise exception '找不到同行家人的寄單 %', p->>'family_no';
  end if;
  insert into rx_orders (order_no, store_id, patient_name, phone, notify_methods, note,
                         hospital_code, hospital_name, dept_code, dept_name, ext_patient_id,
                         created_staff_code, created_staff_name, birth_date, family_no, source, client_ref)
  values (v_no, v_store, trim(p->>'patient_name'), nullif(p->>'phone', ''),
          array(select jsonb_array_elements_text(p->'notify_methods')),
          nullif(trim(coalesce(p->>'note', '')), ''),
          nullif(p->>'hospital_code', ''), coalesce(v_hname, nullif(p->>'hospital_name', '')),
          nullif(p->>'dept_code', ''), coalesce(v_dname, nullif(p->>'dept_name', '')),
          nullif(p->>'ext_patient_id', ''), v_code, v_name,
          nullif(p->>'birth_date', ''), nullif(p->>'family_no', ''),
          coalesce(nullif(p->>'source', ''), 'web'), nullif(p->>'client_ref', ''))
  returning id into v_id;

  for f in select * from jsonb_array_elements(p->'fills') loop
    insert into rx_fills (order_id, store_id, seq, due_date)
    values (v_id, v_store, (f->>'seq')::smallint, (f->>'due_date')::date);
  end loop;
  -- 第一位家人也標上群組編號
  if nullif(p->>'family_no', '') is not null then
    update rx_orders set family_no = p->>'family_no' where order_no = p->>'family_no' and family_no is null;
  end if;

  -- 軌跡：網頁建檔記 create；調劑輸出程式送單（rx_intake，source = dispensing）記 intake
  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name)
  values (v_id, v_store,
          case when coalesce(nullif(p->>'source', ''), 'web') = 'dispensing' then 'intake' else 'create' end,
          p - 'store_id', v_code, v_name);

  return jsonb_build_object('id', v_id, 'order_no', v_no);
end $$;

-- 網頁手動輸入：醫院必須是醫事機構清單內的院所（調劑系統匯入、舊資料匯入不檢查）
create or replace function rx_check_hospital(p jsonb) returns void
language plpgsql stable set search_path = public as $$
begin
  if coalesce(p->>'hospital_code', '') = '' then
    raise exception '%', case when coalesce(trim(p->>'hospital_name'), '') <> ''
      then '「' || trim(p->>'hospital_name') || '」不在醫院清單內，請從清單選擇醫院' else '請選擇醫院' end;
  end if;
  if not exists (select 1 from rx_hospitals where code = p->>'hospital_code') then
    raise exception '院所代號 % 不在醫院清單內', p->>'hospital_code';
  end if;
end $$;

create or replace function rx_create_order(p jsonb, p_staff text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_store text; v_staff record;
begin
  v_store := coalesce(nullif(p->>'store_id', ''), rx_my_store());
  if not rx_can_store(v_store) then raise exception '沒有此門市的權限'; end if;
  perform rx_validate_payload(p);
  perform rx_check_hospital(p);
  select * into v_staff from rx_staff_or_raise(v_store, p_staff);
  return rx_create_order_core((p - 'source') - 'client_ref', v_store, v_staff.code, v_staff.name);
end $$;

create or replace function rx_update_order(p_id bigint, p jsonb, p_staff text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o rx_orders; v_staff record; f jsonb; old_fill rx_fills; v_before jsonb; v_after jsonb;
        v_hname text; v_dname text; keep int[] := '{}';
begin
  select * into o from rx_orders where id = p_id for update;
  if o.id is null then raise exception '找不到寄單'; end if;
  if not rx_can_store(o.store_id) then raise exception '沒有此門市的權限'; end if;
  if o.status = 'cancelled' then raise exception '已取消的寄單不能修改'; end if;
  perform rx_validate_payload(p);
  -- 修改時只有醫院有變動才檢查（匯入的舊寄單不改醫院就照常存檔）
  if coalesce(p->>'hospital_code', '') is distinct from coalesce(o.hospital_code, '')
     or coalesce(trim(p->>'hospital_name'), '') is distinct from coalesce(o.hospital_name, '') then
    perform rx_check_hospital(p);
  end if;
  select * into v_staff from rx_staff_or_raise(o.store_id, p_staff);

  v_before := to_jsonb(o) || jsonb_build_object('fills',
    (select jsonb_agg(jsonb_build_object('seq', seq, 'due_date', due_date, 'status', status) order by seq) from rx_fills where order_id = p_id));

  select name into v_hname from rx_hospitals where code = nullif(p->>'hospital_code', '');
  select name into v_dname from rx_departments where code = nullif(p->>'dept_code', '');

  update rx_orders set
    patient_name = trim(p->>'patient_name'),
    phone = nullif(p->>'phone', ''),
    notify_methods = array(select jsonb_array_elements_text(p->'notify_methods')),
    note = nullif(trim(coalesce(p->>'note', '')), ''),
    hospital_code = nullif(p->>'hospital_code', ''),
    hospital_name = coalesce(v_hname, nullif(p->>'hospital_name', '')),
    dept_code = nullif(p->>'dept_code', ''),
    dept_name = coalesce(v_dname, nullif(p->>'dept_name', '')),
    ext_patient_id = coalesce(nullif(p->>'ext_patient_id', ''), ext_patient_id),
    birth_date = nullif(p->>'birth_date', ''),
    family_no = case when p ? 'family_no' then nullif(p->>'family_no', '') else family_no end,
    updated_at = now()
  where id = p_id;

  for f in select * from jsonb_array_elements(p->'fills') loop
    keep := keep || (f->>'seq')::int;
    select * into old_fill from rx_fills where order_id = p_id and seq = (f->>'seq')::smallint;
    if old_fill.id is null then
      insert into rx_fills (order_id, store_id, seq, due_date)
      values (p_id, o.store_id, (f->>'seq')::smallint, (f->>'due_date')::date);
    elsif old_fill.due_date <> (f->>'due_date')::date then
      if old_fill.status = 'picked' then raise exception '第 % 次已領取，不能改日期', old_fill.seq; end if;
      update rx_fills set due_date = (f->>'due_date')::date where id = old_fill.id;
    end if;
  end loop;

  -- 被移除的次數：已領取不能刪，其餘刪除
  if exists (select 1 from rx_fills where order_id = p_id and not (seq = any(keep)) and status = 'picked') then
    raise exception '已領取的次數不能移除';
  end if;
  delete from rx_fills where order_id = p_id and not (seq = any(keep));

  select to_jsonb(x) || jsonb_build_object('fills',
    (select jsonb_agg(jsonb_build_object('seq', seq, 'due_date', due_date, 'status', status) order by seq) from rx_fills where order_id = p_id))
    into v_after from rx_orders x where id = p_id;

  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name)
  values (p_id, o.store_id, 'edit', jsonb_build_object('before', v_before, 'after', v_after), v_staff.code, v_staff.name);

  perform rx_refresh_order_status(p_id);
  return jsonb_build_object('id', p_id, 'order_no', o.order_no);
end $$;

create or replace function rx_cancel_order(p_id bigint, p_staff text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o rx_orders; v_staff record;
begin
  select * into o from rx_orders where id = p_id for update;
  if o.id is null then raise exception '找不到寄單'; end if;
  if not rx_can_store(o.store_id) then raise exception '沒有此門市的權限'; end if;
  select * into v_staff from rx_staff_or_raise(o.store_id, p_staff);
  update rx_fills set status = 'cancelled' where order_id = p_id and status <> 'picked';
  update rx_orders set status = 'cancelled', updated_at = now() where id = p_id;
  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name)
  values (p_id, o.store_id, 'cancel', jsonb_build_object('reason', p_reason), v_staff.code, v_staff.name);
end $$;

-- 事後連結同行家人：兩張單（及其原本的群組）合併成同一群組
create or replace function rx_link_family(p_order bigint, p_target bigint, p_staff text) returns text
language plpgsql security definer set search_path = public as $$
declare a rx_orders; b rx_orders; v_staff record; g text;
begin
  select * into a from rx_orders where id = p_order;
  select * into b from rx_orders where id = p_target;
  if a.id is null or b.id is null then raise exception '找不到寄單'; end if;
  if not rx_can_store(a.store_id) or a.store_id <> b.store_id then raise exception '只能連結同一門市的寄單'; end if;
  if a.id = b.id then raise exception '不能連結自己'; end if;
  select * into v_staff from rx_staff_or_raise(a.store_id, p_staff);
  g := coalesce(b.family_no, a.family_no, b.order_no);
  update rx_orders set family_no = g, updated_at = now()
  where id in (a.id, b.id) or (family_no is not null and family_no in (a.family_no, b.family_no));
  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name) values
    (a.id, a.store_id, 'family', jsonb_build_object('with', b.order_no, 'with_name', b.patient_name, 'family_no', g), v_staff.code, v_staff.name),
    (b.id, b.store_id, 'family', jsonb_build_object('with', a.order_no, 'with_name', a.patient_name, 'family_no', g), v_staff.code, v_staff.name);
  return g;
end $$;

create or replace function rx_unlink_family(p_order bigint, p_staff text) returns void
language plpgsql security definer set search_path = public as $$
declare a rx_orders; v_staff record; g text;
begin
  select * into a from rx_orders where id = p_order;
  if a.id is null then raise exception '找不到寄單'; end if;
  if not rx_can_store(a.store_id) then raise exception '沒有此門市的權限'; end if;
  select * into v_staff from rx_staff_or_raise(a.store_id, p_staff);
  g := a.family_no;
  if g is null then return; end if;
  update rx_orders set family_no = null, updated_at = now() where id = a.id;
  if (select count(*) from rx_orders where family_no = g) = 1 then
    update rx_orders set family_no = null where family_no = g;
  end if;
  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name)
  values (a.id, a.store_id, 'unfamily', jsonb_build_object('family_no', g), v_staff.code, v_staff.name);
end $$;

create or replace function rx_log_print(p_id bigint, p_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare o rx_orders;
begin
  select * into o from rx_orders where id = p_id;
  if o.id is null or not rx_can_store(o.store_id) then return; end if;
  insert into rx_logs (order_id, store_id, action, detail) values (p_id, o.store_id, 'print', jsonb_build_object('mode', p_mode));
end $$;

-- ---------------------------------------------------------------------
-- 6. 各次領藥狀態操作
-- p_action: prepare / unprepare / notify / unnotify / pickup / unpickup / cancel / restore
-- ---------------------------------------------------------------------
create or replace function rx_fill_action(p_fill_id bigint, p_action text, p_staff text, p_extra jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare f rx_fills; o rx_orders; v_staff record; v_new text;
begin
  select * into f from rx_fills where id = p_fill_id for update;
  if f.id is null then raise exception '找不到領藥資料'; end if;
  select * into o from rx_orders where id = f.order_id;
  if not rx_can_store(f.store_id) then raise exception '沒有此門市的權限'; end if;
  if o.status = 'cancelled' and p_action <> 'restore' then raise exception '此寄單已取消'; end if;
  select * into v_staff from rx_staff_or_raise(f.store_id, p_staff);

  case p_action
    when 'prepare' then
      if f.status <> 'pending' then raise exception '第 % 次目前狀態無法預作', f.seq; end if;
      update rx_fills set status = 'prepared', prepared_at = now(), prepared_by = v_staff.name where id = f.id;
      -- 從預作確認頁（刷條碼或清單點選）確認時，更新門市「最新預作日」
      if (p_extra ? 'via_scan' or p_extra ? 'from_prep') and not coalesce((p_extra->>'force_date')::boolean, false) then
        update rx_stores set settings = settings || jsonb_build_object('last_prep_date',
          greatest(coalesce(nullif(settings->>'last_prep_date', '')::date, f.due_date), f.due_date))
        where id = f.store_id;
      end if;
    when 'unprepare' then
      if f.status <> 'prepared' then raise exception '只有「已預作」可以取消預作'; end if;
      update rx_fills set status = 'pending', prepared_at = null, prepared_by = null where id = f.id;
    when 'notify' then
      if f.status not in ('prepared','notified') then raise exception '請先完成預作再通知'; end if;
      update rx_fills set status = 'notified', notified_at = now(), notified_by = v_staff.name,
             notified_via = coalesce(p_extra->>'via', notified_via) where id = f.id;
    when 'unnotify' then
      if f.status <> 'notified' then raise exception '只有「已通知」可以撤銷通知'; end if;
      update rx_fills set status = 'prepared', notified_at = null, notified_by = null, notified_via = null where id = f.id;
    when 'pickup' then
      if f.status not in ('prepared','notified') then raise exception '尚未預作，不能標記領取'; end if;
      update rx_fills set status = 'picked', picked_at = now(), picked_by = v_staff.name where id = f.id;
    when 'unpickup' then
      if f.status <> 'picked' then raise exception '只有「已領取」可以撤銷'; end if;
      update rx_fills set status = case when notified_at is not null then 'notified' else 'prepared' end,
             picked_at = null, picked_by = null where id = f.id;
    when 'cancel' then
      if f.status = 'picked' then raise exception '已領取不能取消'; end if;
      update rx_fills set status = 'cancelled' where id = f.id;
    when 'restore' then
      if f.status <> 'cancelled' then raise exception '只有已取消可以復原'; end if;
      update rx_fills set status = 'pending', prepared_at = null, prepared_by = null,
             notified_at = null, notified_by = null, notified_via = null where id = f.id;
      update rx_orders set status = 'active' where id = f.order_id and status = 'cancelled';
    else raise exception '未知的動作 %', p_action;
  end case;

  insert into rx_logs (order_id, fill_id, store_id, action, detail, staff_code, staff_name)
  values (f.order_id, f.id, f.store_id, p_action,
          jsonb_build_object('seq', f.seq, 'due_date', f.due_date) || coalesce(p_extra, '{}'::jsonb),
          v_staff.code, v_staff.name);

  perform rx_refresh_order_status(f.order_id);
  select status into v_new from rx_fills where id = f.id;
  return jsonb_build_object('fill_id', f.id, 'status', v_new);
end $$;

-- ---------------------------------------------------------------------
-- 7. 預作確認：刷寄單編號條碼
-- 回傳 result：ok / already / other_date / no_pending / cancelled / not_found / bad_code
-- ---------------------------------------------------------------------
create or replace function rx_scan(p_store text, p_code text, p_from date, p_to date, p_staff text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o rx_orders; f rx_fills; v_code text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
begin
  if not rx_can_store(p_store) then raise exception '沒有此門市的權限'; end if;
  if not rx_valid_order_no(v_code) then
    return jsonb_build_object('result', 'bad_code', 'code', p_code);
  end if;
  select * into o from rx_orders where order_no = v_code;
  if o.id is null then return jsonb_build_object('result', 'not_found', 'code', v_code); end if;
  if o.store_id <> p_store then
    return jsonb_build_object('result', 'other_store', 'code', v_code, 'store_id', o.store_id, 'patient_name', o.patient_name);
  end if;
  if o.status = 'cancelled' then
    return jsonb_build_object('result', 'cancelled', 'order', to_jsonb(o));
  end if;

  -- 範圍內待預作 → 直接確認
  select * into f from rx_fills where order_id = o.id and status = 'pending' and due_date between p_from and p_to
  order by due_date limit 1;
  if f.id is not null then
    perform rx_fill_action(f.id, 'prepare', p_staff, jsonb_build_object('via_scan', true));
    select * into f from rx_fills where id = f.id;
    return jsonb_build_object('result', 'ok', 'order', to_jsonb(o), 'fill', to_jsonb(f));
  end if;

  -- 範圍內已處理過
  select * into f from rx_fills where order_id = o.id and status in ('prepared','notified','picked') and due_date between p_from and p_to
  order by due_date limit 1;
  if f.id is not null then
    return jsonb_build_object('result', 'already', 'order', to_jsonb(o), 'fill', to_jsonb(f));
  end if;

  -- 範圍外最近一筆待預作 → 交給前端詢問是否仍要確認
  select * into f from rx_fills where order_id = o.id and status = 'pending'
  order by abs(due_date - p_from) limit 1;
  if f.id is not null then
    return jsonb_build_object('result', 'other_date', 'order', to_jsonb(o), 'fill', to_jsonb(f));
  end if;

  return jsonb_build_object('result', 'no_pending', 'order', to_jsonb(o));
end $$;

-- ---------------------------------------------------------------------
-- 8. 查詢
-- ---------------------------------------------------------------------
-- 單筆領藥 + 寄單資訊（預作 / 通知頁使用；security_invoker 讓 RLS 生效）
drop view if exists rx_fill_view;
create view rx_fill_view with (security_invoker = true) as
select f.id as fill_id, f.seq, f.due_date, f.status as fill_status,
       f.prepared_at, f.prepared_by, f.notified_at, f.notified_by, f.notified_via, f.picked_at, f.picked_by,
       o.id as order_id, o.order_no, o.store_id, o.patient_name, o.phone, o.notify_methods, o.note,
       o.hospital_code, o.hospital_name, o.dept_code, o.dept_name, o.status as order_status,
       o.created_at, o.created_staff_name,
       (select count(*) from rx_fills x where x.order_id = o.id) as fill_count,
       o.birth_date, o.family_no, o.created_staff_code,
       (select max(x.seq) from rx_fills x where x.order_id = o.id and x.status <> 'cancelled') as max_seq
from rx_fills f join rx_orders o on o.id = f.order_id;

-- 多條件查詢。p: { store_id, keyword, order_no, name, phone, hospital, dept_code, notify, staff,
--   created_from, created_to, due_from, due_to, fill_status, order_status, limit }
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

-- 姓名 / 電話自動完成：同一病人取最近一筆
create or replace function rx_patient_suggest(p_store text, q text) returns setof jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m text[];
  v_birth text;       -- 輸入民國生日（750312、0750312、75/3/12）時轉成 yyyy-mm-dd
begin
  if p_store is null or not rx_can_store(p_store) then raise exception '沒有此門市的權限'; end if;
  if coalesce(trim(q), '') = '' then return; end if;
  m := coalesce(regexp_match(trim(q), '^(\d{2,3})(\d{2})(\d{2})$'), regexp_match(trim(q), '^(\d{1,3})[/.-](\d{1,2})[/.-](\d{1,2})$'));
  if m is not null then
    begin
      v_birth := to_char(make_date(m[1]::int + 1911, m[2]::int, m[3]::int), 'YYYY-MM-DD');
    exception when others then v_birth := null;
    end;
  end if;
  return query
  select to_jsonb(t) from (
    select distinct on (o.patient_name, o.birth_date, coalesce(o.phone, ''))
           o.patient_name, o.phone, o.birth_date, o.notify_methods, o.hospital_code, o.hospital_name,
           o.dept_code, o.dept_name, o.ext_patient_id, o.order_no, o.created_at,
           (select count(*) from rx_fills f join rx_orders o2 on o2.id = f.order_id
             where o2.store_id = p_store and o2.patient_name = o.patient_name
               and coalesce(o2.phone, '') = coalesce(o.phone, '')
               and o2.birth_date is not distinct from o.birth_date
               and f.status in ('pending','prepared')) as open_fills
    from rx_orders o
    where o.store_id = p_store
      and (o.patient_name ilike '%' || trim(q) || '%' or o.phone like trim(q) || '%' or (v_birth is not null and o.birth_date = v_birth))
    order by o.patient_name, o.birth_date, coalesce(o.phone, ''), o.created_at desc
  ) t
  order by (t.patient_name ilike trim(q) || '%') desc, t.created_at desc
  limit 12;
end $$;

-- 掃描處方箋 QR：以生日（可含 ** 隱碼）、藥局系統查到的客戶代號／姓名，找本系統寄單紀錄
-- p_birth：1966-03-26 或 1966-**-26；p_ext_ids：藥局系統客戶代號；p_names：藥局系統姓名（＋QR 姓名）
create or replace function rx_patient_match(p_store text, p_birth text, p_ext_ids text[], p_names text[])
returns setof jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  b text[] := case when coalesce(p_birth, '') ~ '^\d{4}-(\d{2}|\*\*)-(\d{2}|\*\*)$' then string_to_array(p_birth, '-') end;
begin
  if p_store is null or not rx_can_store(p_store) then raise exception '沒有此門市的權限'; end if;
  return query
  select to_jsonb(t) from (
    select distinct on (o.patient_name, o.birth_date, coalesce(o.phone, ''))
           o.patient_name, o.phone, o.birth_date, o.notify_methods, o.hospital_code, o.hospital_name,
           o.dept_code, o.dept_name, o.ext_patient_id, o.order_no, o.created_at,
           (select count(*) from rx_fills f join rx_orders o2 on o2.id = f.order_id
             where o2.store_id = p_store and o2.patient_name = o.patient_name
               and coalesce(o2.phone, '') = coalesce(o.phone, '')
               and o2.birth_date is not distinct from o.birth_date
               and f.status in ('pending','prepared')) as open_fills,
           -- 比對強度：2 = 客戶代號相同；1 = 姓名相同；0 = 只有生日相符
           case when o.ext_patient_id is not null and o.ext_patient_id = any(coalesce(p_ext_ids, '{}')) then 2
                when o.patient_name = any(coalesce(p_names, '{}')) then 1 else 0 end as match_level,
           -- 生日：各段相同或任一邊是 **；沒有生日資料視為不符合（只靠代號／姓名）
           (b is not null and o.birth_date is not null and (
              select bool_and(x.v = '**' or y.v = '**' or x.v = y.v)
              from unnest(b) with ordinality x(v, i) join unnest(string_to_array(o.birth_date, '-')) with ordinality y(v, i) using (i)
           )) as birth_ok
    from rx_orders o
    where o.store_id = p_store
      and (o.ext_patient_id = any(coalesce(p_ext_ids, '{}'))
           or o.patient_name = any(coalesce(p_names, '{}'))
           or (b is not null and o.birth_date like b[1] || '-%'))
    order by o.patient_name, o.birth_date, coalesce(o.phone, ''), o.created_at desc
  ) t
  -- 姓名相同但生日明顯不同（同名不同人）排除；只有生日相符的也要保留（藥局系統沒查到時才有用）
  where t.match_level = 2 or t.birth_ok or (t.match_level = 1 and (b is null or t.birth_date is null))
  order by t.match_level desc, t.birth_ok desc, t.created_at desc
  limit 20;
end $$;

-- 首頁統計
create or replace function rx_dashboard(p_store text, p_prep_from date, p_prep_to date, p_overdue_days int default 7)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Taipei')::date;
begin
  if not rx_can_store(p_store) then raise exception '沒有此門市的權限'; end if;
  return jsonb_build_object(
    'today_orders', (select count(*) from rx_orders where store_id = p_store
                       and created_at >= today::timestamp at time zone 'Asia/Taipei'),
    'prep_pending', (select count(*) from rx_fills f join rx_orders o on o.id = f.order_id
                       where f.store_id = p_store and o.status <> 'cancelled' and f.status = 'pending'
                         and f.due_date between p_prep_from and p_prep_to),
    'prep_total',   (select count(*) from rx_fills f join rx_orders o on o.id = f.order_id
                       where f.store_id = p_store and o.status <> 'cancelled' and f.status <> 'cancelled'
                         and f.due_date between p_prep_from and p_prep_to),
    'late_pending', (select count(*) from rx_fills where store_id = p_store and status = 'pending' and due_date < p_prep_from),
    'to_notify',    (select count(*) from rx_fills f join rx_orders o on o.id = f.order_id
                       where f.store_id = p_store and f.status = 'prepared' and f.due_date <= today
                         and not ('自取' = any(o.notify_methods) and cardinality(o.notify_methods) = 1)),
    'notified_today', (select count(*) from rx_fills where store_id = p_store and status = 'notified'
                       and notified_at >= today::timestamp at time zone 'Asia/Taipei')
  );
end $$;

-- 預作頁：每日到期件數
create or replace function rx_due_counts(p_store text, p_from date, p_to date)
returns table (due_date date, total bigint, pending bigint)
language sql stable security definer set search_path = public as $$
  select f.due_date, count(*) filter (where f.status <> 'cancelled'), count(*) filter (where f.status = 'pending')
  from rx_fills f join rx_orders o on o.id = f.order_id
  where rx_can_store(p_store) and f.store_id = p_store and o.status <> 'cancelled' and f.due_date between p_from and p_to
  group by f.due_date order by f.due_date;
$$;

-- 門市自行維護的設定（只允許特定 key）
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

-- ---------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------
alter table rx_stores          enable row level security;
alter table rx_users           enable row level security;
alter table rx_staff           enable row level security;
alter table rx_hospitals       enable row level security;
alter table rx_departments     enable row level security;
alter table rx_hospital_quick  enable row level security;
alter table rx_phrases         enable row level security;
alter table rx_settings        enable row level security;
alter table rx_orders          enable row level security;
alter table rx_fills           enable row level security;
alter table rx_logs            enable row level security;
alter table rx_counters        enable row level security;

do $$
declare t text;
begin
  -- 先清掉舊 policy，確保可重複執行
  for t in select policyname || ' on ' || tablename from pg_policies
           where schemaname = 'public' and tablename like 'rx\_%' loop
    execute 'drop policy if exists ' || split_part(t, ' on ', 1) || ' on ' || split_part(t, ' on ', 2);
  end loop;
end $$;

-- 基本資料：登入即可讀，管理員可寫
create policy rx_stores_r on rx_stores for select to authenticated using (rx_is_member());
create policy rx_stores_w on rx_stores for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_users_r on rx_users for select to authenticated using (id = auth.uid() or rx_is_admin());
create policy rx_users_w on rx_users for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_staff_r on rx_staff for select to authenticated using (rx_is_member() and (store_id is null or rx_can_store(store_id)));
create policy rx_staff_w on rx_staff for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_hosp_r on rx_hospitals for select to authenticated using (rx_is_member());
create policy rx_hosp_w on rx_hospitals for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_dept_r on rx_departments for select to authenticated using (rx_is_member());
create policy rx_dept_w on rx_departments for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_settings_r on rx_settings for select to authenticated using (rx_is_member());
create policy rx_settings_w on rx_settings for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

-- 門市自行維護：常用醫院、片語（全域片語僅管理員）
create policy rx_quick_r on rx_hospital_quick for select to authenticated using (rx_can_store(store_id));
create policy rx_quick_w on rx_hospital_quick for all to authenticated using (rx_can_store(store_id)) with check (rx_can_store(store_id));

create policy rx_phr_r on rx_phrases for select to authenticated using (rx_is_member() and (store_id is null or rx_can_store(store_id)));
create policy rx_phr_w on rx_phrases for all to authenticated
  using ((store_id is null and rx_is_admin()) or (store_id is not null and rx_can_store(store_id)))
  with check ((store_id is null and rx_is_admin()) or (store_id is not null and rx_can_store(store_id)));

-- 寄單資料：只能讀自己門市；寫入一律走 RPC（security definer）
create policy rx_orders_r on rx_orders for select to authenticated using (rx_can_store(store_id));
create policy rx_fills_r  on rx_fills  for select to authenticated using (rx_can_store(store_id));
create policy rx_logs_r   on rx_logs   for select to authenticated using (rx_can_store(store_id));
-- rx_counters 不開放任何 policy

-- ---------------------------------------------------------------------
-- 8.5 調劑系統串接（v1.14）：門市 API 金鑰 + rx_intake
--   調劑輸出程式以 anon key 呼叫 /rest/v1/rpc/rx_intake，並帶門市 API 金鑰（只存 SHA-256 雜湊）
-- ---------------------------------------------------------------------
create table if not exists rx_api_keys (
  id                  bigserial primary key,
  store_id            text not null references rx_stores(id),
  name                text not null,                       -- 例：福原 調劑電腦
  key_prefix          text not null,                       -- 顯示用：rxk_1a2b…
  key_hash            text not null unique,                -- SHA-256(完整金鑰)
  default_staff_name  text not null default '調劑系統',     -- 未帶人員代碼時的記錄名稱
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz,
  key_plain           text,                                -- v1.21 完整金鑰（只能經 rx_api_key_reveal 由管理員查看）
  has_plain           boolean generated always as (key_plain is not null) stored
);
alter table rx_api_keys enable row level security;
drop policy if exists rx_api_keys_r on rx_api_keys;
drop policy if exists rx_api_keys_w on rx_api_keys;
create policy rx_api_keys_r on rx_api_keys for select to authenticated using (rx_is_admin());
create policy rx_api_keys_w on rx_api_keys for update to authenticated using (rx_is_admin()) with check (rx_is_admin());

-- 管理員產生金鑰：完整金鑰只在這一次回傳
create or replace function rx_api_key_create(p_store text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not rx_is_admin() then raise exception '只有系統管理員可以產生金鑰'; end if;
  if not exists (select 1 from rx_stores where id = p_store) then raise exception '找不到門市 %', p_store; end if;
  k := 'rxk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into rx_api_keys (store_id, name, key_prefix, key_hash, key_plain)
  values (p_store, coalesce(nullif(trim(p_name), ''), '調劑電腦'), left(k, 10), encode(sha256(convert_to(k, 'UTF8')), 'hex'), k);
  return k;
end $$;

-- 管理員查看完整金鑰
create or replace function rx_api_key_reveal(p_id bigint) returns text
language plpgsql stable security definer set search_path = public as $$
declare k text;
begin
  if not rx_is_admin() then raise exception '只有系統管理員可以查看金鑰'; end if;
  select key_plain into k from rx_api_keys where id = p_id;
  if k is null then raise exception '這組金鑰是舊版產生的，系統沒有保存完整內容；需要的話請重新產生一組'; end if;
  return k;
end $$;


-- 日期：民國 1151114 / 115/11/14、西元 2026-11-14 / 20261114 → date；無法判讀回傳 null
create or replace function rx_parse_date(t text) returns date
language plpgsql immutable as $$
declare m text[];
begin
  t := trim(coalesce(t, ''));
  begin
    if t ~ '^\d{4}-\d{1,2}-\d{1,2}$' then return t::date; end if;
    if t ~ '^\d{8}$' then return to_date(t, 'YYYYMMDD'); end if;
    m := coalesce(regexp_match(t, '^(\d{2,3})(\d{2})(\d{2})$'), regexp_match(t, '^(\d{1,3})[/.-](\d{1,2})[/.-](\d{1,2})$'));
    if m is not null then return make_date(m[1]::int + 1911, m[2]::int, m[3]::int); end if;
  exception when others then return null;
  end;
  return null;
end $$;

-- 調劑系統送單：p_dry_run = true 只試算（領藥日、帶出名稱、提醒），不建立
create or replace function rx_intake(p_key text, p jsonb, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k rx_api_keys; st rx_stores; v_staff record; o rx_orders;
  v_phone text; v_mobile text; v_birth date; v_notify text[]; v_memo text;
  v_hcode text; v_hname text; v_dcode text; v_dname text;
  v_fills jsonb := '[]'; f jsonb; d date; v_disp date; v_start date; v_days int; v_cur int; v_total int; v_lead int; n int;
  v_warn text[] := '{}'; v_last date; v_payload jsonb; v_res jsonb; v_code text; v_sname text;
  v_field text := null;
begin
  select * into k from rx_api_keys where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex') and active;
  if k.id is null then return jsonb_build_object('ok', false, 'code', 'BAD_KEY', 'message', 'API 金鑰錯誤或已停用'); end if;
  select * into st from rx_stores where id = k.store_id;
  update rx_api_keys set last_used_at = now() where id = k.id;

  -- 重送：同一個 client_ref 直接回傳原本的寄單
  if nullif(trim(p->>'client_ref'), '') is not null then
    select * into o from rx_orders where store_id = k.store_id and client_ref = trim(p->>'client_ref');
    if o.id is not null then
      return rx_intake_result(o.id, true, '{}');
    end if;
  end if;

  -- 人員：有帶代碼就驗證；沒帶記為金鑰預設名稱
  if nullif(trim(p->>'staff_code'), '') is not null then
    select * into v_staff from rx_resolve_staff(k.store_id, p->>'staff_code');
    if v_staff.code is null then
      return jsonb_build_object('ok', false, 'code', 'STAFF_NOT_FOUND', 'field', 'staff_code', 'message', '人員代碼錯誤或未啟用：' || (p->>'staff_code'));
    end if;
    v_code := v_staff.code; v_sname := v_staff.name;
  else
    v_code := null; v_sname := k.default_staff_name;
  end if;

  -- 電話：手機（09 開頭 10 碼）優先，其次市話
  v_phone := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  v_mobile := regexp_replace(coalesce(p->>'mobile', ''), '\D', '', 'g');
  if v_mobile ~ '^09\d{8}$' then v_phone := v_mobile;
  elsif v_phone = '' then v_phone := v_mobile; end if;

  if nullif(p->>'birth_date', '') is not null then
    v_birth := rx_parse_date(p->>'birth_date');
    if v_birth is null then return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'field', 'birth_date', 'message', '生日格式錯誤：' || (p->>'birth_date')); end if;
  end if;

  -- 通知方式：指定 > 藥局備註判斷 > 門市預設
  select coalesce(array_agg(x), '{}') into v_notify from jsonb_array_elements_text(coalesce(p->'notify_methods', '[]')) x
   where x in ('LINE', '簡訊', '電話', '自取');
  if cardinality(v_notify) = 0 then
    v_memo := coalesce(p->>'pharmacy_memo', '');
    v_notify := array(select m from unnest(array['LINE', '簡訊', '電話']) m
                      where (m = 'LINE' and v_memo ~* 'line') or (m <> 'LINE' and position(m in v_memo) > 0));
  end if;
  if cardinality(v_notify) = 0 then
    select coalesce(array_agg(x), '{}') into v_notify from jsonb_array_elements_text(coalesce(st.settings->'default_notify', '[]')) x;
  end if;

  -- 醫院、科別：代碼帶出名稱
  v_hcode := nullif(trim(p->>'hospital_code'), '');
  select name into v_hname from rx_hospitals where code = v_hcode;
  if v_hname is null then v_hname := nullif(trim(p->>'hospital_name'), ''); end if;
  if v_hname is null and v_hcode is not null then v_hname := v_hcode; end if;
  v_dcode := nullif(trim(p->>'dept_code'), '');
  select name into v_dname from rx_departments where code = v_dcode;
  if v_dname is null then v_dcode := null; v_dname := nullif(trim(p->>'dept_name'), ''); end if;   -- 清單外科別只存名稱

  -- 領藥日：指定 fills 優先；否則依 rx 計算
  --   診所算法：第 n 次 = 第一次日期（XML continous_prescription@start_at）+ 天數 ×（n−1）− 9 天
  --   例 28 天：10/27、11/15、12/13；29、30 天的間隔各多 1、2 天
  --   沒有第一次日期時：調劑日 + 天數 ×（n − 本次）− 提前天數
  if jsonb_array_length(coalesce(p->'fills', '[]')) > 0 then
    for f in select * from jsonb_array_elements(p->'fills') loop
      d := rx_parse_date(f->>'due_date');
      if d is null then return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'field', 'fills', 'message', '領藥日格式錯誤：' || coalesce(f->>'due_date', '')); end if;
      v_fills := v_fills || jsonb_build_object('seq', (f->>'seq')::int, 'due_date', d);
    end loop;
  elsif p ? 'rx' then
    v_disp := rx_parse_date(p->'rx'->>'dispense_date');
    v_start := rx_parse_date(p->'rx'->>'start_date');
    v_days := nullif(p->'rx'->>'days', '')::int;
    v_cur := coalesce(nullif(p->'rx'->>'current_seq', '')::int, 1);
    v_total := coalesce(nullif(p->'rx'->>'total', '')::int, 3);
    v_lead := coalesce(nullif(p->'rx'->>'lead_days', '')::int, 9);
    if coalesce(v_start, v_disp) is null or coalesce(v_days, 0) <= 0 then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'field', 'rx', 'message', '第一次日期（或調劑日）、處方天數錯誤');
    end if;
    for n in (v_cur + 1)..least(v_total, 3) loop
      v_fills := v_fills || jsonb_build_object('seq', n, 'due_date',
        case when v_start is not null then v_start + v_days * (n - 1) - v_lead
             else v_disp + v_days * (n - v_cur) - v_lead end);
    end loop;
    if jsonb_array_length(v_fills) = 0 then
      return jsonb_build_object('ok', false, 'code', 'NO_REMAINING_FILL', 'field', 'rx', 'message', '這張慢箋已是最後一次，沒有可寄放的次數');
    end if;
  end if;

  v_payload := jsonb_build_object(
    'patient_name', trim(coalesce(p->>'patient_name', '')),
    'birth_date', coalesce(to_char(v_birth, 'YYYY-MM-DD'), ''),
    'phone', v_phone,
    'notify_methods', to_jsonb(v_notify),
    'note', left(trim(coalesce(p->>'note', '')), 200),
    'hospital_code', coalesce(v_hcode, ''), 'hospital_name', coalesce(v_hname, ''),
    'dept_code', coalesce(v_dcode, ''), 'dept_name', coalesce(v_dname, ''),
    'ext_patient_id', coalesce(nullif(trim(p->>'ext_patient_id'), ''), ''),
    'fills', v_fills,
    'source', 'dispensing', 'client_ref', nullif(trim(p->>'client_ref'), ''));

  -- 提醒：同一病人尚有未完成寄單、領藥日早於最新預作日
  select coalesce(array_agg(format('%s 已有未完成寄單 %s（%s %s）', x.patient_name,
           substr(x.order_no, 1, 6) || '-' || substr(x.order_no, 7, 4) || '-' || substr(x.order_no, 11, 1),
           coalesce(nullif(rx_short_hosp(x.hospital_name), ''), '—'), coalesce(x.dept_name, '—'))), '{}')
    into v_warn
    from (select distinct o2.patient_name, o2.order_no, o2.hospital_name, o2.dept_name
            from rx_orders o2 join rx_fills f2 on f2.order_id = o2.id
           where o2.store_id = k.store_id and o2.patient_name = v_payload->>'patient_name' and o2.status = 'active'
             and f2.status in ('pending', 'prepared')
             and (v_birth is null or o2.birth_date is null or o2.birth_date = to_char(v_birth, 'YYYY-MM-DD'))
           limit 5) x;
  v_last := nullif(st.settings->>'last_prep_date', '')::date;
  if v_last is not null and exists (select 1 from jsonb_array_elements(v_fills) e where (e->>'due_date')::date <= v_last) then
    v_warn := v_warn || ('有領藥日早於或等於目前最新預作日 ' || to_char(v_last, 'YYYY/MM/DD') || '，請直接打單調劑，勿歸入預作資料夾！');
  end if;

  -- 檢查（與網頁相同規則）
  begin
    perform rx_validate_payload(v_payload);
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'message', sqlerrm, 'preview', v_payload);
  end;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'store_id', k.store_id, 'store_name', st.name,
      'staff_name', v_sname, 'preview', v_payload, 'warnings', to_jsonb(v_warn));
  end if;

  begin
    v_res := rx_create_order_core(v_payload, k.store_id, v_code, v_sname);
  exception when unique_violation then
    -- 同時重送：回傳已建立的那張
    select * into o from rx_orders where store_id = k.store_id and client_ref = v_payload->>'client_ref';
    if o.id is not null then return rx_intake_result(o.id, true, '{}'); end if;
    raise;
  end;
  return rx_intake_result((v_res->>'id')::bigint, false, v_warn);
exception when others then
  return jsonb_build_object('ok', false, 'code', 'SERVER', 'message', sqlerrm);
end $$;

-- 醫院簡稱（與網頁 shortHosp 相同規則）
create or replace function rx_short_hosp(n text) returns text
language sql immutable as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(n, ''),
    '[（(〈【<].*?[）)〉】>]', '', 'g'),
    '^.*?(醫療財團法人|財團法人|社團法人)', ''),
    '^(.{2,20}?)基金會(?=.)', ''),
    '^(行政院國軍退除役官兵輔導委員會|行政院衛生署|衛生福利部|國防部|國立|私立|台灣基督長老教會|基督長老教會|天主教)+', ''));
$$;

-- v1.14.2：先前由調劑系統建立的寄單，建檔軌跡改為 intake（可重複執行）
update rx_logs set action = 'intake'
 where action = 'create' and order_id in (select id from rx_orders where source = 'dispensing');

-- 回應內容（含貼紙要印的文字）
create or replace function rx_intake_result(p_id bigint, p_dup boolean, p_warn text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ok', true, 'duplicate', p_dup, 'order_id', o.id, 'order_no', o.order_no,
    'order_no_fmt', substr(o.order_no, 1, 6) || '-' || substr(o.order_no, 7, 4) || '-' || substr(o.order_no, 11, 1),
    'notify_methods', to_jsonb(o.notify_methods),
    'fills', coalesce((select jsonb_agg(jsonb_build_object('seq', f.seq, 'due_date', f.due_date,
               'roc', lpad((extract(year from f.due_date)::int - 1911)::text, 3, '0') || to_char(f.due_date, '/MM/DD')) order by f.seq)
             from rx_fills f where f.order_id = o.id and f.status <> 'cancelled'), '[]'),
    'warnings', to_jsonb(coalesce(p_warn, '{}')),
    'label', jsonb_build_object(
      'order_no', o.order_no,
      'order_no_fmt', substr(o.order_no, 1, 6) || '-' || substr(o.order_no, 7, 4) || '-' || substr(o.order_no, 11, 1),
      'patient_name', o.patient_name,
      'hospital', coalesce((select q.label from rx_hospital_quick q where q.store_id = o.store_id and q.hospital_code = o.hospital_code and q.label <> '' limit 1), rx_short_hosp(o.hospital_name), ''),
      'dept', coalesce(o.dept_name, ''),
      'phone', coalesce(o.phone, ''),
      'notify', case when cardinality(array_remove(o.notify_methods, '自取')) > 0
                     then array_to_string(array_remove(o.notify_methods, '自取'), '/') || '通知' else '自取' end,
      'fills', coalesce((select jsonb_agg(jsonb_build_object('seq', f.seq, 'md', to_char(f.due_date, 'MM/DD')) order by f.seq)
                 from rx_fills f where f.order_id = o.id and f.status <> 'cancelled'), '[]')))
  from rx_orders o where o.id = p_id;
$$;

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
  rx_luhn(text), rx_valid_order_no(text), rx_api_key_create(text, text), rx_api_key_reveal(bigint)
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
-- 金鑰表：欄位權限不開放 key_plain、key_hash；修改只能改名稱、啟用（v1.21）
revoke select, update on rx_api_keys from authenticated;
grant select (id, store_id, name, key_prefix, default_staff_name, active, created_at, last_used_at, has_plain) on rx_api_keys to authenticated;
grant update (name, active) on rx_api_keys to authenticated;
grant select on rx_fill_view to authenticated;

-- 匯入用的暫存表（含病人資料）用完就刪掉
drop table if exists rx_import_old;
drop table if exists rx_import_mid;

-- ---------------------------------------------------------------------
-- 10. 預設資料（請依實際門市修改）
-- ---------------------------------------------------------------------
insert into rx_stores (id, name, short_name, sort, settings) values
  ('03', '福原藥局', '福原', 1, '{"prep_days_ahead":7,"overdue_days":7,"bridge_url":"http://localhost:5880"}'),
  ('04', '日新藥局', '日新', 2, '{"prep_days_ahead":7,"overdue_days":7}'),
  ('07', '博亞藥局', '博亞', 3, '{"prep_days_ahead":7,"overdue_days":7}')
on conflict (id) do nothing;

insert into rx_settings (key, value, note) values
  ('notify_template', to_jsonb('{name} 您好，您於{store}寄放的慢性處方箋（第{seq}次）藥品已備妥，{date} 起可攜帶健保卡來領取，謝謝！'::text), '通知訊息範本，可用 {name}{store}{seq}{date}{order_no}'),
  ('receipt_footer', to_jsonb('請保留此單據，領藥時出示可加快作業。'::text), '發票機單據底部文字')
on conflict (key) do nothing;

insert into rx_phrases (store_id, text, sort)
select null, t, n from (values ('已收健保卡', 1), ('自費品項另計', 2), ('需調藥', 3),
  ('家屬代領', 4), ('請先電話確認', 5), ('藥品缺貨待補', 6)) v(t, n)
where not exists (select 1 from rx_phrases where store_id is null);
