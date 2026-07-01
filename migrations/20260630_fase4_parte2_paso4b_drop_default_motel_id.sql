-- Fase 4 (onboarding) · Parte 2 (PINs + settings por motel) · Paso 4B (post-soak)
-- Cierra la Parte 2: quita el DEFAULT Casa 50 del motel_id en las 4 tablas
-- globales (admin_pins, reception_pins, maintenance_pins, settings).
--
-- Seguro porque el codigo del Paso 3 (mergeado f155a0d) ya inyecta motel_id en
-- TODO write via helper (tSelect/tInsert/tUpdate/tDelete/tUpsert); ningun insert
-- depende del default. Leccion Lote 12: el DROP DEFAULT solo es seguro post-deploy
-- + soak (la Parte 2 llevaba +24h en produccion operando bien).
--
-- Re-chequeo previo (30-jun): las 4 tablas con datos SOLO en Casa 50, 0 NULLs en
-- motel_id; 0 supabase.from suelto sobre esas 4 en main (12 helper-calls).
--
-- Efecto: motel_id sigue NOT NULL pero SIN default -> todo insert futuro debe
-- pasar motel_id explicito. Esto es una PROTECCION: al sembrar un motel nuevo,
-- un insert a estas 4 tablas sin motel_id ahora FALLA en vez de caer en Casa 50.
-- (seed_motel ya pasa motel_id explicito, asi que el onboarding esta cubierto.)

ALTER TABLE admin_pins       ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE reception_pins   ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE maintenance_pins ALTER COLUMN motel_id DROP DEFAULT;
ALTER TABLE settings         ALTER COLUMN motel_id DROP DEFAULT;

-- Verificacion: sin default, NOT NULL intacto (4 filas, column_default=null,
-- is_nullable=NO)
SELECT table_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND column_name='motel_id'
  AND table_name IN ('admin_pins','reception_pins','maintenance_pins','settings')
ORDER BY table_name;

-- Rollback (si hace falta re-poner el default Casa 50):
-- ALTER TABLE admin_pins       ALTER COLUMN motel_id SET DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
-- ALTER TABLE reception_pins   ALTER COLUMN motel_id SET DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
-- ALTER TABLE maintenance_pins ALTER COLUMN motel_id SET DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
-- ALTER TABLE settings         ALTER COLUMN motel_id SET DEFAULT '24992a8a-48d8-4444-a50f-2d6c7d949828';
