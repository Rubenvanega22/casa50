-- ============================================================================
-- 20260712_app_quejas.sql
-- Pieza 7 (queja libre + bandeja de Quejas y Reclamos), Migracion unica.
--
-- QUE ES
--   La queja libre que escribe un cliente desde la app de reservas, SIN que
--   haya una estadia registrada de por medio. Es la fuente "DECLARADA" de la
--   bandeja: todos sus datos (habitacion, nombre, fecha) los DICE el cliente y
--   el sistema NO puede verificarlos.
--
--   La otra fuente de la bandeja, app_calificaciones, es la "VERIFICADA": esas
--   fichas las crea el POS con los datos reales de la venta. Las dos se mezclan
--   en una sola bandeja pero van ETIQUETADAS distinto, y las metricas serias
--   (promedio de estrellas) se calculan SOLO sobre las verificadas.
--
-- POR QUE LAS COLUMNAS SE LLAMAN _dicha / _dicho
--   Para que el propio esquema deje escrito que ese dato NO esta verificado.
--   Dentro de seis meses alguien va a escribir un reporte contra esta tabla;
--   el nombre de la columna tiene que frenarlo antes de que sume declarado con
--   real en la misma cifra.
--
-- ==================== POR QUE EL CLIENTE NO PUEDE INSERTAR AQUI =============
--   Esta es la PRIMERA vez que el cliente mete texto libre en el sistema. Hoy
--   la app de reservas escribe DIRECTO con la anon key (app_usuarios,
--   app_reservas) y la contiene solo la RLS. Pero la RLS sabe responder "esta
--   fila dice ser tuya y efectivamente lo es"; NO sabe responder "cuantas
--   llevas hoy". Un cliente modificado insertaria quejas en un bucle infinito.
--
--   Por eso la queja entra por un endpoint (/api/queja del repo casa50-reservas)
--   con la service key, que valida el JWT, saca el usuario_id de ahi (JAMAS del
--   body), resuelve el motel_id server-side, y recien ahi cuenta y limita:
--       - maximo 3 quejas por usuario cada 24h RODANTES (no por dia calendario:
--         si fuera por dia, a medianoche se recarga el cupo y entran 6 seguidas)
--       - cooldown de 5 minutos entre quejas del mismo usuario
--   Esta tabla no le da al cliente NINGUNA puerta de INSERT, asi que ese conteo
--   es inevitable por construccion: no hay otra entrada que saltarselo. Por eso
--   tampoco hace falta un trigger anti-spam en la base.
--
-- ============================ SEGURIDAD (REGLA DE ORO, punto 7) =============
--   OJO: en este proyecto las tablas nuevas de public NACEN ABIERTAS. El
--   pg_default_acl le da INSERT/SELECT/UPDATE/DELETE a anon y authenticated
--   automaticamente. Asi nacieron las 44 tablas que cerramos el 11jul26.
--   Por eso este archivo REVOCA todo primero y despues otorga lo minimo.
--
--   Resultado por rol:
--     - service_role (endpoint + POS): bypassa RLS -> unico que inserta, y el
--       unico que mueve el estado / escribe la nota interna.
--     - authenticated (cliente): SELECT de SUS propias quejas y nada mas
--       (para que pueda ver el estado de lo que reporto).
--     - anon: NADA.
--
--   Los CHECK de largo son la LEY. El maxlength del textarea en la app es
--   cortesia visual: se salta con dos clicks en DevTools.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.app_quejas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant first: motel_id NOT NULL + FK REAL a app_moteles.
  -- Lo pone el servidor. Si viniera del body, cualquiera meteria quejas en el
  -- motel del vecino.
  motel_id          uuid NOT NULL REFERENCES public.app_moteles(id),

  -- Lo saca el endpoint del JWT, nunca del body.
  usuario_id        uuid NOT NULL REFERENCES public.app_usuarios(id),

  -- ---- DATOS DECLARADOS POR EL CLIENTE (el sistema NO los puede verificar) --
  habitacion_dicha  text  CHECK (habitacion_dicha IS NULL OR char_length(habitacion_dicha) <= 20),
  nombre_dicho      text  CHECK (nombre_dicho     IS NULL OR char_length(nombre_dicho)     <= 60),
  estadia_dicha_ms  bigint,                       -- fecha/hora aproximada de su estadia

  -- ---- LA QUEJA -----------------------------------------------------------
  -- Minimo 15: corta el "asdf" y la queja vacia, pero deja pasar una legitima
  -- corta ("Falta aseo en el bano" = 21). Maximo 1000: el doble del textarea de
  -- la resena, que se quedaba corto para una queja de verdad.
  texto             text NOT NULL CHECK (char_length(texto) BETWEEN 15 AND 1000),
  estrellas         smallint CHECK (estrellas BETWEEN 1 AND 5),   -- opcional, NULL = no calificó

  -- ---- LO QUE ESCRIBE EL POS (nunca el cliente) ---------------------------
  estado            text NOT NULL DEFAULT 'NUEVA'
                      CHECK (estado IN ('NUEVA','LEIDA','RESUELTA')),
  atendida_por      text,
  atendida_ms       bigint,
  nota_interna      text,

  creado            timestamptz NOT NULL DEFAULT now()
);

