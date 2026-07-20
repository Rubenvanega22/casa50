-- FASE 2 · PIEZA 2c — admin de colaboradores (POS): aprobar/rechazar extras + reset de PIN
-- Aplicada a la BD en 2 migraciones (Supabase): _rechazo_y_verify_active_v2 y _cerrar_rpcs_public.

-- 1) Auditoría de rechazo (staff ya nace cerrada; ADD COLUMN no otorga grants nuevos).
alter table public.staff add column if not exists rechazado_por text;
alter table public.staff add column if not exists rechazado_ms  bigint;

-- 2) verify_staff_pin: verifica el PIN SIN filtrar active y devuelve active + estado,
--    para que el login distinga PENDIENTE/RECHAZADO/desactivado del PIN incorrecto.
--    (Antes filtraba active=true -> el 403 de PENDIENTE era inalcanzable.)
drop function if exists public.verify_staff_pin(text, text);
create function public.verify_staff_pin(p_cedula text, p_pin text)
returns table(id text, name text, rol text, tipo text, estado text, active boolean, pin_version int)
language plpgsql security definer set search_path = public, extensions as $$
begin
  return query
  select s.id, s.name, s.rol, s.type, s.estado_registro, s.active, s.pin_version
  from public.staff s
  where s.cedula = p_cedula
    and s.pin_hash is not null and s.pin_hash = crypt(p_pin, s.pin_hash);
end $$;

-- 3) CIERRE DE SEGURIDAD (regla de oro): REVOKE ... FROM anon/authenticated NO quita el
--    grant implícito a PUBLIC. anon/authenticated podían ejecutar verify_staff_pin por
--    PostgREST (brute-force del PIN sin lockout). Se revoca a PUBLIC y se concede EXECUTE
--    solo a service_role. Aplica también a set_staff_pin (arrastrado de 2a).
revoke all on function public.verify_staff_pin(text, text) from public, anon, authenticated;
revoke all on function public.set_staff_pin(text, text)    from public, anon, authenticated;
grant execute on function public.verify_staff_pin(text, text) to service_role;
grant execute on function public.set_staff_pin(text, text)    to service_role;

-- rollback (parcial): re-crear verify_staff_pin con el filtro active y quitar columnas.
--   drop function if exists public.verify_staff_pin(text,text);
--   -- (re-crear versión previa con "and s.active = true", sin columna active)
--   alter table public.staff drop column if exists rechazado_ms;
--   alter table public.staff drop column if exists rechazado_por;
