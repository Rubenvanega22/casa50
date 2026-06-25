-- Fase 3 (aislamiento multi-tenant) · Lote 7 (mantenimiento)
-- motel_id NOT NULL DEFAULT Casa 50. Mismo patrón: aditivo, idempotente, backfill
-- via default, no-op operativo, reversible con DROP COLUMN.
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE maintenance                  ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE maintenance_bitacora         ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE mantenimiento_solicitudes    ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE mantenimiento_tareas         ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE mantenimiento_zonas_comunes  ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('maintenance','maintenance_bitacora','mantenimiento_solicitudes','mantenimiento_tareas','mantenimiento_zonas_comunes')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla con datos)
SELECT 'maintenance' AS tabla, motel_id, COUNT(*) AS filas FROM maintenance GROUP BY motel_id
UNION ALL SELECT 'maintenance_bitacora', motel_id, COUNT(*) FROM maintenance_bitacora GROUP BY motel_id
UNION ALL SELECT 'mantenimiento_solicitudes', motel_id, COUNT(*) FROM mantenimiento_solicitudes GROUP BY motel_id
UNION ALL SELECT 'mantenimiento_tareas', motel_id, COUNT(*) FROM mantenimiento_tareas GROUP BY motel_id
UNION ALL SELECT 'mantenimiento_zonas_comunes', motel_id, COUNT(*) FROM mantenimiento_zonas_comunes GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE maintenance                 DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE maintenance_bitacora        DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE mantenimiento_solicitudes   DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE mantenimiento_tareas        DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE mantenimiento_zonas_comunes DROP COLUMN IF EXISTS motel_id;
