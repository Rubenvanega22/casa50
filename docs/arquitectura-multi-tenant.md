# MotelSysPro — Diseño de Arquitectura SaaS Multi-Tenant

**Versión 1.0 — borrador para iterar**
**Fecha:** 24 de junio de 2026
**Autor del sistema:** Rubén · **Co-diseño:** Claude (arquitecto/auditor)
**Cambios v1.0:** + sección 1.ter (ventaja competitiva central: motor de reservas autónomo, sin depender de recepción — el diferenciador clave y producto premium).
**Cambios v0.9:** + sección 1.bis (visión de portafolio "familia SysPro").

---

## 0. Cómo usar este documento

Este es un **borrador vivo**. La idea no es que esté perfecto hoy, sino que sea el plano sobre el que decidimos juntos antes de tocar una línea de código, para no repetir trabajo.

Cada punto está etiquetado:

- **[DECISIÓN TOMADA]** — ya lo definimos y lo damos por cerrado (lo podemos reabrir si hace falta).
- **[PENDIENTE]** — necesita tu definición antes de avanzar.
- **[VERIFICAR]** — es técnicamente viable pero hay que confirmar el detalle exacto cuando lleguemos a esa pieza (límites, APIs, costos reales).

Regla de oro del proyecto: **nada se construye sin estar primero en este plano y aprobado por vos.**

---

## 1. Objetivo y visión

Convertir el sistema que hoy corre en Casa 50 en un **producto SaaS vendible a nivel nacional** a otros moteles de Colombia.

Lo que tiene que pasar, en tus palabras:

1. El sistema completo (mismas funciones que Casa 50) se le entrega a otro motel como un **enlace**.
2. Ese motel **arranca en cero**: sin ninguna información de Casa 50. Llena lo suyo desde Configuración (categorías, habitaciones, precios, datos, fotos).
3. La información de cada motel está **100% separada**. La de Casa 50 nunca se mezcla con la de otro motel, ni al revés.
4. Vos tenés una **plataforma de superadmin** por encima de todo, donde:
   - Monitoreás cada motel por separado (incluido entrar a diagnosticar uno puntual si tiene un problema).
   - Ves cuándo se le vence la suscripción a cada uno.
   - Ves cuánto te cuesta la infraestructura (Vercel, Supabase, etc.) para saber tu margen.

Mercado objetivo (de sesiones previas): ~5.000–7.000 moteles en Colombia, ~50.000 en LatAm.

---

## 1.ter Ventaja competitiva central: el motor de reservas autónomo **[DIFERENCIADOR CLAVE]**

El diferenciador más fuerte de SysPro frente a la competencia: **el motor de reservas funciona solo, sin depender de una persona.**

**El problema que resuelve:** la mayoría de los moteles en Colombia reservan por WhatsApp o teléfono → dependen de que haya alguien en recepción. Eso significa: reservas perdidas cuando hay mucho movimiento, nadie que conteste de madrugada (horario fuerte del negocio), errores humanos, sobreventas, y —clave— el cliente tiene que exponerse a hablar con alguien.

**Lo que ofrece SysPro:** el cliente reserva solo, paga solo (Wompi), y la habitación queda lista/activada automáticamente — cero intervención humana. Esto lo tienen los grandes PMS de hotel, pero **casi ningún sistema de motel en Colombia** lo ofrece integrado y pensado para el modelo por horas.

**Por qué vende:**
- **Discreción = oro en este negocio.** "Reservá sin hablar con nadie, pagá desde el celular, llegá y entrá" es un beneficio enorme para el cliente final → más ocupación para el motel.
- **Es el producto premium:** corresponde al "Plan Sistema + Reservas" (sección 9.2). El motor de reservas no es solo un diferenciador, es el upsell que se vende más caro.
- **Argumento de venta al motel:** "te traigo clientes nuevos que hoy no llegan" (los que planifican y los que buscan discreción), sin reemplazar el walk-in tradicional. Suma ocupación, no cambia toda la operación.

**Realidad a tener presente:**
- El motor depende de **Wompi**, hoy bloqueado del lado de Wompi (cuenta en revisión). El diferenciador estrella no está 100% operativo hasta destrabarlo → razón de peso para resolver Wompi.
- El motor **suma** ocupación (capta al que reserva), no reemplaza al cliente que llega sin reserva.

---

## 1.bis Visión de portafolio: la familia SysPro **[DECISIÓN TOMADA — visión de empresa, NO se construye ahora]**

La empresa es **SysPro**. El sistema actual no está limitado solo a moteles: como precios, horas y categorías son configurables, el mismo motor sirve de base para otros sectores de alojamiento. La estrategia es tener una **familia de productos hermanos**, todos derivados de la misma base de código:

- **MotelSysPro** — moteles (el producto actual; cobro por HORA). ← foco hoy.
- **HotelSysPro** — hoteles (cobro por NOCHE, registro de huéspedes, reservas multi-noche, channel manager).
- **(futuro) AmobladoSysPro / StaySysPro** — apartamentos amoblados (por noche/mes, más simple que hotel).

