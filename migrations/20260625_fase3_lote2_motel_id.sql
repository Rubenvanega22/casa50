-- Fase 3 (aislamiento multi-tenant) · Lote 2 (inventario)
-- Agrega motel_id a las tablas de inventario, NOT NULL con DEFAULT Casa 50.
-- Mismo patrón: aditivo, idempotente, backfill via default, no-op operativo,
-- reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE products          ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE stock_entries     ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE stock_movements   ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE product_shift_obs ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('products','stock_entries','stock_movements','product_shift_obs')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla con datos)
SELECT 'products' AS tabla, motel_id, COUNT(*) AS filas FROM products GROUP BY motel_id
UNION ALL SELECT 'stock_entries', motel_id, COUNT(*) FROM stock_entries GROUP BY motel_id
UNION ALL SELECT 'stock_movements', motel_id, COUNT(*) FROM stock_movements GROUP BY motel_id
UNION ALL SELECT 'product_shift_obs', motel_id, COUNT(*) FROM product_shift_obs GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE products          DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE stock_entries     DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE stock_movements   DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE product_shift_obs DROP COLUMN IF EXISTS motel_id;
