-- Migración: agregar flag de baja lógica "archived" a rooms.
-- Aditiva, idempotente (IF NOT EXISTS). DEFAULT false => todas las habitaciones
-- existentes quedan archived=false (no-op operativo para Casa 50).
-- archived = baja DEFINITIVA (se oculta de la operación, se conserva por histórico).
-- Distinto de "disabled" (fuera de servicio temporal / mantenimiento).

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

-- Verificación 1: la columna existe con su default
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'rooms' AND column_name = 'archived';

-- Verificación 2: todas las habitaciones quedaron en archived=false
SELECT archived, COUNT(*) AS habitaciones
FROM rooms
GROUP BY archived
ORDER BY archived;