**Cómo se hace (cuando llegue el momento):** se **replica** la base de código y se le adapta lo que cambia por sector — principalmente la **unidad de cobro** (horas → noches), más lo propio de cada uno. Se reutiliza el 70-80%: gestión de habitaciones, cuadre, turnos, panel admin, superadmin, multi-tenant. Cada producto queda limpio para su nicho.

**Por qué un producto hermano y NO todo dentro de MotelSys:** meter hoteles dentro de MotelSys lo complicaría y ensuciaría para ambos públicos. Productos separados con base común = cada uno hecho para su cliente, y un solo motor que mantener.

**⚠️ Orden (decisión firme de Rubén):** esto es la **visión de crecimiento**, NO se construye ahora. Primero se termina y se vende MotelSysPro (moteles). Recién cuando (a) la base esté madura — idealmente después de la Fase 3, multi-tenant sólido — y (b) haya moteles pagando, se deriva el segundo producto. Derivar antes = dos productos a medio hacer y ninguno vendiendo (la trampa que Rubén mismo identificó: "si esperamos a terminar dos cosas, nunca terminamos"). El momento correcto de derivar es con la base probada, para que el "hijo" nazca sano.

**Riesgo a vigilar:** la tentación de arrancar HotelSysPro antes de tiempo. Es el mayor riesgo para que MotelSysPro llegue a venderse.

---

## 2. Principios de diseño (cómo lo hace la industria)

Antes de decidir nada, el criterio: **copiar lo que ya funciona en los SaaS exitosos**, no inventar.

Los productos que se venden por suscripción a muchos clientes (Shopify, Slack, Notion, y los PMS hoteleros como Cloudbeds) comparten el mismo patrón base:

- **Una sola base de datos compartida**, donde cada fila lleva un identificador del cliente (en tu caso, `motel_id`).
- **Una barrera de seguridad a nivel de la base** (RLS — Row Level Security) que garantiza que un cliente nunca pueda ver los datos de otro, aunque el código tenga un error.
- **Un panel de administración central** desde donde la empresa (vos) ve y gestiona todos los clientes juntos.
- **Onboarding self-service o semi-asistido**: dar de alta un cliente nuevo es rápido y no requiere montar infraestructura nueva.

Las bases de datos separadas por cliente existen, pero se reservan para casos premium (bancos, salud) que pagan mucho y exigen aislamiento físico por ley. **No es tu caso.**

---

## 3. Decisión central: una base compartida + RLS **[DECISIÓN TOMADA]**

**Decisión: una sola base de datos compartida, con `motel_id` en todas las tablas + RLS para aislar.**

Comparación que respalda la decisión:

| Criterio | Base compartida (`motel_id`) ✅ | Base separada por motel |
|---|---|---|
| Tu panel de monitoreo | Fácil — una sola consulta ve a todos | Difícil — conectarse a N bases distintas |
| Costo con 30 moteles | Una base que escala | ~30 proyectos = ~30 costos |
| Mantener / actualizar | Una vez, todos lo reciben | N veces, una por base |
| Onboarding motel nuevo | Insertar filas (instantáneo) | Crear y configurar una base entera |
| Aislamiento de datos | Por código **+ RLS** (barrera en la base) | Físico (más fuerte, pero innecesario acá) |
| Diagnóstico de un motel puntual | Filtrar por `motel_id` desde tu panel | Entrar a la base de ese motel |
| Quién lo usa | Shopify, Slack, Notion, Cloudbeds | Bancos, salud (premium) |

**Por qué es la correcta para vos:** es lo más barato (clave para tu margen), lo más mantenible por una sola persona, lo que hace tu panel de monitoreo posible y simple, y es la dirección en la que ya venías (las tablas nuevas — `app_categorias`, `motel_info`, `app_fotos` — ya tienen `motel_id`).

**El costo de esta decisión** (para tenerlo presente): el aislamiento depende de RLS bien aplicado. Es la pieza que hay que hacer con disciplina. Está cubierto en la sección 6.

---

## 4. Las dos capas del producto

Conviene no mezclarlas, porque son trabajos distintos:

### Capa 1 — La app del motel (multi-tenant)
El sistema que usa cada motel. Mismo código para todos; lo que cambia es el `motel_id` de quien entra. Cada motel ve solo lo suyo. **Es la base de todo y va primero.**

### Capa 2 — Tu panel de superadmin
Una vista separada, solo para vos, que se para por encima de todos los moteles: lista de moteles, suscripciones, costos, soporte. **Se construye una vez que la Capa 1 está sólida y aislada.**

### La app de reservas: producto separado y opcional
Importante para el modelo de negocio: el sistema tiene **dos aplicaciones distintas**, en **dos repositorios separados**, que comparten la misma base de datos:
- **El programa (`casa50`)** — el PMS interno (habitaciones, ventas, cuadre, turnos, config). Es el producto base.
- **La app de reservas (`casa50-reservas`)** — reservas online del cliente final, Wompi, countdown, etc. Es un producto **opcional, separado, NO atado a la venta del programa.**

