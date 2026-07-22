-- Plan B (P1) — novedades sobre staff_mensajes + auditoría de firma del flotante.
-- destino = a dónde navega el tap; el flotante lee no-leídas (leido_colab=false) y la ✕ firma.
alter table public.staff_mensajes
  add column if not exists destino text,      -- CHAT | CALENDARIO | DOCUMENTO | CAPACITACION
  add column if not exists destino_ref text;  -- id/fecha para navegar

-- tipos nuevos de novedad (P2): TURNO, DOCUMENTO, CAPACITACION
alter table public.staff_mensajes drop constraint if exists staff_mensajes_tipo_check;
alter table public.staff_mensajes add constraint staff_mensajes_tipo_check
  check (tipo in ('MENSAJE','COMUNICADO','PERMISO','TURNO','DOCUMENTO','CAPACITACION'));

-- Constancia del empleador: qué lista vio, cuándo y cómo la resolvió (tocó cuál / cerró).
create table if not exists public.staff_novedades_vistas (
  id          bigint generated always as identity primary key,
  motel_id    uuid    not null,
  staff_id    text    not null,
  mensaje_ids jsonb   not null,
  vista_ms    bigint,
  resolucion  text check (resolucion in ('TOCO','CERRO')),
  toco_id     bigint,
  created_at  timestamptz default now()
);
create index if not exists idx_novvistas_staff on public.staff_novedades_vistas (motel_id, staff_id, vista_ms);

-- nace CERRADA (regla de oro)
revoke all on table public.staff_novedades_vistas from anon, authenticated, public;
alter table public.staff_novedades_vistas enable row level security;
grant all on table public.staff_novedades_vistas to service_role;
-- rollback: drop table if exists public.staff_novedades_vistas;
--           alter table public.staff_mensajes drop column if exists destino, drop column if exists destino_ref;
