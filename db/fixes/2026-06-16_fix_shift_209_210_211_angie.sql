-- =====================================================================
-- Fix turno: ventas 7706, 7707, 7708 — SHIFT_1 -> SHIFT_2 (error de login)
-- Fecha: 2026-06-16
-- =====================================================================
-- Contexto:
--   El 2026-06-16 la recepcionista del turno 2 (Angie) inicio sesion por
--   error con el perfil del turno 1. Las 3 ventas que hizo ya en su turno
--   (habitaciones 209, 210, 211, EFECTIVO $60.000 c/u) quedaron grabadas
--   en SHIFT_1 cuando correspondian a SHIFT_2.
--
--   Horas reales (America/Bogota):
--     7706 hab 209  14:03:31
--     7707 hab 210  14:04:28
--     7708 hab 211  14:42:58
--   El cambio de turno cae ~14:00 (ver dias 13 y 15 de junio). Ademas hoy
--   no existia NINGUNA venta en SHIFT_2, lo que confirma el error de login.
--
-- Regla de Inmutabilidad del Turno:
--   El shift_id normalmente NO se mueve. Este es un caso EXCEPCIONAL por
--   error humano de login, no un recalculo. Se documenta el motivo en el
--   campo note de cada fila.
--
-- NO se tocan campos financieros ni temporales/identificatorios:
--   business_day, total, pay_method, amount_*, ts_ms, created_at,
--   check_in_ms, room_id. Tampoco editada/motivo_edicion (evitar badge
--   "EDITADA" falso: la venta es correcta, solo el turno estaba mal).
-- =====================================================================

-- ----------------------- FORWARD (aplicar) ---------------------------
BEGIN;

UPDATE sales
SET shift_id = 'SHIFT_2',
    note = 'Correccion turno (2026-06-16): movida de SHIFT_1 a SHIFT_2 por '
         || 'error de login. Angie (recepcion turno 2) inicio sesion con el '
         || 'perfil del turno 1. Venta real del turno 2.'
WHERE id IN (7706, 7707, 7708)
  AND shift_id = 'SHIFT_1'         -- guarda: solo si todavia estan mal
  AND business_day = '2026-06-16'  -- guarda: dia correcto
  AND total = 60000;              -- guarda: las 3 son de 60.000

COMMIT;

-- ----------------------- REVERSA (revertir) --------------------------
-- Ejecutar SOLO si hay que deshacer el fix de arriba:
--
-- UPDATE sales
-- SET shift_id = 'SHIFT_1', note = ''
-- WHERE id IN (7706, 7707, 7708)
--   AND shift_id = 'SHIFT_2'
--   AND business_day = '2026-06-16';
-- =====================================================================
