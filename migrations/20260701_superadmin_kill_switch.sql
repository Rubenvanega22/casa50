-- 20260701_superadmin_kill_switch.sql
-- Nucleo panel superadmin (Fase 5) - capa de datos del kill switch.
-- Aditiva. No modifica tablas existentes. Solo el backend (service_role) toca estas tablas.

BEGIN;

-- 1) Admins de plataforma (dueño del SaaS + futuros colaboradores)
CREATE TABLE IF NOT EXISTS public.plataforma_admins (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.app_usuarios(id) ON DELETE CASCADE,
  rol     text NOT NULL DEFAULT 'owner' CHECK (rol IN ('owner','colaborador')),
  creado  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.plataforma_admins ENABLE ROW LEVEL SECURITY;

-- 2) Historial de cambios de estado del motel (auditoria del kill switch)
CREATE TABLE IF NOT EXISTS public.app_motel_estado_historial (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  motel_id        uuid NOT NULL REFERENCES public.app_moteles(id) ON DELETE CASCADE,
  activo_anterior boolean,
  activo_nuevo    boolean NOT NULL,
  motivo          text,
  cambiado_por    uuid REFERENCES public.app_usuarios(id) ON DELETE SET NULL,
  cambiado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_motel_estado_hist_motel
  ON public.app_motel_estado_historial (motel_id, cambiado_en DESC);
ALTER TABLE public.app_motel_estado_historial ENABLE ROW LEVEL SECURITY;

-- 3) Semilla: Ruben como owner (idempotente)
INSERT INTO public.plataforma_admins (user_id, rol)
VALUES ('24fe0ca9-5b4d-4377-b4f7-4ea8a7148836', 'owner')
ON CONFLICT (user_id) DO NOTHING;

COMMIT;

-- ============================================================
-- ROLLBACK (ejecutar manualmente si hay que revertir):
-- BEGIN;
-- DROP TABLE IF EXISTS public.app_motel_estado_historial;
-- DROP TABLE IF EXISTS public.plataforma_admins;
-- COMMIT;
-- ============================================================