Hay moteles que van a querer **solo el programa** y otros que van a querer **programa + app de reservas**. Por eso:
- Se venden como **dos planes** distintos (ver 9.2).
- La app de reservas es, en la práctica, un **feature/módulo activable por motel** (ver 7.bis): un motel que contrata "Sistema solo" no tiene la app de reservas activa; uno que contrata "Sistema + Reservas" tiene **las dos apps** apuntando a su `motel_id`.
- Técnicamente: activar la app de reservas a un motel = darle acceso a la segunda app (no es solo un toggle dentro del programa, porque es otra aplicación). Ambas leen el mismo `motel_id` y la misma config (precios desde `app_categorias`, etc.).

**[PENDIENTE técnico]** Conectar `casa50-reservas` a `app_categorias` para que lea los mismos precios que el programa (hoy aún no está conectada). Es parte de "Aparte (app de reservas)" en el checklist.

---

## 5. Modelo de datos multi-tenant

### 5.1 Estado actual (qué ya tiene `motel_id` y qué falta)

| Tabla | ¿Tiene `motel_id` hoy? | Acción |
|---|---|---|
| `app_categorias` | ✅ Sí | OK |
| `motel_info` | ✅ Sí (es la PK) | OK |
| `app_fotos` | ✅ Sí | OK |
| `app_moteles` | ✅ Sí (es el catálogo de moteles) | OK |
| `app_motel_admins` | ✅ Sí | OK |
| `rooms` | ❌ No | **Agregar `motel_id`** |
| `sales` | ❌ No | **Agregar `motel_id`** |
| `room_products` | ❌ No | **Agregar `motel_id`** |
| `settings` | ❌ No (K-V global) | **Agregar `motel_id`** o rediseñar |
| `maid_log`, `maintenance`, `room_issues`, `state_history`, `taxi_expenses`, `shift_close`, etc. | ❌ No | **Agregar `motel_id`** |

**[VERIFICAR]** La lista exacta de tablas y su volumen hay que relevarla tabla por tabla antes de migrar. Las grandes (`sales` ~8.200 filas, `room_products` ~5.200) requieren una migración cuidada (sembrar el `motel_id` de Casa 50 en todo el histórico existente).

### 5.2 El catálogo de moteles

`app_moteles` es la tabla raíz: una fila por motel (id, nombre, estado, fecha de alta, plan/suscripción). Todo lo demás cuelga de ahí por `motel_id`.

### 5.3 Regla de oro del modelo

A partir de ahora, **toda tabla nueva nace con `motel_id`**. Sin excepción. Y toda consulta filtra por `motel_id`. RLS lo hace obligatorio (sección 6).

---

## 6. Aislamiento y seguridad (RLS) **[DECISIÓN TOMADA — implementación PENDIENTE]**

RLS (Row Level Security) es la barrera que hace que el "que no se mezclen los datos" sea de verdad, no solo una promesa del código.

**Cómo funciona, en simple:** se le declara a la base de datos una regla del tipo "una sesión solo puede ver/tocar las filas cuyo `motel_id` coincide con el motel al que pertenece esa sesión". A partir de ahí, aunque el código se olvide de filtrar, la base **no entrega** filas de otro motel. Es el cinturón de seguridad.

**Lo que hay que definir e implementar:**
- Cómo viaja el `motel_id` de la sesión hasta la base (vía el token de autenticación del usuario).
- Las políticas RLS por tabla (select / insert / update / delete).
- **[VERIFICAR]** Hoy el backend usa `service_role` (que saltea RLS) para varias operaciones. Hay que revisar cuáles deben seguir con `service_role` (operaciones de admin controladas) y cuáles deben pasar a respetar RLS. Esto es delicado y se diseña aparte.

**Riesgo si no se hace:** sin RLS, un solo bug de filtrado expone datos de un motel a otro. Para un producto que se vende, eso es inaceptable. **RLS no es opcional.**

---

## 7. El desbloqueo técnico: `getPricing` y categorías arbitrarias **[PENDIENTE de relevar a fondo]**

Este es el **cuello de botella técnico real** para que un motel nuevo arranque en cero.

**El problema:** hoy el motor de precios (`getPricing`) descarta cualquier categoría que no esté en una constante hardcodeada con las 5 categorías de Casa 50 (Junior, Suite Jacuzzi, etc.). Un motel nuevo que quiera crear "Suite Romántica" o como llame a sus cuartos, **no podría** — el sistema la ignoraría y cobraría mal.

**Lo que hay que hacer:** refactorizar `getPricing` para que:
- Lea las categorías **de la tabla** `app_categorias` por `motel_id`, sin exigir que existan en ninguna constante.
- Casa 50 siga funcionando **exactamente igual** (sus 5 categorías con sus precios actuales) — sin cambios de cobro.
- Una categoría nueva nazca **siempre con precios obligatorios** definidos al crearla, para que nunca quede en $0 o sin precio.
- La regla hardcodeada de "Suite Multiple" (la regla del finde / 6h) se vuelva configurable por motel, no atada al nombre de una categoría de Casa 50.

**Por qué es la base de todo lo vendible:** sin este refactor, "crear categorías" y "crear habitaciones" para otro motel no funcionan de verdad. Es el primer ladrillo técnico.

