-- ROLLBACK · FASE 2 · PIEZA 1 — Cimientos
-- (los buckets con archivos NO se dropean a ciegas; borrar manual si vacios)

drop table if exists public.tarifas_extra;
drop table if exists public.festivos;
drop table if exists public.motel_config;

alter table public.schedule    drop column if exists staff_id;
alter table public.extra_staff drop column if exists staff_id;

alter table public.staff drop constraint if exists staff_rol_chk;
alter table public.staff
  drop column if exists correo,
  drop column if exists eps,
  drop column if exists arl,
  drop column if exists pension,
  drop column if exists caja,
  drop column if exists foto_url,
  drop column if exists rol,
  drop column if exists pin_hash,
  drop column if exists pin_reset_ms,
  drop column if exists pin_reset_por,
  drop column if exists estado_registro;

-- Buckets (solo si vacios):
--   delete from storage.buckets where id in ('staff-docs','incapacidades');
