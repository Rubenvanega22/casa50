-- Fix: shift_close no guardaba el snapshot del cierre desde abr-2026.
--
-- Causa raiz: apiCloseShift (commit cba4bb6, 27-abr-2026) reescribio el insert a
-- shift_close incluyendo 4 columnas que NO existian en la tabla:
--   total_productos, total_productos_ef, total_productos_ta, total_productos_nq
-- Postgres rechazaba el insert entero ("column does not exist") y el codigo se
-- tragaba el error (await tInsert(...) sin leer el {error}) -> el LOGOUT del turno
-- se escribia igual pero el snapshot no. Resultado: 256 cierres (LOGOUT released)
-- desde el 13-abr y 0 filas en shift_close.
--
-- Fix (camino 1): agregar las 4 columnas. Aditivo, numeric DEFAULT 0 (igual que
-- sus hermanas total_efectivo/tarjeta/nequi). Restablece los cierres de inmediato
-- con el codigo que ya estaba en produccion (que ya las manda).
-- (Aparte, en api/index.js: apiCloseShift ahora chequea el error del insert y el
--  LOGOUT se escribe DESPUES del snapshot, no antes.)

ALTER TABLE shift_close
  ADD COLUMN IF NOT EXISTS total_productos    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_productos_ef numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_productos_ta numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_productos_nq numeric DEFAULT 0;

-- Verificacion: las 4 columnas existen (numeric, default 0)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='shift_close'
  AND column_name LIKE 'total_productos%'
ORDER BY column_name;

-- Rollback (si hace falta):
-- ALTER TABLE shift_close
--   DROP COLUMN IF EXISTS total_productos,
--   DROP COLUMN IF EXISTS total_productos_ef,
--   DROP COLUMN IF EXISTS total_productos_ta,
--   DROP COLUMN IF EXISTS total_productos_nq;
