-- FASE 2 · PIEZA 5a — Cimientos de la GRILLA (tabla nueva, read-model limpio).
-- Reemplaza el modelo de `schedule` (almacen tonto, delete+insert por mes, SIN staff_id).
-- Aqui: 1 celda por (staff_id, fecha) con UPSERT estable, staff_id OBLIGATORIO (la
-- desconexion con la app colaborador no puede repetirse), estado+flags para novedades.
-- Nace CERRADA (regla de oro): REVOKE + RLS deny-all + solo service_role.

create table if not exists public.grilla (
  id            bigint generated always as identity primary key,
  motel_id      uuid    not null,
  staff_id      text    not null references public.staff(id),  -- 🔑 SIEMPRE la persona real
  person_name   text,                       -- display denormalizado (staff_id es la autoridad)
  fecha         date    not null,            -- fecha real (no el "week_start" mentiroso de schedule)
  shift_id      text,                        -- SHIFT_1/2/3 (null si novedad sin turno)
  area          text    not null,            -- normalizada (Recepcion/Camareria/Patio/Mantenimiento)
  hora_entrada  text default '', hora_salida text default '',  -- doble turno = horas extendidas (6:00-21:00)
  estado        text    not null default 'TRABAJO'
                  check (estado in ('TRABAJO','DESCANSO','VACACIONES','INCAPACIDAD','PERMISO','NO_VINO')),
  es_comodin        boolean default false,   -- celda AZUL: turno cubierto por el comodin del mes (5.2)
  es_mantenimiento  boolean default false,   -- M amarilla de la semana, camareria (5.3)
  novedad_ref   bigint,                      -- puntero a staff_permisos/staff_documentos/vacaciones
  -- auditoria (anular nunca borrar + "que era antes")
  creado_por text, creado_ms bigint,
  editado_por text, editado_ms bigint, valor_anterior jsonb,
  anulado boolean default false, anulado_por text, anulado_ms bigint,
  created_at timestamptz default now(),
  unique (motel_id, staff_id, fecha)         -- 1 celda por persona-dia -> upsert estable, sin churn de ids
);
create index if not exists idx_grilla_persona on public.grilla (motel_id, staff_id, fecha);
create index if not exists idx_grilla_dia     on public.grilla (motel_id, fecha);

-- ===== nace CERRADA: solo service_role =====
revoke all on table public.grilla from anon, authenticated, public;
alter table public.grilla enable row level security;
grant all on table public.grilla to service_role;

-- Migracion de datos schedule -> grilla (ver 20260722_fase2_pieza5a_grilla_datos.sql):
--   estado='TRABAJO' para todas (hoy descanso = ausencia de fila; sin vacaciones persistidas),
--   area normalizada, staff_id ya backfilleado (0 sin persona), 0 duplicados (verificado).
-- PENDIENTE Etapa 2: apiSaveGrilla (upsert+auditoria) + grilla nueva del POS; luego asistencia
-- snapshotea grilla_id y se retira `schedule`. Agregar 'grilla' a TENANT_TABLES al usarla en el POS.
-- rollback: drop table if exists public.grilla;
