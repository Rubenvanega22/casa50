-- Fase 4 (onboarding) · Parte 3 (des-hardcodear cortesia "304") · Paso 1 + 1b
-- Reemplaza el hardcode del room_id '304' por un flag por-habitacion, multi-tenant.
--
-- Paso 1 (aditivo): columna is_cortesia en rooms. DEFAULT false (habitacion nueva
-- = no cortesia), se queda para siempre (no requiere DROP DEFAULT como la Parte 2).
-- No-op operativo: el codigo vivo sigue hardcodeando '304' e ignora la columna
-- hasta que se deployen los pasos de codigo (2-4). Reversible con DROP COLUMN.
--
-- Paso 1b: marcar la 304 de Casa 50 ANTES del deploy del codigo nuevo, para que
-- cuando el codigo pase a leer el flag, Casa 50 conserve su cortesia sin ventana
-- de "sin cortesia" (misma leccion de orden del Lote 12).
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_cortesia boolean NOT NULL DEFAULT false;

UPDATE rooms SET is_cortesia=true
WHERE room_id='304' AND motel_id='24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificacion: columna existe + exactamente la 304 de Casa 50 marcada (global=1)
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='rooms' AND column_name='is_cortesia') AS columna_existe,
  (SELECT count(*) FROM rooms WHERE is_cortesia=true) AS total_cortesia_global,
  (SELECT string_agg(room_id,',') FROM rooms WHERE is_cortesia=true) AS rooms_cortesia;

-- Rollback (si hace falta):
-- ALTER TABLE rooms DROP COLUMN IF EXISTS is_cortesia;
