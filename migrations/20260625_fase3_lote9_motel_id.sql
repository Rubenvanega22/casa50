-- Fase 3 (aislamiento multi-tenant) · Lote 9 (resto / final de la migracion de columnas)
-- motel_id NOT NULL DEFAULT Casa 50. Mismo patrón: aditivo, idempotente, backfill
-- via default, no-op operativo, reversible con DROP COLUMN. (Varias tienen RLS
-- activa; el ALTER es DDL y no se ve afectado.)
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828
--
-- FUERA de esta migracion (sub-fase aparte, por decision): admin_pins,
-- reception_pins, maintenance_pins, settings.

ALTER TABLE caja_paola               ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE config_caja              ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE descargos_nequi          ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE ajustes                  ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE retiros_dueno            ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE cierre_mes               ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE ventas_diarias_manuales  ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE ventas_gastos_anuales    ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE bar_sales                ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE gastos_mes               ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE staff                    ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE staff_vacaciones_historial ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE luciana_chats            ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE login_failures           ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50 (deben ser 14 filas)
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN
  ('caja_paola','config_caja','descargos_nequi','ajustes','retiros_dueno','cierre_mes',
   'ventas_diarias_manuales','ventas_gastos_anuales','bar_sales','gastos_mes','staff',
   'staff_vacaciones_historial','luciana_chats','login_failures')
ORDER BY table_name;

-- Verificación 2: histórico en Casa 50, sin NULLs (una fila por tabla con datos)
SELECT 'caja_paola' AS tabla, motel_id, COUNT(*) AS filas FROM caja_paola GROUP BY motel_id
UNION ALL SELECT 'config_caja', motel_id, COUNT(*) FROM config_caja GROUP BY motel_id
UNION ALL SELECT 'descargos_nequi', motel_id, COUNT(*) FROM descargos_nequi GROUP BY motel_id
UNION ALL SELECT 'ajustes', motel_id, COUNT(*) FROM ajustes GROUP BY motel_id
UNION ALL SELECT 'retiros_dueno', motel_id, COUNT(*) FROM retiros_dueno GROUP BY motel_id
UNION ALL SELECT 'cierre_mes', motel_id, COUNT(*) FROM cierre_mes GROUP BY motel_id
UNION ALL SELECT 'ventas_diarias_manuales', motel_id, COUNT(*) FROM ventas_diarias_manuales GROUP BY motel_id
UNION ALL SELECT 'ventas_gastos_anuales', motel_id, COUNT(*) FROM ventas_gastos_anuales GROUP BY motel_id
UNION ALL SELECT 'bar_sales', motel_id, COUNT(*) FROM bar_sales GROUP BY motel_id
UNION ALL SELECT 'gastos_mes', motel_id, COUNT(*) FROM gastos_mes GROUP BY motel_id
UNION ALL SELECT 'staff', motel_id, COUNT(*) FROM staff GROUP BY motel_id
UNION ALL SELECT 'staff_vacaciones_historial', motel_id, COUNT(*) FROM staff_vacaciones_historial GROUP BY motel_id
UNION ALL SELECT 'luciana_chats', motel_id, COUNT(*) FROM luciana_chats GROUP BY motel_id
UNION ALL SELECT 'login_failures', motel_id, COUNT(*) FROM login_failures GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta): DROP COLUMN IF EXISTS motel_id en cada una de las 14 tablas.
