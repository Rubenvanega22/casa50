-- 20260523_extend_payment_method_changes_bar.sql
-- Extiende payment_method_changes para soportar cambios sobre room_products
-- (ventas de bar), no solo sobre sales (cuartos/extensiones).
--
-- Cambios:
--   - sale_id pasa a NULLABLE
--   - se agrega columna room_product_id (NULLABLE)
--   - CHECK constraint: al menos uno de los dos IDs debe estar seteado
--
-- Uso:
--   - Cambio sobre venta de habitacion: sale_id = X, room_product_id = NULL
--   - Cambio sobre venta de bar:        sale_id = NULL, room_product_id = Y

ALTER TABLE payment_method_changes
  ALTER COLUMN sale_id DROP NOT NULL;

ALTER TABLE payment_method_changes
  ADD COLUMN IF NOT EXISTS room_product_id BIGINT;

ALTER TABLE payment_method_changes
  DROP CONSTRAINT IF EXISTS pmc_target_check;

ALTER TABLE payment_method_changes
  ADD CONSTRAINT pmc_target_check
  CHECK ((sale_id IS NOT NULL) OR (room_product_id IS NOT NULL));
