# Corrección manual — refunds falsos de $25.000 (29 y 30-jun 2026)

Fecha de la corrección: **2026-06-30**. Decidida por el dueño (Rubén). Ejecutada
sobre la BD compartida (Casa 50) vía `UPDATE` puntual.

## Qué pasó

Al hacer **cambios de habitación**, la recepcionista anulaba y reingresaba la
habitación creyendo que el descuento no se reflejaba en el cuadre (el sistema
funciona bien). Eso dejó **devoluciones (REFUND) FALSAS de $25.000** que bajaban el
efectivo sin que existiera devolución física.

Ambas siguen el mismo patrón (confirmado por `state_history`):
1. Check-in con precio errado → **ANULADA**.
2. **CAMBIO_HAB** desde la 301 → genera un **REFUND −25.000** (diferencia de precio).
3. La estadía completa se **ANULA** de nuevo → se libera el cuarto.
4. Se rehace un check-in limpio de $60.000.

Al anular la estadía se anuló el SALE pero **NO el REFUND** → quedó la devolución
huérfana.

| id | fecha | turno | cuarto | total | pago | origen cambio | nota original |
|---|---|---|---|---|---|---|---|
| 8842 | 2026-06-29 16:22 | T2 | 204 | −25.000 | EFECTIVO | 301→204 | (vacía) — "error de precio" |
| 8930 | 2026-06-30 16:48 | T2 | 314 | −25.000 | EFECTIVO | 301→314 | (vacía) — **prueba de Rubén** para replicar el error |

Verificado: eran los **únicos** REFUND/negativos de esos días → no había ninguna
devolución legítima de $25.000 que tocar. **No hubo devolución física** en ninguno.

## SQL ejecutado

```sql
UPDATE sales SET anulada=true, type='ANULADA',
   note='Refund falso: artefacto de cambio de cuarto (301->204) anulado+reingresado. Correccion manual.',
   anulada_ms=(extract(epoch from now())*1000)::bigint, anulada_por='ruben'
WHERE id=8842 AND business_day='2026-06-29' AND room_id='204';

UPDATE sales SET anulada=true, type='ANULADA',
   note='Refund falso: prueba de Ruben (cambio de cuarto 301->314 anulado+reingresado). Correccion manual.',
   anulada_ms=(extract(epoch from now())*1000)::bigint, anulada_por='ruben'
WHERE id=8930 AND business_day='2026-06-30' AND room_id='314';
```

## Antes / Después (efectivo neto del día, sin anuladas, sin 304)

| Día | Antes | Después | Δ |
|---|---|---|---|
| 2026-06-29 | 2.110.000 | **2.135.000** | +25.000 |
| 2026-06-30 | 2.075.000 | **2.100.000** | +25.000 |

Cada día sube +25.000 al sacar el refund falso. Las estadías reales ($60.000 de
reingreso) quedan intactas. 0 refunds vivos en ambos días tras la corrección.

## Rollback (si hiciera falta revertir)

```sql
UPDATE sales SET anulada=false, type='REFUND', note='' WHERE id=8842;
UPDATE sales SET anulada=false, type='REFUND', note='' WHERE id=8930;
```
(Volvería a dejar el efectivo del 29 en 2.110.000 y el del 30 en 2.075.000.)
