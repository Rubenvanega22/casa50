-- Fase 3 (aislamiento multi-tenant) · Lote 8 (aire acondicionado)
-- motel_id NOT NULL DEFAULT Casa 50. Mismo patrón: aditivo, idempotente, backfill
-- via default, no-op operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE aire_unidades      ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE aire_mantenimiento ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE aire_rondas        ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('aire_unidades','aire_mantenimiento','aire_rondas')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla con datos)
SELECT 'aire_unidades' AS tabla, motel_id, COUNT(*) AS filas FROM aire_unidades GROUP BY motel_id
UNION ALL SELECT 'aire_mantenimiento', motel_id, COUNT(*) FROM aire_mantenimiento GROUP BY motel_id
UNION ALL SELECT 'aire_rondas', motel_id, COUNT(*) FROM aire_rondas GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE aire_unidades      DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE aire_mantenimiento DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE aire_rondas        DROP COLUMN IF EXISTS motel_id;
