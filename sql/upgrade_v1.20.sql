-- v1.20 醫院清單檢查：只檢查網頁手動輸入（新增；修改時醫院有變動才檢查），調劑系統匯入不檢查（可重複執行）

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

revoke execute on function rx_validate_payload(jsonb), rx_check_hospital(jsonb) from public, anon, authenticated;
