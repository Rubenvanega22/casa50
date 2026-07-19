-- ============================================================================
-- FASE 2 · PIEZA 1 — Cimientos de identidad + config base
-- Todo aditivo/nullable. Tablas nuevas NACEN CERRADAS (REVOKE + RLS): solo el
-- service_role escribe; la app colaborador escribira via backend con carnet.
-- Rol: CAMARERA absorbe 'Camareria', PATIERO absorbe 'Patio'.
-- ============================================================================

-- pgcrypto para hashear el PIN en Pieza 2
create extension if not exists pgcrypto;

-- 1) STAFF: expediente + credencial + rol normalizado
alter table public.staff
  add column if not exists correo text,
  add column if not exists eps text,
  add column if not exists arl text,
  add column if not exists pension text,
  add column if not exists caja text,
  add column if not exists foto_url text,
  add column if not exists rol text,
  add column if not exists pin_hash text,
  add column if not exists pin_reset_ms bigint,
  add column if not exists pin_reset_por text,
  add column if not exists estado_registro text default 'APROBADO';

update public.staff set rol = case
  when lower(area) = 'recepcion'                 then 'RECEPCION'
  when lower(area) in ('camarera','camareria')   then 'CAMARERA'
  when lower(area) in ('patio','patiero')         then 'PATIERO'
  when lower(area) = 'mantenimiento'             then 'MANTENIMIENTO'
  when lower(area) = 'administrador'             then 'ADMINISTRADOR'
  when lower(area) = 'servicios'                 then 'SERVICIOS'
  else 'OTRO' end
  where rol is null;

alter table public.staff add constraint staff_rol_chk
  check (rol in ('RECEPCION','CAMARERA','PATIERO','MANTENIMIENTO','ADMINISTRADOR','SERVICIOS','OTRO'));

-- 2) LINK real (sin borrar person_name = historico inmutable)
alter table public.schedule    add column if not exists staff_id text references public.staff(id);
alter table public.extra_staff add column if not exists staff_id text references public.staff(id);

update public.schedule sc set staff_id = s.id
  from public.staff s
  where lower(trim(sc.person_name)) = lower(trim(s.name)) and sc.staff_id is null;

-- 3) MOTEL_CONFIG: geoloc + QR (dos modos) + recargos (multi-tenant)
create table if not exists public.motel_config (
  motel_id uuid primary key,
  geo_lat double precision,
  geo_lng double precision,
  geo_radio_m integer default 100,
  qr_modo text default 'IMAGEN' check (qr_modo in ('IMAGEN','ROTATIVO')),
  qr_version integer default 1,       -- IMAGEN: "Regenerar" => qr_version++ invalida el impreso anterior
  qr_rota_seg integer default 60,     -- ROTATIVO: ventana de tiempo
  recargo_nocturno_pct numeric default 0,
  recargo_dominical_pct numeric default 0,
  recargo_festivo_pct numeric default 0,
  updated_at timestamptz default now());

-- 4) FESTIVOS (por motel, editable) — el SEED va aparte (previa confirmacion)
create table if not exists public.festivos (
  id bigserial primary key,
  motel_id uuid not null,
  fecha date not null,
  nombre text not null,
  unique (motel_id, fecha));

-- 5) TARIFAS_EXTRA (las 8 casillas, por motel, editable)
create table if not exists public.tarifas_extra (
  id bigserial primary key,
  motel_id uuid not null,
  turno text not null check (turno in ('8h','12h')),
  franja text not null check (franja in ('DIURNA','NOCTURNA')),
  dia_tipo text not null check (dia_tipo in ('LV','DOMFEST')),
  valor numeric not null,
  unique (motel_id, turno, franja, dia_tipo));

-- ===== nacer CERRADAS (CLAUDE.md pto 7): solo service_role =====
revoke all on public.motel_config  from anon, authenticated;
revoke all on public.festivos      from anon, authenticated;
revoke all on public.tarifas_extra from anon, authenticated;
alter table public.motel_config  enable row level security;
alter table public.festivos      enable row level security;
alter table public.tarifas_extra enable row level security;

-- 6) SEED tarifas (Casa 50) — las 8 del documento maestro
insert into public.tarifas_extra (motel_id, turno, franja, dia_tipo, valor) values
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','8h','DIURNA','LV',80000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','8h','NOCTURNA','LV',85000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','8h','DIURNA','DOMFEST',85000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','8h','NOCTURNA','DOMFEST',90000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','12h','DIURNA','LV',95000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','12h','NOCTURNA','LV',103000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','12h','DIURNA','DOMFEST',105000),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','12h','NOCTURNA','DOMFEST',115000)
on conflict (motel_id, turno, franja, dia_tipo) do nothing;

-- 7) SEED motel_config (Casa 50): radio 100m, recargos 0 (llegan despues), coords TBD
insert into public.motel_config (motel_id, geo_radio_m, qr_modo, qr_version)
values ('24992a8a-48d8-4444-a50f-2d6c7d949828', 100, 'IMAGEN', 1)
on conflict (motel_id) do nothing;

-- 8) BUCKETS PRIVADOS (Storage) para expediente e incapacidades
insert into storage.buckets (id, name, public) values
  ('staff-docs','staff-docs',false),
  ('incapacidades','incapacidades',false)
on conflict (id) do nothing;
