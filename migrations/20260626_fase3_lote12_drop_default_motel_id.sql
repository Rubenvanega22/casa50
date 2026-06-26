-- Fase 3 (aislamiento multi-tenant) · Lote 12 (HARDENING: DROP DEFAULT de motel_id)
-- ============================================================================
-- Quita el DEFAULT Casa 50 de motel_id en las 51 tablas tenant. La columna SIGUE
-- siendo NOT NULL: a partir de ahora un INSERT que NO setee motel_id FALLA ruidoso
-- (en vez de caer en silencio a Casa 50). Esto cierra Fase 3.
--
-- PRECONDICION (verificada en sesion 26-jun-2026, cruce de 3 conjuntos):
--   - TENANT_TABLES (codigo) == tablas con motel_id (BD): 51 = 51, identicos.
--   - Las 39 tablas usadas con tInsert estan todas en TENANT_TABLES -> el helper
--     inyecta motel_id en todo insert.
--   - Los 4 upsert directos a tablas tenant llevan motel_id explicito:
--     maintenance_bitacora, aire_mantenimiento, proyeccion_meses, shift_inventory_start.
--   - No hay tInsert/from con nombre de tabla dinamico.
--   => Todo camino de insert de la APP provee motel_id. DROP DEFAULT es seguro.
--
-- Casa 50 motel_id = 24992a8a-48d8-4444-a50f-2d6c7d949828
--
-- IMPORTANTE — ONBOARDING DE MOTEL NUEVO:
--   Estas 8 tablas NO tienen ningun INSERT desde la app (se siembran por fuera:
--   SQL/onboarding/migracion). Tras este DROP DEFAULT, el seed de un motel NUEVO
--   DEBE incluir motel_id explicito o el INSERT fallara:
--     motel_info, aire_unidades, config_caja, app_motel_admins,
--     app_fotos, cierre_mes, mantenimiento_zonas_comunes, ventas_diarias_manuales
--   (Las filas actuales de Casa 50 NO se tocan: ya tienen motel_id.)
--
-- Aplicar UN BATCH A LA VEZ, correr su verificacion, confirmar column_default = NULL
-- e is_nullable = NO, y recien ahi pasar al siguiente. Operacion metadata-only,
-- instantanea, reversible (ver rollback al final).
-- ============================================================================


-- ===================== BATCH 1 — finanzas / gastos / caja (9) =====================
ALTER TABLE taxi_expenses     ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE loans             ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE general_expenses  ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE gastos_mes        ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE retiros_dueno     ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE caja_paola        ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE config_caja       ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE descargos_nequi   ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE ajustes           ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 1: column_default debe ser NULL, is_nullable debe seguir NO
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('taxi_expenses','loans','general_expenses','gastos_mes','retiros_dueno',
   'caja_paola','config_caja','descargos_nequi','ajustes')
ORDER BY table_name;


-- ===================== BATCH 2 — ventas / bar (7) =====================
ALTER TABLE sales                   ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE bar_sales               ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE cortesias               ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE room_products           ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE payment_method_changes  ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE ventas_diarias_manuales ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE ventas_gastos_anuales   ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 2
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('sales','bar_sales','cortesias','room_products','payment_method_changes',
   'ventas_diarias_manuales','ventas_gastos_anuales')
ORDER BY table_name;


-- ===================== BATCH 3 — inventario (4) =====================
ALTER TABLE products          ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE stock_entries     ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE stock_movements   ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE product_shift_obs ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 3
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('products','stock_entries','stock_movements','product_shift_obs')
ORDER BY table_name;


-- ===================== BATCH 4 — turnos (6) =====================
ALTER TABLE shift_log             ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE shift_close           ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE shift_failures        ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE shift_inventory_start ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE shift_notes           ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE extra_staff           ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 4
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('shift_log','shift_close','shift_failures','shift_inventory_start',
   'shift_notes','extra_staff')
ORDER BY table_name;


-- ===================== BATCH 5 — habitaciones / estado / limpieza (4) =====================
ALTER TABLE rooms          ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE state_history  ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE maid_log       ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE room_issues    ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 5
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('rooms','state_history','maid_log','room_issues')
ORDER BY table_name;


-- ===================== BATCH 6 — mantenimiento + aire (8) =====================
ALTER TABLE maintenance                 ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE maintenance_bitacora        ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE mantenimiento_solicitudes   ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE mantenimiento_tareas        ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE mantenimiento_zonas_comunes ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE aire_unidades               ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE aire_mantenimiento          ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE aire_rondas                 ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 6
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('maintenance','maintenance_bitacora','mantenimiento_solicitudes',
   'mantenimiento_tareas','mantenimiento_zonas_comunes','aire_unidades',
   'aire_mantenimiento','aire_rondas')
ORDER BY table_name;


-- ===================== BATCH 7 — config / personal / proyeccion / misc (13) =====================
ALTER TABLE app_categorias            ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE app_fotos                 ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE app_motel_admins          ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE motel_info                ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE staff                     ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE staff_vacaciones_historial ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE schedule                  ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE schedule_extras           ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE proyeccion_meses          ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE proyeccion_tareas         ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE cierre_mes                ALTER COLUMN motel_id DROP DEFAULT;  -- seed onboarding: motel_id explicito
ALTER TABLE luciana_chats             ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE login_failures            ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion BATCH 7
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_name IN
  ('app_categorias','app_fotos','app_motel_admins','motel_info','staff',
   'staff_vacaciones_historial','schedule','schedule_extras','proyeccion_meses',
   'proyeccion_tareas','cierre_mes','luciana_chats','login_failures')
ORDER BY table_name;


-- ===================== VERIFICACION FINAL (las 51) =====================
-- Deben aparecer 51 filas, todas con column_default = NULL y is_nullable = NO.
SELECT count(*) AS tenant_sin_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_schema='public'
  AND is_nullable='NO' AND column_default IS NULL;
-- (esperado: 51)

-- Sanity: NINGUNA tabla tenant debe conservar default Casa 50.
SELECT table_name, column_default
FROM information_schema.columns
WHERE column_name='motel_id' AND table_schema='public' AND column_default IS NOT NULL
ORDER BY table_name;
-- (esperado: 0 filas)


-- ===================== ROLLBACK (si hiciera falta) =====================
-- Restaurar el default Casa 50 en todas (revierte el hardening):
-- ALTER TABLE <tabla> ALTER COLUMN motel_id SET DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
-- (repetir por cada una de las 51 tablas)