**[PENDIENTE]** Falta el relevamiento puntual de este refactor (qué cambiar exactamente, cómo probar sin afectar a Casa 50). Es solo lectura, sin riesgo, y es el siguiente paso natural.

---

## 7.bis Personalización por motel: feature flags **[DECISIÓN TOMADA — principio central]**

Cada motel es distinto. Algunos van a querer funciones que otros no necesitan (ej. las "ventanas ocultas" que usa Casa 50 pero otro motel quizá no). Hay que poder **personalizar un motel sin afectar a los demás** — y a la vez poder **actualizar a todos de una** cuando sacás una mejora general.

**La regla de oro de la industria: un solo código para todos; lo que cambia por motel son DATOS, no código.**

Tres mecanismos:

1. **Feature flags (interruptores por motel).** Cada función que puede prenderse/apagarse es un flag guardado por `motel_id` (ej. en `settings` con `motel_id`, o en `app_moteles`). Mismo código para todos; Casa 50 tiene `ventanas_ocultas = ON`, otro motel `OFF`. Apagar/prender una función a un motel = cambiar un dato, no tocar código.
2. **Configuración por motel** (precios, categorías, habitaciones, datos) — ya en marcha. El motel se personaliza llenando su config, no modificando el programa.
3. **Módulos/planes.** Funciones agrupadas en paquetes (ej. "módulo reservas") activados según lo que el motel pagó. Es un feature flag a nivel de paquete — conecta con los planes de la sección 9.2.

**Las dos capacidades que pediste, resueltas:**
- **Actualización general:** mejorás el código una vez → llega a todos (porque es un solo código).
- **Personalización individual:** prendés/apagás flags por `motel_id` → solo ese motel cambia.

**El límite honesto:** los feature flags cubren personalizaciones **previstas** (funciones que vos construiste como opcionales). Si un motel pide algo **único que nadie más usará**, se decide caso por caso: o se construye como función opcional con su flag (por si otro la quiere después), o se declina. **Lo que NO se hace es código a medida por cliente** — con 20 moteles serían 20 versiones imposibles de mantener por una persona, y cada bug habría que arreglarlo 20 veces. Esa es la trampa que hunde SaaS. Un solo código + flags = mantenible por vos solo.

**[PENDIENTE menor]** Inventariar qué funciones actuales deberían ser flags opcionales (ej. ventanas ocultas, multi-camarera ya es un toggle, regla del finde, etc.). Se hace cuando lleguemos a la Fase 5.

---

## 8. Onboarding: cómo entra un motel nuevo en cero **[DECISIÓN TOMADA — Opción A asistida]**

Flujo definido: **alta asistida por Rubén + acompañamiento del equipo de ventas.**

1. **Rubén registra el motel** desde el panel de superadmin (nombre + datos de contacto + plan).
2. El sistema genera el `motel_id` y siembra lo mínimo: una fila en `app_moteles`, `motel_info` vacío, un usuario admin inicial con su credencial/PIN.
3. Se le pasa el **enlace + credencial** al motel.
4. El motel entra y ve su sistema **vacío**, y carga su información (categorías, habitaciones, precios, datos, fotos) desde Configuración.
5. **Los colaboradores de venta acompañan al cliente** en esa carga inicial: le indican qué hacer, en qué orden, y cómo funciona el sistema.

**Implicancia de diseño (importante):** como el alta la hace el cliente *con guía humana*, el sistema debe ser **autoexplicativo y guiado**:
- Textos de ayuda claros en cada sección de Configuración (ya empezamos con esto en "Datos del motel").
- Un **orden sugerido de carga** ("primero categorías → después habitaciones → después precios → después fotos"), idealmente con un checklist o asistente de primeros pasos que tus colaboradores puedan seguir con el cliente.
- Que ningún paso requiera conocimiento técnico (ni del cliente ni del colaborador).

**Opción B — Auto-registro (futuro):** el motel se registra solo desde una landing y paga automáticamente. Más escalable, se evalúa cuando haya volumen. Por ahora **no**.

**[PENDIENTE menor]** Definir el checklist exacto de "primeros pasos" del onboarding (qué carga el cliente y en qué orden) — se define cuando estén listas las piezas de Configuración (Fases 1-2).

### 8.1 Cómo se genera el acceso de cada motel **[DECISIÓN TOMADA]**

**Clave:** el enlace del programa es **el mismo para todos los moteles**. NO se genera una app distinta por cliente. Es **una sola aplicación**; lo que separa a un motel de otro es la **credencial con la que entra**, atada a su `motel_id` (modelo Gmail: todos entran por el mismo enlace, cada uno ve solo lo suyo).

Cuando Rubén da de alta un motel desde el superadmin, se crea su `motel_id` + su credencial de acceso. Según el plan contratado:

**Cliente "Solo Sistema":**
- Acceso al **programa** (enlace común) con su credencial → ve su motel vacío para configurar.
- App de reservas **apagada** (no contrató ese módulo).

**Cliente "Paquete completo" (Sistema + Reservas):**
- Mismo acceso al programa, **+** app de reservas activada.
- Las dos apps (programa + reservas) apuntan al mismo `motel_id`.

