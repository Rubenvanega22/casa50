-- 20260702_room_products_desglose_mixto.sql
-- Parte 1 del desglose MIXTO en productos: agrega a room_products las 4 columnas
-- de reparto de pago que sales ya tiene (pay_method_2, amount_1/2/3), con tipos y
-- defaults IDENTICOS a sales. Aditiva e idempotente: no toca filas existentes.
-- (Parte 2 = guardar el desglose al registrar el producto. Parte 3 = repartir en
-- el inventario/cuadre. Este archivo NO toca logica, solo la capa de datos.)

BEGIN;

ALTER TABLE public.room_products
  ADD COLUMN IF NOT EXISTS pay_method_2 text    DEFAULT '',
  ADD COLUMN IF NOT EXISTS amount_1     numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_2     numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_3     numeric DEFAULT 0;

COMMIT;

-- Verificacion (las 4 columnas nuevas con su tipo y default):
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='room_products'
--   AND column_name IN ('pay_method_2','amount_1','amount_2','amount_3')
-- ORDER BY column_name;

-- ============================================================
-- ROLLBACK (ejecutar manualmente si hay que revertir):
-- BEGIN;
-- ALTER TABLE public.room_products
--   DROP COLUMN IF EXISTS pay_method_2,
--   DROP COLUMN IF EXISTS amount_1,
--   DROP COLUMN IF EXISTS amount_2,
--   DROP COLUMN IF EXISTS amount_3;
-- COMMIT;
-- ============================================================
