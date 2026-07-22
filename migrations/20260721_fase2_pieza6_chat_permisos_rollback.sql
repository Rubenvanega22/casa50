-- ROLLBACK Pieza 6 (chat + permisos + comunicados).
-- Nota: el bucket 'permisos' NO se borra aqui (puede tener archivos de soporte);
-- vaciarlo y eliminarlo a mano desde Storage si de verdad se quiere revertir.
drop table if exists public.staff_mensajes;
drop table if exists public.staff_permisos;
drop table if exists public.staff_comunicados;
