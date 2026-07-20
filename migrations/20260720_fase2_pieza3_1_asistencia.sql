-- FASE 2 · PIEZA 3.1 — tabla asistencia (nace CERRADA) + min salida configurable

-- Mínimo de minutos entre ENTRADA y SALIDA (evita que un doble toque cierre el día).
alter table public.motel_config
  add column if not exists asistencia_min_salida_min integer default 30;

create table if not exists public.asistencia (
  id             bigint generated always as identity primary key,
  motel_id       uuid    not null,
  staff_id       text    not null,
  tipo           text,                 -- snapshot de staff.type (nomina/extra)
  business_day   text    not null,
  shift_id       text    not null,
  entrada_ms     bigint  not null,
  salida_ms      bigint,
  entrada_lat    double precision,
  entrada_lng    double precision,
  entrada_dist_m integer,
  salida_lat     double precision,
  salida_lng     double precision,
  salida_dist_m  integer,
  qr_version     integer,
  extra_staff_id bigint,               -- link a extra_staff para extras (null en nómina)
  created_at     timestamptz default now(),
  -- Una fila por persona por día: entrada = insert, salida = update de esta fila.
  unique (motel_id, staff_id, business_day)
);

create index if not exists idx_asistencia_motel_dia on public.asistencia (motel_id, business_day);
create index if not exists idx_asistencia_staff_dia on public.asistencia (staff_id, business_day);

-- NACE CERRADA (regla de oro pto 7): revoke a roles cliente + RLS deny-all.
-- Solo el service_role (backends POS/colaborador) escribe/lee.
revoke all on table public.asistencia from anon, authenticated, public;
alter table public.asistencia enable row level security;
grant all on table public.asistencia to service_role;

-- rollback:
--   drop table if exists public.asistencia;
--   alter table public.motel_config drop column if exists asistencia_min_salida_min;
