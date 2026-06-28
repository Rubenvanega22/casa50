-- Fase 4 (onboarding moteles) · Parte 2 (PINs + settings por motel) · Paso 4A
-- Retira los PK/uniques GLOBALES viejos y promueve los uniques compuestos por
-- motel a PK (reusando los indices del Paso 2 con ADD PRIMARY KEY USING INDEX,
-- atomico, sin reconstruir). Habilita que un 2do motel reuse keys/user_name/pin.
--
-- Seguro porque: el codigo del Paso 3 ya esta deployado y usa onConflict
-- compuesto; 0 FKs apuntan a estas tablas (verificado Paso 0).
-- NO toca el DEFAULT del motel_id (eso es Paso 4B, post-soak).
--
-- Nota: al promover con USING INDEX, los indices settings_motel_key_uidx,
-- reception_pins_motel_user_uidx y admin_pins_motel_user_uidx se renombran a
-- *_pkey (pasan a respaldar el PK). Los indices de PIN quedan como unique index.

-- settings: PK(key) -> PK(motel_id, key)
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD CONSTRAINT settings_pkey PRIMARY KEY USING INDEX settings_motel_key_uidx;

-- reception_pins: PK(user_name) -> PK(motel_id, user_name)
ALTER TABLE reception_pins DROP CONSTRAINT reception_pins_pkey;
ALTER TABLE reception_pins ADD CONSTRAINT reception_pins_pkey PRIMARY KEY USING INDEX reception_pins_motel_user_uidx;

-- admin_pins: PK(user_name) -> PK(motel_id, user_name); (motel_id,pin) queda unique index
ALTER TABLE admin_pins DROP CONSTRAINT admin_pins_pkey;
ALTER TABLE admin_pins ADD CONSTRAINT admin_pins_pkey PRIMARY KEY USING INDEX admin_pins_motel_user_uidx;

-- maintenance_pins: mantiene PK(id serial); dropea solo el UNIQUE(user_name) global viejo
ALTER TABLE maintenance_pins DROP CONSTRAINT maintenance_pins_user_name_key;

-- Verificacion: PKs finales + indices unicos vigentes
SELECT tc.table_name, tc.constraint_type,
       string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS cols
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
WHERE tc.table_schema='public'
  AND tc.table_name IN ('admin_pins','reception_pins','maintenance_pins','settings')
  AND tc.constraint_type='PRIMARY KEY'
GROUP BY tc.table_name, tc.constraint_type
ORDER BY tc.table_name;

-- Rollback (best-effort; re-crea el estado global viejo):
-- ALTER TABLE settings DROP CONSTRAINT settings_pkey;
-- ALTER TABLE settings ADD PRIMARY KEY (key);
-- CREATE UNIQUE INDEX IF NOT EXISTS settings_motel_key_uidx ON settings (motel_id, key);
-- ALTER TABLE reception_pins DROP CONSTRAINT reception_pins_pkey;
-- ALTER TABLE reception_pins ADD PRIMARY KEY (user_name);
-- CREATE UNIQUE INDEX IF NOT EXISTS reception_pins_motel_user_uidx ON reception_pins (motel_id, user_name);
-- ALTER TABLE admin_pins DROP CONSTRAINT admin_pins_pkey;
-- ALTER TABLE admin_pins ADD PRIMARY KEY (user_name);
-- CREATE UNIQUE INDEX IF NOT EXISTS admin_pins_motel_user_uidx ON admin_pins (motel_id, user_name);
-- ALTER TABLE maintenance_pins ADD CONSTRAINT maintenance_pins_user_name_key UNIQUE (user_name);
