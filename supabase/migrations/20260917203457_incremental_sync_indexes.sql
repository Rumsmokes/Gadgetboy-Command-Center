-- Supports cache-first synchronization by allowing each client to request only
-- rows changed after its (updated_at, id) cursor within one shop.
create index if not exists customers_shop_updated_id_idx
  on public.customers (shop_id, updated_at, id);
create index if not exists staff_profiles_shop_updated_id_idx
  on public.staff_profiles (shop_id, updated_at, id);
create index if not exists work_orders_shop_updated_id_idx
  on public.work_orders (shop_id, updated_at, id);
create index if not exists sales_shop_updated_id_idx
  on public.sales (shop_id, updated_at, id);
create index if not exists calendar_events_shop_updated_id_idx
  on public.calendar_events (shop_id, updated_at, id);
create index if not exists calendar_notes_shop_updated_id_idx
  on public.calendar_notes (shop_id, updated_at, id);
create index if not exists purchase_orders_shop_updated_id_idx
  on public.purchase_orders (shop_id, updated_at, id);
create index if not exists shop_settings_shop_updated_id_idx
  on public.shop_settings (shop_id, updated_at, id);
create index if not exists products_shop_updated_id_idx
  on public.products (shop_id, updated_at, id);
create index if not exists product_categories_shop_updated_id_idx
  on public.product_categories (shop_id, updated_at, id);
create index if not exists device_categories_shop_updated_id_idx
  on public.device_categories (shop_id, updated_at, id);
create index if not exists repair_categories_shop_updated_id_idx
  on public.repair_categories (shop_id, updated_at, id);
create index if not exists part_sources_shop_updated_id_idx
  on public.part_sources (shop_id, updated_at, id);
