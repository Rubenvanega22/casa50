# Onboarding de un motel nuevo (Fase 4 · Parte 4)

Runbook para dar de alta un motel nuevo. Asume que Fase 3 (aislamiento por
`motel_id`) y Fase 4 Partes 1-3 ya están en `main`. Ver también
[arquitectura-multi-tenant.md](arquitectura-multi-tenant.md).

## Modelo de despliegue

- **Un proyecto de Vercel por motel**, todos desde el mismo repo (`Rubenvanega22/casa50`)
  y la misma rama (`main`). **Difieren SOLO en la env `MOTEL_ID`.**
- La **BD Supabase es compartida**; el aislamiento lo da el `motel_id` (helper
  `tSelect/tInsert/tUpdate/tDelete/tUpsert` + `getCortesiaIds` + login scopeado).
- Un `git push` a `main` despliega a **todos** los moteles (codebase único).

## Variables de entorno (Vercel → Project → Settings → Environment Variables)

| Variable | Valor | ¿Cambia por motel? |
|---|---|---|
| `MOTEL_ID` | el uuid del motel (lo devuelve `seed_motel`) | **SÍ — es lo único que cambia** |
| `SUPABASE_URL` | la misma que Casa 50 (BD compartida) | No |
| `SUPABASE_SERVICE_KEY` | la **service_role** key (NO la anon) | No |
| `ANTHROPIC_API_KEY` | la misma (Luciana); opcional | No |

> El código lee estas 4 en `api/index.js` (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
> L17-18, `ANTHROPIC_API_KEY` L22, `MOTEL_ID` L44, default Casa 50).

## Pasos

1. **Sembrar la BD** (una vez, desde Supabase):
   `SELECT seed_motel('{...}'::jsonb);` con el payload del motel (ver
   [`sql/seed_motel.sql`](../sql/seed_motel.sql) — identidad, categorías+precios,
   rooms, admin, settings, y `is_cortesia` por-habitación si corresponde).
   **Anotar el `motel_id` que devuelve.**
2. **Crear el proyecto en Vercel** desde el repo, rama `main`.
3. **Setear las 4 env vars** (tabla de arriba). `MOTEL_ID` = el del paso 1; las
   otras 3 = las mismas de Casa 50. **Confirmar que `SUPABASE_SERVICE_KEY` es la
   service_role** (ver gotcha).
4. **Deploy** y esperar verde.
5. **Asignar dominio/subdominio** al motel.
6. **Smoke test** en el dominio nuevo:
   - Login **ADMIN** con el PIN sembrado → entra.
   - Aparece el **nombre/logo** del motel (de `motel_info`).
   - Las **habitaciones** sembradas aparecen, con **precios** correctos (categorías).
   - Un **check-in de prueba** escribe con el `motel_id` correcto (no en Casa 50).
   - Si se marcó cortesía: check-in en esa room = $0 y sección "Cortesía" la muestra.
7. **Verificar aislamiento:** el motel nuevo NO ve datos de Casa 50 ni al revés.

## Gotchas

- **`SUPABASE_SERVICE_KEY` DEBE ser service_role.** Si por error queda la anon, las
  escrituras fallan en silencio (`apiCheckIn` responde ok igual). Es el incidente
  de Fase 3.
- **`MOTEL_ID` explícito en seeds:** mientras NO se aplique el Paso 4B (drop default
  en `admin_pins/reception_pins/maintenance_pins/settings`), esas 4 tablas tienen
  default Casa 50. `seed_motel` ya pasa `motel_id` explícito, así que el alta está
  cubierta; pero cualquier insert manual a esas tablas sin `motel_id` caería en
  Casa 50. Hacer siempre explícito hasta 4B.
- **`app_categorias` vacía → precios de Casa 50:** si el motel no tiene categorías,
  `getPricing` cae al fallback `MASTER_PRICING` (precios de Casa 50). `seed_motel`
  lo previene (exige ≥1 categoría con los 7 precios > 0).
- **`ANTHROPIC_API_KEY` opcional:** sin ella, Luciana falla pero la app opera.

## Baja / limpieza de un motel (ej. uno de prueba)

Borrar sus filas por `motel_id` en orden inverso a las FKs (hijos antes que
`app_moteles`) y al final su fila en `app_moteles`. Patrón usado en las pruebas de
`seed_motel`:

```sql
DELETE FROM admin_pins       WHERE motel_id = '<id>';
DELETE FROM reception_pins   WHERE motel_id = '<id>';
DELETE FROM maintenance_pins WHERE motel_id = '<id>';
DELETE FROM settings         WHERE motel_id = '<id>';
DELETE FROM rooms            WHERE motel_id = '<id>';
DELETE FROM app_categorias   WHERE motel_id = '<id>';
DELETE FROM motel_info       WHERE motel_id = '<id>';
-- (+ tablas operativas si ya hubo movimiento: sales, bar_sales, shift_*, etc.)
DELETE FROM app_moteles      WHERE id       = '<id>';
```
