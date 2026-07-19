-- Boton "Nueva conversacion": conversacion_id en luciana_chats.
-- ADITIVA y nullable: clientes viejos sin convId siguen andando (el backend cae
-- al filtro por business_day). luciana_chats ya tiene RLS + motel_id
-- (TENANT_TABLES), asi que esta columna no cambia la superficie de seguridad.
-- Reversible.
ALTER TABLE public.luciana_chats ADD COLUMN IF NOT EXISTS conversacion_id text;
CREATE INDEX IF NOT EXISTS idx_luciana_conv
  ON public.luciana_chats (motel_id, conversacion_id, ts_ms);

-- rollback:
--   DROP INDEX IF EXISTS idx_luciana_conv;
--   ALTER TABLE public.luciana_chats DROP COLUMN IF EXISTS conversacion_id;
