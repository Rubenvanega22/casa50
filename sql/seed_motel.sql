-- ============================================================================
-- Fase 4 · Parte 1 · seed_motel(payload jsonb) -> uuid
-- Onboarding de un motel nuevo en la BD compartida (Modelo A multi-tenant).
-- BORRADOR PARA AUDITAR — NO APLICADO TODAVIA.
--
-- Devuelve el motel_id (id de app_moteles) generado.
-- Atomico: corre dentro de la transaccion del statement que la invoca; cualquier
-- RAISE EXCEPTION revierte TODOS los inserts (no quedan datos a medias).
--
-- motel_id: se captura UNA vez del RETURNING de app_moteles y se propaga EXPLICITO
-- a cada insert. Esto cubre tanto las tenant (sin default desde el hardening de
-- Fase 3) como las 4 de PINs/settings (con default Casa 50 hasta el Paso 4B): si
-- no se pasara explicito, esas 4 caerian silenciosamente en Casa 50.
--
-- Orden de inserts (por FK + dependencia logica):
--   1) app_moteles (raiz; las FKs de app_categorias/app_fotos/app_motel_admins
--      dependen de su id)  -> captura v_motel_id
--   2) motel_info
--   3) app_categorias (FK a app_moteles) — antes que rooms
--   4) rooms (category debe existir en las categorias)
--   5) settings (motel_id EXPLICITO)
--   6) admin_pins (primer admin; motel_id EXPLICITO)
--   7) reception_pins (opcional)
--   8) maintenance_pins (opcional)
-- aire_unidades y mantenimiento_zonas_comunes: se dejan VACIOS a proposito.
--
-- Forma del payload (ejemplo al pie).
-- ============================================================================

