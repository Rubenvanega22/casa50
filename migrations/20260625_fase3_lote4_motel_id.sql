-- Fase 3 (aislamiento multi-tenant) · Lote 4 (transaccionales grandes)
-- Agrega motel_id a room_products (~5.3k) y sales (~8.1k), NOT NULL DEFAULT Casa 50.
-- ADD COLUMN con DEFAULT constante en Postgres es metadata-only (rapido) aun en
-- tablas grandes. Mismo patrón: aditivo, idempotente, backfill via default, no-op
-- operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE room_products ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE sales         ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('room_products','sales')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla)
SELECT 'room_products' AS tabla, motel_id, COUNT(*) AS filas FROM room_products GROUP BY motel_id
UNION ALL SELECT 'sales', motel_id, COUNT(*) FROM sales GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE room_products DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE sales         DROP COLUMN IF EXISTS motel_id;
