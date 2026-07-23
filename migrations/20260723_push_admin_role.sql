-- Push ADMIN (espejo del push del colaborador) — marcar los dispositivos del admin
-- dentro de push_subscriptions. La tabla ya nace CERRADA (RLS on, solo service_role):
-- esto es ADITIVO y no abre nada. Filas existentes quedan 'colab' por default.
--   sendPushToStaff filtra por staff_id real -> nunca toca filas admin.
--   sendPushToAdmin (fork, tanda 2)          -> filtrará por role='admin'.
alter table public.push_subscriptions
  add column if not exists role text not null default 'colab';
-- rollback: alter table public.push_subscriptions drop column if exists role;
