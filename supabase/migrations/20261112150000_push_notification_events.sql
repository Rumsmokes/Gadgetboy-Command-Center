create table public.push_notification_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  event_key text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (shop_id, event_key)
);

create index push_notification_events_shop_created_at_idx
  on public.push_notification_events (shop_id, created_at desc);

alter table public.push_notification_events enable row level security;

-- This table is an internal server-side idempotency ledger. Only the
-- authenticated Edge Function's service client writes it.
revoke all on public.push_notification_events from anon, authenticated;
