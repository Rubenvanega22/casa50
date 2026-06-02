-- 20260602_admin_pins.sql
-- Tabla de administradores con PIN propio por persona.
--
-- ANTES: el login admin usaba UN solo PIN compartido (settings.ADMIN_CODE = 2206)
-- y el nombre era texto libre. No se podia distinguir un admin de otro.
--
-- AHORA: cada admin tiene su propia fila (nombre canonico + PIN + flag ver_luciana).
-- El login busca la fila cuyo PIN coincida; el nombre y el flag salen de la tabla.
-- Esto permite:
--   1. Dar de alta varios admins con permisos casi identicos
--   2. Bloquear Luciana (asistente IA) solo a quien tenga ver_luciana = false
--   3. Auditoria confiable: cada accion queda con el nombre canonico real
--
-- COMPATIBILIDAD: el backend mantiene un fallback a settings.ADMIN_CODE (2206)
-- si ningun PIN de esta tabla coincide, para no romper logins existentes.

CREATE TABLE admin_pins (
  user_name    TEXT PRIMARY KEY,            -- nombre canonico, en minusculas (ej: 'ruben')
  pin          TEXT NOT NULL,               -- PIN de acceso del admin
  ver_luciana  BOOLEAN NOT NULL DEFAULT TRUE -- false = no ve el boton ni puede usar Luciana
);

-- Sembrar los dos admins iniciales:
--   ruben  -> PIN 2206, ve Luciana (admin principal)
--   lisset -> PIN 2118, NO ve Luciana
INSERT INTO admin_pins (user_name, pin, ver_luciana) VALUES
  ('ruben',  '2206', TRUE),
  ('lisset', '2118', FALSE);
