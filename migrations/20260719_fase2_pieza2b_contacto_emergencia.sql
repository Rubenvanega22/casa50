-- FASE 2 · PIEZA 2b — contacto de emergencia separado (nombre + telefono)
-- Motivo: si un extra sufre un accidente en el motel hay que contactar a la
-- familia de inmediato; el registro es el unico momento en que llena datos.
-- staff ya nace cerrada (RLS on, policies 0 -> deny-all para anon/authenticated;
-- solo service_role escribe). Un ALTER ADD COLUMN no otorga privilegios nuevos.
-- Se conserva la columna legacy contacto_emergencia (NOT NULL): el backend la
-- rellena combinada ("nombre · telefono") para no romper lecturas viejas.

alter table public.staff add column if not exists contacto_emergencia_nombre   text;
alter table public.staff add column if not exists contacto_emergencia_telefono text;

-- rollback:
--   alter table public.staff drop column if exists contacto_emergencia_telefono;
--   alter table public.staff drop column if exists contacto_emergencia_nombre;

-- NOTA DE SEGURIDAD (regla de oro pto 5): al tocar staff se verifico que anon/
-- authenticated conservan los grants amplios por defecto, PERO RLS deny-all los
-- contiene (rls_on=true, policies=0). Es el agujero ya catalogado "grants abiertos
-- bajo RLS", pendiente el REVOKE masivo como bloque propio. No es nuevo.