CREATE OR REPLACE FUNCTION seed_motel(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_motel_id        uuid;
  v_slug            text := nullif(trim(payload->>'slug'), '');
  v_nombre          text := nullif(trim(payload->>'nombre'), '');
  v_admin_user      text := nullif(trim(payload->'admin'->>'user_name'), '');
  v_admin_pin       text := nullif(trim(payload->'admin'->>'pin'), '');
  v_cat             jsonb;
  v_room            jsonb;
  v_rp              jsonb;
  v_mp              jsonb;
  v_skey            text;
  v_precio_key      text;
  v_cats            text[] := ARRAY[]::text[];  -- nombre_db sembrados (validar rooms.category)
  v_required_precio text[] := ARRAY['3h','6h','8h','12h','extraHour','extraPerson','included'];
BEGIN
  -- ========================= VALIDACIONES =========================
  IF v_slug   IS NULL THEN RAISE EXCEPTION 'seed_motel: falta slug'; END IF;
  IF v_nombre IS NULL THEN RAISE EXCEPTION 'seed_motel: falta nombre'; END IF;
  IF v_admin_user IS NULL OR v_admin_pin IS NULL THEN
    RAISE EXCEPTION 'seed_motel: admin.user_name y admin.pin son obligatorios';
  END IF;
  IF v_admin_pin !~ '^\d{4,}$' THEN
    RAISE EXCEPTION 'seed_motel: admin.pin debe ser numerico de 4+ digitos';
  END IF;

  -- slug unico (aborto limpio si ya existe)
  IF EXISTS (SELECT 1 FROM app_moteles WHERE slug = v_slug) THEN
    RAISE EXCEPTION 'seed_motel: el slug "%" ya existe', v_slug;
  END IF;

  -- al menos 1 categoria y 1 habitacion
  IF jsonb_array_length(coalesce(payload->'categorias','[]'::jsonb)) < 1 THEN
    RAISE EXCEPTION 'seed_motel: se requiere al menos una categoria';
  END IF;
  IF jsonb_array_length(coalesce(payload->'rooms','[]'::jsonb)) < 1 THEN
    RAISE EXCEPTION 'seed_motel: se requiere al menos una habitacion';
  END IF;

  -- categorias: nombres presentes + precios con los 7 campos > 0; junta nombre_db
  FOR v_cat IN SELECT * FROM jsonb_array_elements(payload->'categorias') LOOP
    IF nullif(trim(v_cat->>'nombre_ui'),'') IS NULL
       OR nullif(trim(v_cat->>'nombre_db'),'') IS NULL THEN
      RAISE EXCEPTION 'seed_motel: categoria sin nombre_ui/nombre_db: %', v_cat;
    END IF;
    FOREACH v_precio_key IN ARRAY v_required_precio LOOP
      IF NOT (v_cat->'precios' ? v_precio_key)
         OR (v_cat->'precios'->>v_precio_key) !~ '^\d+(\.\d+)?$'
         OR (v_cat->'precios'->>v_precio_key)::numeric <= 0 THEN
        RAISE EXCEPTION 'seed_motel: categoria "%" precio "%" invalido (requerido y > 0)',
          v_cat->>'nombre_db', v_precio_key;
      END IF;
    END LOOP;
    -- included ademas debe ser entero 1..10 (lo que espera getPricing)
    IF (v_cat->'precios'->>'included')::numeric <> floor((v_cat->'precios'->>'included')::numeric)
       OR (v_cat->'precios'->>'included')::int NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION 'seed_motel: categoria "%" included debe ser entero 1..10', v_cat->>'nombre_db';
    END IF;
    v_cats := array_append(v_cats, v_cat->>'nombre_db');
  END LOOP;

  -- rooms: room_id presente y category ∈ categorias sembradas
  FOR v_room IN SELECT * FROM jsonb_array_elements(payload->'rooms') LOOP
    IF nullif(trim(v_room->>'room_id'),'') IS NULL THEN
      RAISE EXCEPTION 'seed_motel: habitacion sin room_id: %', v_room;
    END IF;
    IF NOT (v_room->>'category' = ANY(v_cats)) THEN
      RAISE EXCEPTION 'seed_motel: habitacion "%" tiene category "%" que no esta en las categorias sembradas',
        v_room->>'room_id', v_room->>'category';
    END IF;
  END LOOP;

  -- ========================= INSERTS (orden estricto) =========================
  -- 1) app_moteles (raiz) -> captura el motel_id
  INSERT INTO app_moteles (slug, nombre, logo_path, direccion, contacto, activo)
  VALUES (
    v_slug,
    v_nombre,
    nullif(payload->>'logo_url',''),
    nullif(payload->'fiscal'->>'direccion',''),
    nullif(payload->'fiscal'->>'telefono',''),
    true
  )
  RETURNING id INTO v_motel_id;

  -- 2) motel_info (nombre/logo/fiscal; motel_id EXPLICITO)
  INSERT INTO motel_info (
    motel_id, nombre, logo_url, nit, razon_social, direccion, telefono, ciudad, resolucion_dian
  ) VALUES (
    v_motel_id,
    v_nombre,
    coalesce(payload->>'logo_url',''),
    coalesce(payload->'fiscal'->>'nit',''),
    coalesce(payload->'fiscal'->>'razon_social',''),
    coalesce(payload->'fiscal'->>'direccion',''),
    coalesce(payload->'fiscal'->>'telefono',''),
    coalesce(payload->'fiscal'->>'ciudad',''),
    coalesce(payload->'fiscal'->>'resolucion_dian','')
  );

  -- 3) app_categorias (FK a app_moteles; motel_id EXPLICITO)
  FOR v_cat IN SELECT * FROM jsonb_array_elements(payload->'categorias') LOOP
    INSERT INTO app_categorias (motel_id, nombre_ui, nombre_db, precios, descripcion, orden, activo)
    VALUES (
      v_motel_id,
      v_cat->>'nombre_ui',
      v_cat->>'nombre_db',
      v_cat->'precios',
      nullif(v_cat->>'descripcion',''),
      coalesce(nullif(v_cat->>'orden','')::int, 0),
      true
    );
  END LOOP;

  -- 4) rooms (motel_id EXPLICITO; resto operativo por default)
  FOR v_room IN SELECT * FROM jsonb_array_elements(payload->'rooms') LOOP
    INSERT INTO rooms (motel_id, room_id, floor, category, state, archived)
    VALUES (
      v_motel_id,
      v_room->>'room_id',
      coalesce(nullif(v_room->>'floor','')::int, 0),
      v_room->>'category',
      'AVAILABLE',
      false
    );
  END LOOP;

  -- 5) settings (motel_id EXPLICITO — el default sigue siendo Casa 50 hasta Paso 4B)
  IF payload ? 'settings' THEN
    FOR v_skey IN SELECT jsonb_object_keys(payload->'settings') LOOP
      INSERT INTO settings (motel_id, key, value)
      VALUES (v_motel_id, v_skey, payload->'settings'->>v_skey);
    END LOOP;
  END IF;

  -- 6) admin_pins (primer admin; motel_id EXPLICITO)
  INSERT INTO admin_pins (motel_id, user_name, pin, ver_luciana)
  VALUES (
    v_motel_id,
    v_admin_user,
    v_admin_pin,
    coalesce(nullif(payload->'admin'->>'ver_luciana','')::boolean, true)
  );

  -- 7) reception_pins (opcional; motel_id EXPLICITO)
  IF payload ? 'reception_pins' THEN
    FOR v_rp IN SELECT * FROM jsonb_array_elements(payload->'reception_pins') LOOP
      INSERT INTO reception_pins (motel_id, user_name, pin, updated_at)
      VALUES (v_motel_id, v_rp->>'user_name', coalesce(v_rp->>'pin',''), now());
    END LOOP;
  END IF;

  -- 8) maintenance_pins (opcional; motel_id EXPLICITO)
  IF payload ? 'maintenance_pins' THEN
    FOR v_mp IN SELECT * FROM jsonb_array_elements(payload->'maintenance_pins') LOOP
      INSERT INTO maintenance_pins (motel_id, user_name, pin, active)
      VALUES (v_motel_id, v_mp->>'user_name', v_mp->>'pin', true);
    END LOOP;
  END IF;

  RAISE NOTICE 'seed_motel OK: % (slug=%) motel_id=%', v_nombre, v_slug, v_motel_id;
  RETURN v_motel_id;
