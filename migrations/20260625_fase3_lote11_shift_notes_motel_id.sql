-- Fase 3 (aislamiento multi-tenant) · Lote 11 (cierre de hueco: shift_notes)
-- shift_notes se habia salteado en los lotes 0-9 (igual que rooms en el lote 10).
-- Es tabla tenant: notas de turno por-motel (business_day, shift_id, autor,
-- fotos, respuestas, seen_by). 110 filas reales al momento de esta migracion.
-- motel_id NOT NULL DEFAULT Casa 50. Mismo patron: aditivo, idempotente, backfill
-- via default, no-op operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE shift_notes ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'shift_notes' AND column_name = 'motel_id';

-- Verificación 2: todas las notas en Casa 50, sin NULLs (una sola fila, 110 filas)
SELECT motel_id, COUNT(*) AS notas FROM shift_notes GROUP BY motel_id;

-- Rollback (si hace falta):
-- ALTER TABLE shift_notes DROP COLUMN IF EXISTS motel_id;
