-- Fase 3 (aislamiento multi-tenant) · Lote 0 (PILOTO)
-- Agrega motel_id a 3 tablas chicas, NOT NULL con DEFAULT Casa 50.
-- El DEFAULT rellena el histórico existente (todo queda como Casa 50) y mantiene
-- la app funcionando sin tocar código (los INSERT actuales toman el default).
-- Aditivo e idempotente (IF NOT EXISTS). Reversible con DROP COLUMN.
--
-- Endurecimiento posterior (NO en esta migración): cuando el helper centralizado
-- setee motel_id=MOTEL_ID en todos los inserts, se hará ALTER COLUMN ... DROP DEFAULT
-- para que un insert sin motel_id falle fuerte en vez de mislabelar como Casa 50.
--
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828

ALTER TABLE taxi_expenses    ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE loans            ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
ALTER TABLE general_expenses ADD COLUMN IF NOT EXISTS motel_id uuid NOT NULL DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Verificación 1: columna NOT NULL con default Casa 50
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE column_name = 'motel_id' AND table_name IN ('taxi_expenses','loans','general_expenses')
ORDER BY table_name;

-- Verificación 2: todo el histórico en Casa 50, sin NULLs (una sola fila por tabla)
SELECT 'taxi_expenses' AS tabla, motel_id, COUNT(*) AS filas FROM taxi_expenses GROUP BY motel_id
UNION ALL SELECT 'loans', motel_id, COUNT(*) FROM loans GROUP BY motel_id
UNION ALL SELECT 'general_expenses', motel_id, COUNT(*) FROM general_expenses GROUP BY motel_id
ORDER BY tabla;

-- Rollback (si hace falta):
-- ALTER TABLE taxi_expenses    DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE loans            DROP COLUMN IF EXISTS motel_id;
-- ALTER TABLE general_expenses DROP COLUMN IF EXISTS motel_id;
