-- ============================================================================
-- Migracion: activar RLS en las 44 tablas del POS abiertas a anon
-- Proyecto: casa50 (fojffyncxrrxevavshod)  |  Fecha: 2026-07-11
-- Molde: casa50-reservas/db/migrations/2026-06-09_rooms_enable_rls.sql
--
-- EL AGUJERO
--   Estas 44 tablas tienen RLS DESACTIVADA, cero policies, y grants completos
--   (SELECT, INSERT, UPDATE, DELETE) para los roles anon y authenticated.
--   La anon key es PUBLICA: esta embebida en el bundle del POS
--   (casa50/public/index.html) y en el de casa50-reservas, ambos servidos en
--   Vercel. Cualquiera que abra el codigo fuente la tiene.
--   => Hoy, con esa llave, se puede LEER, MODIFICAR y BORRAR estas 44 tablas.
--      Incluidos los PINs de acceso al POS y toda la contabilidad.
--
-- POR QUE ESTO NO ROMPE NADA (verificado el 11jul26)
--   - Backend POS (casa50/api/index.js:16-19): usa SUPABASE_SERVICE_KEY.
--     service_role BYPASSA RLS siempre -> acceso total intacto.
--   - Frontend POS: la anon key se usa SOLO para Storage (/storage/v1/...),
--     nunca para tablas (/rest/v1/...).
--   - Frontend casa50-reservas: solo toca app_usuarios, app_reservas,
--     app_motel_admins, rooms y app_fotos. NINGUNA de estas 44.
--   - api/ de casa50-reservas: solo app_reservas y app_fotos.
--   - No hay Edge Functions en el proyecto.
--
-- EFECTO POR ROL TRAS APLICAR
--   - service_role (backend POS): bypassa RLS -> sin cambios.
--   - anon / authenticated: BLOQUEADOS para todo. No se crea ninguna policy,
--     y sin policy no hay fila visible ni escribible.
--
-- NO se tocan los GRANTs. Con RLS activado, anon queda bloqueado a nivel de
-- fila aunque conserve el grant (misma nota que la migracion de rooms).
--
-- Transaccional: si algo falla, no queda a medias.
-- Idempotente: ENABLE ROW LEVEL SECURITY sobre una tabla que ya lo tiene no
-- da error; se puede correr de nuevo sin problema.
--
-- NO SE TOCAN (ya tienen su RLS armada): rooms, app_usuarios, app_reservas,
--   app_motel_admins, app_fotos, app_categorias, app_moteles,
--   app_motel_estado_historial, plataforma_admins, caja_paola, config_caja,
--   descargos_nequi, gastos_mes, shift_inventory_start,
--   ventas_diarias_manuales, ventas_gastos_anuales.
--   Tampoco Storage (schema storage, fuera del alcance de este archivo).
--
-- PASO POSTERIOR (coordinado aparte): ROTAR LA ANON KEY. Estuvo expuesta con
--   permisos totales; hay que asumir que pudo haberse copiado.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- PINs (3)
-- Lo mas grave: con estos se entra al POS como recepcion, admin o mantenimiento.
ALTER TABLE public.admin_pins                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_pins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reception_pins                ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------- Ventas y plata (11)
ALTER TABLE public.sales                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bar_sales                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_products                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taxi_expenses                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.general_expenses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retiros_dueno                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cierre_mes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_close                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_method_changes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cortesias                     ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------- Inventario y productos (4)
ALTER TABLE public.products                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_entries                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_shift_obs             ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------ Turnos y personal (9)
ALTER TABLE public.shift_log                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_notes                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_failures                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_vacaciones_historial    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_extras               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extra_staff                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maid_log                      ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------- Mantenimiento (9)
ALTER TABLE public.maintenance                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_bitacora          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mantenimiento_solicitudes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mantenimiento_tareas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mantenimiento_zonas_comunes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_issues                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aire_unidades                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aire_rondas                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aire_mantenimiento            ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------- Operacion y config (8)
ALTER TABLE public.settings                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ajustes                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.motel_info                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_failures                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.state_history                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luciana_chats                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proyeccion_meses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proyeccion_tareas             ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICACION (correr despues; tiene que devolver 0 filas)
--
-- SELECT c.relname AS todavia_abierta
-- FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' AND c.relkind = 'r'
--   AND c.relrowsecurity = false
--   AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
--               WHERE g.table_schema = 'public' AND g.table_name = c.relname
--                 AND g.grantee = 'anon' AND g.privilege_type = 'SELECT')
-- ORDER BY 1;
--
-- Y este tiene que devolver 44:
-- SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity = true
--   AND NOT EXISTS (SELECT 1 FROM pg_policies p
--                   WHERE p.schemaname='public' AND p.tablename=c.relname);
-- ============================================================================
