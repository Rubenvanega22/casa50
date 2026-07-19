-- FASE 2 · PIEZA 1b — recargos verificados + corte nocturno + seed festivos
-- (el corte de hora nocturna 19:00 NO estaba en 1a; se agrega aqui como columna)

-- Corte de franja nocturna (configurable por motel)
alter table public.motel_config
  add column if not exists recargo_nocturno_desde time default '19:00',
  add column if not exists recargo_nocturno_hasta time default '06:00';

-- Recargos verificados de Casa 50 + corte 19:00
update public.motel_config set
  recargo_nocturno_pct = 35,
  recargo_dominical_pct = 90,
  recargo_festivo_pct = 90,
  recargo_nocturno_desde = '19:00',
  recargo_nocturno_hasta = '06:00',
  updated_at = now()
where motel_id = '24992a8a-48d8-4444-a50f-2d6c7d949828';

-- Seed festivos Colombia 2026/2027 (Ley Emiliani; sin Virgen de Chiquinquira)
insert into public.festivos (motel_id, fecha, nombre) values
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-01-01','Ano Nuevo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-01-12','Reyes Magos'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-03-23','San Jose'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-04-02','Jueves Santo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-04-03','Viernes Santo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-05-01','Dia del Trabajo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-05-18','Ascension del Senor'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-06-08','Corpus Christi'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-06-15','Sagrado Corazon'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-06-29','San Pedro y San Pablo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-07-20','Independencia'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-08-07','Batalla de Boyaca'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-08-17','Asuncion de la Virgen'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-10-12','Dia de la Raza'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-11-02','Todos los Santos'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-11-16','Independencia de Cartagena'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-12-08','Inmaculada Concepcion'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2026-12-25','Navidad'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-01-01','Ano Nuevo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-01-11','Reyes Magos'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-03-22','San Jose'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-03-25','Jueves Santo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-03-26','Viernes Santo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-05-01','Dia del Trabajo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-05-10','Ascension del Senor'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-05-31','Corpus Christi'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-06-07','Sagrado Corazon'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-07-05','San Pedro y San Pablo'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-07-20','Independencia'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-08-07','Batalla de Boyaca'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-08-16','Asuncion de la Virgen'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-10-18','Dia de la Raza'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-11-01','Todos los Santos'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-11-15','Independencia de Cartagena'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-12-08','Inmaculada Concepcion'),
  ('24992a8a-48d8-4444-a50f-2d6c7d949828','2027-12-25','Navidad')
on conflict (motel_id, fecha) do nothing;

-- rollback:
--   delete from public.festivos where motel_id='24992a8a-48d8-4444-a50f-2d6c7d949828';
--   update public.motel_config set recargo_nocturno_pct=0, recargo_dominical_pct=0, recargo_festivo_pct=0 where motel_id='24992a8a-48d8-4444-a50f-2d6c7d949828';
--   alter table public.motel_config drop column if exists recargo_nocturno_desde, drop column if exists recargo_nocturno_hasta;
