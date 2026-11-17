-- v1.20 醫院必須是醫事機構清單內的院所（網頁與調劑系統串接都適用，可重複執行）
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
  -- 醫院必須是醫事機構清單內的院所
  if coalesce(p->>'hospital_code', '') = '' then
    raise exception '%', case when coalesce(trim(p->>'hospital_name'), '') <> ''
      then '「' || trim(p->>'hospital_name') || '」不在醫院清單內，請從清單選擇醫院' else '請選擇醫院' end;
  end if;
  if not exists (select 1 from rx_hospitals where code = p->>'hospital_code') then
    raise exception '院所代號 % 不在醫院清單內', p->>'hospital_code';
  end if;
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
revoke execute on function rx_validate_payload(jsonb) from public, anon, authenticated;
