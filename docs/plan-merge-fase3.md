# Plan de merge ordenado — `feat/fase3-motel-id` → `main`

Estado al aprobar (26-jun-2026): `feat` 33 commits adelante de `main`; `main` NO
divergió → merge limpio sin conflictos. La BD tiene las 51 columnas `motel_id`
NOT NULL **con el default Casa 50 restaurado** (Lote 12 / DROP DEFAULT **NO**
aplicado tras el rollback del incidente). Ese es el estado seguro para mergear.

Casa 50 `motel_id` = `24992a8a-48d8-4444-a50f-2d6c7d949828`.
Supabase project_id = `fojffyncxrrxevavshod`.

## Principio rector
Desplegar el helper a producción **con el default todavía puesto**. Durante todo
el merge+deploy el default es la red de seguridad: aunque algún insert se
escapara, no falla. El `DROP DEFAULT` se hace **al final**, recién cuando
producción ya corre el helper. Esto evita repetir el incidente del 26-jun (se
había aplicado DROP DEFAULT con `main` sin helper → producción dejó de insertar).

## Decisiones tomadas
- **Deploy (Fase 1–2) en horario de baja ocupación.**
- **Dejar ~24 h** entre la validación en producción (Fase 3) y el hardening (Fase 4).
- El merge real lo dispara Rubén; Vercel lo verifica Rubén (Claude no tiene acceso).

## Fase 0 — Preparación (HECHA)
- Commiteado el backfill `migrations/20260626_fix_backfill_traslados_sin_auditar.sql`.
- Rama `feat` limpia, `node --check` OK.
- Plan guardado en este archivo.
- No se toca ninguna otra rama: `wompi-firma`, `wip-inventario-columna-G`,
  `feat/aviso-turno-login`, `feat/admin-lisset-sin-luciana`.

## Fase 1 — Merge a `main` (git; sin cambios en BD)
1. `git checkout main` → `git pull` → `git merge --no-ff feat/fase3-motel-id`.
2. Sin divergencia → no se esperan conflictos.
3. `node --check api/index.js` sobre `main` mergeado → `git push origin main`.
- La BD queda igual (default puesto). Gate: push OK.

## Fase 2 — Deploy a producción (Vercel, Rubén)
1. Vercel despliega `main`; verificar build verde.
2. Confirmar env `MOTEL_ID` = Casa 50 en el proyecto de producción (si falta, el
   código cae al mismo valor por default → seguro igual, pero conviene setearlo).
- Gate: deploy verde.

## Fase 3 — Validación en producción con el helper activo (default aún de respaldo)
Probar en prod (riesgo casi nulo porque el default sigue puesto):
- Descargar Nequi · pago MIXTO · check-in · **traslado bodega→recepción**
  (confirmar que AHORA SÍ aparece la fila de auditoría) · venta de bar · cuadre.
- Dejar correr ~24 h antes de endurecer.
- Gate: todo correcto en prod.

## Fase 4 — Re-aplicar Lote 12 (DROP DEFAULT), ahora seguro
1. Re-correr la verificación previa (cruce de 3 conjuntos: TENANT_TABLES vs BD,
   tInsert ⊆ whitelist, upserts con motel_id explícito) contra `main` → limpio.
2. Aplicar `migrations/20260626_fase3_lote12_drop_default_motel_id.sql` batch por
   batch con su verificación (column_default=NULL, is_nullable=NO).
- Gate: 51 sin default, 0 residual.

## Fase 5 — Validación post-hardening + cierre
- Re-probar los mismos flujos en prod (ahora dependen del helper, no del default).
- Monitorear una ventana. Cerrar Fase 3.

## Contingencia (rollback por fase)
| Fase | Si falla | Acción |
|---|---|---|
| 1–2 | Deploy roto | `git revert -m 1 <merge>` + push → Vercel redepliega `main` viejo. BD intacta. |
| 4 | Insert falla tras DROP DEFAULT | Re-aplicar el rollback `SET DEFAULT` Casa 50 en las 51 tablas (ya probado, al pie del archivo lote12). |

## Después de Fase 3 (pendientes separados)
- RLS opcional (capa extra).
- Sub-fase PINs/settings por motel (relevamiento hecho: 12 call-sites; requiere
  PK compuesta (motel_id,key/user_name), filtrar logins por pin, ajustar
  onConflict, filtrar getSettings).
