-- ============================================================================
-- ROLLBACK de 20260711_enable_rls_44_tablas.sql
-- Proyecto: casa50 (fojffyncxrrxevavshod)  |  Fecha: 2026-07-11
--
-- Devuelve las 44 tablas al estado anterior: RLS DESACTIVADA.
--
-- ATENCION: correr esto REABRE el agujero. Las 44 tablas vuelven a quedar
-- legibles, modificables y borrables por cualquiera que tenga la anon key
-- (que es publica: esta en el bundle de los dos frontends). Incluye los PINs
-- de acceso al POS y toda la contabilidad.
--
-- Solo tiene sentido si el POS deja de funcionar tras aplicar la migracion,
-- y aun asi lo correcto seria diagnosticar por que: el backend usa
-- SUPABASE_SERVICE_KEY, que bypassa RLS, asi que un fallo del POS por esta
-- migracion significaria que algo esta usando la anon key contra tablas —
-- y eso es justamente lo que hay que arreglar, no revertir.
--
-- Transaccional e idempotente.
-- ============================================================================

BEGIN;

-- PINs (3)
ALTER TABLE public.admin_pins                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_pins              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.reception_pins                DISABLE ROW LEVEL SECURITY;

-- Ventas y plata (11)
ALTER TABLE public.sales                         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.bar_sales                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_products                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.taxi_expenses                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.general_expenses              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans                         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.retiros_dueno                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.cierre_mes                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_close                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_method_changes        DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.cortesias                     DISABLE ROW LEVEL SECURITY;

-- Inventario y productos (4)
ALTER TABLE public.products                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_entries                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements               DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_shift_obs             DISABLE ROW LEVEL SECURITY;

-- Turnos y personal (9)
ALTER TABLE public.shift_log                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_notes                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_failures                DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff                         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_vacaciones_historial    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_extras               DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.extra_staff                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.maid_log                      DISABLE ROW LEVEL SECURITY;

-- Mantenimiento (9)
ALTER TABLE public.maintenance                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_bitacora          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mantenimiento_solicitudes     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mantenimiento_tareas          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mantenimiento_zonas_comunes   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_issues                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.aire_unidades                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.aire_rondas                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.aire_mantenimiento            DISABLE ROW LEVEL SECURITY;

-- Operacion y config (8)
ALTER TABLE public.settings                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ajustes                       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.motel_info                    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_failures                DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.state_history                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.luciana_chats                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.proyeccion_meses              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.proyeccion_tareas             DISABLE ROW LEVEL SECURITY;

COMMIT;