**Resumen:** dos enlaces fijos e iguales para todos (programa + app de reservas). El superadmin define a qué tiene acceso cada motel (solo programa, o programa + reservas) y le entrega su credencial. No hay un enlace nuevo por motel.

**[DECISIÓN TOMADA]** Tipo de acceso del motel — **dos niveles**:
- **Nivel 1 — Cuenta del motel (correo + contraseña):** se crea al dar de alta el motel desde el superadmin. Es la cuenta "dueña" / administrador del motel: entra la primera vez, configura el sistema y lo administra.
- **Nivel 2 — Usuarios internos (PIN):** una vez instalado en el motel, su personal del día a día entra con **PIN** + rol, igual que Casa 50 (recepcionistas, admin, mantenimiento, camareras). Lo gestiona el propio motel desde adentro (pieza Usuarios/PINs ya existente).

Resumen: correo+clave para la cuenta del motel; PIN para los usuarios operativos internos. Conviven, cada uno en su nivel.

---

## 9. Panel de superadmin (tu plataforma)

### 9.0 Estructura de acceso **[DECISIÓN TOMADA]**
El sistema tiene **TRES enlaces/accesos separados**, independientes:
1. **El programa** (`casa50`) — lo usa cada motel para operar.
2. **La app de reservas** (`casa50-reservas`) — la usa el cliente final del motel para reservar.
3. **El panel de superadmin** — **enlace aparte y privado**, al que entran **solo Rubén y su equipo**. El motel nunca accede acá. Desde este panel se da de alta a los nuevos moteles, se hacen las suscripciones, se monitorea a todos los suscriptores, se prenden/apagan funciones por motel, y se ven los costos.

Vista separada, solo para Rubén y su equipo. Cuatro funciones, según lo pedido:

### 9.1 Monitoreo de moteles
Lista de todos los moteles con: nombre, estado (activo/suspendido), plan contratado, vencimiento de suscripción, fecha de alta, último uso. Y poder **entrar a un motel puntual** para ver su información (habitaciones, ventas, configuración). Es el tablero de control de toda la operación.

### 9.1.bis Soporte técnico con IA por motel **[DECISIÓN TOMADA — concepto]**
La duda clave: cómo hacer soporte sin equivocarse de motel.

**No es "una IA separada por motel"** como entidades distintas. Es **una sola herramienta de soporte donde primero se SELECCIONA el motel**, y a partir de ahí **todo queda filtrado por ese `motel_id`**: la IA (o el operador) solo ve los datos de ese motel, nada de los demás.

**Esa es la protección contra "equivocarse de motel":** no depende de que la IA "se acuerde" de no mezclar — es que técnicamente **solo se carga el contexto del motel seleccionado**. Modelo: "revisemos el motel X" → se entra a X → la herramienta trabaja encerrada en los datos de X (mismo principio que el aislamiento por `motel_id` + RLS de la sección 6).

Equivale a tu idea de "cada proyecto con su info", pero en vez de una IA por proyecto: **un contexto por motel** (misma herramienta, datos aislados según a cuál entrás). Más simple de mantener y más seguro.

### 9.1.ter Equipo de trabajo y asignación de moteles **[DECISIÓN TOMADA]**
El superadmin soporta **un equipo**, no solo a Rubén:
- Cada miembro del equipo tiene su usuario y rol en el superadmin.
- Se le **asigna un grupo de moteles** (ej. 50 por persona) → cada uno ve/atiende solo los suyos.
- Rubén (dueño) ve **todos**.

Así se divide la carga de soporte y gestión a medida que crece la cantidad de moteles.

### 9.1.quater Escalabilidad (cuántos moteles) **[informativo]**
El panel **no impone un límite** de moteles — la arquitectura de base compartida escala a miles. El límite real **no viene del superadmin**, viene de la **infraestructura** (plan de Supabase/Vercel), que se escala según se crece. Lo que aumenta con cada motel es el costo de infraestructura — que se monitorea en el mismo panel (9.4).

### 9.2 Suscripciones y vencimientos
Por cada motel: plan contratado, fecha de vencimiento, estado de pago. Alerta cuando se acerca un vencimiento.

**Modelo de planes [DECISIÓN TOMADA — montos PENDIENTE]:** dos modalidades de producto:
- **Plan Sistema** — solo el PMS interno (gestión de habitaciones, ventas, cuadre, turnos, configuración).
- **Plan Sistema + Reservas** — todo lo anterior **más la app de reservas del cliente** (`casa50-reservas`: reservas online, Wompi, countdown, etc.).

La app de reservas es el upsell natural. Los **montos están sin definir** — Rubén los decide más adelante, idealmente cuando el panel de costos (9.4) le dé el costo real por motel para calcular margen.

### 9.3 Soporte técnico por motel
Poder aislar un motel y revisar su estado: sus habitaciones, sus ventas, sus errores, su configuración — sin tocar a los demás. Esto **depende del aislamiento por `motel_id` bien hecho** (secciones 5 y 6). Es una de las razones de peso para la base compartida: desde un solo lugar ves a todos y entrás a cualquiera.

