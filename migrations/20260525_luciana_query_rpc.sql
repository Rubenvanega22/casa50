-- 20260525_luciana_query_rpc.sql
-- RPC luciana_query: ejecuta SQL arbitrario en READ ONLY transaction
-- con statement_timeout 10s. Devuelve jsonb array de resultados o
-- {error: msg} si fallo.
--
-- Es la CAPA 2 de defensa del feature Tool Use de Luciana (Fase 9).
-- Capa 1 (regex validacion en JS) corre en el backend antes de invocar.
-- Capa 3 (LIMIT 100 forzado) tambien corre en el backend.
--
-- READ ONLY transaction garantiza que Postgres rechace INSERT/UPDATE/
-- DELETE/DDL incluso si las capas previas fallan. Es la barrera real.
--
-- SECURITY DEFINER hace que corra con permisos del owner (postgres).
-- GRANT solo a service_role para que el backend pueda llamarla;
-- REVOKE de anon y authenticated para que no se pueda invocar desde
-- el frontend con la publishable key.

CREATE OR REPLACE FUNCTION luciana_query(query_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  SET LOCAL transaction_read_only = on;
  SET LOCAL statement_timeout = '10s';
  SET LOCAL lock_timeout = '2s';
  EXECUTE 'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM ('
    || query_text || ') t'
    INTO result;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION luciana_query(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION luciana_query(text) TO service_role;