END;
$$;

-- ============================================================================
-- EJEMPLO DE USO (NO ejecutar hasta auditar):
--
-- SELECT seed_motel('{
--   "slug": "villaluz",
--   "nombre": "Villa Luz",
--   "logo_url": "",
--   "fiscal": { "nit":"", "razon_social":"", "direccion":"", "telefono":"", "ciudad":"Cali", "resolucion_dian":"" },
--   "categorias": [
--     { "nombre_ui":"Junior", "nombre_db":"Junior", "orden":1,
--       "precios": {"3h":50000,"6h":100000,"8h":70000,"12h":90000,"extraHour":15000,"extraPerson":15000,"included":2} },
--     { "nombre_ui":"Suite",  "nombre_db":"Suite",  "orden":2,
--       "precios": {"3h":80000,"6h":160000,"8h":100000,"12h":120000,"extraHour":20000,"extraPerson":20000,"included":2} }
--   ],
--   "rooms": [
--     {"room_id":"101","floor":1,"category":"Junior"},
--     {"room_id":"102","floor":1,"category":"Junior"},
--     {"room_id":"201","floor":2,"category":"Suite"}
--   ],
--   "admin": { "user_name":"ruben", "pin":"1234", "ver_luciana": true },
--   "settings": {
--     "ADMIN_CODE":"1234", "DAILY_GOAL":"2000000", "MULTI_MAID_MODE":"false",
--     "BUSINESS_DAY_START_HOUR":"6", "DIRTY_ALERT_MINS":"30", "DRAWER_PENDING":"0"
--   },
--   "reception_pins": [ {"user_name":"angie","pin":"1111"} ],
--   "maintenance_pins": [ {"user_name":"jose","pin":"2222"} ]
-- }'::jsonb);
--
-- ROLLBACK de la funcion (no de los datos):  DROP FUNCTION IF EXISTS seed_motel(jsonb);
-- ============================================================================
