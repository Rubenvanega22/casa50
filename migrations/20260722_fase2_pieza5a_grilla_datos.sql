-- FASE 2 · PIEZA 5a — Migracion de DATOS schedule -> grilla (1:1, ya ejecutada 2026-07-22).
-- Resultado verificado: 1098 elegibles -> 1098 insertadas, 0 sin persona, 0 duplicados,
-- diff simetrico schedule<->grilla = 0/0. estado='TRABAJO' para todas (hoy descanso =
-- ausencia de fila; sin vacaciones persistidas). area normalizada. staff_id ya backfilleado.
insert into public.grilla
  (motel_id, staff_id, person_name, fecha, shift_id, area, hora_entrada, hora_salida, estado, creado_ms)
select
  motel_id, staff_id, person_name, day_of_week::date, shift_id,
  case when lower(area) like 'camarer%'                       then 'Camareria'
       when lower(area) like 'patier%' or lower(area)='patio' then 'Patio'
       when lower(area) like 'recep%'                          then 'Recepcion'
       when lower(area) like 'manten%'                         then 'Mantenimiento'
       else area end,
  coalesce(hora_entrada,''), coalesce(hora_salida,''),
  'TRABAJO', (extract(epoch from created_at)*1000)::bigint
from public.schedule
where motel_id='24992a8a-48d8-4444-a50f-2d6c7d949828'
  and staff_id is not null
  and day_of_week ~ '^\d{4}-\d{2}-\d{2}$'
  and coalesce(type,'') not like 'extra%'
on conflict (motel_id, staff_id, fecha) do nothing;
