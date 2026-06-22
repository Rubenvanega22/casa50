-- Migración: app_categorias — sembrar extraHour/extraPerson/included
-- Motel: Casa 50 (motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828)
-- Valores idénticos a MASTER_PRICING (no-op de comportamiento).
-- Merge con || : agrega las 3 keys, conserva 3h/6h/8h/12h. Idempotente.

UPDATE app_categorias
SET precios = precios || '{"extraHour":20000,"extraPerson":20000,"included":2}'::jsonb
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828' AND nombre_db = 'Junior';

UPDATE app_categorias
SET precios = precios || '{"extraHour":25000,"extraPerson":25000,"included":2}'::jsonb
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828' AND nombre_db = 'Suite Jacuzzi';

UPDATE app_categorias
SET precios = precios || '{"extraHour":30000,"extraPerson":30000,"included":2}'::jsonb
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828' AND nombre_db = 'Presidencial';

UPDATE app_categorias
SET precios = precios || '{"extraHour":35000,"extraPerson":30000,"included":4}'::jsonb
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828' AND nombre_db = 'Suite Multiple';

UPDATE app_categorias
SET precios = precios || '{"extraHour":35000,"extraPerson":30000,"included":4}'::jsonb
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828' AND nombre_db = 'Suite Disco';

-- Verificación: cada fila debe tener los 7 keys
SELECT nombre_db, orden, precios
FROM app_categorias
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828'
ORDER BY orden;
