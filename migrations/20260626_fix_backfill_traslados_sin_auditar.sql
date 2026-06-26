-- FIX puntual · Backfill de auditoría de traslados perdidos en la ventana del hardening
-- ============================================================================
-- CONTEXTO: durante la ventana en que el Lote 12 (DROP DEFAULT) estuvo activo,
-- producción (main, sin helper) hizo traslados bodega->recepcion. El flujo
-- apiTrasladoRecepcion corre 3 pasos SUELTOS (no transaccionales):
--   1) apply_stock_bodega_delta(-cant)   -> baja bodega   (RPC, inmune al hardening)
--   2) apply_stock_actual_delta(+cant)   -> sube recepcion (RPC, inmune al hardening)
--   3) INSERT stock_movements            -> AUDITORIA       (fallo: null motel_id)
-- Resultado: las COLUMNAS de stock quedaron CORRECTAS (recepcion recibio, bodega
-- bajo), pero NO quedo la fila de auditoria 'traslado_recepcion'.
--
-- Reconciliacion (snapshot SHIFT_1 2026-06-26 + movimientos auditados vs stock_actual)
-- detecto 14 productos con recepcion no explicada por la auditoria = 74 unidades.
-- Ventana: business_day 2026-06-26, unico turno abierto hoy = SHIFT_1.
--
-- ESTE SCRIPT SOLO INSERTA LAS 14 FILAS DE AUDITORIA FALTANTES.
-- NO toca stock_actual ni stock_bodega (ya estan correctos; no hay triggers que
-- los modifiquen al insertar en stock_movements -> verificado: 0 triggers).
-- Cantidades = discrepancia reconciliada, confirmadas con conteo fisico del dueno.
-- ============================================================================

INSERT INTO stock_movements
  (ts_ms, business_day, shift_id, user_name, user_role, product_id, product_name, tipo, cantidad, nota, motel_id)
SELECT
  (extract(epoch from now())*1000)::bigint + v.ord,   -- ts dentro de SHIFT_1 de hoy (momento de la reconstruccion)
  '2026-06-26',
  'SHIFT_1',
  'reconstruccion',
  'ADMIN',
  v.product_id,
  v.product_name,
  'traslado_recepcion',
  v.cantidad,
  'reconstruccion - traslado sin auditar, ventana hardening',
  '24992a8a-48d8-4444-a50f-2d6c7d949828'
FROM (VALUES
  ( 0,  9, 'AGUILA LIGHT',           24),
  ( 1, 21, 'H2O LIMONATA',           10),
  ( 2, 69, 'TOALLA HIGIENICA',        7),
  ( 3, 22, 'H2O MARACUYA',            6),
  ( 4,  3, 'C. AGUARDIENTE',          5),
  ( 5, 70, 'PROTECTORES',             5),
  ( 6, 66, 'SILDENAFIL',              4),
  ( 7, 78, 'DILATADOR ANAL',          3),
  ( 8,  5, 'RON ESENCIAL',            3),
  ( 9, 49, 'PAPAS MARGARITA LIMON',   2),
  (10, 47, 'DETODITO LIMON',          2),
  (11, 48, 'DETODITO MIX',            1),
  (12, 46, 'DETODITO BBQ',            1),
  (13, 45, 'DETODITO NATURAL',        1)
) AS v(ord, product_id, product_name, cantidad);

-- ADDENDUM: straggler hallado en la re-reconciliacion post-backfill (mismo patron,
-- no aparecio en el primer barrido por carrera de timing). Confirmado con conteo
-- fisico (recepcion 2 / bodega 0). Total final: 15 filas / 75 unidades.
INSERT INTO stock_movements
  (ts_ms, business_day, shift_id, user_name, user_role, product_id, product_name, tipo, cantidad, nota, motel_id)
VALUES
  ((extract(epoch from now())*1000)::bigint, '2026-06-26', 'SHIFT_1',
   'reconstruccion', 'ADMIN', 53, 'LUCKY AZUL', 'traslado_recepcion', 1,
   'reconstruccion - traslado sin auditar, ventana hardening',
   '24992a8a-48d8-4444-a50f-2d6c7d949828');

-- ============================================================================
-- VERIFICACION 1: filas de reconstruccion (esperado: 15, suma 75)
SELECT count(*) AS filas, COALESCE(sum(cantidad),0) AS unidades
FROM stock_movements
WHERE business_day='2026-06-26' AND tipo='traslado_recepcion' AND user_name='reconstruccion';

-- VERIFICACION 2: re-reconciliacion -> ya NO debe quedar ninguna discrepancia (0 filas)
WITH snap AS (
  SELECT DISTINCT ON (product_id) product_id, saldo_inicial
  FROM shift_inventory_start
  WHERE business_day='2026-06-26'
  ORDER BY product_id, shift_id
),
mov AS (
  SELECT product_id, SUM(cantidad) AS delta_recepcion
  FROM stock_movements
  WHERE business_day='2026-06-26'
    AND tipo NOT IN ('ingreso_bodega','bodega_conteo','ajuste_manual_bodega')
  GROUP BY product_id
)
SELECT p.id, p.nombre,
       p.stock_actual - (s.saldo_inicial + COALESCE(m.delta_recepcion,0)) AS discrepancia
FROM products p
JOIN snap s ON s.product_id = p.id
LEFT JOIN mov m ON m.product_id = p.id
WHERE p.stock_actual - (s.saldo_inicial + COALESCE(m.delta_recepcion,0)) <> 0
ORDER BY discrepancia DESC;
-- (esperado: 0 filas)

-- ROLLBACK (si hiciera falta): borrar exactamente las filas reconstruidas
-- DELETE FROM stock_movements
-- WHERE business_day='2026-06-26' AND tipo='traslado_recepcion' AND user_name='reconstruccion';
