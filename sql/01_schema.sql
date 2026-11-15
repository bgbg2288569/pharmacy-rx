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
language plpgsql immutable as $$
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

create or replace function rx_create_order(p jsonb, p_staff text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_store text; v_staff record; v_id bigint; v_no text; f jsonb; v_hname text; v_dname text;
begin
  v_store := coalesce(nullif(p->>'store_id', ''), rx_my_store());
  if not rx_can_store(v_store) then raise exception '沒有此門市的權限'; end if;
  perform rx_validate_payload(p);
  select * into v_staff from rx_staff_or_raise(v_store, p_staff);

  select name into v_hname from rx_hospitals where code = nullif(p->>'hospital_code', '');
  select name into v_dname from rx_departments where code = nullif(p->>'dept_code', '');

  v_no := rx_next_order_no();
  if nullif(p->>'family_no', '') is not null and not exists
     (select 1 from rx_orders where order_no = p->>'family_no' and store_id = v_store) then
    raise exception '找不到同行家人的寄單 %', p->>'family_no';
  end if;
  insert into rx_orders (order_no, store_id, patient_name, phone, notify_methods, note,
                         hospital_code, hospital_name, dept_code, dept_name, ext_patient_id,
                         created_staff_code, created_staff_name, birth_date, family_no)
  values (v_no, v_store, trim(p->>'patient_name'), nullif(p->>'phone', ''),
          array(select jsonb_array_elements_text(p->'notify_methods')),
          nullif(trim(coalesce(p->>'note', '')), ''),
          nullif(p->>'hospital_code', ''), coalesce(v_hname, nullif(p->>'hospital_name', '')),
          nullif(p->>'dept_code', ''), coalesce(v_dname, nullif(p->>'dept_name', '')),
          nullif(p->>'ext_patient_id', ''), v_staff.code, v_staff.name,
          nullif(p->>'birth_date', ''), nullif(p->>'family_no', ''))
  returning id into v_id;

  for f in select * from jsonb_array_elements(p->'fills') loop
    insert into rx_fills (order_id, store_id, seq, due_date)
    values (v_id, v_store, (f->>'seq')::smallint, (f->>'due_date')::date);
  end loop;
  -- 第一位家人也標上群組編號
  if nullif(p->>'family_no', '') is not null then
    update rx_orders set family_no = p->>'family_no' where order_no = p->>'family_no' and family_no is null;
  end if;

  insert into rx_logs (order_id, store_id, action, detail, staff_code, staff_name)
  values (v_id, v_store, 'create', p - 'store_id', v_staff.code, v_staff.name);

  return jsonb_build_object('id', v_id, 'order_no', v_no);
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
                       where f.store_id = p_store and f.status = 'prepared' and not ('自取' = any(o.notify_methods) and cardinality(o.notify_methods) = 1)),
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
                                'cancel_reasons','last_prep_date'];
        clean jsonb := '{}'::jsonb; k text;
begin
  if not rx_can_store(p_store) then raise exception '沒有此門市的權限'; end if;
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
create policy rx_stores_r on rx_stores for select to authenticated using (true);
create policy rx_stores_w on rx_stores for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_users_r on rx_users for select to authenticated using (id = auth.uid() or rx_is_admin());
create policy rx_users_w on rx_users for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_staff_r on rx_staff for select to authenticated using (store_id is null or rx_can_store(store_id));
create policy rx_staff_w on rx_staff for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_hosp_r on rx_hospitals for select to authenticated using (true);
create policy rx_hosp_w on rx_hospitals for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_dept_r on rx_departments for select to authenticated using (true);
create policy rx_dept_w on rx_departments for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

create policy rx_settings_r on rx_settings for select to authenticated using (true);
create policy rx_settings_w on rx_settings for all to authenticated using (rx_is_admin()) with check (rx_is_admin());

-- 門市自行維護：常用醫院、片語（全域片語僅管理員）
create policy rx_quick_r on rx_hospital_quick for select to authenticated using (rx_can_store(store_id));
create policy rx_quick_w on rx_hospital_quick for all to authenticated using (rx_can_store(store_id)) with check (rx_can_store(store_id));

create policy rx_phr_r on rx_phrases for select to authenticated using (store_id is null or rx_can_store(store_id));
create policy rx_phr_w on rx_phrases for all to authenticated
  using ((store_id is null and rx_is_admin()) or (store_id is not null and rx_can_store(store_id)))
  with check ((store_id is null and rx_is_admin()) or (store_id is not null and rx_can_store(store_id)));

-- 寄單資料：只能讀自己門市；寫入一律走 RPC（security definer）
create policy rx_orders_r on rx_orders for select to authenticated using (rx_can_store(store_id));
create policy rx_fills_r  on rx_fills  for select to authenticated using (rx_can_store(store_id));
create policy rx_logs_r   on rx_logs   for select to authenticated using (rx_can_store(store_id));
-- rx_counters 不開放任何 policy

-- RPC 權限：只給登入者（只處理 rx_ 函式，不影響同專案其他系統）
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'rx\_%' loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;
grant execute on function rx_create_order(jsonb, text), rx_update_order(bigint, jsonb, text),
  rx_cancel_order(bigint, text, text), rx_log_print(bigint, text), rx_fill_action(bigint, text, text, jsonb),
  rx_scan(text, text, date, date, text), rx_search(jsonb), rx_patient_suggest(text, text),
  rx_dashboard(text, date, date, int), rx_update_store_settings(text, jsonb), rx_due_counts(text, date, date),
  rx_link_family(bigint, bigint, text), rx_unlink_family(bigint, text),
  rx_resolve_staff(text, text), rx_is_admin(), rx_my_store(), rx_can_store(text),
  rx_luhn(text), rx_valid_order_no(text)
to authenticated;
grant select on rx_fill_view to authenticated;

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
