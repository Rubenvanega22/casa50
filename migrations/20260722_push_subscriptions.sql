-- Etapa B (Web Push) — suscripciones push por dispositivo. Nace CERRADA (regla de oro).
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  motel_id   uuid    not null,
  staff_id   text    not null,
  endpoint   text    not null,
  p256dh     text    not null,
  auth       text    not null,
  ua         text,
  created_ms bigint,
  created_at timestamptz default now(),
  unique (motel_id, endpoint)
);
create index if not exists idx_push_staff on public.push_subscriptions (motel_id, staff_id);

revoke all on table public.push_subscriptions from anon, authenticated, public;
alter table public.push_subscriptions enable row level security;
grant all on table public.push_subscriptions to service_role;
-- rollback: drop table if exists public.push_subscriptions;
