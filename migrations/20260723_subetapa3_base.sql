-- Sub-etapa 3 — BASE compartida (Piezas 1/2/3/4).
-- Regla de Oro: la baja de una persona es SOFT + auditada; nada se borra.
-- `staff` YA tiene RLS + grants cerrados (escritura solo por service key), así que estas
-- columnas nuevas NO necesitan grants al cliente: el navegador nunca escribe `staff`.

-- 1) Campos de SALIDA en staff (liquidación de nómina + eliminación de extra).
--    salida_ms == null  -> persona activa (en la lista).
--    salida_ms  != null -> fuera de activos -> aparece en 📦 Personal liquidado.
alter table public.staff
  add column if not exists salida_tipo     text,   -- RENUNCIA / DESPIDO / FIN_CONTRATO / ELIMINADO_EXTRA
  add column if not exists salida_fecha     date,   -- fecha de salida (solo nómina)
  add column if not exists salida_obs       text,   -- motivo / observaciones
  add column if not exists salida_por       text,   -- quién la dio de baja (admin firmado)
  add column if not exists salida_ms        bigint, -- cuándo
  add column if not exists reintegrado_por  text,   -- por si se revierte (reintegro)
  add column if not exists reintegrado_ms   bigint;

-- 2) Comunicados: permitir destino EXTRAS (la pestaña ⚡ Extras tiene su propio comunicado).
alter table public.staff_comunicados drop constraint if exists staff_comunicados_destino_check;
alter table public.staff_comunicados add constraint staff_comunicados_destino_check
  check (destino in ('TODOS','RECEPCION','CAMARERA','PATIERO','MANTENIMIENTO','SERVICIOS','EXTRAS'));

-- rollback:
--   alter table public.staff drop column if exists salida_tipo, drop column if exists salida_fecha,
--     drop column if exists salida_obs, drop column if exists salida_por, drop column if exists salida_ms,
--     drop column if exists reintegrado_por, drop column if exists reintegrado_ms;
--   alter table public.staff_comunicados drop constraint if exists staff_comunicados_destino_check;
--   alter table public.staff_comunicados add constraint staff_comunicados_destino_check
--     check (destino in ('TODOS','RECEPCION','CAMARERA','PATIERO','MANTENIMIENTO','SERVICIOS'));
