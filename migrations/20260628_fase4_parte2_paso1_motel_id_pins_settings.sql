-- Fase 4 (onboarding moteles) · Parte 2 (PINs + settings por motel) · Paso 1 (ADITIVO)
-- Agrega motel_id a las 4 tablas globales (NO tenant) que el login/settings usan
-- sin filtro de motel hoy: admin_pins, reception_pins, maintenance_pins, settings.
--
-- Patron: motel_id NOT NULL DEFAULT Casa 50. Aditivo, idempotente, backfill via
-- default, no-op operativo (el codigo vivo ignora la columna extra), reversible.
-- NO toca PK ni UNIQUE todavia (eso es Paso 2: uniques compuestos aditivos, y
-- Paso 4: drop de los uniques/PK viejos DESPUES de mergear+deployar el codigo).
--
-- IMPORTANTE: el DEFAULT se MANTIENE a proposito. main (produccion) todavia
-- inserta en estas tablas sin motel_id; el default lo protege hasta que el Paso 3
-- (codigo que inyecta motel_id via helper) este deployado. Misma leccion del
-- Lote 12 de Fase 3: el DROP DEFAULT solo es seguro post-deploy.
--
-- Estado previo verificado (Paso 0): ninguna tenia motel_id; 0 PINs duplicados
-- (admin/mantenimiento); 0 user_name duplicados (reception); 0 FKs referenciando
-- estas tablas. Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE admin_pins       ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE reception_pins   ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE maintenance_pins ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE settings         ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificacion 1: columna NOT NULL con default Casa 50 (4 filas)
SELECT table_name, column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND column_name='motel_id'
  AND table_name IN ('admin_pins','reception_pins','maintenance_pins','settings')
ORDER BY table_name;

-- Verificacion 2: backfill -> todo en Casa 50, 0 NULLs (una fila por tabla)
SELECT 'admin_pins' t, motel_id, count(*) n FROM admin_pins GROUP BY motel_id
UNION ALL SELECT 'reception_pins', motel_id, count(*) FROM reception_pins GROUP BY motel_id
UNION ALL SELECT 'maintenance_pins', motel_id, count(*) FROM maintenance_pins GROUP BY motel_id
UNION ALL SELECT 'settings', motel_id, count(*) FROM settings GROUP BY motel_id
ORDER BY t;

-- Rollback (si hace falta):
-- ALTER TABLE admin_pins       DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE reception_pins   DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE maintenance_pins DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE settings         DROP COLUMN IF EXISTS motel_id;