### 9.4 Monitoreo de costos de infraestructura **[VERIFICAR — es la pieza más incierta]**
Querés ver cuánto gastás en Vercel, Supabase, GitHub, etc.

**La verdad técnica:** esos costos **no están en tu base de datos** — viven en las cuentas de cada proveedor. Hay dos caminos:

- **Automático:** conectarse a la API de facturación de cada proveedor (Vercel, Supabase, GitHub) y traer el gasto. **[VERIFICAR]** No todos los proveedores exponen una API de facturación usable; hay que confirmarlo uno por uno cuando lleguemos. Es una integración aparte, con su propia complejidad.
- **Manual + proxies (simple y confiable):** vos cargás la factura mensual de cada proveedor en el panel (un número por mes), y el sistema lo cruza contra la cantidad de moteles y el consumo que **sí** podés medir desde tu base (ej. cuánto storage de fotos usa cada motel, cuántas ventas, etc.). Así sabés tu costo por motel y tu margen, sin depender de APIs externas.

**Recomendación:** empezar con el camino manual + proxies (te da el margen real ya), y evaluar la automatización después. **Nota honesta:** GitHub probablemente te cueste ~$0 (repos privados son gratis hasta cierto punto); los costos reales son Vercel y Supabase.

### 9.5 Funciones adicionales del superadmin (investigación de la industria) **[PROPUESTAS — para decidir]**
Tras revisar cómo arman el back-office los SaaS multi-tenant parecidos (PMS, boilerplates, plataformas con super admin), estas funciones son estándar y conviene incluirlas para que el panel quede completo:

1. **"Entrar como el motel" (impersonation) — alta prioridad para soporte.** No solo ver los datos de un motel, sino entrar y ver **exactamente su pantalla**, como si fueras su admin, quedando registrado que fue soporte. Es el patrón estándar de soporte multi-tenant. Mejora directamente la visión de "revisemos el motel X que tiene un problema".
2. **Registro de auditoría (trazabilidad) — alta prioridad.** Grabar quién hizo qué y cuándo, en el superadmin y dentro de cada motel. Esencial en un sistema que maneja plata: si algo sale mal, sabés quién lo tocó. Protege a Rubén y a su equipo.
3. **Doble factor (2FA) en el superadmin — seguridad obligatoria.** El superadmin es la llave maestra de TODOS los moteles. Debe tener 2FA. (Los moteles individuales pueden no necesitarlo; el superadmin sí.)
4. **Roles dentro del equipo (RBAC) — además de asignar moteles.** Definir qué puede hacer cada miembro: ej. un soporte que ve/diagnostica pero NO cancela suscripciones ni cobra. Roles tipo Dueño / Admin / Soporte / Solo-lectura.
5. **Ciclo de vida del motel + facturación.** Estados más finos que activo/suspendido: **prueba → activo → en mora → suspendido → cancelado**, con historial de facturas por motel. Ordena el cobro y la gestión.
6. **Métricas del negocio (no solo costos).** Salud del negocio: ingresos recurrentes mensuales (MRR), altas de moteles por mes, bajas/cancelaciones (churn). Para saber si se crece o se estanca.
7. **Centro de alertas.** Avisos automáticos: vencimientos próximos, motel que dejó de usarse (posible cancelación), errores. Que no se pase nada.

**[PENDIENTE]** Rubén prioriza cuáles entran en la primera versión del superadmin (Fase 5) y cuáles quedan para después. Sugerencia: 1, 2 y 3 son las de mayor valor/seguridad y conviene que estén desde el inicio.

---

## 10. Cobro de suscripción **[PENDIENTE]**

Opciones:
- **Manual al principio (recomendado):** vos activás/suspendés cada motel desde el panel según el pago. Simple, control total, cero dependencia de pasarela.
- **Wompi recurrente (para escalar):** suscripción automática con bloqueo por mora. Requiere la cuenta Wompi de producción activa (hoy bloqueada del lado de Wompi) y la integración de suscripciones.

**Recomendación:** manual hasta tener ~5-10 moteles; automatizar con Wompi cuando el volumen lo justifique.

---

**[DECISIÓN TOMADA — orden de trabajo acordado por Rubén]**

**Razonamiento estratégico (de Rubén):** el programa y la app de reservas nunca van a estar 100% "terminados" — siempre habrá cosas que cambiar o mejorar. Si se espera a que esas dos estén perfectas, no se vende nunca. El superadmin, en cambio, SÍ tiene un punto claro de "listo" (cuando permite dar de alta, cobrar y dar soporte). Una vez ahí, se puede **empezar a vender y mejorar en el camino** el programa y las reservas. Es la mentalidad correcta de salida al mercado: vender con una base sólida + iterar, en vez de perseguir la perfección.

Prioridad de ejecución:
1. **Superadmin completo y probado primero** — es la base de toda la empresa (sin esto no se da de alta ni se gestiona ningún motel).
2. **Después:** terminar lo que falta de la app de reservas y de Casa 50.
3. **Por último:** arrancar la venta.
4. **En paralelo desde ya:** parte legal (empresa, cámara de comercio) + página web profesional + redes de promoción.

