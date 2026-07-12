# RUNBOOK — Activar RLS en las 44 tablas del POS (11-jul-2026)

## Qué se arregla

44 tablas del schema `public` tenían **RLS desactivada, cero policies y grants completos
(`SELECT, INSERT, UPDATE, DELETE`) para `anon` y `authenticated`**.

La anon key es **pública**: está embebida en el bundle del POS (`casa50/public/index.html`)
y en el de `casa50-reservas`, los dos servidos en Vercel. Cualquiera que mire el código
fuente la tiene. Con esa llave se podía **leer, modificar y borrar** las 44 tablas —
incluidos `reception_pins`, `admin_pins` y `maintenance_pins` (o sea, entrar al POS como
administrador) y toda la contabilidad (`sales`, `retiros_dueno`, `cierre_mes`, `shift_close`…).

Detectado el 11-jul-2026 aplicando el punto 5 de la **REGLA DE ORO — SEGURIDAD FIRST**
(`CLAUDE.md`): revisar RLS/policies/grants de paso en cada investigación.

## Por qué no rompe el POS

| Consumidor | Cómo accede | Efecto |
|---|---|---|
| Backend POS (`api/index.js:16-19`) | `SUPABASE_SERVICE_KEY` | **`service_role` bypassa RLS** → sin cambios |
| Frontend POS (`public/index.html:11950`) | anon key, **solo Storage** (`/storage/v1/…`) | sin cambios (no toca tablas) |
| Frontend casa50-reservas | anon key, solo `app_usuarios`, `app_reservas`, `app_motel_admins`, `rooms`, `app_fotos` | sin cambios (ninguna está en las 44) |
| `api/` de casa50-reservas | solo `app_reservas`, `app_fotos` | sin cambios |
| Edge Functions | no hay | — |

No se tocan los GRANTs: con RLS activada, `anon` queda bloqueado a nivel de fila aunque
conserve el grant. (Misma nota que `casa50-reservas/db/migrations/2026-06-09_rooms_enable_rls.sql`,
que hizo esto mismo para `rooms`.)

## Qué NO se toca

Las 16 tablas que ya tienen RLS armada: `rooms`, `app_usuarios`, `app_reservas`,
`app_motel_admins`, `app_fotos`, `app_categorias`, `app_moteles`,
`app_motel_estado_historial`, `plataforma_admins`, `caja_paola`, `config_caja`,
`descargos_nequi`, `gastos_mes`, `shift_inventory_start`, `ventas_diarias_manuales`,
`ventas_gastos_anuales`. Tampoco Storage (schema `storage`, con sus propias policies).

## Aplicar

1. Correr `migrations/20260711_enable_rls_44_tablas.sql` (transaccional e idempotente).
2. Verificar — la primera query debe devolver **0 filas**, la segunda **44**:

```sql
-- Ninguna tabla debe quedar abierta a anon
SELECT c.relname AS todavia_abierta
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity = false
  AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
              WHERE g.table_schema='public' AND g.table_name=c.relname
                AND g.grantee='anon' AND g.privilege_type='SELECT');

-- 44 tablas con RLS activa y sin policies (solo service_role entra)
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity = true
  AND NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname='public' AND p.tablename=c.relname);
```

## Probar en el POS (producción, inmediatamente después)

El backend usa service key, así que **todo debería andar igual**. Recorrido mínimo:

- [ ] **Login** de recepción con PIN (toca `reception_pins`, `login_failures`, `shift_log`)
- [ ] **Tablero** de habitaciones carga (`rooms`, `sales`, `state_history`, `room_issues`)
- [ ] **Check-in** de una habitación (`sales`, `rooms`, `state_history`)
- [ ] **Agregar producto** a una habitación (`room_products`, `products`, `stock_movements`)
- [ ] **Registrar salida** (`sales`, `rooms`, `state_history`)
- [ ] **Cuadre / cierre de turno** (`shift_close`, `general_expenses`, `taxi_expenses`, `loans`)
- [ ] **Login de admin** con PIN (`admin_pins`) y el cuadre del día
- [ ] **Mantenimiento**: ver daños activos (`room_issues`, `maintenance`)
- [ ] **App cliente** (casa50-reservas): login, ver habitaciones, crear una reserva

Si algo falla, el síntoma sería un listado vacío o un error de permisos — y significaría
que ese camino está usando la anon key contra tablas, cosa que hay que **arreglar**, no
revertir. El rollback (`..._rollback.sql`) existe por las dudas, pero **reabre el agujero
completo**: usarlo solo como último recurso y por poco tiempo.

## Paso posterior (coordinado aparte)

**Rotar la anon key.** Estuvo expuesta con permisos totales sobre todo el POS; hay que
asumir que pudo haberse copiado. Se hace desde la consola de Supabase, y después hay que
actualizar la llave en los dos frontends.
