alter table public.repair_categories
  add column if not exists warranty_days integer,
  add column if not exists warranty_excluded boolean not null default false;

alter table public.repair_categories
  drop constraint if exists repair_categories_warranty_days_positive;
alter table public.repair_categories
  add constraint repair_categories_warranty_days_positive
  check (warranty_days is null or warranty_days > 0);

create table if not exists public.repair_family_warranties (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  repair_family text not null,
  warranty_days integer not null check (warranty_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, repair_family)
);

create table if not exists public.warranty_coverages (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_work_order_legacy_id bigint not null,
  source_item_key text not null,
  repair_label text not null,
  warranty_days integer not null check (warranty_days > 0),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  claim_count integer not null default 0 check (claim_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, source_work_order_legacy_id, source_item_key)
);

create table if not exists public.warranty_claims (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  coverage_id uuid not null references public.warranty_coverages(id) on delete cascade,
  warranty_work_order_legacy_id bigint not null,
  resolution_note text,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (shop_id, warranty_work_order_legacy_id)
);

create index if not exists warranty_coverages_source_idx on public.warranty_coverages(shop_id, source_work_order_legacy_id);
create index if not exists warranty_claims_coverage_idx on public.warranty_claims(shop_id, coverage_id, created_at desc);

alter table public.repair_family_warranties enable row level security;
alter table public.warranty_coverages enable row level security;
alter table public.warranty_claims enable row level security;

grant select, insert, update, delete on public.repair_family_warranties to authenticated;
grant select, insert, update, delete on public.warranty_coverages to authenticated;
grant select, insert, update, delete on public.warranty_claims to authenticated;

create policy "active staff manage repair family warranties" on public.repair_family_warranties for all to authenticated using (public.is_active_shop_staff(shop_id)) with check (public.is_active_shop_staff(shop_id));
create policy "active staff read warranty coverages" on public.warranty_coverages for select to authenticated using (public.is_active_shop_staff(shop_id));
create policy "active staff manage warranty claims" on public.warranty_claims for all to authenticated using (public.is_active_shop_staff(shop_id)) with check (public.is_active_shop_staff(shop_id));