**⚠️ Dependencia técnica importante:** el superadmin se apoya en el aislamiento por `motel_id` + RLS (Fase 3). Para que sea seguro (que un motel no vea a otro, que "entrar como motel" funcione), ese aislamiento debe estar. Por eso **"dejar listo el superadmin" en la práctica incluye hacer la Fase 3** (poner `motel_id` en todas las tablas + RLS) como su base. Y la Fase 3 a su vez se apoya en que la config por motel (Fases 1-2) esté encaminada. En resumen: el orden de negocio que pide Rubén (superadmin primero) arrastra hacer Fases 1→2→3 como cimiento técnico de ese superadmin. No es contradicción — es el orden natural; solo hay que tenerlo presente para no subestimar el alcance de "superadmin".

---

## 11. Roadmap por fases (orden de construcción)

Orden pensado para que cada pieza se apoye en la anterior y **no haya que rehacer**:

**Fase 0 — Diseño (esto).** Cerrar este documento. Sin código.

**Fase 1 — El desbloqueo de precios.** Refactor de `getPricing` para soportar categorías arbitrarias por motel, sin afectar a Casa 50. *(Sección 7. Es el primer ladrillo técnico.)*

**Fase 2 — CRUD de configuración por motel.**
- Categorías (crear/editar/baja lógica) — ahora sí posible, apoyado en Fase 1.
- Habitaciones (alta + editar piso/categoría + baja lógica; **número inmutable**).
- *Recordatorio del relevamiento: el número de habitación es la clave de ~13.500 registros históricos sin red de seguridad. Por eso es inmutable.*

**Fase 3 — Aislamiento total (`motel_id` + RLS).** Agregar `motel_id` a todas las tablas que faltan, sembrar el de Casa 50 en el histórico, activar RLS. *(Secciones 5 y 6. Es la pieza más delicada de toda la migración. Es el cimiento de seguridad del superadmin.)*

**Fase 4 — Onboarding.** Alta de motel nuevo en cero (Opción A). *(Sección 8.)*

