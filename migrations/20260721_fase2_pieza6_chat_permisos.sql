-- FASE 2 · PIEZA 6 (parte tablas) — Chat laboral 1-a-1 + permisos + comunicados.
-- Canal PRIVADO colaborador<->admin. Nace TODO cerrado (regla de oro pto 7):
-- REVOKE + RLS deny-all; solo service_role escribe (endpoints con carnet firmado).
-- Anular, nunca borrar. Multi-tenant motel_id en las 3 tablas.

-- 1) HILO de mensajes: individual (MENSAJE) y copias de comunicado (COMUNICADO),
--    mas la tarjeta de permiso (PERMISO) que aparece en linea en el chat.
create table if not exists public.staff_mensajes (
  id            bigint generated always as identity primary key,
  motel_id      uuid    not null,
  staff_id      text    not null,               -- dueño del hilo (el colaborador)
  origen        text    not null check (origen in ('COLAB','ADMIN')),
  tipo          text    not null default 'MENSAJE'
                        check (tipo in ('MENSAJE','COMUNICADO','PERMISO')),
  cuerpo        text    not null,               -- texto libre / resumen auto del permiso
  comunicado_id bigint,                         -- copias de comunicado -> padre (null si no)
  permiso_id    bigint,                         -- tarjeta PERMISO -> staff_permisos (null si no)
  autor         text,                           -- nombre para render/auditoria
  leido_colab   boolean default false, leido_colab_ms bigint,  -- lo leyo el colaborador
  leido_admin   boolean default false, leido_admin_ms bigint,  -- lo leyo admin (aviso POS)
  created_ms    bigint,
  anulado       boolean default false, anulado_por text, anulado_ms bigint,
  created_at    timestamptz default now()
);
create index if not exists idx_staffmsg_hilo  on public.staff_mensajes (motel_id, staff_id, created_ms);
-- para el aviso global del POS: mensajes del colaborador sin leer por admin
create index if not exists idx_staffmsg_aviso on public.staff_mensajes (motel_id, leido_admin)
  where origen = 'COLAB' and anulado = false;

-- 2) PERMISOS: el colaborador NO marca remunerado (lo decide admin al aprobar).
create table if not exists public.staff_permisos (
  id            bigint generated always as identity primary key,
  motel_id      uuid    not null,
  staff_id      text    not null,
  tipo          text    not null
                        check (tipo in ('CITA_MEDICA','CALAMIDAD','DILIGENCIA','LICENCIA','OTRO')),
  fecha         date    not null,
  dia_completo  boolean not null default true,
  hora_desde    time, hora_hasta time,          -- solo si es por horas
  motivo        text,
  soporte_bucket text, soporte_path text, soporte_mime text,  -- foto opcional (bucket privado)
  estado        text    not null default 'PENDIENTE'
                        check (estado in ('PENDIENTE','APROBADO','RECHAZADO')),
  remunerado    boolean,                         -- null hasta que admin apruebe
  respuesta_comentario text,                     -- comentario del admin al resolver
  resuelto_por  text, resuelto_ms bigint,        -- auditoria de la decision
  created_ms    bigint,
  anulado       boolean default false, anulado_por text, anulado_ms bigint,
  created_at    timestamptz default now()
);
create index if not exists idx_staffperm_staff on public.staff_permisos (motel_id, staff_id, created_ms);
-- Pieza 5 (grilla) leera: estado='APROBADO' + fecha + dia_completo/horas para pintar los dias.
create index if not exists idx_staffperm_grilla on public.staff_permisos (motel_id, fecha)
  where estado = 'APROBADO' and anulado = false;

-- 3) COMUNICADO canonico (padre). Lado ADMIN: nace vacio y cerrado, sin endpoint
--    del colaborador. El fan-out (una fila en staff_mensajes por destinatario) se
--    construye al llegar a Personal admin. Se deja creado para contemplarlo dia uno.
create table if not exists public.staff_comunicados (
  id         bigint generated always as identity primary key,
  motel_id   uuid    not null,
  destino    text    not null
                     check (destino in ('TODOS','RECEPCION','CAMARERA','PATIERO','MANTENIMIENTO','SERVICIOS')),
  cuerpo     text    not null,
  autor      text,
  created_ms bigint,
  anulado    boolean default false, anulado_por text, anulado_ms bigint,
  created_at timestamptz default now()
);

-- ===== nacer CERRADAS (CLAUDE.md pto 7): solo service_role =====
revoke all on table public.staff_mensajes    from anon, authenticated, public;
revoke all on table public.staff_permisos     from anon, authenticated, public;
revoke all on table public.staff_comunicados  from anon, authenticated, public;
alter table public.staff_mensajes    enable row level security;
alter table public.staff_permisos    enable row level security;
alter table public.staff_comunicados enable row level security;
grant all on table public.staff_mensajes    to service_role;
grant all on table public.staff_permisos    to service_role;
grant all on table public.staff_comunicados to service_role;

-- 4) BUCKET privado para el soporte de permisos (patron Pieza 1: staff-docs/incapacidades)
insert into storage.buckets (id, name, public) values ('permisos','permisos',false)
on conflict (id) do nothing;

-- PENDIENTE (al construir Personal en el POS): agregar staff_mensajes, staff_permisos
-- y staff_comunicados a TENANT_TABLES + endpoints admin (bandeja, responder, aprobar
-- permiso remunerado/no, comunicado con fan-out, marcar leido_admin, aviso global POS).
-- rollback: ver 20260721_fase2_pieza6_chat_permisos_rollback.sql
