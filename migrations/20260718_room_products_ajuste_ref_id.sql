-- Pieza 2 (quitar/agregar cortesias): vincula la fila compensatoria con la
-- cortesia ORIGINAL que ajusta. Permite netear el listado y bloquear
-- doble-quita de forma exacta y auditable. Aditiva, nullable. room_products
-- ya esta bajo RLS + motel_id (TENANT_TABLES) -> no cambia la superficie de
-- seguridad. Reversible.
ALTER TABLE public.room_products ADD COLUMN IF NOT EXISTS ajuste_ref_id bigint;
CREATE INDEX IF NOT EXISTS idx_room_products_ajuste_ref
  ON public.room_products (motel_id, ajuste_ref_id);

-- rollback:
--   DROP INDEX IF EXISTS idx_room_products_ajuste_ref;
--   ALTER TABLE public.room_products DROP COLUMN IF EXISTS ajuste_ref_id;
