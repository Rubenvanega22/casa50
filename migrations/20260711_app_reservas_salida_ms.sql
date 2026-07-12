-- ============================================================================
-- 20260711_app_reservas_salida_ms.sql
-- Pieza 6 (cierre + calificacion), Migracion A de 2.
--
-- QUE ES
--   El momento en que recepcion registra la salida, el cliente sigue viendo la
--   pantalla persistente de su estadia en la app. Esta columna es la senal que
--   lo libera: la app hace polling de SU reserva (RLS: usuario_id = auth.uid())
--   y cuando ve salida_ms, sale de esa pantalla.
--
--     salida_ms NULL  -> la estadia sigue viva (o la reserva nunca se activo)
--     salida_ms > 0   -> recepcion cerro la estadia; el cliente ya puede salir
--
-- POR QUE SOLO ESTA COLUMNA
--   No se agregan aca el comprobante, la recepcionista ni un flag de "llego".
--   Todo eso vive en la ficha de app_calificaciones (Migracion B), que el POS
--   crea con datos reales y el cliente puede leer. Duplicarlos aca seria una
--   segunda fuente de verdad que puede divergir.
--   Y el "mostrar o no la calificacion" NO necesita flag: la EXISTENCIA de la
--   ficha es la senal. Sin ficha (no-show que nunca llego, o venta anulada) ->
--   la app sale de la pantalla y va al login, sin pedir calificacion.
--
-- ORDEN DEL FLUJO (regla, ver apiCheckOut)
--   1) se crea la ficha de calificacion (si corresponde)
--   2) DESPUES se escribe salida_ms
--   Nunca al reves: si el cliente hiciera polling en el hueco, veria salida_ms,
--   buscaria la ficha, no la encontraria, y se saltearia la calificacion para
--   siempre. Con este orden, salida_ms significa "todo listo".
--
-- SEGURIDAD
--   No hace falta tocar RLS. app_reservas NO tiene policy de UPDATE -> el
--   cliente no puede escribir esta columna (ni ninguna otra) ni ahora ni nunca;
--   solo el POS con la service key. La policy reservas_select_propia que ya
--   existe le deja leerla sin cambios.
--
-- Aditiva e idempotente: no toca filas existentes (todas quedan en NULL, que es
-- el valor correcto — ninguna estadia vieja tiene una salida notificada).
-- ============================================================================

BEGIN;

ALTER TABLE public.app_reservas
  ADD COLUMN IF NOT EXISTS salida_ms bigint;

COMMIT;

-- Verificacion:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='app_reservas'
--   AND column_name='salida_ms';

-- Verificacion 2 (app_reservas sigue SIN policy de UPDATE -> 0 filas):
-- SELECT policyname, cmd FROM pg_policies
-- WHERE schemaname='public' AND tablename='app_reservas' AND cmd='UPDATE';

-- ============================================================================
-- ROLLBACK:
-- BEGIN;
-- ALTER TABLE public.app_reservas DROP COLUMN IF EXISTS salida_ms;
-- COMMIT;
-- ============================================================================