-- Bandeja del admin: mas nuevas primero.
CREATE INDEX IF NOT EXISTS app_quejas_motel_creado_idx  ON public.app_quejas (motel_id, creado DESC);

-- Este NO es decorativo: es el indice que usa el anti-spam del endpoint para
-- contar las quejas del usuario en las ultimas 24h y ver cuando fue la ultima.
CREATE INDEX IF NOT EXISTS app_quejas_usuario_creado_idx ON public.app_quejas (usuario_id, creado DESC);

-- ---------------------------------------------------------------- PERMISOS
-- 1) Deshacer el default abierto de pg_default_acl.
REVOKE ALL ON public.app_quejas FROM anon, authenticated;

-- 2) Otorgar lo minimo. anon NO recibe nada.
GRANT SELECT ON public.app_quejas TO authenticated;
-- (sin INSERT: la queja entra por el endpoint con service key, que es donde
--  vive el limite anti-spam. Sin UPDATE ni DELETE: el cliente no reescribe ni
--  borra lo que reporto, y el estado lo mueve solo el POS.)

-- --------------------------------------------------------------------- RLS
ALTER TABLE public.app_quejas ENABLE ROW LEVEL SECURITY;

-- El cliente ve solo SUS quejas (para consultar el estado de lo que reporto).
DROP POLICY IF EXISTS quejas_select_propia ON public.app_quejas;
CREATE POLICY quejas_select_propia
  ON public.app_quejas
  FOR SELECT
  TO authenticated
  USING (usuario_id = auth.uid());

-- Sin policy de INSERT, UPDATE ni DELETE -> el cliente no tiene ninguna puerta
-- propia sobre esta tabla. service_role bypassa RLS y hace todo lo demas.

COMMIT;

-- ============================================================================
-- VERIFICACION
--
-- 1) anon sin NINGUN permiso, authenticated solo con SELECT:
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema='public' AND table_name='app_quejas'
--   AND grantee IN ('anon','authenticated');
--   -> esperado: exactamente 1 fila (authenticated | SELECT)
--
-- 2) RLS activa y UNA sola policy (SELECT), ninguna de INSERT/UPDATE/DELETE:
-- SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
-- WHERE n.nspname='public' AND c.relname='app_quejas';        -- -> t
-- SELECT policyname, cmd, qual FROM pg_policies
-- WHERE schemaname='public' AND tablename='app_quejas';       -- -> 1 fila, SELECT
--
-- 3) La FK real a app_moteles existe (borrar un motel NO debe dejar huerfanas):
-- SELECT conname, confrelid::regclass FROM pg_constraint
-- WHERE conrelid='public.app_quejas'::regclass AND contype='f';
--   -> esperado: 2 filas (app_moteles y app_usuarios)
--
-- 4) Los CHECK de largo muerden (esto DEBE fallar):
-- INSERT INTO public.app_quejas (motel_id, usuario_id, texto)
-- VALUES ('<un motel>', '<un usuario>', 'corto');   -- -> viola el CHECK de texto
--
-- ============================================================================
-- ROLLBACK:
-- BEGIN;
-- DROP TABLE IF EXISTS public.app_quejas;   -- las policies caen con la tabla
-- COMMIT;
-- ============================================================================
