-- 20260611_aire_mantenimiento_tablas.sql
-- Mantenimiento preventivo de aires acondicionados (cada 4 meses).
--
-- CONTEXTO: el mantenedor (Geovanny) hace una ronda sobre 42 unidades
-- (38 habitaciones + 4 espacios: 2 oficinas ADM, recepcion, capacitacion),
-- chuleando 8 tareas por unidad y marcando resultado VERDE (todo bien) o
-- AMARILLO (mejora pendiente). Cuando las 42 estan registradas, cierra la
-- ronda y arrancan 4 meses; al vencer, ADMIN ve aviso de que toca otra ronda.
--
-- Este flujo es preventivo y ciclico, distinto al de daños puntuales
-- (room_issues). Por eso usa tablas propias y NO toca room_issues.
--
-- Tres tablas:
--   aire_unidades      -> catalogo fijo de las 42 unidades
--   aire_rondas        -> ciclo de 4 meses; snapshot inmutable al cerrar
--   aire_mantenimiento -> un registro por unidad por ronda
--
-- COMPATIBILIDAD: sin RLS, mismo patron que room_issues (acceso via backend
-- con service key).

-- ============================================================
-- 1) Catalogo fijo de las 42 unidades
-- ============================================================
CREATE TABLE IF NOT EXISTS aire_unidades (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo        text    NOT NULL CHECK (tipo IN ('ROOM','ESPACIO')),
  ref_id      text    NOT NULL UNIQUE,   -- room_id ('201') o slug ('adm_1', 'recepcion'...)
  nombre      text    NOT NULL,
  piso        int,                       -- rooms: 2/3/4; espacios: NULL
  orden       int     NOT NULL,
  activo      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2) Rondas del ciclo de 4 meses (snapshot inmutable al cerrar)
-- ============================================================
CREATE TABLE IF NOT EXISTS aire_rondas (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero      int     NOT NULL,          -- correlativo: ronda 1, 2, 3...
  estado      text    NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA','CERRADA')),
  abierta_ms  bigint  NOT NULL,
  abierta_por text    NOT NULL,
  cerrada_ms  bigint,
  cerrada_por text,
  vence_ms    bigint,                     -- cerrada_ms + 4 meses; se congela al cerrar
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Solo puede haber UNA ronda ABIERTA a la vez (la BD blinda la apertura automatica)
CREATE UNIQUE INDEX IF NOT EXISTS aire_rondas_una_abierta
  ON aire_rondas (estado) WHERE estado = 'ABIERTA';

-- ============================================================
-- 3) Un registro por unidad por ronda
-- ============================================================
CREATE TABLE IF NOT EXISTS aire_mantenimiento (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ronda_id        bigint NOT NULL REFERENCES aire_rondas(id),
  unidad_id       bigint NOT NULL REFERENCES aire_unidades(id),
  tareas          jsonb  NOT NULL DEFAULT '{}'::jsonb,  -- 8 claves bool: filtros, serpentin, condensador, drenaje, gas, electrico, carcasa, prueba
  reporte         text,
  resultado       text   NOT NULL CHECK (resultado IN ('VERDE','AMARILLO')),
  registrado_por  text   NOT NULL,
  registrado_rol  text   NOT NULL,
  registrado_ms   bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ronda_id, unidad_id)            -- upsert al re-registrar una unidad
);

-- Indice para la consulta de historial por unidad
CREATE INDEX IF NOT EXISTS aire_mant_unidad_idx
  ON aire_mantenimiento (unidad_id);

-- ============================================================
-- SEED: 42 unidades
-- ============================================================
-- 38 habitaciones desde rooms (fuente de verdad, no hardcodeado)
INSERT INTO aire_unidades (tipo, ref_id, nombre, piso, orden)
SELECT
  'ROOM',
  room_id,
  room_id,
  floor,
  ROW_NUMBER() OVER (ORDER BY floor, room_id)   -- orden 1..38
FROM rooms;

-- 4 espacios que no son habitaciones (orden 39..42)
INSERT INTO aire_unidades (tipo, ref_id, nombre, piso, orden) VALUES
  ('ESPACIO','adm_1',        'Oficina ADM 1',        NULL, 39),
  ('ESPACIO','adm_2',        'Oficina ADM 2',        NULL, 40),
  ('ESPACIO','recepcion',    'Recepción',            NULL, 41),
  ('ESPACIO','capacitacion', 'Zona de capacitación', NULL, 42);
