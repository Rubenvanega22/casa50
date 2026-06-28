-- Fase 4 (onboarding moteles) · Parte 2 (PINs + settings por motel) · Paso 2 (ADITIVO)
-- Crea los uniques compuestos por motel para las 4 tablas globales, SIN dropear
-- los PK/uniques viejos (conviven durante la transicion). Asi el codigo viejo
-- (onConflict 'key'/'user_name') y el nuevo (onConflict compuesto) funcionan
-- ambos hasta que el Paso 4 dropee los viejos (post merge+deploy del Paso 3).
--
-- Se usan CREATE UNIQUE INDEX IF NOT EXISTS (no ADD CONSTRAINT) porque:
--  - es idempotente (Postgres no soporta ADD CONSTRAINT IF NOT EXISTS), y
--  - ON CONFLICT (cols) de supabase-js infiere contra un indice unico (no
--    necesita constraint con nombre).
--
-- Seguro: 0 duplicados verificados en Paso 0 (admin/maint pin, reception user).
-- maintenance_pins.id (PK serial) NO se toca. Reversible con DROP INDEX.

CREATE UNIQUE INDEX IF NOT EXISTS settings_motel_key_uidx
  ON settings (motel_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS reception_pins_motel_user_uidx
  ON reception_pins (motel_id, user_name);
CREATE UNIQUE INDEX IF NOT EXISTS admin_pins_motel_user_uidx
  ON admin_pins (motel_id, user_name);
CREATE UNIQUE INDEX IF NOT EXISTS admin_pins_motel_pin_uidx
  ON admin_pins (motel_id, pin);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_pins_motel_user_uidx
  ON maintenance_pins (motel_id, user_name);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_pins_motel_pin_uidx
  ON maintenance_pins (motel_id, pin);

-- Verificacion: los 6 indices unicos nuevos existen
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname='public'
  AND indexname IN ('settings_motel_key_uidx','reception_pins_motel_user_uidx',
    'admin_pins_motel_user_uidx','admin_pins_motel_pin_uidx',
    'maintenance_pins_motel_user_uidx','maintenance_pins_motel_pin_uidx')
ORDER BY tablename, indexname;

-- Rollback (si hace falta):
-- DROP INDEX IF EXISTS settings_motel_key_uidx;
-- DROP INDEX IF EXISTS reception_pins_motel_user_uidx;
-- DROP INDEX IF EXISTS admin_pins_motel_user_uidx;
-- DROP INDEX IF EXISTS admin_pins_motel_pin_uidx;
-- DROP INDEX IF EXISTS maintenance_pins_motel_user_uidx;
-- DROP INDEX IF EXISTS maintenance_pins_motel_pin_uidx;