**Fase 5 — Panel de superadmin.** Monitoreo, suscripciones, soporte por motel ("entrar como"), auditoría, 2FA, roles de equipo, costos. *(Sección 9. Prioridad de negocio #1, pero depende de Fases 1-3 como cimiento.)*

**Fase 6 — Cobro de suscripción.** Manual → Wompi recurrente. *(Sección 10.)*

**En paralelo / aparte:** terminar Wompi de la app de reservas (`casa50-reservas`, rama `wompi-firma` — bloqueada por llaves de producción + reconciliar rama divergida).

**En paralelo desde YA (no depende del código):** parte legal (empresa, cámara de comercio) + página web profesional + redes de promoción.

---

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Un bug de filtrado expone datos entre moteles | RLS obligatorio (sección 6) — barrera en la base, no solo en el código |
| Migrar `motel_id` al histórico rompe Casa 50 | Migración cuidada, en preview, sembrando el `motel_id` de Casa 50 en todo lo existente, verificada antes de producción |
| Cambiar el número de habitación rompe el histórico | Número inmutable (regla del relevamiento) |
| Categoría nueva queda sin precio → cobra $0/mal | Precios obligatorios al crear (Fase 1) |
| Costos de infraestructura crecen sin control | Monitoreo de costos + proxies de consumo por motel (sección 9.4) |
| Cumplimiento legal de facturas (DIAN) | **Confirmar con contador** — nosotros dejamos los campos; la validez legal la valida un profesional |
| Hacer todo cansado y meter un error caro | Las fases delicadas (3 sobre todo) se encaran frescas, paso a paso, con verificación previa |

---

## 13. Decisiones pendientes (tu input)

Estado actualizado:

1. ~~**Onboarding:**~~ ✅ **DEFINIDO** — alta asistida por Rubén + acompañamiento del equipo de ventas (sección 8).
2. **Planes y precios (9.2):** ✅ modalidad definida (Sistema / Sistema + Reservas); ⏳ **montos pendientes** — los decidís cuando tengas el costo real por motel.
3. **Cobro (sección 10):** ✅ **DEFINIDO** — manual al principio, Wompi recurrente para escalar.
4. **Costos (9.4):** ✅ **DEFINIDO** — carga manual + proxies de consumo al inicio.
5. **Orden del roadmap (sección 11):** ✅ **DEFINIDO** — orden propuesto aceptado.

**Lo único que queda abierto:** los **montos** de los dos planes (punto 2), que no corren prisa.

➡️ **Con esto, el diseño está suficientemente cerrado para empezar a construir por la Fase 1.**

---

## 13.bis Checklist: todo lo que falta para vender **[la lista de trabajo]**

Lista accionable de lo que falta para que el multi-tenant quede funcionando y vendible. Ordenada por fase. Esto es el "qué falta" concreto.

### CARRIL TÉCNICO (vos + Claude Code + auditoría)

**Fase 1 — Motor de precios para categorías arbitrarias** *(en curso)*
- [ ] Refactor `getPricing` (build-from-table + cascada + DEFAULT_CFG) — Commit 1 escrito
- [ ] Cablear los 8 call-sites a `cfgFor()` + eliminar hardcode 6h — Commit 2
- [ ] GATE: regresión no-op Casa 50 (precios idénticos + check-ins de prueba en las 5 categorías) → **probar fresco**
- [ ] Merge a main

**Fase 2 — CRUD de configuración por motel**
- [ ] **Categorías CRUD:** crear / editar nombre visible / baja lógica (`activo=false`). Exigir los 7 precios > 0 al crear (anti-$0 real). Nombre interno (`nombre_db`) inmutable.
- [ ] **Habitaciones CRUD:** alta (número único + piso + categoría + estado inicial) / editar piso y categoría / baja lógica con flag nuevo `archived`. **Número de habitación inmutable** (clave de ~13.500 registros históricos).
- [ ] Editar categoría de una habitación = la pieza que permite "reasignar" antes de dar de baja una categoría.

**Fase 3 — Aislamiento total (lo más delicado de la migración)**
- [ ] Relevar todas las tablas y agregar `motel_id` a las que faltan: `rooms`, `sales`, `room_products`, `settings`, `maid_log`, `maintenance`, `room_issues`, `state_history`, `taxi_expenses`, `shift_close`, etc.
- [ ] Sembrar el `motel_id` de Casa 50 en TODO el histórico existente (migración cuidada, en preview, verificada).
- [ ] Activar **RLS** en todas las tablas (políticas select/insert/update/delete por `motel_id`).
- [ ] Revisar dónde el backend usa `service_role` (saltea RLS) y decidir qué pasa a respetar RLS.
- [ ] Adaptar todas las consultas para filtrar por `motel_id`.

**Fase 4 — Onboarding (alta de motel nuevo en cero)**
- [ ] Endpoint/flujo para que Rubén cree un motel (fila en `app_moteles` + `motel_info` vacío + admin inicial).
- [ ] Que el motel nuevo arranque **vacío** (sin datos de Casa 50).
- [ ] Asistente de "primeros pasos" / checklist de carga guiada (para el equipo de ventas).

**Fase 5 — Panel de superadmin (tu plataforma)**
- [ ] Lista de moteles (estado, alta, último uso).
- [ ] Entrar a un motel puntual a diagnosticar (filtrado por `motel_id`).
- [ ] **Feature flags por motel** (prender/apagar funciones, como los celulares): inventariar qué funciones son opcionales (ventanas ocultas, regla finde, etc.) y construir el panel de interruptores.
- [ ] Suscripciones: plan, vencimiento, estado de pago, alertas.
- [ ] Monitoreo de costos: carga manual de facturas + proxies de consumo por motel.

**Fase 6 — Cobro de suscripción**
- [ ] Manual (activar/suspender motel desde el panel).
- [ ] Wompi recurrente (cuando haya volumen + cuenta Wompi prod activa).

**Aparte (app de reservas `casa50-reservas`)**
- [ ] Reconciliar rama `wompi-firma` (divergida) con main.
- [ ] Llaves de producción Wompi (bloqueado del lado de Wompi).
- [ ] Conectar la app de reservas a `app_categorias` (precios compartidos).
- [ ] Countdown, push, integración reservas→cuadre, DIAN vía Alegra.

**Deuda técnica detectada (menor, anotada)**
- [ ] Bug `avmCalcTotal` ($0 en "Agregar venta manual").
- [ ] Verificar UI cambiar PIN admin (`doChPin`).

### CARRIL NEGOCIO (vos + equipo de ventas — arranca YA, en paralelo)
- [ ] Crear la empresa (cámara de comercio, registro).
- [ ] Página web / landing del producto.
- [ ] Material de venta (demo usando Casa 50 como vidriera viva).
- [ ] Definir los montos de los dos planes (Sistema / Sistema + Reservas).
- [ ] Conseguir 1-2 moteles piloto comprometidos.
- [ ] Confirmar con contador los requisitos legales de factura (DIAN, régimen).

### Antes de venderle a OTRO motel (regla tuya, no negociable)
- [ ] Mínimo **30 días de QA real** con todo lo anterior funcionando.

---

## 14. Glosario

- **Multi-tenant / multi-inquilino:** muchos clientes (moteles) compartiendo el mismo sistema, con datos separados.
- **`motel_id`:** el identificador que etiqueta cada fila como perteneciente a un motel específico. Es lo que separa los datos.
- **RLS (Row Level Security):** regla a nivel de la base de datos que impide que un motel acceda a filas de otro, aunque el código falle.
- **`service_role`:** una credencial del servidor que saltea RLS. Se usa para operaciones de admin controladas; hay que revisar dónde se usa.
- **Onboarding:** el proceso de dar de alta un cliente nuevo.
- **Superadmin:** vos — el dueño de la plataforma, que ve y gestiona todos los moteles.

---

*Documento de trabajo. Próximo paso sugerido: revisar juntos, vos definís los [PENDIENTE], y arrancamos por la Fase 1 (relevamiento del refactor de `getPricing`).*
