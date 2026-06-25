-- Fase 3 (aislamiento multi-tenant) · Lote 6 (grilla de turnos / proyeccion)
-- motel_id NOT NULL DEFAULT Casa 50. Mismo patrón: aditivo, idempotente, backfill
-- via default, no-op operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE schedule          ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE schedule_extras   ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE proyeccion_meses  ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE proyeccion_tareas ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('schedule','schedule_extras','proyeccion_meses','proyeccion_tareas')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla con datos)
SELECT 'schedule' AS tabla, motel_id, COUNT(*) AS filas FROM schedule GROUP BY motel_id
UNION ALL SELECT 'schedule_extras', motel_id, COUNT(*) FROM schedule_extras GROUP BY motel_id
UNION ALL SELECT 'proyeccion_meses', motel_id, COUNT(*) FROM proyeccion_meses GROUP BY motel_id
UNION ALL SELECT 'proyeccion_tareas', motel_id, COUNT(*) FROM proyeccion_tareas GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE schedule          DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE schedule_extras   DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE proyeccion_meses  DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE proyeccion_tareas DROP COLUMN IF EXISTS motel_id;
