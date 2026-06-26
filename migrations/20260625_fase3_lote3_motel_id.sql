-- Fase 3 (aislamiento multi-tenant) · Lote 3 (turnos)
-- Agrega motel_id a las tablas de turnos, NOT NULL con DEFAULT Casa 50.
-- Mismo patrón: aditivo, idempotente, backfill via default, no-op operativo,
-- reversible con DROP COLUMN. (shift_inventory_start tiene RLS activa sin politicas;
-- el ALTER es DDL y no se ve afectado; service_role opera igual.)
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE shift_log             ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE shift_close           ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE shift_inventory_start ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE shift_failures        ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('shift_log','shift_close','shift_inventory_start','shift_failures')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla con datos)
SELECT 'shift_log' AS tabla, motel_id, COUNT(*) AS filas FROM shift_log GROUP BY motel_id
UNION ALL SELECT 'shift_close', motel_id, COUNT(*) FROM shift_close GROUP BY motel_id
UNION ALL SELECT 'shift_inventory_start', motel_id, COUNT(*) FROM shift_inventory_start GROUP BY motel_id
UNION ALL SELECT 'shift_failures', motel_id, COUNT(*) FROM shift_failures GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE shift_log             DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE shift_close           DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE shift_inventory_start DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE shift_failures        DROP COLUMN IF EXISTS motel_id;
