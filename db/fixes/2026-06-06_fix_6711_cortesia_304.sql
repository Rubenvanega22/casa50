-- =====================================================================
-- Fix histórico: venta 6711 — cortesía habitación 304 (cambio 206 -> 304)
-- Fecha: 2026-06-06
-- =====================================================================
-- Contexto:
--   El 2026-06-05 (turno 3) una pareja hizo check-in en la hab 206
--   pagando $60.000 EFECTIVO y luego fue cambiada a la 304 (cortesía).
--   La recepcionista (fernanda y) devolvió físicamente los $60.000 al
--   cliente, pero apiRoomChange (antes del fix de código) movió la venta
--   a la 304 conservando el total de $60.000 -> descuadre Cierre vs Resumen.
--
--   El código ya fue corregido (commit apiRoomChange + commit card MIXTO).
--   Este script corrige el ÚNICO dato histórico real afectado: la venta 6711.
--
-- Regla de negocio:
--   La 304 es cortesía -> total = 0. NO se crea fila REFUND (poner total=0
--   ya representa ingreso neto $0 y mantiene Cierre = Resumen = Cuadre).
--
-- NO se tocan campos temporales/identificatorios:
--   check_in_ms, ts_ms, room_id, business_day, shift_id, pay_method.
-- =====================================================================

-- ----------------------- FORWARD (aplicar) ---------------------------
BEGIN;

UPDATE sales
SET total   = 0,
    amount_1 = 0,
    amount_2 = 0,
    amount_3 = 0,
    note = 'Correccion retroactiva (2026-06-06): cambio a 304 (cortesia): '
         || 'cobrado y devuelto $60000 EFECTIVO al cliente. Origen hab 206. '
         || 'Venta original del 2026-06-05 T3.'
WHERE id = 6711
  AND room_id = '304'
  AND total = 60000;   -- guarda: 1 sola fila, idempotente

COMMIT;

-- ----------------------- REVERSA (revertir) --------------------------
-- Ejecutar SOLO si hay que deshacer el fix de arriba:
--
-- UPDATE sales
-- SET total = 60000, amount_1 = 60000, amount_2 = 0, amount_3 = 0, note = ''
-- WHERE id = 6711;
-- =====================================================================
