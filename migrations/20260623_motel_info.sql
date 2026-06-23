-- Migración: tabla motel_info (datos del motel, multi-tenant por motel_id)
-- Aditiva e idempotente. Siembra Casa 50: nombre + ciudad + logo actual.
-- Datos fiscales vacíos (se completan desde el editor de Configuración).

CREATE TABLE IF NOT EXISTS motel_info (
  motel_id         uuid PRIMARY KEY,
  nombre           text NOT NULL,
  logo_url         text NOT NULL DEFAULT '',
  nit              text NOT NULL DEFAULT '',
  razon_social     text NOT NULL DEFAULT '',
  direccion        text NOT NULL DEFAULT '',
  telefono         text NOT NULL DEFAULT '',
  ciudad           text NOT NULL DEFAULT '',
  resolucion_dian  text NOT NULL DEFAULT '',
  actualizado      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO motel_info (motel_id, nombre, ciudad, logo_url)
VALUES (
  '24992a8a-48d8-4444-a50f-2d6c7d949828',
  'Casa 50',
  'Cali, Colombia',
  'https://fojffyncxrrxevavshod.supabase.co/storage/v1/object/public/maid-photos/motelsys-logo.png?v=1'
)
ON CONFLICT (motel_id) DO NOTHING;

-- Verificación
SELECT motel_id, nombre, ciudad, logo_url, nit, razon_social, direccion, telefono, resolucion_dian, actualizado
FROM motel_info
WHERE motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828';
