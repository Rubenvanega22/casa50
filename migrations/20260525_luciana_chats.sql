-- 20260525_luciana_chats.sql
-- Tabla para guardar el historial completo de conversaciones con Luciana
-- (asistente IA del admin). Sirve como:
--   1. Auditoria de que pregunto/respondio Luciana
--   2. Tracking de costos (tokens + USD por mes)
--   3. Contexto para preguntas siguientes (historial del dia)
--
-- Solo escribe el backend desde apiLucianaChat (un INSERT por respuesta).
-- Nunca se actualiza ni borra automaticamente.

CREATE TABLE luciana_chats (
  id                  BIGSERIAL PRIMARY KEY,
  ts_ms               BIGINT NOT NULL,
  user_name           TEXT NOT NULL,
  business_day        TEXT NOT NULL,
  pregunta            TEXT NOT NULL,
  respuesta           TEXT NOT NULL,
  foto_url            TEXT,
  tokens_input        INT DEFAULT 0,
  tokens_output       INT DEFAULT 0,
  tokens_cache_read   INT DEFAULT 0,
  tokens_cache_write  INT DEFAULT 0,
  costo_usd           NUMERIC(10,4) DEFAULT 0
);

-- Indice por timestamp DESC para listar conversaciones recientes
CREATE INDEX idx_luciana_chats_ts ON luciana_chats(ts_ms DESC);

-- Indice por business_day para sumar costos del mes / dia
CREATE INDEX idx_luciana_chats_bday ON luciana_chats(business_day);
