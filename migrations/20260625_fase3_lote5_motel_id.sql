-- Fase 3 (aislamiento multi-tenant) · Lote 5 (las mas grandes)
-- Agrega motel_id a state_history (~18.5k) y maid_log (~6.3k), NOT NULL DEFAULT Casa 50.
-- ADD COLUMN con DEFAULT constante = metadata-only (rapido) aun en las tablas
-- mas grandes. Mismo patrón: aditivo, idempotente, backfill via default, no-op
-- operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE state_history ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE maid_log      ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('state_history','maid_log')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla)
SELECT 'state_history' AS tabla, motel_id, COUNT(*) AS filas FROM state_history GROUP BY motel_id
UNION ALL SELECT 'maid_log', motel_id, COUNT(*) FROM maid_log GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE state_history DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE maid_log      DROP COLUMN IF EXISTS motel_id;
