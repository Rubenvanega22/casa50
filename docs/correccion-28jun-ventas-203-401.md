# Corrección manual — business_day 2026-06-28 · habitaciones 203 / 401

Fecha de la corrección: **2026-06-30**. Decidida por el dueño (Rubén). Ejecutada
sobre la BD compartida (Casa 50, motel_id 24992a8a-…-d7949828) vía SQL puntual.

## Qué pasó (el episodio)

La mañana del 28-jun (T1), un huésped probó **202 → 401 → 203** (cadena de cambios
de habitación) y se quedó **solo en la 203**. El sistema se colgó; el lío dejó tres
artefactos en `sales` además de la venta real:

| id | hora | cuarto | type | total | estado previo | qué era |
|---|---|---|---|---|---|---|
| 8735 | 07:26 | 203 | ANULADA | 135.000 | ya anulada ("error sistema", DIANA) | intento fumbleado |
| **8736** | 07:40 | **401** | SALE | **45.000** | **viva (huérfana)** | venta huérfana del cambio de cuarto |
| **8738** | 07:50 | 203 | REFUND | **−100.000** | viva | refund artefacto del mismo episodio |
| 8739/8740/8742/8746 | 07:55–12:42 | 203 | SALE/EXT | 140.000 | vivas (correctas) | **la venta REAL de la 203** (Junior 3h + persona + 3h extra) |

La venta real de la 203 = **140.000** en efectivo. Los artefactos 8736 (+45.000) y
8738 (−100.000) distorsionaban el efectivo.

## Decisión

**No hubo devolución física de los $100.000** (confirmado por el dueño). Por lo
tanto el refund 8738 también era un artefacto, no un movimiento real de caja.

Corrección: **anular 8736 y 8738**, dejando la 203 como única venta efectiva del
episodio. (No se usó el botón "anular" de la app porque `apiAnularVenta` exige
cuarto OCUPADO y libera la habitación; se hizo `UPDATE` puntual por id para no
tocar el estado actual de la 401.)

## SQL ejecutado

```sql
UPDATE sales SET anulada=true, type='ANULADA',
   note='Huerfana cambio de cuarto 202->401->203 (28-jun); huesped se quedo solo en 203. Correccion manual.',
   anulada_ms=(extract(epoch from now())*1000)::bigint, anulada_por='ruben'
WHERE id=8736 AND business_day='2026-06-28' AND room_id='401';

UPDATE sales SET anulada=true,
   note='Refund artefacto del mismo episodio (28-jun); sin devolucion fisica. Correccion manual.',
   anulada_ms=(extract(epoch from now())*1000)::bigint, anulada_por='ruben'
WHERE id=8738 AND business_day='2026-06-28';
```

## Antes / Después (efectivo del día 28, habitaciones, sin anuladas, sin 304)

| | Efectivo día 28 | Neto episodio 203/401 |
|---|---|---|
| **ANTES** | 2.735.000 | 85.000 ❌ |
| **DESPUÉS** | **2.790.000** | **140.000** ✔ (solo la 203) |

Verificado tras la corrección: efectivo día = 2.790.000; neto episodio = 140.000;
único cuarto vivo del episodio = 203. Las 4 vistas (Cierre/Resumen/Cuadre/Dashboard)
cuadran solas porque leen `sales` en vivo con el mismo filtro `anulada`.

## Rollback (si hiciera falta revertir la corrección)

```sql
UPDATE sales SET anulada=false, type='SALE',   note='' WHERE id=8736;
UPDATE sales SET anulada=false, type='REFUND', note='' WHERE id=8738;
```
(Volvería a dejar el efectivo del día 28 en 2.735.000 y el episodio en 85.000.)
