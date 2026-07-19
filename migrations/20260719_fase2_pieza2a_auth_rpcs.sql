-- FASE 2 · PIEZA 2a — Auth backend del colaborador (RPCs)
-- pin_version para revocacion de carnet; RPCs SECURITY DEFINER con pgcrypto.
-- search_path = public, extensions (pgcrypto vive en extensions en Supabase).
-- Nacen cerradas: revoke a anon/authenticated (solo service_role ejecuta).

alter table public.staff add column if not exists pin_version int default 1;

create or replace function public.set_staff_pin(p_staff_id text, p_pin text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN debe ser 4 digitos'; end if;
  update public.staff
     set pin_hash = crypt(p_pin, gen_salt('bf')), pin_version = coalesce(pin_version,1)+1
   where id = p_staff_id;
  return found;
end $$;

-- Verifica cedula+PIN; devuelve el staff SOLO si coincide y esta habilitado.
-- Null en cualquier fallo (SECO). El conteo de intentos/lockout lo hace el endpoint.
create or replace function public.verify_staff_pin(p_cedula text, p_pin text)
returns table(id text, name text, rol text, tipo text, estado text, pin_version int)
language plpgsql security definer set search_path = public, extensions as $$
begin
  return query
  select s.id, s.name, s.rol, s.type, s.estado_registro, s.pin_version
  from public.staff s
  where s.cedula = p_cedula and s.active = true
    and s.pin_hash is not null and s.pin_hash = crypt(p_pin, s.pin_hash);
end $$;

revoke all on function public.set_staff_pin(text,text)    from anon, authenticated;
revoke all on function public.verify_staff_pin(text,text) from anon, authenticated;

-- rollback:
--   drop function if exists public.verify_staff_pin(text,text);
--   drop function if exists public.set_staff_pin(text,text);
--   alter table public.staff drop column if exists pin_version;
