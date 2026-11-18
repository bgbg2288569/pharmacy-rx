-- v1.21 調劑串接金鑰：新產生的金鑰保存完整內容，管理員可在「金鑰清單」按「顯示」再次查看（可重複執行）
-- ・完整金鑰存在 key_plain，一般帳號（含同專案其他系統的登入者）讀不到這個欄位
-- ・只能透過 rx_api_key_reveal() 取得，函式內檢查系統管理員
-- ・v1.21 以前產生的金鑰只存雜湊值，無法還原；需要的話請重新產生一組並停用舊的

alter table rx_api_keys add column if not exists key_plain text;
alter table rx_api_keys add column if not exists has_plain boolean generated always as (key_plain is not null) stored;

-- 欄位權限：不開放 key_plain、key_hash；修改只能改名稱、啟用
revoke select, update on rx_api_keys from authenticated;
revoke all on rx_api_keys from anon;
grant select (id, store_id, name, key_prefix, default_staff_name, active, created_at, last_used_at, has_plain) on rx_api_keys to authenticated;
grant update (name, active) on rx_api_keys to authenticated;

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

revoke execute on function rx_api_key_create(text, text), rx_api_key_reveal(bigint) from public, anon, authenticated;
grant execute on function rx_api_key_create(text, text), rx_api_key_reveal(bigint) to authenticated;

-- 檢查：下面應該只列出 authenticated 可讀的欄位，且不含 key_plain、key_hash
select grantee, column_name, privilege_type from information_schema.column_privileges
where table_schema = 'public' and table_name = 'rx_api_keys' and grantee in ('anon', 'authenticated')
order by grantee, privilege_type, column_name;
