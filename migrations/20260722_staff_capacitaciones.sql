-- Capacitaciones (P4): evento programado (fecha+hora+título) por área o a todos. Nace CERRADA.
create table if not exists public.staff_capacitaciones (
  id         bigint generated always as identity primary key,
  motel_id   uuid    not null,
  fecha      date    not null,
  hora       text,
  titulo     text    not null,
  destino    text    not null
             check (destino in ('TODOS','RECEPCION','CAMARERA','PATIERO','MANTENIMIENTO','SERVICIOS')),
  created_por text, created_ms bigint,
  anulado    boolean default false, anulado_por text, anulado_ms bigint,
  created_at timestamptz default now()
);
create index if not exists idx_capac_mes on public.staff_capacitaciones (motel_id, fecha);

revoke all on table public.staff_capacitaciones from anon, authenticated, public;
alter table public.staff_capacitaciones enable row level security;
grant all on table public.staff_capacitaciones to service_role;
-- rollback: drop table if exists public.staff_capacitaciones;
