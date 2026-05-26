-- 20260526_luciana_chats_add_mood.sql
-- Agrega columna mood a luciana_chats. Llenada por el backend en
-- apiLucianaChat segun keyword matching de la respuesta. Valores:
-- 'alegre' | 'preocupado' | 'neutro' | NULL (para rows anteriores).
-- Usado por el frontend para animar el avatar de Luciana segun el
-- contexto de la respuesta. Tambien sirve para analytics futuros.

ALTER TABLE luciana_chats ADD COLUMN mood TEXT;

CREATE INDEX idx_luciana_chats_mood ON luciana_chats(mood) WHERE mood IS NOT NULL;
