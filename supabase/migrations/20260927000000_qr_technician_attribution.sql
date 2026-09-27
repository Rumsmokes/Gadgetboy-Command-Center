alter table public.client_update_history add column if not exists technician_id text;
alter table public.client_update_history add column if not exists technician_name text;
create index if not exists client_update_history_technician_idx on public.client_update_history(shop_id, technician_id, created_at desc);

create table if not exists public.qr_technician_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  qr_token_id uuid not null references public.qr_status_tokens(id) on delete cascade,
  staff_profile_id uuid references public.staff_profiles(id) on delete set null,
  legacy_technician_id text not null,
  session_token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists qr_technician_sessions_active_idx on public.qr_technician_sessions(shop_id, qr_token_id, expires_at) where revoked_at is null;
alter table public.qr_technician_sessions enable row level security;
revoke all on public.qr_technician_sessions from anon, authenticated;
