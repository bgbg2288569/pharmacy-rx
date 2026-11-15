-- v1.16 預作通知：待通知只計算領藥日已到（今天及之前）的處方（可重複執行）
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
