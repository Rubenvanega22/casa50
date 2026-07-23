// ============================================================
// CASA 50 - SPA MOTEL | API Backend v3.3
// api/index.js - Vercel Serverless (Node.js) v3.3
// Cambios v3.3:
//  - Fix T3 medianoche: solo cambia a SHIFT_1 si logout fue en madrugada
//  - Sistema liberacion de turnos: closeShift marca released=true
//  - Bloqueo login: verifica que turno anterior cerro con cuadre
//  - Admin puede forzar entrada
//  - deleteTaxi: eliminar taxi desde modal habitacion
//  - roomChange: transfiere venta original a nueva habitacion
//  - shift_failures: registro de fallas por turno
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});
const LUCIANA_MODEL = 'claude-sonnet-4-6';

// ==================== PRECIOS ====================
const MASTER_PRICING = {
  'Junior':         { h3:60000,  h6:120000, h8:85000,   h12:105000, extraHour:20000, extraPerson:20000, included:2 },
  'Suite Jacuzzi':  { h3:85000,  h6:170000, h8:110000,  h12:130000, extraHour:25000, extraPerson:25000, included:2 },
  'Presidencial':   { h3:105000, h6:210000, h8:130000,  h12:145000, extraHour:30000, extraPerson:30000, included:2 },
  'Suite Multiple': { h3:135000, h6:270000, h8:195000,  h12:235000, extraHour:35000, extraPerson:30000, included:4 },
  'Suite Disco':    { h3:180000, h6:360000, h8:260000,  h12:315000, extraHour:35000, extraPerson:30000, included:4 }
};

// ==================== PRECIOS EN RUNTIME ====================
// Construye los precios POR MOTEL leyendo app_categorias (categorias ARBITRARIAS
// por motel, no solo las de MASTER_PRICING). Cada categoria activa entra con sus
// 7 campos (3h/6h/8h/12h, extraHour, extraPerson, included); cada campo cae en
// cascada: valor de la tabla -> valor de MASTER_PRICING[cat] (si la cat es
// conocida) -> DEFAULT_CFG (placeholder visible). Scoped por motel_id (decision
// A1: MOTEL_ID por env/constante de la instancia). Cache POR motel, 5 min; el
// bootstrap llama con {force:true} para reflejar cambios sin redeploy. Si la
// tabla falla -> fallback global a MASTER_PRICING.
const MOTEL_ID = process.env.MOTEL_ID || '24992a8a-48d8-4444-a50f-2d6c7d949828';

// ==================== ACCESO MULTI-TENANT (Fase 3) ====================
// Helpers que inyectan MOTEL_ID automaticamente en las tablas TENANT (las que
// tienen columna motel_id). Garantizan el aislamiento sin depender de recordar
// el filtro en cada query. Las tablas NO tenant (app_moteles, app_reservas,
// app_usuarios, admin_pins/reception_pins/maintenance_pins, settings) pasan sin
// tocar. Devuelven el query builder para seguir encadenando (.eq/.order/.single/etc.).
// NOTA: la migracion de call-sites a estos helpers se hace por tandas (Fase 3);
// hasta que un call-site se migre, sigue usando supabase.from(...) directo.
const TENANT_TABLES = new Set([
  'aire_mantenimiento','aire_rondas','aire_unidades','ajustes','app_categorias',
  'app_fotos','app_motel_admins','bar_sales','caja_paola','cierre_mes','config_caja',
  'cortesias','descargos_nequi','extra_staff','gastos_mes','general_expenses','loans',
  'login_failures','luciana_chats','maid_log','maintenance','maintenance_bitacora',
  'mantenimiento_solicitudes','mantenimiento_tareas','mantenimiento_zonas_comunes',
  'motel_info','payment_method_changes','product_shift_obs','products','proyeccion_meses',
  'proyeccion_tareas','retiros_dueno','room_issues','room_products','rooms','sales',
  'schedule','schedule_extras','shift_close','shift_failures','shift_inventory_start',
  'shift_log','shift_notes','staff','staff_vacaciones_historial','state_history','stock_entries',
  'stock_movements','taxi_expenses','ventas_diarias_manuales','ventas_gastos_anuales',
  // Fase 4 (Parte 2): PINs + settings ahora scopeados por motel
  'admin_pins','reception_pins','maintenance_pins','settings',
  // Pieza 7: las dos fuentes de la bandeja de Quejas y Reclamos.
  // app_calificaciones ya existia (Pieza 6) pero NO estaba aca: quien escribiera
  // tSelect('app_calificaciones',...) creyendo que filtraba por motel, leia las
  // fichas de TODOS los moteles. Hoy no hay fuga porque cerrarEstadiaReserva usa
  // supabase.from(...) con motel_id explicito; esto desarma la trampa para el
  // proximo que toque la tabla.
  'app_calificaciones','app_quejas',
  // Pieza 5a: read-model de la grilla (la app colaborador ya lee de aca; el POS la usa en Etapa 2)
  'grilla',
  // Pieza 6 + expediente (lado admin de Personal): chat/permisos/comunicados/documentos
  'staff_mensajes','staff_permisos','staff_comunicados','staff_documentos',
  // Etapa B: suscripciones Web Push
  'push_subscriptions',
  // Capacitaciones (P4)
  'staff_capacitaciones'
]);

// ===== ETAPA B (Web Push) — envío server-side =====
// VAPID: publico = el mismo del cliente; privado = SECRETO (env VAPID_PRIVATE). Si faltan
// llaves o el paquete, getWebPush devuelve null y sendPushToStaff no-opea sin romper nada.
let _webpush = null, _webpushTried = false;
function getWebPush() {
  if (_webpushTried) return _webpush;
  _webpushTried = true;
  try {
    const wp = require('web-push');
    // .trim(): un espacio/salto pegado al pegar la env var en Vercel corrompe la clave base64url
    // -> la firma no coincide con la applicationServerKey de la suscripcion -> FCM 403 -> push nunca llega.
    // (Fue exactamente el bug: VAPID_PUBLIC venia con un espacio inicial.) Blindaje permanente.
    const pub = String(process.env.VAPID_PUBLIC || '').trim(), priv = String(process.env.VAPID_PRIVATE || '').trim();
    if (!pub || !priv) return null;
    wp.setVapidDetails(String(process.env.VAPID_SUBJECT || 'mailto:admin@casa50.co').trim(), pub, priv);
    _webpush = wp;
  } catch (e) { console.warn('[push] getWebPush falló (¿clave VAPID inválida?): ' + (e && e.message)); _webpush = null; }
  return _webpush;
}
// Envia push a todos los dispositivos de un colaborador. Suscripciones vencidas (410/404) se borran.
// GANCHO Etapa D: si no hay suscripcion activa, aca se marcaria para aviso por WhatsApp (casa50-whatsapp-bot).
async function sendPushToStaff(staffId, payload) {
  try {
    const wp = getWebPush();
    if (!wp) { console.warn('[push] web-push no disponible (¿falta VAPID_PUBLIC/PRIVATE o el paquete?)'); return; }
    const { data: subs } = await tSelect('push_subscriptions', 'id,endpoint,p256dh,auth').eq('staff_id', staffId);
    if (!subs || !subs.length) {
      // TODO Etapa D (fallback WhatsApp): sin suscripcion push activa -> encolar aviso por bot.
      console.warn('[push] staff ' + staffId + ' sin suscripciones');
      return;
    }
    const body = JSON.stringify(payload);
    // urgency:'high' -> header Urgency del protocolo Web Push: FCM entrega YA y despierta al equipo
    // (sin esto va en 'normal' y Android/Doze la encola y la suelta recién al abrir Chrome = "se destranca").
    // TTL 24h: si el equipo estuvo apagado, FCM la retiene hasta un día (chat: más viejo que eso ya se ve in-app).
    const pushOpts = { urgency: 'high', TTL: 86400 };
    for (const sub of subs) {
      try {
        await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, pushOpts);
        console.log('[push] OK staff=' + staffId + ' sub=' + sub.id + ' urgency=high');
      } catch (e) {
        // 410/404 = suscripcion muerta -> se borra. Cualquier otro (403 mismatch de llaves, 401, etc.)
        // se LOGUEA con statusCode+body para diagnosticar (antes se tragaba en silencio).
        const sc = e && e.statusCode;
        console.warn('[push] FALLO staff=' + staffId + ' sub=' + sub.id + ' status=' + sc + ' body=' + String((e && e.body) || (e && e.message) || e).slice(0, 200));
        if (sc === 410 || sc === 404) {
          try { await tDelete('push_subscriptions').eq('id', sub.id); } catch (er) {}
        }
      }
    }
  } catch (e) { console.warn('[push] error inesperado: ' + (e && e.message)); /* nunca romper el flujo que dispara el push */ }
}

// getVapidPublic: devuelve SOLO la clave publica VAPID (es publica por diseno: ya viaja al navegador).
// Fuente unica de verdad para que el cliente colaborador suscriba con la MISMA clave que firma el envio,
// y no se desincronicen (causa clasica de "push nunca llega": la suscripcion quedo atada a otra clave).
async function apiGetVapidPublic(p, res) {
  // webpushReady: booleano no-sensible (¿web-push inicializó con las llaves VAPID?). Si es false,
  // la PRIVADA falta o está malformada -> sendPushToStaff no-opea. privLen: solo la LONGITUD de la
  // privada (no su valor) para detectar espacios/pegado incompleto sin exponer el secreto.
  const priv = String(process.env.VAPID_PRIVATE || '');
  return ok(res, {
    publicKey: String(process.env.VAPID_PUBLIC || '').trim(),
    webpushReady: !!getWebPush(),
    privLen: priv.length, privTrimLen: priv.trim().length
  });
}

// Registra la suscripción Web Push de ESTE dispositivo admin (Sub-etapa 4). Gate REAL:
// requireAdmin (token HMAC + rol ADMIN, rechazo seco) — NO el userRole del body.
// role='admin' separa estas filas de las del colaborador; sendPushToAdmin (fork) filtra por
// ese role, y sendPushToStaff (colab) filtra por staff_id real, así que nunca se pisan.
async function apiSubscribePushAdmin(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const sub = p.subscription || {}, keys = sub.keys || {};
  const endpoint = String(sub.endpoint || '').trim();
  if (!endpoint || !keys.p256dh || !keys.auth) return err(res, 'Suscripción inválida');
  await supabase.from('push_subscriptions').upsert({
    motel_id: MOTEL_ID, staff_id: String(s.n || ''), role: 'admin',
    endpoint, p256dh: keys.p256dh, auth: keys.auth,
    ua: String(p.ua || '').slice(0, 300), created_ms: Date.now()
  }, { onConflict: 'motel_id,endpoint' });
  return ok(res, {});
}

// novedadColab (Plan B): registra UNA novedad para el colaborador (fila staff_mensajes ADMIN
// no-leida, con destino para el flotante) + push. Puntería: llega SOLO a ese staffId.
// El flotante lee no-leidas; la ✕ firma. (El armado inicial del mes NO llama esto: solo ajustes.)
async function novedadColab(s, staffId, tipo, cuerpo, destino, destinoRef, pushTitle, extra) {
  try {
    const now = Date.now();
    await tInsert('staff_mensajes', Object.assign({
      staff_id: staffId, origen: 'ADMIN', tipo: tipo, cuerpo: cuerpo,
      destino: destino, destino_ref: (destinoRef != null ? String(destinoRef) : null),
      autor: (s && s.n) || 'Administración', leido_admin: true, leido_admin_ms: now,
      leido_colab: false, created_ms: now
    }, extra || {}));   // extra: campos opcionales (p.ej. { comunicado_id } para Comunicados)
    await sendPushToStaff(staffId, { title: pushTitle || 'Casa 50', body: String(cuerpo || '').slice(0, 120), url: '/?abrir=chat', tag: tipo + '-' + staffId });
  } catch (e) { /* la novedad no debe romper el flujo que la dispara */ }
}

// SELECT scopeado por motel. El caller sigue encadenando .eq/.order/.maybeSingle/etc.
function tSelect(table, cols, opts){
  let q = supabase.from(table).select(cols, opts);
  if (TENANT_TABLES.has(table)) q = q.eq('motel_id', MOTEL_ID);
  return q;
}
// INSERT scopeado: fuerza motel_id=MOTEL_ID en cada fila de tablas tenant.
function tInsert(table, rows){
  if (TENANT_TABLES.has(table)) {
    rows = Array.isArray(rows) ? rows.map(r => ({ ...r, motel_id: MOTEL_ID }))
                               : { ...rows, motel_id: MOTEL_ID };
  }
  return supabase.from(table).insert(rows);
}
// UPDATE scopeado por motel. El caller sigue encadenando .eq(...).
function tUpdate(table, patch){
  let q = supabase.from(table).update(patch);
  if (TENANT_TABLES.has(table)) q = q.eq('motel_id', MOTEL_ID);
  return q;
}
// DELETE scopeado por motel. El caller sigue encadenando .eq(...).
function tDelete(table){
  let q = supabase.from(table).delete();
  if (TENANT_TABLES.has(table)) q = q.eq('motel_id', MOTEL_ID);
  return q;
}
// UPSERT scopeado: fuerza motel_id=MOTEL_ID en cada fila de tablas tenant.
// opts pasa tal cual a supabase (ej. {onConflict:'motel_id,key'}).
function tUpsert(table, rows, opts){
  if (TENANT_TABLES.has(table)) {
    rows = Array.isArray(rows) ? rows.map(r => ({ ...r, motel_id: MOTEL_ID }))
                               : { ...rows, motel_id: MOTEL_ID };
  }
  return supabase.from(table).upsert(rows, opts);
}

const PRICING_CACHE = {}; // { [motelId]: { data, ms } }
const PRICING_TTL_MS = 5 * 60 * 1000;
const PRECIO_KEYS = { '3h': 'h3', '6h': 'h6', '8h': 'h8', '12h': 'h12' };
// Placeholder ABSURDO y obvio: si alguna vez se cobra con esto, salta a la vista
// que la categoria quedo sin precio configurado. La proteccion real es exigir los
// 7 campos > 0 al crear categoria (llega con Categorias CRUD).
const DEFAULT_CFG = { h3: 99999, h6: 99999, h8: 99999, h12: 99999, extraHour: 99999, extraPerson: 99999, included: 1 };

// Copia PROFUNDA (un nivel): nunca mutar MASTER_PRICING ni sus objetos internos.
function clonePricing(src) {
  const out = {};
  for (const cat in src) out[cat] = Object.assign({}, src[cat]);
  return out;
}

// Invalida la cache de un motel (usado tras editar precios) o de todos si no se pasa.
function invalidatePricingCache(motelId) {
  if (motelId) delete PRICING_CACHE[motelId];
  else for (const k in PRICING_CACHE) delete PRICING_CACHE[k];
}

// Devuelve el cfg de una categoria, o DEFAULT_CFG con aviso si la categoria no existe.
function cfgFor(PRICING, cat) {
  const c = PRICING && PRICING[cat];
  if (c) return c;
  console.warn('CATEGORÍA SIN PRECIO CONFIGURADO - usando DEFAULT_CFG: ' + cat);
  return DEFAULT_CFG;
}

// Cascada de un precio: tabla -> constante -> default (primer valor > 0).
function pickPrecio(fromTable, fromConst, def) {
  const v = Number(fromTable);
  if (Number.isFinite(v) && v > 0) return v;
  const c = Number(fromConst);
  if (Number.isFinite(c) && c > 0) return c;
  return def;
}

async function getPricing(motelId, opts) {
  const mid = motelId || MOTEL_ID;
  const force = !!(opts && opts.force);
  const now = Date.now();
  const cached = PRICING_CACHE[mid];
  if (!force && cached && (now - cached.ms) < PRICING_TTL_MS) {
    return cached.data;
  }
  try {
    const { data, error } = await supabase
      .from('app_categorias')
      .select('nombre_db,precios')
      .eq('motel_id', mid)
      .eq('activo', true);
    if (error) throw error;
    if (!data || !data.length) throw new Error('app_categorias vacia para motel ' + mid);
    const result = {};
    data.forEach(row => {
      const cat = String(row.nombre_db || '').trim();
      if (!cat) return;
      const precios = row.precios || {};
      const base = MASTER_PRICING[cat] || {}; // relleno por campo si la cat es conocida
      const cfg = {};
      // 4 precios de bloque: '3h' -> 'h3', ... (cascada tabla -> constante -> DEFAULT)
      for (const tk in PRECIO_KEYS) {
        const k = PRECIO_KEYS[tk];
        cfg[k] = pickPrecio(precios[tk], base[k], DEFAULT_CFG[k]);
      }
      cfg.extraHour = pickPrecio(precios.extraHour, base.extraHour, DEFAULT_CFG.extraHour);
      cfg.extraPerson = pickPrecio(precios.extraPerson, base.extraPerson, DEFAULT_CFG.extraPerson);
      // included: entero 1..10 (cascada tabla -> constante -> DEFAULT)
      const incT = Number(precios.included), incC = Number(base.included);
      cfg.included = (Number.isInteger(incT) && incT >= 1 && incT <= 10) ? incT
                   : (Number.isInteger(incC) && incC >= 1 && incC <= 10) ? incC
                   : DEFAULT_CFG.included;
      result[cat] = cfg;
    });
    if (!Object.keys(result).length) throw new Error('app_categorias sin categorias validas para motel ' + mid);
    PRICING_CACHE[mid] = { data: result, ms: now };
    return result;
  } catch (e) {
    // Fallback global: no cachear datos malos; devolver copia limpia de la constante
    console.error('getPricing fallback a MASTER_PRICING:', (e && e.message) || e);
    return clonePricing(MASTER_PRICING);
  }
}

// ==================== HELPERS ====================
function businessDay(ms) {
  const d = new Date((ms || Date.now()) - 5 * 3600000);
  if (d.getUTCHours() < 6) d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function previousBusinessDay(bDay) {
  const [y, m, d] = bDay.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function businessDayRange(bDay) {
  const [y, m, d] = bDay.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d, 11, 0, 0, 0);
  const end   = Date.UTC(y, m - 1, d + 1, 11, 0, 0, 0);
  return { start, end };
}

function currentShiftId(ms) {
  const bogota = new Date((ms || Date.now()) + (-5 * 60 * 60 * 1000));
  const h = bogota.getUTCHours();
  if (h >= 6 && h < 14) return 'SHIFT_1';
  if (h >= 14 && h < 21) return 'SHIFT_2';
  return 'SHIFT_3';
}

function normalizeShiftId(shiftId) {
  if (shiftId === 'SHIFT_1_12') return 'SHIFT_1';
  if (shiftId === 'SHIFT_2_12') return 'SHIFT_3';   // 2T12 (6pm-6am) cubre el horario nocturno del SHIFT_3 (no SHIFT_2)
  return shiftId || 'SHIFT_1';
}

function calcPrice(durationHrs, cfg) {
  if (durationHrs === 3)  return Number(cfg.h3  || 0);
  if (durationHrs === 6)  return Number(cfg.h6  || 0);
  if (durationHrs === 8)  return Number(cfg.h8  || 0);
  if (durationHrs === 12) return Number(cfg.h12 || 0);
  return 0;
}

function ok(res, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ ok: true, ...data });
}
function err(res, msg, status = 400) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json({ ok: false, error: msg });
}

// ==================== SUPERADMIN (Fase 5 - nucleo kill switch) ====================
// Auth por secreto de env (SUPERADMIN_SECRET), no por PIN de motel ni rol del body.
// Comparacion en tiempo constante para no filtrar el largo por timing.
function checkSuperadmin(p) {
  const secret = String((p && p.superadminSecret) || '');
  const expected = String(process.env.SUPERADMIN_SECRET || '');
  if (!expected) return { ok:false, msg:'SUPERADMIN_SECRET no configurado en el servidor' };
  if (!secret) return { ok:false, msg:'Falta credencial de superadmin' };
  const a = Buffer.from(secret);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok:false, msg:'Credencial invalida' };
  let match = false;
  try { match = require('crypto').timingSafeEqual(a, b); } catch(e) { match = false; }
  if (!match) return { ok:false, msg:'Credencial invalida' };
  return { ok:true };
}

// ==================== MINI-SESION FIRMADA (Pieza 7) ====================
// EL PROBLEMA QUE ARREGLA
//   Los 41 handlers de admin se protegen con
//       if (String(p.userRole||'').toUpperCase() !== 'ADMIN') return err(...)
//   pero ese userRole viene del BODY del POST. Un curl -d '{"userRole":"ADMIN"}'
//   pasa el chequeo. apiLogin SI valida el PIN contra admin_pins, pero devuelve
//   un objeto plano sin firma que el navegador reenvia tal cual.
//
// LA SOLUCION (aditiva: NO toca ninguno de esos 41)
//   Cuando el PIN valida, apiLogin emite ademas un token firmado con HMAC-SHA256
//   contra POS_SESSION_SECRET (secreto de env, jamas en el bundle del navegador).
//   El token lleva nombre + rol + vencimiento; el servidor lo verifica
//   recalculando la firma. Los endpoints NUEVOS exigen ese token.
//
// POR QUE UN TOKEN Y NO REVALIDAR EL adminCode EN CADA LLAMADA
//   Para revalidar el PIN, el navegador tendria que RETENERLO, y la sesion del
//   admin vive en localStorage -> el PIN del dueno quedaria en texto plano, en
//   reposo, en el computador compartido de recepcion. Seria cambiar un candado
//   falso por una llave tirada en el mostrador. El token, en cambio, caduca solo
//   y no sirve para loguearse.
//
//   Cuando llegue el bloque de seguridad completo, los 41 viejos cambian
//   p.userRole por requireAdmin(p) y este archivo ya tiene el molde.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12h = un turno

function firmaHmac(dato) {
  const secret = String(process.env.POS_SESSION_SECRET || '');
  if (!secret) return '';                     // sin secreto no se puede firmar NI verificar
  return require('crypto').createHmac('sha256', secret).update(dato).digest('base64url');
}

function firmarSesion(userName, userRole, now) {
  const payload = Buffer.from(JSON.stringify({
    n: String(userName || ''), r: String(userRole || ''), exp: now + SESSION_TTL_MS
  })).toString('base64url');
  const firma = firmaHmac(payload);
  if (!firma) return '';
  return payload + '.' + firma;
}

// Devuelve el payload {n, r, exp} o null. FALLA CERRADO: si POS_SESSION_SECRET
// no esta configurado, firmaHmac devuelve '' y aca todo token se rechaza.
function verificarSesion(token) {
  const t = String(token || '');
  const i = t.indexOf('.');
  if (i <= 0) return null;
  const payload = t.slice(0, i);
  const firma   = t.slice(i + 1);
  const esperada = firmaHmac(payload);
  if (!esperada || !firma) return null;
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length) return null;
  let match = false;
  try { match = require('crypto').timingSafeEqual(a, b); } catch (e) { match = false; }
  if (!match) return null;                    // firma invalida -> payload adulterado
  let datos = null;
  try { datos = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!datos || Number(datos.exp || 0) < Date.now()) return null;   // vencido
  return datos;
}

// Gate REAL de admin. El rechazo es SECO (punto 4 de la REGLA DE ORO): no dice
// si falto el token, si vencio o si el rol no alcanza.
function requireAdmin(p) {
  const s = verificarSesion(p && p.token);
  if (!s || String(s.r || '').toUpperCase() !== 'ADMIN') return null;
  return s;
}

// ===== FASE 2 · 3 — token del QR de asistencia (HMAC con QR_ASISTENCIA_SECRET) =====
// El mismo secreto y formato los verifica el backend del colaborador al marcar.
// Payload {m:motel_id, v:qr_version, md:'I'|'R', w:ventana(rotativo)} firmado.
function firmaQrHmac(dato) {
  const secret = String(process.env.QR_ASISTENCIA_SECRET || '');
  if (!secret) return '';                     // sin secreto no se firma NI verifica
  return require('crypto').createHmac('sha256', secret).update(dato).digest('base64url');
}
function generarTokenQr(motelId, qrVersion, modo, rotaSeg, now) {
  const md = (String(modo || 'IMAGEN').toUpperCase() === 'ROTATIVO') ? 'R' : 'I';
  const obj = { m: String(motelId), v: Number(qrVersion || 1), md: md };
  if (md === 'R') obj.w = Math.floor((now || Date.now()) / 1000 / Math.max(1, Number(rotaSeg || 60)));
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const firma = firmaQrHmac(payload);
  if (!firma) return '';
  return payload + '.' + firma;
}

// Lista TODOS los moteles (sin filtro tenant): ve activos y suspendidos.
async function apiListarMotelesSuperadmin(p, res) {
  const chk = checkSuperadmin(p);
  if (!chk.ok) return err(res, chk.msg, 403);
  const { data, error } = await supabase
    .from('app_moteles')
    .select('id, slug, nombre, activo, creado')
    .order('creado', { ascending: true });
  if (error) return err(res, 'Error listando moteles: ' + error.message);
  return ok(res, { moteles: data || [] });
}

// Kill switch: cambia app_moteles.activo + registra auditoria en app_motel_estado_historial.
async function apiCambiarEstadoMotel(p, res) {
  const chk = checkSuperadmin(p);
  if (!chk.ok) return err(res, chk.msg, 403);
  const motelId = String(p.motelId || '').trim();
  const nuevoActivo = (p.activo === true || p.activo === 'true');
  const motivo = String(p.motivo || '').trim();
  const cambiadoPor = String(p.cambiadoPor || '').trim() || null;
  if (!motelId) return err(res, 'motelId requerido');

  const { data: motelActual, error: eGet } = await supabase
    .from('app_moteles').select('id, activo').eq('id', motelId).single();
  if (eGet || !motelActual) return err(res, 'Motel no encontrado');

  const activoAnterior = motelActual.activo;
  if (activoAnterior === nuevoActivo) {
    return ok(res, { sinCambio:true, activo: nuevoActivo });
  }

  const { error: eUpd } = await supabase
    .from('app_moteles').update({ activo: nuevoActivo }).eq('id', motelId);
  if (eUpd) return err(res, 'Error actualizando estado: ' + eUpd.message);

  const { error: eHist } = await supabase
    .from('app_motel_estado_historial').insert({
      motel_id: motelId,
      activo_anterior: activoAnterior,
      activo_nuevo: nuevoActivo,
      motivo: motivo || null,
      cambiado_por: cambiadoPor
    });
  if (eHist) return ok(res, { activo: nuevoActivo, avisoHistorial: 'Estado cambiado pero fallo el registro de auditoria: ' + eHist.message });

  return ok(res, { activo: nuevoActivo, activoAnterior });
}

async function getSettings() {
  const { data } = await tSelect('settings','key, value');
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return map;
}
async function getRoom(roomId) {
  const { data } = await tSelect('rooms','*').eq('room_id', roomId).single();
  return data;
}

function mapRoom(r) {
  return {
    roomId: r.room_id, floor: r.floor, category: r.category,
    state: r.state, stateSinceMs: Number(r.state_since_ms || 0),
    people: Number(r.people || 0), checkInMs: Number(r.check_in_ms || 0),
    dueMs: Number(r.due_ms || 0), lastCheckoutMs: Number(r.last_checkout_ms || 0),
    noteMinor: !!r.note_minor, noteMinorText: r.note_minor_text || '',
    disabled: !!r.disabled, disabledReason: r.disabled_reason || '', disabledDateMs: Number(r.disabled_date_ms || 0),
    archived: !!r.archived,
    arrivalType: r.arrival_type || '', arrivalPlate: r.arrival_plate || '',
    alarmSilencedMs: Number(r.alarm_silenced_ms || 0),
    alarmSilencedForDueMs: Number(r.alarm_silenced_for_due_ms || 0),
    checkoutObs: r.checkout_obs || '',
    contaminatedSinceMs: Number(r.contaminated_since_ms || 0),
    lastMaidName: r.last_maid_name || '',
    lastMaidDoneMs: Number(r.last_maid_done_ms || 0),
    maidInProgress: !!r.maid_in_progress,
    maidNameProgress: r.maid_name_progress || '',
    retoque: !!r.retoque,
    payMethod: r.pay_method || '',
    isCortesia: !!r.is_cortesia
  };
}

// Set de room_id de cortesia del motel (reemplaza el hardcode '304').
// Vacio = motel sin cortesia. Scopeado por motel via tSelect.
async function getCortesiaIds(){
  const { data } = await tSelect('rooms','room_id').eq('is_cortesia', true);
  return new Set((data || []).map(r => String(r.room_id)));
}
// Corte de la regla nueva de cortesia: desde esta fecha, en el cuarto cortesia la
// HABITACION base no suma pero personas/horas/productos SI. Antes de la fecha la
// cortesia se excluye ENTERA (datos viejos/prueba de abril-mayo no se tocan).
const CORTESIA_COBRO_DESDE = '2026-06-01';
// ==================== HELPER DE PAGINACION ====================
// Trae TODAS las filas de una consulta Supabase, paginando en lotes de 1000.
// Se usa para consultas de rangos largos (ej: mes completo) donde Supabase
// corta por defecto a 1000 filas aunque pidas mas con .range().
//
// Uso: const sales = await fetchAll(() => tSelect('sales','...').like('business_day', '2026-04%'));
async function fetchAll(queryBuilder, batchSize = 1000) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryBuilder().order('id', { ascending: true }).range(from, from + batchSize - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return all;
}
// ==================== HANDLER PRINCIPAL ====================
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  const fn = req.query.fn || (req.body && req.body.fn);
  const payload = req.method === 'POST' ? (req.body || {}) : req.query;
  try {
    switch (fn) {
      case 'bootstrap':         return await apiBootstrap(req, res);
      case 'getRooms':          return await apiGetRooms(req, res);
      case 'login':             return await apiLogin(payload, res);
      case 'checkIn':           return await apiCheckIn(payload, res);
      case 'activarReserva':    return await apiActivarReserva(payload, res);
      case 'verificarLlegadaReserva': return await apiVerificarLlegadaReserva(payload, res);
      case 'getComprobanteReserva': return await apiGetComprobanteReserva(payload, res);
      case 'getComprobante':    return await apiGetComprobante(payload, res);
      case 'getComprobantesPendientes': return await apiGetComprobantesPendientes(payload, res);
      case 'marcarComprobanteImpreso': return await apiMarcarComprobanteImpreso(payload, res);
      case 'checkOut':          return await apiCheckOut(payload, res);
      case 'extendTime':        return await apiExtendTime(payload, res);
      case 'cambiarDuracion':   return await apiCambiarDuracion(payload, res);
      case 'horaGratis':        return await apiHoraGratis(payload, res);
      case 'renewTime':         return await apiRenewTime(payload, res);
      case 'silenceAlarm':      return await apiSilenceAlarm(payload, res);
      case 'maidTake':          return await apiMaidTake(payload, res);
      case 'maidFinish':        return await apiMaidFinish(payload, res);
      case 'maidLogAction':     return await apiMaidLogAction(payload, res);
      case 'maidMarkExit':      return await apiMaidMarkExit(payload, res);
      case 'getMaidLog':        return await apiGetMaidLog(payload, res);
      case 'clearContaminated': return await apiClearContaminated(payload, res);
      case 'setMinorNote':      return await apiSetMinorNote(payload, res);
      case 'setDisabled':       return await apiSetDisabled(payload, res);
      case 'refund':            return await apiRefund(payload, res);
      case 'taxi':              return await apiTaxi(payload, res);
      case 'deleteTaxi':        return await apiDeleteTaxi(payload, res);
      case 'listTaxisTurno':    return await apiListTaxisTurno(payload, res);
      case 'addLoan':           return await apiAddLoan(payload, res);
      case 'getLoans':          return await apiGetLoans(payload, res);
      case 'registerExtraStaff':return await apiRegisterExtra(payload, res);
      case 'updateExtraStaff':  return await apiUpdateExtra(payload, res);
      case 'deleteExtra':       return await apiDeleteExtra(payload, res);
      case 'listExtrasTurno':   return await apiListExtrasTurno(payload, res);
      case 'checkoutExtraStaff':return await apiCheckoutExtra(payload, res);
      case 'getExtraStaff':     return await apiGetExtra(payload, res);
      case 'addShiftNote':      return await apiAddNote(payload, res);
      case 'getShiftNotes':     return await apiGetNotes(payload, res);
      case 'closeShift':        return await apiCloseShift(payload, res);
      case 'metrics':           return await apiMetrics(payload, res);
      case 'metricsHourly':     return await apiMetricsHourly(payload, res);
      case 'monthMetrics':      return await apiMonthMetrics(payload, res);
      case 'maidPanel':         return await apiMaidPanel(payload, res);
      case 'getStaff':          return await apiGetStaff(payload, res);
      case 'saveStaff':         return await apiSaveStaff(payload, res);
      case 'getExtrasPendientes':    return await apiGetExtrasPendientes(payload, res);
      case 'aprobarExtra':           return await apiAprobarExtra(payload, res);
      case 'rechazarExtra':          return await apiRechazarExtra(payload, res);
      case 'resetearPinColaborador': return await apiResetearPin(payload, res);
      case 'getQrAsistencia':        return await apiGetQrAsistencia(payload, res);
      case 'regenerarQrAsistencia':  return await apiRegenerarQrAsistencia(payload, res);
      case 'saveVacacionesEvent': return await apiSaveVacacionesEvent(payload, res);
      case 'getSchedule':       return await apiGetSchedule(payload, res);
      case 'saveSchedule':      return await apiSaveSchedule(payload, res);
      case 'grillaGetMes':      return await apiGrillaGetMes(payload, res);
      case 'grillaGuardarCelda': return await apiGrillaGuardarCelda(payload, res);
      case 'grillaVacaciones':   return await apiGrillaVacaciones(payload, res);
      case 'chatEstado':          return await apiChatEstado(payload, res);
      case 'staffConversacion':   return await apiStaffConversacion(payload, res);
      case 'staffResponder':      return await apiStaffResponder(payload, res);
      case 'resolverPermiso':     return await apiResolverPermiso(payload, res);
      case 'verSoportePermiso':   return await apiVerSoportePermiso(payload, res);
      case 'staffDocumentos':     return await apiStaffDocumentos(payload, res);
      case 'subirDocumento':      return await apiSubirDocumento(payload, res);
      case 'descargarDocumentoAdmin': return await apiDescargarDocumentoAdmin(payload, res);
      case 'toggleVisibilidadDoc': return await apiToggleVisibilidadDoc(payload, res);
      case 'validarIncapacidad':  return await apiValidarIncapacidad(payload, res);
      case 'anularDocumento':     return await apiAnularDocumento(payload, res);
      case 'toggleCarpeta':       return await apiToggleCarpeta(payload, res);
      case 'crearCapacitacion':   return await apiCrearCapacitacion(payload, res);
      case 'getCapacitaciones':   return await apiGetCapacitaciones(payload, res);
      case 'crearComunicado':     return await apiCrearComunicado(payload, res);
      case 'eliminarExtraNomina': return await apiEliminarExtra(payload, res);
      case 'liquidar':            return await apiLiquidar(payload, res);
      case 'getLiquidados':       return await apiGetLiquidados(payload, res);
      case 'reintegrarStaff':     return await apiReintegrar(payload, res);
      case 'getVapidPublic':      return await apiGetVapidPublic(payload, res);
      case 'subscribePushAdmin':  return await apiSubscribePushAdmin(payload, res);
      case 'setMultiMaidMode':  return await apiSetMultiMaidMode(payload, res);
      case 'getMultiMaidMode':  return await apiGetMultiMaidMode(payload, res);
      case 'setDailyGoal':      return await apiSetGoal(payload, res);
      case 'setReceptionPin':   return await apiSetPin(payload, res);
      case 'deleteReceptionPin':return await apiDeletePin(payload, res);
      case 'getReceptionPins':  return await apiGetPins(payload, res);
      case 'changeAdminPin':    return await apiChangeAdminPin(payload, res);
      case 'roomHistory':       return await apiRoomHistory(payload, res);
      case 'markNoteSeen':      return await apiMarkNoteSeen(payload, res);
      case 'markNotePasado':    return await apiMarkNotePasado(payload, res);
      case 'addNoteReply':      return await apiAddNoteReply(payload, res);
      case 'getAllNotes':        return await apiGetAllNotes(payload, res);
      case 'getNoteHistory':    return await apiGetNoteHistory(payload, res);
      case 'reviewNote':        return await apiReviewNote(payload, res);
      case 'deleteNote':        return await apiDeleteNote(payload, res);
      case 'addBarSale':        return await apiAddBarSale(payload, res);
      case 'getBarSales':       return await apiGetBarSales(payload, res);
      case 'addGeneralExpense': return await apiAddGeneralExpense(payload, res);
      case 'getGeneralExpenses':return await apiGetGeneralExpenses(payload, res);
      case 'getDailyCuadre':    return await apiGetDailyCuadre(payload, res);
      case 'addExtraPerson':    return await apiAddExtraPerson(payload, res);
      case 'roomChange':        return await apiRoomChange(payload, res);
      case 'updatePayMethod':   return await apiUpdatePayMethod(payload, res);
      case 'openDrawer':        return await apiOpenDrawer(payload, res);
      case 'drawerPoll':        return await apiDrawerPoll(payload, res);
      case 'drawerAck':         return await apiDrawerAck(payload, res);
      case 'updateArrivalPlate':return await apiUpdateArrivalPlate(payload, res);
      case 'getMaintHistory':   return await apiGetMaintHistory(payload, res);
      case 'clearMaintHistory': return await apiClearMaintHistory(payload, res);
      case 'getRoomIssues':     return await apiGetRoomIssues(payload, res);
      case 'addRoomIssue':      return await apiAddRoomIssue(payload, res);
      case 'editRoomIssue':     return await apiEditRoomIssue(payload, res);
      case 'resolveRoomIssue':  return await apiResolveRoomIssue(payload, res);
      case 'deleteRoomIssue':   return await apiDeleteRoomIssue(payload, res);
      // Modulo de mantenimiento (nuevo flujo con estados)
      case 'getReportesActivos':return await apiGetReportesActivos(payload, res);
      case 'crearReporteMant':  return await apiCrearReporteMant(payload, res);
      case 'aprobarReporteMant':return await apiAprobarReporteMant(payload, res);
      case 'anularReporteMant': return await apiAnularReporteMant(payload, res);
      case 'getMisDanos':       return await apiGetMisDanos(payload, res);
      case 'marcarArreglo':     return await apiMarcarArreglo(payload, res);
      case 'verificarArreglo':  return await apiVerificarArreglo(payload, res);
      case 'rechazarArreglo':   return await apiRechazarArreglo(payload, res);
      case 'cambiarPrioridadMant': return await apiCambiarPrioridadMant(payload, res);
      case 'resolverDanoZonaComun': return await apiResolverDanoZonaComun(payload, res);
      case 'marcarRevision':    return await apiMarcarRevision(payload, res);
      case 'marcarDanioVisto':  return await apiMarcarDanioVisto(payload, res);
      case 'crearTareaMant':    return await apiCrearTareaMant(payload, res);
      case 'getTareasMant':     return await apiGetTareasMant(payload, res);
      case 'completarTareaMant':return await apiCompletarTareaMant(payload, res);
      case 'anularTareaMant':   return await apiAnularTareaMant(payload, res);
      case 'getHistorialMant':  return await apiGetHistorialMant(payload, res);
      case 'getResumenMantHoy': return await apiGetResumenMantHoy(payload, res);
      case 'crearSolicitudMant':  return await apiCrearSolicitudMant(payload, res);
      case 'getSolicitudesMant':  return await apiGetSolicitudesMant(payload, res);
      case 'getHistorialSolicitudesGeo': return await apiGetHistorialSolicitudesGeo(payload, res);
      case 'aprobarSolicitudMant':return await apiAprobarSolicitudMant(payload, res);
      case 'rechazarSolicitudMant':return await apiRechazarSolicitudMant(payload, res);
      // Modulo de mantenimiento de aire (preventivo, ciclo de 4 meses)
      case 'getAireGrid':       return await apiGetAireGrid(payload, res);
      case 'registrarAire':     return await apiRegistrarAire(payload, res);
      case 'cerrarRondaAire':   return await apiCerrarRondaAire(payload, res);
      case 'getAireHistorial':  return await apiGetAireHistorial(payload, res);
      case 'getProyeccion':     return await apiGetProyeccion(payload, res);
      case 'saveTarea':         return await apiSaveTarea(payload, res);
      case 'updateTarea':       return await apiUpdateTarea(payload, res);
      case 'deleteTarea':       return await apiDeleteTarea(payload, res);
      case 'saveMesProyeccion': return await apiSaveMesProyeccion(payload, res);
      case 'clearMaidLog':      return await apiClearMaidLog(payload, res);
      case 'maidCancel':        return await apiMaidCancel(payload, res);
      case 'saveExtra':         return await apiSaveExtra(payload, res);
      case 'getExtras':         return await apiGetExtras(payload, res);
      case 'deleteScheduleExtra':return await apiDeleteScheduleExtra(payload, res);
      case 'saveShiftFailure':  return await apiSaveShiftFailure(payload, res);
      case 'getShiftFailures':  return await apiGetShiftFailures(payload, res);
     case 'saveObservacionTurno':   return await apiSaveObservacionTurno(payload, res);
      case 'getObservacionesTurno':  return await apiGetObservacionesTurno(payload, res);
      case 'getProductosMes':        return await apiGetProductosMes(payload, res);
      case 'getInventarioByDay':     return await apiGetInventarioByDay(payload, res);
      case 'getCortesiasByShift':    return await apiGetCortesiasByShift(payload, res);
      case 'quitarCortesia':         return await apiQuitarCortesia(payload, res);
      case 'agregarCortesia':        return await apiAgregarCortesia(payload, res);
      case 'getProducts':            return await apiGetProducts(payload, res);
      case 'saveProduct':            return await apiSaveProduct(payload, res);
      case 'saveCategoriaPrecios':   return await apiSaveCategoriaPrecios(payload, res);
      case 'getCategorias':          return await apiGetCategorias(payload, res);
      case 'createCategoria':        return await apiCreateCategoria(payload, res);
      case 'editCategoria':          return await apiEditCategoria(payload, res);
      case 'toggleCategoria':        return await apiToggleCategoria(payload, res);
      case 'getRoomsAdmin':          return await apiGetRoomsAdmin(payload, res);
      case 'createRoom':             return await apiCreateRoom(payload, res);
      case 'editRoom':               return await apiEditRoom(payload, res);
      case 'archiveRoom':            return await apiArchiveRoom(payload, res);
      case 'saveMotelInfo':          return await apiSaveMotelInfo(payload, res);
      case 'deleteProduct':          return await apiDeleteProduct(payload, res);
      case 'addStock':               return await apiAddStock(payload, res);
      case 'ingresoBodega':          return await apiIngresoBodega(payload, res);
      case 'trasladoRecepcion':      return await apiTrasladoRecepcion(payload, res);
      case 'devolverABodega':        return await apiDevolverABodega(payload, res);
      case 'agregarPersonaManual':   return await apiAgregarPersonaManual(payload, res);
      case 'getHabitacionesTurno':   return await apiGetHabitacionesTurno(payload, res);
      case 'getExtrasHabitacion':    return await apiGetExtrasHabitacion(payload, res);
      case 'agregarHoraExtraManual': return await apiAgregarHoraExtraManual(payload, res);
      case 'getPersonasHabitacion':  return await apiGetPersonasHabitacion(payload, res);
      case 'editarPersonasCheckIn':  return await apiEditarPersonasCheckIn(payload, res);
      case 'getRoomProducts':    return await apiGetRoomProducts(payload, res)
      case 'addRoomProduct':     return await apiAddRoomProduct(payload, res);
      case 'editRoomProduct':    return await apiEditRoomProduct(payload, res);
      case 'deleteRoomProduct':  return await apiDeleteRoomProduct(payload, res);
      case 'saveCortesia':       return await apiSaveCortesia(payload, res);
      case 'saveRoomBarcode':    return await apiSaveRoomBarcode(payload, res);
      case 'anularVenta':        return await apiAnularVenta(payload, res);
      case 'anularVentaModulo':  return await apiAnularVentaModulo(payload, res);
      case 'agregarVentaManual': return await apiAgregarVentaManual(payload, res);
      case 'listGastosTurno':    return await apiListGastosTurno(payload, res);
      case 'agregarGastoManual': return await apiAgregarGastoManual(payload, res);
      case 'editarGastoModulo':  return await apiEditarGastoModulo(payload, res);
      case 'anularGastoModulo':  return await apiAnularGastoModulo(payload, res);
      case 'ajusteInventario':   return await apiAjusteInventario(payload, res);
      case 'ajusteInventarioV2': return await apiAjusteInventarioV2(payload, res);
     case 'getHistorialAjustes': return await apiGetHistorialAjustes(payload, res); 
      case 'getPrintTurno':      return await apiGetPrintTurno(payload, res);
      case 'getResumenMes':      return await apiGetResumenMes(payload, res);
      case 'getMetricasMes':      return await apiGetMetricasMes(payload, res);
      case 'getGraficaDiaADia':   return await apiGetGraficaDiaADia(payload, res);
      case 'getGraficaAnoAno':    return await apiGetGraficaAnoAno(payload, res);
      case 'getAnoAnterior':      return await apiGetAnoAnterior(payload, res);
      case 'saveAnoAnterior':     return await apiSaveAnoAnterior(payload, res);
      case 'getGastosMesResumen': return await apiGetGastosMesResumen(payload, res);
      case 'addGastoMes':         return await apiAddGastoMes(payload, res);
      case 'editGastoMes':        return await apiEditGastoMes(payload, res);
      case 'createRetiro':        return await apiCreateRetiro(payload, res);
      case 'getRetiros':          return await apiGetRetiros(payload, res);
      case 'anularRetiro':        return await apiAnularRetiro(payload, res);
      case 'anularGastoMes':      return await apiAnularGastoMes(payload, res);
      case 'getCajaPaolaResumen': return await apiGetCajaPaolaResumen(payload, res);
      case 'addCajaEntrega':      return await apiAddCajaEntrega(payload, res);
      case 'addCajaGasto':        return await apiAddCajaGasto(payload, res);
      case 'editCajaGasto':       return await apiEditCajaGasto(payload, res);
      case 'deleteCajaGasto':     return await apiDeleteCajaGasto(payload, res);
      case 'aprobarCajaEntrega':  return await apiAprobarCajaEntrega(payload, res);
      case 'anularCajaEntrega':   return await apiAnularCajaEntrega(payload, res);
      case 'descargarNequi':      return await apiDescargarNequi(payload, res);
      case 'anularDescargoNequi': return await apiAnularDescargoNequi(payload, res);
      case 'updatePrecioCompra': return await apiUpdatePrecioCompra(payload, res);
      case 'changePaymentMethod': return await apiChangePaymentMethod(payload, res);
      case 'changePaymentMethodBar': return await apiChangePaymentMethodBar(payload, res);
      case 'listRoomProductsTurno': return await apiListRoomProductsTurno(payload, res);
      case 'getBitacoraMantenedor':  return await apiGetBitacoraMantenedor(payload, res);
      case 'saveBitacoraMantenedor': return await apiSaveBitacoraMantenedor(payload, res);
      case 'lucianaChat':         return await apiLucianaChat(payload, res);
      case 'lucianaGastoMes':     return await apiLucianaGastoMes(payload, res);
      case 'listarMotelesSuperadmin': return await apiListarMotelesSuperadmin(payload, res);
      case 'cambiarEstadoMotel':      return await apiCambiarEstadoMotel(payload, res);
      // Pieza 7: exigen token firmado (requireAdmin), no el userRole del body.
      case 'getQuejas':           return await apiGetQuejas(payload, res);
      case 'marcarQueja':         return await apiMarcarQueja(payload, res);
      default: return err(res, 'Funcion desconocida: ' + fn);
    }
  } catch (e) {
    console.error('API Error:', e);
    return err(res, e.message || 'Error interno', 500);
  }
};

// Datos del motel (nombre, logo, fiscales) por motel_id. Fallback a un objeto
// minimo con nombre 'Casa 50' si la tabla falla o no hay fila (no rompe la app).
const MOTEL_INFO_FIELDS = 'motel_id,nombre,logo_url,nit,razon_social,direccion,telefono,ciudad,resolucion_dian';
function motelInfoFallback() {
  return { motel_id: MOTEL_ID, nombre: 'Casa 50', logo_url: '', nit: '', razon_social: '', direccion: '', telefono: '', ciudad: '', resolucion_dian: '' };
}
async function getMotelInfo() {
  try {
    const { data, error } = await tSelect('motel_info', MOTEL_INFO_FIELDS).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('motel_info sin fila para ' + MOTEL_ID);
    return data;
  } catch (e) {
    console.error('getMotelInfo fallback a {nombre:Casa 50}:', (e && e.message) || e);
    return motelInfoFallback();
  }
}

// ==================== BOOTSTRAP ====================
async function apiBootstrap(req, res) {
  const now = Date.now();
  const settings = await getSettings();
  const { data: rooms } = await tSelect('rooms','*').eq('archived', false).order('floor').order('room_id');
  return ok(res, {
    settings, rooms: (rooms || []).map(mapRoom),
    motelInfo: await getMotelInfo(),
    masterPricing: await getPricing(MOTEL_ID, { force: true }), serverNowMs: now,
    businessDay: businessDay(now), currentShiftId: currentShiftId(now),
    shifts: [
      { id: 'SHIFT_1', label: 'Turno 1 (6am-2pm)' },
      { id: 'SHIFT_2', label: 'Turno 2 (2pm-9pm)' },
      { id: 'SHIFT_3', label: 'Turno 3 (9pm-6am)' }
    ]
  });
}

// Etapa C: auto-activacion por no-show. Disparo perezoso desde el polling de recepcion.
// Cada apiGetRooms revisa las reservas PAGADAS sin activar cuyo cronometro ya vencio
// (pago_ms + llegada_min) y las activa via el mismo nucleo (venta WOMPI, activada_por=
// 'SISTEMA (no-show)'). El doble candado del core evita dobles activaciones entre pollers.
async function autoActivarReservasVencidas(now) {
  const { data: pend } = await supabase.from('app_reservas')
    .select('id, pago_ms, llegada_min')
    .eq('motel_id', MOTEL_ID).eq('estado', 'PAGADA').is('activacion_ms', null);
  const vencidas = (pend || []).filter(rv => now >= Number(rv.pago_ms||0) + Number(rv.llegada_min||0) * 60000);
  if (!vencidas.length) return;
  const bDay = businessDay(now), shift = currentShiftId(now);
  for (const rv of vencidas) {
    // Resultado ignorado a proposito: si activo, el load de rooms de abajo lo refleja; si la
    // hab no estaba disponible, el claim se revirtio y la reserva sigue viva (VENCIDA).
    try { await activarReservaCore({ reservaId: rv.id, userName: 'SISTEMA (no-show)', bDay, shift, now }); }
    catch (e) { /* nunca romper el getRooms por una activacion fallida */ }
  }
}

async function apiGetRooms(req, res) {
  // Etapa C: auto-activar las vencidas ANTES de leer el estado, para que la respuesta ya
  // refleje la habitacion ocupada y la reserva ya no aparezca como pendiente.
  await autoActivarReservasVencidas(Date.now());

  const { data: rooms } = await tSelect('rooms','*').eq('archived', false).order('floor').order('room_id');

  // Cargar danos activos por habitacion (Fase 3 mantenimiento)
  // Estados que activan el bombillito (PENDIENTE_RECEPCION queda para Fase 6)
  const estadosBombillito = ['NOTA_ACTIVA','ESPERA_VERIFICACION','RECHAZADO_VERIFICACION'];
  const { data: danos } = await tSelect('room_issues', 'id, ubicacion_id, prioridad, estado, description, reportado_ms, created_by, arreglado_por, arreglado_ms, arreglo_nota, foto_arreglo_url, revisiones')
    .eq('anulada', false)
    .eq('ubicacion_tipo', 'habitacion')
    .in('estado', estadosBombillito);
  const danosMap = {};
  (danos || []).forEach(function(d){
    danosMap[d.ubicacion_id] = {
      id: d.id,
      prioridad: d.prioridad,
      estado: d.estado,
      descripcion: d.description || '',
      reportadoMs: Number(d.reportado_ms || 0),
      reportadoPor: d.created_by || '',
      arregladoPor: d.arreglado_por || '',
      arregladoMs: Number(d.arreglado_ms || 0),
      arregloNota: d.arreglo_nota || '',
      fotoArregloUrl: d.foto_arreglo_url || null,
      revisiones: Array.isArray(d.revisiones) ? d.revisiones : []
    };
  });

  // Reservas PAGADAS sin activar (Etapa A reservas<->recepcion). La habitacion
  // sigue AVAILABLE en rooms; la reserva se adjunta como overlay y el front la
  // pinta por encima. app_reservas es multi-tenant (motel_id con DEFAULT casa50),
  // por eso filtramos por MOTEL_ID. Join embebido a app_usuarios via FK
  // app_reservas_usuario_id_fkey para traer el nombre del cliente.
  const { data: reservas } = await supabase
    .from('app_reservas')
    .select('habitacion, pago_ms, activacion_ms, llegada_min, app_usuarios(nombre)')
    .eq('motel_id', MOTEL_ID)
    .eq('estado', 'PAGADA')
    .is('activacion_ms', null);
  const reservasMap = {};
  (reservas || []).forEach(function(rv){
    // Sin gracia: mientras siga PAGADA + activacion_ms null, bloquea. Al vencer
    // el cronometro (pago_ms+llegada_min) la tarjeta pasa a VENCIDA pero NO libera
    // (la auto-activacion llega en Etapa C). Si una hab tiene >1, gana la primera.
    if (reservasMap[rv.habitacion]) return;
    reservasMap[rv.habitacion] = {
      clienteNombre: (rv.app_usuarios && rv.app_usuarios.nombre) || '',
      pagoMs: Number(rv.pago_ms || 0),
      llegadaMin: Number(rv.llegada_min || 0),
      llegadaDeadlineMs: Number(rv.pago_ms || 0) + Number(rv.llegada_min || 0) * 60000
    };
  });

  // Ventas WOMPI vivas -> alimentan DOS marcas distintas de la tarjeta. Una sola query;
  // los flags se derivan abajo, cada uno con SU condicion. Match por room_id + check_in_ms
  // (la estadia actual, no una vieja).
  //   - comprobantePendiente (Etapa D): comprobante_impreso_ms IS NULL.
  //   - sinCliente (Pieza 2): no-show (user_name 'SISTEMA...') que aun no verifico llegada.
  // OJO: el filtro de comprobante_impreso_ms NO puede ir en el WHERE. Si fuera, imprimir el
  // comprobante sacaria la fila de la query y apagaria tambien el badge SIN CLIENTE, aunque
  // el cliente nunca hubiera llegado. Por eso viene como columna y se filtra en memoria.
  const { data: wompiVivas } = await tSelect('sales','room_id,check_in_ms,user_name,comprobante_impreso_ms,cliente_llego_ms')
    .eq('origin','WOMPI').eq('anulada', false);
  const compPendSet = new Set();
  const sinClienteSet = new Set();
  (wompiVivas || []).forEach(function(s){
    const k = String(s.room_id)+'|'+Number(s.check_in_ms||0);
    if (s.comprobante_impreso_ms == null) compPendSet.add(k);
    if (String(s.user_name||'').startsWith('SISTEMA') && s.cliente_llego_ms == null) sinClienteSet.add(k);
  });

  const mapped = (rooms || []).map(function(r){
    const m = mapRoom(r);
    const k = String(r.room_id)+'|'+Number(r.check_in_ms||0);
    m.danoActivo = danosMap[r.room_id] || null;
    m.reserva = reservasMap[r.room_id] || null;
    m.comprobantePendiente = (m.state==='OCCUPIED') && compPendSet.has(k);
    m.sinCliente = (m.state==='OCCUPIED') && sinClienteSet.has(k);
    return m;
  });

  return ok(res, { rooms: mapped });
}

// ==================== LOGIN ====================
async function apiLogin(p, res) {
  const now = Date.now();
  // KILL SWITCH (Fase 5 superadmin): si el motel de ESTE deploy (MOTEL_ID) esta
  // suspendido, no dejar entrar a nadie. FAIL-OPEN: bloquea SOLO si app_moteles.activo
  // === false explicito; ante cualquier duda (fila ausente, null, error de query, sin
  // MOTEL_ID) deja pasar, para NO bloquear casa50 por un problema transitorio.
  try {
    const { data: motelRow } = await supabase.from('app_moteles').select('activo').eq('id', MOTEL_ID).maybeSingle();
    if (motelRow && motelRow.activo === false) {
      return err(res, 'Este motel está suspendido. Contactá al administrador de la plataforma.', 403);
    }
  } catch (e) { /* fail-open: si la verificacion falla, seguir con el login normal */ }
  let bDay = businessDay(now);
  // shiftRaw preserva el valor crudo del dropdown (puede ser SHIFT_1_12 o
  // SHIFT_2_12). Se devuelve en sess.shiftIdRaw para que el frontend pueda
  // mostrar el label correcto del turno 12h, ya que 'shift' queda normalizado.
  const shiftRaw = String(p.shiftId||'').trim() || currentShiftId(now);

  // BUG 2: en domingo operativo (business_day cae en domingo), RECEPTION solo
  // puede entrar como 1T12 o 2T12. Bloqueamos T1/T2/T3 puros para evitar que
  // operaciones del 2T12 se mezclen con un SHIFT_2 fantasma. Validación va
  // ANTES de normalizeShiftId — usamos shiftRaw (no shift) y evaluamos DOW del
  // business_day en vez del día calendario, así un login a las 4am del lunes
  // (business_day=domingo todavía) también se bloquea correctamente.
  const userRoleCheck = String(p.userRole||'').toUpperCase();
  if(userRoleCheck === 'RECEPTION' && ['SHIFT_1','SHIFT_2','SHIFT_3'].includes(shiftRaw)){
    const dowBDay = new Date(bDay+'T12:00:00Z').getUTCDay();
    if(dowBDay === 0){
      return err(res, 'Domingo: recepción solo puede entrar como 1T12 o 2T12. Elegí uno de esos.');
    }
  }

  let shift = shiftRaw;
  shift = normalizeShiftId(shift);
  if(!['SHIFT_1','SHIFT_2','SHIFT_3'].includes(shift)) shift=currentShiftId(now);

  // FIX T3 MEDIANOCHE (item 1):
  // Solo cambia a SHIFT_1 si el logout del T3 fue en la madrugada (0h-6h)
  // Si son las 9pm-11pm y hay un logout del T3 de la madrugada anterior, no cambia
  if(shift==='SHIFT_3'){
    const nowHour = new Date(now + (-5*3600000)).getUTCHours();
    // Solo verificar si estamos en la madrugada (0am-6am)
    if(nowHour >= 0 && nowHour < 6){
      const{data:logoutT3}=await tSelect('shift_log','id,ts_ms').eq('business_day',bDay).eq('shift_id','SHIFT_3').eq('action','LOGOUT').limit(1);
      if(logoutT3&&logoutT3.length){
        const logoutHour = new Date(Number(logoutT3[0].ts_ms) + (-5*3600000)).getUTCHours();
        // Solo cambia a SHIFT_1 si el logout fue tambien en la madrugada
        if(logoutHour >= 0 && logoutHour < 6){
          shift = 'SHIFT_1';
          // Avanzar el business_day al día calendario actual en Bogotá (este SHIFT_1
          // pertenece a "hoy", no al business_day "ayer" que devolvió businessDay()).
          bDay = new Date(now - 5*3600000).toISOString().slice(0,10);
        }
      }
    }
    // FIX FANTASMA T3 MAÑANA (Nivel 2): a partir de las 6am businessDay() ya rotó
    // a HOY, pero un login de turno noche entre las 6am y antes de que arranque el
    // T3 real (6pm) en realidad CONTINÚA el turno noche de AYER si ese sigue abierto
    // (LOGIN sin LOGOUT). Sin esto se crea un "T3 fantasma" de hoy que congela el
    // snapshot con el stock de la mañana (bug del agua del 29-may).
    else if(nowHour >= 6 && nowHour < 17){
      const prevBDay = previousBusinessDay(bDay);
      const { data: prevT3Login } = await tSelect('shift_log', 'id').eq('business_day', prevBDay).eq('shift_id','SHIFT_3')
        .in('action',['LOGIN','RELOGIN']).limit(1);
      if(prevT3Login && prevT3Login.length){
        const { data: prevT3Logout } = await tSelect('shift_log', 'id').eq('business_day', prevBDay).eq('shift_id','SHIFT_3')
          .eq('action','LOGOUT').limit(1);
        if(!prevT3Logout || !prevT3Logout.length){
          // El turno noche de ayer sigue abierto → este login lo continúa.
          bDay = prevBDay;
        }
      }
    }
  }

  // FIX SHIFT_1 MADRUGADA (simétrico al FIX T3): si recep elige T1 explícito
  // antes de las 6am (puede ser T1 normal o 1T12 normalizado a SHIFT_1) y el
  // T3 previo cerró también en madrugada, este SHIFT_1 pertenece al día
  // calendario actual, no al business_day "ayer" que devuelve businessDay(now).
  if(shift==='SHIFT_1'){
    const nowHour = new Date(now + (-5*3600000)).getUTCHours();
    if(nowHour >= 0 && nowHour < 6){
      const{data:logoutT3b}=await tSelect('shift_log','id,ts_ms').eq('business_day',bDay).eq('shift_id','SHIFT_3').eq('action','LOGOUT').limit(1);
      if(logoutT3b && logoutT3b.length){
        const logoutHourB = new Date(Number(logoutT3b[0].ts_ms) + (-5*3600000)).getUTCHours();
        if(logoutHourB >= 0 && logoutHourB < 6){
          bDay = new Date(now - 5*3600000).toISOString().slice(0,10);
        }
      }
    }
  }

  const userName = String(p.userName || '').trim();
  const userRole = String(p.userRole || '').toUpperCase();
  const forceEntry = p.forceEntry === true || p.forceEntry === 'true'; // Admin fuerza entrada
  if (!userRole) return err(res, 'Rol requerido');
  if (!userName && userRole !== 'MAINTENANCE') return err(res, 'Nombre requerido');

  const tenMinsAgo = now - 10 * 60 * 1000;
  const { data: fails } = await tSelect('login_failures', 'ts_ms').eq('user_name', userName.toLowerCase()).eq('user_role', userRole)
    .gt('ts_ms', tenMinsAgo).order('ts_ms', { ascending: false });
  if (fails && fails.length >= 3) {
    const wait = Math.ceil((Number(fails[0].ts_ms) + 5 * 60 * 1000 - now) / 60000);
    if (wait > 0) return err(res, `Demasiados intentos. Espera ${wait} minuto(s).`);
  }

  if (userRole === 'ADMIN') {
    // Buscar el admin por su PIN propio en admin_pins.
    // Si coincide: usamos el nombre canonico de la tabla (auditoria confiable)
    // y su flag ver_luciana. El nombre escrito a mano se ignora a proposito,
    // asi nadie puede hacerse pasar por otro admin tipeando otro nombre.
    const { data: adminRow } = await tSelect('admin_pins','user_name, ver_luciana')
      .eq('pin', String(p.adminCode || '')).maybeSingle();
    let adminName, verLuciana;
    if (adminRow) {
      adminName = adminRow.user_name;
      verLuciana = adminRow.ver_luciana !== false;
    } else {
      // Fallback: PIN compartido viejo (settings.ADMIN_CODE) para no romper
      // ningun login previo si la tabla fallara o no tuviera la fila.
      const settings = await getSettings();
      const expected = String(settings.ADMIN_CODE || '2206');
      if (String(p.adminCode || '') !== expected) {
        await tInsert('login_failures',{ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'ADMIN', ip: '' });
        return err(res, 'PIN de administrador incorrecto.');
      }
      adminName = userName;
      verLuciana = true;
    }
    await tInsert('shift_log',{ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'ADMIN', user_name: adminName, action: 'LOGIN' });
    // El PIN acaba de validar contra admin_pins -> recien aqui se emite el token
    // firmado. El PIN NO vuelve a salir del login: lo que el navegador guarda es
    // este token, que caduca solo y no sirve para loguearse.
    return ok(res, { session: { userName: adminName, userRole: 'ADMIN', verLuciana: verLuciana, shiftId: shift, shiftIdRaw: shiftRaw, businessDay: bDay, serverNowMs: now, token: firmarSesion(adminName, 'ADMIN', now) } });
  }

  if (userRole === 'RECEPTION') {
    const { data: pinRow } = await tSelect('reception_pins','pin').eq('user_name', userName).single();
    if (!pinRow) {
      await tInsert('login_failures',{ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'RECEPTION', ip: '' });
      return err(res, 'Recepcionista no autorizada. Contacte al administrador.');
    }
    if (String(p.userPin || '') !== String(pinRow.pin || '')) {
      await tInsert('login_failures',{ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'RECEPTION', ip: '' });
      return err(res, 'PIN incorrecto.');
    }

    // SISTEMA LIBERACION DE TURNOS (items 2,3,4,5):
    // Verificar si el turno anterior cerro correctamente (con cuadre)
    // Admin puede forzar con forceEntry=true
    if(!forceEntry) {
      const prevShiftMap = { SHIFT_1: 'SHIFT_3', SHIFT_2: 'SHIFT_1', SHIFT_3: 'SHIFT_2' };
      const prevShiftId = prevShiftMap[shift];
      // SHIFT_1 busca el T3 del dia anterior
      const prevBDay = shift === 'SHIFT_1' ? businessDay(now - 86400000) : bDay;

      // Ver si el turno anterior tuvo login (hubo recepcionista)
      const { data: prevLogin } = await tSelect('shift_log', 'user_name')
        .eq('business_day', prevBDay)
        .eq('shift_id', prevShiftId)
        .eq('user_role', 'RECEPTION')
        .in('action', ['LOGIN', 'RELOGIN'])
        .order('ts_ms')
        .limit(1);

      if(prevLogin && prevLogin.length) {
        const { data: prevReleased } = await tSelect('shift_log', 'id')
          .eq('business_day', prevBDay)
          .eq('shift_id', prevShiftId)
          .eq('action', 'LOGOUT')
          .eq('released', true)
          .limit(1);

        if(!prevReleased || !prevReleased.length) {
          if(userName.toLowerCase() !== prevLogin[0].user_name.toLowerCase()) {
            // Verificar si el nuevo turno ya fue abierto (nueva logica)
            const { data: newShiftOpen } = await tSelect('shift_log', 'id')
              .eq('business_day', bDay)
              .eq('shift_id', shift)
              .eq('user_role', 'RECEPTION')
              .in('action', ['LOGIN','RELOGIN'])
              .limit(1);
            // Si el nuevo turno NO estaba abierto aun, bloquear
           if(!newShiftOpen || !newShiftOpen.length) {
              // No bloquear — registrar advertencia y dejar entrar
            }
            // Si ya estaba abierto, dejar pasar (turno anterior en pendiente cierre)
          }
        }
      }
    }

    const { data: existing } = await tSelect('shift_log','user_name').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'RECEPTION').eq('action', 'LOGIN').order('ts_ms').limit(1).single();
    if (existing && existing.user_name.toLowerCase() !== userName.toLowerCase()) {
      const { data: logout } = await tSelect('shift_log','id').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'RECEPTION').eq('action', 'LOGOUT').limit(1);
    if (!logout || !logout.length) {
        // No bloquear — permitir reingreso
      }
    }
 await tInsert('shift_log',{ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, action: existing ? 'RELOGIN' : 'LOGIN' });
    if(!existing) {
      // Primer login del turno → congelar snapshot de inventario inicial (inmutable).
      await capturarSnapshotInventarioInicial(bDay, shift, userName, now);
    }
    const { data: lastLogout } = await tSelect('shift_log','logout_ms').eq('business_day', bDay).eq('shift_id', shift).eq('action', 'LOGOUT').order('ts_ms', { ascending: false }).limit(1);
    const fromMs = lastLogout && lastLogout.length ? Number(lastLogout[0].logout_ms || 0) : 0;
    return ok(res, { session: { userName, userRole: 'RECEPTION', shiftId: shift, shiftIdRaw: shiftRaw, businessDay: bDay, serverNowMs: now, fromMs } });
  }

  if (userRole === 'MAINTENANCE') {
    // Login solo por PIN. Ignoramos lo que envia el frontend en userName
    // y usamos el user_name canonico de maintenance_pins en sesion + logs
    const userPin = String(p.userPin || '').trim();
    if (!userPin) return err(res, 'PIN requerido.');
    const { data: pinRows } = await tSelect('maintenance_pins','user_name, active').eq('pin', userPin).limit(1);
    const pinRow = (pinRows && pinRows.length) ? pinRows[0] : null;
    if (!pinRow) {
      await tInsert('login_failures',{ ts_ms: now, user_name: 'maintenance', user_role: 'MAINTENANCE', ip: '' });
      return err(res, 'PIN incorrecto.');
    }
    if (pinRow.active === false) return err(res, 'Mantenedor inactivo.');
    const canonicalName = pinRow.user_name;
    // Sin verificacion de turno (mantenedor no tiene turnos)
    await tInsert('shift_log',{ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'MAINTENANCE', user_name: canonicalName, action: 'LOGIN' });
    return ok(res, { session: { userName: canonicalName, userRole: 'MAINTENANCE', shiftId: shift, shiftIdRaw: shiftRaw, businessDay: bDay, serverNowMs: now } });
  }

  if (userRole === 'MAID') {
    await tInsert('shift_log',{ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'MAID', user_name: userName, action: 'LOGIN' });
    return ok(res, { session: { userName, userRole: 'MAID', shiftId: shift, shiftIdRaw: shiftRaw, businessDay: bDay, serverNowMs: now } });
  }

  return err(res, 'Rol desconocido');
}

// ==================== CHECK-IN ====================
var drawerPending=false;
async function apiOpenDrawer(p, res) {
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Sin permiso');
  drawerPending=true;
  return ok(res,{opened:true});
}
async function apiDrawerPoll(p,res){
  return ok(res,{open:drawerPending});
}
async function apiDrawerAck(p,res){
  drawerPending=false;
  return ok(res,{ack:true});
}
async function openCashDrawer() {
  drawerPending=true;
}

async function apiCheckIn(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const durationHrs = Number(p.durationHrs || 0);
  if (!userName) return err(res, 'Nombre requerido');
  if (!roomId) return err(res, 'roomId requerido');
  if (![3, 6, 8, 12].includes(durationHrs)) return err(res, 'Duracion invalida (3/6/8/12)');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe: ' + roomId);
  if (room.disabled) return err(res, 'Habitacion deshabilitada');
  if (room.state !== 'AVAILABLE') return err(res, `Hab ${roomId} no disponible (${room.state})`);

  // Etapa A: una reserva PAGADA sin activar bloquea la venta manual. Punto de
  // verdad en backend (el front tambien lo bloquea, pero esto cubre RPC forzada
  // o UI desactualizada). Sin gracia: bloquea hasta que se active.
  const { data: reservaViva } = await supabase
    .from('app_reservas')
    .select('habitacion, app_usuarios(nombre)')
    .eq('motel_id', MOTEL_ID)
    .eq('estado', 'PAGADA')
    .is('activacion_ms', null)
    .eq('habitacion', roomId)
    .maybeSingle();
  if (reservaViva) {
    const cli = (reservaViva.app_usuarios && reservaViva.app_usuarios.nombre) || 'cliente';
    return err(res, `Hab ${roomId} reservada por ${cli} — no se puede vender`);
  }

  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);

  const basePrice = calcPrice(durationHrs, cfg);
  if (!basePrice) return err(res, 'Precio no definido para esa duracion');

  const includedPeople = Number(cfg.included || 2);
  const people = Math.max(includedPeople, Number(p.people || includedPeople));
  const extraPeople = Math.max(0, people - includedPeople);
  const extraPeopleValue = extraPeople * Number(cfg.extraPerson || 0);
  // Cortesia: la HABITACION es gratis (basePrice no se cobra), pero las PERSONAS
  // adicionales SI se cobran. (Antes ponia total=0 a todo -> no cobraba personas.)
  const total = room.is_cortesia ? extraPeopleValue : basePrice + extraPeopleValue;
  const dueMs = now + durationHrs * 3600000;

  const arrivalType = String(p.arrivalType || 'WALK').toUpperCase();
  let arrivalPlate = String(p.arrivalPlate || '').toUpperCase().trim();
  if (arrivalType !== 'CAR' && arrivalType !== 'MOTO') arrivalPlate = '';

  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();
  const paidWith = Number(p.paidWith || 0);
  const changeGiven = payMethod === 'EFECTIVO' && paidWith >= total ? Math.max(0, paidWith - total) : 0;
  const mixtoEf = Number(p.mixtoEf || 0);
  const mixtoTj = Number(p.mixtoTj || 0);
  const mixtoNq = Number(p.mixtoNq || 0);

  await tUpdate('rooms',{
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: now, due_ms: dueMs,
    arrival_type: arrivalType, arrival_plate: arrivalPlate,
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0, retoque: false,
    pay_method: payMethod,
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await tInsert('sales',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'SALE',
    room_id: roomId, category: room.category, duration_hrs: durationHrs,
    base_price: basePrice, people, included_people: includedPeople,
    extra_people: extraPeople, extra_people_value: extraPeopleValue,
    extra_hours: 0, extra_hours_value: 0, total,
    arrival_type: arrivalType, arrival_plate: arrivalPlate,
    pay_method: payMethod, paid_with: paidWith, change_given: changeGiven,
    pay_method_2: payMethod==='MIXTO'?'MIXTO_EF_TJ_NQ':'',
    amount_1: payMethod==='MIXTO'?mixtoEf:(payMethod==='EFECTIVO'?total:0),
    amount_2: payMethod==='MIXTO'?mixtoTj:(payMethod==='TARJETA'?total:0),
    amount_3: payMethod==='MIXTO'?mixtoNq:(payMethod==='NEQUI'?total:0),
    check_in_ms: now, due_ms: dueMs
  });

  await tInsert('state_history',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'AVAILABLE', to_state: 'OCCUPIED', people,
    meta_json: JSON.stringify({ durationHrs, basePrice, total, dueMs, arrivalType, arrivalPlate, payMethod, paidWith, changeGiven, checkInMs: now, extraPeople, extraPeopleValue })
  });

  await openCashDrawer();
  return ok(res, { roomId, total, change: changeGiven, checkInMs: now, dueMs });
}

// ==================== ACTIVAR RESERVA (Etapa B/C reservas<->recepcion) ====================
// Nucleo compartido por la activacion MANUAL (apiActivarReserva, con clave) y la AUTO por
// no-show (Etapa C, desde apiGetRooms, por reservaId). NO toca `res`: devuelve un objeto
// resultado {ok:true, comprobante,...} o {ok:false, code, message}.
// La reserva ya se pago online (Wompi): venta origin='WOMPI' SIN cobro en caja; precio y
// duracion salen de la reserva (no se re-cotiza). Doble candado anti-concurrencia:
//   1) CLAIM: UPDATE app_reservas activacion_ms=now WHERE activacion_ms IS NULL (filas
//      afectadas). Serializa entre pollers -> solo uno reclama la reserva.
//   2) UPDATE atomico de rooms WHERE state='AVAILABLE'. Cubre carreras con walk-ins.
//   Si la hab no estaba disponible -> se REVIERTE el claim (activacion_ms=null) y la reserva
//   queda viva (sigue vencida/parpadeando VENCIDA), reintentable en el proximo poll.
async function activarReservaCore({ reservaId, clave, userName, bDay, shift, now }) {
  // 1) Reserva PAGADA sin activar, de ESTE motel. app_reservas NO es tenant -> motel_id explicito.
  let q = supabase.from('app_reservas')
    .select('id, habitacion, categoria, duracion, precio, clave, wompi_transaction_id, app_usuarios(nombre)')
    .eq('motel_id', MOTEL_ID).eq('estado', 'PAGADA').is('activacion_ms', null);
  q = reservaId ? q.eq('id', reservaId) : q.eq('clave', clave);
  const { data: reservas } = await q.limit(2);
  if (!reservas || !reservas.length) return { ok:false, code:'NOT_FOUND', message:'Reserva no encontrada, ya activada o clave invalida' };
  if (reservas.length > 1) return { ok:false, code:'AMBIGUOUS', message:'Clave ambigua — contactar soporte' };
  const reserva = reservas[0];

  // 2) CANDADO 1 — CLAIM: activacion_ms=now solo si sigue NULL. 0 filas => otro poller/
  //    recepcionista ya la reclamo -> abortar sin tocar nada mas.
  const { data: claimed } = await supabase.from('app_reservas')
    .update({ activacion_ms: now })
    .eq('id', reserva.id).eq('motel_id', MOTEL_ID).is('activacion_ms', null)
    .select('id');
  if (!claimed || !claimed.length) return { ok:false, code:'ALREADY_CLAIMED', message:'La reserva ya se esta activando' };
  const revertClaim = async () => {
    await supabase.from('app_reservas').update({ activacion_ms: null }).eq('id', reserva.id).eq('motel_id', MOTEL_ID);
  };

  // Validar hab + duracion. Si no sirve, revertir el claim (reserva vuelve a estar viva).
  const roomId = String(reserva.habitacion || '').trim();
  const durationHrs = parseInt(String(reserva.duracion||'').replace(/\D/g,''), 10) || 0;
  const room = roomId ? await getRoom(roomId) : null;
  if (!room || room.disabled || ![3,6,8,12].includes(durationHrs)) {
    await revertClaim();
    const code = !room ? 'ROOM_NOT_FOUND' : room.disabled ? 'ROOM_DISABLED' : 'BAD_DURATION';
    return { ok:false, code, message:'Habitacion o reserva no activable' };
  }

  const precio = Number(reserva.precio || 0);
  const dueMs = now + durationHrs * 3600000;
  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);
  const people = Number(cfg.included || 2);  // personas = default de la categoria (extras van por addExtraPerson).

  // 3) CANDADO 2 — UPDATE atomico de rooms: solo pega si la hab SIGUE AVAILABLE.
  const { data: updated } = await tUpdate('rooms', {
    state:'OCCUPIED', state_since_ms:now, people,
    check_in_ms:now, due_ms:dueMs,
    arrival_type:'RESERVA', arrival_plate:'',
    alarm_silenced_ms:0, alarm_silenced_for_due_ms:0,
    checkout_obs:'', contaminated_since_ms:0, retoque:false,
    pay_method:'WOMPI',
    updated_at:new Date().toISOString()
  }).eq('room_id', roomId).eq('state', 'AVAILABLE').select('room_id');
  if (!updated || !updated.length) {
    await revertClaim();  // la reserva vuelve a estar viva (VENCIDA), reintentable.
    return { ok:false, code:'ROOM_TAKEN', message:`Hab ${roomId} ya no esta disponible (se ocupo recien)` };
  }

  // 4) Venta origin='WOMPI' SIN cobro. .select('id') -> consecutivo del comprobante (RSV-NNNNNN).
  const { data: ventaRows } = await tInsert('sales', {
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_role:'RECEPTION', user_name:userName, type:'SALE',
    room_id:roomId, category:room.category, duration_hrs:durationHrs,
    base_price:precio, people, included_people:people,
    extra_people:0, extra_people_value:0, extra_hours:0, extra_hours_value:0, total:precio,
    arrival_type:'RESERVA', arrival_plate:'',
    pay_method:'WOMPI', paid_with:0, change_given:0,
    pay_method_2:'', amount_1:0, amount_2:0, amount_3:0,
    check_in_ms:now, due_ms:dueMs,
    cliente_llego_ms: String(userName||'').startsWith('SISTEMA') ? null : now,  // Pieza 6: activar con clave ES la llegada -> ficha al checkout. Poller no-show queda null hasta verificarLlegadaReserva.
    origin:'WOMPI', reserva_id:reserva.id, wompi_transaction_id:reserva.wompi_transaction_id||''
  }).select('id');
  const saleId = (ventaRows && ventaRows[0]) ? ventaRows[0].id : null;

  // 5) Historial de estado (queda registrado quien activo: recepcionista o SISTEMA no-show).
  await tInsert('state_history', {
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_role:'RECEPTION', user_name:userName, room_id:roomId,
    from_state:'AVAILABLE', to_state:'OCCUPIED', people,
    meta_json: JSON.stringify({ origin:'WOMPI', reservaId:reserva.id, clave:reserva.clave, precio, durationHrs, dueMs, checkInMs:now, activadoPor:userName })
  });

  const clienteNombre = (reserva.app_usuarios && reserva.app_usuarios.nombre) || 'cliente';
  // Mismo shape que buildComprobante (este se arma a mano porque la venta recien nace):
  // origin/payMethod van explicitos o la tirilla saldria como VTA- y sin medio de pago.
  const comprobante = {
    comprobanteNum: saleId, activacionMs: now, clave: reserva.clave||'',
    categoria: room.category, durationHrs, precio,
    wompiTransactionId: reserva.wompi_transaction_id||'', roomId,
    shiftId: shift, activadoPor: userName, clienteNombre,
    origin: 'WOMPI', payMethod: 'WOMPI',
    amountEf: 0, amountTj: 0, amountNq: 0
  };
  return { ok:true, roomId, reservaId:reserva.id, clienteNombre, durationHrs, dueMs, precio, comprobante };
}

// Activacion MANUAL (recepcion escanea/digita clave). Wrapper fino sobre el nucleo.
async function apiActivarReserva(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const clave = String(p.clave || '').toUpperCase().trim();
  const reservaId = String(p.reservaId || '').trim();
  if (!userName) return err(res, 'Nombre requerido');
  if (!clave && !reservaId) return err(res, 'Clave o reservaId requerido');
  const r = await activarReservaCore({ reservaId, clave, userName, bDay, shift, now });
  if (!r.ok) {
    if (r.code === 'ALREADY_CLAIMED') return err(res, 'La reserva ya se activó (o se está activando)');
    return err(res, r.message || 'No se pudo activar la reserva');
  }
  return ok(res, { roomId:r.roomId, reservaId:r.reservaId, clienteNombre:r.clienteNombre, durationHrs:r.durationHrs, dueMs:r.dueMs, precio:r.precio, printFactura:true, comprobante:r.comprobante });
}

// Pieza 2 — LLEGADA TARDIA. El cliente no se presento a tiempo, el poller ocupo la
// habitacion por no-show (user_name 'SISTEMA (no-show)') y la tarjeta quedo con el badge
// ambar SIN CLIENTE. Cuando el cliente aparece, dicta su clave y recepcion la verifica aca.
//
// NO pasa por activarReservaCore a proposito: esa reserva YA esta activada (activacion_ms
// seteado) y su rechazo es correcto — evita dobles activaciones. Este es un camino aparte
// que NO activa nada: solo estampa cliente_llego_ms para apagar el badge.
//
// roomId es OPCIONAL:
//   - con roomId (modal de la habitacion): la clave tiene que ser la de ESA habitacion.
//   - sin roomId (escaner global RSV): se resuelve la habitacion a partir de la clave.
// Clave que no corresponde -> rechazo SECO. Nunca se revela a que habitacion pertenece:
// la clave es verificacion de identidad, el mensaje de error no regala informacion.
async function apiVerificarLlegadaReserva(p, res) {
  const now = Date.now();
  const clave = String(p.clave || '').toUpperCase().trim();
  const roomId = String(p.roomId || '').trim();
  const userName = String(p.userName || '').trim();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  if (!clave) return err(res, 'Clave requerida');
  if (!userName) return err(res, 'Nombre requerido');
  const RECHAZO = roomId ? 'Clave incorrecta para esta habitación' : 'Clave incorrecta';

  // 1) Candidatas: ventas WOMPI vivas activadas por SISTEMA que aun no verificaron llegada.
  let q = tSelect('sales','id,room_id,check_in_ms,reserva_id')
    .eq('origin','WOMPI').eq('anulada', false)
    .like('user_name','SISTEMA%').is('cliente_llego_ms', null);
  if (roomId) {
    // Modal: solo la estadia ACTUAL de esa habitacion (no una vieja del mismo cuarto).
    const room = await getRoom(roomId);
    if (!room || room.state !== 'OCCUPIED') return err(res, 'La habitación no está ocupada');
    q = q.eq('room_id', roomId).eq('check_in_ms', Number(room.check_in_ms||0));
  }
  const { data: ventas } = await q;
  if (!ventas || !ventas.length) return err(res, RECHAZO);

  // 2) De esas candidatas, cual tiene ESTA clave. Se compara contra app_reservas via
  //    reserva_id: la clave nunca sale de la BD hacia el front.
  let venta = null, reserva = null;
  for (const v of ventas) {
    if (!v.reserva_id) continue;
    const { data: rv } = await supabase.from('app_reservas')
      .select('id, clave, app_usuarios(nombre)')
      .eq('id', v.reserva_id).eq('motel_id', MOTEL_ID).maybeSingle();
    if (rv && String(rv.clave||'').toUpperCase().trim() === clave) { venta = v; reserva = rv; break; }
  }
  if (!venta) return err(res, RECHAZO);

  // 3) Estampar. El .is(null) hace la operacion idempotente: un doble click no vuelve a
  //    escribir ni duplica la fila de auditoria (0 filas -> salimos sin tocar nada mas).
  const { data: stamped } = await tUpdate('sales', { cliente_llego_ms: now })
    .eq('id', venta.id).is('cliente_llego_ms', null).select('id');
  if (!stamped || !stamped.length) return err(res, 'La llegada ya fue verificada');

  // 4) Auditoria: queda registrado QUIEN verifico la llegada (cliente_llego_ms solo guarda
  //    el cuando). No cambia el estado de la habitacion: sigue OCUPADA de punta a punta.
  const clienteNombre = (reserva.app_usuarios && reserva.app_usuarios.nombre) || 'cliente';
  await tInsert('state_history', {
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: venta.room_id,
    from_state: 'OCCUPIED', to_state: 'OCCUPIED', people: 0,
    meta_json: JSON.stringify({ evento:'LLEGADA_TARDIA', reservaId:reserva.id, saleId:venta.id,
      clienteNombre, verificadoPor:userName, clienteLlegoMs:now })
  });

  return ok(res, { roomId: venta.room_id, clienteNombre, clienteLlegoMs: now });
}

// Arma el objeto comprobante (para imprimir) desde CUALQUIER venta: reserva WOMPI o venta
// de recepcion (efectivo/tarjeta/nequi/mixto). Join a app_reservas para clave/nombre solo
// si la venta vino de reserva. Reusado por la reimpresion por hab, el listado de pendientes
// y el boton Imprimir del cierre.
// amountEf/Tj/Nq: reparto YA guardado del MIXTO (amount_1/2/3). Es el mismo que lee el
// cuadre. No recalcular con calcRepartoMixto: esa funcion PRODUCE estas columnas en doCI,
// y volver a correrla al imprimir daria una segunda fuente que puede divergir.
async function buildComprobante(venta){
  if(!venta) return null;
  let clave='', clienteNombre='cliente';
  if(venta.reserva_id){
    const { data: rv } = await supabase.from('app_reservas')
      .select('clave, app_usuarios(nombre)').eq('id', venta.reserva_id).maybeSingle();
    if(rv){ clave = rv.clave||''; clienteNombre = (rv.app_usuarios && rv.app_usuarios.nombre) || 'cliente'; }
  }
  return {
    comprobanteNum: venta.id, activacionMs: Number(venta.ts_ms||0), clave,
    categoria: venta.category||'', durationHrs: Number(venta.duration_hrs||0), precio: Number(venta.total||0),
    wompiTransactionId: venta.wompi_transaction_id||'', roomId: String(venta.room_id||''),
    shiftId: venta.shift_id||'', activadoPor: venta.user_name||'', clienteNombre,
    businessDay: venta.business_day||'', checkoutMs: Number(venta.checkout_ms||0),
    origin: venta.origin||'', payMethod: String(venta.pay_method||'').toUpperCase(),
    amountEf: Number(venta.amount_1||0), amountTj: Number(venta.amount_2||0), amountNq: Number(venta.amount_3||0)
  };
}

// Comprobante de una reserva ya activada, para REIMPRESION (mismo numero: deriva del
// sales.id de la venta WOMPI). Devuelve {comprobante:null} si la hab no ingreso por reserva.
async function apiGetComprobanteReserva(p, res) {
  const roomId = String(p.roomId||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  const { data: ventas } = await tSelect('sales','*')
    .eq('room_id', roomId).eq('origin','WOMPI').eq('anulada', false)
    .order('ts_ms',{ascending:false}).limit(1);
  return ok(res,{ comprobante: await buildComprobante(ventas && ventas[0]) });
}

// Comprobante de CUALQUIER venta, por su id. A diferencia de getComprobanteReserva (que
// busca la ultima venta de una HABITACION), este apunta a la venta exacta -> lo usa el
// boton Imprimir del listado del cierre/cuadre, donde cada fila es una venta puntual.
async function apiGetComprobante(p, res) {
  const saleId = Number(p.saleId||0);
  if(!saleId) return err(res,'saleId requerido');
  const { data: ventas } = await tSelect('sales','*').eq('id', saleId).limit(1);
  const venta = ventas && ventas[0];
  if(!venta) return err(res,'Venta no encontrada');
  return ok(res,{ comprobante: await buildComprobante(venta) });
}

// Comprobante obligatorio no-bloqueante: TODOS los comprobantes de reserva (venta WOMPI)
// que aun NO se imprimieron, SIN filtro de turno/dia -> para que ninguno se pierda tras el
// checkout ni entre turnos. Solo lectura. Lo usan el cierre de recepcion y el cuadre ADMIN
// (el admin factura en LOGGRO y necesita ver pendientes de dias/turnos anteriores).
async function apiGetComprobantesPendientes(p, res) {
  const { data: ventas } = await tSelect('sales','*')
    .eq('origin','WOMPI').eq('anulada', false).is('comprobante_impreso_ms', null)
    .order('ts_ms',{ascending:true});
  const lista = [];
  for(const v of (ventas||[])){ const c = await buildComprobante(v); if(c) lista.push(c); }
  return ok(res,{ pendientes: lista });
}

// Etapa D: marca el comprobante como impreso (apaga la marca 🧾). Se llama al abrir la
// ventana de impresion (auto de la activacion manual o via Reimprimir).
async function apiMarcarComprobanteImpreso(p, res) {
  const comprobanteNum = Number(p.comprobanteNum||0);
  if(!comprobanteNum) return err(res,'comprobanteNum requerido');
  const now = Date.now();
  await tUpdate('sales',{ comprobante_impreso_ms: now })
    .eq('id', comprobanteNum).eq('origin','WOMPI').is('comprobante_impreso_ms', null);
  return ok(res,{ comprobanteNum, impresoMs: now });
}

// ==================== PIEZA 6 — CIERRE + CALIFICACION ====================
// Mientras la estadia esta viva, la app cliente muestra una pantalla persistente con el
// cronometro. Lo unico que la saca de ahi es app_reservas.salida_ms. Este helper es el que
// la escribe, y de paso crea la ficha de calificacion cuando corresponde.
//
// ORDEN OBLIGATORIO: primero la FICHA, DESPUES salida_ms. Nunca al reves.
//   La app decide si pedir calificacion por la EXISTENCIA de la ficha (no hay flag aparte).
//   Si salida_ms se escribiera primero, el cliente podria hacer polling justo en el hueco:
//   veria salida_ms, buscaria la ficha, no la encontraria todavia, y se saltearia la
//   calificacion PARA SIEMPRE. Con este orden, salida_ms significa "todo listo".
//
// SIN FICHA en dos casos (el cliente sale igual de la pantalla, pero no se le pide calificar
// una estadia que no existio):
//   - no-show que nunca llego  -> sales.cliente_llego_ms IS NULL
//   - venta anulada            -> crearFicha=false desde apiAnularVenta
//
// La habitacion de la ficha sale de sales.room_id, NO de app_reservas.habitacion: si hubo
// cambio de habitacion a mitad de estadia, la venta se mudo al cuarto nuevo y la reserva
// quedo con el original (apiRoomChange mueve la venta, no la reserva).
//
// El llamador SIEMPRE lo envuelve en try/catch: un fallo aca no puede tumbar el checkout ni
// la anulacion. La habitacion ya quedo liberada antes de llegar a este punto.
async function cerrarEstadiaReserva({ venta, now, userName, crearFicha }) {
  if (!venta) return;
  if (String(venta.origin || '') !== 'WOMPI' || !venta.reserva_id) return;   // venta de mostrador: nada que hacer

  // 1) FICHA (solo si la estadia realmente ocurrio).
  if (crearFicha && !venta.anulada && venta.cliente_llego_ms != null) {
    const { data: rv } = await supabase.from('app_reservas')
      .select('usuario_id').eq('id', venta.reserva_id).eq('motel_id', MOTEL_ID).maybeSingle();
    if (rv && rv.usuario_id) {
      // upsert ignoreDuplicates: reserva_id es UNIQUE -> reintentos no duplican la ficha.
      await supabase.from('app_calificaciones').upsert({
        motel_id: MOTEL_ID,
        reserva_id: venta.reserva_id,
        usuario_id: rv.usuario_id,
        habitacion: String(venta.room_id || ''),
        comprobante_num: venta.id,
        entrada_ms: Number(venta.check_in_ms || venta.ts_ms || 0),
        salida_ms: now,
        duracion_hrs: Number(venta.duration_hrs || 0),
        valor: Number(venta.total || 0),
        recepcionista: userName || '',
        estrellas: null, resena: null, calificado_ms: null
      }, { onConflict: 'reserva_id', ignoreDuplicates: true });
    }
  }

  // 2) SALIDA (siempre, aunque no haya ficha: el cliente tiene que salir de la pantalla).
  //    El .is(null) lo hace idempotente: si ya se cerro, no se pisa la fecha original.
  await supabase.from('app_reservas')
    .update({ salida_ms: now })
    .eq('id', venta.reserva_id).eq('motel_id', MOTEL_ID).is('salida_ms', null);
}

// ==================== CHECK-OUT ====================
async function apiCheckOut(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const obs = String(p.checkoutObs || p.obs || '').trim();
  const force = !!(p.force === true || p.force === 'true');
  if (!roomId) return err(res, 'roomId requerido');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo checkout si OCUPADA');

  const dueMs = Number(room.due_ms || 0);
  if (!force && dueMs > now) {
    const minsLeft = Math.round((dueMs - now) / 60000);
    return res.status(200).json({ ok: false, warning: true, minsLeft, message: `Hay ${minsLeft} min pagados aun. Confirmar checkout?` });
  }

  await tUpdate('rooms',{
    state: 'DIRTY', state_since_ms: now, people: 0,
    due_ms: 0, last_checkout_ms: now,
    arrival_type: '', arrival_plate: '',
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: obs, contaminated_since_ms: 0,
    pay_method: '',
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await tInsert('state_history',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'OCCUPIED', to_state: 'DIRTY', people: 0,
    meta_json: JSON.stringify({ lastCheckoutMs: now, checkoutObs: obs })
  });

  const VENTA_COLS = 'id, reserva_id, origin, user_name, cliente_llego_ms, room_id, category, duration_hrs, total, ts_ms, check_in_ms, anulada';
  const checkInMs = Number(room.check_in_ms || 0);
  let ventaEstadia = null;
  if (checkInMs > 0) {
    // Mismo UPDATE de siempre; el .select() solo pide de vuelta las filas que toco, para
    // saber si la estadia vino de reserva (Pieza 6). No agrega una query.
    const { data: filas } = await tUpdate('sales', { checkout_ms: now })
      .eq('room_id', roomId)
      .eq('type', 'SALE')
      .eq('check_in_ms', checkInMs)
      .select(VENTA_COLS);
    ventaEstadia = (filas && filas[0]) || null;

    // RESCATE: si el UPDATE no matcheo nada, la venta pudo haberse anulado desde el modulo
    // de ajustes (apiAnularVentaModulo la deja en type='ANULADA' y NO libera la habitacion,
    // asi que el checkout llega igual). Sin esto, salida_ms nunca se escribiria y el cliente
    // quedaria atrapado en la pantalla persistente para siempre. Solo corre cuando el UPDATE
    // fallo -> nunca en el flujo normal.
    if (!ventaEstadia) {
      const { data: resc } = await tSelect('sales', VENTA_COLS)
        .eq('room_id', roomId).eq('check_in_ms', checkInMs).eq('origin', 'WOMPI').limit(1);
      ventaEstadia = (resc && resc[0]) || null;
    }
  }

  // Pieza 6: liberar al cliente de la pantalla persistente + crear su ficha de calificacion.
  // NO bloqueante: la habitacion ya quedo en DIRTY y el historial ya se escribio arriba, asi
  // que un fallo de Supabase aca no puede impedirle a recepcion cerrar la habitacion.
  // Una venta de mostrador (origin distinto de WOMPI) sale del helper en la primera linea.
  try {
    await cerrarEstadiaReserva({ venta: ventaEstadia, now, userName, crearFicha: true });
  } catch (e) {
    console.error('apiCheckOut cierre de reserva (no bloqueante):', e);
  }

  // Auto-bloqueo (G3): si la habitación que recién hizo checkout tiene un daño
  // urgente activo, bloquearla. La habitación ya está en estado DIRTY a esta altura,
  // así que el helper bloqueará sin problema (no rechaza por OCCUPIED). Cualquier
  // error acá se loggea pero NO se propaga — el checkout no debe fallar por esto.
  try {
    const { data: urgentes } = await tSelect('room_issues', 'id, description')
      .eq('anulada', false)
      .eq('ubicacion_tipo', 'habitacion')
      .eq('ubicacion_id', roomId)
      .eq('prioridad', 'urgente')
      .in('estado', ['NOTA_ACTIVA','RECHAZADO_VERIFICACION','ESPERA_VERIFICACION']);
    if(urgentes && urgentes.length > 0){
      await bloquearPorDanoUrgenteSiCorresponde(roomId, urgentes[0].description, userName);
    }
  } catch (e) {
    console.error('apiCheckOut hook auto-bloqueo (no bloqueante):', e);
  }

  return ok(res, { roomId, checkoutMs: now });
}

// ==================== EXTENDER TIEMPO ====================
async function apiExtendTime(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const extraHrs = Number(p.extraHrs || 0);
  if (![1,2,3,4,5,6].includes(extraHrs)) return err(res, 'Horas extra invalidas (1-6)');
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');
  const noteIn = String(p.note || '').trim();
  if (noteIn === 'AUTO') {
    const dueMsServer = Number(room.due_ms || 0);
    if (!dueMsServer || now - dueMsServer < 30*60*1000) {
      return err(res, 'Auto-cobro rechazado: habitacion no esta vencida >= 30min en servidor');
    }
  }
  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);
  const extraCost = extraHrs * Number(cfg.extraHour || 0);
  const newDueMs = Number(room.due_ms || now) + extraHrs * 3600000;
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();
  const note = noteIn;
  await tUpdate('rooms',{ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await tInsert('sales',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'EXTENSION',
    room_id: roomId, category: room.category, duration_hrs: extraHrs,
    base_price: extraCost, people: Number(room.people || 0),
    extra_hours: extraHrs, extra_hours_value: extraCost, total: extraCost,
    pay_method: payMethod, check_in_ms: Number(room.check_in_ms || 0), due_ms: newDueMs,
    note: note
  });
  await openCashDrawer();
  return ok(res, { roomId, extraCost, newDueMs });
}

// ==================== CAMBIAR DURACION (+ HORAS) ====================
// Sube la duracion de una venta activa MANTENIENDO la hora de ENTRADA original
// (3h entro 4pm -> 8h = sale 12am). Solo AUMENTAR. NO toca apiExtendTime/apiRenewTime.
// Regla de Oro: la venta original queda INTACTA; la diferencia se cobra en una FILA
// NUEVA con el turno del MOMENTO. La fila reusa type='EXTENSION' (para que entre a
// todos los agregadores del cuadre sin tocarlos) + marca en note='CAMBIO DURACION'.
async function apiCambiarDuracion(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const nuevaDur = Number(p.nuevaDur || 0);
  if (![3,6,8,12].includes(nuevaDur)) return err(res, 'Duracion invalida (3/6/8/12)');
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');
  const checkInMs = Number(room.check_in_ms || 0);
  if (!checkInMs) return err(res, 'La habitacion no tiene hora de ingreso');

  // Venta base original de ESTA estadia (para saber la duracion y el precio ya pagado).
  const { data: ventaBase } = await tSelect('sales','base_price,duration_hrs')
    .eq('room_id', roomId).eq('type', 'SALE').eq('check_in_ms', checkInMs)
    .order('ts_ms', { ascending: true }).limit(1).maybeSingle();
  if (!ventaBase) return err(res, 'No se encontro la venta base de la estadia');
  const origDur = Number(ventaBase.duration_hrs || 0);
  const origBase = Number(ventaBase.base_price || 0);
  if (nuevaDur <= origDur) return err(res, `Solo se puede AUMENTAR (la duracion ya es ${origDur}h)`);

  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);
  const precioNuevo = calcPrice(nuevaDur, cfg);
  if (!precioNuevo) return err(res, 'Precio no definido para esa duracion');
  const diff = precioNuevo - origBase;   // diferencia de duracion (se cobra aun en cortesia: la cortesia es solo la hab base)
  if (diff <= 0) return err(res, 'La diferencia a cobrar debe ser positiva');

  const nuevoDue = checkInMs + nuevaDur * 3600000;   // recalcula la SALIDA desde la ENTRADA
  if (nuevoDue <= Number(room.due_ms || 0)) return err(res, 'La nueva salida debe ser posterior a la actual (hay extensiones que ya cubren ese tiempo)');
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();

  await tUpdate('rooms',{ due_ms: nuevoDue, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await tInsert('sales',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'EXTENSION',
    room_id: roomId, category: room.category, duration_hrs: (nuevaDur - origDur),
    base_price: diff, people: Number(room.people || 0),
    extra_hours: (nuevaDur - origDur), extra_hours_value: diff, total: diff,
    pay_method: payMethod, check_in_ms: checkInMs, due_ms: nuevoDue,
    note: 'CAMBIO DURACION ' + origDur + 'h->' + nuevaDur + 'h'
  });
  await openCashDrawer();
  return ok(res, { roomId, diff, nuevoDue, nuevaDur, origDur });
}

async function apiHoraGratis(p, res) {
  const now = Date.now();
  const roomId = String(p.roomId || '').trim();
  const room = await getRoom(roomId);
  if(!room) return err(res, 'Habitacion no existe');
  if(room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');
  const checkInMs = Number(room.check_in_ms || 0);
  const { data: existing } = await tSelect('sales', 'id').eq('room_id', roomId).eq('type', 'HORA_GRATIS')
    .gte('check_in_ms', checkInMs).limit(1);
  if(existing && existing.length) return err(res, 'Ya se obsequio la hora gratis para esta habitacion');
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const newDueMs = Number(room.due_ms || now) + 3600000;
  await tUpdate('rooms',{ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await tInsert('sales',{ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, type: 'HORA_GRATIS', room_id: roomId, category: room.category, total: 0, pay_method: 'EFECTIVO', check_in_ms: checkInMs });
  return ok(res, { roomId, newDueMs });
}

// ==================== RENOVAR TIEMPO ====================
async function apiRenewTime(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const durationHrs = Number(p.durationHrs || 0);
  if (![3, 6, 8, 12].includes(durationHrs)) return err(res, 'Duracion invalida para renovar (3/6/8/12)');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');

  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);
  const renewPrice = calcPrice(durationHrs, cfg);
  if (!renewPrice) return err(res, 'Precio no definido para esa duracion');

  const newDueMs = Number(room.due_ms || now) + durationHrs * 3600000;
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();

  await tUpdate('rooms',{ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await tInsert('sales',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'RENEWAL',
    room_id: roomId, category: room.category, duration_hrs: durationHrs,
    base_price: renewPrice, people: Number(room.people || 0),
    extra_hours: 0, extra_hours_value: 0, total: renewPrice,
    pay_method: payMethod, check_in_ms: Number(room.check_in_ms || 0), due_ms: newDueMs
  });

  return ok(res, { roomId, renewPrice, newDueMs, durationHrs });
}

// ==================== ALARMA ====================
async function apiSilenceAlarm(p, res) {
  const roomId = String(p.roomId || '').trim();
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  await tUpdate('rooms',{ alarm_silenced_ms: Date.now(), alarm_silenced_for_due_ms: Number(room.due_ms || 0), updated_at: new Date().toISOString() }).eq('room_id', roomId);
  return ok(res, { roomId });
}

// ==================== CAMARERA: TOMAR HABITACION ====================
async function apiMaidTake(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const maidName = String(p.maidName || p.userName || '').trim();
  if (!maidName) return err(res, 'Nombre requerido');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'DIRTY' && room.state !== 'CONTAMINATED' && !room.retoque) return err(res, 'Hab debe estar SUCIA o CONTAMINADA');
  if(room.retoque){
    await tUpdate('rooms',{retoque:false,state:'AVAILABLE',state_since_ms:now,updated_at:new Date().toISOString()}).eq('room_id',roomId);
    return ok(res,{roomId,maidName,startedMs:now,retoque:true});
  }

  await tInsert('maid_log',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    maid_name: maidName, room_id: roomId,
    action: 'START', state: room.state, note: '',
    started_ms: now, finished_ms: 0,
    state_from: room.state, state_to: '',
    check_in_ms: Number(room.check_in_ms || 0),
    checkout_ms: Number(room.last_checkout_ms || 0),
    category: String(room.category || '')
  });
  await tUpdate('rooms',{
    maid_in_progress: true,
    maid_name_progress: maidName,
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  return ok(res, { roomId, maidName, startedMs: now });
}

// ==================== CAMARERA: TERMINAR HABITACION ====================
async function apiMaidFinish(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const maidName = String(p.maidName || p.userName || '').trim();
  const resultState = String(p.resultState || 'AVAILABLE');
  if (!['AVAILABLE', 'CONTAMINATED'].includes(resultState)) return err(res, 'Estado invalido');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'DIRTY' && room.state !== 'CONTAMINATED') return err(res, 'Hab debe estar SUCIA o CONTAMINADA');

  const { data: openLog } = await tSelect('maid_log', 'id, started_ms, ts_ms')
    .eq('maid_name', maidName).eq('room_id', roomId).eq('business_day', bDay)
    .eq('action', 'START').eq('finished_ms', 0)
    .order('ts_ms', { ascending: false }).limit(1);

  let startedMs = openLog && openLog.length ? Number(openLog[0].started_ms || openLog[0].ts_ms) : now;
  const lastCheckoutMs = Number(room.last_checkout_ms || 0);
  const dirtyMins = lastCheckoutMs ? Math.max(0, Math.round((now - lastCheckoutMs) / 60000)) : 0;
  const cleanMins = Math.max(0, Math.round((now - startedMs) / 60000));

  await tUpdate('rooms',{
    state: resultState, state_since_ms: now,
    last_maid_name: maidName, last_maid_done_ms: now,
    contaminated_since_ms: resultState === 'CONTAMINATED' ? now : 0,
    maid_in_progress: resultState === 'CONTAMINATED' ? true : false,
    maid_name_progress: resultState === 'CONTAMINATED' ? maidName : '',
    retoque: false,
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await tInsert('state_history',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'MAID', user_name: maidName, room_id: roomId,
    from_state: room.state, to_state: resultState, people: 0,
    meta_json: JSON.stringify({ maidName, lastCheckoutMs, startedMs, finishedMs: now, dirtyMins, cleanMins, contaminated: resultState === 'CONTAMINATED' })
  });

  if (openLog && openLog.length) {
    if(resultState !== 'CONTAMINATED'){
      await tUpdate('maid_log',{
        action: 'FINISH', finished_ms: now, state_to: resultState,
        note: p.note || ''
      }).eq('id', openLog[0].id);
    }
  } else {
    if(resultState !== 'CONTAMINATED'){
      await tInsert('maid_log',{
        ts_ms: now, business_day: bDay, shift_id: shift,
        maid_name: maidName, room_id: roomId,
        action: 'FINISH', state: resultState, note: p.note || '',
        started_ms: startedMs, finished_ms: now,
        state_from: room.state, state_to: resultState
      });
    }
  }

  return ok(res, { roomId, dirtyMins, cleanMins, startedMs, finishedMs: now });
}

async function apiMaidLogAction(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const maidName = String(p.maidName || p.userName || '').trim();
  if (!maidName) return err(res, 'Nombre requerido');
  await tInsert('maid_log',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    maid_name: maidName, room_id: String(p.roomId || ''),
    action: String(p.action || ''), state: String(p.state || ''), note: String(p.note || ''),
    started_ms: now, finished_ms: 0, state_from: '', state_to: ''
  });
  return ok(res, {});
}

async function apiMaidMarkExit(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const maidName = String(p.maidName || '').trim();
  const roomId = String(p.roomId || '').trim();
  await tUpdate('maid_log',{ finished_ms: now }).eq('maid_name', maidName).eq('room_id', roomId).eq('business_day', bDay).eq('finished_ms', 0);
  return ok(res, { exitMs: now });
}

async function apiGetMaidLog(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await tSelect('maid_log','*').eq('business_day', bDay).order('ts_ms');
  return ok(res, {
    logs: (data || []).map(r => ({
      id: r.id, tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id,
      maidName: r.maid_name, roomId: r.room_id, action: r.action, state: r.state,
      note: r.note, startedMs: Number(r.started_ms || r.ts_ms || 0),
      finishedMs: Number(r.finished_ms || 0),
      stateFrom: r.state_from || '', stateTo: r.state_to || '',
      category: r.category || '',
      checkInMs: Number(r.check_in_ms || 0),
      checkoutMs: Number(r.checkout_ms || 0)
    }))
  });
}

// ==================== ACCIONES HABITACION ====================
async function apiClearContaminated(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const userName = String(p.userName || '').trim();
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'CONTAMINATED') return err(res, 'Solo si CONTAMINADA');

  await tUpdate('rooms',{
    state: 'AVAILABLE', state_since_ms: now, contaminated_since_ms: 0,
    maid_in_progress: false, maid_name_progress: '',
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await tInsert('state_history',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: p.userRole||'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'CONTAMINATED', to_state: 'AVAILABLE', people: 0,
    meta_json: JSON.stringify({action:'clearContaminated', maidName: userName})
  });

  const { data: openLog } = await tSelect('maid_log', 'id, started_ms')
    .eq('room_id', roomId).eq('business_day', bDay)
    .eq('action', 'START').eq('finished_ms', 0)
    .order('ts_ms', { ascending: false }).limit(1);

  if (openLog && openLog.length) {
    await tUpdate('maid_log',{
      action: 'FINISH', finished_ms: now, state_to: 'AVAILABLE',
      note: p.note || '',
      check_in_ms: Number(room.check_in_ms || 0),
      checkout_ms: Number(room.last_checkout_ms || 0),
      category: String(room.category || '')
    }).eq('id', openLog[0].id);
  } else {
    await tInsert('maid_log',{
      ts_ms: now, business_day: bDay, shift_id: shift,
      maid_name: userName, room_id: roomId,
      action: 'FINISH', state: 'AVAILABLE', note: '',
      started_ms: now, finished_ms: now,
      state_from: 'CONTAMINATED', state_to: 'AVAILABLE',
      check_in_ms: Number(room.check_in_ms || 0),
      checkout_ms: Number(room.last_checkout_ms || 0),
      category: String(room.category || '')
    });
  }

  return ok(res, { roomId });
}

async function apiSetMinorNote(p, res) {
  const roomId = String(p.roomId || '').trim();
  const enabled = !!p.enabled;
  const text = String(p.text || '').trim();
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  await tUpdate('rooms',{
    note_minor: enabled,
    note_minor_text: enabled ? text : '',
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);
  return ok(res, { roomId, noteMinor: enabled });
}

async function apiSetDisabled(p, res) {
  const userRole = String(p.userRole || '').toUpperCase();
  const disableFlag = !!p.enabled;
  if (userRole !== 'ADMIN' && userRole !== 'RECEPTION') return err(res, 'Solo ADMIN o RECEPTION');
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const reason = String(p.reason || '').trim();
  if (disableFlag && reason.length < 3) return err(res, 'Motivo obligatorio');
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  await tUpdate('rooms',{ disabled: disableFlag, disabled_date_ms: disableFlag ? now : 0, disabled_reason: disableFlag ? reason : '', updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await tInsert('maintenance',{ ts_ms: now, business_day: bDay, shift_id: shift, user_role: userRole, user_name: String(p.userName || 'ADMIN'), room_id: roomId, type: disableFlag ? 'DISABLE' : 'ENABLE', text: disableFlag ? reason : 'HABILITADA', repair_desc: String(p.repairDesc||''), repair_cost: Number(p.repairCost||0) });
  return ok(res, { roomId, disabled: disableFlag });
}

// ==================== HABITACIONES CRUD (Configuracion, ADMIN) ====================
// Lista TODAS las habitaciones incl. archivadas (para el editor; el editor necesita
// poder reactivar). La grilla operativa filtra archived=false aparte.
async function apiGetRoomsAdmin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const { data, error } = await tSelect('rooms','*').order('floor').order('room_id');
  if(error) return err(res, error.message);
  return ok(res, { rooms: (data||[]).map(mapRoom) });
}
// Valida que la categoria exista y este activa en este motel. Devuelve true/false.
async function categoriaActiva(nombreDb) {
  const { data } = await tSelect('app_categorias', 'id').eq('nombre_db', nombreDb).eq('activo', true).maybeSingle();
  return !!data;
}
// Alta de habitacion. ADMIN. room_id unico + floor entero>0 + categoria activa.
async function apiCreateRoom(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const roomId = String(p.roomId||'').trim();
  const floor = Number(p.floor);
  const category = String(p.category||'').trim();
  if(!roomId) return err(res,'Número de habitación requerido');
  if(!Number.isInteger(floor) || floor <= 0) return err(res,'Piso inválido (entero > 0)');
  if(!category) return err(res,'Categoría requerida');
  if(!(await categoriaActiva(category))) return err(res,'La categoría no existe o está inactiva: '+category);
  const { data: existe } = await tSelect('rooms','room_id').eq('room_id', roomId).maybeSingle();
  if(existe) return err(res,'Ya existe una habitación con el número '+roomId);
  const now = Date.now();
  const { error: insErr } = await tInsert('rooms',{
    room_id: roomId, floor, category, state: 'AVAILABLE', state_since_ms: now,
    disabled: false, archived: false, people: 0, updated_at: new Date().toISOString()
  });
  if(insErr) return err(res, insErr.message);
  return ok(res, { roomId });
}
// Edita SOLO floor + category. room_id NO se toca (inmutable). ADMIN.
async function apiEditRoom(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const roomId = String(p.roomId||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  const floor = Number(p.floor);
  if(!Number.isInteger(floor) || floor <= 0) return err(res,'Piso inválido (entero > 0)');
  const category = String(p.category||'').trim();
  if(!category) return err(res,'Categoría requerida');
  if(!(await categoriaActiva(category))) return err(res,'La categoría no existe o está inactiva: '+category);
  const { data, error } = await tUpdate('rooms', { floor, category, updated_at: new Date().toISOString() })
    .eq('room_id', roomId).select('room_id').maybeSingle();
  if(error) return err(res, error.message);
  if(!data) return err(res,'Habitación no encontrada');
  return ok(res, { roomId, floor, category });
}
// Baja/alta logica (archived). Al archivar BLOQUEA si esta OCCUPIED. Nunca DELETE. ADMIN.
async function apiArchiveRoom(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const roomId = String(p.roomId||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  const archived = p.archived === true;
  const room = await getRoom(roomId);
  if(!room) return err(res,'Habitación no encontrada');
  if(archived && String(room.state) === 'OCCUPIED') return err(res,'No se puede archivar una habitación ocupada');
  const { error } = await tUpdate('rooms', { archived, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  if(error) return err(res, error.message);
  return ok(res, { roomId, archived });
}

// ITEM 9: Devolucion - descuenta solo el monto indicado
async function apiRefund(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const amount = Math.max(1, Number(p.amount || 0));
  const reason = String(p.refundReason || '').trim();
  if (reason.length < 3) return err(res, 'Motivo obligatorio');
  const room = await getRoom(roomId);
  // Insertar devolucion como venta negativa - se descuenta del cuadre automaticamente
  await tInsert('sales',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'REFUND',
    room_id: roomId, category: room ? room.category : '',
    total: -amount, // negativo para que se reste del total
    refund_reason: reason,
    pay_method: 'EFECTIVO',
    check_in_ms: room ? Number(room.check_in_ms || 0) : 0
  });
  return ok(res, { roomId, total: -amount, amount });
}

async function apiTaxi(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const { data } = await tInsert('taxi_expenses',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: String(p.userName || ''),
    amount: 3000, note: 'Taxi fijo', room_id: roomId
  }).select().single();
  return ok(res, { id: data ? data.id : null });
}

// ITEM 7: Eliminar taxi
async function apiDeleteTaxi(p, res) {
  const userRole = String(p.userRole || '').toUpperCase();
  if(userRole !== 'RECEPTION' && userRole !== 'ADMIN') return err(res, 'Sin permiso');
  const id = Number(p.id || 0);
  const motivo = String(p.motivo || '').trim();
  const userName = String(p.userName || '').trim();
  if(!id) return err(res, 'id requerido');
  if(!motivo || motivo.length < 5) return err(res, 'Motivo requerido (min 5 caracteres)');
  const { data: taxi, error: errTaxi } = await tSelect('taxi_expenses','*').eq('id', id).maybeSingle();
  if(errTaxi) return err(res, errTaxi.message);
  if(!taxi) return err(res, 'Taxi no encontrado');
  if(taxi.anulada) return err(res, 'Este taxi ya está anulado');
  const now = Date.now();
  await tUpdate('taxi_expenses',{
    anulada: true,
    anulada_ms: now,
    anulada_por: userName,
    motivo_anulacion: motivo
  }).eq('id', id);
  return ok(res, { anulada: true, id });
}

// Lista taxis del turno (incluye anulados para mostrar historial visual)
async function apiListTaxisTurno(p, res) {
  const userRole = String(p.userRole || '').toUpperCase();
  if(userRole !== 'RECEPTION' && userRole !== 'ADMIN') return err(res, 'Sin permiso');
  const businessDay_ = String(p.businessDay || '').trim();
  const shiftId = String(p.shiftId || '').trim();
  if(!businessDay_) return err(res, 'businessDay requerido');
  if(!shiftId) return err(res, 'shiftId requerido');
  const { data, error } = await tSelect('taxi_expenses', '*')
    .eq('business_day', businessDay_)
    .eq('shift_id', shiftId)
    .order('ts_ms');
  if(error) return err(res, error.message);
  return ok(res, { taxis: data || [] });
}

// ==================== PRESTAMOS ====================
async function apiAddLoan(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const borrowerName = String(p.borrowerName || '').trim();
  const amount = Number(p.amount || 0);
  if (!borrowerName) return err(res, 'Nombre requerido');
  if (amount <= 0) return err(res, 'Monto invalido');
  await tInsert('loans',{ ts_ms: now, business_day: bDay, shift_id: shift, user_name: String(p.userName || ''), borrower_name: borrowerName, amount, note: String(p.note || '') });
  return ok(res, {});
}

async function apiGetLoans(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await tSelect('loans','*').eq('business_day', bDay).eq('anulada', false).order('ts_ms');
  return ok(res, { loans: (data || []).map(r => ({ tsMs: Number(r.ts_ms), shiftId: r.shift_id, userName: r.user_name, borrowerName: r.borrower_name, amount: Number(r.amount), note: r.note })) });
}

// ==================== PERSONAL EXTRA ====================
async function apiRegisterExtra(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const personName = String(p.personName || '').trim();
  const area = String(p.area || 'Servicios').trim();
  const entryMs = Number(p.entryMs || now);
  const scheduledExitMs = Number(p.scheduledExitMs || 0);
  const workHours = Number(p.workHours || 0);
  if (!personName) return err(res, 'Nombre requerido');
  await tInsert('extra_staff',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    registered_by: String(p.userName || ''),
    person_name: personName, entry_ms: entryMs,
    area, active: true, exit_ms: 0, payment: 0,
    scheduled_exit_ms: scheduledExitMs, work_hours: workHours
  });
  return ok(res, { personName, area, shiftId: shift, businessDay: bDay, scheduledExitMs, workHours });
}

async function apiUpdateExtra(p, res) {
  const id = Number(p.id || 0);
  if (!id) return err(res, 'ID requerido');
  const personName = String(p.personName || '').trim();
  const area = String(p.area || 'Servicios').trim();
  const entryMs = Number(p.entryMs || 0);
  const scheduledExitMs = Number(p.scheduledExitMs || 0);
  const workHours = Number(p.workHours || 0);
  const shift = String(p.shiftId || '');
  if (!personName) return err(res, 'Nombre requerido');
  await tUpdate('extra_staff',{
    person_name: personName, area, entry_ms: entryMs,
    scheduled_exit_ms: scheduledExitMs, work_hours: workHours,
    shift_id: shift
  }).eq('id', id);
  return ok(res, { updated: true });
}

async function apiDeleteExtra(p, res) {
  const userRole = String(p.userRole || '').toUpperCase();
  if(userRole !== 'RECEPTION' && userRole !== 'ADMIN') return err(res, 'Sin permiso');
  const id = Number(p.id || 0);
  const motivo = String(p.motivo || '').trim();
  const userName = String(p.userName || '').trim();
  if(!id) return err(res, 'ID requerido');
  if(!motivo || motivo.length < 5) return err(res, 'Motivo requerido (min 5 caracteres)');
  const { data: extra, error: errExtra } = await tSelect('extra_staff','*').eq('id', id).maybeSingle();
  if(errExtra) return err(res, errExtra.message);
  if(!extra) return err(res, 'Personal extra no encontrado');
  if(extra.anulada) return err(res, 'Este personal extra ya está anulado');
  const now = Date.now();
  await tUpdate('extra_staff',{
    anulada: true,
    anulada_ms: now,
    anulada_por: userName,
    motivo_anulacion: motivo
  }).eq('id', id);
  return ok(res, { anulada: true, id });
}

// Lista personal extra del turno (incluye anulados para mostrar historial visual)
async function apiListExtrasTurno(p, res) {
  const userRole = String(p.userRole || '').toUpperCase();
  if(userRole !== 'RECEPTION' && userRole !== 'ADMIN') return err(res, 'Sin permiso');
  const businessDay_ = String(p.businessDay || '').trim();
  const shiftId = String(p.shiftId || '').trim();
  if(!businessDay_) return err(res, 'businessDay requerido');
  if(!shiftId) return err(res, 'shiftId requerido');
  const { data, error } = await tSelect('extra_staff', '*')
    .eq('business_day', businessDay_)
    .eq('shift_id', shiftId)
    .order('ts_ms');
  if(error) return err(res, error.message);
  return ok(res, { extras: data || [] });
}

async function apiCheckoutExtra(p, res) {
  const now = Date.now();
  const personName = String(p.personName || '').trim();
  const payment = Number(p.payment || 0);
  const exitMs = Number(p.exitMs || now);
  const paidBy = String(p.paidBy || p.userName || '').trim();
  if (!personName) return err(res, 'Nombre requerido');
  if (payment <= 0) return err(res, 'Pago requerido');

  const { data } = await tSelect('extra_staff','id').eq('person_name', personName).eq('active', true).order('ts_ms', { ascending: false }).limit(1);
  if (!data || !data.length) return err(res, `No se encontro "${personName}" activo`);

  await tUpdate('extra_staff',{ exit_ms: exitMs, payment, active: false, paid_ms: now, paid_by: paidBy }).eq('id', data[0].id);
  return ok(res, { personName, payment, paidBy });
}

async function apiGetExtra(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await tSelect('extra_staff','*').eq('business_day', bDay).eq('anulada', false).order('ts_ms');
  return ok(res, {
    extraStaff: (data || []).map(r => ({
      id: r.id, tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id,
      personName: r.person_name, area: r.area,
      entryMs: Number(r.entry_ms || 0), exitMs: Number(r.exit_ms || 0),
      payment: Number(r.payment || 0), active: r.active,
      paidMs: Number(r.paid_ms || 0), paidBy: r.paid_by || '',
      registeredBy: r.registered_by || '',
      scheduledExitMs: Number(r.scheduled_exit_ms || 0),
      workHours: Number(r.work_hours || 0)
    }))
  });
}

// ==================== NOTAS ====================
async function apiReviewNote(p, res) {
  const noteId = Number(p.noteId || 0);
  const photoUrl = String(p.photoUrl || '');
  if(!noteId) return err(res, 'noteId requerido');
  if(photoUrl){
    try {
      const fileName = photoUrl.split('/').pop();
      await supabase.storage.from('maid-photos').remove([fileName]);
    } catch(e) { console.error('Error borrando foto:', e); }
  }
  await tUpdate('shift_notes',{photo_url: null}).eq('id', noteId);
  return ok(res, {});
}

async function apiAddNote(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const target = String(p.target || 'ALL').toUpperCase();
  let photoUrl = null;
  if(p.photoUrl){ photoUrl = String(p.photoUrl); }
  await tInsert('shift_notes',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: String(p.userRole || ''), user_name: String(p.userName || ''),
    note: String(p.note || ''), target,
    seen_by: '[]', is_deleted: false,
    photo_url: photoUrl
  });
  return ok(res, {});
}

// Rediseño Reportes: agrega una respuesta a una nota existente.
// Las respuestas se acumulan en la columna JSONB `respuestas` de shift_notes.
// Cada respuesta: { ts, por (userName), rol (userRole), texto, fotoUrl? }.
async function apiAddNoteReply(p, res) {
  const userRole = String(p.userRole || '').toUpperCase();
  if(!['ADMIN','RECEPTION','MAID','MAINTENANCE'].includes(userRole)) return err(res, 'Sin permiso');
  const userName = String(p.userName || '').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const noteId = Number(p.noteId || 0);
  if(!noteId) return err(res, 'noteId requerido');

  const texto = String(p.texto || '').trim();
  if(texto.length < 1) return err(res, 'Texto requerido');

  const fotoUrl = String(p.fotoUrl || '').trim() || null;

  const { data: note } = await tSelect('shift_notes', 'id, is_deleted, respuestas').eq('id', noteId).single();
  if(!note) return err(res, 'Nota no encontrada');
  if(note.is_deleted) return err(res, 'Nota borrada');

  const prev = Array.isArray(note.respuestas) ? note.respuestas : [];
  const nueva = { ts: Date.now(), por: userName, rol: userRole, texto: texto, fotoUrl: fotoUrl };
  const nuevas = prev.concat([nueva]);

  await tUpdate('shift_notes',{ respuestas: nuevas }).eq('id', noteId);
  return ok(res, { noteId: noteId, respuestas: nuevas });
}

async function apiGetNotes(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await tSelect('shift_notes','*')
    .eq('business_day', bDay).eq('is_deleted', false).eq('pasado_a_mantenimiento', false)
    .order('ts_ms', { ascending: false }).limit(100);
  return ok(res, { notes: (data || []).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms), shiftId: r.shift_id,
    userRole: r.user_role, userName: r.user_name, note: r.note,
    target: r.target || 'ALL', seenBy: JSON.parse(r.seen_by || '[]'),
    businessDay: r.business_day, photoUrl: r.photo_url || null,
    respuestas: Array.isArray(r.respuestas) ? r.respuestas : []
  })) });
}

async function apiMarkNoteSeen(p, res) {
  const noteId = Number(p.noteId || 0);
  const userRole = String(p.userRole || '').toUpperCase();
  if (!noteId) return err(res, 'noteId requerido');
  const { data } = await tSelect('shift_notes','seen_by').eq('id', noteId).single();
  if (!data) return err(res, 'Nota no encontrada');
  let seenBy = [];
  try { seenBy = JSON.parse(data.seen_by || '[]'); } catch(e) {}
  if (!seenBy.includes(userRole)) seenBy.push(userRole);
  await tUpdate('shift_notes',{ seen_by: JSON.stringify(seenBy) }).eq('id', noteId);
  return ok(res, { noteId, seenBy });
}

async function apiMarkNotePasado(p, res) {
  // Marca un reporte de shift_notes como "ya pasado a mantenimiento"
  // para que no aparezca mas en la lista de Reportes (Fase 6)
  const userRole = String(p.userRole || '').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const noteId = Number(p.noteId || 0);
  if(!noteId) return err(res, 'noteId requerido');
  const { data: note } = await tSelect('shift_notes','id, is_deleted, pasado_a_mantenimiento').eq('id', noteId).single();
  if(!note) return err(res, 'Nota no encontrada');
  if(note.is_deleted) return err(res, 'Nota ya borrada');
  if(note.pasado_a_mantenimiento) return err(res, 'Nota ya estaba pasada a mantenimiento');
  await tUpdate('shift_notes',{ pasado_a_mantenimiento: true }).eq('id', noteId);
  return ok(res, { noteId });
}

async function apiDeleteNote(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const noteId = Number(p.noteId || 0);
  if (!noteId) return err(res, 'noteId requerido');
  // Leer la foto real de la BD (no confiar en el cliente) y borrarla del storage
  // para liberar espacio. Si falla el storage, no abortar el borrado de la nota.
  const { data: note } = await tSelect('shift_notes','photo_url').eq('id', noteId).single();
  const photoUrl = note && note.photo_url ? String(note.photo_url) : '';
  if (photoUrl) {
    try {
      const fileName = photoUrl.split('/').pop();
      await supabase.storage.from('maid-photos').remove([fileName]);
    } catch (e) { console.error('Error borrando foto de nota:', e); }
  }
  // Soft delete (conserva historial) + limpiar la URL muerta.
  await tUpdate('shift_notes',{ is_deleted: true, photo_url: null }).eq('id', noteId);
  return ok(res, { noteId });
}

async function apiGetAllNotes(p, res) {
  const limit = Math.min(200, Number(p.limit || 100));
  const fromDate = String(p.fromDate || '');
  let query = tSelect('shift_notes','*').eq('is_deleted', false).order('ts_ms', { ascending: false }).limit(limit);
  if (fromDate) query = query.gte('business_day', fromDate);
  const { data } = await query;
  return ok(res, { notes: (data || []).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms), shiftId: r.shift_id,
    userRole: r.user_role, userName: r.user_name, note: r.note,
    target: r.target || 'ALL', seenBy: JSON.parse(r.seen_by || '[]'),
    businessDay: r.business_day,
    respuestas: Array.isArray(r.respuestas) ? r.respuestas : []
  })) });
}

async function apiGetNoteHistory(p, res) {
  const limit = Math.min(200, Number(p.limit || 100));
  const fromDate = String(p.fromDate || '');
  let query = tSelect('shift_notes','*').eq('is_deleted', false).order('ts_ms', { ascending: false }).limit(limit);
  if (fromDate) query = query.gte('business_day', fromDate);
  const { data } = await query;
  return ok(res, { notes: (data || []).map(r => ({ id: r.id, tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, userRole: r.user_role, userName: r.user_name, note: r.note })) });
}

// ==================== CIERRE DE TURNO ====================
// ITEM 2: Al cerrar con cuadre, marca released=true para liberar el siguiente turno
async function apiCloseShift(p, res) {
  const now = Date.now();
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
  const bDay = String(p.businessDay||'').trim()||businessDay(now);
  const userName = String(p.userName || '');

  // Cuadre del turno COMPLETO: filtra por shift_id + business_day (el business_day
  // sale del sess, snapshot inmutable del turno). Antes usaba una ventana desde el
  // ULTIMO login/relogin (loginMs), que truncaba el turno si la recepcionista
  // re-logueaba a mitad -> lo vendido antes del relogin quedaba fuera del cierre
  // (bug 01-jul: coronas de la 401 vendidas 03:09/03:40, relogin 03:49 -> excluidas).
  const [salesRes, taxiRes, loansRes, extraRes, prodRes] = await Promise.all([
    tSelect('sales','type,total,pay_method,people,room_id,anulada').eq('shift_id', shift).eq('business_day', bDay),
    tSelect('taxi_expenses','amount,anulada').eq('shift_id', shift).eq('business_day', bDay),
    tSelect('loans','amount,anulada').eq('shift_id', shift).eq('business_day', bDay),
    tSelect('extra_staff','payment,anulada').eq('shift_id', shift).eq('business_day', bDay),
    tSelect('room_products','total,pay_method,is_cortesia,amount_1,amount_2,amount_3').eq('shift_id', shift).eq('business_day', bDay)
  ]);

  const cortesiaIds = await getCortesiaIds();
  let totalSales=0, totalRefunds=0, totalTaxi=0, totalLoans=0, totalExtraStaff=0;
  let roomsSold=0, people=0, totalEfectivo=0, totalTarjeta=0, totalNequi=0, totalWompi=0;
  let totalProductos=0, totalProductosEf=0, totalProductosTa=0, totalProductosNq=0;
  const reservasApp=[];  // Etapa D: detalle por habitacion de las ventas WOMPI (reservas app) del turno.

  (salesRes.data || []).forEach(r => {
    if (r.anulada) return;
    // Cortesia: ya NO se salta entero. La habitacion base aporta 0 (total=epv tras
    // Parte 1); personas/horas SI suman. Solo no cuenta como roomsSold. (Este cierre
    // es siempre del turno actual -> post-corte, no necesita el cutoff por fecha.)
    const esCortesia = cortesiaIds.has(String(r.room_id));
    const t = Number(r.total||0), pm = String(r.pay_method||'').toUpperCase();
    if (r.type === 'SALE') { totalSales+=t; if(!esCortesia)roomsSold++; people+=Number(r.people||0); if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; else if(pm==='WOMPI'){totalTarjeta+=t; totalWompi+=t; reservasApp.push({roomId:String(r.room_id||''),total:t});/* Reservas app: dentro de Tarjeta */} }
    if (r.type === 'REFUND') { totalRefunds += t; if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; else totalEfectivo+=t; }
    if (r.type === 'RENEWAL') { totalSales+=t; roomsSold++; people+=Number(r.people||0); if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
    if (r.type === 'EXTENSION') { totalSales+=t; if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
  });
  (taxiRes.data||[]).forEach(r=>{if(r.anulada)return;totalTaxi+=Number(r.amount||0);});
  (prodRes.data||[]).forEach(r=>{
    if(r.is_cortesia)return;
    const t=Number(r.total||0);
    const pm=String(r.pay_method||'').toUpperCase();
    totalProductos+=t;
    if(pm==='MIXTO'){totalProductosEf+=Number(r.amount_1||0);totalProductosTa+=Number(r.amount_2||0);totalProductosNq+=Number(r.amount_3||0);}
    else if(pm==='EFECTIVO')totalProductosEf+=t;
    else if(pm==='TARJETA')totalProductosTa+=t;
    else if(pm==='NEQUI')totalProductosNq+=t;
  });
  (loansRes.data||[]).forEach(r=>{if(r.anulada)return;totalLoans+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{if(r.anulada)return;totalExtraStaff+=Number(r.payment||0);});

  const net = totalSales + totalRefunds - totalTaxi - totalLoans - totalExtraStaff;

  const { error: closeErr } = await tInsert('shift_close',{
    ts_ms: now, business_day: bDay, shift_id: shift, user_name: userName,
    total_sales: totalSales, total_refunds: totalRefunds, total_taxi: totalTaxi,
    total_loans: totalLoans, total_extra_staff: totalExtraStaff, net,
    rooms_sold: roomsSold, people, cash_count: Number(p.cashCount||0),
    cash_billetes: Number(p.cashBilletes||0),
    cash_monedas: Number(p.cashMonedas||0),
    notes: String(p.notes||''), total_efectivo: totalEfectivo,
    total_tarjeta: totalTarjeta, total_nequi: totalNequi, total_wompi: totalWompi,
    total_productos: totalProductos,
    total_productos_ef: totalProductosEf,
    total_productos_ta: totalProductosTa,
    total_productos_nq: totalProductosNq
  });
  // No tragar el error: si el snapshot del cierre no se guarda, avisar (antes se
  // perdia en silencio -> 256 cierres sin shift_close desde abr-2026).
  if (closeErr) return err(res, 'No se pudo guardar el cierre de turno: ' + (closeErr.message || closeErr));

  // Recien con el snapshot guardado OK, marcar el turno cerrado y liberado.
  // (Antes el LOGOUT iba ANTES del snapshot -> si el snapshot fallaba, el turno
  // quedaba liberado igual, sin cuadre guardado.)
  await tInsert('shift_log',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName,
    action: 'LOGOUT', logout_ms: now,
    released: true // libera el turno siguiente
  });

  // Bar bar_sales removido - duplicaba valores de room_products
  return ok(res, { summary: { bizDay: bDay, shiftId: shift, totalSales, totalRefunds, totalTaxi, totalLoans, totalExtraStaff, net, roomsSold, people, totalEfectivo, totalTarjeta, totalNequi, totalWompi, reservasApp } });
}

// ==================== METRICAS ====================
async function apiMetrics(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const shiftFilter = String(p.shiftId || '');

  const [salesRes, taxiRes, loansRes, extraRes, barRes, gastoRes, settingsRes, shiftLogRes, shiftCloseRes] = await Promise.all([
    tSelect('sales','*').eq('business_day', bDay).order('ts_ms'),
    tSelect('taxi_expenses','*').eq('business_day', bDay).eq('anulada', false),
    tSelect('loans','*').eq('business_day', bDay).eq('anulada', false).order('ts_ms'),
    tSelect('extra_staff','*').eq('business_day', bDay).eq('anulada', false),
    tSelect('bar_sales','*').eq('business_day', bDay),
    tSelect('general_expenses','*').eq('business_day', bDay),
    tSelect('settings','key,value'),
    tSelect('shift_log','user_name,shift_id').eq('business_day', bDay).eq('user_role','RECEPTION').eq('action','LOGIN').order('ts_ms'),
    tSelect('shift_close','shift_id,cash_count,cash_billetes,cash_monedas,net,total_efectivo,ts_ms').eq('business_day', bDay)
  ]);

  const settings={};(settingsRes.data||[]).forEach(r=>{settings[r.key]=r.value;});
  const dailyGoal=Number(settings.DAILY_GOAL||0);
  const cortesiaIds=await getCortesiaIds();
  let dayTotal=0,dayRefunds=0,dayTaxi=0,dayBar=0,dayGastos=0,dayLoans=0,dayExtraStaff=0;
  let dayEfe=0,dayTar=0,dayNeq=0,dayWompi=0;
  let shiftSales=0,shiftRooms=0,shiftPeople=0,shiftEfe=0,shiftTar=0,shiftNeq=0,shiftWompi=0,shiftTaxi=0,shiftBar=0,shiftGastos=0;
  const allSalesList=[];

  (salesRes.data||[]).forEach(r=>{
    const t=Number(r.total||0),type=r.type,pm=String(r.pay_method||'').toUpperCase(),sid=r.shift_id;
    const isRev=type==='SALE'||type==='EXTENSION'||type==='RENEWAL';
    // Devolucion cruzada: anulada pero con devolucion en efectivo
    const esCruzada = r.anulada && r.devolucion_efectivo;
    const metodoOriginal = String(r.devolucion_metodo_original||'').toUpperCase();
    if(r.anulada && !esCruzada) return;  // Anulada normal: ignorar
    const esCortesia = cortesiaIds.has(String(r.room_id));
    // Cortesia PRE-corte: excluir entero (como hoy). POST-corte: NO excluir; la
    // habitacion base aporta 0 (total=epv) y personas/horas suman. Solo no roomsSold.
    const skip304 = esCortesia && String(r.business_day) < CORTESIA_COBRO_DESDE;
    if(isRev || (esCruzada && type==='ANULADA')){
      if(!skip304){
        if(esCruzada){
          // Suma a metodo original (banco tiene la plata) + resta del efectivo (caja entrego)
          if(metodoOriginal==='TARJETA') dayTar+=t;
          else if(metodoOriginal==='NEQUI') dayNeq+=t;
          dayEfe -= t; // Resta porque salio de caja
        } else {
          dayTotal+=t;
          if(pm==='EFECTIVO')dayEfe+=t;else if(pm==='TARJETA')dayTar+=t;else if(pm==='NEQUI')dayNeq+=t;else if(pm==='WOMPI'){dayTar+=t;dayWompi+=t;/* Reservas app: dentro de Tarjeta */}else if(pm==='MIXTO'){dayEfe+=Number(r.amount_1||0);dayTar+=Number(r.amount_2||0);dayNeq+=Number(r.amount_3||0);}
        }
      }
      if(type==='SALE'||type==='RENEWAL'||type==='EXTENSION')allSalesList.push({id:r.id,tsMs:Number(r.ts_ms),shiftId:sid,roomId:r.room_id,category:r.category,type,durationHrs:Number(r.duration_hrs||0),people:Number(r.people||0),total:t,extraPeople:Number(r.extra_people||0),extraPeopleValue:Number(r.extra_people_value||0),arrivalType:r.arrival_type||'',arrivalPlate:r.arrival_plate||'',payMethod:pm,paidWith:Number(r.paid_with||0),change:Number(r.change_given||0),userName:r.user_name,checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:Number(r.due_ms||0),amount_1:Number(r.amount_1||0),amount_2:Number(r.amount_2||0),amount_3:Number(r.amount_3||0),note:String(r.note||''),checkoutMs:Number(r.checkout_ms||0),anulada:r.anulada,devolucionEfectivo:r.devolucion_efectivo,metodoOriginal:metodoOriginal,isCortesia:cortesiaIds.has(String(r.room_id)),origin:r.origin||'',comprobanteImpresoMs:Number(r.comprobante_impreso_ms||0)});
      if(!shiftFilter||sid===shiftFilter){
        if(!skip304){
          if(esCruzada){
            if(metodoOriginal==='TARJETA') shiftTar+=t;
            else if(metodoOriginal==='NEQUI') shiftNeq+=t;
            shiftEfe -= t;
          } else {
            shiftSales+=t;
            if(pm==='EFECTIVO')shiftEfe+=t;else if(pm==='TARJETA')shiftTar+=t;else if(pm==='NEQUI')shiftNeq+=t;else if(pm==='WOMPI'){shiftTar+=t;shiftWompi+=t;/* Reservas app: dentro de Tarjeta */}else if(pm==='MIXTO'){shiftEfe+=Number(r.amount_1||0);shiftTar+=Number(r.amount_2||0);shiftNeq+=Number(r.amount_3||0);}
            if(type==='SALE'){if(!esCortesia)shiftRooms++;shiftPeople+=Number(r.people||0);}
          }
        }
      }
    }
    if(type==='REFUND'){dayRefunds+=t;if(pm==='TARJETA')dayTar+=t;else if(pm==='NEQUI')dayNeq+=t;else dayEfe+=t;if(!shiftFilter||sid===shiftFilter){shiftSales+=t;if(pm==='TARJETA')shiftTar+=t;else if(pm==='NEQUI')shiftNeq+=t;else shiftEfe+=t;}allSalesList.push({id:r.id,tsMs:Number(r.ts_ms),shiftId:sid,roomId:r.room_id,category:r.category||'',type:'REFUND',durationHrs:0,people:0,total:t,payMethod:pm,userName:r.user_name,checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:0,amount_1:0,amount_2:0,amount_3:0,note:r.refund_reason||'',origin:r.origin||'',comprobanteImpresoMs:Number(r.comprobante_impreso_ms||0)});}
  });
const {data:prodSales}=await tSelect('room_products','*').eq('business_day',bDay);
  const prodSalesFilt=(prodSales||[]).filter(s=>!shiftFilter||s.shift_id===shiftFilter);
  const totalProductos=prodSalesFilt.filter(s=>!s.is_cortesia).reduce((a,s)=>a+Number(s.total||0),0);
  const totalCortesiasProds=prodSalesFilt.filter(s=>s.is_cortesia).reduce((a,s)=>a+Number(s.total||0),0);
  const totalProductosEf=prodSalesFilt.filter(s=>!s.is_cortesia).reduce((a,s)=>a+(s.pay_method==='MIXTO'?Number(s.amount_1||0):(s.pay_method==='EFECTIVO'?Number(s.total||0):0)),0);
  const totalProductosTa=prodSalesFilt.filter(s=>!s.is_cortesia).reduce((a,s)=>a+(s.pay_method==='MIXTO'?Number(s.amount_2||0):(s.pay_method==='TARJETA'?Number(s.total||0):0)),0);
  const totalProductosNq=prodSalesFilt.filter(s=>!s.is_cortesia).reduce((a,s)=>a+(s.pay_method==='MIXTO'?Number(s.amount_3||0):(s.pay_method==='NEQUI'?Number(s.total||0):0)),0);
  const taxiList=[];
  (taxiRes.data||[]).forEach(r=>{
    const a=Number(r.amount||0);
    dayTaxi+=a;
    if(!shiftFilter||(r.shift_id||'').toUpperCase()===shiftFilter)shiftTaxi+=a;
    taxiList.push({id:r.id,tsMs:Number(r.ts_ms),shiftId:r.shift_id,roomId:r.room_id||'',amount:a,businessDay:r.business_day||''});
  });

 let dayBarEfe=0,dayBarTar=0,dayBarNeq=0,shiftBarEfe=0,shiftBarTar=0,shiftBarNeq=0;
  (barRes.data||[]).forEach(r=>{const a=Number(r.amount_cash||0)+Number(r.amount_card||0)+Number(r.amount_nequi||0);dayBar+=a;dayBarEfe+=Number(r.amount_cash||0);dayBarTar+=Number(r.amount_card||0);dayBarNeq+=Number(r.amount_nequi||0);if(!shiftFilter||r.shift_id===shiftFilter){shiftBar+=a;shiftBarEfe+=Number(r.amount_cash||0);shiftBarTar+=Number(r.amount_card||0);shiftBarNeq+=Number(r.amount_nequi||0);}});
  const{data:roomProdsBar}=await tSelect('room_products','shift_id,pay_method,total,is_cortesia,amount_1,amount_2,amount_3').eq('business_day',bDay).eq('is_cortesia',false);
  (roomProdsBar||[]).forEach(r=>{const t=Number(r.total||0),pm=String(r.pay_method||'EFECTIVO').toUpperCase();dayBar+=t;var bEf,bTa,bNq;if(pm==='MIXTO'){bEf=Number(r.amount_1||0);bTa=Number(r.amount_2||0);bNq=Number(r.amount_3||0);}else if(pm==='TARJETA'){bEf=0;bTa=t;bNq=0;}else if(pm==='NEQUI'){bEf=0;bTa=0;bNq=t;}else{bEf=t;bTa=0;bNq=0;}dayBarEfe+=bEf;dayBarTar+=bTa;dayBarNeq+=bNq;if(!shiftFilter||r.shift_id===shiftFilter){shiftBar+=t;shiftBarEfe+=bEf;shiftBarTar+=bTa;shiftBarNeq+=bNq;}});
  (extraRes.data||[]).forEach(r=>{dayExtraStaff+=Number(r.payment||0);});

  // ===== RETIROS DEL DUENO (AHORRO SILENCIOSO) =====
  // Restar retiros activos del dia origen del cuadre del dia
  // Los retiros se descuentan de las ventas del dia origen y metodo correspondiente
  const { data: retirosDia } = await tSelect('retiros_dueno', 'monto, pay_method, anulado')
    .eq('dia_origen', bDay)
    .eq('anulado', false);
  let dayRetirosEfe = 0;
  let dayRetirosTar = 0;
  (retirosDia||[]).forEach(r=>{
    const monto = Number(r.monto||0);
    const pm = String(r.pay_method||'').toUpperCase();
    if(pm==='EFECTIVO') dayRetirosEfe += monto;
    else if(pm==='TARJETA') dayRetirosTar += monto;
  });
  // Restar retiros del total general y de los desgloses
  dayTotal -= (dayRetirosEfe + dayRetirosTar);
  dayEfe -= dayRetirosEfe;
  dayTar -= dayRetirosTar;

  const dayNet=dayTotal+dayBar+dayRefunds-dayTaxi-dayLoans-dayExtraStaff-dayGastos;
  const shiftNet=shiftSales+shiftBar-shiftTaxi-shiftGastos;

  // Salidas reales del businessDay (desde las 6am): check-outs por checkout_ms en la
  // ventana del dia, sin importar cuando fue el check-in (opcion C, exacto).
  const { start: bdStart, end: bdEnd } = businessDayRange(bDay);
  const { count: salidasHoy } = await tSelect('sales','id',{count:'exact',head:true})
    .eq('type','SALE').gte('checkout_ms', bdStart).lt('checkout_ms', bdEnd).neq('anulada', true);

  return ok(res,{
    businessDay:bDay,
    totals:{
      sales:dayTotal,bar:dayBar,refunds:dayRefunds,taxi:dayTaxi,loans:dayLoans,extraStaff:dayExtraStaff,gastos:dayGastos,net:dayNet,
      totalEfectivo:dayEfe,totalTarjeta:dayTar,totalNequi:dayNeq,totalWompi:dayWompi,
      barEfectivo:dayBarEfe,barTarjeta:dayBarTar,barNequi:dayBarNeq,
      shiftNet,shiftSales,shiftRoomsSold:shiftRooms,shiftPeople,shiftBar,shiftTaxi,shiftGastos,
      shiftEfectivo:shiftEfe,shiftTarjeta:shiftTar,shiftNequi:shiftNeq,shiftWompi,
      shiftBarEfectivo:shiftBarEfe,shiftBarTarjeta:shiftBarTar,shiftBarNequi:shiftBarNeq,
      totalProductos,totalCortesiasProds,totalProductosEf,totalProductosTa,totalProductosNq,
      salidasHoy:salidasHoy||0
    },
    loans:(loansRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),shiftId:r.shift_id,userName:r.user_name,borrowerName:r.borrower_name,amount:Number(r.amount),note:r.note})),
    extraStaff:(extraRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),shiftId:r.shift_id,personName:r.person_name,area:r.area,entryMs:Number(r.entry_ms||0),exitMs:Number(r.exit_ms||0),payment:Number(r.payment||0),active:r.active,paidBy:r.paid_by||''})),
    allSalesList:allSalesList.sort((a,b)=>a.tsMs-b.tsMs),
    taxiList,
    dailyGoal,goalProgress:dailyGoal>0?Math.round((dayTotal/dailyGoal)*100):null,
    shiftUser:shiftFilter?(shiftLogRes.data||[]).filter(r=>r.shift_id===shiftFilter).map(r=>r.user_name)[0]||'—':'—',
    shiftClose:(shiftCloseRes.data||[]).filter(r=>(r.shift_id||'').toUpperCase()===(shiftFilter||'').toUpperCase()).map(r=>({cashCount:Number(r.cash_count||0),cashBilletes:Number(r.cash_billetes||0),cashMonedas:Number(r.cash_monedas||0),net:Number(r.net||0),totalEfectivo:Number(r.total_efectivo||0),tsMs:Number(r.ts_ms||0)}))[0]||null
  });
}

// ==================== METRICAS POR HORA ====================
async function apiMetricsHourly(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { start, end } = businessDayRange(bDay);
  const { data } = await tSelect('sales', 'ts_ms, total, type')
    .eq('business_day', bDay)
    .in('type', ['SALE', 'EXTENSION', 'RENEWAL'])
    .order('ts_ms');

  const buckets = [];
  for (let i = 0; i < 24; i++) {
    const realHour = (6 + i) % 24;
    buckets.push({ bucket: i, realHour, label: realHour + ':00', count: 0, sales: 0 });
  }

  (data || []).forEach(r => {
    const ms = Number(r.ts_ms || 0);
    if (ms < start || ms >= end) return;
    const realHour = new Date(ms).getHours();
    const bucketIdx = realHour >= 6 ? realHour - 6 : realHour + 18;
    if (buckets[bucketIdx]) {
      buckets[bucketIdx].count++;
      buckets[bucketIdx].sales += Number(r.total || 0);
    }
  });

  return ok(res, { businessDay: bDay, buckets });
}

async function apiMonthMetrics(p, res) {
  const ym = String(p.yearMonth || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return err(res, 'yearMonth invalido. Formato: YYYY-MM');

  // Queries que pueden superar 1000 filas — usan el helper fetchAll
  const salesData = await fetchAll(() => tSelect('sales', 'business_day,shift_id,type,total,pay_method,extra_people_value,amount_1,amount_2,amount_3,people,user_name,room_id,duration_hrs,anulada,devolucion_efectivo,devolucion_metodo_original')
    .like('business_day', ym+'%'));
  const maidLogsData = await fetchAll(() => tSelect('maid_log', 'maid_name,finished_ms,started_ms,state_to')
    .like('business_day', ym+'%'));
  const roomProdsData = await fetchAll(() => tSelect('room_products', 'business_day,shift_id,pay_method,total,is_cortesia,amount_1,amount_2,amount_3')
    .like('business_day', ym+'%'));

  // Queries pequeñas — se mantienen con Promise.all normal
  const [taxiRes, loansRes, extraRes, failuresRes, shiftLogRes, barSalesRes] = await Promise.all([
    tSelect('taxi_expenses','business_day,shift_id,amount,anulada').like('business_day', ym+'%'),
    tSelect('loans','business_day,shift_id,amount,anulada').like('business_day', ym+'%'),
    tSelect('extra_staff','business_day,shift_id,payment,anulada').like('business_day', ym+'%').gt('payment',0),
    tSelect('shift_failures','*').like('business_day', ym+'%'),
    tSelect('shift_log','business_day,shift_id,user_name').like('business_day', ym+'%').eq('user_role','RECEPTION').in('action',['LOGIN','RELOGIN']),
    tSelect('bar_sales','business_day,shift_id,amount_cash,amount_card,amount_nequi').like('business_day', ym+'%')
  ]);

  // Envolver los arrays paginados en {data: ...} para compatibilidad con el código existente
  const salesRes = { data: salesData };
  const maidLogsRes = { data: maidLogsData };
  const roomProdsRes = { data: roomProdsData };

  const SHIFTS = ['SHIFT_1','SHIFT_2','SHIFT_3'];
  const mkShift = () => ({
    responsable:'—',
    tj_hab:0,tj_padd:0,tj_had:0,tj_bar:0,
    ef_hab:0,ef_padd:0,ef_had:0,ef_bar:0,
    nq_hab:0,nq_padd:0,nq_had:0,nq_bar:0,
    wo_hab:0,wo_padd:0,wo_had:0,   // Etapa D: Reservas (app) / Wompi
    gastos:0,taxis:0,turnos:0,
    roomsSold:0
  });
  const mkDay = (d) => {
    const o = {day:d,roomsSold:0,people:0};
    SHIFTS.forEach(s=>{o[s]=mkShift();});
    return o;
  };

  const dayMap = {};
  const getDay = d => { if(!dayMap[d])dayMap[d]=mkDay(d); return dayMap[d]; };

  // Responsables por turno/día
  (shiftLogRes.data||[]).forEach(r=>{
    const d=getDay(r.business_day);
    const sid=r.shift_id;
    if(SHIFTS.includes(sid)&&d[sid].responsable==='—') d[sid].responsable=r.user_name||'—';
  });

  // Ventas
  const cortesiaIds = await getCortesiaIds();
  (salesRes.data||[]).forEach(r=>{
    // Devolucion cruzada: anulada pero con devolucion en efectivo
    const esCruzada = r.anulada && r.devolucion_efectivo;
    const metodoOriginal = String(r.devolucion_metodo_original||'').toUpperCase();
    if(r.anulada && !esCruzada) return;  // Anulada normal: ignorar
    const esCortesia = cortesiaIds.has(String(r.room_id));
    // Cortesia PRE-corte: excluir entero. POST-corte: la hab base aporta 0
    // (base=t-epv=0 tras Parte 1) y personas/horas suman; solo no roomsSold.
    if(esCortesia && String(r.business_day) < CORTESIA_COBRO_DESDE) return;
    const d=getDay(r.business_day);
    const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';
    const s=d[sid];
    const t=Number(r.total||0), pm=String(r.pay_method||'EFECTIVO').toUpperCase();
    const epv=Number(r.extra_people_value||0);
    if(esCruzada){
      // La venta queda en su seccion original (banco/Nequi tiene la plata)
      // Y se resta del efectivo (caja entrego al cliente)
      if(metodoOriginal==='TARJETA') s.tj_hab+=t;
      else if(metodoOriginal==='NEQUI') s.nq_hab+=t;
      s.ef_hab -= t;  // Resta porque salio efectivo de caja
      return;  // No procesar como venta normal
    }
    // Conteo de habs: solo checkIn original (SALE con check_in_ms===ts_ms) o RENEWAL.
    // Excluye ajustes que reusan type='SALE': +persona, hora extra manual, diff de cambio de hab.
    const isRoomSale = (r.type==='SALE' && Number(r.check_in_ms||0) === Number(r.ts_ms||0))
                    || r.type==='RENEWAL';
    if(isRoomSale){
      // La habitacion de cortesia NO cuenta como roomsSold (RENEWAL si). (El mes
      // no selecciona check_in_ms/ts_ms, asi que se usa el type directamente.)
      const esCortSale = esCortesia && r.type==='SALE';
      if(!esCortSale){ d.roomsSold++; s.roomsSold++; }
      d.people+=Number(r.people||0);  // headcount siempre cuenta
    }
    if(r.type==='SALE'||r.type==='RENEWAL'){
      const base=t-epv;
      if(pm==='TARJETA'){s.tj_hab+=base;s.tj_padd+=epv;}
      else if(pm==='NEQUI'){s.nq_hab+=base;s.nq_padd+=epv;}
      else if(pm==='WOMPI'){s.wo_hab+=base;s.wo_padd+=epv;}   // Reservas (app): NO cae en efectivo.
      else if(pm==='MIXTO'){s.ef_hab+=Number(r.amount_1||0);s.tj_hab+=Number(r.amount_2||0);s.nq_hab+=Number(r.amount_3||0);}
      else{s.ef_hab+=base;s.ef_padd+=epv;}
    }
    if(r.type==='EXTENSION'){
      if(pm==='TARJETA')s.tj_had+=t;
      else if(pm==='NEQUI')s.nq_had+=t;
      else if(pm==='WOMPI')s.wo_had+=t;   // Reservas (app): NO cae en efectivo.
      else if(pm==='MIXTO'){s.ef_had+=Number(r.amount_1||0);s.tj_had+=Number(r.amount_2||0);s.nq_had+=Number(r.amount_3||0);}
      else s.ef_had+=t;
    }
    // Devoluciones (REFUND): se descuentan de la seccion segun metodo de pago
    if(r.type==='REFUND'){
      if(pm==='TARJETA') s.tj_hab+=t;
      else if(pm==='NEQUI') s.nq_hab+=t;
      else s.ef_hab+=t;
    }
  });

  // Bar productos
  (roomProdsRes.data||[]).forEach(r=>{
    if(r.is_cortesia)return;
    const d=getDay(r.business_day);
    const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';
    const s=d[sid], pm=String(r.pay_method||'EFECTIVO').toUpperCase(), t=Number(r.total||0);
    if(pm==='MIXTO'){s.ef_bar+=Number(r.amount_1||0);s.tj_bar+=Number(r.amount_2||0);s.nq_bar+=Number(r.amount_3||0);}
    else if(pm==='TARJETA')s.tj_bar+=t;
    else if(pm==='NEQUI')s.nq_bar+=t;
    else s.ef_bar+=t;
  });


  // Gastos
  (taxiRes.data||[]).forEach(r=>{if(r.anulada)return;const d=getDay(r.business_day);const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';d[sid].taxis+=Number(r.amount||0);});
  (loansRes.data||[]).forEach(r=>{if(r.anulada)return;const d=getDay(r.business_day);const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';d[sid].gastos+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{if(r.anulada)return;const d=getDay(r.business_day);const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';d[sid].turnos+=Number(r.payment||0);});

  // ===== RETIROS DEL DUENO (AHORRO SILENCIOSO) =====
  // Restar retiros activos de las ventas del dia origen y metodo correspondiente
  // Esto cumple la regla de oro: el retiro se ve reflejado en el Mes
  const { data: retirosMes } = await tSelect('retiros_dueno', 'dia_origen, monto, pay_method, anulado')
    .like('dia_origen', ym+'%')
    .eq('anulado', false);
  (retirosMes||[]).forEach(r=>{
    const d=dayMap[r.dia_origen];
    if(!d) return;
    const monto=Number(r.monto||0);
    const pm=String(r.pay_method||'').toUpperCase();
    if(pm==='EFECTIVO') d.SHIFT_1.ef_hab -= monto;
    else if(pm==='TARJETA') d.SHIFT_1.tj_hab -= monto;
  });

  const days = Object.values(dayMap).sort((a,b)=>a.day.localeCompare(b.day));

  // Calcular netos por turno y totales por día
  days.forEach(d=>{
    d.totalTarjeta=0;d.totalEfectivo=0;d.totalNequi=0;d.totalWompi=0;d.totalGastos=0;d.netodia=0;
    SHIFTS.forEach(sid=>{
      const s=d[sid];
      s.totalWompi=s.wo_hab+s.wo_padd+s.wo_had;   // Etapa D: Reservas (app) — sub de Tarjeta
      s.totalTarjeta=s.tj_hab+s.tj_padd+s.tj_had+s.tj_bar+s.totalWompi;   // Tarjeta INCLUYE reservas (app)
      s.totalEfectivo=s.ef_hab+s.ef_padd+s.ef_had+s.ef_bar;
      s.totalNequi=s.nq_hab+s.nq_padd+s.nq_had+s.nq_bar;
      s.totalGastos=s.gastos+s.taxis+s.turnos;
   s.netoTurno=s.totalTarjeta+s.totalEfectivo+s.totalNequi-s.totalGastos;
      d.totalTarjeta+=s.totalTarjeta;
      d.totalEfectivo+=s.totalEfectivo;
      d.totalNequi+=s.totalNequi;
      d.totalWompi+=s.totalWompi;
      d.totalGastos+=s.totalGastos;
    });
    d.netodia=d.totalTarjeta+d.totalEfectivo+d.totalNequi-d.totalGastos;   // Wompi ya va dentro de totalTarjeta
  });

  const monthTotals={sales:0,tarjeta:0,efectivo:0,nequi:0,wompi:0,gastos:0,neto:0,roomsSold:0,people:0,expenses:0};
  days.forEach(d=>{
    monthTotals.tarjeta+=d.totalTarjeta;
    monthTotals.efectivo+=d.totalEfectivo;
    monthTotals.nequi+=d.totalNequi;
    monthTotals.wompi+=d.totalWompi;
    monthTotals.gastos+=d.totalGastos;
    monthTotals.neto+=d.netodia;
    monthTotals.roomsSold+=d.roomsSold;
    monthTotals.people+=d.people||0;
  });
  monthTotals.sales=monthTotals.tarjeta+monthTotals.efectivo+monthTotals.nequi;   // tarjeta ya incluye wompi
  monthTotals.expenses=monthTotals.gastos;

  // Rankings
  const recepMes={};
  (salesRes.data||[]).filter(r=>r.type==='SALE').forEach(r=>{const nm=r.user_name||'?';if(!recepMes[nm])recepMes[nm]={nombre:nm,habs:0,total:0};recepMes[nm].habs++;recepMes[nm].total+=Number(r.total||0);});
  const recepRankingMes=Object.values(recepMes).sort((a,b)=>b.total-a.total);

  const maidMes={};
  (maidLogsRes.data||[]).filter(r=>Number(r.finished_ms||0)>0&&r.state_to==='AVAILABLE').forEach(r=>{const nm=r.maid_name||'?';if(!maidMes[nm])maidMes[nm]={nombre:nm,habs:0,totalMins:0};maidMes[nm].habs++;maidMes[nm].totalMins+=Math.round((Number(r.finished_ms)-Number(r.started_ms))/60000);});
  const maidRankingMes=Object.values(maidMes).sort((a,b)=>b.habs-a.habs);

  const errorMap={};
  (failuresRes.data||[]).forEach(f=>{const nm=f.user_name||'?';if(!errorMap[nm])errorMap[nm]={nombre:nm,total:0,detalles:[]};let fallas=[];try{fallas=Array.isArray(f.failures)?f.failures:JSON.parse(f.failures||'[]');}catch(e){}errorMap[nm].total+=fallas.length;errorMap[nm].detalles.push({fecha:f.business_day,turno:f.shift_id,fallas,creadoPor:f.created_by||''});});
  const errorRanking=Object.values(errorMap).sort((a,b)=>b.total-a.total);

  return ok(res, { yearMonth:ym, monthTotals, days, recepRankingMes, maidRankingMes, errorRanking });
}

// ==================== PANEL CAMARERAS ====================
async function apiMaidPanel(p, res) {
  const now = Date.now();
  const bDay = String(p.businessDay || businessDay(now));
  const shift = currentShiftId(now);

  const [roomsRes, logsRes, maidLogsRes, shiftLogRes] = await Promise.all([
    tSelect('rooms','*').eq('archived', false).order('room_id'),
    tSelect('state_history','*').eq('business_day', bDay),
    tSelect('maid_log','*').eq('business_day', bDay).order('ts_ms'),
    tSelect('shift_log','*').eq('business_day', bDay).eq('user_role', 'MAID').in('action', ['LOGIN', 'RELOGIN'])
  ]);

  const rooms = (roomsRes.data||[]).map(mapRoom);
  const activeMaids = {};
  (shiftLogRes.data||[]).forEach(r=>{const n=r.user_name;if(!activeMaids[n]||Number(r.ts_ms)<activeMaids[n].tsMs)activeMaids[n]={userName:n,loginMs:Number(r.ts_ms),shiftId:r.shift_id};});

  const dirtyRooms = rooms.filter(r=>r.state==='DIRTY').map(r=>({roomId:r.roomId,category:r.category,lastCheckoutMs:r.lastCheckoutMs,waitingMins:r.lastCheckoutMs?Math.round((now-r.lastCheckoutMs)/60000):0})).sort((a,b)=>b.waitingMins-a.waitingMins);
  const contaminatedRooms = rooms.filter(r=>r.state==='CONTAMINATED').map(r=>{const since=r.contaminatedSinceMs||r.stateSinceMs;return{roomId:r.roomId,category:r.category,contaminatedSinceMs:since,waitingMins:since?Math.round((now-since)/60000):0};});

  const byShift = {SHIFT_1:{},SHIFT_2:{},SHIFT_3:{}};
  (logsRes.data||[]).forEach(r=>{
    if(r.from_state!=='DIRTY'&&r.from_state!=='CONTAMINATED')return;
    if(r.to_state!=='AVAILABLE'&&r.to_state!=='CONTAMINATED')return;
    let meta={};try{meta=JSON.parse(r.meta_json||'{}');}catch(e){}
    const maidName=String(meta.maidName||r.user_name||'');if(!maidName)return;
    const sid=['SHIFT_1','SHIFT_2','SHIFT_3'].includes(r.shift_id)?r.shift_id:'SHIFT_1';
    if(!byShift[sid][maidName])byShift[sid][maidName]={maidName,rooms:0,contaminated:0,items:[]};
    byShift[sid][maidName].rooms++;
    if(r.to_state==='CONTAMINATED')byShift[sid][maidName].contaminated++;
    byShift[sid][maidName].items.push({roomId:r.room_id,dirtyMins:Number(meta.dirtyMins||0),cleanMins:Number(meta.cleanMins||0)});
  });

  const shiftReport={};
  ['SHIFT_1','SHIFT_2','SHIFT_3'].forEach(sid=>{shiftReport[sid]=Object.values(byShift[sid]).map(x=>({maidName:x.maidName,totalRooms:x.rooms,contaminated:x.contaminated,avgCleanMins:x.rooms?Math.round(x.items.reduce((s,i)=>s+i.cleanMins,0)/x.rooms):0}));});

  const maidLogs = (maidLogsRes.data||[]).map(r=>({
    id: r.id, tsMs:Number(r.ts_ms), businessDay:r.business_day, shiftId:r.shift_id,
    maidName:r.maid_name, roomId:r.room_id, action:r.action, state:r.state, note:r.note,
    startedMs:Number(r.started_ms||r.ts_ms||0), finishedMs:Number(r.finished_ms||0),
    stateFrom:r.state_from||'', stateTo:r.state_to||'',
    category: r.category||'',
    checkInMs: Number(r.check_in_ms||0),
    checkoutMs: Number(r.checkout_ms||0)
  }));

  return ok(res, { bizDay:bDay, serverShift:shift, activeMaids:Object.values(activeMaids), dirtyRooms, contaminatedRooms, shiftReport, serverNowMs:now, maidLogs });
}

// ==================== PERSONAL / CALENDARIO ====================
async function apiGetStaff(p, res) {
  const { data } = await tSelect('staff','*').order('area').order('name');
  const { data: hist } = await tSelect('staff_vacaciones_historial', '*').order('created_at', { ascending: false });
  const histByStaff = {};
  (hist||[]).forEach(h => {
    if(!histByStaff[h.staff_id]) histByStaff[h.staff_id] = [];
    histByStaff[h.staff_id].push({
      id: h.id,
      fechaIngreso: h.fecha_ingreso || '',
      fechaSalidaVacaciones: h.fecha_salida_vacaciones || '',
      fechaReingreso: h.fecha_reingreso || ''
    });
  });
  return ok(res, { staff: (data||[]).map(r=>({
    id:r.id, name:r.name, area:r.area, type:r.type, active:r.active,
    cedula:r.cedula||'', celular:r.celular||'', direccion:r.direccion||'',
    contactoEmergencia:r.contacto_emergencia||'', fechaNacimiento:r.fecha_nacimiento||'',
    fechaIngreso:r.fecha_ingreso||'', fechaVacaciones:r.fecha_vacaciones||'',
    estadoRegistro:r.estado_registro||'', tienePin: !!r.pin_hash,
    pinResetPor:r.pin_reset_por||'', pinResetMs:r.pin_reset_ms||null,
    salidaMs:r.salida_ms||null, salidaTipo:r.salida_tipo||'', salidaFecha:r.salida_fecha||'',
    salidaObs:r.salida_obs||'', salidaPor:r.salida_por||'',
    vacacionesHistorial: histByStaff[r.id] || []
  })) });
}

async function apiSaveStaff(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const name=String(p.name||'').trim(),area=String(p.area||'').trim(),active=p.active!==false,id=String(p.id||'').trim();
  if(!name)return err(res,'Nombre requerido');
  if(!area)return err(res,'Area requerida');
  const extra={
    cedula:String(p.cedula||'').trim(), celular:String(p.celular||'').trim(),
    direccion:String(p.direccion||'').trim(), contacto_emergencia:String(p.contactoEmergencia||'').trim(),
    fecha_nacimiento:p.fechaNacimiento||null, fecha_ingreso:p.fechaIngreso||null, fecha_vacaciones:p.fechaVacaciones||null
  };
  if(id){await tUpdate('staff',{name,area,active,...extra}).eq('id',id);}
  else{await tInsert('staff',{id:'S'+Date.now(),name,area,type:'nomina',active,created_ms:Date.now(),...extra});}
  return ok(res,{});
}

async function apiSaveVacacionesEvent(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN');
  const staffId = String(p.staffId||'').trim();
  const fechaSalida = String(p.fechaSalidaVacaciones||'').trim();
  const fechaReingreso = String(p.fechaReingreso||'').trim();
  if(!staffId) return err(res, 'staffId requerido');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fechaSalida)) return err(res, 'Fecha salida invalida (YYYY-MM-DD)');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fechaReingreso)) return err(res, 'Fecha reingreso invalida (YYYY-MM-DD)');
  if(fechaReingreso < fechaSalida) return err(res, 'Reingreso no puede ser antes de salida');

  const { data: staffRow } = await tSelect('staff','fecha_ingreso').eq('id', staffId).single();
  if(!staffRow) return err(res, 'Staff no existe');

  // Proxima fecha tentativa = re-ingreso + 1 año
  const proxima = new Date(fechaReingreso + 'T00:00:00');
  proxima.setFullYear(proxima.getFullYear() + 1);
  const proximaStr = proxima.getFullYear() + '-' +
    String(proxima.getMonth()+1).padStart(2,'0') + '-' +
    String(proxima.getDate()).padStart(2,'0');

  await tInsert('staff_vacaciones_historial',{
    staff_id: staffId,
    fecha_ingreso: staffRow.fecha_ingreso,
    fecha_salida_vacaciones: fechaSalida,
    fecha_reingreso: fechaReingreso
  });
  await tUpdate('staff',{
    fecha_ingreso: fechaReingreso,
    fecha_vacaciones: proximaStr
  }).eq('id', staffId);

  return ok(res, { ok: true, fechaIngreso: fechaReingreso, fechaVacaciones: proximaStr });
}

// ===== FASE 2 · 2c — admin de colaboradores (extras pendientes + reset de PIN) =====
// Todos con requireAdmin (carnet firmado, NO p.userRole) y motel-scoped (tSelect/tUpdate).

async function apiGetExtrasPendientes(p, res) {
  if (!requireAdmin(p)) return err(res, 'No autorizado', 403);
  const { data } = await tSelect('staff', '*')
    .eq('type', 'extra').eq('estado_registro', 'PENDIENTE').order('created_ms');
  return ok(res, { pendientes: (data || []).map(r => ({
    id: r.id, name: r.name, cedula: r.cedula || '', celular: r.celular || '',
    direccion: r.direccion || '', fechaNacimiento: r.fecha_nacimiento || '', correo: r.correo || '',
    contactoEmergenciaNombre: r.contacto_emergencia_nombre || '',
    contactoEmergenciaTelefono: r.contacto_emergencia_telefono || '',
    createdMs: r.created_ms || null
  })) });
}

async function apiAprobarExtra(p, res) {
  if (!requireAdmin(p)) return err(res, 'No autorizado', 403);
  const id = String(p.id || '').trim();
  const { data: row } = await tSelect('staff', 'id,type,estado_registro').eq('id', id).maybeSingle();
  if (!row || row.type !== 'extra' || row.estado_registro !== 'PENDIENTE') return err(res, 'Extra no válido');
  await tUpdate('staff', { estado_registro: 'APROBADO', active: true }).eq('id', id);
  return ok(res, {});
}

async function apiRechazarExtra(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const id = String(p.id || '').trim();
  const { data: row } = await tSelect('staff', 'id,type,estado_registro').eq('id', id).maybeSingle();
  if (!row || row.type !== 'extra' || row.estado_registro !== 'PENDIENTE') return err(res, 'Extra no válido');
  // Regla de oro: anular, nunca borrar. Queda RECHAZADO + auditoría, inactivo.
  await tUpdate('staff', {
    estado_registro: 'RECHAZADO', active: false,
    rechazado_por: s.n || '', rechazado_ms: Date.now()
  }).eq('id', id);
  return ok(res, {});
}

async function apiResetearPin(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const id = String(p.id || '').trim();
  const { data: row } = await tSelect('staff', 'id,name').eq('id', id).maybeSingle();  // solo de este motel
  if (!row) return err(res, 'Colaborador no encontrado');
  // PIN aleatorio de 4 dígitos (se muestra UNA vez al admin). set_staff_pin sube
  // pin_version -> revoca los carnets viejos. Auditoría en pin_reset_por/_ms.
  const pin = String(require('crypto').randomInt(0, 10000)).padStart(4, '0');
  const { error } = await supabase.rpc('set_staff_pin', { p_staff_id: id, p_pin: pin });
  if (error) return err(res, 'No se pudo resetear el PIN');
  await tUpdate('staff', { pin_reset_por: s.n || '', pin_reset_ms: Date.now() }).eq('id', id);
  return ok(res, { pin: pin, nombre: row.name });
}

// QR de asistencia: token actual (modo IMAGEN estático / ROTATIVO por ventana).
async function apiGetQrAsistencia(p, res) {
  if (!requireAdmin(p)) return err(res, 'No autorizado', 403);
  const { data: cfg } = await tSelect('motel_config', 'qr_modo,qr_version,qr_rota_seg').maybeSingle();
  if (!cfg) return err(res, 'motel_config no encontrada');
  const modo = String(cfg.qr_modo || 'IMAGEN').toUpperCase();
  const now = Date.now();
  const token = generarTokenQr(MOTEL_ID, cfg.qr_version, modo, cfg.qr_rota_seg, now);
  if (!token) return err(res, 'Falta configurar QR_ASISTENCIA_SECRET en el servidor');
  const out = { token: token, modo: modo, qrVersion: Number(cfg.qr_version || 1) };
  if (modo === 'ROTATIVO') {
    const rota = Math.max(1, Number(cfg.qr_rota_seg || 60));
    out.rotaSeg = rota;
    out.expiraMs = (Math.floor(now / 1000 / rota) + 1) * rota * 1000;
  }
  return ok(res, out);
}
// Regenerar: sube qr_version -> el impreso viejo (v distinta) deja de servir.
async function apiRegenerarQrAsistencia(p, res) {
  if (!requireAdmin(p)) return err(res, 'No autorizado', 403);
  const { data: cfg } = await tSelect('motel_config', 'qr_version').maybeSingle();
  const nueva = Number((cfg && cfg.qr_version) || 1) + 1;
  await tUpdate('motel_config', { qr_version: nueva, updated_at: new Date().toISOString() }).eq('motel_id', MOTEL_ID);
  return ok(res, { qrVersion: nueva });
}

async function apiGetSchedule(p, res) {
  const ws=String(p.weekStart||'').trim();
  let query=tSelect('schedule','*');
  if(ws)query=query.eq('week_start',ws);
  const{data}=await query.order('shift_id').order('area');
  return ok(res,{schedule:(data||[]).map(r=>({weekStart:r.week_start,shiftId:r.shift_id,area:r.area,personName:r.person_name,dayOfWeek:r.day_of_week,type:r.type,horaEntrada:r.hora_entrada||'',horaSalida:r.hora_salida||'',extraNombre:r.extra_nombre||'',extraTurno:r.extra_turno||''}))});
}

async function apiSaveSchedule(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo el administrador puede guardar el calendario');
  const ws=String(p.weekStart||'').trim(),entries=p.entries||[];
  if(!ws)return err(res,'Semana requerida');
  const mesPrefix=ws.substring(0,7);
  const existingRes=await tSelect('schedule','id,area,person_name,day_of_week,type');
  const existing=existingRes.data||[];
  const personasEnEntradas=[...new Set(entries.map(function(e){return e.area+'|'+e.personName;}))];
  const toDelete=(existing||[]).filter(function(r){
    if(!String(r.day_of_week||'').startsWith(mesPrefix))return false;
    if(String(r.type||'').startsWith('extra')||String(r.type||'')==='extra_day')return false;
    return personasEnEntradas.indexOf(r.area+'|'+r.person_name)>=0;
  }).map(function(r){return r.id;});
  if(toDelete.length>0){await tDelete('schedule').in('id',toDelete);}
  if(entries.length>0){
    const rows=entries.map(e=>({week_start:ws,shift_id:String(e.shiftId||''),area:String(e.area||''),person_name:String(e.personName||''),day_of_week:String(e.dayOfWeek||''),type:String(e.type||'normal'),hora_entrada:String(e.horaEntrada||''),hora_salida:String(e.horaSalida||''),extra_nombre:String(e.extraNombre||''),extra_turno:String(e.extraTurno||'')}));
    await tInsert('schedule',rows);
  }

  // ===== ESPEJO a `grilla` (Pieza 5a) — read-model que lee la app colaborador =====
  // Va en try/catch APARTE: si el espejo falla, el guardado de schedule (arriba, ya hecho)
  // NO se afecta. Resuelve staff_id por nombre como la migracion; nombres sin persona se
  // reportan (grillaAviso) pero NO bloquean. `grilla` no esta en TENANT_TABLES -> motel_id explicito.
  let grillaAviso = null;
  try {
    const norm = x => String(x||'').trim().toLowerCase();
    const normArea = a => { const x=norm(a);
      if(x.startsWith('camarer'))return 'Camareria';
      if(x.startsWith('patier')||x==='patio')return 'Patio';
      if(x.startsWith('recep'))return 'Recepcion';
      if(x.startsWith('manten'))return 'Mantenimiento';
      return String(a||''); };
    const { data: staffRows } = await tSelect('staff','id,name');
    const nameToId = {}; (staffRows||[]).forEach(r => { nameToId[norm(r.name)] = r.id; });
    const idOf = e => nameToId[norm(e.personName)];
    // 1) borrar en grilla el MES de las personas afectadas (solo celdas TRABAJO: preserva novedades)
    const primerDia = mesPrefix + '-01';
    const [gy,gm] = mesPrefix.split('-').map(Number);
    const mesSig = (gm===12) ? ((gy+1)+'-01-01') : (gy+'-'+String(gm+1).padStart(2,'0')+'-01');
    const staffAfectados = [...new Set(entries.map(idOf).filter(Boolean))];
    for (const sid of staffAfectados) {
      await supabase.from('grilla').delete()
        .eq('motel_id',MOTEL_ID).eq('staff_id',sid).eq('estado','TRABAJO').eq('anulado',false)
        .gte('fecha',primerDia).lt('fecha',mesSig);
    }
    // 2) upsert de las celdas que resuelven persona y tienen fecha real (doble turno -> onConflict)
    const gRows = entries
      .filter(e => idOf(e) && /^\d{4}-\d{2}-\d{2}$/.test(String(e.dayOfWeek||'')))
      .map(e => ({ motel_id:MOTEL_ID, staff_id:idOf(e), person_name:String(e.personName||''),
        fecha:String(e.dayOfWeek), shift_id:String(e.shiftId||''), area:normArea(e.area),
        hora_entrada:String(e.horaEntrada||''), hora_salida:String(e.horaSalida||''),
        estado:'TRABAJO', creado_ms:Date.now() }));
    if (gRows.length) await supabase.from('grilla').upsert(gRows,{onConflict:'motel_id,staff_id,fecha'});
    const sinResolver = [...new Set(entries.map(e=>e.personName).filter(pn => !nameToId[norm(pn)]))];
    if (sinResolver.length) { grillaAviso = 'Sin persona vinculada (no llegan a la app): ' + sinResolver.join(', '); console.warn('[grilla espejo] '+grillaAviso); }
  } catch (e) {
    grillaAviso = 'El espejo a grilla no se actualizo (el calendario SI se guardo).';
    console.warn('[grilla espejo] fallo:', e && e.message);
  }
  return ok(res,{saved:entries.length,weekStart:ws,grillaAviso});
}

// ===== PIEZA 5a (Etapa 2 · sub-1) — lectura de la grilla nueva desde `grilla` =====
// Read-model limpio: 1 fila por celda (staff_id x fecha) ya resuelta. Motel-scoped (tSelect).
// Sin gate de rol: la pestaña Turnos la ven RECEPTION/MAID igual que getSchedule.
async function apiGrillaGetMes(p, res) {
  const mes = /^\d{4}-\d{2}$/.test(String(p.mes || '')) ? String(p.mes) : '';
  if (!mes) return err(res, 'Mes requerido (YYYY-MM)');
  const [y, m] = mes.split('-').map(Number);
  const primer = mes + '-01';
  const sig = (m === 12) ? ((y + 1) + '-01-01') : (y + '-' + String(m + 1).padStart(2, '0') + '-01');
  const { data } = await tSelect('grilla',
    'staff_id,person_name,area,fecha,shift_id,hora_entrada,hora_salida,estado,es_comodin,es_mantenimiento,novedad_ref')
    .gte('fecha', primer).lt('fecha', sig).eq('anulado', false)
    .order('area').order('person_name').order('fecha');
  const cells = (data || []).map(r => ({
    staffId: r.staff_id, personName: r.person_name || '', area: r.area || '', fecha: r.fecha,
    shiftId: r.shift_id || '', horaEntrada: r.hora_entrada || '', horaSalida: r.hora_salida || '',
    estado: r.estado || 'TRABAJO', esComodin: !!r.es_comodin, esMantenimiento: !!r.es_mantenimiento,
    novedadRef: r.novedad_ref || null
  }));
  return ok(res, { mes, cells });
}

// Area normalizada de la grilla a partir del rol (o el area libre como fallback).
function areaGrillaDeStaff(st) {
  const rol = String((st && st.rol) || '').toUpperCase();
  if (rol === 'RECEPCION') return 'Recepcion';
  if (rol === 'CAMARERA') return 'Camareria';
  if (rol === 'PATIERO') return 'Patio';
  if (rol === 'MANTENIMIENTO') return 'Mantenimiento';
  const a = String((st && st.area) || '').toLowerCase();
  if (a.startsWith('camarer')) return 'Camareria';
  if (a.startsWith('patier') || a === 'patio') return 'Patio';
  if (a.startsWith('recep')) return 'Recepcion';
  if (a.startsWith('manten')) return 'Mantenimiento';
  return String((st && st.area) || '');
}

// ===== PIEZA 5a (Etapa 2 · sub-2) — guardado POR CELDA (upsert individual + auditoria) =====
// Gate REAL de admin (requireAdmin firmado, NO el userRole del body). Nunca reescribe el mes.
// TRABAJO exige turno+horas; las novedades PRESERVAN shift/horas actuales (para poder revertir).
async function apiGrillaGuardarCelda(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  const fecha = String(p.fecha || '').trim();
  const estado = String(p.estado || '').trim().toUpperCase();
  const ESTADOS = ['TRABAJO', 'DESCANSO', 'VACACIONES', 'INCAPACIDAD', 'PERMISO', 'NO_VINO'];
  if (!staffId) return err(res, 'Falta la persona');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res, 'Fecha invalida');
  if (ESTADOS.indexOf(estado) < 0) return err(res, 'Estado invalido');

  const { data: st } = await tSelect('staff', 'id,name,rol,area').eq('id', staffId).maybeSingle();
  if (!st) return err(res, 'Persona no encontrada');
  const { data: actual } = await tSelect('grilla', '*').eq('staff_id', staffId).eq('fecha', fecha).maybeSingle();

  let shiftId, he, hs;
  if (estado === 'TRABAJO') {
    shiftId = String(p.shiftId || '').trim();
    he = String(p.horaEntrada || '').trim();
    hs = String(p.horaSalida || '').trim();
    if (!/^SHIFT_[123]$/.test(shiftId)) return err(res, 'Elegi el turno');
    if (!/^\d{2}:\d{2}$/.test(he) || !/^\d{2}:\d{2}$/.test(hs)) return err(res, 'Pone entrada y salida');
  } else {
    // novedad: preserva el turno/horas actuales para que "volver a trabajo" los restaure
    shiftId = actual ? (actual.shift_id || null) : null;
    he = actual ? (actual.hora_entrada || '') : '';
    hs = actual ? (actual.hora_salida || '') : '';
  }

  const now = Date.now();
  const valorAnterior = actual ? {
    estado: actual.estado, shift_id: actual.shift_id, hora_entrada: actual.hora_entrada,
    hora_salida: actual.hora_salida, es_comodin: actual.es_comodin,
    es_mantenimiento: actual.es_mantenimiento, novedad_ref: actual.novedad_ref
  } : null;
  const row = {
    motel_id: MOTEL_ID, staff_id: staffId, person_name: st.name || '', fecha,
    shift_id: shiftId, area: areaGrillaDeStaff(st), hora_entrada: he, hora_salida: hs,
    estado, novedad_ref: null, anulado: false,
    editado_por: s.n || '', editado_ms: now, valor_anterior: valorAnterior
  };
  if (!actual) { row.creado_por = s.n || ''; row.creado_ms = now; }
  const { error } = await supabase.from('grilla').upsert(row, { onConflict: 'motel_id,staff_id,fecha' });
  if (error) return err(res, 'No se pudo guardar la celda');
  // Plan B: ajuste sobre un día ya montado -> novedad al colaborador (puntería 1 persona).
  const turnoLbl = { SHIFT_1: 'Mañana (T1)', SHIFT_2: 'Tarde (T2)', SHIFT_3: 'Noche (T3)' };
  const cuerpoNov = (estado === 'TRABAJO')
    ? ('Te cambiaron el turno del ' + fecha + ': ' + (turnoLbl[shiftId] || shiftId) + (he ? ' ' + he + '-' + hs : ''))
    : (estado === 'DESCANSO' ? ('Te pusieron descanso el ' + fecha) : ('Ajuste en tu horario del ' + fecha));
  await novedadColab(s, staffId, 'TURNO', cuerpoNov, 'CALENDARIO', fecha, 'Cambio de horario');
  return ok(res, { estado, fecha, staffId });
}

// ===== PIEZA 5a (Etapa 2 · sub-3) — VACACIONES por rango desde la grilla =====
// Gate REAL requireAdmin. Pinta el rango [desde,hasta] como VACACIONES en `grilla` Y registra
// la salida/reingreso en Personal (mismo efecto que apiSaveVacacionesEvent: historial +
// staff.fecha_ingreso/fecha_vacaciones). reingreso = último día + 1. La ACCIÓN vive en la grilla;
// el REGISTRO sigue en Personal (aparece solo en la ficha del colaborador).
async function apiGrillaVacaciones(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  const desde = String(p.desde || '').trim();
  const hasta = String(p.hasta || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return err(res, 'Fechas invalidas');
  if (hasta < desde) return err(res, 'El ultimo dia no puede ser antes del primero');
  const { data: st } = await tSelect('staff', 'id,name,rol,area,fecha_ingreso').eq('id', staffId).maybeSingle();
  if (!st) return err(res, 'Persona no encontrada');

  // reingreso = ultimo dia + 1 ; proxima tentativa = reingreso + 1 año (igual que el flujo de Personal)
  const rd = new Date(hasta + 'T00:00:00'); rd.setDate(rd.getDate() + 1);
  const reingreso = rd.getFullYear() + '-' + String(rd.getMonth() + 1).padStart(2, '0') + '-' + String(rd.getDate()).padStart(2, '0');
  const prox = new Date(reingreso + 'T00:00:00'); prox.setFullYear(prox.getFullYear() + 1);
  const proxStr = prox.getFullYear() + '-' + String(prox.getMonth() + 1).padStart(2, '0') + '-' + String(prox.getDate()).padStart(2, '0');

  const { data: vh } = await tInsert('staff_vacaciones_historial', {
    staff_id: staffId, fecha_ingreso: st.fecha_ingreso, fecha_salida_vacaciones: desde, fecha_reingreso: reingreso
  }).select('id').maybeSingle();
  await tUpdate('staff', { fecha_ingreso: reingreso, fecha_vacaciones: proxStr }).eq('id', staffId);

  // Pintar el rango en grilla (VACACIONES). shift/horas se preservan en updates (revert los restaura).
  const area = areaGrillaDeStaff(st);
  const now = Date.now();
  const rows = [];
  const cur = new Date(desde + 'T00:00:00'), end = new Date(hasta + 'T00:00:00');
  while (cur <= end) {
    const f = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
    rows.push({ motel_id: MOTEL_ID, staff_id: staffId, person_name: st.name || '', fecha: f, area: area,
      estado: 'VACACIONES', novedad_ref: (vh ? vh.id : null), anulado: false, editado_por: s.n || '', editado_ms: now });
    cur.setDate(cur.getDate() + 1);
  }
  if (rows.length) await supabase.from('grilla').upsert(rows, { onConflict: 'motel_id,staff_id,fecha' });
  // Plan B: novedad al colaborador (puntería 1 persona).
  await novedadColab(s, staffId, 'TURNO', 'Te programaron vacaciones del ' + desde + ' al ' + hasta + ' (regresás el ' + reingreso + ')', 'CALENDARIO', desde, 'Vacaciones');
  return ok(res, { dias: rows.length, reingreso });
}

// ===== SUB-ETAPA 1 (lado admin de Personal) — Chat + Permisos =====
// Todos gate REAL requireAdmin. Tablas ya en TENANT_TABLES (scope por motel via tSelect/tInsert/tUpdate).

// apiChatEstado: badges por persona + aviso global (mensajes COLAB sin leer por admin).
async function apiChatEstado(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const { data } = await tSelect('staff_mensajes', 'staff_id,cuerpo,autor,created_ms')
    .eq('origen', 'COLAB').eq('leido_admin', false).eq('anulado', false)
    .order('created_ms', { ascending: false });
  const rows = data || [];
  const porStaff = {};
  rows.forEach(r => { porStaff[r.staff_id] = (porStaff[r.staff_id] || 0) + 1; });
  const ultimo = rows.length ? { staffId: rows[0].staff_id, nombre: rows[0].autor || '', preview: String(rows[0].cuerpo || '').slice(0, 60) } : null;
  return ok(res, { porStaff, total: rows.length, ultimo });
}

// apiStaffConversacion: hilo de esa persona; tarjetas PERMISO con estado vivo. Abrir = leer (leido_admin).
async function apiStaffConversacion(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  const { data } = await tSelect('staff_mensajes', 'id,origen,tipo,cuerpo,permiso_id,autor,created_ms')
    .eq('staff_id', staffId).eq('anulado', false).order('created_ms', { ascending: true });
  const rows = data || [];
  const permIds = rows.filter(r => r.tipo === 'PERMISO' && r.permiso_id).map(r => r.permiso_id);
  const permMap = {};
  if (permIds.length) {
    const { data: perms } = await tSelect('staff_permisos',
      'id,tipo,fecha,dia_completo,hora_desde,hora_hasta,motivo,estado,remunerado,respuesta_comentario,soporte_path')
      .in('id', permIds);
    (perms || []).forEach(pr => { permMap[pr.id] = pr; });
  }
  const mensajes = rows.map(r => {
    const m = { id: r.id, origen: r.origen, tipo: r.tipo, cuerpo: r.cuerpo, autor: r.autor || '', createdMs: r.created_ms || null };
    if (r.tipo === 'PERMISO' && permMap[r.permiso_id]) {
      const pr = permMap[r.permiso_id];
      m.permiso = {
        id: pr.id, tipo: pr.tipo, fecha: pr.fecha, diaCompleto: pr.dia_completo,
        horaDesde: pr.hora_desde, horaHasta: pr.hora_hasta, motivo: pr.motivo || '',
        estado: pr.estado, remunerado: pr.remunerado, respuestaComentario: pr.respuesta_comentario || '',
        tieneSoporte: !!pr.soporte_path
      };
    }
    return m;
  });
  await tUpdate('staff_mensajes', { leido_admin: true, leido_admin_ms: Date.now() })
    .eq('staff_id', staffId).eq('origen', 'COLAB').eq('leido_admin', false);
  return ok(res, { mensajes });
}

// apiStaffResponder: admin escribe. leido_colab=false -> el colaborador lo ve como no leido.
async function apiStaffResponder(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  const cuerpo = String(p.cuerpo || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  if (!cuerpo) return err(res, 'Escribe un mensaje');
  if (cuerpo.length > 2000) return err(res, 'Mensaje muy largo');
  const now = Date.now();
  await tInsert('staff_mensajes', {
    staff_id: staffId, origen: 'ADMIN', tipo: 'MENSAJE', cuerpo, destino: 'CHAT',
    autor: s.n || 'Administración', leido_admin: true, leido_admin_ms: now,
    leido_colab: false, created_ms: now
  });
  await sendPushToStaff(staffId, { title: 'Administración', body: cuerpo.slice(0, 120), url: '/?abrir=chat', tag: 'chat-admin' });
  return ok(res, {});
}

// apiResolverPermiso: TRIPLE accion -> permiso + notificacion + grilla automatica.
async function apiResolverPermiso(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const permisoId = Number(p.permisoId || 0);
  const decision = String(p.decision || '').trim().toUpperCase();
  const comentario = String(p.comentario || '').trim();
  if (!permisoId) return err(res, 'Falta el permiso');
  if (decision !== 'APROBADO' && decision !== 'RECHAZADO') return err(res, 'Decision invalida');
  const { data: perm } = await tSelect('staff_permisos', '*').eq('id', permisoId).maybeSingle();
  if (!perm) return err(res, 'Permiso no encontrado');
  if (perm.estado !== 'PENDIENTE') return err(res, 'Este permiso ya fue resuelto');
  const remunerado = (decision === 'APROBADO') ? (p.remunerado === true || p.remunerado === 'true') : null;
  const now = Date.now();

  // 1) actualizar el permiso
  await tUpdate('staff_permisos', {
    estado: decision, remunerado, respuesta_comentario: comentario || null,
    resuelto_por: s.n || '', resuelto_ms: now
  }).eq('id', permisoId);

  // 2) notificacion al colaborador (mensaje ADMIN, leido_colab=false)
  const cuerpoNoti = (decision === 'APROBADO')
    ? ('Permiso aprobado (' + (remunerado ? 'remunerado' : 'no remunerado') + ')' + (comentario ? ': ' + comentario : ''))
    : ('Permiso no aprobado' + (comentario ? ': ' + comentario : ''));
  await tInsert('staff_mensajes', {
    staff_id: perm.staff_id, origen: 'ADMIN', tipo: 'MENSAJE', cuerpo: cuerpoNoti, destino: 'CHAT',
    autor: s.n || 'Administración', leido_admin: true, leido_admin_ms: now,
    leido_colab: false, created_ms: now
  });
  await sendPushToStaff(perm.staff_id, { title: 'Respuesta de permiso', body: cuerpoNoti, url: '/?abrir=chat', tag: 'permiso-' + permisoId });

  // 3) conexion automatica a la grilla (solo aprobado)
  let grillaAviso = null;
  if (decision === 'APROBADO') {
    try {
      const { data: st } = await tSelect('staff', 'id,name,rol,area').eq('id', perm.staff_id).maybeSingle();
      const area = areaGrillaDeStaff(st || {});
      if (perm.dia_completo) {
        await supabase.from('grilla').upsert({
          motel_id: MOTEL_ID, staff_id: perm.staff_id, person_name: (st && st.name) || '',
          fecha: perm.fecha, area, estado: 'PERMISO', novedad_ref: permisoId, anulado: false,
          editado_por: s.n || '', editado_ms: now
        }, { onConflict: 'motel_id,staff_id,fecha' });
      } else {
        const { data: cell } = await tSelect('grilla', 'id,estado')
          .eq('staff_id', perm.staff_id).eq('fecha', perm.fecha).eq('anulado', false).maybeSingle();
        if (cell && cell.estado === 'TRABAJO') {
          await tUpdate('grilla', { novedad_ref: permisoId, editado_por: s.n || '', editado_ms: now }).eq('id', cell.id);
        } else {
          grillaAviso = 'Aprobado por horas, pero ese día no tiene turno en la grilla (no se marcó el puntito).';
        }
      }
    } catch (e) { grillaAviso = 'El permiso se aprobó, pero no se pudo pintar la grilla.'; }
  }
  return ok(res, { estado: decision, grillaAviso });
}

// apiVerSoportePermiso: signed URL 60s de la foto de soporte del permiso (patron descargarDocumento).
async function apiVerSoportePermiso(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const permisoId = Number(p.permisoId || 0);
  if (!permisoId) return err(res, 'Falta el permiso');
  const { data: perm } = await tSelect('staff_permisos', 'soporte_bucket,soporte_path').eq('id', permisoId).maybeSingle();
  if (!perm || !perm.soporte_path) return err(res, 'Este permiso no tiene soporte');
  const { data: signed, error } = await supabase.storage.from(perm.soporte_bucket || 'permisos').createSignedUrl(perm.soporte_path, 60);
  if (error || !signed) return err(res, 'No se pudo generar el enlace');
  return ok(res, { url: signed.signedUrl });
}

// ===== SUB-ETAPA 2 (lado admin de Personal) — Documentos + Validar incapacidad =====

// apiStaffDocumentos: TODOS los docs de esa persona (empresa visibles/ocultos + incapacidades con estado).
async function apiStaffDocumentos(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  const { data } = await tSelect('staff_documentos',
    'id,tipo,titulo,mime,visible,estado,inc_dias,inc_desde,subido_por,subido_rol,created_ms,validado_por,validado_ms')
    .eq('staff_id', staffId).eq('anulado', false).order('created_ms', { ascending: false });
  const docs = (data || []).map(d => ({
    id: d.id, tipo: d.tipo, titulo: d.titulo, mime: d.mime || '', visible: !!d.visible,
    estado: d.estado || null, incDias: d.inc_dias || null, incDesde: d.inc_desde || null,
    subidoPor: d.subido_por || '', subidoRol: d.subido_rol || '', createdMs: d.created_ms || null,
    validadoPor: d.validado_por || '', validadoMs: d.validado_ms || null
  }));
  return ok(res, { empresa: docs.filter(d => d.tipo === 'empresa'), incapacidades: docs.filter(d => d.tipo === 'incapacidad') });
}

// apiSubirDocumento: admin sube un doc de EMPRESA (bucket privado staff-docs). Imagen o PDF.
async function apiSubirDocumento(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  const titulo = String(p.titulo || '').trim();
  const visible = (p.visible === true || p.visible === 'true');
  // tipo: 'empresa' (default) o docs de liquidación (Pieza 2). Los de liquidación son INTERNOS:
  // visible=false forzado (el colaborador nunca los ve) y no disparan novedad.
  const TIPOS_DOC = ['empresa', 'liquidacion', 'liquidacion_comprobante'];
  const tipoDoc = TIPOS_DOC.indexOf(String(p.tipo || 'empresa')) >= 0 ? String(p.tipo || 'empresa') : 'empresa';
  const visibleFinal = (tipoDoc === 'empresa') ? visible : false;
  const file = String(p.fileBase64 || '');
  if (!staffId) return err(res, 'Falta la persona');
  if (!titulo) return err(res, 'Falta el título');
  const m = file.match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
  if (!m) return err(res, 'Adjunta el archivo');
  const mime = m[1];
  if (!/^image\//.test(mime) && mime !== 'application/pdf') return err(res, 'Solo imágenes o PDF');
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) return err(res, 'El archivo no se pudo leer');
  if (buffer.length > 10 * 1024 * 1024) return err(res, 'El archivo es muy pesado (máx 10MB)');
  const ext = (mime === 'application/pdf') ? 'pdf' : (mime === 'image/png' ? 'png' : 'jpg');
  const now = Date.now();
  const path = MOTEL_ID + '/' + staffId + '/doc_' + now + '.' + ext;
  const up = await supabase.storage.from('staff-docs').upload(path, buffer, { contentType: mime, upsert: false });
  if (up.error) return err(res, 'No se pudo subir el archivo');
  await tInsert('staff_documentos', {
    staff_id: staffId, tipo: tipoDoc, titulo, bucket: 'staff-docs', path, mime,
    visible: visibleFinal, estado: null, subido_por: s.n || '', subido_rol: 'ADMIN', created_ms: now
  });
  // Plan B: si es visible, novedad al colaborador (si está oculto no lo ve, no se avisa).
  if (visibleFinal) await novedadColab(s, staffId, 'DOCUMENTO', 'Nuevo documento en tu expediente: ' + titulo, 'DOCUMENTO', null, 'Documento nuevo');
  return ok(res, {});
}

// apiDescargarDocumentoAdmin: signed URL 60s de cualquier doc (incl. soporte de incapacidad).
async function apiDescargarDocumentoAdmin(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const docId = Number(p.docId || 0);
  if (!docId) return err(res, 'Falta el documento');
  const { data: doc } = await tSelect('staff_documentos', 'bucket,path,anulado').eq('id', docId).maybeSingle();
  if (!doc || doc.anulado === true || !doc.path) return err(res, 'No disponible');
  const { data: signed, error } = await supabase.storage.from(doc.bucket).createSignedUrl(doc.path, 60);
  if (error || !signed) return err(res, 'No se pudo generar el enlace');
  return ok(res, { url: signed.signedUrl });
}

// apiToggleVisibilidadDoc: "Lo ve" / "Oculto" — SOLO docs de empresa (la incapacidad la ve siempre el dueño).
async function apiToggleVisibilidadDoc(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const docId = Number(p.docId || 0);
  const visible = (p.visible === true || p.visible === 'true');
  if (!docId) return err(res, 'Falta el documento');
  const { data: doc } = await tSelect('staff_documentos', 'tipo').eq('id', docId).maybeSingle();
  if (!doc) return err(res, 'Documento no encontrado');
  if (doc.tipo !== 'empresa') return err(res, 'Solo los documentos de empresa cambian visibilidad');
  await tUpdate('staff_documentos', { visible }).eq('id', docId);
  return ok(res, { visible });
}

// apiValidarIncapacidad: TRIPLE accion -> corrige fecha/dias + notifica + celdas rojas a la grilla.
async function apiValidarIncapacidad(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const docId = Number(p.docId || 0);
  const decision = String(p.decision || '').trim().toUpperCase();
  const comentario = String(p.comentario || '').trim();
  if (!docId) return err(res, 'Falta el documento');
  if (decision !== 'VALIDADA' && decision !== 'RECHAZADA') return err(res, 'Decision invalida');
  const { data: doc } = await tSelect('staff_documentos', '*').eq('id', docId).maybeSingle();
  if (!doc || doc.tipo !== 'incapacidad') return err(res, 'Incapacidad no encontrada');
  if (doc.estado !== 'EN_REVISION') return err(res, 'Esta incapacidad ya fue resuelta');
  const now = Date.now();
  let incDesde = doc.inc_desde, incDias = doc.inc_dias;
  if (decision === 'VALIDADA') {
    const nd = String(p.incDesde || '').trim();
    const ni = parseInt(p.incDias, 10);
    if (nd) { if (!/^\d{4}-\d{2}-\d{2}$/.test(nd)) return err(res, 'Fecha inicio invalida'); incDesde = nd; }
    if (Number.isInteger(ni) && ni >= 1 && ni <= 365) incDias = ni;
    if (!incDesde || !incDias) return err(res, 'Faltan fecha inicio o dias');
  }
  await tUpdate('staff_documentos', {
    estado: decision, inc_desde: incDesde, inc_dias: incDias, validado_por: s.n || '', validado_ms: now
  }).eq('id', docId);

  const cuerpoNoti = (decision === 'VALIDADA')
    ? ('Incapacidad validada · ' + incDias + (incDias === 1 ? ' día' : ' días') + ' desde ' + incDesde + (comentario ? ': ' + comentario : ''))
    : ('Incapacidad rechazada' + (comentario ? ': ' + comentario : ''));
  await tInsert('staff_mensajes', {
    staff_id: doc.staff_id, origen: 'ADMIN', tipo: 'MENSAJE', cuerpo: cuerpoNoti, destino: 'CHAT',
    autor: s.n || 'Administración', leido_admin: true, leido_admin_ms: now, leido_colab: false, created_ms: now
  });
  await sendPushToStaff(doc.staff_id, { title: 'Incapacidad', body: cuerpoNoti, url: '/?abrir=chat', tag: 'incapacidad-' + docId });

  let grillaAviso = null;
  if (decision === 'VALIDADA') {
    try {
      const { data: st } = await tSelect('staff', 'id,name,rol,area').eq('id', doc.staff_id).maybeSingle();
      const area = areaGrillaDeStaff(st || {});
      const rows = [];
      const cur = new Date(incDesde + 'T00:00:00');
      for (let i = 0; i < incDias; i++) {
        const f = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
        rows.push({ motel_id: MOTEL_ID, staff_id: doc.staff_id, person_name: (st && st.name) || '', fecha: f, area,
          estado: 'INCAPACIDAD', novedad_ref: docId, anulado: false, editado_por: s.n || '', editado_ms: now });
        cur.setDate(cur.getDate() + 1);
      }
      if (rows.length) await supabase.from('grilla').upsert(rows, { onConflict: 'motel_id,staff_id,fecha' });
    } catch (e) { grillaAviso = 'La incapacidad se validó, pero no se pudo pintar la grilla.'; }
  }
  return ok(res, { estado: decision, incDesde, incDias, grillaAviso });
}

// apiAnularDocumento: anular (nunca borrar), con auditoria.
async function apiAnularDocumento(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const docId = Number(p.docId || 0);
  if (!docId) return err(res, 'Falta el documento');
  const { data: doc } = await tSelect('staff_documentos', 'id').eq('id', docId).maybeSingle();
  if (!doc) return err(res, 'Documento no encontrado');
  await tUpdate('staff_documentos', { anulado: true, anulado_por: s.n || '', anulado_ms: Date.now() }).eq('id', docId);
  return ok(res, {});
}

// ===== CAPACITACIONES (P4) — crear (fan-out novedad + push) y listar =====
async function apiCrearCapacitacion(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const fecha = String(p.fecha || '').trim();
  const hora = String(p.hora || '').trim();
  const titulo = String(p.titulo || '').trim();
  const destino = String(p.destino || '').trim().toUpperCase();
  const DESTINOS = ['TODOS', 'RECEPCION', 'CAMARERA', 'PATIERO', 'MANTENIMIENTO', 'SERVICIOS'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res, 'Fecha inválida');
  if (!titulo) return err(res, 'Falta el título');
  if (DESTINOS.indexOf(destino) < 0) return err(res, 'Destinatarios inválidos');
  if (hora && !/^\d{2}:\d{2}$/.test(hora)) return err(res, 'Hora inválida (HH:MM)');
  const now = Date.now();
  const { data: cap } = await tInsert('staff_capacitaciones', {
    fecha, hora: hora || null, titulo, destino, created_por: s.n || '', created_ms: now
  }).select('id').maybeSingle();
  // fan-out: novedad + push a cada destinatario (nomina activa; por rol o TODOS). Puntería por persona.
  const { data: staffAll } = await tSelect('staff', 'id,rol,type,active');
  const targets = (staffAll || []).filter(st =>
    st.active !== false && (st.type || 'nomina') !== 'extra' &&
    (destino === 'TODOS' || String(st.rol || '').toUpperCase() === destino));
  const cuerpo = '🎓 Capacitación: ' + titulo + ' · ' + fecha + (hora ? (' ' + hora) : '');
  for (const st of targets) {
    await novedadColab(s, st.id, 'CAPACITACION', cuerpo, 'CALENDARIO', fecha, 'Capacitación');
  }
  return ok(res, { creada: (cap && cap.id) || null, destinatarios: targets.length });
}

// ===== COMUNICADOS (Sub-etapa 3 · Pieza 1) — crear + fan-out (novedad + push) =====
// Padre en staff_comunicados + 1 fila staff_mensajes tipo COMUNICADO por destinatario (con comunicado_id).
// El colaborador YA pinta tipo COMUNICADO en su chat (📢). destino EXTRAS = pestaña ⚡ Extras.
async function apiCrearComunicado(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const cuerpo = String(p.cuerpo || '').trim();
  const destino = String(p.destino || '').trim().toUpperCase();
  const DESTINOS = ['TODOS', 'RECEPCION', 'CAMARERA', 'PATIERO', 'MANTENIMIENTO', 'SERVICIOS', 'EXTRAS'];
  if (!cuerpo) return err(res, 'Escribe el comunicado');
  if (cuerpo.length > 2000) return err(res, 'Comunicado muy largo');
  if (DESTINOS.indexOf(destino) < 0) return err(res, 'Destinatarios inválidos');
  const now = Date.now();
  const { data: com } = await tInsert('staff_comunicados', {
    destino, cuerpo, autor: s.n || '', created_ms: now
  }).select('id').maybeSingle();
  const comId = (com && com.id) || null;
  // fan-out: activos; EXTRAS -> extras aprobados; resto -> nomina por rol (o TODOS). Puntería por persona.
  const { data: staffAll } = await tSelect('staff', 'id,rol,type,active,estado_registro,salida_ms');
  const targets = (staffAll || []).filter(st => st.active !== false && !st.salida_ms && (
    destino === 'EXTRAS'
      ? ((st.type || '') === 'extra' && st.estado_registro === 'APROBADO')
      : ((st.type || 'nomina') !== 'extra' && (destino === 'TODOS' || String(st.rol || '').toUpperCase() === destino))));
  for (const st of targets) {
    await novedadColab(s, st.id, 'COMUNICADO', cuerpo, 'CHAT', null, '📢 Comunicado', { comunicado_id: comId });
  }
  return ok(res, { creado: comId, destinatarios: targets.length });
}

// ===== ELIMINAR EXTRA (Sub-etapa 3 · Pieza 4) — soft, historial intacto =====
// El extra (staff type='extra') que ya no se va a llamar: sale de la lista pero su fila NUNCA se borra
// (asistencias/pagos quedan). Regla de Oro: marca salida_* + auditoría. Corta la app (pin_version+1).
// OJO: NO es apiDeleteExtra (esa opera sobre extra_staff, extras de TURNO).
async function apiEliminarExtra(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  const { data: st } = await tSelect('staff', 'id,type,salida_ms,pin_version').eq('id', staffId).maybeSingle();
  if (!st) return err(res, 'No encontrado');
  if ((st.type || '') !== 'extra') return err(res, 'Solo aplica a extras');
  if (st.salida_ms) return err(res, 'Ya está fuera de la lista');
  const now = Date.now();
  await tUpdate('staff', {
    salida_tipo: 'ELIMINADO_EXTRA', salida_por: s.n || '', salida_ms: now,
    active: false,                                   // bloquea el LOGIN (el colaborador chequea active===false)
    pin_version: (Number(st.pin_version) || 1) + 1   // + mata la sesión activa (carnet viejo inválido)
  }).eq('id', staffId);
  return ok(res, { eliminado: true });
}

// ===== LIQUIDAR nómina (Sub-etapa 3 · Pieza 2) — soft, historial intacto, corta la app =====
// Motivo obligatorio; carta/comprobantes son docs opcionales (se suben antes con apiSubirDocumento
// tipo liquidacion/liquidacion_comprobante, o se adjuntan después en la carpeta). Sale de activos.
async function apiLiquidar(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  const tipo = String(p.tipo || '').trim().toUpperCase();
  const TIPOS = ['RENUNCIA', 'DESPIDO', 'FIN_CONTRATO'];
  const obs = String(p.observaciones || '').trim();
  const fecha = String(p.fecha || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  if (TIPOS.indexOf(tipo) < 0) return err(res, 'Motivo inválido');
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res, 'Fecha inválida');
  const { data: st } = await tSelect('staff', 'id,type,salida_ms,pin_version').eq('id', staffId).maybeSingle();
  if (!st) return err(res, 'No encontrado');
  if ((st.type || 'nomina') === 'extra') return err(res, 'Los extras se eliminan, no se liquidan');
  if (st.salida_ms) return err(res, 'Ya está liquidado');
  const now = Date.now();
  await tUpdate('staff', {
    salida_tipo: tipo, salida_fecha: fecha || null, salida_obs: obs || null,
    salida_por: s.n || '', salida_ms: now,
    active: false,                                   // bloquea el LOGIN (el colaborador chequea active===false)
    pin_version: (Number(st.pin_version) || 1) + 1   // + mata la sesión activa (carnet viejo inválido)
  }).eq('id', staffId);
  return ok(res, { liquidado: true });
}

// ===== 📦 PERSONAL LIQUIDADO (Sub-etapa 3 · Pieza 3) — lista + carpeta =====
// Trae liquidados (nómina) y extras eliminados JUNTOS (salida_ms != null), con su carpeta completa.
async function apiGetLiquidados(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const { data } = await tSelect('staff', '*').not('salida_ms', 'is', null).order('salida_ms', { ascending: false });
  const list = data || [];
  const ids = list.map(r => r.id);
  const docsByStaff = {};
  if (ids.length) {
    const { data: docs } = await tSelect('staff_documentos', 'id,staff_id,tipo,titulo,mime,created_ms')
      .in('staff_id', ids).eq('anulado', false).order('created_ms', { ascending: false });
    (docs || []).forEach(d => { (docsByStaff[d.staff_id] = docsByStaff[d.staff_id] || []).push({ id: d.id, tipo: d.tipo, titulo: d.titulo, mime: d.mime || '', createdMs: d.created_ms || null }); });
  }
  return ok(res, { liquidados: list.map(r => ({
    id: r.id, name: r.name, area: r.area, type: r.type, rol: r.rol || '',
    salidaTipo: r.salida_tipo || '', salidaFecha: r.salida_fecha || '', salidaObs: r.salida_obs || '',
    salidaPor: r.salida_por || '', salidaMs: r.salida_ms || null,
    cedula: r.cedula || '', celular: r.celular || '', direccion: r.direccion || '',
    fechaNacimiento: r.fecha_nacimiento || '', fechaIngreso: r.fecha_ingreso || '',
    contactoEmergenciaNombre: r.contacto_emergencia_nombre || '', contactoEmergenciaTelefono: r.contacto_emergencia_telefono || '',
    contactoEmergencia: r.contacto_emergencia || '', correo: r.correo || '', eps: r.eps || '', arl: r.arl || '',
    docs: docsByStaff[r.id] || []
  })) });
}

// apiReintegrar: revierte la salida (por si fue error o vuelve al motel) -> vuelve a activos Y recupera
// el acceso a la app. active:true reabre el LOGIN; como el pin_hash NUNCA se tocó, entra con su MISMO
// PIN de siempre (el pin_version quedó subido = los carnets viejos siguen muertos, pero un login fresco
// emite uno nuevo). No hace falta ponerle un PIN nuevo con 🔑, salvo que el colaborador lo haya olvidado.
async function apiReintegrar(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  if (!staffId) return err(res, 'Falta la persona');
  const { data: st } = await tSelect('staff', 'id,salida_ms').eq('id', staffId).maybeSingle();
  if (!st) return err(res, 'No encontrado');
  if (!st.salida_ms) return err(res, 'No está fuera de la lista');
  const now = Date.now();
  await tUpdate('staff', {
    salida_tipo: null, salida_fecha: null, salida_obs: null, salida_por: null, salida_ms: null,
    active: true,                                    // reabre el login, con su PIN original
    reintegrado_por: s.n || '', reintegrado_ms: now
  }).eq('id', staffId);
  return ok(res, { reintegrado: true });
}

// apiGetCapacitaciones: lista del mes (para el admin en la grilla).
async function apiGetCapacitaciones(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const mes = /^\d{4}-\d{2}$/.test(String(p.mes || '')) ? String(p.mes) : '';
  if (!mes) return err(res, 'Mes requerido');
  const [y, m] = mes.split('-').map(Number);
  const sig = (m === 12) ? ((y + 1) + '-01-01') : (y + '-' + String(m + 1).padStart(2, '0') + '-01');
  const { data } = await tSelect('staff_capacitaciones', 'id,fecha,hora,titulo,destino')
    .eq('anulado', false).gte('fecha', mes + '-01').lt('fecha', sig).order('fecha');
  return ok(res, { capacitaciones: (data || []).map(c => ({ id: c.id, fecha: c.fecha, hora: c.hora || '', titulo: c.titulo, destino: c.destino })) });
}

// apiToggleCarpeta: visibilidad POR CARPETA (todos los docs de empresa con ese titulo).
async function apiToggleCarpeta(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const staffId = String(p.staffId || '').trim();
  const titulo = String(p.titulo || '').trim();
  const visible = (p.visible === true || p.visible === 'true');
  if (!staffId || !titulo) return err(res, 'Faltan datos');
  await tUpdate('staff_documentos', { visible })
    .eq('staff_id', staffId).eq('tipo', 'empresa').eq('titulo', titulo).eq('anulado', false);
  return ok(res, { visible });
}

// ==================== CONFIG ====================
async function apiSetMultiMaidMode(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const value=p.enabled?'true':'false';
  await tUpsert('settings',{key:'MULTI_MAID_MODE',value},{onConflict:'motel_id,key'});
  return ok(res,{multiMaidMode:p.enabled});
}
async function apiGetMultiMaidMode(p, res) {
  const settings=await getSettings();
  const enabled=String(settings.MULTI_MAID_MODE||'false')==='true';
  return ok(res,{multiMaidMode:enabled});
}
async function apiSetGoal(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const goal=Number(p.goal||0);
  await tUpsert('settings',{key:'DAILY_GOAL',value:String(goal)},{onConflict:'motel_id,key'});
  return ok(res,{goal});
}
async function apiSetPin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const targetName=String(p.targetName||'').trim(),pin=String(p.pin||'').trim();
  if(!targetName)return err(res,'Nombre requerido');
  await tUpsert('reception_pins',{user_name:targetName,pin,updated_at:new Date().toISOString()},{onConflict:'motel_id,user_name'});
  return ok(res,{});
}
async function apiDeletePin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const targetName=String(p.targetName||'').trim();
  if(!targetName)return err(res,'Nombre requerido');
  await tDelete('reception_pins').eq('user_name',targetName);
  return ok(res,{});
}
async function apiGetPins(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const{data}=await tSelect('reception_pins','user_name, pin');
  return ok(res,{pins:(data||[]).map(r=>({userName:r.user_name,hasPin:!!String(r.pin||'').trim()}))});
}
async function apiChangeAdminPin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const cur=String(p.currentPin||''),nw=String(p.newPin||'');
  const settings=await getSettings();
  if(cur!==String(settings.ADMIN_CODE||'2206'))return err(res,'PIN actual incorrecto');
  if(nw.length<4||!/^\d+$/.test(nw))return err(res,'PIN invalido');
  await tUpsert('settings',{key:'ADMIN_CODE',value:nw},{onConflict:'motel_id,key'});
  return ok(res,{});
}

async function apiRoomHistory(p, res) {
  const roomId=String(p.roomId||'').trim();
  if(!roomId)return err(res,'roomId requerido');
  const limit=Number(p.limit||30);
  const[stateRes,salesRes,taxiRes]=await Promise.all([
    tSelect('state_history','*').eq('room_id',roomId).order('ts_ms',{ascending:false}).limit(limit),
    tSelect('sales','*').eq('room_id',roomId).in('type',['SALE','EXTENSION','RENEWAL','HORA_GRATIS']).order('ts_ms',{ascending:false}).limit(limit),
    tSelect('taxi_expenses','*').eq('room_id',roomId).eq('anulada',false).order('ts_ms',{ascending:false}).limit(10)
  ]);
  return ok(res,{
    roomId,
    stateHistory:(stateRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),businessDay:r.business_day,fromState:r.from_state,toState:r.to_state,userName:r.user_name,meta:(()=>{try{return JSON.parse(r.meta_json||'{}');}catch(e){return{};}})()})),
    salesHistory:(salesRes.data||[]).map(r=>({id:r.id,origin:r.origin||'',tsMs:Number(r.ts_ms),businessDay:r.business_day,shiftId:r.shift_id||'',type:r.type,durationHrs:Number(r.duration_hrs||0),total:Number(r.total||0),people:Number(r.people||0),extraPeople:Number(r.extra_people||0),extraPeopleValue:Number(r.extra_people_value||0),arrivalType:r.arrival_type||'',arrivalPlate:r.arrival_plate||'',userName:r.user_name,payMethod:r.pay_method||'',checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:Number(r.due_ms||0)})),
    taxiHistory:(taxiRes.data||[]).map(r=>({id:r.id,tsMs:Number(r.ts_ms),amount:Number(r.amount||0)}))
  });
}

// ==================== BAR / GASTOS ====================
async function apiAddBarSale(p, res) {
  const now=Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Solo RECEPTION o ADMIN');
  const cash=Number(p.amountCash||0),card=Number(p.amountCard||0),nequi=Number(p.amountNequi||0);
  if(cash+card+nequi<=0)return err(res,'Monto total debe ser mayor a 0');
  await tInsert('bar_sales',{ts_ms:now,business_day:bDay,shift_id:shift,user_name:String(p.userName||''),description:String(p.description||'').trim(),amount_cash:cash,amount_card:card,amount_nequi:nequi,total:cash+card+nequi});
  return ok(res,{tsMs:now,total:cash+card+nequi,shiftId:shift});
}
async function apiGetBarSales(p, res) {
  const bDay=String(p.businessDay||businessDay(Date.now()));
  const shiftFilter=String(p.shiftId||'');
  let q=tSelect('bar_sales','*').eq('business_day',bDay).order('ts_ms');
  if(shiftFilter)q=q.eq('shift_id',shiftFilter);
  const{data}=await q;
  const list=(data||[]).map(r=>({id:r.id,tsMs:Number(r.ts_ms),shiftId:r.shift_id,userName:r.user_name,description:r.description||'',amountCash:Number(r.amount_cash||0),amountCard:Number(r.amount_card||0),amountNequi:Number(r.amount_nequi||0),total:Number(r.total||0)}));
  const totals=list.reduce((acc,r)=>({cash:acc.cash+r.amountCash,card:acc.card+r.amountCard,nequi:acc.nequi+r.amountNequi,total:acc.total+r.total}),{cash:0,card:0,nequi:0,total:0});
  return ok(res,{sales:list,totals});
}
async function apiAddGeneralExpense(p, res) {
  const now=Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Solo RECEPTION o ADMIN');
  const desc=String(p.description||'').trim(),amount=Number(p.amount||0);
  if(desc.length<3)return err(res,'Descripcion requerida (min 3 caracteres)');
  if(amount<=0)return err(res,'Monto debe ser mayor a 0');
  await tInsert('general_expenses',{ts_ms:now,business_day:bDay,shift_id:shift,user_name:String(p.userName||''),description:desc,amount,category:String(p.category||'Otro').trim()});
  return ok(res,{tsMs:now,amount,shiftId:shift});
}
async function apiGetGeneralExpenses(p, res) {
  const bDay=String(p.businessDay||businessDay(Date.now()));
  const shiftFilter=String(p.shiftId||'');
  let q=tSelect('general_expenses','*').eq('business_day',bDay).order('ts_ms');
  if(shiftFilter)q=q.eq('shift_id',shiftFilter);
  const{data}=await q;
  const list=(data||[]).map(r=>({id:r.id,tsMs:Number(r.ts_ms),shiftId:r.shift_id,userName:r.user_name,description:r.description||'',amount:Number(r.amount||0),category:r.category||''}));
  return ok(res,{expenses:list,total:list.reduce((a,r)=>a+r.amount,0)});
}

async function apiGetDailyCuadre(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const defaultDay=businessDay(Date.now()-86400000);
  const bDay=String(p.businessDay||defaultDay);

  const[salesRes,taxiRes,extraRes,barRes,gastoRes,shiftLogRes]=await Promise.all([
    tSelect('sales','type,total,pay_method,extra_people_value,shift_id,room_id,amount_1,amount_2,amount_3,anulada,devolucion_efectivo,devolucion_metodo_original,origin').eq('business_day',bDay),
    tSelect('taxi_expenses','amount,shift_id,anulada').eq('business_day',bDay).eq('anulada',false),
    tSelect('extra_staff','payment,shift_id,anulada').eq('business_day',bDay).eq('anulada',false),
    tSelect('bar_sales','amount_cash,amount_card,amount_nequi,shift_id').eq('business_day',bDay),
    tSelect('general_expenses','amount,shift_id').eq('business_day',bDay),
    tSelect('shift_log','shift_id,user_name,ts_ms').eq('business_day',bDay).eq('user_role','RECEPTION').eq('action','LOGIN').order('ts_ms')
  ]);

  const responsables={SHIFT_1:'—',SHIFT_2:'—',SHIFT_3:'—'};
  (shiftLogRes.data||[]).forEach(r=>{if(responsables[r.shift_id]==='—')responsables[r.shift_id]=r.user_name;});

  const shifts=['SHIFT_1','SHIFT_2','SHIFT_3'];
  const c={};
  shifts.forEach(sid=>{c[sid]={responsable:responsables[sid],tarjetaHab:0,tarjetaPersonas:0,tarjetaHoras:0,tarjetaBar:0,efectivoHab:0,efectivoPersonas:0,efectivoHoras:0,efectivoBar:0,nequiHab:0,nequiPersonas:0,nequiHoras:0,nequiBar:0,gastos:0,taxis:0,turnos:0,reservasApp:0,reservasAppDetalle:[]};});

  const cortesiaIds = await getCortesiaIds();
  (salesRes.data||[]).forEach(r=>{
    const sid=r.shift_id;if(!c[sid])return;
    // Devolucion cruzada: anulada pero con devolucion en efectivo
    const esCruzada = r.anulada && r.devolucion_efectivo;
    const metodoOriginal = String(r.devolucion_metodo_original||'').toUpperCase();
    if(r.anulada && !esCruzada) return;  // Anulada normal: ignorar
    // Etapa D: venta WOMPI (pago online) NO entra al cuadre de caja (el dinero no paso
    // por la recepcionista), pero SI se muestra como linea propia "Reservas (app)" con
    // detalle por habitacion. No suma a la entrega (entrega = solo lo que ella recibio).
    if(String(r.origin||'').toUpperCase()==='WOMPI'){
      const tW=Number(r.total||0);
      c[sid].reservasApp+=tW;
      c[sid].reservasAppDetalle.push({roomId:String(r.room_id||''),total:tW});
      return;
    }
    // Cortesia PRE-corte: excluir entero. POST-corte: la hab base aporta 0
    // (habVal=t-epv=0 tras Parte 1) y personas/horas suman. (Cuadre sin roomsSold.)
    if(cortesiaIds.has(String(r.room_id)) && String(bDay) < CORTESIA_COBRO_DESDE) return;
    const t=Number(r.total||0),pm=String(r.pay_method||'').toUpperCase(),epv=Number(r.extra_people_value||0);
    if(esCruzada){
      // La venta queda en su seccion original (el banco/Nequi tiene la plata)
      // Y se resta del efectivo (la caja entrego la plata al cliente)
      if(metodoOriginal==='TARJETA') c[sid].tarjetaHab+=t;
      else if(metodoOriginal==='NEQUI') c[sid].nequiHab=(c[sid].nequiHab||0)+t;
      c[sid].efectivoHab -= t;  // Resta porque salio efectivo de caja
      return;  // No procesar como venta normal
    }
    if(r.type==='SALE'){
      const habVal=t-epv;
      if(pm==='TARJETA'){c[sid].tarjetaHab+=habVal;c[sid].tarjetaPersonas+=epv;}
      else if(pm==='MIXTO'){c[sid].efectivoHab+=Number(r.amount_1||0);c[sid].tarjetaHab+=Number(r.amount_2||0);c[sid].nequiHab=(c[sid].nequiHab||0)+Number(r.amount_3||0);}
      else{c[sid].efectivoHab+=habVal;c[sid].efectivoPersonas+=epv;}
    }
    if(r.type==='RENEWAL'){
      const habVal=t-epv;
      if(pm==='TARJETA'){c[sid].tarjetaHab+=habVal;c[sid].tarjetaPersonas+=epv;}
      else if(pm==='MIXTO'){c[sid].efectivoHab+=Number(r.amount_1||0);c[sid].tarjetaHab+=Number(r.amount_2||0);c[sid].nequiHab=(c[sid].nequiHab||0)+Number(r.amount_3||0);}
      else{c[sid].efectivoHab+=habVal;c[sid].efectivoPersonas+=epv;}
    }
    if(r.type==='EXTENSION'){
      if(pm==='TARJETA')c[sid].tarjetaHoras+=t;
      else if(pm==='MIXTO'){c[sid].efectivoHoras+=Number(r.amount_1||0);c[sid].tarjetaHoras+=Number(r.amount_2||0);}
      else c[sid].efectivoHoras+=t;
    }
    if(r.type==='REFUND'){c[sid].efectivoHab+=t;} // negativo, se resta automaticamente
  });
  (barRes.data||[]).forEach(r=>{const sid=r.shift_id;if(!c[sid])return;c[sid].tarjetaBar+=Number(r.amount_card||0);c[sid].efectivoBar+=Number(r.amount_cash||0);c[sid].nequiBar+=Number(r.amount_nequi||0);});
  (taxiRes.data||[]).forEach(r=>{const sid=r.shift_id;if(c[sid])c[sid].taxis+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{const sid=r.shift_id;if(c[sid])c[sid].turnos+=Number(r.payment||0);});
  (gastoRes.data||[]).forEach(r=>{const sid=r.shift_id;if(c[sid])c[sid].gastos+=Number(r.amount||0);});

  const cuadre={};let diaTotal=0;
  shifts.forEach(sid=>{
    const x=c[sid];
    const totTarjeta=x.tarjetaHab+x.tarjetaPersonas+x.tarjetaHoras+x.tarjetaBar+x.reservasApp;  // Tarjeta INCLUYE reservas (app)
    const totNequi=x.nequiBar;
    const totEfectivo=x.efectivoHab+x.efectivoPersonas+x.efectivoHoras+x.efectivoBar;
    const totGastos=x.gastos+x.taxis+x.turnos;
    const entrega=totTarjeta+totEfectivo+totNequi-totGastos;
    diaTotal+=entrega;
    cuadre[sid]={responsable:x.responsable,tarjeta:{hab:x.tarjetaHab,personas:x.tarjetaPersonas,horas:x.tarjetaHoras,bar:x.tarjetaBar,reservasApp:{total:x.reservasApp,detalle:x.reservasAppDetalle},total:totTarjeta},efectivo:{hab:x.efectivoHab,personas:x.efectivoPersonas,horas:x.efectivoHoras,bar:x.efectivoBar,total:totEfectivo},nequi:{bar:x.nequiBar,total:totNequi},gastos:{generales:x.gastos,taxis:x.taxis,turnos:x.turnos,total:totGastos},entregaDiaria:entrega};
  });
  return ok(res,{businessDay:bDay,cuadre,entregaTotalDia:diaTotal});
}

async function apiGetPersonasHabitacion(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const businessDayParam = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  const roomId = String(p.roomId||'').trim();
  if(!businessDayParam) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  if(!roomId) return err(res,'roomId requerido');
  const { data, error } = await tSelect('sales', 'id, ts_ms, extra_people, extra_people_value, total, pay_method, user_name, anulada, anulada_ms, anulada_por, note, type, duration_hrs, base_price, editada, editada_por, editada_ms, motivo_edicion')
    .eq('business_day', businessDayParam)
    .eq('shift_id', shiftId)
    .eq('room_id', roomId)
    .in('type', ['SALE', 'ANULADA'])
    .gt('extra_people_value', 0)
    .order('ts_ms', { ascending: true });
  if(error) return err(res, error.message);
  const personas = (data||[]).map(r => ({
    ...r,
    esCheckIn: Number(r.duration_hrs||0) > 0 || Number(r.base_price||0) > 0
  }));
  return ok(res, { personas });
}
async function apiAgregarHoraExtraManual(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN puede agregar horas extra manualmente');
  const businessDayParam = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  const roomId = String(p.roomId||'').trim();
  const extraHrs = Number(p.extraHrs||0);
  const total = Number(p.total||0);
  const payMethod = String(p.payMethod||'EFECTIVO').toUpperCase();
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!businessDayParam) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  if(!roomId) return err(res,'roomId requerido');
  if(extraHrs<=0||extraHrs>6) return err(res,'Horas extra inválidas (1-6)');
  if(total<=0) return err(res,'Total inválido');
  if(!motivo||motivo.length<5) return err(res,'Motivo obligatorio (mínimo 5 caracteres)');
  const room = await getRoom(roomId);
  if(!room) return err(res,'Habitación no existe');
  const now = Date.now();
  const noteFinal = '[MANUAL] '+motivo;
  let amount_1=null, amount_2=null, amount_3=null, pay_method_2=null;
  if(payMethod==='MIXTO'){
    amount_1=Number(p.amount_1||0);
    amount_2=Number(p.amount_2||0);
    amount_3=Number(p.amount_3||0);
    if((amount_1+amount_2+amount_3)!==total) return err(res,'Suma del mixto debe ser igual al total');
    pay_method_2='MIXTO';
  }
  const { data: inserted, error: errIns } = await tInsert('sales',{
    ts_ms: now,
    business_day: businessDayParam,
    shift_id: shiftId,
    user_role: 'ADMIN',
    user_name: userName,
    type: 'EXTENSION',
    room_id: roomId,
    category: room.category,
    duration_hrs: extraHrs,
    base_price: total,
    people: Number(room.people||0),
    extra_hours: extraHrs,
    extra_hours_value: total,
    total: total,
    pay_method: payMethod,
    pay_method_2: pay_method_2,
    amount_1: amount_1,
    amount_2: amount_2,
    amount_3: amount_3,
    note: noteFinal,
    anulada: false
  }).select('id').single();
  if(errIns) return err(res,'Error guardando hora extra: '+errIns.message);
  await tInsert('state_history',{
    ts_ms: now,
    business_day: businessDayParam,
    shift_id: shiftId,
    user_role: userRole,
    user_name: userName,
    room_id: roomId,
    from_state: 'AJUSTE',
    to_state: 'HORA_EXTRA_MANUAL',
    people: Number(room.people||0),
    meta_json: JSON.stringify({
      accion:'HORA_EXTRA_AGREGADA_MANUAL',
      saleId: inserted.id,
      motivo: motivo,
      total: total,
      pay_method: payMethod,
      extra_hours: extraHrs
    })
  });
  return ok(res,{saleId:inserted.id, total, extraHrs});
}
async function apiGetExtrasHabitacion(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const businessDayParam = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  const roomId = String(p.roomId||'').trim();
  if(!businessDayParam) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  if(!roomId) return err(res,'roomId requerido');
  const { data, error } = await tSelect('sales', 'id, ts_ms, extra_hours, total, pay_method, user_name, anulada, anulada_ms, anulada_por, note')
    .eq('business_day', businessDayParam)
    .eq('shift_id', shiftId)
    .eq('room_id', roomId)
    .in('type', ['EXTENSION', 'ANULADA'])
    .gt('extra_hours', 0)
    .order('ts_ms', { ascending: true });
  if(error) return err(res, error.message);
  return ok(res, { extras: data || [] });
}
async function apiGetHabitacionesTurno(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const businessDayParam = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  if(!businessDayParam) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  const { data, error } = await tSelect('sales', 'room_id, category, type, anulada, duration_hrs, base_price, extra_people_value')
    .eq('business_day', businessDayParam)
    .eq('shift_id', shiftId)
    .in('type', ['SALE', 'RENEWAL', 'EXTENSION']);
  if(error) return err(res, error.message);
  const habitacionesMap = {};
  (data||[]).forEach(r => {
    if(r.anulada) return;
    if(!habitacionesMap[r.room_id]) {
      habitacionesMap[r.room_id] = { roomId: r.room_id, category: r.category, countExtensiones: 0, countPersonasAdicionales: 0 };
    }
    if(r.type === 'EXTENSION') habitacionesMap[r.room_id].countExtensiones++;
    if(r.type === 'SALE' && Number(r.extra_people_value||0)>0){
      habitacionesMap[r.room_id].countPersonasAdicionales++;
    }
  });
  const habitaciones = Object.values(habitacionesMap).sort((a,b) => String(a.roomId).localeCompare(String(b.roomId)));
  return ok(res, { habitaciones });
}
async function apiAgregarPersonaManual(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Sin permiso');
  const now = Date.now();
  const businessDayParam = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  const roomId = String(p.roomId||'').trim();
  const cantidad = Number(p.cantidad||0);
  const payMethod = String(p.payMethod||'EFECTIVO').toUpperCase();
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!businessDayParam) return err(res,'Día requerido');
  if(!shiftId) return err(res,'Turno requerido');
  if(!roomId) return err(res,'Habitación requerida');
  if(cantidad<=0) return err(res,'Cantidad inválida');
  if(!motivo||motivo.length<5) return err(res,'Motivo obligatorio (mínimo 5 caracteres)');
  const room = await getRoom(roomId);
  if(!room) return err(res,'Habitación no existe');
  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);
  const costPerPerson = Number(cfg.extraPerson||0);
  const totalCost = costPerPerson * cantidad;
  await tInsert('sales',{
    ts_ms:now, business_day:businessDayParam, shift_id:shiftId,
    user_role:'ADMIN', user_name:userName, type:'SALE',
    room_id:roomId, category:room.category, duration_hrs:0,
    base_price:0, people:cantidad, included_people:Number(cfg.included||2),
    extra_people:cantidad, extra_people_value:costPerPerson,
    total:totalCost, pay_method:payMethod,
    check_in_ms:0, due_ms:0,
    note:'[MANUAL] '+motivo
  });
  return ok(res,{roomId,cantidad,totalCost,businessDay:businessDayParam,shiftId});
}
async function apiEditarPersonasCheckIn(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN puede editar personas adicionales');
  const saleId = Number(p.saleId||0);
  const nuevaCantidad = Number(p.nuevaCantidad);
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!saleId) return err(res,'saleId requerido');
  if(!Number.isFinite(nuevaCantidad) || nuevaCantidad < 0) return err(res,'Cantidad inválida (debe ser >= 0)');
  if(!motivo || motivo.length < 5) return err(res,'Motivo obligatorio (mínimo 5 caracteres)');
  const { data: sale, error: errSale } = await tSelect('sales','*').eq('id', saleId).maybeSingle();
  if(errSale) return err(res, errSale.message);
  if(!sale) return err(res,'Venta no encontrada');
  if(sale.anulada) return err(res,'Esta venta está anulada, no se puede editar');
  // Cortesia: el ajuste de personas SI se permite (las personas adicionales se
  // cobran). El recompute opera sobre total/extra_people_value, ya consistentes.
  if(String(sale.pay_method_2||'') === 'MIXTO_EF_TJ_NQ') return err(res,'Venta con devolución cruzada, no se puede editar');
  const personasOriginales = Number(sale.extra_people||0);
  if(personasOriginales <= 0) return err(res,'Esta venta no tiene personas adicionales');
  if(nuevaCantidad > personasOriginales) return err(res,'Solo se puede REDUCIR la cantidad, no aumentar');
  if(nuevaCantidad === personasOriginales) return err(res,'La cantidad no cambia, nada que actualizar');
  const esCheckIn = Number(sale.duration_hrs||0) > 0 || Number(sale.base_price||0) > 0;
  if(!esCheckIn) return err(res,'Esta fila no es de check-in. Usá Anular en su lugar.');
  const { data: refunds } = await tSelect('sales', 'id').eq('room_id', sale.room_id).eq('check_in_ms', Number(sale.check_in_ms||0))
    .eq('type','REFUND').limit(1);
  if(refunds && refunds.length) return err(res,'Esta venta tiene una devolución asociada, no se puede editar');
  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, sale.category);
  const valorPorPersona = Number(cfg.extraPerson || 0);
  const extraPeopleValueNuevo = valorPorPersona * nuevaCantidad;
  const diferencia = Number(sale.extra_people_value||0) - extraPeopleValueNuevo;
  if(diferencia < 0) return err(res,'Inconsistencia: el valor nuevo es mayor que el original');
  const totalNuevo = Number(sale.total||0) - diferencia;
  if(totalNuevo < 0) return err(res,'Inconsistencia: el nuevo total queda negativo');
  const includedPeople = Number(sale.included_people||0);
  const peopleNuevo = includedPeople + nuevaCantidad;
  const payMethod = String(sale.pay_method||'EFECTIVO').toUpperCase();
  let newA1 = Number(sale.amount_1||0);
  let newA2 = Number(sale.amount_2||0);
  let newA3 = Number(sale.amount_3||0);
  if(payMethod === 'EFECTIVO'){ newA1 = totalNuevo; newA2 = 0; newA3 = 0; }
  else if(payMethod === 'TARJETA'){ newA1 = 0; newA2 = totalNuevo; newA3 = 0; }
  else if(payMethod === 'NEQUI'){ newA1 = 0; newA2 = 0; newA3 = totalNuevo; }
  else if(payMethod === 'MIXTO'){
    let restante = diferencia;
    const efDeducir = Math.min(restante, newA1);
    newA1 -= efDeducir; restante -= efDeducir;
    if(restante > 0){
      const tjDeducir = Math.min(restante, newA2);
      newA2 -= tjDeducir; restante -= tjDeducir;
    }
    if(restante > 0){
      const nqDeducir = Math.min(restante, newA3);
      newA3 -= nqDeducir; restante -= nqDeducir;
    }
    if(restante > 0) return err(res,'Inconsistencia en reparto MIXTO: amounts insuficientes');
    if((newA1 + newA2 + newA3) !== totalNuevo) return err(res,'Inconsistencia: suma amounts no cuadra con total nuevo');
  } else {
    return err(res,'Método de pago no reconocido: '+payMethod);
  }
  const now = Date.now();
  const noteFinal = String(sale.note||'') + ' | EDITADO: ' + motivo;
  const { error: errUpd } = await tUpdate('sales',{
    extra_people: nuevaCantidad,
    extra_people_value: extraPeopleValueNuevo,
    total: totalNuevo,
    people: peopleNuevo,
    amount_1: newA1,
    amount_2: newA2,
    amount_3: newA3,
    note: noteFinal,
    editada: true,
    editada_por: userName,
    editada_ms: now,
    motivo_edicion: motivo
  }).eq('id', saleId);
  if(errUpd) return err(res,'Error actualizando venta: '+errUpd.message);
  await tInsert('state_history',{
    ts_ms: now,
    business_day: sale.business_day,
    shift_id: sale.shift_id,
    user_role: userRole,
    user_name: userName,
    room_id: sale.room_id,
    from_state: 'AJUSTE',
    to_state: 'PERSONAS_EDITADAS',
    people: peopleNuevo,
    meta_json: JSON.stringify({
      accion: 'PERSONAS_CHECKIN_EDITADAS',
      saleId,
      motivo,
      personasAntes: personasOriginales,
      personasDespues: nuevaCantidad,
      extraPeopleValueAntes: Number(sale.extra_people_value||0),
      extraPeopleValueDespues: extraPeopleValueNuevo,
      totalAntes: Number(sale.total||0),
      totalDespues: totalNuevo,
      diferencia,
      payMethod
    })
  });
  return ok(res, { saleId, personasAntes: personasOriginales, personasDespues: nuevaCantidad, totalAntes: Number(sale.total||0), totalDespues: totalNuevo, diferencia });
}
async function apiAddExtraPerson(p, res) {
  const now=Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName=String(p.userName||'').trim(),roomId=String(p.roomId||'').trim();
  const payMethod=String(p.payMethod||'EFECTIVO').toUpperCase();
  const room=await getRoom(roomId);
  if(!room)return err(res,'Habitacion no existe');
  if(room.state!=='OCCUPIED')return err(res,'Habitacion no esta ocupada');
  const currentPeople=Number(room.people||0);
  if(currentPeople>=10)return err(res,'Maximo 10 personas');
  const PRICING = await getPricing(MOTEL_ID);
  const cfg = cfgFor(PRICING, room.category);
  const cost=Number(cfg.extraPerson||0),newPeople=currentPeople+1;
  await tUpdate('rooms',{people:newPeople,updated_at:new Date().toISOString()}).eq('room_id',roomId);
  await tInsert('sales',{ts_ms:now,business_day:bDay,shift_id:shift,user_role:'RECEPTION',user_name:userName,type:'SALE',room_id:roomId,category:room.category,duration_hrs:0,base_price:0,people:newPeople,included_people:Number(cfg.included||2),extra_people:newPeople-Number(cfg.included||2),extra_people_value:cost,total:cost,pay_method:payMethod,check_in_ms:Number(room.check_in_ms||0),due_ms:Number(room.due_ms||0),arrival_type:room.arrival_type||'',arrival_plate:room.arrival_plate||''});
  return ok(res,{roomId,newPeople,extraPersonCost:cost});
}

// ITEM 8: Cambio de habitacion - transfiere venta original a nueva habitacion
async function apiRoomChange(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const fromRoomId = String(p.fromRoomId || '').trim();
  const toRoomId = String(p.toRoomId || '').trim();
  if(!fromRoomId || !toRoomId) return err(res, 'Habitaciones requeridas');
  if(fromRoomId === toRoomId) return err(res, 'Debe seleccionar una habitacion diferente');

  const fromRoom = await getRoom(fromRoomId);
  const toRoom = await getRoom(toRoomId);
  if(!fromRoom) return err(res, 'Habitacion origen no existe');
  if(!toRoom) return err(res, 'Habitacion destino no existe');
  if(fromRoom.state !== 'OCCUPIED') return err(res, 'Habitacion origen no esta ocupada');
  if(toRoom.state !== 'AVAILABLE') return err(res, 'Habitacion destino no esta disponible');

  const PRICING = await getPricing(MOTEL_ID);
  const fromCfg = cfgFor(PRICING, fromRoom.category);
  const toCfg = cfgFor(PRICING, toRoom.category);
  const durationHrs = Number(p.durationHrs || 3);
  const people = Number(fromRoom.people || 2);
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();

  function calcTotalPrice(cfg, hrs, ppl) {
    let base = 0;
    if(hrs===3)base=cfg.h3;else if(hrs===6)base=cfg.h6;else if(hrs===8)base=cfg.h8;else if(hrs===12)base=cfg.h12;
    const incl = Number(cfg.included||2);
    const extra = Math.max(0, ppl-incl);
    return base + extra * Number(cfg.extraPerson||0);
  }

  // Cortesia: precio efectivo siempre 0 (misma regla que apiCheckIn). Flag por-habitacion.
  const precioCortAware = (room, cfg) => room.is_cortesia ? 0 : calcTotalPrice(cfg, durationHrs, people);
  const fromPrice = precioCortAware(fromRoom, fromCfg);
  const toPrice = precioCortAware(toRoom, toCfg);
  const diff = toPrice - fromPrice;

  // Marcar habitacion origen como RETOQUE
  await tUpdate('rooms',{
    state: 'AVAILABLE', retoque: true, state_since_ms: now,
    people: 0, due_ms: 0, last_checkout_ms: now,
    arrival_type: '', arrival_plate: '',
    checkout_obs: 'CAMBIO DE HABITACION a ' + toRoomId,
    updated_at: new Date().toISOString()
  }).eq('room_id', fromRoomId);

  // Check-in en habitacion destino con mismo tiempo que tenia la original
  const originalCheckInMs = Number(fromRoom.check_in_ms || now);
  const originalDueMs = Number(fromRoom.due_ms || (now + durationHrs * 3600000));

  await tUpdate('rooms',{
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: originalCheckInMs, due_ms: originalDueMs,
    arrival_type: fromRoom.arrival_type || 'WALK',
    arrival_plate: fromRoom.arrival_plate || '',
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0,
    pay_method: fromRoom.is_cortesia ? payMethod : (fromRoom.payMethod || payMethod),
    updated_at: new Date().toISOString()
  }).eq('room_id', toRoomId);

  // ITEM 8: Transferir la venta original de fromRoom a toRoom
  // Buscar la venta original de esta estadia
  const { data: originalSale } = await tSelect('sales', 'id, total, pay_method')
    .eq('room_id', fromRoomId)
    .eq('type', 'SALE')
    .eq('check_in_ms', originalCheckInMs)
    .limit(1);
  const saleId = (originalSale && originalSale.length) ? originalSale[0].id : null;
  const saleTotalOriginal = (originalSale && originalSale.length) ? Number(originalSale[0].total||0) : 0;

  let caso = 'NORMAL';
  if(toRoom.is_cortesia){
    // ===== CASO A: cambio HACIA cortesia (entra a cortesia) =====
    // La venta queda en $0. La plata cobrada se devuelve fisicamente al cliente.
    // NO se inserta REFUND: poner total=0 ya representa ingreso neto $0 y mantiene
    // Cierre = Resumen = Cuadre (REGLA DE ORO). La traza queda en la nota.
    caso = 'A_CORTESIA';
    if(saleId){
      await tUpdate('sales',{
        room_id: toRoomId, category: toRoom.category,
        total: 0, amount_1: 0, amount_2: 0, amount_3: 0, pay_method_2: '',
        note: 'Cambio a '+toRoomId+' (cortesia): cobrado y devuelto $'+saleTotalOriginal+' al cliente. Origen hab '+fromRoomId
      }).eq('id', saleId);
    }
  } else if(fromRoom.is_cortesia){
    // ===== CASO B: cambio DESDE cortesia (sale de cortesia) =====
    // Ahora si paga la habitacion nueva: se cobra el precio completo con el metodo elegido.
    caso = 'B_DESDE_CORTESIA';
    const mixtoEf = Number(p.mixtoEf||0), mixtoTj = Number(p.mixtoTj||0), mixtoNq = Number(p.mixtoNq||0);
    if(payMethod==='MIXTO' && (mixtoEf+mixtoTj+mixtoNq)!==toPrice){
      return err(res, 'Los montos MIXTO deben sumar '+toPrice);
    }
    if(saleId){
      await tUpdate('sales',{
        room_id: toRoomId, category: toRoom.category,
        total: toPrice, pay_method: payMethod,
        pay_method_2: payMethod==='MIXTO'?'MIXTO_EF_TJ_NQ':'',
        amount_1: payMethod==='MIXTO'?mixtoEf:(payMethod==='EFECTIVO'?toPrice:0),
        amount_2: payMethod==='MIXTO'?mixtoTj:(payMethod==='TARJETA'?toPrice:0),
        amount_3: payMethod==='MIXTO'?mixtoNq:(payMethod==='NEQUI'?toPrice:0),
        note: 'Cambio desde '+fromRoomId+' (cortesia): cobrado $'+toPrice+' ['+payMethod+']. Destino hab '+toRoomId
      }).eq('id', saleId);
    }
  } else {
    // ===== Caso NORMAL (igual que hoy): mover venta + fila diff =====
    if(saleId){
      await tUpdate('sales',{ room_id: toRoomId, category: toRoom.category }).eq('id', saleId);
    }
    if(diff > 0) {
      await tInsert('sales',{
        ts_ms: now, business_day: bDay, shift_id: shift,
        user_role: 'RECEPTION', user_name: userName, type: 'SALE',
        room_id: toRoomId, category: toRoom.category, duration_hrs: durationHrs,
        base_price: diff, people, total: diff,
        pay_method: payMethod, check_in_ms: originalCheckInMs, due_ms: originalDueMs,
        arrival_type: fromRoom.arrival_type||'WALK'
      });
    } else if(diff < 0) {
      await tInsert('sales',{
        ts_ms: now, business_day: bDay, shift_id: shift,
        user_role: 'RECEPTION', user_name: userName, type: 'REFUND',
        room_id: toRoomId, category: fromRoom.category, total: diff,
        pay_method: payMethod, refund_reason: 'CAMBIO DE HABITACION de ' + fromRoomId
      });
    }
  }

  // Registrar el cambio en el historial (antes no se registraba state_history)
  await tInsert('state_history',[
    { ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName,
      room_id: fromRoomId, from_state: 'OCCUPIED', to_state: 'AVAILABLE', people: 0,
      meta_json: JSON.stringify({ accion:'CAMBIO_HAB_SALIDA', destino: toRoomId, checkInMs: originalCheckInMs, caso }) },
    { ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName,
      room_id: toRoomId, from_state: 'AVAILABLE', to_state: 'OCCUPIED', people,
      meta_json: JSON.stringify({ accion:'CAMBIO_HAB_ENTRADA', origen: fromRoomId, checkInMs: originalCheckInMs, dueMs: originalDueMs, caso }) }
  ]);

  return ok(res, { fromRoomId, toRoomId, diff, newDueMs: originalDueMs, caso });
}

async function apiUpdatePayMethod(p, res) {
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Solo RECEPTION o ADMIN');
  const roomId=String(p.roomId||'').trim();
  const payMethod=String(p.payMethod||'EFECTIVO').toUpperCase();
  if(!['EFECTIVO','TARJETA','NEQUI'].includes(payMethod))return err(res,'Metodo de pago invalido');
  const room=await getRoom(roomId);
  if(!room)return err(res,'Habitacion no existe');
  if(room.state!=='OCCUPIED')return err(res,'Solo se puede cambiar en habitacion ocupada');
  const now=Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const checkInMs=Number(room.check_in_ms||0);
  await tUpdate('sales',{pay_method:payMethod}).eq('room_id',roomId).eq('business_day',bDay).in('type',['SALE','EXTENSION','RENEWAL']).eq('shift_id',shift).eq('check_in_ms',checkInMs);
  await tUpdate('rooms',{pay_method:payMethod, updated_at:new Date().toISOString()}).eq('room_id',roomId);
  return ok(res,{roomId,payMethod});
}

async function apiUpdateArrivalPlate(p, res) {
  const roomId=String(p.roomId||'').trim(),plate=String(p.plate||'').toUpperCase().trim();
  const arrivalType=String(p.arrivalType||'').toUpperCase().trim();
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Solo RECEPTION o ADMIN');
  const room=await getRoom(roomId);
  if(!room)return err(res,'Habitacion no existe');
  if(room.state!=='OCCUPIED')return err(res,'Habitacion no esta ocupada');
  const updates={arrival_plate:plate,updated_at:new Date().toISOString()};
  if(arrivalType)updates.arrival_type=arrivalType;
  await tUpdate('rooms',updates).eq('room_id',roomId);
  return ok(res,{roomId,plate,arrivalType});
}

// ==================== MANTENIMIENTO ====================
async function apiGetMaintHistory(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const from=String(p.from||'');
  const to=String(p.to||'');
  if(!from||!to) return err(res,'Fechas requeridas');
  const{data}=await tSelect('maintenance','*').gte('business_day',from).lte('business_day',to).order('ts_ms',{ascending:false});
  return ok(res,{logs:(data||[]).map(r=>({
    id:r.id, tsMs:Number(r.ts_ms), businessDay:r.business_day, shiftId:r.shift_id,
    roomId:r.room_id, type:r.type, text:r.text||'',
    repairDesc:r.repair_desc||'', repairCost:Number(r.repair_cost||0),
    userName:r.user_name||'', userRole:r.user_role||''
  }))});
}
async function apiClearMaintHistory(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const from=String(p.from||'');
  const to=String(p.to||'');
  if(!from||!to) return err(res,'Fechas requeridas');
  await tDelete('maintenance').gte('business_day',from).lte('business_day',to);
  return ok(res,{});
}

// ==================== ROOM ISSUES ====================
async function apiGetRoomIssues(p, res) {
  const roomId=String(p.roomId||'').trim();
  const{data}=await tSelect('room_issues','*').eq('room_id',roomId).order('created_at',{ascending:false});
  return ok(res,{issues:(data||[]).map(r=>({id:r.id,roomId:r.room_id,type:r.type,description:r.description,resolved:!!r.resolved,resolvedAt:r.resolved_at||'',resolvedBy:r.resolved_by||'',createdAt:r.created_at||'',createdBy:r.created_by||''}))});
}
async function apiAddRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const roomId=String(p.roomId||'').trim();
  const type=String(p.type||'dano').trim();
  const description=String(p.description||'').trim();
  if(!roomId)return err(res,'roomId requerido');
  if(!description)return err(res,'Descripcion requerida');
  await tInsert('room_issues',{room_id:roomId,type,description,resolved:false,created_by:String(p.userName||'')});
  return ok(res,{});
}
async function apiEditRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const id=Number(p.id||0);
  const description=String(p.description||'').trim();
  if(!id)return err(res,'id requerido');
  if(!description)return err(res,'Descripcion requerida');
  await tUpdate('room_issues',{description}).eq('id',id);
  return ok(res,{});
}
async function apiResolveRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const id=Number(p.id||0);
  if(!id)return err(res,'id requerido');
  const hoy=new Date().toISOString().split('T')[0];
  await tUpdate('room_issues',{resolved:true,resolved_at:hoy,resolved_by:String(p.userName||'')}).eq('id',id);
  return ok(res,{});
}
async function apiDeleteRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  if(!id)return err(res,'id requerido');
  await tDelete('room_issues').eq('id',id);
  return ok(res,{});
}

// ==================== MANTENIMIENTO (Modulo nuevo) ====================
// Reusa la tabla room_issues con campos extendidos.
// ==================== AUTO-BLOQUEO POR DAÑO URGENTE (G3) ====================
// Bloquea automaticamente una habitacion cuando se reporta/aprueba un daño urgente
// o cuando se hace checkout estando pendiente un daño urgente.
// - Si la habitacion esta OCUPADA, no se bloquea (espera al checkout).
// - Si ya estaba bloqueada por otro motivo, se concatena al disabled_reason previo.
// - El desbloqueo es SIEMPRE manual (no se auto-desbloquea al verificar el daño).
// Toda la logica esta envuelta en try/catch — un fallo aca nunca debe romper el caller.
async function bloquearPorDanoUrgenteSiCorresponde(roomId, descDano, userName) {
  try {
    if(!roomId) return { blocked: false, reason: 'sin roomId' };
    const room = await getRoom(roomId);
    if(!room) return { blocked: false, reason: 'habitacion no existe' };
    if(room.state === 'OCCUPIED') return { blocked: false, reason: 'ocupada, espera checkout' };

    const now = Date.now();
    const bDay = businessDay(now);
    const shift = currentShiftId(now);

    const descCorta = String(descDano || 'sin descripción').slice(0, 100);
    const motivoNuevo = 'Daño urgente: ' + descCorta;
    let motivoFinal = motivoNuevo;

    if(room.disabled){
      const prev = String(room.disabled_reason || '').trim();
      if(prev && !prev.includes('Daño urgente')) {
        motivoFinal = prev + ' · ' + motivoNuevo;
      } else if(prev) {
        // Ya tiene marca de daño urgente — no duplicamos
        motivoFinal = prev;
      }
    }

    await tUpdate('rooms',{
      disabled: true,
      disabled_date_ms: Number(room.disabled_date_ms || 0) || now,
      disabled_reason: motivoFinal,
      updated_at: new Date().toISOString()
    }).eq('room_id', roomId);

    // Registro en historial de mantenimiento (mismo formato que apiSetDisabled)
    await tInsert('maintenance',{
      ts_ms: now, business_day: bDay, shift_id: shift,
      user_role: 'AUTO', user_name: userName || 'sistema',
      room_id: roomId, type: 'DISABLE',
      text: motivoNuevo,
      repair_desc: '', repair_cost: 0
    });

    return { blocked: true, alreadyDisabled: !!room.disabled, reason: motivoFinal };
  } catch (e) {
    console.error('bloquearPorDanoUrgenteSiCorresponde error:', e);
    return { blocked: false, reason: 'error: '+(e.message||String(e)) };
  }
}

// Estados activos: PENDIENTE_RECEPCION, NOTA_ACTIVA, ESPERA_VERIFICACION, RECHAZADO_VERIFICACION
// Estados terminales: VERIFICADO, RECHAZADO_REC
// Filtra siempre anulada=false en lecturas.

async function apiGetReportesActivos(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION','MAID','MAINTENANCE'].includes(userRole)) {
    return err(res,'Sin permiso');
  }

  // Estados que se consideran "activos" en el flujo
  let estadosFiltro = [
    'PENDIENTE_RECEPCION','NOTA_ACTIVA',
    'ESPERA_VERIFICACION','RECHAZADO_VERIFICACION'
  ];

  // Mantenedor solo ve los que tiene que atender
  if(userRole === 'MAINTENANCE') {
    estadosFiltro = ['NOTA_ACTIVA','RECHAZADO_VERIFICACION'];
  }

  let query = tSelect('room_issues', '*')
    .eq('anulada', false)
    .in('estado', estadosFiltro)
    .order('reportado_ms', {ascending: false});

  // Camarera solo ve sus propios reportes
  if(userRole === 'MAID') {
    const userName = String(p.userName||'').trim();
    query = query.eq('created_by', userName);
  }

  const {data, error} = await query;
  if(error) return err(res,'Error consultando reportes: '+error.message);

  return ok(res, {
    reportes: (data||[]).map(r => ({
      id: r.id,
      ubicacionTipo: r.ubicacion_tipo || 'habitacion',
      ubicacionId: r.ubicacion_id || r.room_id || '',
      descripcion: r.description || '',
      prioridad: r.prioridad || null,
      estado: r.estado || null,
      reportadoPor: r.created_by || '',
      reportadoPorRol: r.reportado_por_rol || null,
      reportadoMs: Number(r.reportado_ms || 0),
      businessDay: r.business_day || null,
      shiftId: r.shift_id || null,
      fotoDanoUrl: r.foto_dano_url || null,
      aprobadoPor: r.aprobado_por || null,
      aprobadoMs: Number(r.aprobado_ms || 0),
      comentarioRecepcion: r.comentario_recepcion || null,
      arregladoPor: r.arreglado_por || null,
      arregladoMs: Number(r.arreglado_ms || 0),
      arregloNota: r.arreglo_nota || null,
      fotoArregloUrl: r.foto_arreglo_url || null,
      verificadoPor: r.verificado_por || null,
      verificadoMs: Number(r.verificado_ms || 0),
      motivoRechazo: r.motivo_rechazo || null,
      revisiones: Array.isArray(r.revisiones) ? r.revisiones : [],
      vistoPorAdmin: !!r.visto_por_admin,
      vistoPorAdminMs: Number(r.visto_por_admin_ms || 0)
    }))
  });
}

async function apiCrearReporteMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION','MAID'].includes(userRole)) {
    return err(res,'Sin permiso');
  }

  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');

  const ubicacionTipo = String(p.ubicacionTipo||'habitacion').toLowerCase();
  if(!['habitacion','zona_comun'].includes(ubicacionTipo)) {
    return err(res,'Ubicacion invalida (habitacion o zona_comun)');
  }

  const ubicacionId = String(p.ubicacionId||'').trim();
  if(!ubicacionId) return err(res,'Ubicacion ID requerida');

  const descripcion = String(p.descripcion||'').trim();
  if(descripcion.length < 3) return err(res,'Descripcion minima 3 caracteres');

  const fotoUrl = String(p.fotoDanoUrl||'').trim() || null;

  // Prioridad: obligatoria para ADMIN/RECEPTION, NULL para MAID
  const prioridadInput = String(p.prioridad||'').toLowerCase().trim();
  const prioridadesValidas = ['urgente','normal','baja'];

  // Regla: 1 reporte activo por ubicacion
  const estadosActivos = [
    'PENDIENTE_RECEPCION','NOTA_ACTIVA',
    'ESPERA_VERIFICACION','RECHAZADO_VERIFICACION'
  ];
  const {data: existentes} = await tSelect('room_issues', 'id, estado')
    .eq('anulada', false)
    .eq('ubicacion_tipo', ubicacionTipo)
    .eq('ubicacion_id', ubicacionId)
    .in('estado', estadosActivos);

  if(existentes && existentes.length > 0) {
    return err(res, 'Ya hay un reporte activo en esta ubicacion (estado: '+existentes[0].estado+')');
  }

  // Estado inicial y prioridad segun quien reporta:
  //  - MAID -> PENDIENTE_RECEPCION, prioridad NULL (la decide recepcion al aprobar - Fase 6)
  //  - ADMIN o RECEPTION -> NOTA_ACTIVA directo, prioridad obligatoria
  //    (ellos son los que aprueban, no tiene sentido que se aprueben a si mismos)
  let estadoInicial;
  let prioridadFinal = null;
  let aprobadoPor = null;
  let aprobadoMs = null;

  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);

  if(userRole === 'MAID') {
    estadoInicial = 'PENDIENTE_RECEPCION';
    prioridadFinal = null;
  } else {
    // ADMIN o RECEPTION
    estadoInicial = 'NOTA_ACTIVA';
    if(!prioridadesValidas.includes(prioridadInput)) {
      return err(res,'Prioridad requerida (urgente, normal o baja)');
    }
    prioridadFinal = prioridadInput;
    // Auditoria: como saltean aprobacion, dejamos rastro de quien "aprobo"
    aprobadoPor = userName;
    aprobadoMs = now;
  }

  const {data: inserted, error} = await tInsert('room_issues',{
    // Campos originales (compat con apiAddRoomIssue + ranking existente)
    room_id: (ubicacionTipo === 'habitacion') ? ubicacionId : '',
    type: 'dano',
    description: descripcion,
    resolved: false,
    created_by: userName,
    // Campos nuevos del flujo
    estado: estadoInicial,
    prioridad: prioridadFinal,
    reportado_por_rol: userRole,
    reportado_ms: now,
    business_day: bDay,
    shift_id: shift,
    foto_dano_url: fotoUrl,
    ubicacion_tipo: ubicacionTipo,
    ubicacion_id: ubicacionId,
    aprobado_por: aprobadoPor,
    aprobado_ms: aprobadoMs,
    anulada: false,
    editada: false
  }).select().single();

  if(error) return err(res,'Error al crear reporte: '+error.message);

  // Auto-bloqueo (G3): daño urgente en habitación recién aprobado directamente
  if(estadoInicial === 'NOTA_ACTIVA' && prioridadFinal === 'urgente' && ubicacionTipo === 'habitacion'){
    await bloquearPorDanoUrgenteSiCorresponde(ubicacionId, descripcion, userName);
  }

  return ok(res, {
    id: inserted.id,
    estado: estadoInicial,
    prioridad: prioridadFinal,
    ubicacionTipo: ubicacionTipo,
    ubicacionId: ubicacionId
  });
}

// ==================== MANTENEDOR (Fase 4) ====================
async function apiGetMisDanos(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE') return err(res, 'Solo MAINTENANCE');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  // Danos activos para el mantenedor
  const { data: activos } = await tSelect('room_issues', '*')
    .eq('anulada', false)
    .in('estado', ['NOTA_ACTIVA','RECHAZADO_VERIFICACION'])
    .order('reportado_ms', { ascending: false });

  // "Termine hoy": reportes que el mantenedor marco como ESPERA_VERIFICACION o VERIFICADO hoy
  const today = businessDay(Date.now());
  const inicioHoy = new Date(today + 'T00:00:00').getTime();
  const finHoy = inicioHoy + 86400000;
  const { data: terminados } = await tSelect('room_issues', 'id, estado')
    .eq('anulada', false)
    .eq('arreglado_por', userName)
    .gte('arreglado_ms', inicioHoy)
    .lt('arreglado_ms', finHoy);

  const reportes = (activos || []).map(function(r){
    return {
      id: r.id,
      ubicacionTipo: r.ubicacion_tipo || 'habitacion',
      ubicacionId: r.ubicacion_id || r.room_id || '',
      descripcion: r.description || '',
      prioridad: r.prioridad || 'normal',
      estado: r.estado,
      reportadoPor: r.created_by || '',
      reportadoMs: Number(r.reportado_ms || 0),
      fotoDanoUrl: r.foto_dano_url || null,
      motivoRechazo: r.motivo_rechazo || null,
      comentarioRecepcion: r.comentario_recepcion || null,
      revisiones: Array.isArray(r.revisiones) ? r.revisiones : []
    };
  });

  const contadores = {
    urgentes: reportes.filter(function(r){return r.prioridad === 'urgente';}).length,
    normales: reportes.filter(function(r){return r.prioridad === 'normal';}).length,
    bajas: reportes.filter(function(r){return r.prioridad === 'baja';}).length,
    terminadosHoy: (terminados || []).length
  };

  return ok(res, { contadores, reportes });
}

async function apiMarcarArreglo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE') return err(res, 'Solo MAINTENANCE');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const nota = String(p.nota || '').trim();
  if(nota.length < 3) return err(res, 'Nota minima 3 caracteres (obligatoria)');

  const fotoUrl = String(p.fotoArregloUrl || '').trim() || null;

  // Buscar el reporte y validar estado
  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(!['NOTA_ACTIVA','RECHAZADO_VERIFICACION'].includes(reporte.estado)) {
    return err(res, 'Reporte no esta activo (estado: '+reporte.estado+')');
  }

  // Marcar como arreglado, listo para verificar
  const now = Date.now();
  await tUpdate('room_issues',{
    estado: 'ESPERA_VERIFICACION',
    arreglado_por: userName,
    arreglado_ms: now,
    arreglo_nota: nota,
    foto_arreglo_url: fotoUrl,
    motivo_rechazo: null  // si era un rechazo previo, lo limpiamos
  }).eq('id', reporteId);

  return ok(res, { id: reporteId, estado: 'ESPERA_VERIFICACION', arregladoMs: now });
}

// ==================== VERIFICACION (Fase 5) ====================
async function apiVerificarArreglo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(reporte.estado !== 'ESPERA_VERIFICACION') {
    return err(res, 'Reporte no esta esperando verificacion (estado: '+reporte.estado+')');
  }

  const now = Date.now();
  const todayDate = new Date().toISOString().split('T')[0];
  await tUpdate('room_issues',{
    estado: 'VERIFICADO',
    verificado_por: userName,
    verificado_ms: now,
    // compat con ranking de habitaciones mas danadas que usa resolved
    resolved: true,
    resolved_at: todayDate,
    resolved_by: userName
  }).eq('id', reporteId);

  return ok(res, { id: reporteId, estado: 'VERIFICADO', verificadoMs: now });
}

async function apiRechazarArreglo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const motivo = String(p.motivo || '').trim();
  if(motivo.length < 3) return err(res, 'Motivo de rechazo minimo 3 caracteres');

  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(reporte.estado !== 'ESPERA_VERIFICACION') {
    return err(res, 'Reporte no esta esperando verificacion (estado: '+reporte.estado+')');
  }

  // Vuelve a estado activo para el mantenedor.
  // arreglado_por / arreglado_ms / arreglo_nota / foto_arreglo_url se mantienen
  // como historial del intento previo. apiMarcarArreglo los sobreescribe en el proximo intento.
  await tUpdate('room_issues',{
    estado: 'RECHAZADO_VERIFICACION',
    motivo_rechazo: motivo
  }).eq('id', reporteId);

  return ok(res, { id: reporteId, estado: 'RECHAZADO_VERIFICACION' });
}

// ==================== CAMBIAR PRIORIDAD (reclasificar) ====================
// ADMIN/RECEPTION reclasifica la prioridad de un reporte que ya está en el
// flujo, SIN cambiar su estado. Deja rastro en revisiones (jsonb).
// - Si SUBE a 'urgente' en una habitación, dispara el auto-bloqueo (G3).
// - Si BAJA de 'urgente', NO se desbloquea: el desbloqueo sigue siendo manual.
async function apiCambiarPrioridadMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const prioridadInput = String(p.prioridad||'').toLowerCase().trim();
  const prioridadesValidas = ['urgente','normal','baja'];
  if(!prioridadesValidas.includes(prioridadInput)) {
    return err(res,'Prioridad requerida (urgente, normal o baja)');
  }

  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(reporte.estado === 'VERIFICADO') {
    return err(res, 'Reporte ya verificado, no se puede cambiar prioridad');
  }

  const prioridadPrev = reporte.prioridad || null;
  if(prioridadPrev === prioridadInput) {
    return err(res, 'La prioridad ya es '+prioridadInput);
  }

  const now = Date.now();
  const prev = Array.isArray(reporte.revisiones) ? reporte.revisiones : [];
  const entrada = { accion: 'cambio_prioridad', de: prioridadPrev, a: prioridadInput, por: userName, rol: userRole, ms: now, ts: now,
                    motivo: 'Prioridad: '+(prioridadPrev||'—')+' → '+prioridadInput };
  const nuevas = prev.concat([entrada]);

  await tUpdate('room_issues',{
    prioridad: prioridadInput,
    revisiones: nuevas
  }).eq('id', reporteId);

  // Auto-bloqueo (G3): si SUBE a urgente en habitación, bloquear.
  // Bajar de urgente NO desbloquea (desbloqueo siempre manual).
  if(prioridadInput === 'urgente' && reporte.ubicacion_tipo === 'habitacion'){
    await bloquearPorDanoUrgenteSiCorresponde(reporte.ubicacion_id, reporte.description, userName);
  }

  return ok(res, { id: reporteId, prioridad: prioridadInput, prioridadPrev: prioridadPrev, revisiones: nuevas });
}

// ==================== APROBAR REPORTE DE CAMARERA (Fase 6) ====================
// Recepción/Admin aprueba un daño que la camarera dejó en PENDIENTE_RECEPCION:
// le asigna prioridad y lo pasa a NOTA_ACTIVA para que le llegue al mantenedor.
async function apiAprobarReporteMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const prioridadInput = String(p.prioridad||'').toLowerCase().trim();
  const prioridadesValidas = ['urgente','normal','baja'];
  if(!prioridadesValidas.includes(prioridadInput)) {
    return err(res,'Prioridad requerida (urgente, normal o baja)');
  }

  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(reporte.estado !== 'PENDIENTE_RECEPCION') {
    return err(res, 'Reporte no esta pendiente de recepcion (estado: '+reporte.estado+')');
  }

  const now = Date.now();
  const comentario = String(p.comentario||'').trim() || null;
  await tUpdate('room_issues',{
    estado: 'NOTA_ACTIVA',
    prioridad: prioridadInput,
    aprobado_por: userName,
    aprobado_ms: now,
    comentario_recepcion: comentario
  }).eq('id', reporteId);

  // Auto-bloqueo (G3): daño urgente en habitación recién aprobado
  if(prioridadInput === 'urgente' && reporte.ubicacion_tipo === 'habitacion'){
    await bloquearPorDanoUrgenteSiCorresponde(reporte.ubicacion_id, reporte.description, userName);
  }

  return ok(res, { id: reporteId, estado: 'NOTA_ACTIVA', prioridad: prioridadInput, aprobadoMs: now });
}

// ==================== DESCARTAR REPORTE DE CAMARERA (Fase 6) ====================
// Recepción/Admin descarta (borrado lógico) un daño de camarera que no aplica
// o es falso, antes de que entre al flujo del mantenedor. Deja rastro auditable.
async function apiAnularReporteMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const motivo = String(p.motivo || '').trim();
  if(motivo.length < 3) return err(res, 'Motivo minimo 3 caracteres');

  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte ya anulado');
  if(reporte.estado !== 'PENDIENTE_RECEPCION') {
    return err(res, 'Solo se pueden descartar reportes pendientes de recepcion (estado: '+reporte.estado+')');
  }

  const now = Date.now();
  await tUpdate('room_issues',{
    anulada: true,
    anulada_por: userName,
    anulada_ms: now,
    motivo_anulacion: motivo
  }).eq('id', reporteId);

  return ok(res, { id: reporteId, anulada: true });
}

// Rediseño Reportes: ADMIN/RECEPTION cierra un daño de zona común sin
// pasar por mantenimiento (bombillito quemado, basura, etc — cosas que
// la propia recep resuelve en el momento). Solo aplica a zonas comunes.
// Para habitaciones se mantiene el flujo completo con mantenedor.
async function apiResolverDanoZonaComun(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const { data: reporte } = await tSelect('room_issues','*').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(reporte.ubicacion_tipo !== 'zona_comun') return err(res, 'Solo aplica a zonas comunes. Las habitaciones requieren flujo de mantenedor.');
  if(!['NOTA_ACTIVA','RECHAZADO_VERIFICACION'].includes(reporte.estado)) {
    return err(res, 'Reporte no esta activo (estado: '+reporte.estado+')');
  }

  const now = Date.now();
  const todayDate = new Date().toISOString().split('T')[0];
  await tUpdate('room_issues',{
    estado: 'VERIFICADO',
    verificado_por: userName,
    verificado_ms: now,
    // Si no pasó por mantenedor, dejamos rastro: arreglado_por también es recep,
    // para que el historial muestre quién resolvió.
    arreglado_por: reporte.arreglado_por || userName,
    arreglado_ms: reporte.arreglado_ms || now,
    arreglo_nota: reporte.arreglo_nota || 'Resuelto directo por '+userRole.toLowerCase(),
    resolved: true,
    resolved_at: todayDate,
    resolved_by: userName
  }).eq('id', reporteId);

  return ok(res, { id: reporteId, estado: 'VERIFICADO', verificadoMs: now });
}

// ==================== REVISION (G1) ====================
// Geovanny / ADM / Recep registran una visita/revision al dano sin cerrarlo.
// El estado y la prioridad NO cambian; solo se acumula al array revisiones.
async function apiMarcarRevision(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['MAINTENANCE','ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Sin permiso');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const motivo = String(p.motivo || '').trim();
  if(motivo.length < 3) return err(res, 'Motivo minimo 3 caracteres');

  const fotoUrl = String(p.fotoUrl || '').trim() || null;

  const { data: reporte } = await tSelect('room_issues', 'id, estado, anulada, revisiones').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(!['NOTA_ACTIVA','RECHAZADO_VERIFICACION'].includes(reporte.estado)) {
    return err(res, 'Reporte no esta activo (estado: '+reporte.estado+')');
  }

  const prev = Array.isArray(reporte.revisiones) ? reporte.revisiones : [];
  const nueva = { ts: Date.now(), por: userName, rol: userRole, motivo: motivo, fotoUrl: fotoUrl };
  if(p.tecnicoExterno === true) nueva.tecnicoExterno = true;
  const nuevas = prev.concat([nueva]);

  await tUpdate('room_issues',{ revisiones: nuevas }).eq('id', reporteId);

  return ok(res, { id: reporteId, revisiones: nuevas });
}

// ==================== VISTO POR ADMIN ====================
// Acuse de recibo del admin sobre un daño activo. NO cambia el estado del
// reporte (sigue activo hasta que mantenimiento lo arregle y recepcion lo
// verifique). Solo marca que Ruben ya vio que ese daño existe — sirve para
// el badge rojo en la pestaña Mantenimiento.
async function apiMarcarDanioVisto(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const reporteId = Number(p.reporteId || 0);
  if(!reporteId) return err(res, 'reporteId requerido');

  const { data: reporte } = await tSelect('room_issues', 'id, anulada, visto_por_admin').eq('id', reporteId).single();
  if(!reporte) return err(res, 'Reporte no existe');
  if(reporte.anulada) return err(res, 'Reporte anulado');
  if(reporte.visto_por_admin) return ok(res, { id: reporteId, yaVisto: true });

  await tUpdate('room_issues',{
    visto_por_admin: true,
    visto_por_admin_ms: Date.now()
  }).eq('id', reporteId);

  return ok(res, { id: reporteId, vistoPorAdmin: true });
}

// ==================== BITACORA DEL MANTENEDOR ====================
async function apiGetBitacoraMantenedor(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE' && userRole !== 'ADMIN') return err(res, 'Sin permiso');
  const fecha = String(p.fecha || businessDay(Date.now())).trim();
  const mantenedor = String(p.mantenedor || p.userName || '').trim();
  if(!mantenedor) return err(res, 'Mantenedor requerido');

  const inicio = new Date(fecha + 'T00:00:00').getTime();
  const fin = inicio + 86400000;

  const { data: arreglados } = await tSelect('room_issues', 'id, ubicacion_id, ubicacion_tipo, description, estado, arreglo_nota, arreglado_ms')
    .eq('arreglado_por', mantenedor)
    .eq('anulada', false)
    .gte('arreglado_ms', inicio)
    .lt('arreglado_ms', fin)
    .order('arreglado_ms', { ascending: true });

  // Filtro del array revisiones en JS (jsonb-por-elemento no es queryable directo aqui)
  const { data: conRevs } = await tSelect('room_issues', 'id, ubicacion_id, ubicacion_tipo, description, revisiones')
    .not('revisiones', 'is', null);

  const mantLower = mantenedor.toLowerCase();
  const revisados = (conRevs||[]).map(r => {
    const revs = Array.isArray(r.revisiones) ? r.revisiones : [];
    const revsHoy = revs.filter(rv =>
      String(rv.por||'').trim().toLowerCase() === mantLower
      && Number(rv.ts||0) >= inicio && Number(rv.ts||0) < fin
    );
    if(!revsHoy.length) return null;
    return {
      id: r.id,
      ubicacionTipo: r.ubicacion_tipo || 'habitacion',
      ubicacionId: r.ubicacion_id || '',
      descripcion: r.description || '',
      motivos: revsHoy.map(rv => String(rv.motivo||'')).filter(Boolean)
    };
  }).filter(Boolean);

  const { data: bitRow } = await tSelect('maintenance_bitacora', 'nota_libre').eq('fecha', fecha).eq('mantenedor', mantenedor).maybeSingle();

  return ok(res, {
    fecha, mantenedor,
    arreglados: (arreglados||[]).map(r => ({
      id: r.id,
      ubicacionTipo: r.ubicacion_tipo || 'habitacion',
      ubicacionId: r.ubicacion_id || '',
      descripcion: r.description || '',
      arregloNota: r.arreglo_nota || '',
      estado: r.estado || ''
    })),
    revisados,
    notaLibre: (bitRow && bitRow.nota_libre) || ''
  });
}

async function apiSaveBitacoraMantenedor(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE' && userRole !== 'ADMIN') return err(res, 'Sin permiso');
  const fecha = String(p.fecha || businessDay(Date.now())).trim();
  const mantenedor = String(p.mantenedor || p.userName || '').trim();
  const notaLibre = String(p.notaLibre || '').trim();
  if(!mantenedor) return err(res, 'Mantenedor requerido');
  if(!fecha) return err(res, 'Fecha requerida');

  const { error } = await supabase.from('maintenance_bitacora').upsert({
    motel_id: MOTEL_ID, fecha, mantenedor, nota_libre: notaLibre, ts_ms: Date.now()
  }, { onConflict: 'fecha,mantenedor' });
  if(error) return err(res, 'Error guardando: ' + error.message);

  return ok(res, { saved: true });
}

// ==================== TAREAS MANTENEDOR (Fase 4.5) ====================
// Tabla mantenimiento_tareas: tareas planificadas asignadas al mantenedor
// (separadas de los danos reactivos en room_issues).
// Estados: pendiente -> hecha (al completar). ADMIN puede anular -> anulada.

async function apiCrearTareaMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const descripcion = String(p.descripcion||'').trim();
  if(descripcion.length < 3) return err(res, 'Descripcion minima 3 caracteres');

  const prioridad = String(p.prioridad||'').toLowerCase().trim();
  if(!['urgente','normal','baja'].includes(prioridad)) return err(res, 'Prioridad requerida (urgente, normal o baja)');

  const asignadoA = String(p.asignadoA||'').trim();
  if(!asignadoA) return err(res, 'Asignado_a requerido');

  // fecha_objetivo opcional. Si viene, debe ser YYYY-MM-DD y >= today.
  const fechaInput = String(p.fechaObjetivo||'').trim();
  let fechaObjetivo = null;
  if(fechaInput){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(fechaInput)) return err(res, 'fecha_objetivo formato invalido (YYYY-MM-DD)');
    const today = new Date().toISOString().split('T')[0];
    if(fechaInput < today) return err(res, 'fecha_objetivo no puede ser pasada');
    fechaObjetivo = fechaInput;
  }

  const now = Date.now();
  const { data: inserted, error } = await tInsert('mantenimiento_tareas',{
    descripcion: descripcion,
    prioridad: prioridad,
    asignado_a: asignadoA,
    fecha_objetivo: fechaObjetivo,
    estado: 'pendiente',
    creado_por: userName,
    creado_por_rol: 'ADMIN',
    creado_ms: now
  }).select().single();

  if(error) return err(res, 'Error al crear tarea: '+error.message);
  return ok(res, { id: inserted.id, estado: 'pendiente' });
}

async function apiGetTareasMant(p, res) {
  // MAINTENANCE ve sus propias tareas. ADMIN puede listar todas pasando listAll=true.
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['MAINTENANCE','ADMIN'].includes(userRole)) return err(res, 'Sin permiso');
  const userName = String(p.userName||'').trim();

  let query = tSelect('mantenimiento_tareas','*');
  if(userRole === 'MAINTENANCE'){
    if(!userName) return err(res, 'Usuario requerido');
    query = query.eq('asignado_a', userName);
  } else if(p.listAll !== true && userName){
    // ADMIN sin listAll explicito -> filtra por nombre tambien
    query = query.eq('asignado_a', userName);
  }
  query = query.in('estado', ['pendiente','hecha']);
  query = query.order('estado', {ascending: true})
               .order('fecha_objetivo', {ascending: true, nullsFirst: false})
               .order('creado_ms', {ascending: false});

  const { data, error } = await query;
  if(error) return err(res, 'Error consultando tareas: '+error.message);

  const today = new Date().toISOString().split('T')[0];
  const inicioHoy = new Date(today+'T00:00:00').getTime();
  const finHoy = inicioHoy + 86400000;

  const tareas = (data||[]).map(function(t){
    return {
      id: t.id,
      descripcion: t.descripcion || '',
      prioridad: t.prioridad,
      asignadoA: t.asignado_a || '',
      fechaObjetivo: t.fecha_objetivo || null,
      estado: t.estado,
      creadoPor: t.creado_por || '',
      creadoMs: Number(t.creado_ms || 0),
      completadoPor: t.completado_por || null,
      completadoMs: Number(t.completado_ms || 0),
      completadoNota: t.completado_nota || null,
      fotoCompletadoUrl: t.foto_completado_url || null
    };
  });

  const pendientes = tareas.filter(function(t){return t.estado==='pendiente';});
  const hechasHoy = tareas.filter(function(t){return t.estado==='hecha' && t.completadoMs>=inicioHoy && t.completadoMs<finHoy;});

  return ok(res, {
    pendientes: pendientes,
    hechasHoy: hechasHoy,
    contadores: {
      pendientes: pendientes.length,
      urgentesPendientes: pendientes.filter(function(t){return t.prioridad==='urgente';}).length,
      hechasHoy: hechasHoy.length
    }
  });
}

async function apiCompletarTareaMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE') return err(res, 'Solo MAINTENANCE');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const tareaId = Number(p.tareaId || 0);
  if(!tareaId) return err(res, 'tareaId requerido');

  const nota = String(p.nota || '').trim();
  if(nota.length < 3) return err(res, 'Nota minima 3 caracteres (obligatoria)');

  const fotoUrl = String(p.fotoCompletadoUrl || '').trim() || null;

  const { data: tarea } = await tSelect('mantenimiento_tareas','*').eq('id', tareaId).single();
  if(!tarea) return err(res, 'Tarea no existe');
  if(tarea.estado !== 'pendiente') return err(res, 'Tarea no esta pendiente (estado: '+tarea.estado+')');
  if(tarea.asignado_a !== userName) return err(res, 'Esta tarea no esta asignada a vos');

  const now = Date.now();
  await tUpdate('mantenimiento_tareas',{
    estado: 'hecha',
    completado_por: userName,
    completado_ms: now,
    completado_nota: nota,
    foto_completado_url: fotoUrl
  }).eq('id', tareaId);

  return ok(res, { id: tareaId, estado: 'hecha', completadoMs: now });
}

async function apiAnularTareaMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const tareaId = Number(p.tareaId || 0);
  if(!tareaId) return err(res, 'tareaId requerido');

  const motivo = String(p.motivo || '').trim();
  if(motivo.length < 3) return err(res, 'Motivo de anulacion minimo 3 caracteres');

  const { data: tarea } = await tSelect('mantenimiento_tareas','estado').eq('id', tareaId).single();
  if(!tarea) return err(res, 'Tarea no existe');
  if(tarea.estado === 'anulada') return err(res, 'Tarea ya estaba anulada');

  const now = Date.now();
  await tUpdate('mantenimiento_tareas',{
    estado: 'anulada',
    anulada_por: userName,
    anulada_ms: now,
    motivo_anulacion: motivo
  }).eq('id', tareaId);

  return ok(res, { id: tareaId, estado: 'anulada' });
}

// ==================== HISTORIAL MANTENIMIENTO (Fase 7.1) ====================
// ADMIN/RECEPTION ven el historial unificado de:
//   - Daños VERIFICADOS (room_issues con estado='VERIFICADO')
//   - Tareas COMPLETADAS (mantenimiento_tareas con estado='hecha')
// Con filtros por rango de fecha, tipo, mantenedor y ubicacion.
async function apiGetHistorialMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');

  // Rango de fechas (default: ultimos 30 dias)
  const hoy = new Date().toISOString().split('T')[0];
  const hace30 = new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
  const desde = String(p.desde || hace30);
  const hasta = String(p.hasta || hoy);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)){
    return err(res, 'Fechas formato YYYY-MM-DD');
  }
  const desdeMs = new Date(desde+'T00:00:00').getTime();
  const hastaMs = new Date(hasta+'T00:00:00').getTime() + 86400000; // fin del dia

  const tipo = String(p.tipo||'todos').toLowerCase();
  if(!['todos','danos','tareas'].includes(tipo)) return err(res, 'tipo invalido');

  const mantenedorFilter = String(p.mantenedor||'').trim();  // filtro opcional
  const ubicacionFilter = String(p.ubicacion||'').trim();    // filtro opcional (text-match)

  const items = [];

  // 1) DAÑOS VERIFICADOS
  if(tipo === 'todos' || tipo === 'danos'){
    let q1 = tSelect('room_issues','*')
      .eq('anulada', false)
      .eq('estado', 'VERIFICADO')
      .gte('verificado_ms', desdeMs)
      .lt('verificado_ms', hastaMs);
    if(mantenedorFilter) q1 = q1.eq('arreglado_por', mantenedorFilter);
    if(ubicacionFilter) q1 = q1.ilike('ubicacion_id', '%'+ubicacionFilter+'%');
    const { data: danos } = await q1.order('verificado_ms', {ascending: false});
    (danos||[]).forEach(function(r){
      const tiempoTrabajoMs = (r.arreglado_ms && r.aprobado_ms) ? Number(r.arreglado_ms - r.aprobado_ms) : 0;
      items.push({
        tipo: 'dano',
        id: r.id,
        ubicacionTipo: r.ubicacion_tipo || 'habitacion',
        ubicacionId: r.ubicacion_id || r.room_id || '',
        descripcion: r.description || '',
        prioridad: r.prioridad,
        reportadoPor: r.created_by || '',
        reportadoMs: Number(r.reportado_ms || 0),
        aprobadoPor: r.aprobado_por || null,
        aprobadoMs: Number(r.aprobado_ms || 0),
        arregladoPor: r.arreglado_por || '',
        arregladoMs: Number(r.arreglado_ms || 0),
        arregloNota: r.arreglo_nota || '',
        fotoDanoUrl: r.foto_dano_url || null,
        fotoArregloUrl: r.foto_arreglo_url || null,
        verificadoPor: r.verificado_por || '',
        verificadoMs: Number(r.verificado_ms || 0),
        revisiones: Array.isArray(r.revisiones) ? r.revisiones : [],
        // ms para ordenar el array combinado
        sortMs: Number(r.verificado_ms || 0),
        tiempoTrabajoMs: tiempoTrabajoMs
      });
    });
  }

  // 2) TAREAS COMPLETADAS
  if(tipo === 'todos' || tipo === 'tareas'){
    let q2 = tSelect('mantenimiento_tareas','*')
      .eq('estado', 'hecha')
      .gte('completado_ms', desdeMs)
      .lt('completado_ms', hastaMs);
    if(mantenedorFilter) q2 = q2.eq('completado_por', mantenedorFilter);
    if(ubicacionFilter) q2 = q2.ilike('descripcion', '%'+ubicacionFilter+'%');
    const { data: tareas } = await q2.order('completado_ms', {ascending: false});
    (tareas||[]).forEach(function(t){
      items.push({
        tipo: 'tarea',
        id: t.id,
        descripcion: t.descripcion || '',
        prioridad: t.prioridad,
        asignadoA: t.asignado_a || '',
        fechaObjetivo: t.fecha_objetivo || null,
        creadoPor: t.creado_por || '',
        creadoMs: Number(t.creado_ms || 0),
        completadoPor: t.completado_por || '',
        completadoMs: Number(t.completado_ms || 0),
        completadoNota: t.completado_nota || '',
        fotoCompletadoUrl: t.foto_completado_url || null,
        sortMs: Number(t.completado_ms || 0)
      });
    });
  }

  // 3) REVISIONES (G1) — explotar array revisiones como items individuales
  if(tipo === 'todos' || tipo === 'danos'){
    let q3 = tSelect('room_issues', 'id, ubicacion_id, ubicacion_tipo, description, revisiones')
      .eq('anulada', false)
      .not('revisiones', 'is', null);
    if(ubicacionFilter) q3 = q3.ilike('ubicacion_id', '%'+ubicacionFilter+'%');
    const { data: conRevs } = await q3;
    const mantLower = mantenedorFilter.toLowerCase();
    (conRevs||[]).forEach(function(r){
      const revs = Array.isArray(r.revisiones) ? r.revisiones : [];
      revs.forEach(function(rv){
        const tsMs = Number(rv.ts||0);
        if(tsMs < desdeMs || tsMs >= hastaMs) return;
        if(mantenedorFilter && String(rv.por||'').trim().toLowerCase() !== mantLower) return;
        items.push({
          tipo: 'revision',
          id: r.id + '-' + tsMs,
          reporteId: r.id,
          ubicacionTipo: r.ubicacion_tipo || 'habitacion',
          ubicacionId: r.ubicacion_id || '',
          descripcion: r.description || '',
          motivo: String(rv.motivo||''),
          por: String(rv.por||''),
          rol: String(rv.rol||''),
          fotoUrl: rv.fotoUrl || null,
          tecnicoExterno: rv.tecnicoExterno === true,
          sortMs: tsMs
        });
      });
    });
  }

  // 4) BITACORAS LIBRES — una por dia/mantenedor (si tiene texto)
  if(tipo === 'todos' && !ubicacionFilter){
    let q4 = tSelect('maintenance_bitacora', '*')
      .gte('fecha', desde).lte('fecha', hasta);
    if(mantenedorFilter) q4 = q4.eq('mantenedor', mantenedorFilter);
    const { data: bits } = await q4;
    (bits||[]).forEach(function(b){
      if(!b.nota_libre || !String(b.nota_libre).trim()) return;
      items.push({
        tipo: 'bitacora',
        id: 'bit-'+b.id,
        mantenedor: b.mantenedor || '',
        notaLibre: b.nota_libre || '',
        fecha: b.fecha || '',
        sortMs: new Date((b.fecha||'1970-01-01')+'T23:59:59').getTime()
      });
    });
  }

  // Ordenar combinado por sortMs descendente (lo mas reciente primero)
  items.sort(function(a, b){ return b.sortMs - a.sortMs; });

  const danosCount = items.filter(function(x){return x.tipo==='dano';}).length;
  const tareasCount = items.filter(function(x){return x.tipo==='tarea';}).length;
  const revisionesCount = items.filter(function(x){return x.tipo==='revision';}).length;
  const bitacorasCount = items.filter(function(x){return x.tipo==='bitacora';}).length;

  return ok(res, {
    items: items,
    contadores: {
      total: items.length,
      danos: danosCount, tareas: tareasCount,
      revisiones: revisionesCount, bitacoras: bitacorasCount
    },
    rango: { desde, hasta }
  });
}

// Resumen del día para los 4 cards de Mantenimiento ADM (Fase 7.2)
async function apiGetResumenMantHoy(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','RECEPTION'].includes(userRole)) return err(res, 'Solo ADMIN o RECEPTION');

  const today = businessDay(Date.now());
  const inicioHoyMs = new Date(today+'T00:00:00').getTime();
  const finHoyMs = inicioHoyMs + 86400000;

  // 1) Nuevos hoy: danos creados hoy (cualquier estado, sin anulados)
  const { data: nuevosData } = await tSelect('room_issues', 'id')
    .eq('anulada', false)
    .eq('business_day', today);

  // 2) Activos: no verificados ni anulados
  const { data: activosData } = await tSelect('room_issues', 'estado')
    .eq('anulada', false)
    .in('estado', ['PENDIENTE_RECEPCION','NOTA_ACTIVA','ESPERA_VERIFICACION','RECHAZADO_VERIFICACION']);

  // 3) Verificados hoy
  const { data: verifHoyData } = await tSelect('room_issues', 'id')
    .eq('anulada', false)
    .eq('estado', 'VERIFICADO')
    .gte('verificado_ms', inicioHoyMs)
    .lt('verificado_ms', finHoyMs);

  // 4) Tareas completadas hoy
  const { data: tareasHoyData } = await tSelect('mantenimiento_tareas', 'id')
    .eq('estado', 'hecha')
    .gte('completado_ms', inicioHoyMs)
    .lt('completado_ms', finHoyMs);

  const activosArr = activosData || [];
  const pendientesMant = activosArr.filter(function(r){
    return r.estado==='NOTA_ACTIVA' || r.estado==='RECHAZADO_VERIFICACION';
  }).length;

  return ok(res, {
    nuevosHoy: (nuevosData||[]).length,
    activos: activosArr.length,
    pendientesMant: pendientesMant,
    hechosHoy: (verifHoyData||[]).length + (tareasHoyData||[]).length
  });
}

// ==================== MANTENIMIENTO DE AIRE ====================
// Mantenimiento preventivo de aires acondicionados, ciclo de 4 meses.
// 42 unidades (38 habitaciones + 4 espacios). Tablas: aire_unidades,
// aire_rondas, aire_mantenimiento. Apertura de ronda automatica (al
// registrar la primera unidad); cierre manual cuando estan las 42.
const AIRE_CICLO_MESES = 4;
const AIRE_TAREAS = ['filtros','serpentin','condensador','drenaje','gas','electrico','carcasa','prueba'];

// Suma meses calendario a un timestamp ms (para vence_ms = cierre + 4 meses).
function aireAddMonthsMs(ms, months){
  const d = new Date(Number(ms));
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

// Devuelve la ronda ABIERTA (o null) y la ultima CERRADA (o null).
async function aireGetRondas(){
  const { data: abiertaArr } = await tSelect('aire_rondas', '*').eq('estado','ABIERTA').limit(1);
  const rondaAbierta = (abiertaArr && abiertaArr[0]) || null;
  const { data: cerradaArr } = await tSelect('aire_rondas', '*').eq('estado','CERRADA').order('cerrada_ms',{ascending:false}).limit(1);
  const ultimaCerrada = (cerradaArr && cerradaArr[0]) || null;
  return { rondaAbierta, ultimaCerrada };
}

// Grilla de las 42 unidades con su estado de color + flags de la ronda.
async function apiGetAireGrid(p, res){
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','MAINTENANCE'].includes(userRole)) return err(res, 'Sin permiso');

  const now = Date.now();

  const { data: unidades, error: eu } = await tSelect('aire_unidades', '*').eq('activo', true).order('orden', {ascending:true});
  if(eu) return err(res, 'Error consultando unidades: '+eu.message);

  const { rondaAbierta, ultimaCerrada } = await aireGetRondas();

  // Registros de la ronda de referencia: la abierta si hay; si no, la ultima cerrada.
  const rondaRef = rondaAbierta || ultimaCerrada || null;
  let regsPorUnidad = {};
  if(rondaRef){
    const { data: regs } = await tSelect('aire_mantenimiento', '*').eq('ronda_id', rondaRef.id);
    (regs||[]).forEach(function(r){ regsPorUnidad[r.unidad_id] = r; });
  }

  // vencida: no hay ronda abierta y (nunca cerro o ya paso vence_ms).
  const vencida = !rondaAbierta && (!ultimaCerrada || (ultimaCerrada.vence_ms && now >= Number(ultimaCerrada.vence_ms)));

  const unidadesOut = (unidades||[]).map(function(u){
    const reg = regsPorUnidad[u.id] || null;
    let estado;
    if(rondaAbierta){
      estado = reg ? reg.resultado : 'GRIS';        // ronda en curso: registrada o pendiente
    } else if(ultimaCerrada){
      estado = vencida ? 'ROJO' : (reg ? reg.resultado : 'GRIS');  // al dia o vencida
    } else {
      estado = 'GRIS';                              // nunca hubo ronda
    }
    return {
      id: u.id,
      tipo: u.tipo,
      refId: u.ref_id,
      nombre: u.nombre,
      piso: u.piso,
      orden: u.orden,
      estado: estado,                               // VERDE | AMARILLO | ROJO | GRIS
      registrada: !!reg,
      resultado: reg ? reg.resultado : null,
      reporte: reg ? (reg.reporte||null) : null,
      registradoMs: reg ? Number(reg.registrado_ms||0) : 0
    };
  });

  const totalUnidades = unidadesOut.length;
  const totalRegistradas = unidadesOut.filter(function(u){ return u.registrada; }).length;
  const puedeCerrar = !!rondaAbierta && totalUnidades > 0 && totalRegistradas >= totalUnidades;

  return ok(res, {
    unidades: unidadesOut,
    rondaAbierta: !!rondaAbierta,
    rondaNumero: rondaAbierta ? rondaAbierta.numero : (ultimaCerrada ? ultimaCerrada.numero : 0),
    totalUnidades: totalUnidades,
    totalRegistradas: rondaAbierta ? totalRegistradas : 0,
    puedeCerrar: puedeCerrar,
    vencida: vencida,
    venceMs: ultimaCerrada ? Number(ultimaCerrada.vence_ms||0) : 0,
    ultimaCerradaMs: ultimaCerrada ? Number(ultimaCerrada.cerrada_ms||0) : 0
  });
}

// Registra (o re-registra) una unidad. Abre ronda automaticamente si no hay.
async function apiRegistrarAire(p, res){
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','MAINTENANCE'].includes(userRole)) return err(res, 'Sin permiso');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const unidadId = Number(p.unidadId||0);
  if(!unidadId) return err(res, 'unidadId requerido');

  const resultado = String(p.resultado||'').toUpperCase();
  if(!['VERDE','AMARILLO'].includes(resultado)) return err(res, 'resultado invalido (VERDE o AMARILLO)');

  const { data: unidad } = await tSelect('aire_unidades', 'id').eq('id', unidadId).eq('activo', true).single();
  if(!unidad) return err(res, 'Unidad no encontrada');

  // Normalizar las 8 tareas a booleanos estrictos.
  const tareasIn = (p.tareas && typeof p.tareas === 'object') ? p.tareas : {};
  const tareas = {};
  AIRE_TAREAS.forEach(function(k){ tareas[k] = tareasIn[k] === true; });

  const reporte = String(p.reporte||'').trim() || null;
  const now = Date.now();

  // Apertura automatica de ronda.
  let { rondaAbierta } = await aireGetRondas();
  if(!rondaAbierta){
    const { data: ultArr } = await tSelect('aire_rondas', 'numero').order('numero',{ascending:false}).limit(1);
    const siguiente = ((ultArr && ultArr[0] && ultArr[0].numero) || 0) + 1;
    const { data: nueva, error: ec } = await tInsert('aire_rondas',{
      numero: siguiente,
      estado: 'ABIERTA',
      abierta_ms: now,
      abierta_por: userName
    }).select().single();
    if(ec) return err(res, 'Error al abrir ronda: '+ec.message);
    rondaAbierta = nueva;
  }

  const { error: em } = await supabase.from('aire_mantenimiento').upsert({
    motel_id: MOTEL_ID,
    ronda_id: rondaAbierta.id,
    unidad_id: unidadId,
    tareas: tareas,
    reporte: reporte,
    resultado: resultado,
    registrado_por: userName,
    registrado_rol: userRole,
    registrado_ms: now
  }, { onConflict: 'ronda_id,unidad_id' });
  if(em) return err(res, 'Error al registrar: '+em.message);

  return ok(res, { registrado: true, rondaId: rondaAbierta.id, rondaNumero: rondaAbierta.numero });
}

// Cierra la ronda abierta (exige las 42 registradas; permite amarillos).
async function apiCerrarRondaAire(p, res){
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['ADMIN','MAINTENANCE'].includes(userRole)) return err(res, 'Sin permiso');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const { rondaAbierta } = await aireGetRondas();
  if(!rondaAbierta) return err(res, 'No hay ronda abierta para cerrar');

  const { data: unidades } = await tSelect('aire_unidades', 'id').eq('activo', true);
  const totalUnidades = (unidades||[]).length;

  const { data: regs } = await tSelect('aire_mantenimiento', 'unidad_id').eq('ronda_id', rondaAbierta.id);
  const totalReg = (regs||[]).length;

  if(totalReg < totalUnidades){
    return err(res, 'Faltan '+(totalUnidades-totalReg)+' unidades por registrar');
  }

  const now = Date.now();
  const venceMs = aireAddMonthsMs(now, AIRE_CICLO_MESES);

  const { error } = await tUpdate('aire_rondas',{
    estado: 'CERRADA',
    cerrada_ms: now,
    cerrada_por: userName,
    vence_ms: venceMs
  }).eq('id', rondaAbierta.id);
  if(error) return err(res, 'Error al cerrar ronda: '+error.message);

  return ok(res, { cerrada: true, rondaNumero: rondaAbierta.numero, venceMs: venceMs });
}

// Historial completo de una unidad a traves de las rondas. SOLO ADMIN.
async function apiGetAireHistorial(p, res){
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Sin permiso');

  const unidadId = Number(p.unidadId||0);
  if(!unidadId) return err(res, 'unidadId requerido');

  const { data: unidad } = await tSelect('aire_unidades', '*').eq('id', unidadId).single();
  if(!unidad) return err(res, 'Unidad no encontrada');

  const { data: regs, error } = await tSelect('aire_mantenimiento', '*').eq('unidad_id', unidadId).order('registrado_ms',{ascending:false});
  if(error) return err(res, 'Error consultando historial: '+error.message);

  // Enriquecer con datos de cada ronda.
  const rondaIds = [...new Set((regs||[]).map(function(r){ return r.ronda_id; }))];
  let rondasMap = {};
  if(rondaIds.length){
    const { data: rondas } = await tSelect('aire_rondas', '*').in('id', rondaIds);
    (rondas||[]).forEach(function(r){ rondasMap[r.id] = r; });
  }

  const historial = (regs||[]).map(function(r){
    const ronda = rondasMap[r.ronda_id] || {};
    return {
      id: r.id,
      rondaId: r.ronda_id,
      rondaNumero: ronda.numero || null,
      rondaEstado: ronda.estado || null,
      rondaCerradaMs: ronda.cerrada_ms ? Number(ronda.cerrada_ms) : 0,
      tareas: r.tareas || {},
      reporte: r.reporte || null,
      resultado: r.resultado,
      registradoPor: r.registrado_por,
      registradoRol: r.registrado_rol,
      registradoMs: Number(r.registrado_ms||0)
    };
  });

  return ok(res, {
    unidad: { id: unidad.id, tipo: unidad.tipo, refId: unidad.ref_id, nombre: unidad.nombre, piso: unidad.piso },
    historial: historial
  });
}

// ==================== SOLICITUDES GEOVANNY → ADM ====================
// Don Geovanny puede solicitar 2 cosas: reportar un dano (que ADM aprueba con
// prioridad y se convierte en room_issues) o pedir permiso (ADM aprueba/rechaza).

async function apiCrearSolicitudMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE') return err(res, 'Solo MAINTENANCE');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const tipo = String(p.tipoSolicitud||'').toLowerCase().trim();
  if(!['dano','permiso'].includes(tipo)) return err(res, 'tipoSolicitud invalido (dano o permiso)');

  const descripcion = String(p.descripcion||'').trim();
  if(descripcion.length < 3) return err(res, 'Descripcion minima 3 caracteres');

  // Solo daños llevan ubicacion
  let ubicacionTipo = null;
  let ubicacionId = null;
  if(tipo === 'dano'){
    ubicacionTipo = String(p.ubicacionTipo||'').toLowerCase().trim();
    if(!['habitacion','zona_comun'].includes(ubicacionTipo)) return err(res, 'ubicacionTipo invalido para tipo=dano');
    ubicacionId = String(p.ubicacionId||'').trim();
    if(!ubicacionId) return err(res, 'ubicacionId requerido para tipo=dano');
  }

  const fotoUrl = String(p.fotoUrl||'').trim() || null;
  const now = Date.now();

  const { data: inserted, error } = await tInsert('mantenimiento_solicitudes',{
    tipo_solicitud: tipo,
    ubicacion_tipo: ubicacionTipo,
    ubicacion_id: ubicacionId,
    descripcion: descripcion,
    foto_url: fotoUrl,
    estado: 'pendiente',
    solicitado_por: userName,
    solicitado_ms: now
  }).select().single();

  if(error) return err(res, 'Error al crear solicitud: '+error.message);
  return ok(res, { id: inserted.id, estado: 'pendiente' });
}

async function apiGetSolicitudesMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(!['MAINTENANCE','ADMIN'].includes(userRole)) return err(res, 'Sin permiso');
  const userName = String(p.userName||'').trim();

  let query = tSelect('mantenimiento_solicitudes','*');

  if(userRole === 'MAINTENANCE'){
    if(!userName) return err(res, 'Usuario requerido');
    // Auto-archivado: pendientes (todas) + resueltas hoy. Las resueltas de
    // ayer o antes desaparecen de la pantalla principal pero siguen accesibles
    // vía apiGetHistorialSolicitudesGeo (botón "Ver historial completo").
    const today = businessDay(Date.now());
    const inicioHoyMs = new Date(today+'T00:00:00').getTime();
    query = query.eq('solicitado_por', userName)
                 .or('estado.eq.pendiente,resuelto_ms.gte.'+inicioHoyMs)
                 .order('solicitado_ms', {ascending: false})
                 .limit(30);
  } else {
    // ADMIN: por default ve pendientes + ultimas 20 resueltas
    if(p.soloPendientes === true){
      query = query.eq('estado', 'pendiente')
                   .order('solicitado_ms', {ascending: false});
    } else {
      query = query.order('solicitado_ms', {ascending: false}).limit(50);
    }
  }

  const { data, error } = await query;
  if(error) return err(res, 'Error consultando solicitudes: '+error.message);

  const solicitudes = (data||[]).map(function(s){
    return {
      id: s.id,
      tipoSolicitud: s.tipo_solicitud,
      ubicacionTipo: s.ubicacion_tipo,
      ubicacionId: s.ubicacion_id,
      descripcion: s.descripcion || '',
      fotoUrl: s.foto_url || null,
      estado: s.estado,
      solicitadoPor: s.solicitado_por || '',
      solicitadoMs: Number(s.solicitado_ms || 0),
      resueltoPor: s.resuelto_por || null,
      resueltoMs: Number(s.resuelto_ms || 0),
      motivoRechazo: s.motivo_rechazo || null,
      comentarioAdm: s.comentario_adm || null,
      prioridadAsignada: s.prioridad_asignada || null,
      roomIssueId: s.room_issue_id || null
    };
  });

  const contadores = {
    pendientes: solicitudes.filter(function(s){return s.estado==='pendiente';}).length,
    aprobadas: solicitudes.filter(function(s){return s.estado==='aprobada';}).length,
    rechazadas: solicitudes.filter(function(s){return s.estado==='rechazada';}).length
  };

  return ok(res, { solicitudes: solicitudes, contadores: contadores });
}

// Historial completo de solicitudes de Geovanny (sin filtro de fecha).
// Solo lo consume el modal "Ver historial completo" desde su pantalla.
async function apiGetHistorialSolicitudesGeo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'MAINTENANCE') return err(res, 'Solo MAINTENANCE');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const { data, error } = await tSelect('mantenimiento_solicitudes', '*')
    .eq('solicitado_por', userName)
    .order('solicitado_ms', {ascending: false})
    .limit(200);

  if(error) return err(res, 'Error consultando historial: '+error.message);

  const solicitudes = (data||[]).map(function(s){
    return {
      id: s.id,
      tipoSolicitud: s.tipo_solicitud,
      ubicacionTipo: s.ubicacion_tipo,
      ubicacionId: s.ubicacion_id,
      descripcion: s.descripcion || '',
      fotoUrl: s.foto_url || null,
      estado: s.estado,
      solicitadoPor: s.solicitado_por || '',
      solicitadoMs: Number(s.solicitado_ms || 0),
      resueltoPor: s.resuelto_por || null,
      resueltoMs: Number(s.resuelto_ms || 0),
      motivoRechazo: s.motivo_rechazo || null,
      comentarioAdm: s.comentario_adm || null,
      prioridadAsignada: s.prioridad_asignada || null,
      roomIssueId: s.room_issue_id || null
    };
  });

  return ok(res, { solicitudes: solicitudes });
}

async function apiAprobarSolicitudMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const solicitudId = Number(p.solicitudId || 0);
  if(!solicitudId) return err(res, 'solicitudId requerido');

  const { data: sol } = await tSelect('mantenimiento_solicitudes','*').eq('id', solicitudId).single();
  if(!sol) return err(res, 'Solicitud no existe');
  if(sol.estado !== 'pendiente') return err(res, 'Solicitud no esta pendiente (estado: '+sol.estado+')');

  const now = Date.now();
  const comentario = String(p.comentario||'').trim() || null;

  if(sol.tipo_solicitud === 'dano'){
    // Aprobar daño: crear room_issues con prioridad asignada por ADM
    const prioridad = String(p.prioridad||'').toLowerCase().trim();
    if(!['urgente','normal','baja'].includes(prioridad)) return err(res, 'Prioridad requerida (urgente/normal/baja)');

    // 1 reporte activo por ubicacion (regla del modulo)
    const estadosActivos = ['PENDIENTE_RECEPCION','NOTA_ACTIVA','ESPERA_VERIFICACION','RECHAZADO_VERIFICACION'];
    const { data: existentes } = await tSelect('room_issues', 'id, estado')
      .eq('anulada', false)
      .eq('ubicacion_tipo', sol.ubicacion_tipo)
      .eq('ubicacion_id', sol.ubicacion_id)
      .in('estado', estadosActivos);
    if(existentes && existentes.length > 0){
      return err(res, 'Ya hay un daño activo en esa ubicacion (estado: '+existentes[0].estado+')');
    }

    const bDay = businessDay(now);
    const shift = currentShiftId(now);

    const { data: insertedDano, error: errDano } = await tInsert('room_issues',{
      room_id: (sol.ubicacion_tipo === 'habitacion') ? sol.ubicacion_id : '',
      type: 'dano',
      description: sol.descripcion,
      resolved: false,
      created_by: sol.solicitado_por,
      estado: 'NOTA_ACTIVA',
      prioridad: prioridad,
      reportado_por_rol: 'MAINTENANCE',
      reportado_ms: Number(sol.solicitado_ms || now),
      business_day: bDay,
      shift_id: shift,
      foto_dano_url: sol.foto_url,
      ubicacion_tipo: sol.ubicacion_tipo,
      ubicacion_id: sol.ubicacion_id,
      aprobado_por: userName,
      aprobado_ms: now,
      anulada: false,
      editada: false
    }).select().single();
    if(errDano) return err(res, 'Error creando daño: '+errDano.message);

    // Auto-bloqueo (G3): daño urgente en habitación recién aprobado desde solicitud
    if(prioridad === 'urgente' && sol.ubicacion_tipo === 'habitacion'){
      await bloquearPorDanoUrgenteSiCorresponde(sol.ubicacion_id, sol.descripcion, userName);
    }

    await tUpdate('mantenimiento_solicitudes',{
      estado: 'aprobada',
      resuelto_por: userName,
      resuelto_ms: now,
      prioridad_asignada: prioridad,
      room_issue_id: insertedDano.id,
      comentario_adm: comentario
    }).eq('id', solicitudId);

    return ok(res, { id: solicitudId, estado: 'aprobada', roomIssueId: insertedDano.id });
  } else {
    // Aprobar permiso: solo update solicitud
    await tUpdate('mantenimiento_solicitudes',{
      estado: 'aprobada',
      resuelto_por: userName,
      resuelto_ms: now,
      comentario_adm: comentario
    }).eq('id', solicitudId);
    return ok(res, { id: solicitudId, estado: 'aprobada' });
  }
}

async function apiRechazarSolicitudMant(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res, 'Usuario requerido');

  const solicitudId = Number(p.solicitudId || 0);
  if(!solicitudId) return err(res, 'solicitudId requerido');

  const motivo = String(p.motivo || '').trim();
  if(motivo.length < 3) return err(res, 'Motivo minimo 3 caracteres');

  const { data: sol } = await tSelect('mantenimiento_solicitudes','estado').eq('id', solicitudId).single();
  if(!sol) return err(res, 'Solicitud no existe');
  if(sol.estado !== 'pendiente') return err(res, 'Solicitud no esta pendiente (estado: '+sol.estado+')');

  const now = Date.now();
  await tUpdate('mantenimiento_solicitudes',{
    estado: 'rechazada',
    resuelto_por: userName,
    resuelto_ms: now,
    motivo_rechazo: motivo
  }).eq('id', solicitudId);

  return ok(res, { id: solicitudId, estado: 'rechazada' });
}

// ==================== PROYECCION ====================
async function apiGetProyeccion(p, res) {
  try {
    if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
    const anio=Number(p.anio||new Date().getFullYear());
    const[tareasRes,mesesRes]=await Promise.all([
      tSelect('proyeccion_tareas','*').eq('anio',anio).order('mes',{ascending:true}),
      tSelect('proyeccion_meses','*').eq('anio',anio).order('mes')
    ]);
    return ok(res,{
      tareas:(tareasRes.data||[]).map(r=>({id:r.id,anio:r.anio,nombre:r.nombre,descripcion:r.descripcion||'',area:r.area,mes:r.mes,responsable:r.responsable||'',prioridad:r.prioridad||'media',estado:r.estado||'pendiente',observaciones:r.observaciones||'',fechaEstado:r.fecha_estado||''})),
      meses:(mesesRes.data||[]).map(r=>({id:r.id,anio:r.anio,mes:r.mes,meta:Number(r.meta||0),presupuesto:Number(r.presupuesto||0),observaciones:r.observaciones||'',ventasAnterior:Number(r.ventas_anterior||0),ventasActual:Number(r.ventas_actual||0),gastos:Number(r.gastos||0),gastosAnterior:Number(r.gastos_anterior||0)}))
    });
  } catch(e) { return err(res, 'Error proyeccion: '+e.message); }
}
async function apiSaveTarea(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const anio=Number(p.anio||new Date().getFullYear());
  const{data}=await tInsert('proyeccion_tareas',{
    anio,nombre:String(p.nombre||'').trim(),descripcion:String(p.descripcion||'').trim(),
    area:String(p.area||'').trim(),mes:Number(p.mes||1),responsable:String(p.responsable||'').trim(),
    prioridad:String(p.prioridad||'media'),estado:String(p.estado||'pendiente'),
    observaciones:String(p.observaciones||'').trim(),updated_at:new Date().toISOString()
  }).select().single();
  return ok(res,{id:data.id});
}
async function apiUpdateTarea(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  if(!id) return err(res,'id requerido');
  await tUpdate('proyeccion_tareas',{
    nombre:String(p.nombre||'').trim(),descripcion:String(p.descripcion||'').trim(),
    area:String(p.area||'').trim(),mes:Number(p.mes||1),responsable:String(p.responsable||'').trim(),
    prioridad:String(p.prioridad||'media'),estado:String(p.estado||'pendiente'),
    observaciones:String(p.observaciones||'').trim(),
    fecha_estado:p.fechaEstado||new Date().toISOString().split('T')[0],
    updated_at:new Date().toISOString()
  }).eq('id',id);
  return ok(res,{id});
}
async function apiDeleteTarea(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  if(!id) return err(res,'id requerido');
  await tDelete('proyeccion_tareas').eq('id',id);
  return ok(res,{id});
}
async function apiSaveMesProyeccion(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const anio=Number(p.anio||new Date().getFullYear()),mes=Number(p.mes||1);
  await supabase.from('proyeccion_meses').upsert({
    motel_id: MOTEL_ID,
    anio,mes,meta:Number(p.meta||0),presupuesto:Number(p.presupuesto||0),
    observaciones:String(p.observaciones||'').trim(),
    ventas_anterior:Number(p.ventasAnterior||0),
    ventas_actual:Number(p.ventasActual||0),
    gastos:Number(p.gastos||0),
    gastos_anterior:Number(p.gastosAnterior||0)
  },{onConflict:'anio,mes'});
  return ok(res,{anio,mes});
}

// ==================== MAID LOG ====================
async function apiClearMaidLog(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const bDay=String(p.businessDay||businessDay(Date.now()));
  await tDelete('maid_log').eq('business_day',bDay);
  return ok(res,{businessDay:bDay});
}
async function apiMaidCancel(p, res) {
  const now=Date.now();
  const bDay=businessDay(now);
  const roomId=String(p.roomId||'').trim();
  const maidName=String(p.maidName||p.userName||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  const room=await getRoom(roomId);
  if(!room) return err(res,'Habitacion no existe');
  await tDelete('maid_log')
    .eq('maid_name',maidName).eq('room_id',roomId)
    .eq('business_day',bDay).eq('action','START').eq('finished_ms',0);
  await tUpdate('rooms',{
    maid_in_progress:false,
    maid_name_progress:'',
    state: room.state==='CONTAMINATED'?'DIRTY':room.state,
    contaminated_since_ms: 0,
    updated_at:new Date().toISOString()
  }).eq('room_id',roomId);
  return ok(res,{roomId,cancelled:true});
}

// ==================== CALENDARIO EXTRAS ====================
function ncalMapAreaExtra(a){
  a=String(a||'').trim();
  if(a==='Recepcion')return 'Recepcion';
  if(a==='Camarera'||a==='Camareria')return 'Camareria';
  if(a==='Patiero'||a==='Patio')return 'Patio';
  return '';
}
async function apiGetExtras(p, res) {
  const mes=String(p.mes||'').trim();
  if(!mes) return err(res,'mes requerido');
  const{data}=await tSelect('schedule_extras','*').like('fecha',mes+'%').order('fecha');
  const manual=(data||[]).map(r=>({id:r.id,fecha:r.fecha,area:r.area,nombre:r.nombre,horaEntrada:r.hora_entrada||'',horaSalida:r.hora_salida||'',tipo:r.tipo||'normal',vacInicio:r.vac_inicio||'',vacFin:r.vac_fin||'',fijo:r.fijo||'',origen:'manual'}));
  const SHIFT={SHIFT_1:'T1',SHIFT_2:'T2',SHIFT_3:'T3'};
  const{data:reales}=await tSelect('extra_staff','id,person_name,area,shift_id,business_day,entry_ms,exit_ms,payment,registered_by').like('business_day',mes+'%').eq('anulada',false);
  const realesMap=(reales||[]).map(r=>{
    const area=ncalMapAreaExtra(r.area);
    if(!area)return null;
    return {id:'real_'+r.id,fecha:r.business_day,area:area,nombre:r.person_name||'',horaEntrada:'',horaSalida:'',tipo:'normal',turno:SHIFT[r.shift_id]||'',vacInicio:'',vacFin:'',fijo:'',origen:'real',entryMs:r.entry_ms,exitMs:r.exit_ms,payment:r.payment,registeredBy:r.registered_by};
  }).filter(Boolean);
  return ok(res,{extras:manual.concat(realesMap)});
}
async function apiSaveExtra(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  const fecha=String(p.fecha||'').trim();
  const area=String(p.area||'').trim();
  const nombre=String(p.nombre||'').trim();
  const horaEntrada=String(p.horaEntrada||'').trim();
  const horaSalida=String(p.horaSalida||'').trim();
  const tipo=String(p.tipo||'normal').trim();
  const vacInicio=String(p.vacInicio||'').trim();
  const vacFin=String(p.vacFin||'').trim();
  if(!fecha||!area||!nombre) return err(res,'Datos incompletos');
  if(!id){
    const limite=area==='Camareria'?4:area==='Patio'?2:10;
    const{data:existing}=await tSelect('schedule_extras','id').eq('fecha',fecha).eq('area',area);
    if(existing&&existing.length>=limite) return err(res,'Limite de extras alcanzado para este dia ('+limite+')');
  }
  if(id){
    await tUpdate('schedule_extras',{nombre,hora_entrada:horaEntrada,hora_salida:horaSalida,tipo,vac_inicio:vacInicio,vac_fin:vacFin,fijo:String(p.fijo||'')}).eq('id',id);
  } else {
    await tInsert('schedule_extras',{fecha,area,nombre,hora_entrada:horaEntrada,hora_salida:horaSalida,tipo,vac_inicio:vacInicio,vac_fin:vacFin,fijo:String(p.fijo||'')});
  }
  return ok(res,{ok:true});
}
async function apiDeleteScheduleExtra(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  if(!id) return err(res,'id requerido');
  await tDelete('schedule_extras').eq('id',id);
  return ok(res,{ok:true});
}

// ITEM 10: Fallas de recepcionistas
async function apiSaveShiftFailure(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const now=Date.now();
  const bDay=String(p.businessDay||businessDay(now));
  const shiftId=String(p.shiftId||'');
  const userName=String(p.userName||'').trim();
  const failures=p.failures||[];
  if(!userName) return err(res,'userName requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  await tInsert('shift_failures',{
    ts_ms:now, business_day:bDay, shift_id:shiftId,
    user_name:userName, failures:JSON.stringify(failures),
    created_by:String(p.createdBy||'ADMIN')
  });
  return ok(res,{saved:true});
}
async function apiGetShiftFailures(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const yearMonth=String(p.yearMonth||'');
  const filterUserName=String(p.filterUserName||'').trim();
  let query=tSelect('shift_failures','*').order('ts_ms',{ascending:false});
  if(yearMonth) query=query.like('business_day',yearMonth+'%');
  if(filterUserName) query=query.eq('user_name',filterUserName);
  const{data}=await query.limit(filterUserName?1000:200);
  // Agrupar por recepcionista
  const byUser={};
  (data||[]).forEach(r=>{
    const nm=r.user_name||'?';
    if(!byUser[nm])byUser[nm]={nombre:nm,totalFallas:0,detalle:[]};
    const fallas=JSON.parse(r.failures||'[]');
    byUser[nm].totalFallas+=fallas.length;
    byUser[nm].detalle.push({tsMs:Number(r.ts_ms),businessDay:r.business_day,shiftId:r.shift_id,failures:fallas,createdBy:r.created_by||''});
  });
  const ranking=Object.values(byUser).sort((a,b)=>b.totalFallas-a.totalFallas);
  return ok(res,{ranking,raw:(data||[]).map(r=>({id:r.id,tsMs:Number(r.ts_ms),businessDay:r.business_day,shiftId:r.shift_id,userName:r.user_name,failures:JSON.parse(r.failures||'[]'),createdBy:r.created_by||''}))});
}
// ==================== PRODUCTOS ====================
async function apiGetProducts(p, res) {
  const { data } = await tSelect('products','*').order('categoria').order('nombre');
  return ok(res, { products: (data || []).map(r => ({
    id: r.id, nombre: r.nombre, codigoBarras: r.codigo_barras || '',
    precio: Number(r.precio || 0), categoria: r.categoria || '',
    stockActual: Number(r.stock_actual || 0), stockBodega: Number(r.stock_bodega || 0),
    stockMinimo: Number(r.stock_minimo || 5), activo: !!r.activo
  })) });
}

async function apiSaveProduct(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id = Number(p.id || 0);
  const nombre = String(p.nombre||'').trim();
  const codigo = String(p.codigoBarras||'').trim();
  const precio = Number(p.precio||0);
  const categoria = String(p.categoria||'').trim();
  const stockActual = Number(p.stockActual||0);
  const stockMinimo = Number(p.stockMinimo||5);
  if(!nombre) return err(res,'Nombre requerido');
  if(!precio) return err(res,'Precio requerido');
  if(id) {
    // Al EDITAR no se modifica stock_actual — para ajustar stock usar apiAjusteInventario
    await tUpdate('products',{
      nombre, codigo_barras: codigo||null, precio, categoria,
      stock_minimo: stockMinimo
    }).eq('id', id);
  } else {
    await tInsert('products',{
      nombre, codigo_barras: codigo||null, precio, categoria,
      stock_actual: 0, stock_bodega: stockActual, stock_minimo: stockMinimo, activo: true
    });
  }
  return ok(res, {});
}

async function apiDeleteProduct(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id = Number(p.id||0);
  if(!id) return err(res,'id requerido');
  await tUpdate('products',{ activo: false }).eq('id', id);
  return ok(res, {});
}

// Editor de precios (Configuracion): actualiza los 7 campos del jsonb de UNA
// categoria, scopeado por MOTEL_ID. Valida ADMIN y rangos. Invalida la cache de
// getPricing del motel para que el cambio impacte el cobro al instante.
async function apiSaveCategoriaPrecios(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const nombreDb = String(p.nombreDb||'').trim();
  if(!nombreDb) return err(res,'nombreDb requerido');
  const precios = p.precios || {};
  // 6 campos de dinero: entero > 0
  const MONEY_KEYS = ['3h','6h','8h','12h','extraHour','extraPerson'];
  const out = {};
  for(const k of MONEY_KEYS){
    const v = Number(precios[k]);
    if(!Number.isInteger(v) || v <= 0) return err(res,'Valor invalido para '+k+' (entero > 0)');
    out[k] = v;
  }
  // included: entero 1..10
  const inc = Number(precios.included);
  if(!Number.isInteger(inc) || inc < 1 || inc > 10) return err(res,'included debe ser entero entre 1 y 10');
  out.included = inc;
  // Update scopeado por motel + categoria; .select confirma que la fila existia
  const { data: upd, error: updErr } = await tUpdate('app_categorias', { precios: out })
    .eq('nombre_db', nombreDb)
    .select('nombre_db');
  if(updErr) return err(res, updErr.message);
  if(!upd || !upd.length) return err(res,'Categoria no encontrada para este motel: '+nombreDb);
  // Refresca cache y devuelve el pricing actualizado para que el front actualice MP
  invalidatePricingCache(MOTEL_ID);
  const masterPricing = await getPricing(MOTEL_ID, { force: true });
  return ok(res, { nombreDb, precios: out, masterPricing });
}

// Valida los 7 precios de una categoria. Devuelve {out} (normalizado) o {error}.
function validarPreciosCat(precios) {
  precios = precios || {};
  const MONEY_KEYS = ['3h','6h','8h','12h','extraHour','extraPerson'];
  const out = {};
  for(const k of MONEY_KEYS){
    const v = Number(precios[k]);
    if(!Number.isInteger(v) || v <= 0) return { error: 'Valor invalido para '+k+' (entero > 0)' };
    out[k] = v;
  }
  const inc = Number(precios.included);
  if(!Number.isInteger(inc) || inc < 1 || inc > 10) return { error: 'included debe ser entero entre 1 y 10' };
  out.included = inc;
  return { out };
}

// Lista todas las categorias del motel (incluye inactivas) para el editor. ADMIN.
async function apiGetCategorias(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const { data, error } = await tSelect('app_categorias', 'id,nombre_ui,nombre_db,precios,orden,activo')
    .order('orden');
  if(error) return err(res, error.message);
  return ok(res, { categorias: data || [] });
}

// Crea categoria. ADMIN. Exige nombre + 7 precios > 0 (anti-$0). nombre_db se
// genera del nombre (normalizado), unico por motel, INMUTABLE. activo=true.
async function apiCreateCategoria(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const nombre = String(p.nombre||'').trim().replace(/\s+/g,' ');
  if(!nombre) return err(res,'El nombre de la categoria es obligatorio');
  const v = validarPreciosCat(p.precios);
  if(v.error) return err(res, v.error);
  const nombreDb = nombre; // clave de match con rooms.category, inmutable
  // Unicidad por motel (incluye inactivas para no colisionar)
  const { data: existe } = await tSelect('app_categorias', 'id').eq('nombre_db', nombreDb).maybeSingle();
  if(existe) return err(res,'Ya existe una categoria con ese nombre');
  // orden: el enviado, o el siguiente disponible
  let orden = Number(p.orden||0);
  if(!Number.isInteger(orden) || orden <= 0){
    const { data: maxRow } = await tSelect('app_categorias', 'orden').order('orden',{ascending:false}).limit(1).maybeSingle();
    orden = ((maxRow && Number(maxRow.orden)) || 0) + 1;
  }
  const { data: ins, error: insErr } = await tInsert('app_categorias', { nombre_ui: nombre, nombre_db: nombreDb, precios: v.out, orden, activo: true, creado: new Date().toISOString() })
    .select('id,nombre_ui,nombre_db,orden,activo').single();
  if(insErr) return err(res, insErr.message);
  invalidatePricingCache(MOTEL_ID);
  const masterPricing = await getPricing(MOTEL_ID, { force: true });
  return ok(res, { categoria: ins, masterPricing });
}

// Edita SOLO nombre visible (nombre_ui) y orden. nombre_db NO se toca (inmutable). ADMIN.
async function apiEditCategoria(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id = String(p.id||'').trim();
  if(!id) return err(res,'id requerido');
  const nombre = String(p.nombre||'').trim().replace(/\s+/g,' ');
  if(!nombre) return err(res,'El nombre visible es obligatorio');
  const upd = { nombre_ui: nombre };
  const orden = Number(p.orden);
  if(Number.isInteger(orden) && orden > 0) upd.orden = orden;
  const { data, error } = await tUpdate('app_categorias', upd).eq('id', id)
    .select('id,nombre_ui,nombre_db,orden,activo').maybeSingle();
  if(error) return err(res, error.message);
  if(!data) return err(res,'Categoria no encontrada');
  invalidatePricingCache(MOTEL_ID);
  const masterPricing = await getPricing(MOTEL_ID, { force: true });
  return ok(res, { categoria: data, masterPricing });
}

// Baja/alta logica (activo). Al desactivar, BLOQUEA si hay habitaciones apuntando.
// Nunca DELETE. ADMIN.
async function apiToggleCategoria(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id = String(p.id||'').trim();
  if(!id) return err(res,'id requerido');
  const activo = p.activo === true;
  const { data: cat } = await tSelect('app_categorias', 'id,nombre_db').eq('id', id).maybeSingle();
  if(!cat) return err(res,'Categoria no encontrada');
  if(!activo){
    // Bloquear baja si hay habitaciones en esta categoria (filtra por motel via tSelect)
    const { count } = await tSelect('rooms', 'room_id', { count: 'exact', head: true }).eq('category', cat.nombre_db);
    if(count && count > 0) return err(res,'No se puede desactivar: hay '+count+' habitacion(es) en esta categoria. Reasignalas primero.');
  }
  const { data, error } = await tUpdate('app_categorias', { activo }).eq('id', id)
    .select('id,nombre_ui,nombre_db,orden,activo').maybeSingle();
  if(error) return err(res, error.message);
  invalidatePricingCache(MOTEL_ID);
  const masterPricing = await getPricing(MOTEL_ID, { force: true });
  return ok(res, { categoria: data, masterPricing });
}

// Editor de datos del motel (Configuracion > Datos del motel). Valida ADMIN y
// nombre no vacio; el resto (logo, fiscales) son opcionales. Scoped por MOTEL_ID.
async function apiSaveMotelInfo(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const nombre = String(p.nombre||'').trim();
  if(!nombre) return err(res,'El nombre del motel es obligatorio');
  const upd = {
    nombre,
    logo_url: String(p.logoUrl||'').trim(),
    nit: String(p.nit||'').trim(),
    razon_social: String(p.razonSocial||'').trim(),
    direccion: String(p.direccion||'').trim(),
    telefono: String(p.telefono||'').trim(),
    ciudad: String(p.ciudad||'').trim(),
    resolucion_dian: String(p.resolucionDian||'').trim(),
    actualizado: new Date().toISOString()
  };
  const { data, error } = await tUpdate('motel_info', upd)
    .select(MOTEL_INFO_FIELDS).maybeSingle();
  if(error) return err(res, error.message);
  if(!data) return err(res,'No existe motel_info para este motel');
  return ok(res, { motelInfo: data });
}

async function apiAddStock(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const id = Number(p.id||0);
  const cantidad = Number(p.cantidad||0);
  if(!id) return err(res,'id requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const { data: prod } = await tSelect('products','*').eq('id', id).single();
  if(!prod) return err(res,'Producto no existe');
  const { data: nuevoStock, error: stockErr } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: id, p_delta: cantidad });
  if(stockErr) return err(res, stockErr.message);
  const now = Date.now();
  await tInsert('stock_entries',{
    ts_ms: now, business_day: businessDay(now), shift_id: currentShiftId(now),
    product_id: id, product_name: prod.nombre||'',
    cantidad: cantidad, user_name: String(p.userName||'')
  });
  return ok(res, { nuevoStock });
}

async function apiGetRoomProducts(p, res) {
  const roomId = String(p.roomId||'').trim();
  const checkInMs = Number(p.checkInMs||0);
  if(!roomId) return err(res,'roomId requerido');
  let query = tSelect('room_products','*').eq('room_id', roomId);
  if(checkInMs) query = query.eq('check_in_ms', checkInMs);
  const { data } = await query.order('ts_ms');
  return ok(res, { products: (data||[]).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms), productId: r.product_id,
    productName: r.product_name, cantidad: Number(r.cantidad||0),
    precioUnit: Number(r.precio_unit||0), total: Number(r.total||0),
    payMethod: r.pay_method||'EFECTIVO', userName: r.user_name||'',
    isCortesia: !!r.is_cortesia
  })) });
}

async function apiAddRoomProduct(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const roomId = String(p.roomId||'').trim();
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||1);
  const payMethod = String(p.payMethod||'EFECTIVO').toUpperCase();
  const isCortesia = !!(p.isCortesia);
  const cortesiaDestinatario = String(p.cortesiaDestinatario||'').trim();
  const userName = String(p.userName||'').trim();
  const checkInMs = Number(p.checkInMs||0);
  if(!roomId) return err(res,'roomId requerido');
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const { data: prod } = await tSelect('products','*').eq('id', productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_actual||0) < cantidad) return err(res,'Stock insuficiente. Quedan: '+prod.stock_actual);
  const total = isCortesia ? 0 : Number(prod.precio||0) * cantidad;
  // Desglose de pago (Parte 2 del MIXTO en productos): si el front manda el reparto
  // (check-in mixto), se usa; si no, se deriva del pay_method simple (molde apiCheckIn).
  const tieneDesglose = (p.amount_1!=null || p.amount_2!=null || p.amount_3!=null);
  const amount1 = tieneDesglose ? Number(p.amount_1||0) : (payMethod==='EFECTIVO'?total:0);
  const amount2 = tieneDesglose ? Number(p.amount_2||0) : (payMethod==='TARJETA'?total:0);
  const amount3 = tieneDesglose ? Number(p.amount_3||0) : (payMethod==='NEQUI'?total:0);
  const payMethod2 = String(p.payMethod2 || (payMethod==='MIXTO'?'MIXTO_EF_TJ_NQ':''));
  await tInsert('room_products',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    room_id: roomId, check_in_ms: checkInMs,
    product_id: productId, product_name: prod.nombre,
    cantidad, precio_unit: Number(prod.precio||0),
    total, pay_method: payMethod,
    pay_method_2: payMethod2,
    amount_1: amount1, amount_2: amount2, amount_3: amount3,
    user_name: userName, is_cortesia: isCortesia,
    cortesia_destinatario: cortesiaDestinatario
  });
  const { data: stockRestante, error: stockErr } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: -cantidad });
  if(stockErr) return err(res, stockErr.message);
  await tInsert('stock_movements',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_name: userName, user_role: 'RECEPTION',
    product_id: productId, product_name: prod.nombre,
    tipo: isCortesia ? 'venta_bar_cortesia' : 'venta_bar',
    cantidad: -cantidad,
    nota: roomId ? ('Hab '+roomId) : ''
  });
  if(isCortesia) {
    await tInsert('cortesias',{
      ts_ms: now, business_day: bDay, shift_id: shift,
      product_id: productId, product_name: prod.nombre,
      cantidad, precio_unit: Number(prod.precio||0),
      total: Number(prod.precio||0) * cantidad,
      user_name: userName,
      destinatario: cortesiaDestinatario
    });
  }
  return ok(res, { total, stockRestante });
}

async function apiEditRoomProduct(p, res) {
  const id = Number(p.id||0);
  const nuevaCantidad = Number(p.cantidad||0);
  if(!id) return err(res,'id requerido');
  if(nuevaCantidad<=0) return err(res,'Cantidad invalida');
  const { data: rp } = await tSelect('room_products','*').eq('id', id).single();
  if(!rp) return err(res,'Registro no existe');
  const diff = nuevaCantidad - Number(rp.cantidad||0);
  const { data: prod } = await tSelect('products','stock_actual').eq('id', rp.product_id).single();
  if(!prod) return err(res,'Producto no existe');
  if(diff > 0 && Number(prod.stock_actual||0) < diff) return err(res,'Stock insuficiente');
  const nuevoTotal = rp.is_cortesia ? 0 : Number(rp.precio_unit||0) * nuevaCantidad;
  await tUpdate('room_products',{
    cantidad: nuevaCantidad, total: nuevoTotal
  }).eq('id', id);
  const { error: stockErr } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: rp.product_id, p_delta: -diff });
  if(stockErr) return err(res, stockErr.message);
  if(diff !== 0) {
    await tInsert('stock_movements',{
      ts_ms: Date.now(), business_day: rp.business_day, shift_id: rp.shift_id,
      user_name: String(p.userName||rp.user_name||''), user_role: String(p.userRole||'').toUpperCase() || 'RECEPTION',
      product_id: rp.product_id, product_name: rp.product_name,
      tipo: 'edit_venta_bar',
      cantidad: -diff,
      nota: 'Hab '+rp.room_id+' — edit cantidad '+rp.cantidad+'->'+nuevaCantidad
    });
  }
  return ok(res, { nuevoTotal });
}

async function apiDeleteRoomProduct(p, res) {
  const id = Number(p.id||0);
  if(!id) return err(res,'id requerido');
  const { data: rp } = await tSelect('room_products','*').eq('id', id).single();
  if(!rp) return err(res,'Registro no existe');
  const { error: stockErr } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: rp.product_id, p_delta: Number(rp.cantidad||0) });
  if(stockErr) return err(res, stockErr.message);
  await tInsert('stock_movements',{
    ts_ms: Date.now(), business_day: rp.business_day, shift_id: rp.shift_id,
    user_name: String(p.userName||rp.user_name||''), user_role: String(p.userRole||'').toUpperCase() || 'RECEPTION',
    product_id: rp.product_id, product_name: rp.product_name,
    tipo: 'delete_venta_bar',
    cantidad: Number(rp.cantidad||0),
    nota: 'Hab '+rp.room_id+' — delete'
  });
  await tDelete('room_products').eq('id', id);
  return ok(res, {});
}

async function apiSaveCortesia(p, res) {
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||1);
  const userName = String(p.userName||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const { data: prod } = await tSelect('products','*').eq('id', productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_actual||0) < cantidad) return err(res,'Stock insuficiente');
  await tInsert('cortesias',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    product_id: productId, product_name: prod.nombre,
    cantidad, precio_unit: Number(prod.precio||0),
    total: Number(prod.precio||0) * cantidad,
    user_name: userName
  });
  const { data: stockRestante, error: stockErr } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: -cantidad });
  if(stockErr) return err(res, stockErr.message);
  await tInsert('stock_movements',{
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_name: userName, user_role: 'RECEPTION',
    product_id: productId, product_name: prod.nombre,
    tipo: 'cortesia_bar',
    cantidad: -cantidad,
    nota: 'Cortesia'
  });
  return ok(res, { stockRestante });
}
async function apiSaveObservacionTurno(p, res) {
  if(!['ADMIN','RECEPTION'].includes(String(p.userRole||'').toUpperCase())) return err(res,'Sin permiso');
  const now=Date.now();
  const bd=String(p.businessDay||businessDay(now));
  const shiftId=String(p.shiftId||'');
  const observacion=String(p.observacion||'');
  if(!shiftId) return err(res,'shiftId requerido');
  const {data:existing}=await tSelect('product_shift_obs','id').eq('business_day',bd).eq('shift_id',shiftId).maybeSingle();
  if(existing){
    await tUpdate('product_shift_obs',{observacion,user_name:String(p.userName||''),ts_ms:now}).eq('id',existing.id);
  } else {
    await tInsert('product_shift_obs',{business_day:bd,shift_id:shiftId,observacion,user_name:String(p.userName||''),ts_ms:now});
  }
  return ok(res,{saved:true});
}

async function apiGetObservacionesTurno(p, res) {
  const bd=String(p.businessDay||businessDay(Date.now()));
  const {data:obs}=await tSelect('product_shift_obs','*').eq('business_day',bd);
  return ok(res,{obs:obs||[]});
}
async function apiGetProductosMes(p, res) {
  const ym=String(p.yearMonth||'');
  if(!ym)return err(res,'yearMonth requerido');
  const {data:prods}=await tSelect('room_products','total,pay_method,is_cortesia,amount_1,amount_2,amount_3').like('business_day',ym+'%').eq('is_cortesia',false);
  const {data:cors}=await tSelect('room_products','total,cantidad,product_id').like('business_day',ym+'%').eq('is_cortesia',true);
  const {data:prodsList}=await tSelect('products','id,precio');
  const totalVentas=(prods||[]).reduce((a,r)=>a+Number(r.total||0),0);
  const totalEf=(prods||[]).reduce((a,r)=>a+(r.pay_method==='MIXTO'?Number(r.amount_1||0):(r.pay_method==='EFECTIVO'?Number(r.total||0):0)),0);
  const totalTa=(prods||[]).reduce((a,r)=>a+(r.pay_method==='MIXTO'?Number(r.amount_2||0):(r.pay_method==='TARJETA'?Number(r.total||0):0)),0);
  const totalNq=(prods||[]).reduce((a,r)=>a+(r.pay_method==='MIXTO'?Number(r.amount_3||0):(r.pay_method==='NEQUI'?Number(r.total||0):0)),0);
  const precioMap={};(prodsList||[]).forEach(p=>{precioMap[p.id]=Number(p.precio||0);});
  const totalCortesias=(cors||[]).reduce((a,r)=>a+Number(r.cantidad||0)*Number(precioMap[r.product_id]||0),0);
  return ok(res,{yearMonth:ym,totalVentas,totalEf,totalTa,totalNq,totalCortesias});
}
// Pieza 3: delta de stock FIRMADO de un ajuste (fila de la tabla `ajustes`), para
// pintar la evidencia (retiro rojo / ingreso verde). NO se puede usar el signo crudo
// de `cantidad`: p.ej. roto/vencido/robo guardan cantidad positiva pero RESTAN stock.
function signoDeltaAjuste(a) {
  const tipo = String(a.tipo || '');
  const cant = Number(a.cantidad || 0);
  if (tipo === 'conteo') return cant;                                   // cantidad ya viene con signo (cantidad_signo)
  if (tipo === 'ingreso_extra' || tipo === 'venta_duplicada') return Math.abs(cant);  // suman stock
  if (tipo === 'roto' || tipo === 'vencido' || tipo === 'robo' || tipo === 'salida_extra' || tipo === 'venta_olvidada') return -Math.abs(cant); // restan
  if (tipo === 'producto') return -Math.abs(cant);                      // cambio: el producto principal se resta
  if (tipo === 'metodo_pago') return 0;                                 // no afecta stock
  return cant;
}

// Pieza 1 (read-only): lista las cortesias ORIGINALES de un business_day+turno.
// ADMIN-only por consistencia con el modal de ajuste. Las Piezas 2/3 (escritura)
// naceran con verificacion de sesion firmada, NO con p.userRole.
async function apiGetCortesiasByShift(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN', 403);
  const bDay = String(p.businessDay || '').trim();
  const sid  = String(p.shiftId || '').trim();
  if (!bDay || !sid) return err(res, 'Falta fecha o turno', 400);
  const { data, error } = await tSelect('room_products',
      'id, ts_ms, product_id, product_name, cantidad, cortesia_destinatario, user_name')
    .eq('business_day', bDay).eq('shift_id', sid)
    .eq('is_cortesia', true).is('tipo_ajuste', null)
    .order('ts_ms', { ascending: true });
  if (error) return err(res, error.message, 500);
  // Netear: excluir las cortesias ya quitadas (fila compensatoria con ajuste_ref_id)
  const { data: quitadas } = await tSelect('room_products', 'ajuste_ref_id')
    .eq('business_day', bDay).eq('shift_id', sid).eq('tipo_ajuste', 'cortesia_quitada');
  const quitadasSet = new Set((quitadas || []).map(q => Number(q.ajuste_ref_id)));
  const items = (data || []).filter(r => !quitadasSet.has(Number(r.id))).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms || 0), productId: r.product_id,
    productName: r.product_name, cantidad: Number(r.cantidad || 0),
    destinatario: r.cortesia_destinatario || '', userName: r.user_name || ''
  }));
  return ok(res, { items });
}

// Pieza 2 (escritura): quita una cortesia. NACE CERRADA: exige carnet firmado
// (requireAdmin), NO p.userRole. Inserta la fila compensatoria negativa
// estampada al business_day+shift_id ORIGINAL (espejo triple room_products +
// cortesias + stock_movements), repone stock, y audita en `ajustes`.
async function apiQuitarCortesia(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const rpId = Number(p.roomProductId || 0);
  const motivo = String(p.motivo || '').trim();
  if (!rpId) return err(res, 'Falta la cortesía', 400);
  if (motivo.length < 3) return err(res, 'Motivo obligatorio (min 3)', 400);

  // Cargar la cortesia ORIGINAL (de este motel, no es fila de ajuste)
  const { data: orig } = await tSelect('room_products', '*')
    .eq('id', rpId).eq('is_cortesia', true).is('tipo_ajuste', null).maybeSingle();
  if (!orig) return err(res, 'Cortesía no encontrada', 404);

  // Guard doble-quita
  const { data: yaQ } = await tSelect('room_products', 'id')
    .eq('ajuste_ref_id', rpId).eq('tipo_ajuste', 'cortesia_quitada').maybeSingle();
  if (yaQ) return err(res, 'Esta cortesía ya fue quitada', 409);

  const now = Date.now();
  const bDay = orig.business_day, sid = orig.shift_id;   // estampado al ORIGINAL
  const n = Number(orig.cantidad || 0);
  const { data: prod } = await tSelect('products', 'precio').eq('id', orig.product_id).maybeSingle();
  const precio = Number((prod && prod.precio) || orig.precio_unit || 0);

  await tInsert('room_products', {
    ts_ms: now, business_day: bDay, shift_id: sid, room_id: 'AJUSTE',
    product_id: orig.product_id, product_name: orig.product_name,
    cantidad: -n, precio_unit: precio, total: 0, pay_method: 'EFECTIVO',
    user_name: s.n, is_cortesia: true, cortesia_destinatario: orig.cortesia_destinatario || '',
    created_by_admin: true, tipo_ajuste: 'cortesia_quitada', motivo_ajuste: motivo,
    ajuste_ref_id: rpId
  });
  await tInsert('cortesias', {
    ts_ms: now, business_day: bDay, shift_id: sid, product_id: orig.product_id,
    product_name: orig.product_name, cantidad: -n, precio_unit: precio,
    total: -(precio * n), user_name: s.n, destinatario: orig.cortesia_destinatario || ''
  });
  await tInsert('stock_movements', {
    ts_ms: now, business_day: bDay, shift_id: sid, user_name: s.n, user_role: 'ADMIN',
    product_id: orig.product_id, product_name: orig.product_name,
    tipo: 'cortesia_ajuste_entrada', cantidad: n, nota: 'Quita cortesía #' + rpId + ' — ' + motivo
  });
  await supabase.rpc('apply_stock_actual_delta', { p_product_id: orig.product_id, p_delta: n });

  await tInsert('ajustes', {
    ts_ms: now, categoria: 'RECEPCION', tipo: 'cortesia_quitada',
    product_id: orig.product_id, product_name: orig.product_name, cantidad: n,
    afecta_stock: 'recepcion', afecta_cuadre: false, business_day: bDay, shift_id: sid,
    valor_afectado: precio * n, motivo, admin_name: s.n
  });
  return ok(res, { ok: true, repuesto: n });
}

// Pieza 3 (escritura): agrega una cortesia a un turno (posible pasado). NACE
// CERRADA (requireAdmin). BLOQUEA si el stock no alcanza (como todo el sistema
// y el piso duro de apply_stock_actual_delta): descuento atomico PRIMERO, y
// recien si pasa, inserta el espejo triple estampado al dia/turno elegido.
async function apiAgregarCortesia(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);
  const productId = Number(p.productId || 0);
  const cantidad  = Math.floor(Number(p.cantidad || 0));
  const dest   = String(p.destinatario || '').trim();
  const motivo = String(p.motivo || '').trim();
  const bDay = String(p.businessDay || '').trim();
  const sid  = String(p.shiftId || '').trim();
  if (!productId || cantidad < 1) return err(res, 'Producto y cantidad válidos', 400);
  if (!dest) return err(res, 'Falta el destinatario', 400);
  if (motivo.length < 3) return err(res, 'Motivo obligatorio (min 3)', 400);
  if (!bDay || !sid) return err(res, 'Falta fecha o turno', 400);

  const { data: prod } = await tSelect('products', 'id, nombre, precio, stock_actual').eq('id', productId).maybeSingle();
  if (!prod) return err(res, 'Producto no encontrado', 404);
  const precio = Number(prod.precio || 0);

  // BLOQUEO: stock insuficiente. Pre-check + descuento atomico primero.
  if (Number(prod.stock_actual || 0) < cantidad)
    return err(res, 'Stock insuficiente: hay ' + Number(prod.stock_actual || 0) + '. Registrá una entrada o ajuste de inventario antes de agregar la cortesía.', 409);
  try {
    await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: -cantidad });
  } catch (e) {
    return err(res, 'Stock insuficiente para agregar la cortesía', 409);
  }

  const now = Date.now();
  await tInsert('room_products', {
    ts_ms: now, business_day: bDay, shift_id: sid, room_id: 'AJUSTE',
    product_id: productId, product_name: prod.nombre,
    cantidad: cantidad, precio_unit: precio, total: 0, pay_method: 'EFECTIVO',
    user_name: s.n, is_cortesia: true, cortesia_destinatario: dest,
    created_by_admin: true, tipo_ajuste: null, motivo_ajuste: motivo
  });
  await tInsert('cortesias', {
    ts_ms: now, business_day: bDay, shift_id: sid, product_id: productId,
    product_name: prod.nombre, cantidad: cantidad, precio_unit: precio,
    total: precio * cantidad, user_name: s.n, destinatario: dest
  });
  await tInsert('stock_movements', {
    ts_ms: now, business_day: bDay, shift_id: sid, user_name: s.n, user_role: 'ADMIN',
    product_id: productId, product_name: prod.nombre,
    tipo: 'cortesia_ajuste_salida', cantidad: -cantidad, nota: 'Cortesía agregada (admin) — ' + motivo
  });
  await tInsert('ajustes', {
    ts_ms: now, categoria: 'RECEPCION', tipo: 'cortesia_agregada',
    product_id: productId, product_name: prod.nombre, cantidad: cantidad,
    afecta_stock: 'recepcion', afecta_cuadre: false, business_day: bDay, shift_id: sid,
    valor_afectado: precio * cantidad, motivo, admin_name: s.n
  });
  return ok(res, { ok: true });
}

async function apiGetInventarioByDay(p, res) {
  const bd=String(p.businessDay||businessDay(Date.now()));
  const {data:products}=await tSelect('products','*').eq('activo',true).order('categoria').order('nombre');
  if(!products||!products.length) return ok(res,{rows:[],resumenTurnos:{},businessDay:bd});
  const {data:entries}=await tSelect('stock_entries','*').eq('business_day',bd);
  const {data:sales}=await tSelect('room_products','*').eq('business_day',bd);
  const {data:obs}=await tSelect('product_shift_obs','*').eq('business_day',bd);
  const {data:movements}=await tSelect('stock_movements','*').eq('business_day',bd);
  // Pieza 3: ajustes admin del dia (evidencia visible del descuadre).
  const {data:ajustesDia}=await tSelect('ajustes','*').eq('business_day',bd).order('ts_ms',{ascending:false});
  const {data:snapsRows}=await tSelect('shift_inventory_start','shift_id,product_id,saldo_inicial').eq('business_day',bd);
  const snaps={};(snapsRows||[]).forEach(s=>{if(!snaps[s.shift_id])snaps[s.shift_id]={};snaps[s.shift_id][s.product_id]=Number(s.saldo_inicial);});
  const shifts=['SHIFT_1','SHIFT_2','SHIFT_3'];
 const ayer=new Date(bd.replace(/-/g,'/'));ayer.setDate(ayer.getDate()-1);
  const ayerStr=ayer.getFullYear()+'-'+String(ayer.getMonth()+1).padStart(2,'0')+'-'+String(ayer.getDate()).padStart(2,'0');
  const {data:salesAyer}=await tSelect('room_products','product_id,cantidad,is_cortesia').eq('business_day',ayerStr);
  const {data:entriesAyer}=await tSelect('stock_entries','product_id,cantidad').eq('business_day',ayerStr);
  const rows=products.map(function(prod){
    const totalVentas=(sales||[]).filter(s=>s.product_id===prod.id&&!s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const totalCortesias=(sales||[]).filter(s=>s.product_id===prod.id&&s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const totalEntradas=(entries||[]).filter(e=>e.product_id===prod.id).reduce((a,e)=>a+Number(e.cantidad||0),0);
    const ventasAyer=(salesAyer||[]).filter(s=>s.product_id===prod.id&&!s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const cortesiasAyer=(salesAyer||[]).filter(s=>s.product_id===prod.id&&s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const entradasAyer=(entriesAyer||[]).filter(e=>e.product_id===prod.id).reduce((a,e)=>a+Number(e.cantidad||0),0);
   const totalTraslados=(movements||[]).filter(m=>m.product_id===prod.id&&m.tipo==='traslado_recepcion').reduce((a,m)=>a+Number(m.cantidad||0),0);
    const totalDevoluciones=(movements||[]).filter(m=>m.product_id===prod.id&&m.tipo==='devolucion_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
    const snapT1=(snaps['SHIFT_1']||{})[prod.id];
    const saldoInicialReal=(snapT1!=null)?snapT1:(Number(prod.stock_actual||0)+totalVentas+totalCortesias-totalTraslados-totalEntradas+totalDevoluciones);
    const turnosData={};
    shifts.forEach(function(sid){
      const ent=(entries||[]).filter(e=>e.product_id===prod.id&&e.shift_id===sid).reduce((a,e)=>a+Number(e.cantidad||0),0);
      const ven=(sales||[]).filter(s=>s.product_id===prod.id&&s.shift_id===sid&&!s.is_cortesia);
      const corItems=(sales||[]).filter(s=>s.product_id===prod.id&&s.shift_id===sid&&s.is_cortesia);
      const cor=corItems.reduce((a,s)=>a+Number(s.cantidad||0),0);
      const cortesiasDetalle=corItems.map(s=>({cantidad:Number(s.cantidad||0),destinatario:s.cortesia_destinatario||''}));
      turnosData[sid]={entradas:ent,ventas:ven.reduce((a,s)=>a+Number(s.cantidad||0),0),cortesias:cor,cortesiasDetalle,valorVendido:ven.reduce((a,s)=>a+Number(s.total||0),0),ef:ven.reduce((a,s)=>a+(s.pay_method==='MIXTO'?Number(s.amount_1||0):(s.pay_method==='EFECTIVO'?Number(s.total||0):0)),0),ta:ven.reduce((a,s)=>a+(s.pay_method==='MIXTO'?Number(s.amount_2||0):(s.pay_method==='TARJETA'?Number(s.total||0):0)),0),nq:ven.reduce((a,s)=>a+(s.pay_method==='MIXTO'?Number(s.amount_3||0):(s.pay_method==='NEQUI'?Number(s.total||0):0)),0)};
    });
    const movsProd=(movements||[]).filter(m=>m.product_id===prod.id);
const ingBodegaTotal=movsProd.filter(m=>m.tipo==='ingreso_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
const trasladoTotal=movsProd.filter(m=>m.tipo==='traslado_recepcion').reduce((a,m)=>a+Number(m.cantidad||0),0);
shifts.forEach(function(sid){
  const movsSid=movsProd.filter(m=>m.shift_id===sid);
  turnosData[sid].ingresoBodega=movsSid.filter(m=>m.tipo==='ingreso_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
  var trasladoTurno=movsSid.filter(m=>m.tipo==='traslado_recepcion').reduce((a,m)=>a+Number(m.cantidad||0),0);
  var devolucionTurno=movsSid.filter(m=>m.tipo==='devolucion_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
  turnosData[sid].trasladoRecepcion=trasladoTurno-devolucionTurno;
  // Ajuste por CONTEO de recepcion en este turno: mueve stock_actual pero NO deja
  // fila en room_products, asi que la reconstruccion de la S no lo veia -> descuadre
  // falso. Solo 'conteo': venta_olvidada/venta_duplicada/producto YA entran por la V
  // (escriben room_products). BODEGA no aplica a la S (afecta SALDO BOD, stock vivo).
  turnosData[sid].ajusteRecepcion=(ajustesDia||[])
    .filter(a=>a.product_id===prod.id&&a.shift_id===sid&&a.categoria==='RECEPCION'&&String(a.tipo||'')==='conteo')
    .reduce((acc,a)=>acc+signoDeltaAjuste(a),0);
});
return{id:prod.id,nombre:prod.nombre,categoria:prod.categoria||'',codigoBarras:prod.codigo_barras||'',precio:Number(prod.precio||0),stockMinimo:Number(prod.stock_minimo||5),saldoInicial:saldoInicialReal,saldoActual:Number(prod.stock_actual||0),stockBodega:Number(prod.stock_bodega||0),turnos:turnosData};
  });
  const resumenTurnos={};
  shifts.forEach(function(sid){
    const venTurno=(sales||[]).filter(s=>s.shift_id===sid&&!s.is_cortesia);
    const corTurno=(sales||[]).filter(s=>s.shift_id===sid&&s.is_cortesia);
    resumenTurnos[sid]={totalVendido:venTurno.reduce((a,s)=>a+Number(s.total||0),0),totalEf:venTurno.filter(s=>s.pay_method==='EFECTIVO').reduce((a,s)=>a+Number(s.total||0),0),totalTa:venTurno.filter(s=>s.pay_method==='TARJETA').reduce((a,s)=>a+Number(s.total||0),0),totalNq:venTurno.filter(s=>s.pay_method==='NEQUI').reduce((a,s)=>a+Number(s.total||0),0),totalCortesias:corTurno.reduce((a,s)=>a+Number(s.cantidad||0)*Number(s.precio_unit||0),0),cortesiasDetalle:corTurno.map(s=>({nombre:s.product_name||'',cantidad:Number(s.cantidad||0),destinatario:s.cortesia_destinatario||''})),observacion:((obs||[]).find(o=>o.shift_id===sid)||{}).observacion||''};
  });
  // Panel "Ajustes del dia" solo para ADMIN (decision Ruben): el detalle NO viaja al
  // navegador de recepcion. OJO: turnosData[sid].ajusteRecepcion (arriba) SI se calcula
  // para todos los roles -> la S de recepcion sigue cuadrando; aca solo se oculta el detalle.
  const esAdminInv = String(p.userRole||'').toUpperCase()==='ADMIN';
  const ajustes=esAdminInv ? (ajustesDia||[]).map(function(a){return {
    tsMs:Number(a.ts_ms||0), productName:a.product_name||'', cantidad:Number(a.cantidad||0),
    tipo:a.tipo||'', categoria:a.categoria||'', motivo:a.motivo||'',
    quien:a.admin_name||a.recep_name||'', shiftId:a.shift_id||'',
    deltaStock:signoDeltaAjuste(a)
  };}) : [];
  return ok(res,{rows,resumenTurnos,businessDay:bd,ajustes});
}
// ==================== SNAPSHOT INMUTABLE DE INVENTARIO POR TURNO ====================
// Invocado SOLO al primer LOGIN de RECEPTION de cada (business_day, shift_id).
// ON CONFLICT DO NOTHING (vía ignoreDuplicates) garantiza que el snapshot original
// NUNCA se sobreescribe — ni por relogins, reintentos ni concurrencia.
// Inmutabilidad del turno aplicada a inventario inicial.
async function capturarSnapshotInventarioInicial(bDay, shiftId, userName, now) {
  try {
    // === DEFENSA: inmutabilidad del turno ===
    // Coherencia entre bDay y dia real Bogota segun naturaleza del turno.
    // - bDay en el futuro: SIEMPRE es bug (rechazar)
    // - bDay del pasado: solo legitimo en T3 nocturno cruzando medianoche
    //   (ej: T3 entra a la 1am del dia siguiente; bDay sigue siendo el de
    //   inicio del turno, dia real = bDay+1)
    // - Turnos diurnos (T1, T2, T1_12, T2_12, DC): bDay debe = dia real
    const diaRealBogota = new Date(now - 5*3600000).toISOString().slice(0,10);
    const difDias = (new Date(bDay).getTime() - new Date(diaRealBogota).getTime()) / 86400000;
    const esNocturno = String(shiftId||'').startsWith('SHIFT_3');
    const minDif = esNocturno ? -1 : 0;
    if(difDias > 0 || difDias < minDif) {
      console.error('[SNAPSHOT-RECHAZADO] bDay incoherente. bDay=' + bDay +
        ' diaReal=' + diaRealBogota + ' difDias=' + difDias +
        ' shift=' + shiftId + ' user=' + userName +
        ' (esperado: ' + (esNocturno ? '-1..0' : '0') + ')');
      return;
    }

    // === DEFENSA 2: hora coherente con turno noche (Nivel 1) ===
    // Un turno noche (SHIFT_3; incluye el 2T12 de domingo ya normalizado) solo
    // arranca en la tarde-noche. Si llega una foto de turno noche en horario
    // diurno (6:00am–4:59pm) es un login fantasma (ej: el relogin del T3 saliente
    // a las 6am). Se BLOQUEA la foto pero NO se interrumpe el login (solo return).
    if(esNocturno) {
      const horaBogota = new Date(now - 5*3600000).getUTCHours();
      if(horaBogota >= 6 && horaBogota < 17) {
        console.error('[SNAPSHOT-BLOQUEADO] foto de turno noche en horario diurno. ' +
          'bDay=' + bDay + ' shift=' + shiftId + ' horaBogota=' + horaBogota +
          ' user=' + userName + ' (turno noche arranca 6pm; rango bloqueado 6am-4:59pm)');
        return;
      }
    }
    const { data: products } = await tSelect('products', 'id, stock_actual').eq('activo', true);
    if(!products || !products.length) return;
    const rows = products.map(p => ({
      motel_id: MOTEL_ID,
      business_day: bDay,
      shift_id: shiftId,
      product_id: p.id,
      saldo_inicial: Number(p.stock_actual||0),
      ts_ms: now,
      created_by: userName || ''
    }));
    await supabase.from('shift_inventory_start')
      .upsert(rows, { onConflict: 'business_day,shift_id,product_id', ignoreDuplicates: true });
  } catch(e) {
    console.error('snapshot inventario fallo (fallback a formula):', e && e.message || e);
  }
}
async function apiIngresoBodega(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const nota = String(p.nota||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const {data:prod} = await tSelect('products','*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');
  const { data: nuevoBodega, error: stockErr } = await supabase.rpc('apply_stock_bodega_delta', { p_product_id: productId, p_delta: cantidad });
  if(stockErr) return err(res, stockErr.message);
  await tInsert('stock_movements',{
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_name:String(p.userName||''), user_role:userRole,
    product_id:productId, product_name:prod.nombre,
    tipo:'ingreso_bodega', cantidad, nota
  });
  return ok(res,{productId,nuevoBodega});
}

async function apiDevolverABodega(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const nota = String(p.nota||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const {data:prod} = await tSelect('products','*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_actual||0)<cantidad) return err(res,'No hay suficiente en recepción. Hay: '+prod.stock_actual);
  const { data: nuevoRecepcion, error: stockErrA } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: -cantidad });
  if(stockErrA) return err(res, stockErrA.message);
  const { data: nuevoBodega, error: stockErrB } = await supabase.rpc('apply_stock_bodega_delta', { p_product_id: productId, p_delta: cantidad });
  if(stockErrB) return err(res, stockErrB.message);
  await tInsert('stock_movements',{
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_name:String(p.userName||''), user_role:userRole,
    product_id:productId, product_name:prod.nombre,
    tipo:'devolucion_bodega', cantidad, nota
  });
  return ok(res,{productId,nuevoBodega,nuevoRecepcion});
}
async function apiTrasladoRecepcion(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const now = Date.now();
  const bDay = String(p.sessionBusinessDay||p.businessDay||'').trim() || businessDay(now);
  const shift = String(p.sessionShiftId||p.shiftId||'').trim() || currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const nota = String(p.nota||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const {data:prod} = await tSelect('products','*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_bodega||0)<cantidad) return err(res,'Stock en bodega insuficiente. Hay: '+prod.stock_bodega);
  const { data: nuevoBodega, error: stockErrA } = await supabase.rpc('apply_stock_bodega_delta', { p_product_id: productId, p_delta: -cantidad });
  if(stockErrA) return err(res, stockErrA.message);
  const { data: nuevoRecepcion, error: stockErrB } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: cantidad });
  if(stockErrB) return err(res, stockErrB.message);
  await tInsert('stock_movements',{
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_name:String(p.userName||''), user_role:userRole,
    product_id:productId, product_name:prod.nombre,
    tipo:'traslado_recepcion', cantidad, nota
  });
  return ok(res,{productId,nuevoBodega,nuevoRecepcion});
}
async function apiListGastosTurno(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  const businessDay_ = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  if(!businessDay_) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  const { data, error } = await tSelect('loans', '*')
    .eq('business_day', businessDay_)
    .eq('shift_id', shiftId)
    .order('ts_ms', {ascending:true});
  if(error) return err(res, error.message);
  return ok(res, {gastos: data||[]});
}
async function apiAgregarGastoManual(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN puede agregar gastos manuales');
  const businessDay_ = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  const borrowerName = String(p.borrowerName||'').trim();
  const amount = Number(p.amount||0);
  const note = String(p.note||'').trim();
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!businessDay_) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  if(!borrowerName) return err(res,'borrowerName requerido');
  if(amount<=0) return err(res,'Monto inválido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido (min 5 caracteres)');
  const now = Date.now();
  const { data, error } = await tInsert('loans',{
    ts_ms: now,
    business_day: businessDay_,
    shift_id: shiftId,
    user_name: userName,
    borrower_name: borrowerName,
    amount: amount,
    note: note,
    manual: true,
    motivo_manual: motivo,
    anulada: false
  }).select('id').single();
  if(error) return err(res,'Error guardando: '+error.message);
  return ok(res,{gastoId:data.id, amount});
}
async function apiEditarGastoModulo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const gastoId = Number(p.gastoId||0);
  const borrowerName = String(p.borrowerName||'').trim();
  const amount = Number(p.amount||0);
  const note = String(p.note||'').trim();
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!gastoId) return err(res,'gastoId requerido');
  if(!borrowerName) return err(res,'borrowerName requerido');
  if(amount<=0) return err(res,'Monto inválido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido (min 5 caracteres)');
  const now = Date.now();
  const { data: gasto, error: errGasto } = await tSelect('loans','*').eq('id', gastoId).maybeSingle();
  if(errGasto) return err(res, errGasto.message);
  if(!gasto) return err(res,'Gasto no encontrado');
  if(gasto.anulada) return err(res,'No se puede editar un gasto anulado');
  // Si ya fue editado antes, NO sobreescribir el amount_original
  const amountOriginal = gasto.amount_original!==null && gasto.amount_original!==undefined
    ? gasto.amount_original
    : gasto.amount;
  await tUpdate('loans',{
    borrower_name: borrowerName,
    amount: amount,
    note: note,
    editada: true,
    editada_ms: now,
    editada_por: userName,
    amount_original: amountOriginal,
    motivo_edicion: motivo
  }).eq('id', gastoId);
  return ok(res,{gastoId, amount});
}
async function apiAnularGastoModulo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const gastoId = Number(p.gastoId||0);
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!gastoId) return err(res,'gastoId requerido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido (min 5 caracteres)');
  const now = Date.now();
  const { data: gasto, error: errGasto } = await tSelect('loans','*').eq('id', gastoId).maybeSingle();
  if(errGasto) return err(res, errGasto.message);
  if(!gasto) return err(res,'Gasto no encontrado');
  if(gasto.anulada) return err(res,'Este gasto ya está anulado');
  await tUpdate('loans',{
    anulada: true,
    anulada_ms: now,
    anulada_por: userName,
    motivo_anulacion: motivo
  }).eq('id', gastoId);
  return ok(res,{gastoId, anulada:true});
}
async function apiAgregarVentaManual(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN puede agregar ventas manuales');
  const businessDay_ = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  const roomId = String(p.roomId||'').trim();
  const category = String(p.category||'').trim();
  const durationHrs = Number(p.durationHrs||0);
  const people = Number(p.people||0);
  const arrivalType = String(p.arrivalType||'WALK').trim();
  const arrivalPlate = String(p.arrivalPlate||'').trim();
  const horaIn = String(p.horaIn||'').trim();
  const horaOut = String(p.horaOut||'').trim();
  const total = Number(p.total||0);
  const payMethod = String(p.payMethod||'').trim();
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!businessDay_) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  if(!roomId) return err(res,'roomId requerido');
  if(!horaIn||!horaOut) return err(res,'horaIn y horaOut requeridas');
  if(total<=0) return err(res,'Total inválido');
  if(!payMethod) return err(res,'payMethod requerido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido (min 5 caracteres)');
  let amount_1=null, amount_2=null, amount_3=null, pay_method_2=null;
  if(payMethod==='MIXTO'){
    amount_1=Number(p.amount_1||0);
    amount_2=Number(p.amount_2||0);
    amount_3=Number(p.amount_3||0);
    if((amount_1+amount_2+amount_3)!==total) return err(res,'Suma del mixto debe ser igual al total');
    pay_method_2='MIXTO';
  }
  const dateBase = businessDay_;
  const checkInIso = dateBase+'T'+horaIn+':00-05:00';
  const checkOutIso = dateBase+'T'+horaOut+':00-05:00';
  let checkInMs = new Date(checkInIso).getTime();
  let dueMs = new Date(checkOutIso).getTime();
  if(dueMs<=checkInMs) dueMs += 24*60*60*1000;
  const now = Date.now();
  const included = (people>2)?2:people;
  const extraPeople = Math.max(0,people-included);
  const extraPeopleValue = extraPeople*20000;
  const noteFinal = '[MANUAL] '+motivo;
  const { data: inserted, error: errIns } = await tInsert('sales',{
    ts_ms: now,
    business_day: businessDay_,
    shift_id: shiftId,
    user_role: userRole,
    user_name: userName,
    type: 'SALE',
    room_id: roomId,
    category: category,
    duration_hrs: durationHrs,
    base_price: total - extraPeopleValue,
    people: people,
    included_people: included,
    extra_people: extraPeople,
    extra_people_value: extraPeopleValue,
    extra_hours: 0,
    extra_hours_value: 0,
    total: total,
    arrival_type: arrivalType,
    arrival_plate: arrivalPlate,
    pay_method: payMethod,
    pay_method_2: pay_method_2,
    amount_1: amount_1,
    amount_2: amount_2,
    amount_3: amount_3,
    paid_with: total,
    change_given: 0,
    check_in_ms: checkInMs,
    due_ms: dueMs,
    checkout_ms: dueMs,
    note: noteFinal,
    anulada: false
  }).select('id').single();
  if(errIns) return err(res, 'Error guardando venta: '+errIns.message);
  await tInsert('state_history',{
    ts_ms: now,
    business_day: businessDay_,
    shift_id: shiftId,
    user_role: userRole,
    user_name: userName,
    room_id: roomId,
    from_state: 'AJUSTE',
    to_state: 'VENTA_MANUAL',
    people: people,
    meta_json: JSON.stringify({
      accion:'VENTA_AGREGADA_MANUAL',
      saleId: inserted.id,
      motivo: motivo,
      total: total,
      pay_method: payMethod,
      duration_hrs: durationHrs,
      hora_in: horaIn,
      hora_out: horaOut
    })
  });
  return ok(res,{saleId:inserted.id, total});
}
async function apiAnularVentaModulo(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN') return err(res,'Sin permiso');
  const saleId = Number(p.saleId||0);
  const motivo = String(p.motivo||'').trim();
  const userName = String(p.userName||'').trim();
  if(!saleId) return err(res,'saleId requerido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido (min 5 caracteres)');
  const now = Date.now();
  const { data: sale, error: errSale } = await tSelect('sales','*').eq('id', saleId).maybeSingle();
  if(errSale) return err(res, errSale.message);
  if(!sale) return err(res,'Venta no encontrada');
  if(sale.anulada) return err(res,'Esta venta ya está anulada');
  const motivoFinal = '[AJUSTE-ANULACION] ' + motivo;
  await tUpdate('sales',{
    type:'ANULADA',
    note: motivoFinal,
    anulada: true,
    anulada_ms: now,
    anulada_por: userName
  }).eq('id', saleId);
  await tInsert('state_history',{
    ts_ms: now,
    business_day: sale.business_day,
    shift_id: sale.shift_id,
    user_role: userRole,
    user_name: userName,
    room_id: sale.room_id,
    from_state: 'AJUSTE',
    to_state: 'ANULADA',
    people: 0,
    meta_json: JSON.stringify({
      accion:'ANULADA_DESDE_AJUSTE',
      saleId: saleId,
      motivo: motivo,
      total_anulado: sale.total,
      pay_method: sale.pay_method,
      business_day_original: sale.business_day,
      shift_original: sale.shift_id
    })
  });
  return ok(res,{saleId, anulada:true});
}
async function apiAnularVenta(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN') return err(res,'Sin permiso');
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId||'').trim();
  const motivo = String(p.motivo||'').trim();
  const checkInMs = Number(p.checkInMs||0);
  const userName = String(p.userName||'').trim();
  const devolucionEfectivo = p.devolucionEfectivo === true;
  if(!roomId) return err(res,'roomId requerido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido');
  const room = await getRoom(roomId);
  if(!room) return err(res,'Habitacion no existe');
  if(room.state!=='OCCUPIED') return err(res,'Solo se puede anular si está ocupada');
  // Si es devolucion en efectivo, leer el metodo de pago original de la venta
  let metodoOriginal = null;
  if(devolucionEfectivo){
    const { data: ventaOriginal } = await tSelect('sales', 'pay_method')
      .eq('room_id',roomId)
      .eq('check_in_ms',checkInMs)
      .eq('type','SALE')
      .maybeSingle();
    if(!ventaOriginal) return err(res,'No se encontro venta original');
    const pm = String(ventaOriginal.pay_method||'').toUpperCase();
    if(pm !== 'TARJETA' && pm !== 'NEQUI') return err(res,'Devolucion en efectivo solo aplica si pago fue TARJETA o NEQUI');
    metodoOriginal = pm;
  }
  // Marcar todas las ventas de esta estadia como ANULADA (con o sin devolucion cruzada)
  const updateData = {
    type:'ANULADA',
    note:motivo,
    anulada:true,
    anulada_ms:now,
    anulada_por:userName,
    devolucion_efectivo: devolucionEfectivo,
    devolucion_metodo_original: metodoOriginal
  };
  // El .select() devuelve TODAS las ventas de la estadia que se anularon (habitacion +
  // extras). De ahi sacamos la de reserva, si la hubo (Pieza 6). No agrega una query.
  const { data: ventasAnuladas } = await tUpdate('sales',updateData)
    .eq('room_id',roomId).eq('check_in_ms',checkInMs)
    .select('id, reserva_id, origin, anulada');
  // Devolver habitacion a disponible
  await tUpdate('rooms',{
    state:'AVAILABLE', state_since_ms:now, people:0,
    due_ms:0, check_in_ms:0, last_checkout_ms:now,
    arrival_type:'', arrival_plate:'',
    alarm_silenced_ms:0, alarm_silenced_for_due_ms:0,
    checkout_obs:'ANULADA: '+motivo, pay_method:'',
    updated_at:new Date().toISOString()
  }).eq('room_id',roomId);
  // Registrar en historial
  await tInsert('state_history',{
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_role:userRole, user_name:userName, room_id:roomId,
    from_state:'OCCUPIED', to_state:'AVAILABLE', people:0,
    meta_json:JSON.stringify({accion:'ANULADA',motivo,checkInMs,userName})
  });

  // Pieza 6: la anulacion NO pasa por apiCheckOut, asi que sin esto el cliente se quedaria
  // en la pantalla persistente para siempre. Se escribe salida_ms (sale de la pantalla) pero
  // SIN ficha: no se le pide calificar una estadia que se anulo. NO bloqueante.
  try {
    const ventaReserva = (ventasAnuladas||[]).find(v => String(v.origin||'')==='WOMPI' && v.reserva_id);
    await cerrarEstadiaReserva({ venta: ventaReserva, now, userName, crearFicha: false });
  } catch (e) {
    console.error('apiAnularVenta cierre de reserva (no bloqueante):', e);
  }

  return ok(res,{roomId,anulada:true});
}
async function apiSaveRoomBarcode(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const roomId = String(p.roomId||'').trim();
  const barcode = String(p.barcode||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  if(!barcode) return err(res,'barcode requerido');
  await tUpdate('rooms',{ barcode }).eq('room_id', roomId);
  return ok(res, { roomId, barcode });
}
// ==================== AJUSTE DE INVENTARIO (ADMIN) ====================
// Gestiona ajustes de stock del bar con 3 tipos:
//  - venta_olvidada: Descuenta stock + suma al cuadre (recep olvidó registrar)
//  - faltante_cobrado: Descuenta stock + suma al cuadre (alguien paga el faltante)
//  - ajuste_sin_dinero: Solo ajusta stock (rotura, vencido, sobrante, conteo)
async function apiAjusteInventario(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const now = Date.now();
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const tipo = String(p.tipoAjuste||'').trim();
  const motivo = String(p.motivo||'').trim();
  const adminName = String(p.userName||'').trim();

  if(!productId) return err(res,'productId requerido');
  if(!cantidad || cantidad === 0) return err(res,'Cantidad invalida');
  if(!['venta_olvidada','faltante_cobrado','ajuste_sin_dinero'].includes(tipo)) return err(res,'Tipo de ajuste invalido');
  if(motivo.length < 3) return err(res,'Motivo requerido (minimo 3 caracteres)');
  if(!adminName) return err(res,'Admin requerido');

  const afectaCuadre = (tipo === 'venta_olvidada' || tipo === 'faltante_cobrado');
  const bDayAjuste = afectaCuadre ? String(p.businessDay||'').trim() : businessDay(now);
  const shiftAjuste = afectaCuadre ? String(p.shiftId||'').trim() : currentShiftId(now);
  const payMethodAjuste = afectaCuadre ? String(p.payMethod||'EFECTIVO').toUpperCase() : '';
  const recepNameAjuste = afectaCuadre ? String(p.recepName||'').trim() : '';

  if(afectaCuadre) {
    if(!bDayAjuste) return err(res,'Fecha del turno requerida');
    if(!['SHIFT_1','SHIFT_2','SHIFT_3'].includes(shiftAjuste)) return err(res,'Turno invalido');
    if(!['EFECTIVO','TARJETA','NEQUI'].includes(payMethodAjuste)) return err(res,'Metodo de pago invalido');
    if(cantidad <= 0) return err(res,'Cantidad debe ser positiva en venta olvidada/faltante');
  }

  const { data: prod } = await tSelect('products','*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');

  const vaDescontar = (cantidad > 0);
  if(vaDescontar && Number(prod.stock_actual||0) < cantidad) {
    return err(res,'Stock insuficiente. Hay '+prod.stock_actual+' unidades');
  }

  const { data: nuevoStock, error: stockErr } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: -cantidad });
  if(stockErr) return err(res, stockErr.message);

  await tInsert('stock_movements',{
    ts_ms: now, business_day: bDayAjuste, shift_id: shiftAjuste,
    user_name: adminName, user_role: 'ADMIN',
    product_id: productId, product_name: prod.nombre,
    tipo: 'ajuste_'+tipo,
    cantidad: cantidad,
    nota: motivo
  });

  if(afectaCuadre) {
    const precioUnit = Number(prod.precio||0);
    const total = precioUnit * cantidad;
    await tInsert('room_products',{
      ts_ms: now, business_day: bDayAjuste, shift_id: shiftAjuste,
      room_id: 'AJUSTE', check_in_ms: 0,
      product_id: productId, product_name: prod.nombre,
      cantidad: cantidad, precio_unit: precioUnit,
      total: total, pay_method: payMethodAjuste,
      user_name: recepNameAjuste || adminName,
      is_cortesia: false,
      created_by_admin: true,
      tipo_ajuste: tipo,
      motivo_ajuste: motivo
    });
  }

  return ok(res, { productId, nuevoStock, tipo, afectaCuadre });
}
// ==================== IMPRESION DE TURNO (RECIBO TERMICO) ====================
// Devuelve los datos consolidados por producto + método de pago para imprimir
async function apiGetPrintTurno(p, res) {
  const bd = String(p.businessDay || businessDay(Date.now()));
  const sid = String(p.shiftId || '').trim();
  if(!['SHIFT_1','SHIFT_2','SHIFT_3'].includes(sid)) return err(res,'Turno invalido');

  const { data: products } = await tSelect('products','*').eq('activo',true).order('categoria').order('nombre');
  if(!products || !products.length) return ok(res,{rows:[],totals:{},cortesias:[],businessDay:bd,shiftId:sid});

  const { data: salesDay } = await tSelect('room_products','*').eq('business_day',bd);
  const { data: movements } = await tSelect('stock_movements','*').eq('business_day',bd);
  const { data: entries } = await tSelect('stock_entries','*').eq('business_day',bd);
  const { data: snapsRows } = await tSelect('shift_inventory_start','shift_id,product_id,saldo_inicial').eq('business_day',bd);
  const snaps = {}; (snapsRows||[]).forEach(s=>{ if(!snaps[s.shift_id]) snaps[s.shift_id]={}; snaps[s.shift_id][s.product_id]=Number(s.saldo_inicial); });

  const salesShift = (salesDay||[]).filter(s => s.shift_id === sid);

  const { data: shiftLog } = await tSelect('shift_log', 'user_name').eq('business_day',bd).eq('shift_id',sid)
    .eq('user_role','RECEPTION').in('action',['LOGIN','RELOGIN'])
    .order('ts_ms').limit(1);
  const recepName = shiftLog && shiftLog.length ? shiftLog[0].user_name : '—';

  const SHIFTS = ['SHIFT_1','SHIFT_2','SHIFT_3'];
  const shiftIdx = SHIFTS.indexOf(sid);

  const rows = products.map(function(prod){
    const entTurno = (movements||[])
      .filter(m => m.product_id === prod.id && m.shift_id === sid && m.tipo === 'traslado_recepcion')
      .reduce((a,m) => a + Number(m.cantidad||0), 0);

    const ventasT = salesShift.filter(s => s.product_id === prod.id && !s.is_cortesia);
    const efT = ventasT.filter(s => s.pay_method === 'EFECTIVO').reduce((a,s) => a + Number(s.cantidad||0), 0);
    const taT = ventasT.filter(s => s.pay_method === 'TARJETA').reduce((a,s) => a + Number(s.cantidad||0), 0);
    const nqT = ventasT.filter(s => s.pay_method === 'NEQUI').reduce((a,s) => a + Number(s.cantidad||0), 0);
    const corItems = salesShift.filter(s => s.product_id === prod.id && s.is_cortesia);
    const corT = corItems.reduce((a,s) => a + Number(s.cantidad||0), 0);

    const vendidasT = efT + taT + nqT;
    const valorT = ventasT.reduce((a,s) => a + Number(s.total||0), 0);

    const totalVentasDia = (salesDay||[]).filter(s => s.product_id === prod.id && !s.is_cortesia).reduce((a,s) => a + Number(s.cantidad||0), 0);
    const totalCortesiasDia = (salesDay||[]).filter(s => s.product_id === prod.id && s.is_cortesia).reduce((a,s) => a + Number(s.cantidad||0), 0);
    const totalTrasladosDia = (movements||[]).filter(m => m.product_id === prod.id && m.tipo === 'traslado_recepcion').reduce((a,m) => a + Number(m.cantidad||0), 0);
    const totalEntradasDia = (entries||[]).filter(e => e.product_id === prod.id).reduce((a,e) => a + Number(e.cantidad||0), 0);
    const snapT1 = (snaps['SHIFT_1']||{})[prod.id];
    const saldoInicialDia = (snapT1 != null)
      ? snapT1
      : (Number(prod.stock_actual||0) + totalVentasDia + totalCortesiasDia - totalTrasladosDia - totalEntradasDia);

    let saldoTurno = saldoInicialDia;
    let saldoInicialTurno = saldoInicialDia;
    for(let i = 0; i <= shiftIdx; i++) {
      // Si hay snapshot del turno i, anclar saldoTurno al valor congelado (inmutable por turno).
      const snapI = (snaps[SHIFTS[i]]||{})[prod.id];
      if(snapI != null) saldoTurno = snapI;
      if(i === shiftIdx) saldoInicialTurno = saldoTurno;
      const s = SHIFTS[i];
      const entsUntil = (movements||[]).filter(m => m.product_id === prod.id && m.shift_id === s && m.tipo === 'traslado_recepcion').reduce((a,m) => a + Number(m.cantidad||0), 0);
      const venUntil = (salesDay||[]).filter(x => x.product_id === prod.id && x.shift_id === s && !x.is_cortesia).reduce((a,x) => a + Number(x.cantidad||0), 0);
      const corUntil = (salesDay||[]).filter(x => x.product_id === prod.id && x.shift_id === s && x.is_cortesia).reduce((a,x) => a + Number(x.cantidad||0), 0);
      // Ajuste por conteo de recepcion del turno: mueve stock_actual sin dejar venta,
      // asi que la S del papel quedaba vieja (bug). Se suma igual que en renderInventario
      // (papel == pantalla). Fuente: recepcion_conteo (ya cargado en movements), SIN corte
      // de fecha para coincidir con la pantalla (la tabla `ajustes` guarda la misma cantidad).
      const conteoUntil = (movements||[]).filter(m => m.product_id === prod.id && m.shift_id === s && m.tipo === 'recepcion_conteo').reduce((a,m) => a + Number(m.cantidad||0), 0);
      saldoTurno = saldoTurno + entsUntil + conteoUntil - venUntil - corUntil;
    }

    return {
      id: prod.id,
      nombre: prod.nombre,
      categoria: prod.categoria || 'Sin categoría',
      precio: Number(prod.precio||0),
      entrada: entTurno,
      efectivo: efT,
      tarjeta: taT,
      nequi: nqT,
      cortesia: corT,
      vendidas: vendidasT,
      saldoInicial: saldoInicialTurno,
      saldo: saldoTurno,
      valor: valorT
    };
  });

  const rowsFiltradas = rows.filter(r =>
    r.entrada > 0 || r.efectivo > 0 || r.tarjeta > 0 || r.nequi > 0 || r.cortesia > 0 || r.saldo !== 0
  );

  const gruposMap = {};
  rows.forEach(r => {
    if(!gruposMap[r.categoria]) gruposMap[r.categoria] = 0;
    gruposMap[r.categoria] += r.saldo;
  });
  rowsFiltradas.forEach(r => { r.grupoTotal = gruposMap[r.categoria] || 0; });

  const cortesias = salesShift
    .filter(s => s.is_cortesia)
    .map(s => ({
      nombre: s.product_name || '',
      cantidad: Number(s.cantidad||0),
      destinatario: s.cortesia_destinatario || ''
    }));

  const totalEf = salesShift.filter(s => !s.is_cortesia && s.pay_method === 'EFECTIVO').reduce((a,s) => a + Number(s.total||0), 0);
  const totalTa = salesShift.filter(s => !s.is_cortesia && s.pay_method === 'TARJETA').reduce((a,s) => a + Number(s.total||0), 0);
  const totalNq = salesShift.filter(s => !s.is_cortesia && s.pay_method === 'NEQUI').reduce((a,s) => a + Number(s.total||0), 0);

  return ok(res, {
    businessDay: bd,
    shiftId: sid,
    recepName: recepName,
    rows: rowsFiltradas,
    cortesias: cortesias,
    totals: {
      efectivo: totalEf,
      tarjeta: totalTa,
      nequi: totalNq,
      total: totalEf + totalTa + totalNq
    }
  });
}

// ==================== GET AÑO ANTERIOR ====================
// Lee los datos guardados de un año anterior (los 12 meses con ventas y gastos)
async function apiGetAnoAnterior(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const ano = Number(p.ano||0);
  if(!ano || ano < 2020 || ano > 2100) return err(res,'Ano invalido');
  const { data, error } = await tSelect('ventas_gastos_anuales', '*')
    .eq('ano', ano)
    .maybeSingle();
  if(error) return err(res, error.message);
  if(!data){
    // No existe, devolver estructura vacia
    return ok(res, { ano: ano, existe: false, datos: null });
  }
  return ok(res, { ano: ano, existe: true, datos: data });
}

// ==================== SAVE AÑO ANTERIOR ====================
// Guarda los 12 totales del año anterior (ventas + gastos por mes)
async function apiSaveAnoAnterior(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const ano = Number(p.ano||0);
  if(!ano || ano < 2020 || ano > 2100) return err(res,'Ano invalido');

  // Validar que vienen los 24 valores (12 ventas + 12 gastos)
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const datos = { ano: ano, edited_ms: Date.now(), edited_by: userName };
  meses.forEach(m => {
    const vKey = `ventas_${m}`;
    const gKey = `gastos_${m}`;
    datos[vKey] = Number(p[vKey]||0);
    datos[gKey] = Number(p[gKey]||0);
    if(datos[vKey] < 0) datos[vKey] = 0;
    if(datos[gKey] < 0) datos[gKey] = 0;
  });

  // Verificar si ya existe el ano
  const { data: existe } = await tSelect('ventas_gastos_anuales', 'id')
    .eq('ano', ano)
    .maybeSingle();

  let result;
  if(existe){
    // Actualizar
    result = await tUpdate('ventas_gastos_anuales', datos)
      .eq('ano', ano);
  } else {
    // Crear nuevo
    result = await tInsert('ventas_gastos_anuales', datos);
  }
  if(result.error) return err(res, result.error.message);
  return ok(res, { ano: ano, guardado: true });
}

// ==================== GRAFICA DIA A DIA ====================
// Devuelve datos del mes actual + mes anterior dia por dia (ventas y gastos)
async function apiGetGraficaDiaADia(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const mes = String(p.mes || '').trim();
  if(!/^\d{4}-\d{2}$/.test(mes)) return err(res,'Mes invalido (formato YYYY-MM)');

  const [yearStr, monthStr] = mes.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  
  // Calcular mes anterior
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const mesAnterior = `${prevYear}-${String(prevMonth).padStart(2,'0')}`;

  const firstDayActual = `${mes}-01`;
  const lastDayActualDate = new Date(year, month, 0);
  const lastDayActual = `${mes}-${String(lastDayActualDate.getDate()).padStart(2,'0')}`;
  const diasActual = lastDayActualDate.getDate();

  const firstDayAnterior = `${mesAnterior}-01`;
  const lastDayAnteriorDate = new Date(prevYear, prevMonth, 0);
  const lastDayAnterior = `${mesAnterior}-${String(lastDayAnteriorDate.getDate()).padStart(2,'0')}`;
  const diasAnterior = lastDayAnteriorDate.getDate();

  // Hoy (para limitar dias del mes actual)
  const hoy = new Date();
  const hoyYear = hoy.getFullYear();
  const hoyMonth = hoy.getMonth() + 1;
  const hoyDay = hoy.getDate();
  const esActualMes = (year === hoyYear && month === hoyMonth);
  const ultimoDiaActual = esActualMes ? hoyDay : diasActual;

  // 1. Ventas mes actual
  const ventasActual = await fetchAll(() => tSelect('sales', 'business_day, total, type, anulada')
    .gte('business_day', firstDayActual)
    .lte('business_day', lastDayActual)
    .in('type', ['SALE','RENEWAL','EXTENSION','REFUND'])
    .neq('anulada', true));

  // 1b. Ventas del bar mes actual
  const ventasBarActual = await fetchAll(() => tSelect('room_products', 'business_day, total, is_cortesia')
    .gte('business_day', firstDayActual)
    .lte('business_day', lastDayActual));

  // 2. Ventas mes anterior
  const ventasAnterior = await fetchAll(() => tSelect('sales', 'business_day, total, type, anulada')
    .gte('business_day', firstDayAnterior)
    .lte('business_day', lastDayAnterior)
    .in('type', ['SALE','RENEWAL','EXTENSION','REFUND'])
    .neq('anulada', true));

  // 2b. Ventas del bar mes anterior
  const ventasBarAnterior = await fetchAll(() => tSelect('room_products', 'business_day, total, is_cortesia')
    .gte('business_day', firstDayAnterior)
    .lte('business_day', lastDayAnterior));

  // 2c. Ventas diarias MANUALES del mes actual (override)
  const { data: manualActual } = await tSelect('ventas_diarias_manuales', 'fecha, total_ventas')
    .eq('mes', mes);

  // 2d. Ventas diarias MANUALES del mes anterior (override)
  const { data: manualAnterior } = await tSelect('ventas_diarias_manuales', 'fecha, total_ventas')
    .eq('mes', mesAnterior);

// 3. Gastos del mes actual (de gastos_mes)
  const { data: gastosActual } = await tSelect('gastos_mes', 'fecha, monto, anulada')
    .eq('mes', mes)
    .neq('anulada', true);

  // 3b. GASTOS DEL CUADRE del mes actual (general + taxi + turnos + loans manuales)
  // Estos se descuentan del calculo automatico (no se suman como gastos_mes)
  const [gralAct, taxiAct, extraAct, loansAct] = await Promise.all([
    tSelect('general_expenses','amount, business_day').gte('business_day', firstDayActual).lte('business_day', lastDayActual),
    tSelect('taxi_expenses','amount, business_day').eq('anulada', false).gte('business_day', firstDayActual).lte('business_day', lastDayActual),
    tSelect('extra_staff','payment, business_day').eq('anulada', false).gte('business_day', firstDayActual).lte('business_day', lastDayActual),
    tSelect('loans','amount, business_day').gte('business_day', firstDayActual).lte('business_day', lastDayActual).eq('manual', true).eq('anulada', false)
  ]);

  // 3c. GASTOS DEL CUADRE del mes anterior
  const [gralAnt, taxiAnt, extraAnt, loansAnt] = await Promise.all([
    tSelect('general_expenses','amount, business_day').gte('business_day', firstDayAnterior).lte('business_day', lastDayAnterior),
    tSelect('taxi_expenses','amount, business_day').eq('anulada', false).gte('business_day', firstDayAnterior).lte('business_day', lastDayAnterior),
    tSelect('extra_staff','payment, business_day').eq('anulada', false).gte('business_day', firstDayAnterior).lte('business_day', lastDayAnterior),
    tSelect('loans','amount, business_day').gte('business_day', firstDayAnterior).lte('business_day', lastDayAnterior).eq('manual', true).eq('anulada', false)
  ]);

  // Agrupar gastos del cuadre POR DIA (mes actual)
  const gastosCuadreDiaActual = {};
  (gralAct.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaActual[d] = (gastosCuadreDiaActual[d]||0) + Number(r.amount||0);
  });
  (taxiAct.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaActual[d] = (gastosCuadreDiaActual[d]||0) + Number(r.amount||0);
  });
  (extraAct.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaActual[d] = (gastosCuadreDiaActual[d]||0) + Number(r.payment||0);
  });
  (loansAct.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaActual[d] = (gastosCuadreDiaActual[d]||0) + Number(r.amount||0);
  });

  // Agrupar gastos del cuadre POR DIA (mes anterior)
  const gastosCuadreDiaAnterior = {};
  (gralAnt.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaAnterior[d] = (gastosCuadreDiaAnterior[d]||0) + Number(r.amount||0);
  });
  (taxiAnt.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaAnterior[d] = (gastosCuadreDiaAnterior[d]||0) + Number(r.amount||0);
  });
  (extraAnt.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaAnterior[d] = (gastosCuadreDiaAnterior[d]||0) + Number(r.payment||0);
  });
  (loansAnt.data||[]).forEach(r => {
    const d = r.business_day;
    gastosCuadreDiaAnterior[d] = (gastosCuadreDiaAnterior[d]||0) + Number(r.amount||0);
  });

  // Agrupar por dia
  const datosActual = {};
  const datosAnterior = {};
  const gastosDia = {};
  for(let d=1; d<=diasActual; d++){
    const fecha = `${mes}-${String(d).padStart(2,'0')}`;
    datosActual[fecha] = 0;
    gastosDia[fecha] = 0;
  }
  for(let d=1; d<=diasAnterior; d++){
    const fecha = `${mesAnterior}-${String(d).padStart(2,'0')}`;
    datosAnterior[fecha] = 0;
  }

  (ventasActual||[]).forEach(v => {
    if(v.anulada) return;
    if(datosActual[v.business_day] !== undefined){
      datosActual[v.business_day] += Number(v.total||0);
    }
  });
 // Sumar ventas del bar al mes actual
  (ventasBarActual||[]).forEach(v => {
    if(v.is_cortesia) return; // Cortesias no suman
    const total = Number(v.total||0);
    // incluye ajustes negativos (total<=0): netean ventas de bar mal cargadas
    if(datosActual[v.business_day] !== undefined){
      datosActual[v.business_day] += total;
    }
  });

  // ===== RETIROS DEL DUENO (AHORRO SILENCIOSO) =====
  // Restar retiros activos del mes actual (regla de oro - grafica dia a dia)
  const { data: retirosGDDActual } = await tSelect('retiros_dueno', 'dia_origen, monto, anulado')
    .gte('dia_origen', firstDayActual)
    .lte('dia_origen', lastDayActual)
    .eq('anulado', false);
  (retirosGDDActual||[]).forEach(r => {
    const dia = r.dia_origen;
    const monto = Number(r.monto||0);
    if(datosActual[dia] !== undefined){
      datosActual[dia] -= monto;
    }
  });

  // Restar retiros activos del mes anterior tambien (para comparacion justa)
  const { data: retirosGDDAnterior } = await tSelect('retiros_dueno', 'dia_origen, monto, anulado')
    .gte('dia_origen', firstDayAnterior)
    .lte('dia_origen', lastDayAnterior)
    .eq('anulado', false);
  (retirosGDDAnterior||[]).forEach(r => {
    const dia = r.dia_origen;
    const monto = Number(r.monto||0);
    if(datosAnterior[dia] !== undefined){
      datosAnterior[dia] -= monto;
    }
  });

  // RESTAR gastos del cuadre del mes actual (esa plata ya se pago en el turno)
  // IMPORTANTE: esto se hace ANTES del override manual. Si hay manual, lo sobrescribe igual.
  Object.keys(gastosCuadreDiaActual).forEach(fecha => {
    if(datosActual[fecha] !== undefined){
      datosActual[fecha] -= Number(gastosCuadreDiaActual[fecha]||0);
    }
  });
  // OVERRIDE: si hay valores manuales para el mes actual, sobrescribir el calculado
  (manualActual||[]).forEach(m => {
    const fechaStr = String(m.fecha);
    if(datosActual[fechaStr] !== undefined){
      datosActual[fechaStr] = Number(m.total_ventas||0);
    }
  });
  (ventasAnterior||[]).forEach(v => {
    if(v.anulada) return;
    if(datosAnterior[v.business_day] !== undefined){
      datosAnterior[v.business_day] += Number(v.total||0);
    }
  });
  // Sumar ventas del bar al mes anterior
  (ventasBarAnterior||[]).forEach(v => {
    if(v.is_cortesia) return; // Cortesias no suman
    const total = Number(v.total||0);
    // incluye ajustes negativos (total<=0): netean ventas de bar mal cargadas
    if(datosAnterior[v.business_day] !== undefined){
      datosAnterior[v.business_day] += total;
    }
  });
  // OVERRIDE: si hay valores manuales para el mes anterior, sobrescribir el calculado
  (manualAnterior||[]).forEach(m => {
    const fechaStr = String(m.fecha);
    if(datosAnterior[fechaStr] !== undefined){
      datosAnterior[fechaStr] = Number(m.total_ventas||0);
    }
  });
  (gastosActual||[]).forEach(g => {
    if(g.anulada) return;
    if(gastosDia[g.fecha] !== undefined){
      gastosDia[g.fecha] += Number(g.monto||0);
    }
  });

  // Convertir a arrays alineados por dia (1, 2, 3, ..., 31)
  const labels = [];
  const seriesActual = [];
  const seriesAnterior = [];
  const seriesGastos = [];
  const maxDias = Math.max(diasActual, diasAnterior);
  for(let d=1; d<=maxDias; d++){
    labels.push(d);
    const fechaActual = `${mes}-${String(d).padStart(2,'0')}`;
    const fechaAnterior = `${mesAnterior}-${String(d).padStart(2,'0')}`;
    seriesActual.push(d <= diasActual ? (datosActual[fechaActual]||0) : null);
    seriesAnterior.push(d <= diasAnterior ? (datosAnterior[fechaAnterior]||0) : null);
    seriesGastos.push(d <= diasActual ? (gastosDia[fechaActual]||0) : null);
  }

  // Calcular totales "a la fecha" (hasta hoyDay si es mes actual, sino mes completo)
  let totalActualHastaFecha = 0;
  let totalAnteriorHastaFecha = 0;
  let gastosActualHastaFecha = 0;
  let gastosAnteriorHastaFecha = 0;

  for(let d=1; d<=ultimoDiaActual; d++){
    const fechaActual = `${mes}-${String(d).padStart(2,'0')}`;
    const fechaAnterior = `${mesAnterior}-${String(d).padStart(2,'0')}`;
    totalActualHastaFecha += datosActual[fechaActual]||0;
    if(d <= diasAnterior) totalAnteriorHastaFecha += datosAnterior[fechaAnterior]||0;
    gastosActualHastaFecha += gastosDia[fechaActual]||0;
  }

  // Gastos mes anterior hasta misma fecha
  const { data: gastosAnteriorRaw } = await tSelect('gastos_mes', 'fecha, monto, anulada')
    .eq('mes', mesAnterior)
    .neq('anulada', true);
  (gastosAnteriorRaw||[]).forEach(g => {
    if(g.anulada) return;
    const dia = Number(g.fecha.split('-')[2]);
    if(dia <= ultimoDiaActual){
      gastosAnteriorHastaFecha += Number(g.monto||0);
    }
  });

  // Mejor dia, peor dia, promedio
  let mejorDia = { dia: '—', total: 0 };
  let peorDia = { dia: '—', total: Infinity };
  let suma = 0;
  let cuenta = 0;
  for(let d=1; d<=ultimoDiaActual; d++){
    const fecha = `${mes}-${String(d).padStart(2,'0')}`;
    const v = datosActual[fecha]||0;
    if(v > 0){
      suma += v;
      cuenta++;
      if(v > mejorDia.total) mejorDia = { dia: d, total: v };
      if(v < peorDia.total) peorDia = { dia: d, total: v };
    }
  }
  if(cuenta === 0) peorDia = { dia: '—', total: 0 };
  const promedio = cuenta > 0 ? Math.round(suma/cuenta) : 0;

  return ok(res, {
    mes: mes,
    mesAnterior: mesAnterior,
    labels: labels,
    seriesActual: seriesActual,
    seriesAnterior: seriesAnterior,
    seriesGastos: seriesGastos,
    ultimoDiaActual: ultimoDiaActual,
    aLaFecha: {
      ventasActual: totalActualHastaFecha,
      ventasAnterior: totalAnteriorHastaFecha,
      diferenciaVentas: totalActualHastaFecha - totalAnteriorHastaFecha,
      pctVentas: totalAnteriorHastaFecha > 0 ? Math.round(((totalActualHastaFecha - totalAnteriorHastaFecha) / totalAnteriorHastaFecha) * 1000) / 10 : 0,
      gastosActual: gastosActualHastaFecha,
      gastosAnterior: gastosAnteriorHastaFecha,
      diferenciaGastos: gastosActualHastaFecha - gastosAnteriorHastaFecha,
      pctGastos: gastosAnteriorHastaFecha > 0 ? Math.round(((gastosActualHastaFecha - gastosAnteriorHastaFecha) / gastosAnteriorHastaFecha) * 1000) / 10 : 0
    },
    minicards: {
      mejorDia: mejorDia,
      peorDia: peorDia,
      promedio: promedio
    }
  });
}

// ==================== GRAFICA AÑO A AÑO ====================
// Devuelve datos de los 12 meses del año actual + 12 meses del año anterior
async function apiGetGraficaAnoAno(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const ano = Number(p.ano||0);
  if(!ano || ano < 2020 || ano > 2100) return err(res,'Ano invalido');

  const anoAnterior = ano - 1;
  const firstDay = `${ano}-01-01`;
  const lastDay = `${ano}-12-31`;
// 1. Ventas y gastos del año actual (calculados desde sales, room_products y gastos_mes)
  const ventasActual = await fetchAll(() => tSelect('sales', 'business_day, total, type, anulada')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .in('type', ['SALE','RENEWAL','EXTENSION','REFUND'])
    .neq('anulada', true));

  // 1b. Ventas del bar (room_products) del año actual
  const ventasBarActual = await fetchAll(() => tSelect('room_products', 'business_day, total, is_cortesia')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay));

  const { data: gastosActual } = await tSelect('gastos_mes', 'mes, monto, anulada')
    .gte('mes', `${ano}-01`)
    .lte('mes', `${ano}-12`)
    .neq('anulada', true);

  // Agrupar por mes (1-12)
  const ventasPorMes = [0,0,0,0,0,0,0,0,0,0,0,0];
  const gastosPorMes = [0,0,0,0,0,0,0,0,0,0,0,0];
  
  (ventasActual||[]).forEach(v => {
    if(v.anulada) return;
    const m = Number(v.business_day.split('-')[1]) - 1;
    if(m >= 0 && m <= 11) ventasPorMes[m] += Number(v.total||0);
  });
  // Sumar ventas del bar al mes correspondiente
  (ventasBarActual||[]).forEach(v => {
    if(v.is_cortesia) return; // Cortesias no suman
    const total = Number(v.total||0);
    // incluye ajustes negativos (total<=0): netean ventas de bar mal cargadas
    const m = Number(v.business_day.split('-')[1]) - 1;
    if(m >= 0 && m <= 11) ventasPorMes[m] += total;
  });

  // ===== RETIROS DEL DUENO (AHORRO SILENCIOSO) =====
  // Restar retiros activos del año (regla de oro - grafica año a año)
  const { data: retirosGAA } = await tSelect('retiros_dueno', 'dia_origen, monto, anulado')
    .gte('dia_origen', firstDay)
    .lte('dia_origen', lastDay)
    .eq('anulado', false);
  (retirosGAA||[]).forEach(r => {
    const monto = Number(r.monto||0);
    const m = Number(r.dia_origen.split('-')[1]) - 1;
    if(m >= 0 && m <= 11) ventasPorMes[m] -= monto;
  });

  (gastosActual||[]).forEach(g => {
    if(g.anulada) return;
    const m = Number(g.mes.split('-')[1]) - 1;
    if(m >= 0 && m <= 11) gastosPorMes[m] += Number(g.monto||0);
  });

  // Hoy: hasta qué mes mostrar el año actual
  const hoy = new Date();
  const hoyYear = hoy.getFullYear();
  const hoyMonth = hoy.getMonth() + 1;
  const ultimoMes = (ano === hoyYear) ? hoyMonth : 12;

  // 2. Año anterior (de la tabla ventas_gastos_anuales)
  const { data: anoAnt } = await tSelect('ventas_gastos_anuales', '*')
    .eq('ano', anoAnterior)
    .maybeSingle();

  // 2b. Año actual MANUAL (override de meses pasados — totales mensuales)
  const { data: anoActualManual } = await tSelect('ventas_gastos_anuales', '*')
    .eq('ano', ano)
    .maybeSingle();

  // 2c. Ventas diarias MANUALES del año actual (override mas preciso)
  const { data: ventasDiariasManuales } = await tSelect('ventas_diarias_manuales', 'mes, total_ventas')
    .gte('mes', `${ano}-01`)
    .lte('mes', `${ano}-12`);

  // Si hay valores manuales del año actual (por mes total), sobrescribir el calculado
  const mesesKey = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  if(anoActualManual){
    mesesKey.forEach((m, i) => {
      const ventaManual = Number(anoActualManual[`ventas_${m}`]||0);
      const gastoManual = Number(anoActualManual[`gastos_${m}`]||0);
      // Solo sobrescribir si el manual tiene valor (>0)
      if(ventaManual > 0) ventasPorMes[i] = ventaManual;
      if(gastoManual > 0) gastosPorMes[i] = gastoManual;
    });
  }

  // Override mas preciso: sumar ventas diarias manuales por mes
  if(ventasDiariasManuales && ventasDiariasManuales.length > 0){
    const ventasManualesPorMes = [0,0,0,0,0,0,0,0,0,0,0,0];
    ventasDiariasManuales.forEach(d => {
      const mesNum = Number(String(d.mes).split('-')[1]) - 1;
      if(mesNum >= 0 && mesNum <= 11){
        ventasManualesPorMes[mesNum] += Number(d.total_ventas||0);
      }
    });
    // Aplicar override solo si hay valor
    ventasManualesPorMes.forEach((total, i) => {
      if(total > 0) ventasPorMes[i] = total;
    });
  }

  // Poner null en meses futuros del año actual (DESPUES del override)
  const ventasActualFinal = ventasPorMes.map((v, i) => i < ultimoMes ? v : null);
  const gastosActualFinal = gastosPorMes.map((v, i) => i < ultimoMes ? v : null);

  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const ventasAnterior = meses.map(m => Number(anoAnt ? (anoAnt[`ventas_${m}`]||0) : 0));
  const gastosAnterior = meses.map(m => Number(anoAnt ? (anoAnt[`gastos_${m}`]||0) : 0));

  // Acumulados a la fecha (hasta ultimoMes)
  let ventasActualAcum = 0;
  let ventasAnteriorAcum = 0;
  let gastosActualAcum = 0;
  let gastosAnteriorAcum = 0;
  for(let i=0; i<ultimoMes; i++){
    ventasActualAcum += ventasPorMes[i]||0;
    ventasAnteriorAcum += ventasAnterior[i]||0;
    gastosActualAcum += gastosPorMes[i]||0;
    gastosAnteriorAcum += gastosAnterior[i]||0;
  }

  // Mejor mes del año actual
  let mejorMes = { mes: '—', total: 0 };
  for(let i=0; i<ultimoMes; i++){
    if(ventasPorMes[i] > mejorMes.total){
      mejorMes = { mes: i+1, total: ventasPorMes[i] };
    }
  }

  return ok(res, {
    ano: ano,
    anoAnterior: anoAnterior,
    ultimoMes: ultimoMes,
    seriesVentasActual: ventasActualFinal,
    seriesVentasAnterior: ventasAnterior,
    seriesGastosActual: gastosActualFinal,
    seriesGastosAnterior: gastosAnterior,
    acumulados: {
      ventasActual: ventasActualAcum,
      ventasAnterior: ventasAnteriorAcum,
      diferenciaVentas: ventasActualAcum - ventasAnteriorAcum,
      pctVentas: ventasAnteriorAcum > 0 ? Math.round(((ventasActualAcum - ventasAnteriorAcum) / ventasAnteriorAcum) * 1000) / 10 : 0,
      gastosActual: gastosActualAcum,
      gastosAnterior: gastosAnteriorAcum,
      diferenciaGastos: gastosActualAcum - gastosAnteriorAcum,
      pctGastos: gastosAnteriorAcum > 0 ? Math.round(((gastosActualAcum - gastosAnteriorAcum) / gastosAnteriorAcum) * 1000) / 10 : 0
    },
    mejorMes: mejorMes,
    tieneAnoAnterior: !!anoAnt
  });
}

// ==================== METRICAS MES (DASHBOARD NUEVO) ====================
// Devuelve resumen rapido, ranking recepcion, ranking camareras, habs danadas, proyeccion
// Para el modulo de Metricas reorganizado
async function apiGetMetricasMes(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const mes = String(p.mes || '').trim();
  if(!/^\d{4}-\d{2}$/.test(mes)) return err(res,'Mes invalido (formato YYYY-MM)');

  const [yearStr, monthStr] = mes.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const firstDay = `${mes}-01`;
  const lastDayDate = new Date(year, month, 0);
  const lastDay = `${mes}-${String(lastDayDate.getDate()).padStart(2,'0')}`;
  const daysInMonth = lastDayDate.getDate();

// 1. Ventas del mes (de la tabla sales)
  const ventasMes = await fetchAll(() => tSelect('sales', 'id, ts_ms, business_day, shift_id, total, room_id, user_name, type, anulada')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .in('type', ['SALE','RENEWAL','EXTENSION','REFUND'])
    .neq('anulada', true));

  // 1b. Ventas del bar (de la tabla room_products)
  const ventasBar = await fetchAll(() => tSelect('room_products', 'business_day, total, is_cortesia')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay));

  // 2. Datos por dia (para encontrar mejor dia y hora pico)
  const ventasPorDia = {};
  const ventasPorHora = {};
  for(let i=0; i<24; i++) ventasPorHora[i] = 0;
  let totalVentas = 0;
  let totalHabs = 0;
  
  (ventasMes||[]).forEach(v => {
    if(v.anulada) return;
    // SALE/RENEWAL/EXTENSION: suman al total de ventas (dinero)
    totalVentas += Number(v.total||0);
    if(!ventasPorDia[v.business_day]) ventasPorDia[v.business_day] = { total:0, habs:0 };
    ventasPorDia[v.business_day].total += Number(v.total||0);
    // Solo SALE cuenta como habitacion vendida (para contador y hora pico)
    if(v.type !== 'SALE') return;
    ventasPorDia[v.business_day].habs++;
    totalHabs++;
    // Hora pico (basado en hora real del check-in)
    if(v.ts_ms){
      const d = new Date(Number(v.ts_ms));
      // Ajuste UTC-5 Colombia
      const hora = (d.getUTCHours() - 5 + 24) % 24;
      ventasPorHora[hora] = (ventasPorHora[hora]||0) + 1;
    }
  });

  // Sumar ventas del bar al totalVentas y por dia (sin contar como "habitacion")
  (ventasBar||[]).forEach(v => {
    if(v.is_cortesia) return; // Cortesias no suman
    const total = Number(v.total||0);
    // incluye ajustes negativos (total<=0): netean ventas de bar mal cargadas
    totalVentas += total;
    const dia = v.business_day;
    if(!ventasPorDia[dia]) ventasPorDia[dia] = { total:0, habs:0 };
    ventasPorDia[dia].total += total;
  });

  // ===== RETIROS DEL DUENO (AHORRO SILENCIOSO) =====
  // Restar retiros activos del totalVentas y de las ventas por dia (regla de oro)
  // Esto cumple la regla de oro: el retiro se ve reflejado en Metricas
  const { data: retirosMM } = await tSelect('retiros_dueno', 'dia_origen, monto, anulado')
    .gte('dia_origen', firstDay)
    .lte('dia_origen', lastDay)
    .eq('anulado', false);
  (retirosMM||[]).forEach(r => {
    const monto = Number(r.monto||0);
    const dia = r.dia_origen;
    totalVentas -= monto;
    if(ventasPorDia[dia]) ventasPorDia[dia].total -= monto;
  });

  // Mejor dia
  let mejorDia = { fecha: '—', total: 0, habs: 0 };
  Object.keys(ventasPorDia).forEach(fecha => {
    const d = ventasPorDia[fecha];
    if(d.total > mejorDia.total) mejorDia = { fecha:fecha, total:d.total, habs:d.habs };
  });

  // Hora pico
  let horaPico = 0;
  let pickCount = 0;
  Object.keys(ventasPorHora).forEach(h => {
    if(ventasPorHora[h] > pickCount){
      pickCount = ventasPorHora[h];
      horaPico = Number(h);
    }
  });

  // 3. Ranking recepcionistas (este mes)
  const recepMap = {};
  (ventasMes||[]).forEach(v => {
    if(v.anulada || v.type !== 'SALE') return;
    const nm = v.user_name || '?';
    if(!recepMap[nm]) recepMap[nm] = { nombre:nm, habs:0, total:0, turnos:0, fallas:0 };
    recepMap[nm].habs++;
    recepMap[nm].total += Number(v.total||0);
  });

  // Contar turnos trabajados y fallas (de tabla shift_log y shift_failures)
  const { data: shiftLogs } = await tSelect('shift_log', 'user_name, business_day')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay);
  const turnosPorRecep = {};
  (shiftLogs||[]).forEach(s => {
    const nm = s.user_name || '?';
    if(!turnosPorRecep[nm]) turnosPorRecep[nm] = 0;
    turnosPorRecep[nm]++;
  });

  const { data: failures } = await tSelect('shift_failures', 'user_name, business_day')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay);
  const fallasPorRecep = {};
  (failures||[]).forEach(f => {
    const nm = f.user_name || '?';
    if(!fallasPorRecep[nm]) fallasPorRecep[nm] = 0;
    fallasPorRecep[nm]++;
  });

  Object.keys(recepMap).forEach(nm => {
    recepMap[nm].turnos = turnosPorRecep[nm] || 0;
    recepMap[nm].fallas = fallasPorRecep[nm] || 0;
  });

  const recepRanking = Object.values(recepMap).sort((a,b) => b.total - a.total);

  // 4. Ranking camareras
  const maidLogs = await fetchAll(() => tSelect('maid_log', 'maid_name, business_day, started_ms, finished_ms, state_to')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .gt('finished_ms', 0)
    .eq('state_to', 'AVAILABLE'));

  const maidMap = {};
  (maidLogs||[]).forEach(l => {
    const nm = l.maid_name || '?';
    if(!maidMap[nm]) maidMap[nm] = { nombre:nm, habs:0, totalMins:0 };
    maidMap[nm].habs++;
    maidMap[nm].totalMins += Math.round((Number(l.finished_ms) - Number(l.started_ms))/60000);
  });
  const maidRanking = Object.values(maidMap).sort((a,b) => b.habs - a.habs);

  // 5. Habitaciones mas danadas (filtrar por created_at del mes en curso)
  const firstDayTs = `${firstDay}T00:00:00`;
  const lastDayTs = `${lastDay}T23:59:59`;
  const { data: roomIssues } = await tSelect('room_issues', 'room_id, type, description, resolved, created_at')
    .gte('created_at', firstDayTs)
    .lte('created_at', lastDayTs);
  const roomMap = {};
  (roomIssues||[]).forEach(i => {
    const rid = i.room_id || '?';
    if(!roomMap[rid]) roomMap[rid] = { roomId:rid, count:0, totalCosto:0, pendientes:0 };
    roomMap[rid].count++;
    if(!i.resolved) roomMap[rid].pendientes++;
  });
  const habsDanadas = Object.values(roomMap).sort((a,b) => b.count - a.count).slice(0,5);

  // 6. Proyeccion del mes (mes y anio son numericos en la tabla)
  const { data: proyTareas } = await tSelect('proyeccion_tareas', 'id, anio, mes, nombre, descripcion, area, responsable, prioridad, estado, fecha_estado')
    .eq('anio', year)
    .eq('mes', month);
  let totalTareas = 0;
  let ejecutadas = 0;
  let pendientes = 0;
  let noRealizadas = 0;
  const tareasPendientes = [];
  (proyTareas||[]).forEach(t => {
    totalTareas++;
    const est = String(t.estado||'').toLowerCase();
    if(est === 'realizado') ejecutadas++;
    else if(est === 'no_realizado' || est === 'no realizado') noRealizadas++;
    else {
      pendientes++;
      tareasPendientes.push({
        id: t.id,
        nombre: t.nombre || '',
        descripcion: t.descripcion || '',
        area: t.area || '',
        responsable: t.responsable || '',
        prioridad: t.prioridad || 'media',
        estado: t.estado || 'pendiente'
      });
    }
  });

  // 7. Ocupacion promedio del mes (rooms vendidas / dias transcurridos / total rooms activos)
  const diasConVentas = Object.keys(ventasPorDia).length;
  const habsPorDia = diasConVentas > 0 ? totalHabs / diasConVentas : 0;
  // Suponemos 30 habitaciones activas (esto se puede mejorar luego)
  const ocupacionPct = Math.min(100, Math.round((habsPorDia / 30) * 100));

  return ok(res, {
    mes: mes,
    resumen: {
      mejorDia: mejorDia,
      horaPico: { hora: horaPico, count: pickCount },
      ocupacion: ocupacionPct,
      totalVentas: totalVentas,
      totalHabs: totalHabs,
      diasConVentas: diasConVentas
    },
    recepRanking: recepRanking,
    maidRanking: maidRanking,
    habsDanadas: habsDanadas,
    proyeccion: {
      total: totalTareas,
      ejecutadas: ejecutadas,
      pendientes: pendientes,
      noRealizadas: noRealizadas,
      pct: totalTareas > 0 ? Math.round((ejecutadas/totalTareas)*100) : 0,
      tareasPendientes: tareasPendientes
    },
    horasPico: ventasPorHora,
    ventasPorDia: ventasPorDia
  });
}

// ==================== GASTOS DEL MES (NUEVO MODULO) ====================
// Devuelve ventas, gastos y descargos del mes para el modulo de Gastos del Mes
async function apiGetGastosMesResumen(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const mes = String(p.mes || '').trim();
  if(!/^\d{4}-\d{2}$/.test(mes)) return err(res,'Mes invalido (formato YYYY-MM)');

  const [yearStr, monthStr] = mes.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const firstDay = `${mes}-01`;
  const lastDayDate = new Date(year, month, 0);
  const lastDay = `${mes}-${String(lastDayDate.getDate()).padStart(2,'0')}`;

  // 1. Ventas del mes desde la tabla "sales" (habitaciones + extensiones)
  const ventasMes = await fetchAll(() => tSelect('sales', 'id, ts_ms, business_day, shift_id, total, pay_method, pay_method_2, amount_1, amount_2, amount_3, anulada, type, devolucion_efectivo, devolucion_metodo_original')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .in('type', ['SALE','RENEWAL','EXTENSION','REFUND'])
    .neq('anulada', true));
  
  let ventasEfectivo = 0;
  let ventasTarjeta = 0;
  let ventasNequi = 0;
  let totalVentas = 0;
  let cantVentas = 0;
  
  (ventasMes||[]).forEach(v => {
    if(v.anulada) return;
    if(v.type !== 'REFUND') cantVentas++;  // el REFUND netea la plata pero no es una venta (no cuenta)
    totalVentas += Number(v.total||0);
    // Si es MIXTO usa amount_1/2/3
    if(v.pay_method === 'MIXTO' || v.pay_method_2) {
      ventasEfectivo += Number(v.amount_1||0);
      ventasTarjeta += Number(v.amount_2||0);
      ventasNequi += Number(v.amount_3||0);
    } else {
      const total = Number(v.total||0);
      const pm = String(v.pay_method||'').toUpperCase();
      if(pm === 'EFECTIVO') ventasEfectivo += total;
      else if(pm === 'TARJETA') ventasTarjeta += total;
      else if(pm === 'NEQUI') ventasNequi += total;
      else if(pm === 'WOMPI') ventasTarjeta += total;   // Reservas (app): dentro de Tarjeta
    }
  });

  // Devoluciones cruzadas: ventas anuladas con devolucion en efectivo
  // El banco/Nequi tiene la plata (suma a tarjeta/nequi) pero la caja entrego (resta del efectivo)
  const ventasCruzadas = await fetchAll(() => tSelect('sales', 'total, devolucion_metodo_original')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .eq('anulada', true)
    .eq('devolucion_efectivo', true));
  (ventasCruzadas||[]).forEach(v => {
    const t = Number(v.total||0);
    const metodoOriginal = String(v.devolucion_metodo_original||'').toUpperCase();
    if(metodoOriginal === 'TARJETA') ventasTarjeta += t;  // Banco tiene la plata
    else if(metodoOriginal === 'NEQUI') ventasNequi += t;  // Nequi tiene la plata
    ventasEfectivo -= t;  // Caja entrego efectivo al cliente
  });

  // 1b. Ventas del bar desde la tabla "room_products" (productos consumidos en habitaciones)
  const ventasBar = await fetchAll(() => tSelect('room_products', 'total, pay_method, is_cortesia, amount_1, amount_2, amount_3')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay));
  
  let ventasBarEfectivo = 0;
  let ventasBarTarjeta = 0;
  let ventasBarNequi = 0;
  let totalVentasBar = 0;
  let cantVentasBar = 0;
  
  (ventasBar||[]).forEach(v => {
    if(v.is_cortesia) return; // Cortesias NO suman
    const total = Number(v.total||0);
    // incluye ajustes negativos (total<=0): netean ventas de bar mal cargadas
    cantVentasBar++;
    totalVentasBar += total;
    const pm = String(v.pay_method||'').toUpperCase();
    if(pm === 'MIXTO'){ ventasBarEfectivo += Number(v.amount_1||0); ventasBarTarjeta += Number(v.amount_2||0); ventasBarNequi += Number(v.amount_3||0); }
    else if(pm === 'EFECTIVO') ventasBarEfectivo += total;
    else if(pm === 'TARJETA') ventasBarTarjeta += total;
    else if(pm === 'NEQUI') ventasBarNequi += total;
  });
  
  // Sumar las ventas del bar a los totales generales
  ventasEfectivo += ventasBarEfectivo;
  ventasTarjeta += ventasBarTarjeta;
  ventasNequi += ventasBarNequi;

  // ===== RETIROS DEL DUENO (AHORRO SILENCIOSO) =====
  // Restar retiros activos del mes de las ventas (regla de oro)
  // El retiro se ve reflejado en la pantalla "Gastos Mes" como menos ventas
  const retirosMesGM = await fetchAll(() => tSelect('retiros_dueno', 'monto, pay_method, anulado')
    .gte('dia_origen', firstDay)
    .lte('dia_origen', lastDay)
    .eq('anulado', false));
  let totalRetirosEfectivo = 0;
  let totalRetirosTarjeta = 0;
  (retirosMesGM||[]).forEach(r => {
    const monto = Number(r.monto||0);
    const pm = String(r.pay_method||'').toUpperCase();
    if(pm === 'EFECTIVO') totalRetirosEfectivo += monto;
    else if(pm === 'TARJETA') totalRetirosTarjeta += monto;
  });
  ventasEfectivo -= totalRetirosEfectivo;
  ventasTarjeta -= totalRetirosTarjeta;
  totalVentas -= (totalRetirosEfectivo + totalRetirosTarjeta);
  totalVentas += totalVentasBar;
  cantVentas += cantVentasBar;

  // 2. Gastos del mes desde la nueva tabla "gastos_mes"
  const { data: gastosMes, error: errG } = await tSelect('gastos_mes', '*')
    .eq('mes', mes)
    .order('fecha', { ascending: true })
    .order('ts_ms', { ascending: true });
  if(errG) return err(res, errG.message);

  let gastosEfectivo = 0;
  let gastosTarjeta = 0;
  let totalGastos = 0;
  let cantGastos = 0;
  const gastosPorCategoria = {};
  
  (gastosMes||[]).forEach(g => {
    if(g.anulada) return;
    cantGastos++;
    const monto = Number(g.monto||0);
    totalGastos += monto;
    if(g.pay_method === 'EFECTIVO') gastosEfectivo += monto;
    else if(g.pay_method === 'TARJETA') gastosTarjeta += monto;
    if(!gastosPorCategoria[g.categoria]) gastosPorCategoria[g.categoria] = 0;
    gastosPorCategoria[g.categoria] += monto;
  });

  // 3. Descargos de Nequi del mes
  const { data: descargos, error: errD } = await tSelect('descargos_nequi', '*')
    .eq('mes', mes)
    .order('fecha', { ascending: true });
  if(errD) return err(res, errD.message);

  // 3b. GASTOS DEL CUADRE (los que paga la recepcionista en cada turno)
  // Estos gastos SE PAGAN EN EFECTIVO durante el turno y nunca entran a caja
  // Se descuentan de "Ventas en efectivo" para mostrar la plata REAL disponible
  const [gralRes, taxiRes, extraRes, loansRes] = await Promise.all([
    tSelect('general_expenses', 'amount')
      .gte('business_day', firstDay)
      .lte('business_day', lastDay),
    tSelect('taxi_expenses', 'amount')
      .eq('anulada', false)
      .gte('business_day', firstDay)
      .lte('business_day', lastDay),
    tSelect('extra_staff', 'payment')
      .eq('anulada', false)
      .gte('business_day', firstDay)
      .lte('business_day', lastDay),
    tSelect('loans', 'amount')
      .gte('business_day', firstDay)
      .lte('business_day', lastDay)
      .eq('manual', true)
      .eq('anulada', false)
  ]);

  let gastosGenerales = 0, gastosTaxis = 0, gastosTurnos = 0, gastosAjustes = 0;
  (gralRes.data||[]).forEach(r => gastosGenerales += Number(r.amount||0));
  (taxiRes.data||[]).forEach(r => gastosTaxis += Number(r.amount||0));
  (extraRes.data||[]).forEach(r => gastosTurnos += Number(r.payment||0));
  (loansRes.data||[]).forEach(r => gastosAjustes += Number(r.amount||0));
  const gastosCuadre = gastosGenerales + gastosTaxis + gastosTurnos + gastosAjustes;

  // Descontar los gastos del cuadre de las ventas en efectivo
  // (esa plata YA se pagó en el turno, nunca llegó a caja)
  ventasEfectivo = ventasEfectivo - gastosCuadre;

  let totalDescargos = 0;
  (descargos||[]).forEach(d => {
    if(d.anulada) return;
    totalDescargos += Number(d.monto||0);
  });

  // 4. Calculos finales (donde esta la plata HOY)
  const efectivoEnCaja = ventasEfectivo + totalDescargos - gastosEfectivo;
  const cajaTarjeta = ventasTarjeta - gastosTarjeta;
  const nequiDisponible = ventasNequi - totalDescargos;
  const utilidad = totalVentas - totalGastos - gastosCuadre;

  return ok(res, {
    mes: mes,
    ventas: {
      total: totalVentas,
      efectivo: ventasEfectivo,
      tarjeta: ventasTarjeta,
      nequi: ventasNequi,
      cantidad: cantVentas
    },
    gastos: {
      total: totalGastos,
      efectivo: gastosEfectivo,
      tarjeta: gastosTarjeta,
      cantidad: cantGastos,
      lista: gastosMes || [],
      porCategoria: gastosPorCategoria
    },
    descargos: {
      total: totalDescargos,
      cantidad: (descargos||[]).filter(d => !d.anulada).length,
      lista: descargos || []
    },
    saldos: {
      efectivoEnCaja: efectivoEnCaja,
      cajaTarjeta: cajaTarjeta,
      nequiDisponible: nequiDisponible
    },
    gastosCuadre: {
      generales: gastosGenerales,
      taxis: gastosTaxis,
      turnos: gastosTurnos,
      ajustes: gastosAjustes,
      total: gastosCuadre
    },
    utilidad: utilidad
  });
}

// ==================== AGREGAR GASTO DEL MES ====================
async function apiAddGastoMes(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const fecha = String(p.fecha||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res,'Fecha invalida (YYYY-MM-DD)');
  const categoria = String(p.categoria||'').trim();
  const CATEGORIAS_VALIDAS = ['Compras Bar','Aseo','Mantenimiento','Gastos Generales','Servicios','Caja Menor','Nomina','Seguridad Social','Entrega M','Entrega L','Préstamo'];
  if(!CATEGORIAS_VALIDAS.includes(categoria)) return err(res,'Categoria invalida. Validas: '+CATEGORIAS_VALIDAS.join(', '));
  const concepto = String(p.concepto||'').trim();
  if(concepto.length<3) return err(res,'Concepto requerido (min 3 caracteres)');
  const monto = Number(p.monto||0);
  if(monto<=0) return err(res,'Monto debe ser mayor a 0');
  const payMethod = String(p.payMethod||'').toUpperCase();
  if(!['EFECTIVO','TARJETA'].includes(payMethod)) return err(res,'Metodo de pago invalido (solo EFECTIVO o TARJETA)');
  const mes = fecha.substring(0,7);
  const now = Date.now();
  const { data, error } = await tInsert('gastos_mes',{
    ts_ms: now,
    fecha: fecha,
    mes: mes,
    categoria: categoria,
    concepto: concepto,
    monto: monto,
    pay_method: payMethod,
    created_by: userName
  }).select().single();
  if(error) return err(res, error.message);
  return ok(res, { gasto: data });
}

// ==================== EDITAR GASTO DEL MES ====================
// ==================== RETIROS DEL DUEÑO (AHORRO SILENCIOSO) ====================
async function apiAnularRetiro(p, res) {
  const userName = String(p.userName||'').trim();
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN puede anular retiros');
  
  const retiroId = Number(p.retiroId||0);
  const motivo = String(p.motivo||'').trim();
  
  // Validaciones
  if(retiroId <= 0) return err(res, 'ID de retiro invalido');
  if(motivo.length < 5) return err(res, 'Motivo de anulacion obligatorio (minimo 5 caracteres)');
  
  // Verificar que el retiro existe y no esta ya anulado
  const { data: retiroExistente, error: errBusqueda } = await tSelect('retiros_dueno', '*')
    .eq('id', retiroId)
    .single();
  
  if(errBusqueda || !retiroExistente) return err(res, 'Retiro no encontrado');
  if(retiroExistente.anulado === true) return err(res, 'Este retiro ya esta anulado');
  
  // Anular el retiro (NO se borra, queda en historial)
  const now = Date.now();
  const { error: errUpdate } = await tUpdate('retiros_dueno',{
    anulado: true,
    anulado_ms: now,
    anulado_por: userName,
    motivo_anulacion: motivo
  }).eq('id', retiroId);
  
  if(errUpdate) return err(res, 'Error al anular: '+errUpdate.message);
  
  return ok(res, {
    retiroId: retiroId,
    monto: Number(retiroExistente.monto||0),
    payMethod: retiroExistente.pay_method,
    diaOrigen: retiroExistente.dia_origen,
    mensaje: 'Retiro anulado. La plata vuelve donde estaba ($'+Number(retiroExistente.monto||0).toLocaleString('es-CO')+' en '+retiroExistente.pay_method+' del dia '+retiroExistente.dia_origen+').'
  });
}

async function apiGetRetiros(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN puede ver retiros');
  
  const mes = String(p.mes||'').trim(); // formato YYYY-MM (opcional)
  
  // Construir query base
  let query = tSelect('retiros_dueno','*');
  
  // Filtrar por mes si se proporciona
  if(mes && mes.match(/^\d{4}-\d{2}$/)) {
    const inicio = mes + '-01';
    // Calcular fin de mes
    const [yyyy, mm] = mes.split('-').map(Number);
    const finMes = new Date(yyyy, mm, 0).getDate(); // ultimo dia del mes
    const fin = mes + '-' + String(finMes).padStart(2,'0');
    query = query.gte('business_day', inicio).lte('business_day', fin);
  }
  
  const { data, error } = await query.order('ts_ms', { ascending: false });
  
  if(error) return err(res, 'Error al consultar: '+error.message);
  
  // Mapear a formato camelCase y calcular totales
  const retiros = (data||[]).map(r => ({
    id: r.id,
    tsMs: Number(r.ts_ms),
    businessDay: r.business_day,
    diaOrigen: r.dia_origen,
    shiftId: r.shift_id,
    monto: Number(r.monto||0),
    payMethod: r.pay_method,
    motivo: r.motivo || '',
    userName: r.user_name,
    anulado: r.anulado === true,
    anuladoMs: Number(r.anulado_ms||0),
    anuladoPor: r.anulado_por || '',
    motivoAnulacion: r.motivo_anulacion || ''
  }));
  
  // Calcular totales SOLO de retiros activos (no anulados)
  let totalEfectivo = 0;
  let totalTarjeta = 0;
  let cantidadActivos = 0;
  retiros.forEach(r => {
    if(r.anulado) return;
    cantidadActivos++;
    if(r.payMethod === 'EFECTIVO') totalEfectivo += r.monto;
    else if(r.payMethod === 'TARJETA') totalTarjeta += r.monto;
  });
  
  return ok(res, {
    retiros: retiros,
    totalEfectivo: totalEfectivo,
    totalTarjeta: totalTarjeta,
    totalGeneral: totalEfectivo + totalTarjeta,
    cantidad: cantidadActivos,
    cantidadTotal: retiros.length
  });
}

async function apiCreateRetiro(p, res) {
  const userName = String(p.userName||'').trim();
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole !== 'ADMIN') return err(res, 'Solo ADMIN puede registrar retiros');
  
  const diaOrigen = String(p.diaOrigen||'').trim();
  const monto = Number(p.monto||0);
  const payMethod = String(p.payMethod||'').toUpperCase();
  const motivo = String(p.motivo||'').trim();
  
  // Validaciones basicas
  if(!diaOrigen.match(/^\d{4}-\d{2}-\d{2}$/)) return err(res, 'Dia origen invalido (formato YYYY-MM-DD)');
  if(monto <= 0) return err(res, 'El monto debe ser mayor a 0');
  if(payMethod !== 'EFECTIVO' && payMethod !== 'TARJETA') return err(res, 'Metodo de pago invalido');
  
  // VALIDACION ESTRICTA: verificar disponibilidad del dia origen
  // Sumar ventas de ese dia y metodo (solo SALE/RENEWAL/EXTENSION, no anuladas, no devolucion cruzada)
  const { data: ventasDia } = await tSelect('sales', 'total, pay_method, pay_method_2, amount_1, amount_2, amount_3, type, anulada, devolucion_efectivo')
    .eq('business_day', diaOrigen)
    .in('type', ['SALE','RENEWAL','EXTENSION']);
  
  let disponible = 0;
  (ventasDia||[]).forEach(v => {
    if(v.anulada && !v.devolucion_efectivo) return;
    const t = Number(v.total||0);
    const pm = String(v.pay_method||'EFECTIVO').toUpperCase();
    if(pm === 'MIXTO') {
      // Para MIXTO: leer del amount correspondiente
      if(payMethod === 'EFECTIVO') disponible += Number(v.amount_1||0);
      else if(payMethod === 'TARJETA') disponible += Number(v.amount_2||0);
    } else if(pm === payMethod) {
      disponible += t;
    }
  });
  
  // Restar bar productos del dia con ese metodo (tambien cuenta como ventas)
  const { data: barDia } = await tSelect('room_products', 'total, pay_method, is_cortesia, amount_1, amount_2, amount_3')
    .eq('business_day', diaOrigen);
  (barDia||[]).forEach(b => {
    if(b.is_cortesia) return;
    const pm = String(b.pay_method||'EFECTIVO').toUpperCase();
    if(pm === 'MIXTO'){
      if(payMethod==='EFECTIVO') disponible += Number(b.amount_1||0);
      else if(payMethod==='TARJETA') disponible += Number(b.amount_2||0);
      else if(payMethod==='NEQUI') disponible += Number(b.amount_3||0);
    } else if(pm === payMethod) disponible += Number(b.total||0);
  });
  
  // Restar retiros previos del mismo dia y metodo (no anulados)
  const { data: retirosPrev } = await tSelect('retiros_dueno', 'monto')
    .eq('dia_origen', diaOrigen)
    .eq('pay_method', payMethod)
    .eq('anulado', false);
  let yaRetirado = 0;
  (retirosPrev||[]).forEach(r => { yaRetirado += Number(r.monto||0); });
  
  const disponibleNeto = disponible - yaRetirado;
  
  if(monto > disponibleNeto) {
    return err(res, 'Solo hay $'+disponibleNeto.toLocaleString('es-CO')+' disponibles en '+payMethod+' del dia '+diaOrigen+'. Ya se retiraron $'+yaRetirado.toLocaleString('es-CO')+' previamente.');
  }
  
  // Crear el retiro
  const now = Date.now();
  const today = new Date(now - 5*3600*1000).toISOString().slice(0,10); // UTC-5 Colombia
  const hour = new Date(now - 5*3600*1000).getUTCHours();
  let shiftId = 'SHIFT_1';
  if(hour >= 14 && hour < 21) shiftId = 'SHIFT_2';
  else if(hour >= 21 || hour < 6) shiftId = 'SHIFT_3';
  
  const { data, error } = await tInsert('retiros_dueno',{
    ts_ms: now,
    business_day: today,
    dia_origen: diaOrigen,
    shift_id: shiftId,
    monto: monto,
    pay_method: payMethod,
    motivo: motivo || null,
    user_name: userName,
    user_role: 'ADMIN',
    anulado: false
  }).select().single();
  
  if(error) return err(res, 'Error al guardar: '+error.message);
  
  return ok(res, {
    id: data.id,
    monto: monto,
    payMethod: payMethod,
    diaOrigen: diaOrigen,
    disponibleAntes: disponibleNeto,
    disponibleDespues: disponibleNeto - monto,
    yaRetiradoTotal: yaRetirado + monto
  });
}

async function apiEditGastoMes(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const gastoId = Number(p.gastoId||0);
  if(!gastoId) return err(res,'gastoId requerido');
  const motivo = String(p.motivo||'').trim();
  if(motivo.length<5) return err(res,'Motivo de edicion requerido (min 5 caracteres)');
  const { data: gastoActual, error: errG } = await tSelect('gastos_mes','*').eq('id', gastoId).maybeSingle();
  if(errG) return err(res, errG.message);
  if(!gastoActual) return err(res,'Gasto no encontrado');
  if(gastoActual.anulada) return err(res,'No se puede editar un gasto anulado');
  const updates = {
    edited_ms: Date.now(),
    edited_by: userName,
    motivo_edicion: motivo
  };
  if(p.concepto !== undefined){
    const concepto = String(p.concepto||'').trim();
    if(concepto.length<3) return err(res,'Concepto requerido (min 3 caracteres)');
    updates.concepto = concepto;
  }
  if(p.monto !== undefined){
    const monto = Number(p.monto||0);
    if(monto<=0) return err(res,'Monto debe ser mayor a 0');
    if(updates.monto_original === undefined) updates.monto_original = gastoActual.monto;
    updates.monto = monto;
  }
  if(p.payMethod !== undefined){
    const payMethod = String(p.payMethod||'').toUpperCase();
    if(!['EFECTIVO','TARJETA'].includes(payMethod)) return err(res,'Metodo de pago invalido');
    updates.pay_method = payMethod;
  }
  if(p.categoria !== undefined){
    const categoria = String(p.categoria||'').trim();
    const CATEGORIAS_VALIDAS = ['Compras Bar','Aseo','Mantenimiento','Gastos Generales','Servicios','Caja Menor','Nomina','Seguridad Social','Entrega M','Entrega L','Préstamo'];
    if(!CATEGORIAS_VALIDAS.includes(categoria)) return err(res,'Categoria invalida');
    updates.categoria = categoria;
  }
  if(p.fecha !== undefined){
    const fecha = String(p.fecha||'').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res,'Fecha invalida');
    updates.fecha = fecha;
    updates.mes = fecha.substring(0,7);
  }
  const { error } = await tUpdate('gastos_mes',updates).eq('id', gastoId);
  if(error) return err(res, error.message);
  return ok(res, { gastoId: gastoId });
}

// ==================== DESCARGAR NEQUI A EFECTIVO ====================
async function apiDescargarNequi(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const fecha = String(p.fecha||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res,'Fecha invalida (YYYY-MM-DD)');
  const monto = Number(p.monto||0);
  if(monto<=0) return err(res,'Monto debe ser mayor a 0');
  const nota = String(p.nota||'').trim();
  const mes = fecha.substring(0,7);
  const now = Date.now();
  const { data, error } = await tInsert('descargos_nequi',{
    ts_ms: now,
    fecha: fecha,
    mes: mes,
    monto: monto,
    nota: nota || null,
    created_by: userName
  }).select().single();
  if(error) return err(res, error.message);
  return ok(res, { descargo: data });
}

// ==================== ANULAR DESCARGO NEQUI ====================
async function apiAnularDescargoNequi(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const descargoId = Number(p.descargoId||0);
  if(!descargoId) return err(res,'descargoId requerido');
  const { data: descargoActual, error: errD } = await tSelect('descargos_nequi','*').eq('id', descargoId).maybeSingle();
  if(errD) return err(res, errD.message);
  if(!descargoActual) return err(res,'Descargo no encontrado');
  if(descargoActual.anulada) return err(res,'Este descargo ya esta anulado');
  const { error } = await tUpdate('descargos_nequi',{
    anulada: true,
    anulada_ms: Date.now(),
    anulada_por: userName
  }).eq('id', descargoId);
  if(error) return err(res, error.message);
  return ok(res, { descargoId: descargoId });
}

// ==================== ANULAR GASTO DEL MES ====================
async function apiAnularGastoMes(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const gastoId = Number(p.gastoId||0);
  if(!gastoId) return err(res,'gastoId requerido');
  const motivo = String(p.motivo||'').trim();
  if(motivo.length<5) return err(res,'Motivo requerido (min 5 caracteres)');
  const { data: gastoActual, error: errG } = await tSelect('gastos_mes','*').eq('id', gastoId).maybeSingle();
  if(errG) return err(res, errG.message);
  if(!gastoActual) return err(res,'Gasto no encontrado');
  if(gastoActual.anulada) return err(res,'Este gasto ya esta anulado');
  const { error } = await tUpdate('gastos_mes',{
    anulada: true,
    anulada_ms: Date.now(),
    anulada_por: userName,
    motivo_anulacion: motivo
  }).eq('id', gastoId);
  if(error) return err(res, error.message);
  return ok(res, { gastoId: gastoId });
}

// ==================== CAJA PAOLA → RUBEN ====================
// Movimiento interno PRIVADO entre Paola y Ruben
// NO afecta el efectivo en caja publico

// 1. Resumen: 3 saldos + entregas + gastos del mes
async function apiGetCajaPaolaResumen(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const mes = String(p.mes || '').trim();
  if(!/^\d{4}-\d{2}$/.test(mes)) return err(res,'Mes invalido (formato YYYY-MM)');

  // Leer todos los movimientos del mes (excepto anulados)
  const { data: movs, error: errM } = await tSelect('caja_paola', '*')
    .eq('mes', mes)
    .order('ts_ms', { ascending: false });
  if(errM) return err(res, errM.message);

  // Separar entregas y gastos
  const entregas = [];
  const gastosRuben = [];
  let totalEntregasAprobadas = 0;
  let totalEntregasPendientes = 0;
  let totalGastos = 0;

  (movs||[]).forEach(m => {
    if(m.anulada) return; // Anulados no cuentan ni se muestran en listas activas
    if(m.tipo === 'entrega'){
      entregas.push(m);
      if(m.estado === 'aprobada') totalEntregasAprobadas += Number(m.monto||0);
      else if(m.estado === 'pendiente') totalEntregasPendientes += Number(m.monto||0);
    } else if(m.tipo === 'gasto'){
      gastosRuben.push(m);
      totalGastos += Number(m.monto||0);
    }
  });

  // Calcular el "Efectivo en caja del mes" (publico) para validacion del cuadre
  // Reusamos la misma logica que apiGetGastosMesResumen
  const [yearStr, monthStr] = mes.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const firstDay = `${mes}-01`;
  const lastDayDate = new Date(year, month, 0);
  const lastDay = `${mes}-${String(lastDayDate.getDate()).padStart(2,'0')}`;

  // Ventas en efectivo (sales)
  const ventasMes = await fetchAll(() => tSelect('sales', 'total, pay_method, pay_method_2, amount_1, amount_2, amount_3, anulada, type')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .in('type', ['SALE','RENEWAL','EXTENSION','REFUND'])
    .neq('anulada', true));

  let ventasEfectivo = 0;
  (ventasMes||[]).forEach(v => {
    if(v.anulada) return;
    if(v.pay_method === 'MIXTO' || v.pay_method_2){
      ventasEfectivo += Number(v.amount_1||0);
    } else if(String(v.pay_method||'').toUpperCase() === 'EFECTIVO'){
      ventasEfectivo += Number(v.total||0);
    }
  });

  // Devoluciones cruzadas: ventas anuladas con devolucion en efectivo
  // La caja entrego esa plata al cliente, asi que se resta del efectivo del mes
  const ventasCruzadasCP = await fetchAll(() => tSelect('sales', 'total')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .eq('anulada', true)
    .eq('devolucion_efectivo', true));
  (ventasCruzadasCP||[]).forEach(v => {
    ventasEfectivo -= Number(v.total||0);  // Caja entrego efectivo al cliente
  });

  // Ventas del bar en efectivo
  const ventasBar = await fetchAll(() => tSelect('room_products', 'total, pay_method, is_cortesia, amount_1, amount_2, amount_3')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay));
  (ventasBar||[]).forEach(v => {
    if(v.is_cortesia) return;
    const total = Number(v.total||0);
    // incluye ajustes negativos (total<=0): netean ventas de bar mal cargadas
    const pm = String(v.pay_method||'').toUpperCase();
    if(pm === 'EFECTIVO'){
      ventasEfectivo += total;
    } else if(pm === 'MIXTO'){
      ventasEfectivo += Number(v.amount_1||0);   // solo la parte en efectivo del mixto
    }
  });

  // Descargos de Nequi a efectivo (suman al efectivo)
  const { data: descargos } = await tSelect('descargos_nequi', 'monto, anulada')
    .eq('mes', mes)
    .neq('anulada', true);
  let totalDescargos = 0;
  (descargos||[]).forEach(d => {
    if(d.anulada) return;
    totalDescargos += Number(d.monto||0);
  });

  // Gastos publicos en efectivo (gastos_mes con pay_method=EFECTIVO)
  const { data: gastosPublic } = await tSelect('gastos_mes', 'monto, pay_method, anulada')
    .eq('mes', mes)
    .neq('anulada', true);
  let gastosPublicEfectivo = 0;
  (gastosPublic||[]).forEach(g => {
    if(g.anulada) return;
    if(String(g.pay_method||'').toUpperCase() === 'EFECTIVO'){
      gastosPublicEfectivo += Number(g.monto||0);
    }
  });

  // Gastos del cuadre (los que paga la recepcionista en cada turno - ya salieron de caja)
  // Mismo calculo que apiGetGastosMesResumen para que las dos pantallas coincidan
  const [gralResCP, taxiResCP, extraResCP, loansResCP] = await Promise.all([
    tSelect('general_expenses','amount').gte('business_day', firstDay).lte('business_day', lastDay),
    tSelect('taxi_expenses','amount').eq('anulada', false).gte('business_day', firstDay).lte('business_day', lastDay),
    tSelect('extra_staff','payment').eq('anulada', false).gte('business_day', firstDay).lte('business_day', lastDay),
    tSelect('loans','amount').gte('business_day', firstDay).lte('business_day', lastDay).eq('manual', true).eq('anulada', false)
  ]);
  let gastosCuadreCP = 0;
  (gralResCP.data||[]).forEach(r => gastosCuadreCP += Number(r.amount||0));
  (taxiResCP.data||[]).forEach(r => gastosCuadreCP += Number(r.amount||0));
  (extraResCP.data||[]).forEach(r => gastosCuadreCP += Number(r.payment||0));
  (loansResCP.data||[]).forEach(r => gastosCuadreCP += Number(r.amount||0));

  // Efectivo en caja publico = ventas efectivo + descargos - gastos publicos efectivo - gastos del cuadre
  const efectivoEnCajaPublico = ventasEfectivo + totalDescargos - gastosPublicEfectivo - gastosCuadreCP;

  // Calcular los 3 saldos privados
  const saldoPaola = efectivoEnCajaPublico - totalEntregasAprobadas - totalGastos;
  const cajaFuerteRuben = totalEntregasAprobadas;
  // total Gastos Ruben ya esta calculado

  // Validar cuadre (deben sumar al efectivo publico)
  const sumaPrivados = saldoPaola + cajaFuerteRuben + totalGastos;
  const cuadra = Math.abs(sumaPrivados - efectivoEnCajaPublico) < 1; // tolerancia 1 peso

  return ok(res, {
    mes: mes,
    efectivoEnCajaPublico: efectivoEnCajaPublico,
    saldos: {
      paola: saldoPaola,
      cajaFuerteRuben: cajaFuerteRuben,
      gastosRuben: totalGastos
    },
    entregas: {
      lista: entregas,
      totalAprobadas: totalEntregasAprobadas,
      totalPendientes: totalEntregasPendientes
    },
    gastos: {
      lista: gastosRuben,
      total: totalGastos
    },
    cuadre: {
      sumaPrivados: sumaPrivados,
      cuadra: cuadra,
      diferencia: efectivoEnCajaPublico - sumaPrivados
    }
  });
}

// 2. Crear entrega (Paola → Ruben), queda pendiente de aprobacion
async function apiAddCajaEntrega(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const monto = Number(p.monto||0);
  if(monto<=0) return err(res,'Monto debe ser mayor a 0');
  const nota = String(p.nota||'').trim();

  const now = Date.now();
  const fecha = new Date(now).toISOString().slice(0,10); // YYYY-MM-DD UTC
  const mes = fecha.substring(0,7);

  const { data, error } = await tInsert('caja_paola',{
    ts_ms: now,
    fecha: fecha,
    mes: mes,
    tipo: 'entrega',
    monto: monto,
    nota: nota || null,
    estado: 'pendiente',
    created_by: userName
  }).select().single();
  if(error) return err(res, error.message);
  return ok(res, { entrega: data });
}

// 3. Crear gasto Ruben (lo paga Paola en nombre de Ruben)
async function apiAddCajaGasto(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const monto = Number(p.monto||0);
  if(monto<=0) return err(res,'Monto debe ser mayor a 0');
  const concepto = String(p.concepto||'').trim();
  if(concepto.length<3) return err(res,'Concepto requerido (min 3 caracteres)');
  const fecha = String(p.fecha||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res,'Fecha invalida (YYYY-MM-DD)');
  const mes = fecha.substring(0,7);

  const { data, error } = await tInsert('caja_paola',{
    ts_ms: Date.now(),
    fecha: fecha,
    mes: mes,
    tipo: 'gasto',
    monto: monto,
    concepto: concepto,
    estado: 'aprobada', // los gastos se "aprueban" al instante (no requieren PIN)
    created_by: userName
  }).select().single();
  if(error) return err(res, error.message);
  return ok(res, { gasto: data });
}

// 4. Editar gasto Ruben existente (cualquier campo)
async function apiEditCajaGasto(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const movId = Number(p.movId||0);
  if(!movId) return err(res,'movId requerido');

  const { data: gastoActual, error: errG } = await tSelect('caja_paola','*').eq('id', movId).maybeSingle();
  if(errG) return err(res, errG.message);
  if(!gastoActual) return err(res,'Movimiento no encontrado');
  if(gastoActual.tipo !== 'gasto') return err(res,'Solo se editan gastos, no entregas');
  if(gastoActual.anulada) return err(res,'No se puede editar un gasto anulado');

  const updates = {
    edited_ms: Date.now(),
    edited_by: userName
  };
  if(p.monto !== undefined){
    const monto = Number(p.monto||0);
    if(monto<=0) return err(res,'Monto debe ser mayor a 0');
    updates.monto = monto;
  }
  if(p.concepto !== undefined){
    const concepto = String(p.concepto||'').trim();
    if(concepto.length<3) return err(res,'Concepto requerido (min 3 caracteres)');
    updates.concepto = concepto;
  }
  if(p.fecha !== undefined){
    const fecha = String(p.fecha||'').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return err(res,'Fecha invalida (YYYY-MM-DD)');
    updates.fecha = fecha;
    updates.mes = fecha.substring(0,7);
  }

  const { error } = await tUpdate('caja_paola',updates).eq('id', movId);
  if(error) return err(res, error.message);
  return ok(res, { movId: movId });
}

// 5. Eliminar gasto Ruben (anular logico, no borra fila)
async function apiDeleteCajaGasto(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const movId = Number(p.movId||0);
  if(!movId) return err(res,'movId requerido');

  const { data: gastoActual, error: errG } = await tSelect('caja_paola','*').eq('id', movId).maybeSingle();
  if(errG) return err(res, errG.message);
  if(!gastoActual) return err(res,'Movimiento no encontrado');
  if(gastoActual.tipo !== 'gasto') return err(res,'Solo se eliminan gastos, no entregas');
  if(gastoActual.anulada) return err(res,'Este gasto ya fue eliminado');

  const { error } = await tUpdate('caja_paola',{
    anulada: true,
    anulada_ms: Date.now(),
    anulada_por: userName
  }).eq('id', movId);
  if(error) return err(res, error.message);
  return ok(res, { movId: movId });
}

// 6. Aprobar entrega (Ruben con PIN)
async function apiAprobarCajaEntrega(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const movId = Number(p.movId||0);
  if(!movId) return err(res,'movId requerido');
  const pin = String(p.pin||'').trim();
  if(!pin) return err(res,'PIN requerido');

  // Verificar PIN contra config_caja
  const { data: cfg, error: errC } = await tSelect('config_caja', 'value')
    .eq('key', 'pin_ruben')
    .maybeSingle();
  if(errC) return err(res, errC.message);
  if(!cfg) return err(res,'PIN no configurado');
  if(String(cfg.value).trim() !== pin) return err(res,'PIN incorrecto');

  // Validar la entrega
  const { data: entrega, error: errE } = await tSelect('caja_paola','*').eq('id', movId).maybeSingle();
  if(errE) return err(res, errE.message);
  if(!entrega) return err(res,'Entrega no encontrada');
  if(entrega.tipo !== 'entrega') return err(res,'Solo se aprueban entregas');
  if(entrega.anulada) return err(res,'Esta entrega esta anulada');
  if(entrega.estado !== 'pendiente') return err(res,'Solo se aprueban entregas pendientes');

  // Aprobar
  const now = Date.now();
  const { error } = await tUpdate('caja_paola',{
    estado: 'aprobada',
    approved_ms: now,
    approved_by: userName
  }).eq('id', movId);
  if(error) return err(res, error.message);
  return ok(res, { movId: movId, monto: entrega.monto });
}

// 7. Anular entrega pendiente (solo si NO esta aprobada)
async function apiAnularCajaEntrega(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN') return err(res,'Solo ADMIN');
  const userName = String(p.userName||'').trim();
  if(!userName) return err(res,'Usuario requerido');
  const movId = Number(p.movId||0);
  if(!movId) return err(res,'movId requerido');

  const { data: entrega, error: errE } = await tSelect('caja_paola','*').eq('id', movId).maybeSingle();
  if(errE) return err(res, errE.message);
  if(!entrega) return err(res,'Entrega no encontrada');
  if(entrega.tipo !== 'entrega') return err(res,'Solo se anulan entregas');
  if(entrega.anulada) return err(res,'Esta entrega ya esta anulada');
  if(entrega.estado === 'aprobada') return err(res,'No se puede anular una entrega ya aprobada');

  const motivo = String(p.motivo||'').trim() || 'Anulada por el creador';

  const { error } = await tUpdate('caja_paola',{
    anulada: true,
    estado: 'anulada',
    anulada_ms: Date.now(),
    anulada_por: userName,
    motivo_anulacion: motivo
  }).eq('id', movId);
  if(error) return err(res, error.message);
  return ok(res, { movId: movId });
}

// ==================== RESUMEN MENSUAL (INVENTARIO MES) ====================
// Devuelve el flujo completo del mes por producto, día y turno
async function apiGetResumenMes(p, res) {
  const mes = String(p.mes || '').trim();
  if(!/^\d{4}-\d{2}$/.test(mes)) return err(res,'Mes invalido (formato YYYY-MM)');

  const [yearStr, monthStr] = mes.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const firstDay = `${mes}-01`;
  const lastDayDate = new Date(year, month, 0);
  const lastDay = `${mes}-${String(lastDayDate.getDate()).padStart(2,'0')}`;
  const daysInMonth = lastDayDate.getDate();

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMes = `${prevYear}-${String(prevMonth).padStart(2,'0')}`;

  const { data: products } = await tSelect('products','*').eq('activo',true).order('categoria').order('nombre');
  if(!products || !products.length) return ok(res,{rows:[],totals:{},daysTotals:{},mes:mes});

  // Saldo inicial calculado al vuelo (sin depender de tabla cierre_mes).
  // Traemos todos los movimientos POSTERIORES al mes consultado (desde el dia siguiente
  // a lastDay hasta hoy) para combinarlos con los del mes y poder deshacer todo
  // desde stock_actual/stock_bodega hacia atras hasta el primer dia del mes.
  const todayBd = businessDay(Date.now());
  const salesPost = await fetchAll(() => tSelect('room_products','*').gt('business_day',lastDay).lte('business_day',todayBd));
  const movementsPost = await fetchAll(() => tSelect('stock_movements','*').gt('business_day',lastDay).lte('business_day',todayBd));
  const entriesPost = await fetchAll(() => tSelect('stock_entries','*').gt('business_day',lastDay).lte('business_day',todayBd));

  // Combinamos movimientos del mes + posteriores = todos los movs desde firstDay hasta hoy
  const salesAfter = (salesPost||[]);
  const movementsAfter = (movementsPost||[]);
  const entriesAfter = (entriesPost||[]);

  const salesMes = await fetchAll(() => tSelect('room_products','*').gte('business_day',firstDay).lte('business_day',lastDay));
  const movementsMes = await fetchAll(() => tSelect('stock_movements','*').gte('business_day',firstDay).lte('business_day',lastDay));
  const entriesMes = await fetchAll(() => tSelect('stock_entries','*').gte('business_day',firstDay).lte('business_day',lastDay));


  const SHIFTS = ['SHIFT_1','SHIFT_2','SHIFT_3'];

  const rows = products.map(function(prod){
    // Reconstruir saldo al inicio del mes consultado calculando hacia atras
    // desde stock_actual / stock_bodega (que estan al dia HOY) deshaciendo
    // todos los movimientos ocurridos desde firstDay hasta hoy.
    const ventasFut = (salesMes||[]).concat(salesAfter).filter(s => s.product_id === prod.id && !s.is_cortesia).reduce((a,s) => a + Number(s.cantidad||0), 0);
    const cortesiasFut = (salesMes||[]).concat(salesAfter).filter(s => s.product_id === prod.id && s.is_cortesia).reduce((a,s) => a + Number(s.cantidad||0), 0);
    const entriesFut = (entriesMes||[]).concat(entriesAfter).filter(e => e.product_id === prod.id).reduce((a,e) => a + Number(e.cantidad||0), 0);
    const movsFut = (movementsMes||[]).concat(movementsAfter).filter(m => m.product_id === prod.id);
    const trasladosFut = movsFut.filter(m => m.tipo === 'traslado_recepcion').reduce((a,m) => a + Number(m.cantidad||0), 0);
    const devsBodFut = movsFut.filter(m => m.tipo === 'devolucion_bodega').reduce((a,m) => a + Number(m.cantidad||0), 0);
    const ingBodFut = movsFut.filter(m => m.tipo === 'ingreso_bodega').reduce((a,m) => a + Number(m.cantidad||0), 0);
    const conteosFut = movsFut.filter(m => m.tipo === 'recepcion_conteo').reduce((a,m) => a + Number(m.cantidad||0), 0);
    // Recepcion: stock_actual + (lo que SALIO de recepcion) - (lo que ENTRO a recepcion)
    const siRec = Number(prod.stock_actual||0) + ventasFut + cortesiasFut + devsBodFut - entriesFut - trasladosFut - conteosFut;
    // Bodega: stock_bodega + (lo que SALIO de bodega) - (lo que ENTRO a bodega)
    const siBod = Number(prod.stock_bodega||0) + trasladosFut - ingBodFut - devsBodFut;
    const siTotal = siRec + siBod;

    const compras = (movementsMes||[]).filter(m => m.product_id === prod.id && m.tipo === 'ingreso_bodega').reduce((a,m) => a + Number(m.cantidad||0), 0);

    const ventasProd = (salesMes||[]).filter(s => s.product_id === prod.id && !s.is_cortesia);
    const cortesiasProd = (salesMes||[]).filter(s => s.product_id === prod.id && s.is_cortesia);
    const cantVendida = ventasProd.reduce((a,s) => a + Number(s.cantidad||0), 0);
    const valorVendido = ventasProd.reduce((a,s) => a + Number(s.total||0), 0);
    const cantCortesias = cortesiasProd.reduce((a,s) => a + Number(s.cantidad||0), 0);
    const valorCortesias = cortesiasProd.reduce((a,s) => a + Number(s.total||0), 0);

    const porDia = {};
    for(let d = 1; d <= daysInMonth; d++) {
      const fecha = `${mes}-${String(d).padStart(2,'0')}`;
      porDia[fecha] = {
        valorDia: 0,
        turnos: {
          SHIFT_1: {b:0,e:0,v:0,c:0,s:0},
          SHIFT_2: {b:0,e:0,v:0,c:0,s:0},
          SHIFT_3: {b:0,e:0,v:0,c:0,s:0}
        }
      };
    }
// Llenar B: ingresos a bodega (stock_movements tipo 'ingreso_bodega' = compras del mes)
    (movementsMes||[]).filter(m => m.product_id === prod.id && m.tipo === 'ingreso_bodega').forEach(function(m){
      const fecha = m.business_day;
      const sid = m.shift_id || 'SHIFT_1';
      if(porDia[fecha] && porDia[fecha].turnos[sid]) {
        porDia[fecha].turnos[sid].b += Number(m.cantidad||0);
      }
    });
    (movementsMes||[]).filter(m => m.product_id === prod.id && m.tipo === 'traslado_recepcion').forEach(function(m){
      const fecha = m.business_day;
      if(porDia[fecha] && porDia[fecha].turnos[m.shift_id]) {
        porDia[fecha].turnos[m.shift_id].e += Number(m.cantidad||0);
      }
    });
    (movementsMes||[]).filter(m => m.product_id === prod.id && m.tipo === 'devolucion_bodega').forEach(function(m){
      const fecha = m.business_day;
      if(porDia[fecha] && porDia[fecha].turnos[m.shift_id]) {
        porDia[fecha].turnos[m.shift_id].e -= Number(m.cantidad||0);
      }
    });
    // Ajuste por conteo de recepcion: cuenta como entrada (E) en el resumen
    // Solo se aplica a partir del 2026-04-30 para no afectar ajustes anteriores
    (movementsMes||[]).filter(m => m.product_id === prod.id && m.tipo === 'recepcion_conteo' && m.business_day >= '2026-04-30').forEach(function(m){
      const fecha = m.business_day;
      if(porDia[fecha] && porDia[fecha].turnos[m.shift_id]) {
        porDia[fecha].turnos[m.shift_id].e += Number(m.cantidad||0);
      }
    });

    (salesMes||[]).filter(s => s.product_id === prod.id).forEach(function(s){
      const fecha = s.business_day;
      if(!porDia[fecha] || !porDia[fecha].turnos[s.shift_id]) return;
      if(s.is_cortesia) {
        porDia[fecha].turnos[s.shift_id].c += Number(s.cantidad||0);
      } else {
        porDia[fecha].turnos[s.shift_id].v += Number(s.cantidad||0);
        porDia[fecha].valorDia += Number(s.total||0);
      }
    });

    let saldoRec = siRec;
    Object.keys(porDia).sort().forEach(function(fecha){
      SHIFTS.forEach(function(sid){
        const t = porDia[fecha].turnos[sid];
        saldoRec = saldoRec + t.e - t.v - t.c;
        t.s = saldoRec;
      });
    });

    return {
      id: prod.id,
      nombre: prod.nombre,
      categoria: prod.categoria || 'Sin categoría',
      precioCompra: Number(prod.precio_compra||0),
      precioVenta: Number(prod.precio||0),
      bodega: Number(prod.stock_bodega||0),
      siMes: siTotal,
      siRec: siRec,
      siBod: siBod,
      compras: compras,
      cantVendida: cantVendida,
      valorVendido: valorVendido,
      cantCortesias: cantCortesias,
      valorCortesias: valorCortesias,
      porDia: porDia
    };
  });

  const totalSiAnterior = rows.reduce((a,r) => a + (r.siRec + r.siBod) * r.precioCompra, 0);
  const totalCompras = (movementsMes||[]).filter(m => m.tipo === 'ingreso_bodega').reduce((a,m) => {
    const prod = products.find(p => p.id === m.product_id);
    const costo = prod ? Number(prod.precio_compra||0) : 0;
    return a + Number(m.cantidad||0) * costo;
  }, 0);
  const totalVendido = (salesMes||[]).filter(s => !s.is_cortesia).reduce((a,s) => a + Number(s.total||0), 0);
  const totalCortesiasValor = (salesMes||[]).filter(s => s.is_cortesia).reduce((a,s) => a + Number(s.total||0), 0);
  const totalGanancia = totalVendido - totalCompras - totalCortesiasValor;

  const daysTotals = {};
  for(let d = 1; d <= daysInMonth; d++) {
    const fecha = `${mes}-${String(d).padStart(2,'0')}`;
    daysTotals[fecha] = 0;
  }
  (salesMes||[]).filter(s => !s.is_cortesia).forEach(function(s){
    if(daysTotals[s.business_day] !== undefined) {
      daysTotals[s.business_day] += Number(s.total||0);
    }
  });

  return ok(res, {
    mes: mes,
    daysInMonth: daysInMonth,
    rows: rows,
    totals: {
      siAnterior: totalSiAnterior,
      compras: totalCompras,
      vendido: totalVendido,
      cortesias: totalCortesiasValor,
      ganancia: totalGanancia
    },
    daysTotals: daysTotals
  });
}
// ==================== UPDATE PRECIO COMPRA ====================
// Permite editar el precio de compra desde el Resumen (solo ADMIN)
async function apiUpdatePrecioCompra(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const productId = Number(p.productId||0);
  const precioCompra = Number(p.precioCompra||0);
  if(!productId) return err(res,'productId requerido');
  if(precioCompra < 0) return err(res,'Precio invalido');

  await tUpdate('products',{ precio_compra: precioCompra }).eq('id', productId);
  return ok(res, { productId, precioCompra });
}
async function apiChangePaymentMethod(p, res) {
  try {
    const saleId = Number(p.saleId || 0);
    const newPm = String(p.newPayMethod || '').toUpperCase();
    const newPm2 = String(p.newPayMethod2 || '');
    const newA1 = Number(p.newAmount1 || 0);
    const newA2 = Number(p.newAmount2 || 0);
    const newA3 = Number(p.newAmount3 || 0);
    const reason = String(p.reason || '').trim();
    const userName = String(p.userName || '');
    const userRole = String(p.userRole || '');
    if (!saleId) return err(res, 'Falta saleId');
    if (!['EFECTIVO','TARJETA','NEQUI','MIXTO'].includes(newPm)) return err(res, 'Metodo invalido');
    if (!reason) return err(res, 'Falta motivo');
    if (!userName) return err(res, 'Falta usuario');
    const { data: saleData, error: saleErr } = await tSelect('sales','*').eq('id', saleId).single();
    if (saleErr || !saleData) return err(res, 'Venta no encontrada');
    if (saleData.anulada) return err(res, 'No se puede modificar una venta anulada');
    const total = Number(saleData.total || 0);
    if (newPm === 'MIXTO') {
      if (Math.round(newA1 + newA2 + newA3) !== Math.round(total)) return err(res, 'La suma del MIXTO no cuadra con el total ('+total+')');
    } else {
      if (newPm === 'EFECTIVO' && Math.round(newA1) !== Math.round(total)) return err(res, 'amount_1 debe igualar al total');
      if (newPm === 'TARJETA'  && Math.round(newA2) !== Math.round(total)) return err(res, 'amount_2 debe igualar al total');
      if (newPm === 'NEQUI'    && Math.round(newA3) !== Math.round(total)) return err(res, 'amount_3 debe igualar al total');
    }
    const nowMs = Date.now();
    const { error: insErr } = await tInsert('payment_method_changes',{
      sale_id: saleId,
      changed_at_ms: nowMs,
      business_day: saleData.business_day,
      shift_id: saleData.shift_id,
      user_role: userRole,
      user_name: userName,
      old_pay_method: saleData.pay_method || '',
      old_pay_method_2: saleData.pay_method_2 || '',
      old_amount_1: Number(saleData.amount_1 || 0),
      old_amount_2: Number(saleData.amount_2 || 0),
      old_amount_3: Number(saleData.amount_3 || 0),
      new_pay_method: newPm,
      new_pay_method_2: newPm2,
      new_amount_1: newA1,
      new_amount_2: newA2,
      new_amount_3: newA3,
      total: total,
      reason: reason
    });
    if (insErr) return err(res, 'Error guardando auditoria: ' + insErr.message);
    const { error: updErr } = await tUpdate('sales',{
      pay_method: newPm,
      pay_method_2: newPm2,
      amount_1: newA1,
      amount_2: newA2,
      amount_3: newA3
    }).eq('id', saleId);
    if (updErr) return err(res, 'Error actualizando venta: ' + updErr.message);
    return ok(res, { changed: true, saleId: saleId });
  } catch (e) {
    return err(res, e.message || String(e));
  }
}
// Cambia el metodo de pago de una venta de bar (room_products) directamente sobre
// el registro original. NO crea entradas -N/+N como hacia el ajuste viejo
// (tipo='metodo_pago' en apiAjusteInventarioV2). Registra en payment_method_changes
// con room_product_id seteado y sale_id NULL.
async function apiChangePaymentMethodBar(p, res) {
  try {
    const userRole = String(p.userRole||'').toUpperCase();
    if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
    const roomProductId = Number(p.roomProductId||0);
    const newPm = String(p.newPayMethod||'').toUpperCase();
    const reason = String(p.reason||'').trim();
    const userName = String(p.userName||'').trim();
    if(!roomProductId) return err(res,'Falta roomProductId');
    if(!['EFECTIVO','TARJETA','NEQUI'].includes(newPm)) return err(res,'Metodo invalido (EFECTIVO/TARJETA/NEQUI)');
    if(!reason || reason.length < 5) return err(res,'Motivo requerido (min 5 caracteres)');
    if(!userName) return err(res,'Falta usuario');
    const { data: rp, error: rpErr } = await tSelect('room_products','*').eq('id', roomProductId).maybeSingle();
    if(rpErr) return err(res, rpErr.message);
    if(!rp) return err(res,'Venta de bar no encontrada');
    if(rp.is_cortesia) return err(res,'Las cortesias no tienen metodo de pago');
    const oldPm = String(rp.pay_method||'').toUpperCase();
    if(oldPm === newPm) return err(res,'El metodo de pago ya es '+newPm);
    const nowMs = Date.now();
    const { error: insErr } = await tInsert('payment_method_changes',{
      sale_id: null,
      room_product_id: roomProductId,
      changed_at_ms: nowMs,
      business_day: rp.business_day,
      shift_id: rp.shift_id,
      user_role: userRole,
      user_name: userName,
      old_pay_method: oldPm,
      new_pay_method: newPm,
      total: Number(rp.total||0),
      reason: reason
    });
    if(insErr) return err(res, 'Error guardando auditoria: ' + insErr.message);
    const { error: updErr } = await tUpdate('room_products',{ pay_method: newPm }).eq('id', roomProductId);
    if(updErr) return err(res, 'Error actualizando venta: ' + updErr.message);
    return ok(res, { changed: true, roomProductId, oldPayMethod: oldPm, newPayMethod: newPm });
  } catch (e) {
    return err(res, e.message || String(e));
  }
}
// Lista ventas de bar de un dia+turno para que admin pueda seleccionar una y
// cambiarle el metodo de pago. Excluye cortesias y ajustes admin (created_by_admin).
async function apiListRoomProductsTurno(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const bDay = String(p.businessDay||'').trim();
  const shiftId = String(p.shiftId||'').trim();
  if(!bDay) return err(res,'businessDay requerido');
  if(!shiftId) return err(res,'shiftId requerido');
  const { data, error } = await tSelect('room_products', 'id, ts_ms, room_id, product_id, product_name, cantidad, precio_unit, total, pay_method, user_name, is_cortesia, created_by_admin')
    .eq('business_day', bDay)
    .eq('shift_id', shiftId)
    .eq('is_cortesia', false)
    .order('ts_ms');
  if(error) return err(res, error.message);
  const list = (data||[]).filter(r => !r.created_by_admin && Number(r.cantidad||0) > 0).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms), roomId: r.room_id,
    productId: r.product_id, productName: r.product_name,
    cantidad: Number(r.cantidad||0), precioUnit: Number(r.precio_unit||0),
    total: Number(r.total||0), payMethod: r.pay_method||'EFECTIVO',
    userName: r.user_name||''
  }));
  return ok(res, { items: list });
}
// ==================== AJUSTE DE INVENTARIO V2 (13 ESCENARIOS) ====================
// Maneja todos los escenarios de ajuste: BODEGA, RECEPCION, FALTANTES, AJUSTE
// ==================== HISTORIAL DE AJUSTES (BITÁCORA) ====================
// Devuelve el historial de ajustes hechos por admin, filtrado por mes
async function apiGetHistorialAjustes(p, res) {
  const mes = String(p.mes || '').trim();
  const filtroTipo = String(p.filtroTipo || '').trim(); // 'BODEGA', 'RECEPCION' o '' para todos
  const filtroProducto = Number(p.filtroProducto || 0);
  const filtroAdmin = String(p.filtroAdmin || '').trim();

  let firstDay, lastDay;
  if(/^\d{4}-\d{2}$/.test(mes)) {
    const [yearStr, monthStr] = mes.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    firstDay = `${mes}-01`;
    const lastDayDate = new Date(year, month, 0);
    lastDay = `${mes}-${String(lastDayDate.getDate()).padStart(2,'0')}`;
  } else {
    return err(res, 'Mes invalido (formato YYYY-MM)');
  }

  let query = tSelect('ajustes','*')
    .gte('business_day', firstDay)
    .lte('business_day', lastDay)
    .order('ts_ms', { ascending: false });

  if(filtroTipo === 'BODEGA') query = query.eq('categoria', 'BODEGA');
  else if(filtroTipo === 'RECEPCION') query = query.eq('categoria', 'RECEPCION');
  if(filtroProducto > 0) query = query.eq('product_id', filtroProducto);
  if(filtroAdmin) query = query.eq('admin_name', filtroAdmin);

  const { data, error } = await query;
  if(error) return err(res, error.message);

  const items = (data||[]).map(a => ({
    id: a.id,
    ts_ms: Number(a.ts_ms || 0),
    categoria: a.categoria || '',
    tipo: a.tipo || '',
    productId: a.product_id,
    productName: a.product_name || '',
    cantidad: Number(a.cantidad || 0),
    afectaStock: a.afecta_stock || '',
    afectaCuadre: !!a.afecta_cuadre,
    businessDay: a.business_day || '',
    shiftId: a.shift_id || '',
    recepName: a.recep_name || '',
    payMethod: a.pay_method || '',
    payMethodViejo: a.pay_method_viejo || '',
    productoViejoId: a.producto_viejo_id,
    valorAfectado: Number(a.valor_afectado || 0),
    motivo: a.motivo || '',
    adminName: a.admin_name || '',
    createdAt: a.created_at
  }));

  const totalBodega = items.filter(x => x.categoria === 'BODEGA').length;
  const totalRecepcion = items.filter(x => x.categoria === 'RECEPCION').length;

  return ok(res, {
    mes: mes,
    items: items,
    total: items.length,
    totalBodega: totalBodega,
    totalRecepcion: totalRecepcion
  });
}
async function apiAjusteInventarioV2(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const now = Date.now();
  const adminName = String(p.userName||'').trim();
  if(!adminName) return err(res,'Admin requerido');

  const categoria = String(p.categoria||'').toUpperCase().trim();
  const tipo = String(p.tipo||'').trim();
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const motivo = String(p.motivo||'').trim();

  if(!motivo) return err(res,'Motivo requerido');  // decision Ruben: motivo obligatorio (punto de verdad)
  if(!['BODEGA','RECEPCION'].includes(categoria)) return err(res,'Categoria invalida (solo BODEGA o RECEPCION)');
  if(!tipo) return err(res,'Tipo requerido');
  if(!productId) return err(res,'Producto requerido');
  if(motivo.length < 3) return err(res,'Motivo minimo 3 letras');

  const { data: prod } = await tSelect('products','*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');

  const precio = Number(prod.precio||0);
  const precioCompra = Number(prod.precio_compra||0);

  let afectaStock = 'ninguno';
  let afectaCuadre = false;
  let businessDayAj = '';
  let shiftAj = '';
  let recepNameAj = '';
  let payMethodAj = '';
  let payMethodViejo = '';
  let productoViejoId = null;
  let valorAfectado = 0;
  let nuevoStockBod = Number(prod.stock_bodega||0);

  // ========== BODEGA (no afecta cuadre) ==========
  if(categoria === 'BODEGA') {
    afectaStock = 'bodega';
    afectaCuadre = false;
    businessDayAj = businessDay(now);
    shiftAj = currentShiftId(now);
    valorAfectado = cantidad * precioCompra;

    // Tipos: roto, vencido, conteo, robo, ingreso_extra, salida_extra
    let deltaBod = 0;
    if(tipo === 'conteo' || tipo === 'ingreso_extra') {
      if(cantidad === 0) return err(res,'Cantidad no puede ser 0');
      if(Number(prod.stock_bodega||0) + cantidad < 0) return err(res,'Resultado negativo en bodega');
      deltaBod = cantidad;
    } else if(tipo === 'roto' || tipo === 'vencido' || tipo === 'robo' || tipo === 'salida_extra') {
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');
      if(Number(prod.stock_bodega||0) < cantidad) return err(res,'Stock bodega insuficiente. Hay '+prod.stock_bodega);
      deltaBod = -cantidad;
    } else {
      return err(res,'Tipo de bodega invalido: '+tipo);
    }

    {
      const { data: _newBod, error: _err } = await supabase.rpc('apply_stock_bodega_delta', { p_product_id: productId, p_delta: deltaBod });
      if(_err) return err(res, _err.message);
      nuevoStockBod = _newBod;
    }

    await tInsert('stock_movements',{
      ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
      user_name: adminName, user_role: 'ADMIN',
      product_id: productId, product_name: prod.nombre,
      tipo: 'bodega_'+tipo,
      cantidad: cantidad,
      nota: motivo
    });
  }

  // ========== RECEPCION (afecta cuadre y stock) ==========
  else if(categoria === 'RECEPCION') {
    afectaCuadre = true;
    businessDayAj = String(p.businessDay||'').trim();
    shiftAj = String(p.shiftId||'').trim();
    recepNameAj = String(p.recepName||'').trim();
    payMethodAj = String(p.payMethod||'EFECTIVO').toUpperCase();

    // Para conteo: si no envía fecha/turno/recep, los completamos con valores actuales
    if(tipo === 'conteo') {
      if(!businessDayAj) businessDayAj = businessDay(now);
      if(!shiftAj) shiftAj = currentShiftId(now);
      if(!recepNameAj) recepNameAj = adminName;
    } else {
      if(!businessDayAj) return err(res,'Fecha requerida');
      if(!['SHIFT_1','SHIFT_2','SHIFT_3'].includes(shiftAj)) return err(res,'Turno invalido');
      if(!recepNameAj) return err(res,'Recepcionista requerida');
    }

    // Escenario 5: ajuste por conteo (NO afecta cuadre, solo stock_actual)
    if(tipo === 'conteo') {
      if(cantidad === 0) return err(res,'Cantidad no puede ser 0');
      afectaCuadre = false;
      afectaStock = 'recepcion';
      valorAfectado = 0;
      if(Number(prod.stock_actual||0) + cantidad < 0) return err(res,'Resultado negativo. Stock actual: '+prod.stock_actual);
      {
        const { data: _newStock, error: _err } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: cantidad });
        if(_err) return err(res, _err.message);
        nuevoStockBod = _newStock;
      }
      await tInsert('stock_movements',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        user_name: recepNameAj, user_role: 'ADMIN',
        product_id: productId, product_name: prod.nombre,
        tipo: 'recepcion_conteo',
        cantidad: cantidad,
        nota: motivo
      });
    }

    // Escenario 4: agregar venta olvidada
    else if(tipo === 'venta_olvidada') {
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');
      afectaStock = 'recepcion';
      valorAfectado = cantidad * precio;
      {
        const stockActualNow = Number(prod.stock_actual||0);
        const delta = stockActualNow >= cantidad ? -cantidad : -stockActualNow;
        const { data: _newStock, error: _err } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: delta });
        if(_err) return err(res, _err.message);
        nuevoStockBod = _newStock;
      }

      await tInsert('stock_movements',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        user_name: recepNameAj, user_role: 'ADMIN',
        product_id: productId, product_name: prod.nombre,
        tipo: 'ajuste_venta_olvidada',
        cantidad: -cantidad,
        nota: 'AJUSTE (admin '+adminName+'): '+motivo
      });

      await tInsert('room_products',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        room_id: 'AJUSTE', check_in_ms: 0,
        product_id: productId, product_name: prod.nombre,
        cantidad: cantidad, precio_unit: precio,
        total: valorAfectado, pay_method: payMethodAj,
        user_name: recepNameAj,
        is_cortesia: false,
        created_by_admin: true,
        tipo_ajuste: 'venta_olvidada',
        motivo_ajuste: motivo
      });
    }

    // Escenario 3: quitar venta (vendio de mas)
    else if(tipo === 'venta_duplicada') {
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');
      afectaStock = 'recepcion';
      valorAfectado = -(cantidad * precio);
      {
        const { data: _newStock, error: _err } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: cantidad });
        if(_err) return err(res, _err.message);
        nuevoStockBod = _newStock;
      }

      await tInsert('stock_movements',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        user_name: recepNameAj, user_role: 'ADMIN',
        product_id: productId, product_name: prod.nombre,
        tipo: 'ajuste_venta_duplicada',
        cantidad: cantidad,
        nota: 'AJUSTE (admin '+adminName+'): '+motivo
      });

      await tInsert('room_products',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        room_id: 'AJUSTE', check_in_ms: 0,
        product_id: productId, product_name: prod.nombre,
        cantidad: -cantidad, precio_unit: precio,
        total: -(cantidad * precio), pay_method: payMethodAj,
        user_name: recepNameAj,
        is_cortesia: false,
        created_by_admin: true,
        tipo_ajuste: 'venta_duplicada',
        motivo_ajuste: motivo
      });
    }

    // Escenario 1: cambiar producto vendido por otro
    else if(tipo === 'producto') {
      productoViejoId = Number(p.productoViejoId||0);
      if(!productoViejoId) return err(res,'Producto viejo requerido');
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');

      const { data: prodViejo } = await tSelect('products','*').eq('id',productoViejoId).single();
      if(!prodViejo) return err(res,'Producto viejo no existe');
      const precioViejo = Number(prodViejo.precio||0);

      afectaStock = 'ambos';
      valorAfectado = (cantidad * precio) - (cantidad * precioViejo);

      {
        const { error: _errV } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productoViejoId, p_delta: cantidad });
        if(_errV) return err(res, _errV.message);
      }
      {
        const stockActualNow = Number(prod.stock_actual||0);
        const delta = stockActualNow >= cantidad ? -cantidad : -stockActualNow;
        const { data: _newStock, error: _err } = await supabase.rpc('apply_stock_actual_delta', { p_product_id: productId, p_delta: delta });
        if(_err) return err(res, _err.message);
        nuevoStockBod = _newStock;
      }

      await tInsert('stock_movements',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        user_name: recepNameAj, user_role: 'ADMIN',
        product_id: productoViejoId, product_name: prodViejo.nombre,
        tipo: 'ajuste_cambio_producto',
        cantidad: cantidad,
        nota: 'AJUSTE cambio producto (admin '+adminName+'): '+motivo
      });
      await tInsert('stock_movements',{
        ts_ms: now + 1, business_day: businessDayAj, shift_id: shiftAj,
        user_name: recepNameAj, user_role: 'ADMIN',
        product_id: productId, product_name: prod.nombre,
        tipo: 'ajuste_cambio_producto',
        cantidad: -cantidad,
        nota: 'AJUSTE cambio producto (admin '+adminName+'): '+motivo
      });

      await tInsert('room_products',{
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        room_id: 'AJUSTE', check_in_ms: 0,
        product_id: productoViejoId, product_name: prodViejo.nombre,
        cantidad: -cantidad, precio_unit: precioViejo,
        total: -(cantidad * precioViejo), pay_method: payMethodAj,
        user_name: recepNameAj,
        is_cortesia: false,
        created_by_admin: true,
        tipo_ajuste: 'producto_resta',
        motivo_ajuste: motivo
      });
      await tInsert('room_products',{
        ts_ms: now + 1, business_day: businessDayAj, shift_id: shiftAj,
        room_id: 'AJUSTE', check_in_ms: 0,
        product_id: productId, product_name: prod.nombre,
        cantidad: cantidad, precio_unit: precio,
        total: cantidad * precio, pay_method: payMethodAj,
        user_name: recepNameAj,
        is_cortesia: false,
        created_by_admin: true,
        tipo_ajuste: 'producto_suma',
        motivo_ajuste: motivo
      });
    }

    else {
      return err(res,'Tipo de recepcion invalido: '+tipo);
    }
  }

  // ========== REGISTRAR EN TABLA AUDITABLE ==========
  await tInsert('ajustes',{
    ts_ms: now,
    categoria: categoria,
    tipo: tipo,
    product_id: productId,
    product_name: prod.nombre,
    cantidad: cantidad,
    afecta_stock: afectaStock,
    afecta_cuadre: afectaCuadre,
    business_day: businessDayAj,
    shift_id: shiftAj,
    recep_name: recepNameAj,
    pay_method: payMethodAj,
    pay_method_viejo: payMethodViejo,
    producto_viejo_id: productoViejoId,
    valor_afectado: valorAfectado,
    motivo: motivo,
    admin_name: adminName
  });

  return ok(res, {
    categoria: categoria,
    tipo: tipo,
    productId: productId,
    cantidad: cantidad,
    afectaCuadre: afectaCuadre,
    valorAfectado: valorAfectado,
    nuevoStockBodega: nuevoStockBod,
    // Pieza 1: dia/turno reales con que quedo estampado el movimiento, para que
    // el front recargue ESE dia y avise si difiere del que se estaba mirando.
    businessDay: businessDayAj,
    shiftId: shiftAj
  });
}

// ==================== LUCIANA (asistente IA admin) ====================
// Fase 3 minimal: pregunta texto -> Claude -> respuesta + guardado.
// Sin foto, sin cache, sin historial, sin schema BD. Solo conexion E2E.
//
// Costos claude-sonnet-4-6 (USD por 1M tokens):
//   input normal:  $3      | output:           $15
//   cache write:   $3.75   | cache read:       $0.30
//   (cache write = 1.25x input, cache read = 0.1x input)
// El schema BD se cachea con cache_control:ephemeral (TTL 5min).

// SYSTEM_BASE es funcion porque incluye el nombre del admin (cambia por usuario).
// Sigue SIN cache (200 tokens, no significativo). El bloque cacheable es el SCHEMA_BD.
function lucianaSystemBase(userName) {
  const now = Date.now();
  const bogota = new Date(now - 5 * 3600000);
  const dd  = String(bogota.getUTCDate()).padStart(2, '0');
  const mm  = String(bogota.getUTCMonth() + 1).padStart(2, '0');
  const yyyy= bogota.getUTCFullYear();
  const hh  = String(bogota.getUTCHours()).padStart(2, '0');
  const mi  = String(bogota.getUTCMinutes()).padStart(2, '0');
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const diaSemana = dias[bogota.getUTCDay()];
  const bDay = businessDay(now);
  const bDayAyer = previousBusinessDay(bDay);
  const turno = currentShiftId(now);

  return [
    'INFORMACION DE TIEMPO ACTUAL (NO INVENTAR FECHAS):',
    '- Fecha y hora actual en Cali: ' + dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi,
    '- Dia de la semana: ' + diaSemana,
    '- Business day actual (hoy en terminos operativos): ' + bDay,
    '- Business day de ayer: ' + bDayAyer,
    '- Turno operativo actual: ' + turno,
    '',
    'Cuando el admin diga "hoy" usa el business_day actual.',
    'Cuando diga "ayer" usa el business_day de ayer.',
    'Cuando diga "la semana pasada" usa business_day actual menos 7 dias.',
    'NUNCA inventes ni adivines fechas. Si dudas de que fecha quiere el admin, preguntale.',
    '',
    'Eres Luciana, asistente IA del administrador de Casa 50 (motel/spa en Cali, Colombia).',
    'El admin que te esta hablando se llama ' + userName + '. Saludalo por su nombre y',
    'tratalo con calidez, pero NO uses su nombre en cada mensaje forzadamente; solo',
    'cuando suene natural.',
    '',
    'REGLAS DE ESTILO (importantes):',
    '- Se breve: 1 a 3 lineas maximo. NO expliques de mas.',
    '- PERO con calidez genuina, no fria ni cortante. No seas robotica ni transaccional.',
    '- Podes (y conviene) agregar un detalle calido al inicio o al final:',
    '  "Mira:", "Ahi va:", "Listo Ruben, te cuento:", "Ojo con esto:", etc.',
    '- NO listes opciones a menos que el admin lo pida.',
    '- NO repitas informacion del schema.',
    '- Si la noticia es buena, alegrate un poquito ("buen turno", "todo en orden").',
    '- Si la noticia es mala (descuadre, atasco), tono empatico pero directo.',
    '  No suavices la realidad, pero acompaniala.',
    '- Estilo: como un mensaje de WhatsApp a un amigo, no como un informe.',
    '',
    'Ejemplos de tono (calibrar el balance breve+calido):',
    '- Pregunta: "Cuanto vendio Diana hoy?"',
    '  MAL (muy frio): "Diana vendio $850.000 hoy."',
    '  MAL (muy largo): "Hola Ruben, dejame consultar... Diana realizo ventas..."',
    '  BIEN: "Mira Ruben: Diana vendio $850.000 hoy. Buen turno."',
    '- Pregunta: "Por que la 211 esta atascada?"',
    '  BIEN: "Ahi va: la 211 esta en MAID_PROGRESS con Ingrid Ruiz desde las 21:54.',
    '         Seguro no marco terminado."',
    '- Pregunta: "Hay descuadre hoy?"',
    '  BIEN (si SI): "Si, falta $12.000 en SHIFT_2. Mejor revisarlo antes del cierre."',
    '  BIEN (si NO): "Todo cuadrado hoy, Ruben. Sin diferencias."',
    '',
    'PERSONALIDAD:',
    '- Calida y cercana, como una colega de confianza',
    '- Amigable sin exagerar emojis (uno ocasional esta bien, no en todas)',
    '- Si descubris algo grave, lo decis directo PERO con empatia',
    '- No sos servil ni excesivamente disculpativa',
    '- No sos robotica ni transaccional - sos una persona que ayuda',
    '',
    'PRINCIPIOS OPERATIVOS:',
    '- Solo lectura: nunca modificas datos, solo informas y sugieres.',
    '- Si no estas 100% segura, deci "no lo se" en vez de inventar.',
    '- Tenes una herramienta query_supabase para consultar datos en vivo cuando',
    '  haga falta. Usala con criterio - no la uses para cosas que ya estan',
    '  resueltas en el schema. Si necesitas datos concretos (ej: comparar foto',
    '  vs sistema, analizar descuadre, ver ventas de hoy), llamala.',
    '- El admin conoce su sistema; tu rol es ayudarlo a diagnosticar problemas.',
    '',
    'VERACIDAD Y HUMILDAD (CRITICO - leelo antes de CADA respuesta):',
    '- Para CUALQUIER pregunta sobre ventas, plata, descuadres, habitaciones,',
    '  turnos o personal: CONSULTA la base con query_supabase ANTES de responder.',
    '  NUNCA respondas de memoria ni deduzcas del schema: el schema es solo la',
    '  estructura de las tablas, NO los datos reales.',
    '- AUNQUE el tema ya se haya discutido antes en esta conversacion,',
    '  RE-CONSULTA la base antes de reafirmar una conclusion. El historial',
    '  NO es evidencia: los datos pueden haber cambiado desde la ultima vez',
    '  que consultaste (una venta manual, una correccion o un cierre de turno',
    '  pueden haber entrado despues). Nunca respondas "eso ya lo vimos" ni',
    '  repitas una conclusion vieja sin volver a mirar los datos frescos.',
    '- Si la consulta NO devuelve filas, deci EXACTAMENTE: "No encontre registro',
    '  de eso" y ofrece revisar otra cosa. NO rellenes el hueco.',
    '- JAMAS inventes un dato, una hora, un monto, una clave, un nombre ni una',
    '  historia. Si no lo consultaste o no aparecio, para vos no existe.',
    '- Es mejor decir "no encontre registro" que dar una respuesta que suena',
    '  bien pero no salio de una consulta real. No adornes ni completes con',
    '  suposiciones.',
    '- PISTA DE DOMINIO: un descuento de taxista puede estar guardado como fila',
    '  REFUND (negativa) en la tabla sales, NO solo en taxi_expenses. Si buscas',
    '  un descuento y no aparece en una tabla, revisa la otra antes de concluir.',
    '- RAZONAMIENTO FORENSE (arma el rompecabezas, no listes datos sueltos):',
    '  * Una venta con nota [MANUAL] o motivo "error" significa que una venta',
    '    ORIGINAL fallo o no se registro en su momento: la venta manual ES la',
    '    CORRECCION de ese hueco, no un dato aparte. Relacionala con los',
    '    movimientos huerfanos del mismo turno y habitacion (refunds,',
    '    descuentos, extras sin venta base) antes de concluir.',
    '  * Un refund, descuento o extra sin venta propia en SU turno NO queda',
    '    explicado por una venta de OTRO turno de OTRO cliente. Un refund y una',
    '    venta manual del mismo turno y misma habitacion suelen ser UNA misma',
    '    estadia.',
    '  * Fijate en las pistas antes de concluir: la nota de la venta, el',
    '    check_in (hora de entrada) estampado, el turno y la habitacion. Antes',
    '    de decir "todo en orden", explica CADA movimiento huerfano; si no',
    '    podes explicar uno, decilo ("hay un movimiento que no cuadra") en vez',
    '    de "todo en orden".',
    '',
    'REGLAS DE LENGUAJE (CRITICAS):',
    '- NUNCA uses codigos internos del sistema en las respuestas. Traduci',
    '  TODO a espanol natural para que cualquier persona entienda, no solo',
    '  programadores.',
    '- Terminos a TRADUCIR siempre:',
    '  * SHIFT_1 -> "Turno 1" o "Turno manana"',
    '  * SHIFT_2 -> "Turno 2" o "Turno tarde"',
    '  * SHIFT_3 -> "Turno 3" o "Turno noche"',
    '  * SHIFT_1_12 -> "Turno 1 (12h, domingo)"',
    '  * SHIFT_2_12 -> "Turno 2 (12h, domingo)" (en BD aparece como SHIFT_3)',
    '  * type=SALE -> "venta normal"',
    '  * type=EXTENSION -> "extension de tiempo"',
    '  * type=EXTRA_HOUR -> "hora extra"',
    '  * type=HORA_GRATIS -> "cortesia" o "hora gratis"',
    '  * type=EXTRA_PERSON -> "persona adicional"',
    '  * type=REFUND -> "devolucion"',
    '  * type=ANULADA -> "venta anulada"',
    '  * type=ROOM_CHANGE -> "cambio de habitacion"',
    '  * shift_close -> "cierre de turno" o "cuadre del turno"',
    '  * check_in_ms -> "hora de entrada del cliente"',
    '  * stock_movements -> "movimientos de inventario"',
    '  * room_products -> "ventas del bar"',
    '  * business_day -> "dia operativo" o simplemente "dia"',
    '  * rooms_sold -> "habitaciones vendidas"',
    '  * anulada -> "anulada"  (este si va igual)',
    '  * editada -> "editada"  (este si va igual)',
    '  * pay_method=EFECTIVO/TARJETA/NEQUI -> "efectivo", "tarjeta", "Nequi"',
    '- Cuando muestres tablas o reportes, los encabezados deben ser en',
    '  espanol natural.',
    '- Cuando menciones empleados, NO digas "user=Fernanda" ni',
    '  "user_name: Fernanda", simplemente "Fernanda".',
    '- SOLO usa lenguaje tecnico si el admin pide expresamente',
    '  "detalle tecnico" o "datos sin traducir".',
    '',
    'EJEMPLO de respuesta correcta (traduccion de codigos a espanol):',
    '- MAL: "En SHIFT_1 hubo una SALE de tipo EXTRA_PERSON con check_in_ms',
    '  correspondiente a la HAB 302 que infla los rooms_sold."',
    '- BIEN: "En el Turno 1 (manana), Fernanda registro una persona',
    '  adicional en la habitacion 302, pero la cargo como venta normal en',
    '  lugar de como persona adicional. Eso hace que el numero de',
    '  habitaciones vendidas se vea mas alto de lo real."',
    '',
    'REGLAS DE CONSULTAS A BD (CRITICAS - leelas antes de cada respuesta):',
    '- Para SALUDOS (hola, qué tal, buenos días, hey, buenas) NO consultes la',
    '  BD. Respondé directamente con saludo amable y preguntale en qué podes',
    '  ayudarlo. Ejemplo: "Hola Ruben, ¿en qué te ayudo hoy?".',
    '- Para PREGUNTAS DE FECHA/HORA usá el contexto de tiempo de arriba, NO',
    '  consultes la BD.',
    '- Para PREGUNTAS SIMPLES del día (ventas hoy, ocupación, descuadre',
    '  rápido) usá MÁXIMO 2-3 queries.',
    '- Para "¿cómo va el día?" / "¿cómo vamos hoy?" hacé MÁXIMO 2 queries:',
    '  una para ventas+habitaciones VENDIDAS del día (sales), otra para',
    '  contar OCUPADAS ahora (rooms WHERE state=\'OCCUPIED\').',
    '  NUNCA digas "habitaciones activas" - es ambiguo. Reportá al admin',
    '  traduciendo al español (OCCUPIED -> "ocupadas"). Formato corto:',
    '  "Mira Ruben, hoy vamos así:',
    '   $1.250.000 en ventas hoy (15 habitaciones vendidas).',
    '   8 habitaciones ocupadas en este momento.',
    '   Sin alertas."',
    '- Solo hacé MUCHAS queries (5+) si el admin usó palabras como',
    '  "investigá", "análisis a fondo", "revisá bien", "detalle completo".',
    '- Si necesitás más queries pero el admin NO activó modo profundo,',
    '  terminá tu respuesta preguntandole: "¿Querés que investigue más a',
    '  fondo? Decime \'investigá\' al inicio de tu pregunta."'
  ].join('\n');
}

// Detecta si la pregunta del admin pide modo profundo (mas queries permitidas).
// Es match laxo: si la pregunta contiene alguna keyword, activa profundo.
function detectarModoLuciana(pregunta) {
  const txt = String(pregunta || '').toLowerCase();
  const keywords = [
    'investigá', 'investiga', 'investigar',
    'análisis a fondo', 'analisis a fondo',
    'analiza a fondo', 'analizá a fondo',
    'revisá bien', 'revisa bien',
    'detalle completo',
    'comparación detallada', 'comparacion detallada'
  ];
  for (const k of keywords) if (txt.includes(k)) return 'profundo';
  return 'normal';
}

const LUCIANA_SCHEMA_BD = `# Esquema de la base de datos Casa 50

Casa 50 es un motel/spa en Cali, Colombia. Atiende habitaciones por horas
(3h, 6h, 8h, 12h) y vende productos de bar a los huespedes. Opera 24/7
con 3 turnos: SHIFT_1 (6am-2pm), SHIFT_2 (2pm-9pm), SHIFT_3 (9pm-6am).
Los domingos hay 2 turnos 12h: SHIFT_1_12 (6am-6pm) y SHIFT_2_12 (6pm-6am,
que se NORMALIZA en BD a SHIFT_3). El "business_day" cambia a las 6am,
no a las 00:00.

Roles: ADMIN, RECEPTION, MAID (camarera), MAINTENANCE (mantenedor).

Metodos de pago: EFECTIVO, TARJETA, NEQUI, MIXTO (mas de un metodo en
la misma venta, usa amount_1/2/3 + pay_method/pay_method_2).

REGLA CRITICA: shift_id, business_day y los conteos iniciales de un turno
son INMUTABLES en BD. Si ves datos viejos, son validos para ese momento
aunque hoy parezcan raros.

---

## sales - ventas de habitacion
Cada check-in, extension de tiempo, hora gratis, renovacion, cambio de
habitacion o anulacion crea o modifica una fila aca.

Columnas clave:
- id, ts_ms, business_day, shift_id, user_role, user_name
- type: SALE (check-in normal) | EXTENSION (renovacion de tiempo) |
  EXTRA_HOUR (extension pagada por hora) | EXTRA_PERSON (persona adicional) |
  ROOM_CHANGE (cambio de habitacion, sale anterior anulada + sale nueva) |
  REFUND (devolucion) | HORA_GRATIS (cortesia) | ANULADA (marcador
  historico cuando aplica)
- room_id, category (Junior, Suite Jacuzzi, Presidencial, Suite Multiple,
  Suite Disco)
- duration_hrs (3/6/8/12), base_price, people, included_people,
  extra_people, extra_people_value, extra_hours, extra_hours_value
- total (lo que efectivamente cobro)
- pay_method (EFECTIVO/TARJETA/NEQUI/MIXTO), paid_with, change_given
- pay_method_2, amount_1, amount_2, amount_3 (para MIXTO)
- check_in_ms, due_ms, checkout_ms
- anulada (bool), anulada_ms, anulada_por
- editada (bool), editada_ms, editada_por, motivo_edicion
- devolucion_efectivo (bool), devolucion_metodo_original
- refund_reason (si es REFUND)
- arrival_type (CARRO/MOTO/A_PIE), arrival_plate
- note

Si anulada=true, NO contar en cuadres. Edicion se registra con motivo.

---

## room_products - ventas de bar a una habitacion
Productos consumidos por huespedes. Una fila por linea de venta.

Columnas clave:
- id, ts_ms, business_day, shift_id, room_id, check_in_ms
- product_id, product_name, cantidad, precio_unit, total
- pay_method (mismo set que sales)
- user_name (quien registro la venta)
- is_cortesia (bool), cortesia_destinatario (a quien se la regalaron)
- created_by_admin (true si admin la agrego manualmente)
- tipo_ajuste, motivo_ajuste (si fue correccion)

Cortesias NO afectan caja pero SI afectan stock.

---

## shift_close - cierre de turno (cuadre)
Una fila cada vez que RECEPTION o ADMIN cierra un turno.

Columnas clave:
- id, ts_ms, business_day, shift_id, user_name
- total_sales, total_refunds, total_taxi, total_loans, total_extra_staff
- total_efectivo, total_tarjeta, total_nequi (suma por metodo)
- net (sales - refunds - taxi - loans - extra_staff)
- rooms_sold, people
- cash_count (efectivo contado al cierre), cash_billetes, cash_monedas
- notes

Si cash_count != total_efectivo esperado, hay descuadre. Diferencia
positiva = sobrante, negativa = faltante.

---

## shift_inventory_start - inventario inicial del turno (INMUTABLE)
Por cada producto, cuanto habia al ABRIR el turno. Snapshot, nunca se actualiza.

PK compuesta: business_day + shift_id + product_id
- saldo_inicial, ts_ms, created_by, created_at

Sirve para validar el inventario del turno:
saldo_inicial + ingresos - ventas - cortesias = saldo_final esperado.

---

## stock_movements - movimientos de stock (auditoria completa)
Cada cambio de stock crea una fila. Es la fuente de verdad para auditar
descuadres de inventario.

Columnas clave:
- id, ts_ms, business_day, shift_id, user_name, user_role
- product_id, product_name, cantidad (positivo = entra, negativo = sale)
- tipo (string), nota

Valores conocidos de tipo:
- venta_bar - venta normal al huesped (resta stock_actual)
- venta_bar_cortesia - cortesia durante venta (resta stock_actual, no afecta caja)
- edit_venta_bar - correccion de venta existente (ajusta delta)
- delete_venta_bar - venta borrada (devuelve al stock)
- cortesia_bar - cortesia suelta (no asociada a venta)
- ajuste_venta_olvidada - venta cargada despues del cierre
- ajuste_venta_duplicada - correccion por doble carga
- ajuste_cambio_producto - cambio de producto en venta existente
- ajuste_metodo_pago (DEPRECATED - no usar para nuevos analisis,
  se reemplazo por payment_method_changes desde el Fix 3 del 23 may)
- ajuste_manual - ajuste libre por admin
- recepcion_conteo - conteo fisico de recepcion al cambio de turno
- ingreso_bodega - compra/ingreso a bodega (suma stock_bodega)
- traslado_recepcion - pasaje de bodega a recepcion (resta bodega, suma actual)
- devolucion_bodega - pasaje de recepcion a bodega (resta actual, suma bodega)

Para diagnosticar descuadres: sumar todos los movimientos del rango
contra cambio neto en products.stock_actual / stock_bodega.

---

## taxi_expenses - gastos de taxi
Gastos por taxi pagados por la caja.

Columnas clave:
- id, ts_ms, business_day, shift_id, user_role, user_name
- amount, note, room_id (si fue para huesped especifico)
- anulada, anulada_ms, anulada_por, motivo_anulacion
- editada, editada_ms, editada_por, motivo_edicion, amount_original

Resta de caja. Si anulada=true, NO descontar.

---

## general_expenses - gastos generales del turno
Gastos varios cargados por RECEPTION durante el turno (compras chicas,
servicios, propinas operativas).

Columnas clave:
- id, ts_ms, business_day, shift_id, user_name
- description, amount, category (texto libre)

Suma a "total_extra" en el cuadre del turno.

---

## gastos_mes - gastos del mes (vista admin)
Gastos cargados por ADMIN en la pestania "Gastos" agrupados por mes.

Columnas clave:
- id, ts_ms, fecha (date), mes (text 'YYYY-MM')
- categoria (texto libre), concepto, monto, pay_method
- created_by, edited_ms, edited_by, motivo_edicion, monto_original
- anulada, anulada_ms, anulada_por, motivo_anulacion

Son gastos fijos/grandes (alquiler, servicios, impuestos, sueldos).
No afectan caja del turno; son para reportes mensuales.

---

## loans - prestamos a personal
Prestamos en efectivo a empleados que descuentan de la caja.

Columnas clave:
- id, ts_ms, business_day, shift_id, user_name (quien lo registro)
- borrower_name (a quien se le presto), amount, note
- anulada, anulada_ms, anulada_por, motivo_anulacion
- editada, editada_ms, editada_por, motivo_edicion, amount_original
- manual (bool), motivo_manual

Descuentan de total_loans en shift_close.

---

## extra_staff - personal extra del turno
Empleados temporales contratados solo para un turno (suma a gastos).

Columnas clave:
- id, ts_ms, business_day, shift_id, registered_by
- person_name, area, payment, work_hours
- entry_ms, exit_ms, scheduled_exit_ms, active
- paid_ms, paid_by
- anulada, anulada_ms, anulada_por, motivo_anulacion
- editada, editada_ms, editada_por, motivo_edicion, payment_original

El pago suma a total_extra_staff en shift_close.

---

## caja_paola - caja secundaria (operativa de Paola)
Movimientos de una caja paralela manejada por Paola (admin secundaria).
Se aprueba antes de incluirse en cuadres.

Columnas clave:
- id, ts_ms, fecha (date), mes (text)
- tipo, monto, concepto, nota
- estado (PENDIENTE / APROBADA / RECHAZADA u similar - verificar en operacion)
- created_by, approved_ms, approved_by
- edited_ms, edited_by
- anulada, anulada_ms, anulada_por, motivo_anulacion

Solo cuentan las APROBADAS.

---

## descargos_nequi - descargos de Nequi
Cuando se descarga dinero acumulado en Nequi (transferencia a banco /
retiro en efectivo). Mensual, no por turno.

Columnas clave:
- id, ts_ms, fecha (date), mes (text)
- monto, nota, created_by
- anulada, anulada_ms, anulada_por

Sirve para reconciliar saldo de Nequi: total_nequi (acumulado de ventas)
- descargos = saldo actual estimado en la app.

---

## retiros_dueno - retiros del dueno
Retiros de efectivo del dueno (Ruben) desde caja.

Columnas clave:
- id, ts_ms, business_day, dia_origen, shift_id
- monto, pay_method (solo EFECTIVO o NEQUI), motivo
- user_name, user_role
- anulado, anulado_ms, anulado_por, motivo_anulacion

Descuentan de caja.

---

## ventas_gastos_anuales - agregados anuales por mes
Snapshot anual de ventas/gastos por mes (12 columnas de ventas + 12
de gastos). Editable por admin para reportes historicos.

Columnas: id, ano, ventas_ene..ventas_dic, gastos_ene..gastos_dic,
edited_ms, edited_by.

Source de la pestania "Resumen mensual" anual.

---

## rooms - estado actual de cada habitacion
Una fila por habitacion. Es el estado VIGENTE, no historico.

Columnas clave:
- room_id (PK), floor, category
- state: estado actual de la habitacion. Los valores estan en INGLES en BD.
  Cuando el admin habla en espanol, traducis al ingles para la query:
  * AVAILABLE: vacia, lista para vender. Admin la llama "LIBRE". UI: VERDE.
  * OCCUPIED: cliente adentro, generando ingreso AHORA. Admin la llama
    "OCUPADA". UI: ROJO.
  * DIRTY: cliente salio, esperando limpieza. Admin la llama "SUCIA". UI: AMARILLO.
  * CONTAMINATED: necesita limpieza profunda. Admin la llama
    "CONTAMINADA". UI: AZUL.
- state_since_ms, people, check_in_ms, due_ms, last_checkout_ms
- pay_method (ultimo usado)
- note_minor (bool), note_minor_text, note_minor_date_ms
- disabled (bool), disabled_reason, disabled_date_ms
  disabled NO es un estado: es un campo SEPARADO. Una habitacion
  puede tener disabled=true Y un state cualquiera al mismo tiempo.
  UI: GRIS cuando disabled=true (independiente del color de state).
- last_maid_name, last_maid_done_ms, last_maid_contaminated
- maid_in_progress (bool), maid_name_progress
  TAMPOCO es un estado: es un FLAG separado. Indica que una camarera
  esta limpiando AHORA. Combinado con state='DIRTY' significa "en
  limpieza"; con state='CONTAMINATED' significa "limpieza profunda
  en curso". Admin a veces lo llama "MAID_PROGRESS".
- retoque (bool)
  TAMPOCO es un estado: es un FLAG separado. Marca retoque pendiente
  o en curso. Suele coexistir con state='AVAILABLE'. Admin lo llama
  "RETOQUE". UI: BLANCO cuando retoque=true.
- arrival_type, arrival_plate, alarm_silenced_ms,
  alarm_silenced_for_due_ms
- contaminated_since_ms, checkout_obs, barcode

REGLAS CRITICAS sobre habitaciones (no las confundas):
- "habitaciones ocupadas" = state='OCCUPIED'. Son las que generan
  ingresos AHORA. Esto es lo que el admin quiere saber cuando
  pregunta "cuantas estan ocupadas?" o pide resumen del dia.
- "habitaciones libres" = state='AVAILABLE'. Listas para vender.
- NUNCA uses el termino "habitaciones activas" - es ambiguo y
  confunde al admin. Usa SIEMPRE el estado exacto.
- Cuando reportes al admin, traduci de vuelta al espanol:
  AVAILABLE -> "libres", OCCUPIED -> "ocupadas",
  DIRTY -> "sucias", CONTAMINATED -> "contaminadas".
- "habitaciones vendidas hoy" NO es lo mismo que "ocupadas ahora":
  * vendidas hoy = COUNT(*) FROM sales WHERE business_day=hoy
    (historico del dia, incluye las que ya hicieron checkout)
  * ocupadas ahora = COUNT(*) FROM rooms WHERE state='OCCUPIED'
    (estado actual, lo que esta generando ingreso en este momento)
- Si el admin habla por color: "verdes"=AVAILABLE, "rojas"=OCCUPIED,
  "amarillas"=DIRTY (incluyendo las que tengan maid_in_progress=true),
  "azules"=CONTAMINATED, "blancas"=retoque=true, "grises"=disabled=true.

Si una habitacion "se atasca" suele ser por state que no transiciona
(ej: queda en DIRTY con maid_in_progress=true porque la camarera no
marco terminado).

---

## staff - personal
Empleados con sus datos personales.

Columnas: id, name, area, type, active, cedula, celular, direccion,
contacto_emergencia, fecha_nacimiento, fecha_ingreso, fecha_vacaciones.

Si active=false, esta dado de baja. fecha_vacaciones marca el periodo
actual de vacaciones.

---

## maid_log - log de actividad de camareras
Cada inicio/fin de limpieza de habitacion. Tambien entradas/salidas
del turno.

Columnas clave:
- id, ts_ms, business_day, shift_id, maid_name, room_id
- action: INICIO_LIMPIEZA | FIN_LIMPIEZA | CANCELAR | ENTRADA |
  SALIDA | RETOQUE
- state, state_from, state_to (transicion del cuarto)
- started_ms, finished_ms (duracion real de la limpieza)
- check_in_ms, checkout_ms, category (del cuarto que limpio)
- note, exit_ms

Para auditoria: cuantas habitaciones limpio X camarera hoy?
cuanto tardo en promedio?

---

## room_issues - reportes de dano / mantenimiento
Danos reportados por recepcion/camarera/admin sobre habitaciones o
zonas comunes.

Columnas clave:
- id, ubicacion_tipo (habitacion/zona_comun), ubicacion_id (room_id si
  aplica), room_id (legacy)
- type, description, prioridad (BAJA/MEDIA/ALTA)
- estado: NOTA_ACTIVA | ESPERA_VERIFICACION | RECHAZADO_VERIFICACION |
  RESUELTO | PENDIENTE_RECEPCION
- reportado_por_rol, reportado_ms, created_by, business_day, shift_id
- foto_dano_url, foto_arreglo_url
- aprobado_por, aprobado_ms, comentario_recepcion
- arreglado_por, arreglado_ms, arreglo_nota
- verificado_por, verificado_ms, motivo_rechazo
- editada/editada_por/editada_ms
- anulada/anulada_por/anulada_ms/motivo_anulacion
- revisiones (jsonb - array de revisiones rechazadas con motivo)
- visto_por_admin (bool), visto_por_admin_ms

Flujo: reporta (NOTA_ACTIVA) -> mantenedor arregla
(ESPERA_VERIFICACION) -> recepcion verifica -> RESUELTO o
RECHAZADO_VERIFICACION (vuelve a NOTA_ACTIVA).

---

## shift_notes - informes/notas del turno
Notas que escriben los roles para comunicarse o reportar.

Columnas clave:
- id, ts_ms, business_day, shift_id, user_role, user_name
- note, target (ALL/ADMIN/MAID/RECEPTION - a quien va dirigida)
- photo_url
- is_deleted (bool), deleted_by, deleted_ms
- seen_by (texto con quien la vio)
- pasado_a_mantenimiento (bool)
- respuestas (jsonb - array de respuestas anidadas)

target define visibilidad en pestania Informes. Si is_deleted=true,
no contar.

---

## products - catalogo de productos del bar
Productos disponibles para venta.

Columnas: id, nombre, codigo_barras, precio, precio_compra, categoria,
stock_actual (recepcion), stock_bodega, stock_minimo, activo.

stock_actual = lo que hay en recepcion listo para vender.
stock_bodega = lo que esta guardado.

REGLA CRITICA: stock_actual y stock_bodega NUNCA se updatean
directamente con UPDATE. SIEMPRE via RPCs atomicos
apply_stock_actual_delta(product_id, delta) y
apply_stock_bodega_delta(product_id, delta) que evitan race conditions
en ventas concurrentes (Fix 1 del 23 may).

Si ves un cambio de stock que no paso por stock_movements, es un bug.

---

## payment_method_changes - cambios de metodo de pago
Cada vez que admin cambia el metodo de pago de una venta (sale o
room_product).

Columnas clave:
- id, sale_id (nullable), room_product_id (nullable - uno de los dos
  debe estar)
- changed_at_ms, business_day, shift_id, user_role, user_name
- old_pay_method, old_pay_method_2, old_amount_1/2/3
- new_pay_method, new_pay_method_2, new_amount_1/2/3
- total, reason

Si una venta cambio de TARJETA -> EFECTIVO, debe haber una fila aca.
La venta original conserva su pay_method actualizado.

room_product_id es lo que se sumo en el Fix 3 del 23 may para soportar
cambios de metodo sobre ventas de bar (antes solo sales).

---

## shift_log - log de login/logout de turnos
Cada entrada (LOGIN) y salida (LOGOUT) de un usuario operativo.

Columnas: id, ts_ms, business_day, shift_id, user_role, user_name,
action (LOGIN/LOGOUT), logout_ms, released (bool - true cuando el turno
cerro cuadre).

Util para auditar: quien abrio el turno SHIFT_2 del 2026-05-25?
se cerro ya?

---

## Reglas generales

1. Timestamps: ts_ms es epoch en milisegundos (Bogota local convertido).
   created_at es timestamptz cuando existe.
2. Anulacion: si una fila tiene anulada=true (o anulado=true en
   retiros_dueno), NO la sumes a metricas (a menos que el usuario te
   pida ver anuladas).
3. Edicion: editada=true significa que el monto/datos cambio
   posteriormente. amount_original / monto_original / payment_original
   guarda el valor previo.
4. Multi-turno 12h: si ves shift_id=SHIFT_3 pero la hora de ts_ms es
   6am-6pm de domingo, probablemente fue un SHIFT_2_12 normalizado.
5. Nunca modifiques datos: solo lees y sugieres. Si el admin necesita
   cambiar algo, decile que endpoint/modulo de la app usar.

---

## Contexto: fixes recientes (23 may 2026)

Hubo una serie de fixes importantes el 23 de mayo. Si analizas datos
de antes vs despues, considera esto:

- Fix 1 (atomic stock RPCs - commit 81c1a37 + d027252): se crearon
  apply_stock_actual_delta y apply_stock_bodega_delta. Antes, updates
  de stock con UPDATE simple podian pisarse en ventas concurrentes.
  Despues del 23 may, todo cambio de stock pasa por estos RPCs.

- Fix 2 (stock_movements completo - commit b59c951): se sumo la
  escritura de stock_movements en TODAS las operaciones de venta de
  bar: venta, edit, delete, cortesia. Antes, ventas de bar NO dejaban
  rastro en stock_movements (solo se actualizaba stock_actual directo).
  Despues del 23 may, los tipos venta_bar / venta_bar_cortesia /
  edit_venta_bar / delete_venta_bar / cortesia_bar aparecen aca.
  Si auditas stock_movements de antes del 23 may para entender ventas
  de bar, NO los vas a encontrar - usa room_products en ese caso.

- Fix 3 (payment_method_changes para bar - commit e8c6311): se sumo
  room_product_id a payment_method_changes. Antes, cambios de metodo
  de pago sobre ventas de bar se registraban con tipo='ajuste_metodo_pago'
  en stock_movements (deprecated). Despues del 23 may, van limpios a
  payment_method_changes con room_product_id.

- Fix auto-cobro (commit 184b8e0): el auto-cobro de horas vencidas
  ahora rechaza si el servidor no confirma que la habitacion esta
  vencida hace >=30min. Antes podia haber falsos positivos.
`;

// ==================== LUCIANA — Tool Use (queries en vivo) ====================
// Tool unica que Claude puede invocar para leer datos de la BD.
// Tres capas defensivas: regex en JS, RPC luciana_query con read-only
// transaction, y LIMIT 100 forzado. Detalle en migrations/20260525_luciana_query_rpc.sql.
const LUCIANA_TOOL_QUERY = {
  name: 'query_supabase',
  description:
    'Ejecuta una query SQL SELECT de solo lectura en la BD de Casa 50. ' +
    'Solo SELECT (o WITH ... SELECT). Maximo 100 filas. Timeout 10s. ' +
    'Solo las 22 tablas del schema descritas arriba. ' +
    'NO se permiten INSERT/UPDATE/DELETE/DROP ni nada destructivo. ' +
    'Devuelve un JSON array de objetos. ' +
    'Usala cuando necesites datos concretos para responder al admin ' +
    '(ej: descuadre del dia, ventas por turno, comparar foto vs sistema). ' +
    'NO la uses para preguntas que podes contestar con el schema solo.',
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'Query SQL SELECT. Ejemplo: SELECT shift_id, SUM(total) ' +
          'AS total FROM sales WHERE business_day = \'2026-05-25\' ' +
          'AND anulada IS NOT TRUE GROUP BY shift_id'
      }
    },
    required: ['sql']
  }
};

// LUCIANA_LIMITS limita TURNOS del modelo (iter) y queries TOTALES por modo.
// Normal: dia a dia, preguntas simples. Profundo: investigaciones que pide
// el admin con keywords ("investigá", "análisis a fondo", etc).
// Sin el limite de queries totales Claude puede pedir 4 queries por turno x
// N turnos y disparar el costo, aunque iter este capado.
const LUCIANA_LIMITS = {
  normal:   { iter: 3,  queries: 6  },
  profundo: { iter: 12, queries: 20 }
};

// Capa 1: validacion regex previa.
function validarSqlLuciana(sqlRaw) {
  const s = String(sqlRaw || '').trim();
  if (!s) throw new Error('SQL vacio');
  if (s.length > 2000) throw new Error('SQL muy largo (max 2000 chars)');
  const sinFinal = s.replace(/;\s*$/, '');
  if (sinFinal.includes(';')) throw new Error('No se permiten multiples statements');
  if (!/^(SELECT|WITH)\s/i.test(sinFinal)) {
    throw new Error('Solo SELECT (o WITH ... SELECT). Empieza con: ' + sinFinal.slice(0, 30));
  }
  const blacklist = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COMMIT|ROLLBACK|CALL|COPY|VACUUM|REINDEX|CLUSTER|LOCK|REFRESH|REASSIGN|SET\s+ROLE|SET\s+SESSION|RESET|LISTEN|NOTIFY|PREPARE|DEALLOCATE|DISCARD|LOAD|FETCH|MOVE|DECLARE|CLOSE)\b/i;
  if (blacklist.test(sinFinal)) {
    throw new Error('Palabra clave no permitida en el SQL');
  }
  const schemasBloqueados = /\b(pg_catalog|information_schema|pg_user|pg_roles|pg_authid|pg_shadow|auth\.|storage\.|luciana_chats)\b/i;
  if (schemasBloqueados.test(sinFinal)) {
    throw new Error('No se puede consultar esquemas internos ni luciana_chats');
  }
  return sinFinal;
}

// Capa 3: limite 100 filas. Si ya tiene LIMIT, lo capamos a 100.
// Si no, envolvemos en subquery.
function envolverConLimit(sql) {
  if (/\bLIMIT\s+\d+/i.test(sql)) {
    return sql.replace(/\bLIMIT\s+(\d+)/i, function(_, n) {
      return 'LIMIT ' + Math.min(Number(n), 100);
    });
  }
  return 'SELECT * FROM (' + sql + ') AS luciana_sub LIMIT 100';
}

async function ejecutarQueryLuciana(sqlRaw) {
  const sqlValidado = validarSqlLuciana(sqlRaw);
  const sqlLimitado = envolverConLimit(sqlValidado);
  const { data, error } = await supabase.rpc('luciana_query', { query_text: sqlLimitado });
  if (error) throw new Error(error.message);
  // La RPC devuelve {error: msg} si fallo el EXECUTE interno (ej: tabla no existe)
  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
    throw new Error(data.error);
  }
  return Array.isArray(data) ? data : [];
}

function detectarMoodLuciana(respuesta) {
  const txt = String(respuesta || '').toLowerCase();
  // Preocupado gana sobre alegre (seguridad operativa: si hay
  // problemas mencionados, no sonreir aunque tambien diga "todo ok").
  const preocupado = [
    'descuadre', 'no cuadra', 'no cuadran', 'faltan', 'falta ',
    'error', 'problema', 'problemas', 'sospech', 'atascad',
    'robo', 'perdid', 'deuda', 'danad', 'dañad', 'roto', 'rota'
  ];
  for (const k of preocupado) if (txt.includes(k)) return 'preocupado';

  const alegre = [
    'perfecto', 'excelente', 'todo ok', 'todo bien', 'sin problemas',
    'cuadra perfecto', 'ningun problema', 'ningún problema',
    'todo en orden', 'completo', 'sin novedad'
  ];
  for (const k of alegre) if (txt.includes(k)) return 'alegre';

  return 'neutro';
}

async function apiLucianaChat(p, res) {
  // Validacion estricta: SOLO admin
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') {
    return err(res, 'Solo el administrador puede usar Luciana', 403);
  }
  // Bloqueo por admin especifico: si el admin tiene ver_luciana=false en
  // admin_pins, no puede usar Luciana aunque su rol sea ADMIN (caso lisset).
  const quien = String(p.userName || '').trim().toLowerCase();
  if (quien) {
    const { data: adminRow } = await tSelect('admin_pins','ver_luciana')
      .eq('user_name', quien).maybeSingle();
    if (adminRow && adminRow.ver_luciana === false) {
      return err(res, 'Este administrador no tiene acceso a Luciana', 403);
    }
  }
  const pregunta = String(p.pregunta || '').trim();
  if (!pregunta) return err(res, 'Pregunta vacia', 400);
  if (pregunta.length > 4000) return err(res, 'Pregunta muy larga (max 4000)', 400);

  if (!process.env.ANTHROPIC_API_KEY) {
    return err(res, 'ANTHROPIC_API_KEY no configurada en Vercel', 500);
  }

  const now = Date.now();
  const bDay = businessDay(now);
  const userName = String(p.userName || 'admin').slice(0, 100);
  const fotoUrl = String(p.fotoUrl || '').trim() || null;
  const convId = String(p.conversacionId || '').slice(0, 64) || null;

  // Si vino foto, fetchear y convertir a base64 para vision.
  // Restringimos a URLs del propio bucket por seguridad (evita SSRF).
  let imageBlock = null;
  if (fotoUrl) {
    const allowedPrefix = (process.env.SUPABASE_URL || '') + '/storage/v1/object/public/luciana-photos/';
    if (!fotoUrl.startsWith(allowedPrefix)) {
      return err(res, 'fotoUrl no permitida (solo bucket luciana-photos)', 400);
    }
    try {
      const r = await fetch(fotoUrl);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      const buf = Buffer.from(await r.arrayBuffer());
      imageBlock = {
        type: 'image',
        source: { type: 'base64', media_type: ct, data: buf.toString('base64') }
      };
    } catch (e) {
      console.error('fetch foto error:', e);
      return err(res, 'No se pudo cargar la foto: ' + (e.message || 'error'), 502);
    }
  }

  const userContent = imageBlock
    ? [imageBlock, { type: 'text', text: pregunta }]
    : pregunta;

  // Historial multi-turno: ultimas 10 preguntas/respuestas del business_day
  // actual. Permite seguimiento de hilo ("y en el SHIFT_3?" referido al
  // SHIFT_2 de la pregunta anterior). Solo texto - fotos viejas no se
  // re-fetchean. Si falla, seguimos sin historial.
  let historial = [];
  try {
    let q = tSelect('luciana_chats', 'pregunta, respuesta');
    q = convId ? q.eq('conversacion_id', convId)   // hilo actual
               : q.eq('business_day', bDay);        // fallback compat clientes viejos
    const { data: prevs } = await q
      .order('ts_ms', { ascending: false })
      .limit(10);
    historial = (prevs || []).reverse().flatMap(c => [
      { role: 'user',      content: c.pregunta },
      { role: 'assistant', content: c.respuesta }
    ]);
  } catch (e) {
    console.error('luciana historial load error:', e);
  }

  // Modo (normal/profundo) detectado por keywords en la pregunta. Profundo
  // permite mas iter y mas queries totales (para investigaciones).
  const modoUsado = detectarModoLuciana(pregunta);
  const limits = LUCIANA_LIMITS[modoUsado];
  const maxIter = limits.iter;
  const maxQueries = limits.queries;

  // Loop tool_use: Claude puede pedir query_supabase y nosotros la ejecutamos.
  // Doble limite: maxIter (turnos del modelo) y maxQueries (queries totales,
  // incluyendo paralelas dentro de un mismo turno).
  // Acumulamos tokens de TODAS las iteraciones para auditoria de costo.
  let messages = [...historial, { role: 'user', content: userContent }];
  let response = null;
  let totIn = 0, totOut = 0, totCR = 0, totCW = 0;
  let queriesEjecutadas = 0;
  let iteraciones = 0;
  // motivo: 'end_turn' (Claude termino normal) | 'limit_iter' (agoto turnos)
  // | 'limit_queries' (agoto queries totales)
  let motivo = 'end_turn';

  for (let iter = 0; iter < maxIter; iter++) {
    iteraciones = iter + 1;
    try {
      response = await anthropic.messages.create({
        model: LUCIANA_MODEL,
        max_tokens: 4000,
        tools: [LUCIANA_TOOL_QUERY],
        // System en 2 bloques: base corto sin cache + schema BD con
        // cache_control ephemeral (TTL 5min).
        system: [
          { type: 'text', text: lucianaSystemBase(userName) },
          { type: 'text', text: LUCIANA_SCHEMA_BD, cache_control: { type: 'ephemeral' } }
        ],
        messages: messages
      });
    } catch (e) {
      console.error('Anthropic error iter ' + iter + ':', e);
      return err(res, 'Luciana no disponible: ' + (e.message || 'error'), 502);
    }

    const u = response.usage || {};
    totIn  += u.input_tokens  || 0;
    totOut += u.output_tokens || 0;
    totCR  += u.cache_read_input_tokens     || 0;
    totCW  += u.cache_creation_input_tokens || 0;

    if (response.stop_reason !== 'tool_use') {
      motivo = 'end_turn';
      break;
    }
    if (iter === maxIter - 1) {
      motivo = 'limit_iter';
      break;
    }

    // Procesar cada tool_use block y armar tool_results. Si llegamos al
    // limite total de queries, devolvemos is_error para las restantes
    // (Claude las ve como fallidas y deberia parar de pedir mas).
    const toolUses = (response.content || []).filter(b => b.type === 'tool_use');
    const toolResults = [];
    let cortadoPorLimite = false;
    for (const tu of toolUses) {
      if (queriesEjecutadas >= maxQueries) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Error: limite de queries alcanzado (' + maxQueries +
            '). Respondele al admin con lo que ya sabes o pedile que use modo profundo.',
          is_error: true
        });
        cortadoPorLimite = true;
        continue;
      }
      queriesEjecutadas++;
      let content, isError = false;
      try {
        const sql = String((tu.input || {}).sql || '');
        const rows = await ejecutarQueryLuciana(sql);
        content = JSON.stringify(rows);
        // Truncar respuestas gigantes para no romper el contexto de Claude
        if (content.length > 50000) {
          content = content.slice(0, 50000) + '...[TRUNCADO ' + content.length + ' chars totales]';
        }
      } catch (e) {
        content = 'Error: ' + (e.message || 'unknown');
        isError = true;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: content,
        is_error: isError
      });
    }
    // Appendear assistant (con tool_use blocks) + user (con tool_results)
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    if (cortadoPorLimite && queriesEjecutadas >= maxQueries) {
      // Le damos un turno mas a Claude para que responda con lo que sabe,
      // pero marcamos el motivo. Si en ese turno vuelve a pedir tool_use,
      // saldra por limit_iter o limit_queries en la proxima vuelta.
      motivo = 'limit_queries';
    }
  }

  let respuesta = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  // Fallback claro si el loop termino sin texto util (paso siempre que
  // motivo != end_turn y Claude no alcanzo a redactar respuesta final).
  let truncado = false;
  if (!respuesta) {
    respuesta = 'Disculpame Ruben, esta consulta requiere mas investigacion. ' +
      '¿Querés que investigue más a fondo? Decime "investigá" al inicio de tu pregunta.';
    truncado = true;
  }

  console.log('[luciana] modo=' + modoUsado +
    ' queries=' + queriesEjecutadas + '/' + maxQueries +
    ' iters=' + iteraciones + '/' + maxIter +
    ' motivo=' + motivo +
    ' truncado=' + truncado +
    ' user=' + userName +
    ' preg=' + JSON.stringify(pregunta.slice(0, 80)));

  const mood = detectarMoodLuciana(respuesta);

  // Costo USD: input $3, output $15, cache_write $3.75 (1.25x), cache_read $0.30 (0.1x)
  const costoUsd = (totIn * 3 + totOut * 15 + totCW * 3.75 + totCR * 0.30) / 1_000_000;

  // Guardar en BD (best-effort: si falla, igual devolvemos la respuesta)
  try {
    await tInsert('luciana_chats',{
      ts_ms: now,
      user_name: userName,
      business_day: bDay,
      pregunta,
      respuesta,
      foto_url: fotoUrl,
      tokens_input: totIn,
      tokens_output: totOut,
      tokens_cache_read: totCR,
      tokens_cache_write: totCW,
      costo_usd: costoUsd,
      mood,
      conversacion_id: convId
    });
  } catch (e) {
    console.error('luciana_chats insert error:', e);
  }

  return ok(res, {
    respuesta,
    mood,
    modoUsado,
    tokensIn: totIn,
    tokensOut: totOut,
    queries: queriesEjecutadas,
    costoUsd: Number(costoUsd.toFixed(6)),
    truncado
  });
}

// Suma el costo USD y tokens del mes calendario actual (no business_day).
// Solo ADMIN. Para alimentar el contador "Mes: $X" del header del modal.
async function apiLucianaGastoMes(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') {
    return err(res, 'Solo el administrador', 403);
  }
  // Mes calendario en horario Bogota (UTC-5)
  const d = new Date(Date.now() - 5 * 3600000);
  const yyyymm = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');

  // luciana_chats.business_day es 'YYYY-MM-DD' -> LIKE 'YYYY-MM%'
  const { data, error } = await tSelect('luciana_chats', 'costo_usd, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write')
    .like('business_day', yyyymm + '%');

  if (error) {
    console.error('lucianaGastoMes error:', error);
    return err(res, 'Error consultando gasto: ' + error.message, 500);
  }

  let totalUsd = 0, totIn = 0, totOut = 0, totCR = 0, totCW = 0;
  (data || []).forEach(r => {
    totalUsd += Number(r.costo_usd || 0);
    totIn    += Number(r.tokens_input  || 0);
    totOut   += Number(r.tokens_output || 0);
    totCR    += Number(r.tokens_cache_read  || 0);
    totCW    += Number(r.tokens_cache_write || 0);
  });

  return ok(res, {
    mes: yyyymm,
    totalUsd: Number(totalUsd.toFixed(4)),
    preguntas: (data || []).length,
    tokensIn: totIn, tokensOut: totOut,
    cacheRead: totCR, cacheWrite: totCW
  });
}

// ============== BANDEJA DE QUEJAS Y RECLAMOS (Pieza 7) ==============
// UNA bandeja, DOS fuentes, ETIQUETADAS distinto porque no valen lo mismo:
//
//   VERIFICADA (app_calificaciones) -> la ficha la creo el POS en el checkout
//     con los datos REALES de la venta. Solo entran las YA calificadas
//     (estrellas IS NOT NULL): las de estrellas en NULL son fichas pendientes
//     que el cliente todavia no lleno, no opiniones, y no van a la bandeja.
//
//   DECLARADA (app_quejas) -> queja libre. Habitacion, nombre y fecha los DICE
//     el cliente y el sistema NO los puede verificar.
//
// Las metricas serias (promedio de estrellas) salen SOLO de las verificadas.
// Mezclar las declaradas ahi seria inventar un dato: cualquiera con una cuenta
// podria hundir el promedio del motel sin haberse hospedado nunca.
async function apiGetQuejas(p, res) {
  if (!requireAdmin(p)) return err(res, 'No autorizado', 403);

  const { data: cal } = await tSelect('app_calificaciones',
      'id, habitacion, comprobante_num, entrada_ms, duracion_hrs, recepcionista, estrellas, resena, calificado_ms, creado')
    .not('estrellas', 'is', null)
    .order('calificado_ms', { ascending: false })
    .limit(200);

  const { data: qj } = await tSelect('app_quejas',
      'id, habitacion_dicha, nombre_dicho, estadia_dicha_ms, texto, estrellas, estado, atendida_por, atendida_ms, nota_interna, creado')
    .order('creado', { ascending: false })
    .limit(200);

  const verificadas = (cal || []).map(function(r) {
    return {
      tipo: 'VERIFICADA',
      id: r.id,
      fechaMs: Number(r.calificado_ms || 0) || new Date(r.creado).getTime(),
      habitacion: String(r.habitacion || ''),
      nombre: '',
      texto: String(r.resena || ''),
      estrellas: r.estrellas == null ? null : Number(r.estrellas),
      estadiaMs: Number(r.entrada_ms || 0),
      duracionHrs: Number(r.duracion_hrs || 0),
      comprobanteNum: r.comprobante_num == null ? null : Number(r.comprobante_num),
      recepcionista: String(r.recepcionista || ''),
      estado: null, notaInterna: '', atendidaPor: '', atendidaMs: 0
    };
  });

  const declaradas = (qj || []).map(function(r) {
    return {
      tipo: 'DECLARADA',
      id: r.id,
      fechaMs: new Date(r.creado).getTime(),
      habitacion: String(r.habitacion_dicha || ''),
      nombre: String(r.nombre_dicho || ''),
      texto: String(r.texto || ''),
      estrellas: r.estrellas == null ? null : Number(r.estrellas),
      estadiaMs: Number(r.estadia_dicha_ms || 0),
      duracionHrs: 0, comprobanteNum: null, recepcionista: '',
      estado: String(r.estado || 'NUEVA'),
      notaInterna: String(r.nota_interna || ''),
      atendidaPor: String(r.atendida_por || ''),
      atendidaMs: Number(r.atendida_ms || 0)
    };
  });

  const bandeja = verificadas.concat(declaradas).sort(function(a, b) { return b.fechaMs - a.fechaMs; });

  const conEstrellas = verificadas.filter(function(v) { return v.estrellas != null; });
  const promedio = conEstrellas.length
    ? Math.round((conEstrellas.reduce(function(s, v) { return s + v.estrellas; }, 0) / conEstrellas.length) * 10) / 10
    : 0;

  return ok(res, {
    bandeja: bandeja,
    metricas: {
      promedioVerificadas: promedio,
      totalVerificadas: verificadas.length,
      totalDeclaradas: declaradas.length,
      nuevasSinAtender: declaradas.filter(function(d) { return d.estado === 'NUEVA'; }).length
    }
  });
}

// Mueve el estado de una queja DECLARADA (NUEVA -> LEIDA -> RESUELTA) y guarda
// la nota interna. Esto lo escribe SOLO el POS: el cliente no tiene UPDATE
// sobre app_quejas. atendida_por sale del TOKEN, no del body, para que la
// auditoria no se pueda falsear.
async function apiMarcarQueja(p, res) {
  const s = requireAdmin(p);
  if (!s) return err(res, 'No autorizado', 403);

  const id = String(p.quejaId || '');
  const estado = String(p.estado || '').toUpperCase();
  if (!id) return err(res, 'Falta la queja');
  if (['NUEVA','LEIDA','RESUELTA'].indexOf(estado) < 0) return err(res, 'Estado invalido');

  const patch = {
    estado: estado,
    atendida_por: String(s.n || ''),
    atendida_ms: Date.now()
  };
  if (p.notaInterna !== undefined) patch.nota_interna = String(p.notaInterna || '').slice(0, 1000);

  // tUpdate scopea por motel_id: nadie puede tocar la queja de otro motel.
  const { error } = await tUpdate('app_quejas', patch).eq('id', id);
  if (error) return err(res, 'Error actualizando la queja: ' + error.message);
  return ok(res, {});
}
