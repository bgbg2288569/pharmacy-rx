-- v1.15 掃描處方箋 QR 比對病人（可重複執行）
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
revoke execute on function rx_patient_match(text, text, text[], text[]) from public, anon;
grant execute on function rx_patient_match(text, text, text[], text[]) to authenticated;
