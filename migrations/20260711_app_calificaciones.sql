-- ============================================================================
-- 20260711_app_calificaciones.sql
-- Pieza 6 (cierre + calificacion), Migracion B de 2.
--
-- QUE ES
--   La ficha de calificacion de una estadia. La CREA EL POS en el checkout, con
--   los datos reales de la venta y estrellas en NULL. El cliente solo la
--   completa: estrellas + resena. Nunca la crea ni la borra.
--
-- POR QUE AL REVES DE LO OBVIO (el POS inserta, el cliente actualiza)
--   Si el cliente insertara la fila con todos los datos (habitacion, valor,
--   recepcionista...), RLS NO podria validarlos: un WITH CHECK sabe comparar
--   contra auth.uid(), pero no puede verificar que el valor que mando sea el
--   precio real. Un cliente modificado inyectaria calificaciones falsas.
--   Es el mismo molde que ya usa reservas_insert_propia, que bloquea todos los
--   campos que el cliente no debe poder falsear (clave, pago_ms, wompi_*).
--   Aca vamos un paso mas: el cliente ni siquiera puede insertar.
--
-- LA EXISTENCIA DE LA FICHA ES LA SENAL
--   El POS crea la ficha SOLO si la estadia realmente ocurrio:
--     - no-show que nunca llego (sales.cliente_llego_ms IS NULL) -> SIN ficha
--     - venta anulada                                            -> SIN ficha
--   La app cliente muestra la pantalla de calificacion solo si encuentra su
--   ficha. Sin ficha -> directo al login. No hace falta ningun flag aparte.
--
-- ============================ SEGURIDAD (REGLA DE ORO, punto 7) =============
--   OJO: en este proyecto las tablas nuevas de public NACEN ABIERTAS. El
--   pg_default_acl le da INSERT/SELECT/UPDATE/DELETE a anon y authenticated
--   automaticamente. Asi nacieron las 44 tablas que cerramos el 11jul26.
--   Por eso este archivo REVOCA todo primero y despues otorga lo minimo.
--
--   Y RLS es por FILA, no por columna: una policy de UPDATE autoriza la fila
--   ENTERA, y con eso el cliente podria reescribir valor, habitacion o
--   recepcionista. La herramienta correcta para limitar columnas son los GRANT
--   a nivel de columna: GRANT UPDATE (estrellas, resena, calificado_ms).
--
--   Resultado por rol:
--     - service_role (POS): bypassa RLS -> crea la ficha y lee todo.
--     - authenticated (cliente): SELECT de SU fila; UPDATE de SU fila solo
--       en 3 columnas y solo mientras estrellas IS NULL (no puede re-calificar).
--     - anon: NADA.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.app_calificaciones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant first: motel_id NOT NULL + FK REAL a app_moteles.
  -- (Solo 4 de 56 tablas tenian FK real; borrar un motel dejaba huerfanas.)
  motel_id         uuid NOT NULL REFERENCES public.app_moteles(id),

  -- Una calificacion por reserva (UNIQUE -> el INSERT del POS es idempotente
  -- con ON CONFLICT DO NOTHING).
  reserva_id       uuid NOT NULL UNIQUE REFERENCES public.app_reservas(id),
  usuario_id       uuid NOT NULL REFERENCES public.app_usuarios(id),

  -- Datos REALES de la estadia, copiados de sales en el checkout.
  -- habitacion sale de sales.room_id, NO de app_reservas.habitacion: si hubo
  -- cambio de habitacion a mitad de estadia, app_reservas guarda la original
  -- (la venta se mueve al cuarto nuevo, la reserva no).
  habitacion       text   NOT NULL,
  comprobante_num  bigint,          -- sales.id -> el numero RSV-NNNNNN
  entrada_ms       bigint,
  salida_ms        bigint,
  duracion_hrs     numeric,
  valor            numeric,
  recepcionista    text,            -- quien registro la salida

  -- Lo unico que escribe el cliente.
  estrellas        smallint CHECK (estrellas BETWEEN 1 AND 5),   -- NULL = sin calificar
  resena           text,
  calificado_ms    bigint,

  creado           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_calificaciones_usuario_idx ON public.app_calificaciones (usuario_id);
CREATE INDEX IF NOT EXISTS app_calificaciones_motel_idx   ON public.app_calificaciones (motel_id);

-- ---------------------------------------------------------------- PERMISOS
-- 1) Deshacer el default abierto de pg_default_acl.
REVOKE ALL ON public.app_calificaciones FROM anon, authenticated;

-- 2) Otorgar lo minimo. anon NO recibe nada.
GRANT SELECT                                        ON public.app_calificaciones TO authenticated;
GRANT UPDATE (estrellas, resena, calificado_ms)     ON public.app_calificaciones TO authenticated;
-- (sin INSERT, sin DELETE: la ficha la crea el POS con la service key)

-- --------------------------------------------------------------------- RLS
ALTER TABLE public.app_calificaciones ENABLE ROW LEVEL SECURITY;

-- El cliente ve solo SUS fichas.
DROP POLICY IF EXISTS calificaciones_select_propia ON public.app_calificaciones;
CREATE POLICY calificaciones_select_propia
  ON public.app_calificaciones
  FOR SELECT
  TO authenticated
  USING (usuario_id = auth.uid());

-- El cliente califica SU ficha, una sola vez (USING estrellas IS NULL) y tiene
-- que dejar una calificacion real (WITH CHECK estrellas IS NOT NULL).
-- Que columnas puede tocar NO lo decide esta policy: lo decide el GRANT de arriba.
DROP POLICY IF EXISTS calificaciones_update_propia ON public.app_calificaciones;
CREATE POLICY calificaciones_update_propia
  ON public.app_calificaciones
  FOR UPDATE
  TO authenticated
  USING      (usuario_id = auth.uid() AND estrellas IS NULL)
  WITH CHECK (usuario_id = auth.uid() AND estrellas IS NOT NULL);

-- Sin policy de INSERT y sin policy de DELETE -> el cliente no puede crear ni
-- borrar fichas. service_role bypassa RLS y hace el INSERT desde apiCheckOut.

COMMIT;

-- ============================================================================
-- VERIFICACION
--
-- 1) anon no tiene NINGUN permiso (0 filas) y authenticated solo SELECT + el
--    UPDATE de 3 columnas:
-- SELECT grantee, privilege_type, column_name
-- FROM information_schema.column_privileges
-- WHERE table_schema='public' AND table_name='app_calificaciones'
--   AND grantee IN ('anon','authenticated')
-- ORDER BY grantee, privilege_type, column_name;
--
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema='public' AND table_name='app_calificaciones'
--   AND grantee IN ('anon','authenticated');
--
-- 2) RLS activa y las 2 policies (SELECT y UPDATE, ninguna de INSERT/DELETE):
-- SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
-- WHERE n.nspname='public' AND c.relname='app_calificaciones';
-- SELECT policyname, cmd, qual, with_check FROM pg_policies
-- WHERE schemaname='public' AND tablename='app_calificaciones' ORDER BY cmd;
--
-- ============================================================================
-- ROLLBACK:
-- BEGIN;
-- DROP TABLE IF EXISTS public.app_calificaciones;   -- las policies caen con la tabla
-- COMMIT;
-- ============================================================================
