# casa50 — POS de recepción

Monolito: backend en `api/index.js` (Node, service key de Supabase), frontend en
`public/index.html`. Desplegado en Vercel. La app cliente de reservas vive en el repo
aparte `casa50-reservas` y comparte la misma base de datos.

## REGLA DE ORO — SEGURIDAD FIRST
El sistema debe ser lo más seguro posible. Cada feature se diseña asumiendo
que alguien intentará abusarlo.
1. Todo lo que vale plata lo escribe SOLO el servidor (service key). El
   navegador nunca tiene poder de escritura sobre ventas, precios o estados.
2. Secretos (llaves Wompi, etc.) solo server-side, jamás en el bundle de la
   app. Si un secreto se expone, se rota de inmediato.
3. Roles y permisos en tablas aparte verificadas server-side. Nunca campos
   auto-asignables por el propio usuario.
4. Claves y códigos de verificación no viajan al navegador; los rechazos son
   SECOS, sin revelar información (ni a qué habitación pertenece una clave,
   ni si un dato existe).
5. En CADA investigación de una zona nueva, revisar DE PASO las RLS, policies
   y grants de las tablas involucradas, y reportar cualquier agujero aunque
   no sea parte de la tarea (así se detectó sales/state_history abiertas a
   anon el 11jul26).
6. Antes de vender a otros moteles: revisión de seguridad completa de punta a
   punta como bloque propio.
7. TODA migración que cree una tabla debe incluir, en el MISMO archivo, su
   `REVOKE` + `ENABLE ROW LEVEL SECURITY` + policies explícitas. En este
   proyecto las tablas nuevas de `public` nacen ABIERTAS: el `pg_default_acl`
   les da INSERT/SELECT/UPDATE/DELETE a `anon` y `authenticated`. Así nacieron
   las 44 tablas expuestas. Crear una tabla sin cerrarla es abrir un agujero.
   Recordar además que RLS es por FILA, no por columna: para limitar qué
   columnas puede escribir el cliente hay que usar `GRANT UPDATE (col1, col2)`.
