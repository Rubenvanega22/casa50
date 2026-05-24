-- 20260523_apply_stock_delta.sql
-- Funciones atomicas para aplicar deltas a products.stock_actual y products.stock_bodega
-- sin race conditions.
--
-- Contexto: el patron historico era leer (SELECT) -> calcular -> UPDATE con valor calculado.
-- Bajo concurrencia (dos requests leyendo el mismo valor inicial), el segundo UPDATE
-- sobreescribia al primero y se perdia una operacion entera, descuadrando el stock.
--
-- Estas funciones aplican el delta en una sola sentencia UPDATE atomica a nivel de fila,
-- eliminando la ventana de carrera. La validacion de no-negatividad ocurre dentro de la
-- misma transaccion implicita.
--
-- Uso desde el cliente JS:
--   const { data, error } = await supabase.rpc('apply_stock_actual_delta', {
--     p_product_id: 42, p_delta: -2
--   });
--   // data = nuevo stock_actual, o error si producto no existe o quedaria negativo

CREATE OR REPLACE FUNCTION apply_stock_actual_delta(
  p_product_id BIGINT,
  p_delta INT
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new INT;
BEGIN
  UPDATE products
     SET stock_actual = stock_actual + p_delta
   WHERE id = p_product_id
  RETURNING stock_actual INTO v_new;

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'Producto % no existe', p_product_id;
  END IF;

  IF v_new < 0 THEN
    RAISE EXCEPTION 'stock_actual negativo no permitido (resultado: %)', v_new;
  END IF;

  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION apply_stock_bodega_delta(
  p_product_id BIGINT,
  p_delta INT
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new INT;
BEGIN
  UPDATE products
     SET stock_bodega = stock_bodega + p_delta
   WHERE id = p_product_id
  RETURNING stock_bodega INTO v_new;

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'Producto % no existe', p_product_id;
  END IF;

  IF v_new < 0 THEN
    RAISE EXCEPTION 'stock_bodega negativo no permitido (resultado: %)', v_new;
  END IF;

  RETURN v_new;
END;
$$;
