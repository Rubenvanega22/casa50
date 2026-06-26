-- Fase 3 (aislamiento multi-tenant) · Lote 1
-- Agrega motel_id a 4 tablas operativas chicas, NOT NULL con DEFAULT Casa 50.
-- Mismo patrón que el Lote 0: aditivo, idempotente, backfill via default, no-op
-- operativo (nadie lee motel_id aún). Reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE cortesias              ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE extra_staff            ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE room_issues            ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE payment_method_changes ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('cortesias','extra_staff','room_issues','payment_method_changes')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla con datos)
SELECT 'cortesias' AS tabla, motel_id, COUNT(*) AS filas FROM cortesias GROUP BY motel_id
UNION ALL SELECT 'extra_staff', motel_id, COUNT(*) FROM extra_staff GROUP BY motel_id
UNION ALL SELECT 'room_issues', motel_id, COUNT(*) FROM room_issues GROUP BY motel_id
UNION ALL SELECT 'payment_method_changes', motel_id, COUNT(*) FROM payment_method_changes GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE cortesias              DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE extra_staff            DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE room_issues            DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE payment_method_changes DROP COLUMN IF EXISTS motel_id;
