alter table public.work_orders add column if not exists storage_fee_started_at timestamptz;
alter table public.work_orders add column if not exists storage_fee_last_accrued_at timestamptz;

-- The QR approval creates the first $25 line. This guarded helper can be called
-- by the scheduled POS maintenance job to add one $25 increment for every full
-- day after the last accrual without ever backcharging pre-reminder pickup time.
create or replace function public.storage_fee_due_days(last_accrued_at timestamptz, at_time timestamptz default now())
returns integer language sql stable as $$
  select case when last_accrued_at is null then 1 else greatest(0, floor(extract(epoch from (at_time - last_accrued_at)) / 86400)::integer) end;
$$;

create or replace function public.accrue_open_storage_fees(at_time timestamptz default now())
returns integer language plpgsql security invoker set search_path = public as $$
declare ticket record; due_days integer; charge numeric; next_items jsonb; next_totals jsonb; updated_count integer := 0;
begin
  for ticket in select * from public.work_orders where storage_fee_last_accrued_at is not null and lower(coalesce(status, '')) <> 'closed' and picked_up_at is null and client_pickup_date is null for update loop
    due_days := public.storage_fee_due_days(ticket.storage_fee_last_accrued_at, at_time);
    if due_days <= 0 then continue; end if;
    charge := due_days * 25;
    next_items := coalesce(ticket.items, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('id', 'storage-' || extract(epoch from at_time)::bigint || '-' || ticket.legacy_id, 'repair', 'Storage Fee', 'description', 'Storage Fee (' || due_days || ' day' || case when due_days = 1 then '' else 's' end || ' × $25)', 'labor', charge, 'parts', 0, 'taxable', false, 'feeType', 'storage', 'accruedAt', at_time));
    next_totals := jsonb_set(jsonb_set(coalesce(ticket.totals, '{}'::jsonb), '{total}', to_jsonb(coalesce((ticket.totals->>'total')::numeric, 0) + charge), true), '{remaining}', to_jsonb(coalesce((ticket.totals->>'remaining')::numeric, 0) + charge), true);
    update public.work_orders set items = next_items, totals = next_totals, storage_fee_last_accrued_at = at_time, storage_fee_reviewed_at = at_time, updated_at = at_time where id = ticket.id;
    updated_count := updated_count + 1;
  end loop;
  return updated_count;
end;
$$;

revoke all on function public.accrue_open_storage_fees(timestamptz) from public, anon, authenticated;

-- Hourly is intentional: it respects each reminder's exact start time while
-- the function only creates a charge after a full 24-hour interval.
do $schedule$
begin
  create extension if not exists pg_cron;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'gadgetboy-storage-fee-accrual-hourly') then
      perform cron.unschedule(jobid) from cron.job where jobname = 'gadgetboy-storage-fee-accrual-hourly';
    end if;
    perform cron.schedule('gadgetboy-storage-fee-accrual-hourly', '0 * * * *', 'select public.accrue_open_storage_fees();');
  end if;
exception when undefined_table or undefined_function or insufficient_privilege then
  raise notice 'pg_cron is unavailable; storage fees will accrue on the next POS/QR workflow pass.';
end;
$schedule$;
