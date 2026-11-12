create table public.push_notification_devices (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('android')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (token)
);

create index push_notification_devices_shop_enabled_idx
  on public.push_notification_devices (shop_id, enabled, updated_at desc);

alter table public.push_notification_devices enable row level security;
grant select, insert, update, delete on public.push_notification_devices to authenticated;

create policy "staff read own push devices"
  on public.push_notification_devices for select to authenticated
  using (user_id = (select auth.uid()) and public.is_active_shop_staff(shop_id));
create policy "staff add own push devices"
  on public.push_notification_devices for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_shop_staff(shop_id));
create policy "staff update own push devices"
  on public.push_notification_devices for update to authenticated
  using (user_id = (select auth.uid()) and public.is_active_shop_staff(shop_id))
  with check (user_id = (select auth.uid()) and public.is_active_shop_staff(shop_id));
create policy "staff delete own push devices"
  on public.push_notification_devices for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_active_shop_staff(shop_id));

create trigger push_notification_devices_set_updated_at
  before update on public.push_notification_devices
  for each row execute function public.set_updated_at();
