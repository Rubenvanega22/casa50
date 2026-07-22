-- FASE 2 · Expediente/Documentos — tabla staff_documentos (nace CERRADA)
-- Lo más delicado del sistema: contratos e incapacidades médicas. Archivos en buckets
-- PRIVADOS (staff-docs / incapacidades, creados en Pieza 1). Nunca URL pública; descarga
-- solo por signed URL de vida corta (60s) tras verificar propiedad (backend colaborador).
create table if not exists public.staff_documentos (
  id           bigint generated always as identity primary key,
  motel_id     uuid    not null,
  staff_id     text    not null,           -- dueño del documento
  tipo         text    not null,           -- 'empresa' (sube admin) | 'incapacidad' (sube colaborador)
  titulo       text    not null,           -- título libre (admin) / auto "Incapacidad · N días"
  bucket       text    not null,           -- 'staff-docs' | 'incapacidades'
  path         text    not null,           -- ruta en el bucket (NUNCA URL pública)
  mime         text,
  visible      boolean default false,      -- toggle admin "Lo ve"/"Oculto"; incapacidad propia = true
  estado       text,                       -- incapacidad: EN_REVISION|VALIDADA|RECHAZADA ; empresa: null
  inc_dias     int,                        -- incapacidad: días
  inc_desde    date,                       -- incapacidad: fecha inicio
  subido_por   text    not null,
  subido_rol   text,                       -- 'ADMIN' | 'COLAB'
  created_ms   bigint,
  validado_por text, validado_ms bigint,   -- auditoría de validación (admin)
  anulado      boolean default false, anulado_por text, anulado_ms bigint,  -- anular, nunca borrar
  created_at   timestamptz default now()
);
create index if not exists idx_staffdoc_staff on public.staff_documentos (motel_id, staff_id);

-- NACE CERRADA (regla de oro pto 7): revoke a roles cliente + RLS deny-all; solo service_role.
revoke all on table public.staff_documentos from anon, authenticated, public;
alter table public.staff_documentos enable row level security;
grant all on table public.staff_documentos to service_role;

-- PENDIENTE (al construir Personal en el POS): agregar 'staff_documentos' a TENANT_TABLES
-- (para que tSelect lo scopee por motel) + endpoints admin (subir/toggle visibilidad/validar).
-- rollback: drop table if exists public.staff_documentos;
