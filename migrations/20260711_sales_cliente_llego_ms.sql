-- 20260711_sales_cliente_llego_ms.sql
-- Pieza 2 (badge "SIN CLIENTE"), Parte 1: capa de datos.
--
-- Cuando autoActivarReservasVencidas activa una reserva por no-show, la venta WOMPI queda
-- con user_name='SISTEMA (no-show)'. Esa huella dice que la habitacion se ocupo SIN que el
-- cliente se presentara, pero no hay donde anotar que despues SI llego. Esta columna es ese
-- lugar: se estampa cuando la recepcionista verifica la llegada tardia con la clave.
--
--   cliente_llego_ms NULL  -> el cliente no ha llegado (o la venta no es un no-show)
--   cliente_llego_ms > 0   -> llego tarde y se verifico con la clave, en ese instante
--
-- El badge ambar "SIN CLIENTE" se deriva de: venta WOMPI de la estadia actual
-- + user_name empieza con 'SISTEMA' + cliente_llego_ms IS NULL.
--
-- IMPORTANTE: NO se toca user_name. La huella del no-show se conserva para siempre (sale
-- impresa en la tirilla como "Activo:" y alimenta los reportes por usuario). Saber que el
-- cliente llego tarde NO borra el hecho de que hubo un no-show: son dos datos distintos.
--
-- Aditiva e idempotente: no toca filas existentes (todas quedan en NULL, que es el valor
-- correcto — ninguna venta vieja tiene llegada verificada). sales ya es tabla tenant
-- (tiene motel_id), asi que no hay nada que scopear aca.

BEGIN;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cliente_llego_ms bigint;

COMMIT;

-- Verificacion (la columna nueva, nullable y sin default):
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='sales'
--   AND column_name='cliente_llego_ms';

-- Verificacion 2 (no-shows activos hoy, que son los que van a mostrar el badge):
-- SELECT id, room_id, business_day, user_name, cliente_llego_ms
-- FROM public.sales
-- WHERE origin='WOMPI' AND anulada=false AND user_name LIKE 'SISTEMA%'
-- ORDER BY ts_ms DESC LIMIT 20;

-- ============================================================
-- ROLLBACK (ejecutar manualmente si hay que revertir):
-- BEGIN;
-- ALTER TABLE public.sales
--   DROP COLUMN IF EXISTS cliente_llego_ms;
-- COMMIT;
-- ============================================================
