-- Fase 3 (aislamiento multi-tenant) · Lote 10 (cierre de hueco: rooms)
-- rooms se habia salteado en los lotes 0-9. Es tabla tenant central.
-- motel_id NOT NULL DEFAULT Casa 50. Mismo patrón: aditivo, idempotente, backfill
-- via default, no-op operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'rooms' AND column_name = 'motel_id';

-- Verificación 2: todas las habitaciones en Casa 50, sin NULLs (una sola fila)
SELECT motel_id, COUNT(*) AS habitaciones FROM rooms GROUP BY motel_id;

-- Rollback (si hace falta):
-- ALTER TABLE rooms DROP COLUMN IF EXISTS motel_id;
