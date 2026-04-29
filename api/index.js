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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==================== PRECIOS ====================
const MASTER_PRICING = {
  'Junior':         { h3:60000,  h6:120000, h8:85000,   h12:105000, extraHour:20000, extraPerson:20000, included:2 },
  'Suite Jacuzzi':  { h3:85000,  h6:170000, h8:110000,  h12:130000, extraHour:25000, extraPerson:25000, included:2 },
  'Presidencial':   { h3:105000, h6:210000, h8:130000,  h12:145000, extraHour:30000, extraPerson:30000, included:2 },
  'Suite Multiple': { h3:135000, h6:270000, h8:195000,  h12:235000, extraHour:35000, extraPerson:30000, included:4 },
  'Suite Disco':    { h3:180000, h6:360000, h8:260000,  h12:315000, extraHour:35000, extraPerson:30000, included:4 }
};

// ==================== HELPERS ====================
function businessDay(ms) {
  const d = new Date((ms || Date.now()) - 5 * 3600000);
  if (d.getUTCHours() < 6) d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  if (shiftId === 'SHIFT_2_12') return 'SHIFT_2';
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

async function getSettings() {
  const { data } = await supabase.from('settings').select('key, value');
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return map;
}
async function getRoom(roomId) {
  const { data } = await supabase.from('rooms').select('*').eq('room_id', roomId).single();
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
    payMethod: r.pay_method || ''
  };
}
// ==================== HELPER DE PAGINACION ====================
// Trae TODAS las filas de una consulta Supabase, paginando en lotes de 1000.
// Se usa para consultas de rangos largos (ej: mes completo) donde Supabase
// corta por defecto a 1000 filas aunque pidas mas con .range().
//
// Uso: const sales = await fetchAll(() => supabase.from('sales').select('...').like('business_day', '2026-04%'));
async function fetchAll(queryBuilder, batchSize = 1000) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryBuilder().range(from, from + batchSize - 1);
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
      case 'checkOut':          return await apiCheckOut(payload, res);
      case 'extendTime':        return await apiExtendTime(payload, res);
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
      case 'addLoan':           return await apiAddLoan(payload, res);
      case 'getLoans':          return await apiGetLoans(payload, res);
      case 'registerExtraStaff':return await apiRegisterExtra(payload, res);
      case 'updateExtraStaff':  return await apiUpdateExtra(payload, res);
      case 'deleteExtra':       return await apiDeleteExtra(payload, res);
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
      case 'getSchedule':       return await apiGetSchedule(payload, res);
      case 'saveSchedule':      return await apiSaveSchedule(payload, res);
      case 'setMultiMaidMode':  return await apiSetMultiMaidMode(payload, res);
      case 'getMultiMaidMode':  return await apiGetMultiMaidMode(payload, res);
      case 'setDailyGoal':      return await apiSetGoal(payload, res);
      case 'setReceptionPin':   return await apiSetPin(payload, res);
      case 'deleteReceptionPin':return await apiDeletePin(payload, res);
      case 'getReceptionPins':  return await apiGetPins(payload, res);
      case 'changeAdminPin':    return await apiChangeAdminPin(payload, res);
      case 'roomHistory':       return await apiRoomHistory(payload, res);
      case 'markNoteSeen':      return await apiMarkNoteSeen(payload, res);
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
      case 'getProducts':            return await apiGetProducts(payload, res);
      case 'saveProduct':            return await apiSaveProduct(payload, res);
      case 'deleteProduct':          return await apiDeleteProduct(payload, res);
      case 'addStock':               return await apiAddStock(payload, res);
      case 'ingresoBodega':          return await apiIngresoBodega(payload, res);
      case 'trasladoRecepcion':      return await apiTrasladoRecepcion(payload, res);
      case 'devolverABodega':        return await apiDevolverABodega(payload, res);
      case 'agregarPersonaManual':   return await apiAgregarPersonaManual(payload, res);
      case 'getHabitacionesTurno':   return await apiGetHabitacionesTurno(payload, res);
      case 'getExtrasHabitacion':    return await apiGetExtrasHabitacion(payload, res);
      case 'agregarHoraExtraManual': return await apiAgregarHoraExtraManual(payload, res);
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
      case 'updatePrecioCompra': return await apiUpdatePrecioCompra(payload, res);
      case 'changePaymentMethod': return await apiChangePaymentMethod(payload, res);
      default: return err(res, 'Funcion desconocida: ' + fn);
    }
  } catch (e) {
    console.error('API Error:', e);
    return err(res, e.message || 'Error interno', 500);
  }
};

// ==================== BOOTSTRAP ====================
async function apiBootstrap(req, res) {
  const now = Date.now();
  const settings = await getSettings();
  const { data: rooms } = await supabase.from('rooms').select('*').order('floor').order('room_id');
  return ok(res, {
    settings, rooms: (rooms || []).map(mapRoom),
    masterPricing: MASTER_PRICING, serverNowMs: now,
    businessDay: businessDay(now), currentShiftId: currentShiftId(now),
    shifts: [
      { id: 'SHIFT_1', label: 'Turno 1 (6am-2pm)' },
      { id: 'SHIFT_2', label: 'Turno 2 (2pm-9pm)' },
      { id: 'SHIFT_3', label: 'Turno 3 (9pm-6am)' }
    ]
  });
}

async function apiGetRooms(req, res) {
  const { data: rooms } = await supabase.from('rooms').select('*').order('floor').order('room_id');
  return ok(res, { rooms: (rooms || []).map(mapRoom) });
}

// ==================== LOGIN ====================
async function apiLogin(p, res) {
  const now = Date.now();
  let bDay = businessDay(now);
  let shift = String(p.shiftId||'').trim()||currentShiftId(now);
  shift = normalizeShiftId(shift);
  if(!['SHIFT_1','SHIFT_2','SHIFT_3'].includes(shift)) shift=currentShiftId(now);

  // FIX T3 MEDIANOCHE (item 1):
  // Solo cambia a SHIFT_1 si el logout del T3 fue en la madrugada (0h-6h)
  // Si son las 9pm-11pm y hay un logout del T3 de la madrugada anterior, no cambia
  if(shift==='SHIFT_3'){
    const nowHour = new Date(now + (-5*3600000)).getUTCHours();
    // Solo verificar si estamos en la madrugada (0am-6am)
    if(nowHour >= 0 && nowHour < 6){
      const{data:logoutT3}=await supabase.from('shift_log').select('id,ts_ms').eq('business_day',bDay).eq('shift_id','SHIFT_3').eq('action','LOGOUT').limit(1);
      if(logoutT3&&logoutT3.length){
        const logoutHour = new Date(Number(logoutT3[0].ts_ms) + (-5*3600000)).getUTCHours();
        // Solo cambia a SHIFT_1 si el logout fue tambien en la madrugada
        if(logoutHour >= 0 && logoutHour < 6){
          shift = 'SHIFT_1';
          // Avanzar el business_day un día porque este SHIFT_1 pertenece al dia siguiente comercialmente
          const tomorrow = new Date(now + 24 * 3600 * 1000);
          bDay = tomorrow.toISOString().slice(0,10);
        }
      }
    }
  }

  const userName = String(p.userName || '').trim();
  const userRole = String(p.userRole || '').toUpperCase();
  const forceEntry = p.forceEntry === true || p.forceEntry === 'true'; // Admin fuerza entrada
  if (!userName) return err(res, 'Nombre requerido');
  if (!userRole) return err(res, 'Rol requerido');

  const tenMinsAgo = now - 10 * 60 * 1000;
  const { data: fails } = await supabase.from('login_failures')
    .select('ts_ms').eq('user_name', userName.toLowerCase()).eq('user_role', userRole)
    .gt('ts_ms', tenMinsAgo).order('ts_ms', { ascending: false });
  if (fails && fails.length >= 3) {
    const wait = Math.ceil((Number(fails[0].ts_ms) + 5 * 60 * 1000 - now) / 60000);
    if (wait > 0) return err(res, `Demasiados intentos. Espera ${wait} minuto(s).`);
  }

  if (userRole === 'ADMIN') {
    const settings = await getSettings();
    const expected = String(settings.ADMIN_CODE || '2206');
    if (String(p.adminCode || '') !== expected) {
      await supabase.from('login_failures').insert({ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'ADMIN', ip: '' });
      return err(res, 'PIN de administrador incorrecto.');
    }
    await supabase.from('shift_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'ADMIN', user_name: userName, action: 'LOGIN' });
    return ok(res, { session: { userName, userRole: 'ADMIN', shiftId: shift, businessDay: bDay, serverNowMs: now } });
  }

  if (userRole === 'RECEPTION') {
    const { data: pinRow } = await supabase.from('reception_pins').select('pin').eq('user_name', userName).single();
    if (!pinRow) {
      await supabase.from('login_failures').insert({ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'RECEPTION', ip: '' });
      return err(res, 'Recepcionista no autorizada. Contacte al administrador.');
    }
    if (String(p.userPin || '') !== String(pinRow.pin || '')) {
      await supabase.from('login_failures').insert({ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'RECEPTION', ip: '' });
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
      const { data: prevLogin } = await supabase.from('shift_log')
        .select('user_name')
        .eq('business_day', prevBDay)
        .eq('shift_id', prevShiftId)
        .eq('user_role', 'RECEPTION')
        .in('action', ['LOGIN', 'RELOGIN'])
        .order('ts_ms')
        .limit(1);

      if(prevLogin && prevLogin.length) {
        const { data: prevReleased } = await supabase.from('shift_log')
          .select('id')
          .eq('business_day', prevBDay)
          .eq('shift_id', prevShiftId)
          .eq('action', 'LOGOUT')
          .eq('released', true)
          .limit(1);

        if(!prevReleased || !prevReleased.length) {
          if(userName.toLowerCase() !== prevLogin[0].user_name.toLowerCase()) {
            // Verificar si el nuevo turno ya fue abierto (nueva logica)
            const { data: newShiftOpen } = await supabase.from('shift_log')
              .select('id')
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

    const { data: existing } = await supabase.from('shift_log').select('user_name').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'RECEPTION').eq('action', 'LOGIN').order('ts_ms').limit(1).single();
    if (existing && existing.user_name.toLowerCase() !== userName.toLowerCase()) {
      const { data: logout } = await supabase.from('shift_log').select('id').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'RECEPTION').eq('action', 'LOGOUT').limit(1);
    if (!logout || !logout.length) {
        // No bloquear — permitir reingreso
      }
    }
 await supabase.from('shift_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, action: existing ? 'RELOGIN' : 'LOGIN' });
    const { data: lastLogout } = await supabase.from('shift_log').select('logout_ms').eq('business_day', bDay).eq('shift_id', shift).eq('action', 'LOGOUT').order('ts_ms', { ascending: false }).limit(1);
    const fromMs = lastLogout && lastLogout.length ? Number(lastLogout[0].logout_ms || 0) : 0;
    return ok(res, { session: { userName, userRole: 'RECEPTION', shiftId: shift, businessDay: bDay, serverNowMs: now, fromMs } });
  }

  if (userRole === 'MAID') {
    await supabase.from('shift_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'MAID', user_name: userName, action: 'LOGIN' });
    return ok(res, { session: { userName, userRole: 'MAID', shiftId: shift, businessDay: bDay, serverNowMs: now } });
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
  const bDay = businessDay(now);
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
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

  const cfg = MASTER_PRICING[room.category] || MASTER_PRICING['Junior'];
  if (room.category === 'Suite Multiple' && durationHrs === 6 && !cfg.h6) {
    return err(res, 'Suite Multiple no tiene precio para 6h');
  }

  const basePrice = calcPrice(durationHrs, cfg);
  if (!basePrice) return err(res, 'Precio no definido para esa duracion');

  const includedPeople = Number(cfg.included || 2);
  const people = Math.max(includedPeople, Number(p.people || includedPeople));
  const extraPeople = Math.max(0, people - includedPeople);
  const extraPeopleValue = extraPeople * Number(cfg.extraPerson || 0);
  const total = roomId === '304' ? 0 : basePrice + extraPeopleValue;
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

  await supabase.from('rooms').update({
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: now, due_ms: dueMs,
    arrival_type: arrivalType, arrival_plate: arrivalPlate,
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0, retoque: false,
    pay_method: payMethod,
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await supabase.from('sales').insert({
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

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'AVAILABLE', to_state: 'OCCUPIED', people,
    meta_json: JSON.stringify({ durationHrs, basePrice, total, dueMs, arrivalType, arrivalPlate, payMethod, paidWith, changeGiven, checkInMs: now, extraPeople, extraPeopleValue })
  });

  await openCashDrawer();
  return ok(res, { roomId, total, change: changeGiven, checkInMs: now, dueMs });
}

// ==================== CHECK-OUT ====================
async function apiCheckOut(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.sessionShiftId||'').trim() || currentShiftId(now);
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

  await supabase.from('rooms').update({
    state: 'DIRTY', state_since_ms: now, people: 0,
    due_ms: 0, last_checkout_ms: now,
    arrival_type: '', arrival_plate: '',
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: obs, contaminated_since_ms: 0,
    pay_method: '',
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'OCCUPIED', to_state: 'DIRTY', people: 0,
    meta_json: JSON.stringify({ lastCheckoutMs: now, checkoutObs: obs })
  });

  const checkInMs = Number(room.check_in_ms || 0);
  if (checkInMs > 0) {
    await supabase.from('sales')
      .update({ checkout_ms: now })
      .eq('room_id', roomId)
      .eq('type', 'SALE')
      .eq('check_in_ms', checkInMs);
  }
  return ok(res, { roomId, checkoutMs: now });
}

// ==================== EXTENDER TIEMPO ====================
async function apiExtendTime(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const extraHrs = Number(p.extraHrs || 0);
  if (![1,2,3,4,5,6].includes(extraHrs)) return err(res, 'Horas extra invalidas (1-6)');
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');
  const cfg = MASTER_PRICING[room.category] || MASTER_PRICING['Junior'];
  const extraCost = extraHrs * Number(cfg.extraHour || 0);
  const newDueMs = Number(room.due_ms || now) + extraHrs * 3600000;
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();
  const note = String(p.note || '').trim();
  await supabase.from('rooms').update({ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('sales').insert({
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

async function apiHoraGratis(p, res) {
  const now = Date.now();
  const roomId = String(p.roomId || '').trim();
  const room = await getRoom(roomId);
  if(!room) return err(res, 'Habitacion no existe');
  if(room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');
  const checkInMs = Number(room.check_in_ms || 0);
  const { data: existing } = await supabase.from('sales')
    .select('id').eq('room_id', roomId).eq('type', 'HORA_GRATIS')
    .gte('check_in_ms', checkInMs).limit(1);
  if(existing && existing.length) return err(res, 'Ya se obsequio la hora gratis para esta habitacion');
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const newDueMs = Number(room.due_ms || now) + 3600000;
  await supabase.from('rooms').update({ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('sales').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, type: 'HORA_GRATIS', room_id: roomId, category: room.category, total: 0, pay_method: 'EFECTIVO', check_in_ms: checkInMs });
  return ok(res, { roomId, newDueMs });
}

// ==================== RENOVAR TIEMPO ====================
async function apiRenewTime(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const durationHrs = Number(p.durationHrs || 0);
  if (![3, 6, 8, 12].includes(durationHrs)) return err(res, 'Duracion invalida para renovar (3/6/8/12)');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');

  const cfg = MASTER_PRICING[room.category] || MASTER_PRICING['Junior'];
  const renewPrice = calcPrice(durationHrs, cfg);
  if (!renewPrice) return err(res, 'Precio no definido para esa duracion');

  const newDueMs = Number(room.due_ms || now) + durationHrs * 3600000;
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();

  await supabase.from('rooms').update({ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('sales').insert({
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
  await supabase.from('rooms').update({ alarm_silenced_ms: Date.now(), alarm_silenced_for_due_ms: Number(room.due_ms || 0), updated_at: new Date().toISOString() }).eq('room_id', roomId);
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
    await supabase.from('rooms').update({retoque:false,state:'AVAILABLE',state_since_ms:now,updated_at:new Date().toISOString()}).eq('room_id',roomId);
    return ok(res,{roomId,maidName,startedMs:now,retoque:true});
  }

  await supabase.from('maid_log').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    maid_name: maidName, room_id: roomId,
    action: 'START', state: room.state, note: '',
    started_ms: now, finished_ms: 0,
    state_from: room.state, state_to: '',
    check_in_ms: Number(room.check_in_ms || 0),
    checkout_ms: Number(room.last_checkout_ms || 0),
    category: String(room.category || '')
  });
  await supabase.from('rooms').update({
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

  const { data: openLog } = await supabase.from('maid_log')
    .select('id, started_ms, ts_ms')
    .eq('maid_name', maidName).eq('room_id', roomId).eq('business_day', bDay)
    .eq('action', 'START').eq('finished_ms', 0)
    .order('ts_ms', { ascending: false }).limit(1);

  let startedMs = openLog && openLog.length ? Number(openLog[0].started_ms || openLog[0].ts_ms) : now;
  const lastCheckoutMs = Number(room.last_checkout_ms || 0);
  const dirtyMins = lastCheckoutMs ? Math.max(0, Math.round((now - lastCheckoutMs) / 60000)) : 0;
  const cleanMins = Math.max(0, Math.round((now - startedMs) / 60000));

  await supabase.from('rooms').update({
    state: resultState, state_since_ms: now,
    last_maid_name: maidName, last_maid_done_ms: now,
    contaminated_since_ms: resultState === 'CONTAMINATED' ? now : 0,
    maid_in_progress: resultState === 'CONTAMINATED' ? true : false,
    maid_name_progress: resultState === 'CONTAMINATED' ? maidName : '',
    retoque: false,
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'MAID', user_name: maidName, room_id: roomId,
    from_state: room.state, to_state: resultState, people: 0,
    meta_json: JSON.stringify({ maidName, lastCheckoutMs, startedMs, finishedMs: now, dirtyMins, cleanMins, contaminated: resultState === 'CONTAMINATED' })
  });

  if (openLog && openLog.length) {
    if(resultState !== 'CONTAMINATED'){
      await supabase.from('maid_log').update({
        action: 'FINISH', finished_ms: now, state_to: resultState,
        note: p.note || ''
      }).eq('id', openLog[0].id);
    }
  } else {
    if(resultState !== 'CONTAMINATED'){
      await supabase.from('maid_log').insert({
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
  await supabase.from('maid_log').insert({
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
  await supabase.from('maid_log').update({ finished_ms: now }).eq('maid_name', maidName).eq('room_id', roomId).eq('business_day', bDay).eq('finished_ms', 0);
  return ok(res, { exitMs: now });
}

async function apiGetMaidLog(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('maid_log').select('*').eq('business_day', bDay).order('ts_ms');
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

  await supabase.from('rooms').update({
    state: 'AVAILABLE', state_since_ms: now, contaminated_since_ms: 0,
    maid_in_progress: false, maid_name_progress: '',
    updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: p.userRole||'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'CONTAMINATED', to_state: 'AVAILABLE', people: 0,
    meta_json: JSON.stringify({action:'clearContaminated', maidName: userName})
  });

  const { data: openLog } = await supabase.from('maid_log')
    .select('id, started_ms')
    .eq('room_id', roomId).eq('business_day', bDay)
    .eq('action', 'START').eq('finished_ms', 0)
    .order('ts_ms', { ascending: false }).limit(1);

  if (openLog && openLog.length) {
    await supabase.from('maid_log').update({
      action: 'FINISH', finished_ms: now, state_to: 'AVAILABLE',
      note: p.note || '',
      check_in_ms: Number(room.check_in_ms || 0),
      checkout_ms: Number(room.last_checkout_ms || 0),
      category: String(room.category || '')
    }).eq('id', openLog[0].id);
  } else {
    await supabase.from('maid_log').insert({
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
  await supabase.from('rooms').update({
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
  await supabase.from('rooms').update({ disabled: disableFlag, disabled_date_ms: disableFlag ? now : 0, disabled_reason: disableFlag ? reason : '', updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('maintenance').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: userRole, user_name: String(p.userName || 'ADMIN'), room_id: roomId, type: disableFlag ? 'DISABLE' : 'ENABLE', text: disableFlag ? reason : 'HABILITADA', repair_desc: String(p.repairDesc||''), repair_cost: Number(p.repairCost||0) });
  return ok(res, { roomId, disabled: disableFlag });
}

// ITEM 9: Devolucion - descuenta solo el monto indicado
async function apiRefund(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.sessionShiftId||'').trim() || currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const amount = Math.max(1, Number(p.amount || 0));
  const reason = String(p.refundReason || '').trim();
  if (reason.length < 3) return err(res, 'Motivo obligatorio');
  const room = await getRoom(roomId);
  // Insertar devolucion como venta negativa - se descuenta del cuadre automaticamente
  await supabase.from('sales').insert({
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
  const bDay = businessDay(now);
  const shift = String(p.sessionShiftId||'').trim() || currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const { data } = await supabase.from('taxi_expenses').insert({
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
  if(!id) return err(res, 'id requerido');
  await supabase.from('taxi_expenses').delete().eq('id', id);
  return ok(res, { deleted: true });
}

// ==================== PRESTAMOS ====================
async function apiAddLoan(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.shiftId || '').trim() || currentShiftId(now);
  const borrowerName = String(p.borrowerName || '').trim();
  const amount = Number(p.amount || 0);
  if (!borrowerName) return err(res, 'Nombre requerido');
  if (amount <= 0) return err(res, 'Monto invalido');
  await supabase.from('loans').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_name: String(p.userName || ''), borrower_name: borrowerName, amount, note: String(p.note || '') });
  return ok(res, {});
}

async function apiGetLoans(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('loans').select('*').eq('business_day', bDay).order('ts_ms');
  return ok(res, { loans: (data || []).map(r => ({ tsMs: Number(r.ts_ms), shiftId: r.shift_id, userName: r.user_name, borrowerName: r.borrower_name, amount: Number(r.amount), note: r.note })) });
}

// ==================== PERSONAL EXTRA ====================
async function apiRegisterExtra(p, res) {
  const now = Date.now();
  const bDay = String(p.businessDay || businessDay(now));
  const shift = String(p.shiftId || currentShiftId(now));
  const personName = String(p.personName || '').trim();
  const area = String(p.area || 'Servicios').trim();
  const entryMs = Number(p.entryMs || now);
  const scheduledExitMs = Number(p.scheduledExitMs || 0);
  const workHours = Number(p.workHours || 0);
  if (!personName) return err(res, 'Nombre requerido');
  await supabase.from('extra_staff').insert({
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
  await supabase.from('extra_staff').update({
    person_name: personName, area, entry_ms: entryMs,
    scheduled_exit_ms: scheduledExitMs, work_hours: workHours,
    shift_id: shift
  }).eq('id', id);
  return ok(res, { updated: true });
}

async function apiDeleteExtra(p, res) {
  const id = Number(p.id || 0);
  if (!id) return err(res, 'ID requerido');
  await supabase.from('extra_staff').delete().eq('id', id);
  return ok(res, { deleted: true });
}

async function apiCheckoutExtra(p, res) {
  const now = Date.now();
  const personName = String(p.personName || '').trim();
  const payment = Number(p.payment || 0);
  const exitMs = Number(p.exitMs || now);
  const paidBy = String(p.paidBy || p.userName || '').trim();
  if (!personName) return err(res, 'Nombre requerido');
  if (payment <= 0) return err(res, 'Pago requerido');

  const { data } = await supabase.from('extra_staff').select('id').eq('person_name', personName).eq('active', true).order('ts_ms', { ascending: false }).limit(1);
  if (!data || !data.length) return err(res, `No se encontro "${personName}" activo`);

  await supabase.from('extra_staff').update({ exit_ms: exitMs, payment, active: false, paid_ms: now, paid_by: paidBy }).eq('id', data[0].id);
  return ok(res, { personName, payment, paidBy });
}

async function apiGetExtra(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('extra_staff').select('*').eq('business_day', bDay).order('ts_ms');
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
  await supabase.from('shift_notes').update({photo_url: null}).eq('id', noteId);
  return ok(res, {});
}

async function apiAddNote(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const target = String(p.target || 'ALL').toUpperCase();
  let photoUrl = null;
  if(p.photoUrl){ photoUrl = String(p.photoUrl); }
  await supabase.from('shift_notes').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: String(p.userRole || ''), user_name: String(p.userName || ''),
    note: String(p.note || ''), target,
    seen_by: '[]', is_deleted: false,
    photo_url: photoUrl
  });
  return ok(res, {});
}

async function apiGetNotes(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('shift_notes').select('*')
    .eq('business_day', bDay).eq('is_deleted', false)
    .order('ts_ms', { ascending: false }).limit(100);
  return ok(res, { notes: (data || []).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms), shiftId: r.shift_id,
    userRole: r.user_role, userName: r.user_name, note: r.note,
    target: r.target || 'ALL', seenBy: JSON.parse(r.seen_by || '[]'),
    businessDay: r.business_day, photoUrl: r.photo_url || null
  })) });
}

async function apiMarkNoteSeen(p, res) {
  const noteId = Number(p.noteId || 0);
  const userRole = String(p.userRole || '').toUpperCase();
  if (!noteId) return err(res, 'noteId requerido');
  const { data } = await supabase.from('shift_notes').select('seen_by').eq('id', noteId).single();
  if (!data) return err(res, 'Nota no encontrada');
  let seenBy = [];
  try { seenBy = JSON.parse(data.seen_by || '[]'); } catch(e) {}
  if (!seenBy.includes(userRole)) seenBy.push(userRole);
  await supabase.from('shift_notes').update({ seen_by: JSON.stringify(seenBy) }).eq('id', noteId);
  return ok(res, { noteId, seenBy });
}

async function apiDeleteNote(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const noteId = Number(p.noteId || 0);
  if (!noteId) return err(res, 'noteId requerido');
  await supabase.from('shift_notes').update({ is_deleted: true }).eq('id', noteId);
  return ok(res, { noteId });
}

async function apiGetAllNotes(p, res) {
  const limit = Math.min(200, Number(p.limit || 100));
  const fromDate = String(p.fromDate || '');
  let query = supabase.from('shift_notes').select('*').eq('is_deleted', false).order('ts_ms', { ascending: false }).limit(limit);
  if (fromDate) query = query.gte('business_day', fromDate);
  const { data } = await query;
  return ok(res, { notes: (data || []).map(r => ({
    id: r.id, tsMs: Number(r.ts_ms), shiftId: r.shift_id,
    userRole: r.user_role, userName: r.user_name, note: r.note,
    target: r.target || 'ALL', seenBy: JSON.parse(r.seen_by || '[]'),
    businessDay: r.business_day
  })) });
}

async function apiGetNoteHistory(p, res) {
  const limit = Math.min(200, Number(p.limit || 100));
  const fromDate = String(p.fromDate || '');
  let query = supabase.from('shift_notes').select('*').eq('is_deleted', false).order('ts_ms', { ascending: false }).limit(limit);
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

  // Marcar turno como cerrado Y liberado (released=true)
  await supabase.from('shift_log').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName,
    action: 'LOGOUT', logout_ms: now,
    released: true // NUEVO: libera el turno siguiente
  });

  const { data: loginLog } = await supabase.from('shift_log')
    .select('ts_ms').eq('shift_id', shift).eq('user_role', 'RECEPTION')
    .in('action', ['LOGIN', 'RELOGIN']).eq('user_name', userName)
    .order('ts_ms', { ascending: false }).limit(1);
  const loginMs = loginLog && loginLog.length ? Number(loginLog[0].ts_ms) : (now - 9*3600000);

  const [salesRes, taxiRes, loansRes, extraRes, prodRes] = await Promise.all([
    supabase.from('sales').select('type,total,pay_method,people,room_id').eq('shift_id', shift).gte('ts_ms', loginMs),
    supabase.from('taxi_expenses').select('amount').eq('shift_id', shift).gte('ts_ms', loginMs),
    supabase.from('loans').select('amount').eq('shift_id', shift).gte('ts_ms', loginMs),
    supabase.from('extra_staff').select('payment').eq('shift_id', shift).gte('ts_ms', loginMs),
    supabase.from('room_products').select('total,pay_method,is_cortesia').eq('shift_id', shift).gte('ts_ms', loginMs)
  ]);

  let totalSales=0, totalRefunds=0, totalTaxi=0, totalLoans=0, totalExtraStaff=0;
  let roomsSold=0, people=0, totalEfectivo=0, totalTarjeta=0, totalNequi=0;
  let totalProductos=0, totalProductosEf=0, totalProductosTa=0, totalProductosNq=0;

  (salesRes.data || []).forEach(r => {
    if (r.anulada) return;
    if (String(r.room_id) === '304') return;
    const t = Number(r.total||0), pm = String(r.pay_method||'').toUpperCase();
    if (r.type === 'SALE') { totalSales+=t; roomsSold++; people+=Number(r.people||0); if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
    if (r.type === 'REFUND') totalRefunds += t;
    if (r.type === 'RENEWAL') { totalSales+=t; roomsSold++; people+=Number(r.people||0); if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
    if (r.type === 'EXTENSION') { totalSales+=t; if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
  });
  (taxiRes.data||[]).forEach(r=>{totalTaxi+=Number(r.amount||0);});
  (prodRes.data||[]).forEach(r=>{
    if(r.is_cortesia)return;
    const t=Number(r.total||0);
    const pm=String(r.pay_method||'').toUpperCase();
    totalProductos+=t;
    if(pm==='EFECTIVO')totalProductosEf+=t;
    else if(pm==='TARJETA')totalProductosTa+=t;
    else if(pm==='NEQUI')totalProductosNq+=t;
  });
  (loansRes.data||[]).forEach(r=>{totalLoans+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{totalExtraStaff+=Number(r.payment||0);});

  const net = totalSales + totalRefunds - totalTaxi - totalLoans - totalExtraStaff;

  await supabase.from('shift_close').insert({
    ts_ms: now, business_day: bDay, shift_id: shift, user_name: userName,
    total_sales: totalSales, total_refunds: totalRefunds, total_taxi: totalTaxi,
    total_loans: totalLoans, total_extra_staff: totalExtraStaff, net,
    rooms_sold: roomsSold, people, cash_count: Number(p.cashCount||0),
    cash_billetes: Number(p.cashBilletes||0),
    cash_monedas: Number(p.cashMonedas||0),
    notes: String(p.notes||''), total_efectivo: totalEfectivo,
    total_tarjeta: totalTarjeta, total_nequi: totalNequi,
    total_productos: totalProductos,
    total_productos_ef: totalProductosEf,
    total_productos_ta: totalProductosTa,
    total_productos_nq: totalProductosNq
  });

  // Bar bar_sales removido - duplicaba valores de room_products
  return ok(res, { summary: { bizDay: bDay, shiftId: shift, totalSales, totalRefunds, totalTaxi, totalLoans, totalExtraStaff, net, roomsSold, people, totalEfectivo, totalTarjeta, totalNequi } });
}

// ==================== METRICAS ====================
async function apiMetrics(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const shiftFilter = String(p.shiftId || '');

  const [salesRes, taxiRes, loansRes, extraRes, barRes, gastoRes, settingsRes, shiftLogRes, shiftCloseRes] = await Promise.all([
    supabase.from('sales').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('taxi_expenses').select('*').eq('business_day', bDay),
    supabase.from('loans').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('extra_staff').select('*').eq('business_day', bDay),
    supabase.from('bar_sales').select('*').eq('business_day', bDay),
    supabase.from('general_expenses').select('*').eq('business_day', bDay),
    supabase.from('settings').select('key,value'),
    supabase.from('shift_log').select('user_name,shift_id').eq('business_day', bDay).eq('user_role','RECEPTION').eq('action','LOGIN').order('ts_ms'),
    supabase.from('shift_close').select('shift_id,cash_count,cash_billetes,cash_monedas,net,total_efectivo,ts_ms').eq('business_day', bDay)
  ]);

  const settings={};(settingsRes.data||[]).forEach(r=>{settings[r.key]=r.value;});
  const dailyGoal=Number(settings.DAILY_GOAL||0);
  let dayTotal=0,dayRefunds=0,dayTaxi=0,dayBar=0,dayGastos=0,dayLoans=0,dayExtraStaff=0;
  let dayEfe=0,dayTar=0,dayNeq=0;
  let shiftSales=0,shiftRooms=0,shiftPeople=0,shiftEfe=0,shiftTar=0,shiftNeq=0,shiftTaxi=0,shiftBar=0,shiftGastos=0;
  const allSalesList=[];

  (salesRes.data||[]).forEach(r=>{
    const t=Number(r.total||0),type=r.type,pm=String(r.pay_method||'').toUpperCase(),sid=r.shift_id;
    const isRev=type==='SALE'||type==='EXTENSION'||type==='RENEWAL';
    if(r.anulada)return;
    const skip304 = String(r.room_id) === '304';
    if(isRev){
      if(!skip304){
        dayTotal+=t;
        if(pm==='EFECTIVO')dayEfe+=t;else if(pm==='TARJETA')dayTar+=t;else if(pm==='NEQUI')dayNeq+=t;else if(pm==='MIXTO'){dayEfe+=Number(r.amount_1||0);dayTar+=Number(r.amount_2||0);dayNeq+=Number(r.amount_3||0);}
      }
      if(type==='SALE'||type==='RENEWAL'||type==='EXTENSION')allSalesList.push({id:r.id,tsMs:Number(r.ts_ms),shiftId:sid,roomId:r.room_id,category:r.category,type,durationHrs:Number(r.duration_hrs||0),people:Number(r.people||0),total:t,extraPeople:Number(r.extra_people||0),extraPeopleValue:Number(r.extra_people_value||0),arrivalType:r.arrival_type||'',arrivalPlate:r.arrival_plate||'',payMethod:pm,paidWith:Number(r.paid_with||0),change:Number(r.change_given||0),userName:r.user_name,checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:Number(r.due_ms||0),amount_1:Number(r.amount_1||0),amount_2:Number(r.amount_2||0),amount_3:Number(r.amount_3||0),note:String(r.note||''),checkoutMs:Number(r.checkout_ms||0)});
      if(!shiftFilter||sid===shiftFilter){
        if(!skip304){
          shiftSales+=t;
          if(pm==='EFECTIVO')shiftEfe+=t;else if(pm==='TARJETA')shiftTar+=t;else if(pm==='NEQUI')shiftNeq+=t;else if(pm==='MIXTO'){shiftEfe+=Number(r.amount_1||0);shiftTar+=Number(r.amount_2||0);shiftNeq+=Number(r.amount_3||0);}
          if(type==='SALE'){shiftRooms++;shiftPeople+=Number(r.people||0);}
        }
      }
    }
    if(type==='REFUND'){dayRefunds+=t;if(!shiftFilter||sid===shiftFilter)shiftSales+=t;allSalesList.push({id:r.id,tsMs:Number(r.ts_ms),shiftId:sid,roomId:r.room_id,category:r.category||'',type:'REFUND',durationHrs:0,people:0,total:t,payMethod:pm,userName:r.user_name,checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:0,amount_1:0,amount_2:0,amount_3:0,note:r.refund_reason||''});}
  });
const {data:prodSales}=await supabase.from('room_products').select('*').eq('business_day',bDay);
  const prodSalesFilt=(prodSales||[]).filter(s=>!shiftFilter||s.shift_id===shiftFilter);
  const totalProductos=prodSalesFilt.filter(s=>!s.is_cortesia).reduce((a,s)=>a+Number(s.total||0),0);
  const totalCortesiasProds=prodSalesFilt.filter(s=>s.is_cortesia).reduce((a,s)=>a+Number(s.total||0),0);
  const totalProductosEf=prodSalesFilt.filter(s=>!s.is_cortesia&&s.pay_method==='EFECTIVO').reduce((a,s)=>a+Number(s.total||0),0);
  const totalProductosTa=prodSalesFilt.filter(s=>!s.is_cortesia&&s.pay_method==='TARJETA').reduce((a,s)=>a+Number(s.total||0),0);
  const totalProductosNq=prodSalesFilt.filter(s=>!s.is_cortesia&&s.pay_method==='NEQUI').reduce((a,s)=>a+Number(s.total||0),0);
  const taxiList=[];
  (taxiRes.data||[]).forEach(r=>{
    const a=Number(r.amount||0);
    dayTaxi+=a;
    if(!shiftFilter||(r.shift_id||'').toUpperCase()===shiftFilter)shiftTaxi+=a;
    taxiList.push({id:r.id,tsMs:Number(r.ts_ms),shiftId:r.shift_id,roomId:r.room_id||'',amount:a,businessDay:r.business_day||''});
  });

 let dayBarEfe=0,dayBarTar=0,dayBarNeq=0,shiftBarEfe=0,shiftBarTar=0,shiftBarNeq=0;
  (barRes.data||[]).forEach(r=>{const a=Number(r.amount_cash||0)+Number(r.amount_card||0)+Number(r.amount_nequi||0);dayBar+=a;dayBarEfe+=Number(r.amount_cash||0);dayBarTar+=Number(r.amount_card||0);dayBarNeq+=Number(r.amount_nequi||0);if(!shiftFilter||r.shift_id===shiftFilter){shiftBar+=a;shiftBarEfe+=Number(r.amount_cash||0);shiftBarTar+=Number(r.amount_card||0);shiftBarNeq+=Number(r.amount_nequi||0);}});
  const{data:roomProdsBar}=await supabase.from('room_products').select('shift_id,pay_method,total,is_cortesia').eq('business_day',bDay).eq('is_cortesia',false);
  (roomProdsBar||[]).forEach(r=>{const t=Number(r.total||0),pm=String(r.pay_method||'EFECTIVO').toUpperCase();dayBar+=t;if(pm==='TARJETA'){dayBarTar+=t;}else if(pm==='NEQUI'){dayBarNeq+=t;}else{dayBarEfe+=t;}if(!shiftFilter||r.shift_id===shiftFilter){shiftBar+=t;if(pm==='TARJETA'){shiftBarTar+=t;}else if(pm==='NEQUI'){shiftBarNeq+=t;}else{shiftBarEfe+=t;}}});
  (extraRes.data||[]).forEach(r=>{dayExtraStaff+=Number(r.payment||0);});

  const dayNet=dayTotal+dayBar+dayRefunds-dayTaxi-dayLoans-dayExtraStaff-dayGastos;
  const shiftNet=shiftSales+shiftBar-shiftTaxi-shiftGastos;

  return ok(res,{
    businessDay:bDay,
    totals:{
      sales:dayTotal,bar:dayBar,refunds:dayRefunds,taxi:dayTaxi,loans:dayLoans,extraStaff:dayExtraStaff,gastos:dayGastos,net:dayNet,
      totalEfectivo:dayEfe,totalTarjeta:dayTar,totalNequi:dayNeq,
      barEfectivo:dayBarEfe,barTarjeta:dayBarTar,barNequi:dayBarNeq,
      shiftNet,shiftSales,shiftRoomsSold:shiftRooms,shiftPeople,shiftBar,shiftTaxi,shiftGastos,
      shiftEfectivo:shiftEfe,shiftTarjeta:shiftTar,shiftNequi:shiftNeq,
      shiftBarEfectivo:shiftBarEfe,shiftBarTarjeta:shiftBarTar,shiftBarNequi:shiftBarNeq,
      totalProductos,totalCortesiasProds,totalProductosEf,totalProductosTa,totalProductosNq
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
  const { data } = await supabase.from('sales')
    .select('ts_ms, total, type')
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
  const salesData = await fetchAll(() => supabase.from('sales')
    .select('business_day,shift_id,type,total,pay_method,extra_people_value,amount_1,amount_2,amount_3,people,user_name,room_id,duration_hrs,anulada')
    .like('business_day', ym+'%'));
  const maidLogsData = await fetchAll(() => supabase.from('maid_log')
    .select('maid_name,finished_ms,started_ms,state_to')
    .like('business_day', ym+'%'));
  const roomProdsData = await fetchAll(() => supabase.from('room_products')
    .select('business_day,shift_id,pay_method,total,is_cortesia')
    .like('business_day', ym+'%'));

  // Queries pequeñas — se mantienen con Promise.all normal
  const [taxiRes, loansRes, extraRes, failuresRes, shiftLogRes, barSalesRes] = await Promise.all([
    supabase.from('taxi_expenses').select('business_day,shift_id,amount').like('business_day', ym+'%'),
    supabase.from('loans').select('business_day,shift_id,amount').like('business_day', ym+'%'),
    supabase.from('extra_staff').select('business_day,shift_id,payment').like('business_day', ym+'%').gt('payment',0),
    supabase.from('shift_failures').select('*').like('business_day', ym+'%'),
    supabase.from('shift_log').select('business_day,shift_id,user_name').like('business_day', ym+'%').eq('user_role','RECEPTION').in('action',['LOGIN','RELOGIN']),
    supabase.from('bar_sales').select('business_day,shift_id,amount_cash,amount_card,amount_nequi').like('business_day', ym+'%')
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
  (salesRes.data||[]).forEach(r=>{
    if(r.anulada)return;
    if(String(r.room_id)==='304') return;
    const d=getDay(r.business_day);
    const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';
    const s=d[sid];
    const t=Number(r.total||0), pm=String(r.pay_method||'EFECTIVO').toUpperCase();
    const epv=Number(r.extra_people_value||0);
 if(r.type==='SALE'){
      d.roomsSold++;d.people+=Number(r.people||0);s.roomsSold++;
      const base=t-epv;
      if(pm==='TARJETA'){s.tj_hab+=base;s.tj_padd+=epv;}
      else if(pm==='NEQUI'){s.nq_hab+=base;s.nq_padd+=epv;}
      else if(pm==='MIXTO'){s.ef_hab+=Number(r.amount_1||0);s.tj_hab+=Number(r.amount_2||0);s.nq_hab+=Number(r.amount_3||0);}
      else{s.ef_hab+=base;s.ef_padd+=epv;}
    }
    if(r.type==='EXTENSION'||r.type==='RENEWAL'){
      if(pm==='TARJETA')s.tj_had+=t;
      else if(pm==='NEQUI')s.nq_had+=t;
      else if(pm==='MIXTO'){s.ef_had+=Number(r.amount_1||0);s.tj_had+=Number(r.amount_2||0);s.nq_had+=Number(r.amount_3||0);}
      else s.ef_had+=t;
    }
  });

  // Bar productos
  (roomProdsRes.data||[]).forEach(r=>{
    if(r.is_cortesia)return;
    const d=getDay(r.business_day);
    const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';
    const s=d[sid], pm=String(r.pay_method||'EFECTIVO').toUpperCase(), t=Number(r.total||0);
    if(pm==='TARJETA')s.tj_bar+=t;
    else if(pm==='NEQUI')s.nq_bar+=t;
    else s.ef_bar+=t;
  });


  // Gastos
  (taxiRes.data||[]).forEach(r=>{const d=getDay(r.business_day);const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';d[sid].taxis+=Number(r.amount||0);});
  (loansRes.data||[]).forEach(r=>{const d=getDay(r.business_day);const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';d[sid].gastos+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{const d=getDay(r.business_day);const sid=SHIFTS.includes(r.shift_id)?r.shift_id:'SHIFT_1';d[sid].turnos+=Number(r.payment||0);});

  const days = Object.values(dayMap).sort((a,b)=>a.day.localeCompare(b.day));

  // Calcular netos por turno y totales por día
  days.forEach(d=>{
    d.totalTarjeta=0;d.totalEfectivo=0;d.totalNequi=0;d.totalGastos=0;d.netodia=0;
    SHIFTS.forEach(sid=>{
      const s=d[sid];
      s.totalTarjeta=s.tj_hab+s.tj_padd+s.tj_had+s.tj_bar;
      s.totalEfectivo=s.ef_hab+s.ef_padd+s.ef_had+s.ef_bar;
      s.totalNequi=s.nq_hab+s.nq_padd+s.nq_had+s.nq_bar;
      s.totalGastos=s.gastos+s.taxis+s.turnos;
   s.netoTurno=s.totalTarjeta+s.totalEfectivo+s.totalNequi-s.totalGastos;
      d.totalTarjeta+=s.totalTarjeta;
      d.totalEfectivo+=s.totalEfectivo;
      d.totalNequi+=s.totalNequi;
      d.totalGastos+=s.totalGastos;
    });
    d.netodia=d.totalTarjeta+d.totalEfectivo+d.totalNequi-d.totalGastos;
  });

  const monthTotals={sales:0,tarjeta:0,efectivo:0,nequi:0,gastos:0,neto:0,roomsSold:0,people:0,expenses:0};
  days.forEach(d=>{
    monthTotals.tarjeta+=d.totalTarjeta;
    monthTotals.efectivo+=d.totalEfectivo;
    monthTotals.nequi+=d.totalNequi;
    monthTotals.gastos+=d.totalGastos;
    monthTotals.neto+=d.netodia;
    monthTotals.roomsSold+=d.roomsSold;
    monthTotals.people+=d.people||0;
  });
  monthTotals.sales=monthTotals.tarjeta+monthTotals.efectivo+monthTotals.nequi;
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
    supabase.from('rooms').select('*').order('room_id'),
    supabase.from('state_history').select('*').eq('business_day', bDay),
    supabase.from('maid_log').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('shift_log').select('*').eq('business_day', bDay).eq('user_role', 'MAID').in('action', ['LOGIN', 'RELOGIN'])
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
    stateFrom:r.state_from||'', stateTo:r.state_to||''
  }));

  return ok(res, { bizDay:bDay, serverShift:shift, activeMaids:Object.values(activeMaids), dirtyRooms, contaminatedRooms, shiftReport, serverNowMs:now, maidLogs });
}

// ==================== PERSONAL / CALENDARIO ====================
async function apiGetStaff(p, res) {
  const { data } = await supabase.from('staff').select('*').order('area').order('name');
  return ok(res, { staff: (data||[]).map(r=>({
    id:r.id, name:r.name, area:r.area, type:r.type, active:r.active,
    cedula:r.cedula||'', celular:r.celular||'', direccion:r.direccion||'',
    contactoEmergencia:r.contacto_emergencia||'', fechaNacimiento:r.fecha_nacimiento||'',
    fechaIngreso:r.fecha_ingreso||'', fechaVacaciones:r.fecha_vacaciones||''
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
  if(id){await supabase.from('staff').update({name,area,active,...extra}).eq('id',id);}
  else{await supabase.from('staff').insert({id:'S'+Date.now(),name,area,type:'nomina',active,created_ms:Date.now(),...extra});}
  return ok(res,{});
}

async function apiGetSchedule(p, res) {
  const ws=String(p.weekStart||'').trim();
  let query=supabase.from('schedule').select('*');
  if(ws)query=query.eq('week_start',ws);
  const{data}=await query.order('shift_id').order('area');
  return ok(res,{schedule:(data||[]).map(r=>({weekStart:r.week_start,shiftId:r.shift_id,area:r.area,personName:r.person_name,dayOfWeek:r.day_of_week,type:r.type,horaEntrada:r.hora_entrada||'',horaSalida:r.hora_salida||'',extraNombre:r.extra_nombre||'',extraTurno:r.extra_turno||''}))});
}

async function apiSaveSchedule(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo el administrador puede guardar el calendario');
  const ws=String(p.weekStart||'').trim(),entries=p.entries||[];
  if(!ws)return err(res,'Semana requerida');
  const mesPrefix=ws.substring(0,7);
  const existingRes=await supabase.from('schedule').select('id,area,person_name,day_of_week,type');
  const existing=existingRes.data||[];
  const personasEnEntradas=[...new Set(entries.map(function(e){return e.area+'|'+e.personName;}))];
  const toDelete=(existing||[]).filter(function(r){
    if(!String(r.day_of_week||'').startsWith(mesPrefix))return false;
    if(String(r.type||'').startsWith('extra')||String(r.type||'')==='extra_day')return false;
    return personasEnEntradas.indexOf(r.area+'|'+r.person_name)>=0;
  }).map(function(r){return r.id;});
  if(toDelete.length>0){await supabase.from('schedule').delete().in('id',toDelete);}
  if(entries.length>0){
    const rows=entries.map(e=>({week_start:ws,shift_id:String(e.shiftId||''),area:String(e.area||''),person_name:String(e.personName||''),day_of_week:String(e.dayOfWeek||''),type:String(e.type||'normal'),hora_entrada:String(e.horaEntrada||''),hora_salida:String(e.horaSalida||''),extra_nombre:String(e.extraNombre||''),extra_turno:String(e.extraTurno||'')}));
    await supabase.from('schedule').insert(rows);
  }
  return ok(res,{saved:entries.length,weekStart:ws});
}

// ==================== CONFIG ====================
async function apiSetMultiMaidMode(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const value=p.enabled?'true':'false';
  await supabase.from('settings').upsert({key:'MULTI_MAID_MODE',value},{onConflict:'key'});
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
  await supabase.from('settings').upsert({key:'DAILY_GOAL',value:String(goal)},{onConflict:'key'});
  return ok(res,{goal});
}
async function apiSetPin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const targetName=String(p.targetName||'').trim(),pin=String(p.pin||'').trim();
  if(!targetName)return err(res,'Nombre requerido');
  await supabase.from('reception_pins').upsert({user_name:targetName,pin,updated_at:new Date().toISOString()},{onConflict:'user_name'});
  return ok(res,{});
}
async function apiDeletePin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const targetName=String(p.targetName||'').trim();
  if(!targetName)return err(res,'Nombre requerido');
  await supabase.from('reception_pins').delete().eq('user_name',targetName);
  return ok(res,{});
}
async function apiGetPins(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const{data}=await supabase.from('reception_pins').select('user_name, pin');
  return ok(res,{pins:(data||[]).map(r=>({userName:r.user_name,hasPin:!!String(r.pin||'').trim()}))});
}
async function apiChangeAdminPin(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo ADMIN');
  const cur=String(p.currentPin||''),nw=String(p.newPin||'');
  const settings=await getSettings();
  if(cur!==String(settings.ADMIN_CODE||'2206'))return err(res,'PIN actual incorrecto');
  if(nw.length<4||!/^\d+$/.test(nw))return err(res,'PIN invalido');
  await supabase.from('settings').upsert({key:'ADMIN_CODE',value:nw},{onConflict:'key'});
  return ok(res,{});
}

async function apiRoomHistory(p, res) {
  const roomId=String(p.roomId||'').trim();
  if(!roomId)return err(res,'roomId requerido');
  const limit=Number(p.limit||30);
  const[stateRes,salesRes,taxiRes]=await Promise.all([
    supabase.from('state_history').select('*').eq('room_id',roomId).order('ts_ms',{ascending:false}).limit(limit),
    supabase.from('sales').select('*').eq('room_id',roomId).in('type',['SALE','EXTENSION','RENEWAL','HORA_GRATIS']).order('ts_ms',{ascending:false}).limit(limit),
    supabase.from('taxi_expenses').select('*').eq('room_id',roomId).order('ts_ms',{ascending:false}).limit(10)
  ]);
  return ok(res,{
    roomId,
    stateHistory:(stateRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),businessDay:r.business_day,fromState:r.from_state,toState:r.to_state,userName:r.user_name,meta:(()=>{try{return JSON.parse(r.meta_json||'{}');}catch(e){return{};}})()})),
    salesHistory:(salesRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),businessDay:r.business_day,shiftId:r.shift_id||'',type:r.type,durationHrs:Number(r.duration_hrs||0),total:Number(r.total||0),people:Number(r.people||0),extraPeople:Number(r.extra_people||0),extraPeopleValue:Number(r.extra_people_value||0),arrivalType:r.arrival_type||'',arrivalPlate:r.arrival_plate||'',userName:r.user_name,payMethod:r.pay_method||'',checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:Number(r.due_ms||0)})),
    taxiHistory:(taxiRes.data||[]).map(r=>({id:r.id,tsMs:Number(r.ts_ms),amount:Number(r.amount||0)}))
  });
}

// ==================== BAR / GASTOS ====================
async function apiAddBarSale(p, res) {
  const now=Date.now(),bDay=businessDay(now),shift=currentShiftId(now);
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Solo RECEPTION o ADMIN');
  const cash=Number(p.amountCash||0),card=Number(p.amountCard||0),nequi=Number(p.amountNequi||0);
  if(cash+card+nequi<=0)return err(res,'Monto total debe ser mayor a 0');
  await supabase.from('bar_sales').insert({ts_ms:now,business_day:bDay,shift_id:shift,user_name:String(p.userName||''),description:String(p.description||'').trim(),amount_cash:cash,amount_card:card,amount_nequi:nequi,total:cash+card+nequi});
  return ok(res,{tsMs:now,total:cash+card+nequi,shiftId:shift});
}
async function apiGetBarSales(p, res) {
  const bDay=String(p.businessDay||businessDay(Date.now()));
  const shiftFilter=String(p.shiftId||'');
  let q=supabase.from('bar_sales').select('*').eq('business_day',bDay).order('ts_ms');
  if(shiftFilter)q=q.eq('shift_id',shiftFilter);
  const{data}=await q;
  const list=(data||[]).map(r=>({id:r.id,tsMs:Number(r.ts_ms),shiftId:r.shift_id,userName:r.user_name,description:r.description||'',amountCash:Number(r.amount_cash||0),amountCard:Number(r.amount_card||0),amountNequi:Number(r.amount_nequi||0),total:Number(r.total||0)}));
  const totals=list.reduce((acc,r)=>({cash:acc.cash+r.amountCash,card:acc.card+r.amountCard,nequi:acc.nequi+r.amountNequi,total:acc.total+r.total}),{cash:0,card:0,nequi:0,total:0});
  return ok(res,{sales:list,totals});
}
async function apiAddGeneralExpense(p, res) {
  const now=Date.now(),bDay=businessDay(now),shift=currentShiftId(now);
  const userRole=String(p.userRole||'').toUpperCase();
  if(userRole!=='RECEPTION'&&userRole!=='ADMIN')return err(res,'Solo RECEPTION o ADMIN');
  const desc=String(p.description||'').trim(),amount=Number(p.amount||0);
  if(desc.length<3)return err(res,'Descripcion requerida (min 3 caracteres)');
  if(amount<=0)return err(res,'Monto debe ser mayor a 0');
  await supabase.from('general_expenses').insert({ts_ms:now,business_day:bDay,shift_id:shift,user_name:String(p.userName||''),description:desc,amount,category:String(p.category||'Otro').trim()});
  return ok(res,{tsMs:now,amount,shiftId:shift});
}
async function apiGetGeneralExpenses(p, res) {
  const bDay=String(p.businessDay||businessDay(Date.now()));
  const shiftFilter=String(p.shiftId||'');
  let q=supabase.from('general_expenses').select('*').eq('business_day',bDay).order('ts_ms');
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
    supabase.from('sales').select('type,total,pay_method,extra_people_value,shift_id,room_id,amount_1,amount_2,amount_3').eq('business_day',bDay),
    supabase.from('taxi_expenses').select('amount,shift_id').eq('business_day',bDay),
    supabase.from('extra_staff').select('payment,shift_id').eq('business_day',bDay),
    supabase.from('bar_sales').select('amount_cash,amount_card,amount_nequi,shift_id').eq('business_day',bDay),
    supabase.from('general_expenses').select('amount,shift_id').eq('business_day',bDay),
    supabase.from('shift_log').select('shift_id,user_name,ts_ms').eq('business_day',bDay).eq('user_role','RECEPTION').eq('action','LOGIN').order('ts_ms')
  ]);

  const responsables={SHIFT_1:'—',SHIFT_2:'—',SHIFT_3:'—'};
  (shiftLogRes.data||[]).forEach(r=>{if(responsables[r.shift_id]==='—')responsables[r.shift_id]=r.user_name;});

  const shifts=['SHIFT_1','SHIFT_2','SHIFT_3'];
  const c={};
  shifts.forEach(sid=>{c[sid]={responsable:responsables[sid],tarjetaHab:0,tarjetaPersonas:0,tarjetaHoras:0,tarjetaBar:0,efectivoHab:0,efectivoPersonas:0,efectivoHoras:0,efectivoBar:0,nequiHab:0,nequiPersonas:0,nequiHoras:0,nequiBar:0,gastos:0,taxis:0,turnos:0};});

  (salesRes.data||[]).forEach(r=>{
    const sid=r.shift_id;if(!c[sid])return;
    if(r.anulada)return;
    if(String(r.room_id) === '304') return;
    const t=Number(r.total||0),pm=String(r.pay_method||'').toUpperCase(),epv=Number(r.extra_people_value||0);
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
    const totTarjeta=x.tarjetaHab+x.tarjetaPersonas+x.tarjetaHoras+x.tarjetaBar;
    const totNequi=x.nequiBar;
    const totEfectivo=x.efectivoHab+x.efectivoPersonas+x.efectivoHoras+x.efectivoBar;
    const totGastos=x.gastos+x.taxis+x.turnos;
    const entrega=totTarjeta+totEfectivo+totNequi-totGastos;
    diaTotal+=entrega;
    cuadre[sid]={responsable:x.responsable,tarjeta:{hab:x.tarjetaHab,personas:x.tarjetaPersonas,horas:x.tarjetaHoras,bar:x.tarjetaBar,total:totTarjeta},efectivo:{hab:x.efectivoHab,personas:x.efectivoPersonas,horas:x.efectivoHoras,bar:x.efectivoBar,total:totEfectivo},nequi:{bar:x.nequiBar,total:totNequi},gastos:{generales:x.gastos,taxis:x.taxis,turnos:x.turnos,total:totGastos},entregaDiaria:entrega};
  });
  return ok(res,{businessDay:bDay,cuadre,entregaTotalDia:diaTotal});
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
  const { data: inserted, error: errIns } = await supabase.from('sales').insert({
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
  await supabase.from('state_history').insert({
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
  const { data, error } = await supabase
    .from('sales')
    .select('id, ts_ms, extra_hours, total, pay_method, user_name, anulada, anulada_ms, anulada_por, note')
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
  const { data, error } = await supabase
    .from('sales')
    .select('room_id, category, type, anulada')
    .eq('business_day', businessDayParam)
    .eq('shift_id', shiftId)
    .in('type', ['SALE', 'RENEWAL', 'EXTENSION']);
  if(error) return err(res, error.message);
  const habitacionesMap = {};
  (data||[]).forEach(r => {
    if(r.anulada) return;
    if(!habitacionesMap[r.room_id]) {
      habitacionesMap[r.room_id] = { roomId: r.room_id, category: r.category, countExtensiones: 0 };
    }
    if(r.type === 'EXTENSION') habitacionesMap[r.room_id].countExtensiones++;
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
  const cfg = MASTER_PRICING[room.category]||MASTER_PRICING['Junior'];
  const costPerPerson = Number(cfg.extraPerson||0);
  const totalCost = costPerPerson * cantidad;
  await supabase.from('sales').insert({
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
async function apiAddExtraPerson(p, res) {
  const now=Date.now(),bDay=businessDay(now),shift=currentShiftId(now);
  const userName=String(p.userName||'').trim(),roomId=String(p.roomId||'').trim();
  const payMethod=String(p.payMethod||'EFECTIVO').toUpperCase();
  const room=await getRoom(roomId);
  if(!room)return err(res,'Habitacion no existe');
  if(room.state!=='OCCUPIED')return err(res,'Habitacion no esta ocupada');
  const currentPeople=Number(room.people||0);
  if(currentPeople>=10)return err(res,'Maximo 10 personas');
  const cfg=MASTER_PRICING[room.category]||MASTER_PRICING['Junior'];
  const cost=Number(cfg.extraPerson||0),newPeople=currentPeople+1;
  await supabase.from('rooms').update({people:newPeople,updated_at:new Date().toISOString()}).eq('room_id',roomId);
  await supabase.from('sales').insert({ts_ms:now,business_day:bDay,shift_id:shift,user_role:'RECEPTION',user_name:userName,type:'SALE',room_id:roomId,category:room.category,duration_hrs:0,base_price:0,people:newPeople,included_people:Number(cfg.included||2),extra_people:newPeople-Number(cfg.included||2),extra_people_value:cost,total:cost,pay_method:payMethod,check_in_ms:Number(room.check_in_ms||0),due_ms:Number(room.due_ms||0),arrival_type:room.arrival_type||'',arrival_plate:room.arrival_plate||''});
  return ok(res,{roomId,newPeople,extraPersonCost:cost});
}

// ITEM 8: Cambio de habitacion - transfiere venta original a nueva habitacion
async function apiRoomChange(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
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

  const fromCfg = MASTER_PRICING[fromRoom.category] || MASTER_PRICING['Junior'];
  const toCfg = MASTER_PRICING[toRoom.category] || MASTER_PRICING['Junior'];
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

  const fromPrice = calcTotalPrice(fromCfg, durationHrs, people);
  const toPrice = calcTotalPrice(toCfg, durationHrs, people);
  const diff = toPrice - fromPrice;

  // Marcar habitacion origen como RETOQUE
  await supabase.from('rooms').update({
    state: 'AVAILABLE', retoque: true, state_since_ms: now,
    people: 0, due_ms: 0, last_checkout_ms: now,
    arrival_type: '', arrival_plate: '',
    checkout_obs: 'CAMBIO DE HABITACION a ' + toRoomId,
    updated_at: new Date().toISOString()
  }).eq('room_id', fromRoomId);

  // Check-in en habitacion destino con mismo tiempo que tenia la original
  const originalCheckInMs = Number(fromRoom.check_in_ms || now);
  const originalDueMs = Number(fromRoom.due_ms || (now + durationHrs * 3600000));

  await supabase.from('rooms').update({
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: originalCheckInMs, due_ms: originalDueMs,
    arrival_type: fromRoom.arrival_type || 'WALK',
    arrival_plate: fromRoom.arrival_plate || '',
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0,
    pay_method: fromRoom.payMethod || payMethod,
    updated_at: new Date().toISOString()
  }).eq('room_id', toRoomId);

  // ITEM 8: Transferir la venta original de fromRoom a toRoom
  // Buscar la venta original de esta estadia
  const { data: originalSale } = await supabase.from('sales')
    .select('id')
    .eq('room_id', fromRoomId)
    .eq('type', 'SALE')
    .eq('check_in_ms', originalCheckInMs)
    .limit(1);

  if(originalSale && originalSale.length) {
    // Actualizar la venta original para que apunte a la nueva habitacion
    await supabase.from('sales').update({
      room_id: toRoomId,
      category: toRoom.category
    }).eq('id', originalSale[0].id);
  }

  // Registrar diferencia de precio si la hay
  if(diff > 0) {
    await supabase.from('sales').insert({
      ts_ms: now, business_day: bDay, shift_id: shift,
      user_role: 'RECEPTION', user_name: userName, type: 'SALE',
      room_id: toRoomId, category: toRoom.category, duration_hrs: durationHrs,
      base_price: diff, people, total: diff,
      pay_method: payMethod, check_in_ms: originalCheckInMs, due_ms: originalDueMs,
      arrival_type: fromRoom.arrival_type||'WALK'
    });
  } else if(diff < 0) {
    await supabase.from('sales').insert({
      ts_ms: now, business_day: bDay, shift_id: shift,
      user_role: 'RECEPTION', user_name: userName, type: 'REFUND',
      room_id: toRoomId, category: fromRoom.category, total: diff,
      pay_method: payMethod, refund_reason: 'CAMBIO DE HABITACION de ' + fromRoomId
    });
  }

  return ok(res, { fromRoomId, toRoomId, diff, newDueMs: originalDueMs });
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
  const bDay=businessDay(now);
  const shift=currentShiftId(now);
  const checkInMs=Number(room.check_in_ms||0);
  await supabase.from('sales').update({pay_method:payMethod}).eq('room_id',roomId).eq('business_day',bDay).in('type',['SALE','EXTENSION','RENEWAL']).eq('shift_id',shift).eq('check_in_ms',checkInMs);
  await supabase.from('rooms').update({pay_method:payMethod, updated_at:new Date().toISOString()}).eq('room_id',roomId);
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
  await supabase.from('rooms').update(updates).eq('room_id',roomId);
  return ok(res,{roomId,plate,arrivalType});
}

// ==================== MANTENIMIENTO ====================
async function apiGetMaintHistory(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const from=String(p.from||'');
  const to=String(p.to||'');
  if(!from||!to) return err(res,'Fechas requeridas');
  const{data}=await supabase.from('maintenance').select('*').gte('business_day',from).lte('business_day',to).order('ts_ms',{ascending:false});
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
  await supabase.from('maintenance').delete().gte('business_day',from).lte('business_day',to);
  return ok(res,{});
}

// ==================== ROOM ISSUES ====================
async function apiGetRoomIssues(p, res) {
  const roomId=String(p.roomId||'').trim();
  const{data}=await supabase.from('room_issues').select('*').eq('room_id',roomId).order('created_at',{ascending:false});
  return ok(res,{issues:(data||[]).map(r=>({id:r.id,roomId:r.room_id,type:r.type,description:r.description,resolved:!!r.resolved,resolvedAt:r.resolved_at||'',resolvedBy:r.resolved_by||'',createdAt:r.created_at||'',createdBy:r.created_by||''}))});
}
async function apiAddRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const roomId=String(p.roomId||'').trim();
  const type=String(p.type||'dano').trim();
  const description=String(p.description||'').trim();
  if(!roomId)return err(res,'roomId requerido');
  if(!description)return err(res,'Descripcion requerida');
  await supabase.from('room_issues').insert({room_id:roomId,type,description,resolved:false,created_by:String(p.userName||'')});
  return ok(res,{});
}
async function apiEditRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const id=Number(p.id||0);
  const description=String(p.description||'').trim();
  if(!id)return err(res,'id requerido');
  if(!description)return err(res,'Descripcion requerida');
  await supabase.from('room_issues').update({description}).eq('id',id);
  return ok(res,{});
}
async function apiResolveRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN'&&String(p.userRole||'').toUpperCase()!=='RECEPTION') return err(res,'Solo ADMIN o RECEPTION');
  const id=Number(p.id||0);
  if(!id)return err(res,'id requerido');
  const hoy=new Date().toISOString().split('T')[0];
  await supabase.from('room_issues').update({resolved:true,resolved_at:hoy,resolved_by:String(p.userName||'')}).eq('id',id);
  return ok(res,{});
}
async function apiDeleteRoomIssue(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  if(!id)return err(res,'id requerido');
  await supabase.from('room_issues').delete().eq('id',id);
  return ok(res,{});
}

// ==================== PROYECCION ====================
async function apiGetProyeccion(p, res) {
  try {
    if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
    const anio=Number(p.anio||new Date().getFullYear());
    const[tareasRes,mesesRes]=await Promise.all([
      supabase.from('proyeccion_tareas').select('*').eq('anio',anio).order('mes',{ascending:true}),
      supabase.from('proyeccion_meses').select('*').eq('anio',anio).order('mes')
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
  const{data}=await supabase.from('proyeccion_tareas').insert({
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
  await supabase.from('proyeccion_tareas').update({
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
  await supabase.from('proyeccion_tareas').delete().eq('id',id);
  return ok(res,{id});
}
async function apiSaveMesProyeccion(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const anio=Number(p.anio||new Date().getFullYear()),mes=Number(p.mes||1);
  await supabase.from('proyeccion_meses').upsert({
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
  await supabase.from('maid_log').delete().eq('business_day',bDay);
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
  await supabase.from('maid_log')
    .delete()
    .eq('maid_name',maidName).eq('room_id',roomId)
    .eq('business_day',bDay).eq('action','START').eq('finished_ms',0);
  await supabase.from('rooms').update({
    maid_in_progress:false,
    maid_name_progress:'',
    state: room.state==='CONTAMINATED'?'DIRTY':room.state,
    contaminated_since_ms: 0,
    updated_at:new Date().toISOString()
  }).eq('room_id',roomId);
  return ok(res,{roomId,cancelled:true});
}

// ==================== CALENDARIO EXTRAS ====================
async function apiGetExtras(p, res) {
  const mes=String(p.mes||'').trim();
  if(!mes) return err(res,'mes requerido');
  const{data}=await supabase.from('schedule_extras').select('*').like('fecha',mes+'%').order('fecha');
  return ok(res,{extras:(data||[]).map(r=>({id:r.id,fecha:r.fecha,area:r.area,nombre:r.nombre,horaEntrada:r.hora_entrada||'',horaSalida:r.hora_salida||'',tipo:r.tipo||'normal',vacInicio:r.vac_inicio||'',vacFin:r.vac_fin||'',fijo:r.fijo||''}))});
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
    const{data:existing}=await supabase.from('schedule_extras').select('id').eq('fecha',fecha).eq('area',area);
    if(existing&&existing.length>=limite) return err(res,'Limite de extras alcanzado para este dia ('+limite+')');
  }
  if(id){
    await supabase.from('schedule_extras').update({nombre,hora_entrada:horaEntrada,hora_salida:horaSalida,tipo,vac_inicio:vacInicio,vac_fin:vacFin,fijo:String(p.fijo||'')}).eq('id',id);
  } else {
    await supabase.from('schedule_extras').insert({fecha,area,nombre,hora_entrada:horaEntrada,hora_salida:horaSalida,tipo,vac_inicio:vacInicio,vac_fin:vacFin,fijo:String(p.fijo||'')});
  }
  return ok(res,{ok:true});
}
async function apiDeleteScheduleExtra(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const id=Number(p.id||0);
  if(!id) return err(res,'id requerido');
  await supabase.from('schedule_extras').delete().eq('id',id);
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
  await supabase.from('shift_failures').insert({
    ts_ms:now, business_day:bDay, shift_id:shiftId,
    user_name:userName, failures:JSON.stringify(failures),
    created_by:String(p.createdBy||'ADMIN')
  });
  return ok(res,{saved:true});
}
async function apiGetShiftFailures(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const yearMonth=String(p.yearMonth||'');
  let query=supabase.from('shift_failures').select('*').order('ts_ms',{ascending:false});
  if(yearMonth) query=query.like('business_day',yearMonth+'%');
  const{data}=await query.limit(200);
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
  const { data } = await supabase.from('products').select('*').order('categoria').order('nombre');
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
    await supabase.from('products').update({
      nombre, codigo_barras: codigo||null, precio, categoria,
      stock_minimo: stockMinimo
    }).eq('id', id);
  } else {
    await supabase.from('products').insert({
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
  await supabase.from('products').update({ activo: false }).eq('id', id);
  return ok(res, {});
}

async function apiAddStock(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const id = Number(p.id||0);
  const cantidad = Number(p.cantidad||0);
  if(!id) return err(res,'id requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const { data: prod } = await supabase.from('products').select('*').eq('id', id).single();
  if(!prod) return err(res,'Producto no existe');
  const nuevoStock = Number(prod.stock_actual||0) + cantidad;
  await supabase.from('products').update({ stock_actual: nuevoStock }).eq('id', id);
  const now = Date.now();
  await supabase.from('stock_entries').insert({
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
  let query = supabase.from('room_products').select('*').eq('room_id', roomId);
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
  const bDay = businessDay(now);
  const shift = String(p.sessionShiftId||'').trim() || currentShiftId(now);
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
  const { data: prod } = await supabase.from('products').select('*').eq('id', productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_actual||0) < cantidad) return err(res,'Stock insuficiente. Quedan: '+prod.stock_actual);
  const total = isCortesia ? 0 : Number(prod.precio||0) * cantidad;
  await supabase.from('room_products').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    room_id: roomId, check_in_ms: checkInMs,
    product_id: productId, product_name: prod.nombre,
    cantidad, precio_unit: Number(prod.precio||0),
    total, pay_method: payMethod,
    user_name: userName, is_cortesia: isCortesia,
    cortesia_destinatario: cortesiaDestinatario
  });
  await supabase.from('products').update({
    stock_actual: Number(prod.stock_actual||0) - cantidad
  }).eq('id', productId);
  if(isCortesia) {
    await supabase.from('cortesias').insert({
      ts_ms: now, business_day: bDay, shift_id: shift,
      product_id: productId, product_name: prod.nombre,
      cantidad, precio_unit: Number(prod.precio||0),
      total: Number(prod.precio||0) * cantidad,
      user_name: userName,
      destinatario: cortesiaDestinatario
    });
  }
  return ok(res, { total, stockRestante: Number(prod.stock_actual||0) - cantidad });
}

async function apiEditRoomProduct(p, res) {
  const id = Number(p.id||0);
  const nuevaCantidad = Number(p.cantidad||0);
  if(!id) return err(res,'id requerido');
  if(nuevaCantidad<=0) return err(res,'Cantidad invalida');
  const { data: rp } = await supabase.from('room_products').select('*').eq('id', id).single();
  if(!rp) return err(res,'Registro no existe');
  const diff = nuevaCantidad - Number(rp.cantidad||0);
  const { data: prod } = await supabase.from('products').select('stock_actual').eq('id', rp.product_id).single();
  if(!prod) return err(res,'Producto no existe');
  if(diff > 0 && Number(prod.stock_actual||0) < diff) return err(res,'Stock insuficiente');
  const nuevoTotal = rp.is_cortesia ? 0 : Number(rp.precio_unit||0) * nuevaCantidad;
  await supabase.from('room_products').update({
    cantidad: nuevaCantidad, total: nuevoTotal
  }).eq('id', id);
  await supabase.from('products').update({
    stock_actual: Number(prod.stock_actual||0) - diff
  }).eq('id', rp.product_id);
  return ok(res, { nuevoTotal });
}

async function apiDeleteRoomProduct(p, res) {
  const id = Number(p.id||0);
  if(!id) return err(res,'id requerido');
  const { data: rp } = await supabase.from('room_products').select('*').eq('id', id).single();
  if(!rp) return err(res,'Registro no existe');
  const { data: prod } = await supabase.from('products').select('stock_actual').eq('id', rp.product_id).single();
  if(prod) {
    await supabase.from('products').update({
      stock_actual: Number(prod.stock_actual||0) + Number(rp.cantidad||0)
    }).eq('id', rp.product_id);
  }
  await supabase.from('room_products').delete().eq('id', id);
  return ok(res, {});
}

async function apiSaveCortesia(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.sessionShiftId||'').trim() || currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||1);
  const userName = String(p.userName||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const { data: prod } = await supabase.from('products').select('*').eq('id', productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_actual||0) < cantidad) return err(res,'Stock insuficiente');
  await supabase.from('cortesias').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    product_id: productId, product_name: prod.nombre,
    cantidad, precio_unit: Number(prod.precio||0),
    total: Number(prod.precio||0) * cantidad,
    user_name: userName
  });
  await supabase.from('products').update({
    stock_actual: Number(prod.stock_actual||0) - cantidad
  }).eq('id', productId);
  return ok(res, { stockRestante: Number(prod.stock_actual||0) - cantidad });
}
async function apiSaveObservacionTurno(p, res) {
  if(!['ADMIN','RECEPTION'].includes(String(p.userRole||'').toUpperCase())) return err(res,'Sin permiso');
  const now=Date.now();
  const bd=String(p.businessDay||businessDay(now));
  const shiftId=String(p.shiftId||'');
  const observacion=String(p.observacion||'');
  if(!shiftId) return err(res,'shiftId requerido');
  const {data:existing}=await supabase.from('product_shift_obs').select('id').eq('business_day',bd).eq('shift_id',shiftId).maybeSingle();
  if(existing){
    await supabase.from('product_shift_obs').update({observacion,user_name:String(p.userName||''),ts_ms:now}).eq('id',existing.id);
  } else {
    await supabase.from('product_shift_obs').insert({business_day:bd,shift_id:shiftId,observacion,user_name:String(p.userName||''),ts_ms:now});
  }
  return ok(res,{saved:true});
}

async function apiGetObservacionesTurno(p, res) {
  const bd=String(p.businessDay||businessDay(Date.now()));
  const {data:obs}=await supabase.from('product_shift_obs').select('*').eq('business_day',bd);
  return ok(res,{obs:obs||[]});
}
async function apiGetProductosMes(p, res) {
  const ym=String(p.yearMonth||'');
  if(!ym)return err(res,'yearMonth requerido');
  const {data:prods}=await supabase.from('room_products').select('total,pay_method,is_cortesia').like('business_day',ym+'%').eq('is_cortesia',false);
  const {data:cors}=await supabase.from('room_products').select('total,cantidad,product_id').like('business_day',ym+'%').eq('is_cortesia',true);
  const {data:prodsList}=await supabase.from('products').select('id,precio');
  const totalVentas=(prods||[]).reduce((a,r)=>a+Number(r.total||0),0);
  const totalEf=(prods||[]).filter(r=>r.pay_method==='EFECTIVO').reduce((a,r)=>a+Number(r.total||0),0);
  const totalTa=(prods||[]).filter(r=>r.pay_method==='TARJETA').reduce((a,r)=>a+Number(r.total||0),0);
  const totalNq=(prods||[]).filter(r=>r.pay_method==='NEQUI').reduce((a,r)=>a+Number(r.total||0),0);
  const precioMap={};(prodsList||[]).forEach(p=>{precioMap[p.id]=Number(p.precio||0);});
  const totalCortesias=(cors||[]).reduce((a,r)=>a+Number(r.cantidad||0)*Number(precioMap[r.product_id]||0),0);
  return ok(res,{yearMonth:ym,totalVentas,totalEf,totalTa,totalNq,totalCortesias});
}
async function apiGetInventarioByDay(p, res) {
  const bd=String(p.businessDay||businessDay(Date.now()));
  const {data:products}=await supabase.from('products').select('*').eq('activo',true).order('categoria').order('nombre');
  if(!products||!products.length) return ok(res,{rows:[],resumenTurnos:{},businessDay:bd});
  const {data:entries}=await supabase.from('stock_entries').select('*').eq('business_day',bd);
  const {data:sales}=await supabase.from('room_products').select('*').eq('business_day',bd);
  const {data:obs}=await supabase.from('product_shift_obs').select('*').eq('business_day',bd);
  const {data:movements}=await supabase.from('stock_movements').select('*').eq('business_day',bd);
  const shifts=['SHIFT_1','SHIFT_2','SHIFT_3'];
 const ayer=new Date(bd.replace(/-/g,'/'));ayer.setDate(ayer.getDate()-1);
  const ayerStr=ayer.getFullYear()+'-'+String(ayer.getMonth()+1).padStart(2,'0')+'-'+String(ayer.getDate()).padStart(2,'0');
  const {data:salesAyer}=await supabase.from('room_products').select('product_id,cantidad,is_cortesia').eq('business_day',ayerStr);
  const {data:entriesAyer}=await supabase.from('stock_entries').select('product_id,cantidad').eq('business_day',ayerStr);
  const rows=products.map(function(prod){
    const totalVentas=(sales||[]).filter(s=>s.product_id===prod.id&&!s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const totalCortesias=(sales||[]).filter(s=>s.product_id===prod.id&&s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const totalEntradas=(entries||[]).filter(e=>e.product_id===prod.id).reduce((a,e)=>a+Number(e.cantidad||0),0);
    const ventasAyer=(salesAyer||[]).filter(s=>s.product_id===prod.id&&!s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const cortesiasAyer=(salesAyer||[]).filter(s=>s.product_id===prod.id&&s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const entradasAyer=(entriesAyer||[]).filter(e=>e.product_id===prod.id).reduce((a,e)=>a+Number(e.cantidad||0),0);
   const totalTraslados=(movements||[]).filter(m=>m.product_id===prod.id&&m.tipo==='traslado_recepcion').reduce((a,m)=>a+Number(m.cantidad||0),0);
    const totalDevoluciones=(movements||[]).filter(m=>m.product_id===prod.id&&m.tipo==='devolucion_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
    const saldoInicialReal=Number(prod.stock_actual||0)+totalVentas+totalCortesias-totalTraslados-totalEntradas+totalDevoluciones;
    const turnosData={};
    shifts.forEach(function(sid){
      const ent=(entries||[]).filter(e=>e.product_id===prod.id&&e.shift_id===sid).reduce((a,e)=>a+Number(e.cantidad||0),0);
      const ven=(sales||[]).filter(s=>s.product_id===prod.id&&s.shift_id===sid&&!s.is_cortesia);
      const corItems=(sales||[]).filter(s=>s.product_id===prod.id&&s.shift_id===sid&&s.is_cortesia);
      const cor=corItems.reduce((a,s)=>a+Number(s.cantidad||0),0);
      const cortesiasDetalle=corItems.map(s=>({cantidad:Number(s.cantidad||0),destinatario:s.cortesia_destinatario||''}));
      turnosData[sid]={entradas:ent,ventas:ven.reduce((a,s)=>a+Number(s.cantidad||0),0),cortesias:cor,cortesiasDetalle,valorVendido:ven.reduce((a,s)=>a+Number(s.total||0),0),ef:ven.filter(s=>s.pay_method==='EFECTIVO').reduce((a,s)=>a+Number(s.total||0),0),ta:ven.filter(s=>s.pay_method==='TARJETA').reduce((a,s)=>a+Number(s.total||0),0),nq:ven.filter(s=>s.pay_method==='NEQUI').reduce((a,s)=>a+Number(s.total||0),0)};
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
});
return{id:prod.id,nombre:prod.nombre,categoria:prod.categoria||'',codigoBarras:prod.codigo_barras||'',precio:Number(prod.precio||0),stockMinimo:Number(prod.stock_minimo||5),saldoInicial:saldoInicialReal,saldoActual:Number(prod.stock_actual||0),stockBodega:Number(prod.stock_bodega||0),turnos:turnosData};
  });
  const resumenTurnos={};
  shifts.forEach(function(sid){
    const venTurno=(sales||[]).filter(s=>s.shift_id===sid&&!s.is_cortesia);
    const corTurno=(sales||[]).filter(s=>s.shift_id===sid&&s.is_cortesia);
    resumenTurnos[sid]={totalVendido:venTurno.reduce((a,s)=>a+Number(s.total||0),0),totalEf:venTurno.filter(s=>s.pay_method==='EFECTIVO').reduce((a,s)=>a+Number(s.total||0),0),totalTa:venTurno.filter(s=>s.pay_method==='TARJETA').reduce((a,s)=>a+Number(s.total||0),0),totalNq:venTurno.filter(s=>s.pay_method==='NEQUI').reduce((a,s)=>a+Number(s.total||0),0),totalCortesias:corTurno.reduce((a,s)=>a+Number(s.cantidad||0)*Number(s.precio_unit||0),0),cortesiasDetalle:corTurno.map(s=>({nombre:s.product_name||'',cantidad:Number(s.cantidad||0),destinatario:s.cortesia_destinatario||''})),observacion:((obs||[]).find(o=>o.shift_id===sid)||{}).observacion||''};
  });
  return ok(res,{rows,resumenTurnos,businessDay:bd});
}
async function apiIngresoBodega(p, res) {
  const userRole = String(p.userRole||'').toUpperCase();
  if(userRole!=='ADMIN'&&userRole!=='RECEPTION') return err(res,'Sin permiso');
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const nota = String(p.nota||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const {data:prod} = await supabase.from('products').select('*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');
  const nuevoBodega = Number(prod.stock_bodega||0) + cantidad;
  await supabase.from('products').update({stock_bodega:nuevoBodega}).eq('id',productId);
  await supabase.from('stock_movements').insert({
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
  const bDay = businessDay(now);
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const nota = String(p.nota||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const {data:prod} = await supabase.from('products').select('*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_actual||0)<cantidad) return err(res,'No hay suficiente en recepción. Hay: '+prod.stock_actual);
  const nuevoBodega = Number(prod.stock_bodega||0) + cantidad;
  const nuevoRecepcion = Number(prod.stock_actual||0) - cantidad;
  await supabase.from('products').update({stock_bodega:nuevoBodega, stock_actual:nuevoRecepcion}).eq('id',productId);
  await supabase.from('stock_movements').insert({
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
  const bDay = businessDay(now);
  const shift = String(p.shiftId||'').trim()||currentShiftId(now);
  const productId = Number(p.productId||0);
  const cantidad = Number(p.cantidad||0);
  const nota = String(p.nota||'').trim();
  if(!productId) return err(res,'productId requerido');
  if(cantidad<=0) return err(res,'Cantidad invalida');
  const {data:prod} = await supabase.from('products').select('*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');
  if(Number(prod.stock_bodega||0)<cantidad) return err(res,'Stock en bodega insuficiente. Hay: '+prod.stock_bodega);
  const nuevoBodega = Number(prod.stock_bodega||0) - cantidad;
  const nuevoRecepcion = Number(prod.stock_actual||0) + cantidad;
  await supabase.from('products').update({stock_bodega:nuevoBodega, stock_actual:nuevoRecepcion}).eq('id',productId);
  await supabase.from('stock_movements').insert({
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
  const { data, error } = await supabase.from('loans')
    .select('*')
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
  const { data, error } = await supabase.from('loans').insert({
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
  const { data: gasto, error: errGasto } = await supabase.from('loans').select('*').eq('id', gastoId).maybeSingle();
  if(errGasto) return err(res, errGasto.message);
  if(!gasto) return err(res,'Gasto no encontrado');
  if(gasto.anulada) return err(res,'No se puede editar un gasto anulado');
  // Si ya fue editado antes, NO sobreescribir el amount_original
  const amountOriginal = gasto.amount_original!==null && gasto.amount_original!==undefined
    ? gasto.amount_original
    : gasto.amount;
  await supabase.from('loans').update({
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
  const { data: gasto, error: errGasto } = await supabase.from('loans').select('*').eq('id', gastoId).maybeSingle();
  if(errGasto) return err(res, errGasto.message);
  if(!gasto) return err(res,'Gasto no encontrado');
  if(gasto.anulada) return err(res,'Este gasto ya está anulado');
  await supabase.from('loans').update({
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
  const { data: inserted, error: errIns } = await supabase.from('sales').insert({
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
  await supabase.from('state_history').insert({
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
  const { data: sale, error: errSale } = await supabase.from('sales').select('*').eq('id', saleId).maybeSingle();
  if(errSale) return err(res, errSale.message);
  if(!sale) return err(res,'Venta no encontrada');
  if(sale.anulada) return err(res,'Esta venta ya está anulada');
  const motivoFinal = '[AJUSTE-ANULACION] ' + motivo;
  await supabase.from('sales').update({
    type:'ANULADA',
    note: motivoFinal,
    anulada: true,
    anulada_ms: now,
    anulada_por: userName
  }).eq('id', saleId);
  await supabase.from('state_history').insert({
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
  if(!roomId) return err(res,'roomId requerido');
  if(!motivo||motivo.length<5) return err(res,'Motivo requerido');
  const room = await getRoom(roomId);
  if(!room) return err(res,'Habitacion no existe');
  if(room.state!=='OCCUPIED') return err(res,'Solo se puede anular si está ocupada');
  // Marcar todas las ventas de esta estadia como ANULADA
  await supabase.from('sales').update({type:'ANULADA',note:motivo,anulada:true,anulada_ms:now,anulada_por:userName}).eq('room_id',roomId).eq('check_in_ms',checkInMs);
  // Devolver habitacion a disponible
  await supabase.from('rooms').update({
    state:'AVAILABLE', state_since_ms:now, people:0,
    due_ms:0, check_in_ms:0, last_checkout_ms:now,
    arrival_type:'', arrival_plate:'',
    alarm_silenced_ms:0, alarm_silenced_for_due_ms:0,
    checkout_obs:'ANULADA: '+motivo, pay_method:'',
    updated_at:new Date().toISOString()
  }).eq('room_id',roomId);
  // Registrar en historial
  await supabase.from('state_history').insert({
    ts_ms:now, business_day:bDay, shift_id:shift,
    user_role:userRole, user_name:userName, room_id:roomId,
    from_state:'OCCUPIED', to_state:'AVAILABLE', people:0,
    meta_json:JSON.stringify({accion:'ANULADA',motivo,checkInMs,userName})
  });
  return ok(res,{roomId,anulada:true});
}
async function apiSaveRoomBarcode(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const roomId = String(p.roomId||'').trim();
  const barcode = String(p.barcode||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  if(!barcode) return err(res,'barcode requerido');
  await supabase.from('rooms').update({ barcode }).eq('room_id', roomId);
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

  const { data: prod } = await supabase.from('products').select('*').eq('id',productId).single();
  if(!prod) return err(res,'Producto no existe');

  const vaDescontar = (cantidad > 0);
  if(vaDescontar && Number(prod.stock_actual||0) < cantidad) {
    return err(res,'Stock insuficiente. Hay '+prod.stock_actual+' unidades');
  }

  const nuevoStock = Number(prod.stock_actual||0) - cantidad;
  await supabase.from('products').update({ stock_actual: nuevoStock }).eq('id',productId);

  await supabase.from('stock_movements').insert({
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
    await supabase.from('room_products').insert({
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

  const { data: products } = await supabase.from('products').select('*').eq('activo',true).order('categoria').order('nombre');
  if(!products || !products.length) return ok(res,{rows:[],totals:{},cortesias:[],businessDay:bd,shiftId:sid});

  const { data: salesDay } = await supabase.from('room_products').select('*').eq('business_day',bd);
  const { data: movements } = await supabase.from('stock_movements').select('*').eq('business_day',bd);
  const { data: entries } = await supabase.from('stock_entries').select('*').eq('business_day',bd);

  const salesShift = (salesDay||[]).filter(s => s.shift_id === sid);

  const { data: shiftLog } = await supabase.from('shift_log')
    .select('user_name').eq('business_day',bd).eq('shift_id',sid)
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
    const saldoInicialDia = Number(prod.stock_actual||0) + totalVentasDia + totalCortesiasDia - totalTrasladosDia - totalEntradasDia;

    let saldoTurno = saldoInicialDia;
    let saldoInicialTurno = saldoInicialDia;
    for(let i = 0; i <= shiftIdx; i++) {
      if(i === shiftIdx) saldoInicialTurno = saldoTurno;
      const s = SHIFTS[i];
      const entsUntil = (movements||[]).filter(m => m.product_id === prod.id && m.shift_id === s && m.tipo === 'traslado_recepcion').reduce((a,m) => a + Number(m.cantidad||0), 0);
      const venUntil = (salesDay||[]).filter(x => x.product_id === prod.id && x.shift_id === s && !x.is_cortesia).reduce((a,x) => a + Number(x.cantidad||0), 0);
      const corUntil = (salesDay||[]).filter(x => x.product_id === prod.id && x.shift_id === s && x.is_cortesia).reduce((a,x) => a + Number(x.cantidad||0), 0);
      saldoTurno = saldoTurno + entsUntil - venUntil - corUntil;
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

  const { data: products } = await supabase.from('products').select('*').eq('activo',true).order('categoria').order('nombre');
  if(!products || !products.length) return ok(res,{rows:[],totals:{},daysTotals:{},mes:mes});

  const { data: cierreAnt } = await supabase.from('cierre_mes').select('*').eq('mes',prevMes);
  const cierreMap = {};
  (cierreAnt||[]).forEach(c => { cierreMap[c.product_id] = c; });

  const salesMes = await fetchAll(() => supabase.from('room_products').select('*').gte('business_day',firstDay).lte('business_day',lastDay));
  const movementsMes = await fetchAll(() => supabase.from('stock_movements').select('*').gte('business_day',firstDay).lte('business_day',lastDay));
  const entriesMes = await fetchAll(() => supabase.from('stock_entries').select('*').gte('business_day',firstDay).lte('business_day',lastDay));


  const SHIFTS = ['SHIFT_1','SHIFT_2','SHIFT_3'];

  const rows = products.map(function(prod){
    const cierreProd = cierreMap[prod.id] || {};
    const siRec = Number(cierreProd.stock_recepcion||0);
    const siBod = Number(cierreProd.stock_bodega||0);
    const siTotal = siRec + siBod;

    const compras = (entriesMes||[]).filter(e => e.product_id === prod.id).reduce((a,e) => a + Number(e.cantidad||0), 0);

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
// Llenar B: entradas a bodega (stock_entries = compras a proveedor + ajustes de suma)
    (entriesMes||[]).filter(e => e.product_id === prod.id).forEach(function(e){
      const fecha = e.business_day;
      const sid = e.shift_id || 'SHIFT_1';
      if(porDia[fecha] && porDia[fecha].turnos[sid]) {
        porDia[fecha].turnos[sid].b += Number(e.cantidad||0);
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
      bodega: Number(prod.stock_actual||0),
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
  const totalCompras = (entriesMes||[]).reduce((a,e) => {
    const prod = products.find(p => p.id === e.product_id);
    const costo = prod ? Number(prod.precio_compra||0) : 0;
    return a + Number(e.cantidad||0) * costo;
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

  await supabase.from('products').update({ precio_compra: precioCompra }).eq('id', productId);
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
    const { data: saleData, error: saleErr } = await supabase.from('sales').select('*').eq('id', saleId).single();
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
    const { error: insErr } = await supabase.from('payment_method_changes').insert({
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
    const { error: updErr } = await supabase.from('sales').update({
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

  let query = supabase.from('ajustes').select('*')
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

  if(!['BODEGA','RECEPCION'].includes(categoria)) return err(res,'Categoria invalida (solo BODEGA o RECEPCION)');
  if(!tipo) return err(res,'Tipo requerido');
  if(!productId) return err(res,'Producto requerido');
  if(motivo.length < 3) return err(res,'Motivo minimo 3 letras');

  const { data: prod } = await supabase.from('products').select('*').eq('id',productId).single();
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
  let nuevoStockBod = Number(prod.stock_actual||0);

  // ========== BODEGA (no afecta cuadre) ==========
  if(categoria === 'BODEGA') {
    afectaStock = 'bodega';
    afectaCuadre = false;
    businessDayAj = businessDay(now);
    shiftAj = currentShiftId(now);
    valorAfectado = cantidad * precioCompra;

    // Tipos: roto, vencido, conteo, robo, ingreso_extra, salida_extra
    if(tipo === 'conteo' || tipo === 'ingreso_extra') {
      // Suman o restan segun el signo de cantidad
      if(cantidad === 0) return err(res,'Cantidad no puede ser 0');
      nuevoStockBod = Number(prod.stock_actual||0) + cantidad;
      if(nuevoStockBod < 0) return err(res,'Resultado negativo en bodega');
    } else if(tipo === 'roto' || tipo === 'vencido' || tipo === 'robo' || tipo === 'salida_extra') {
      // Siempre restan
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');
      if(Number(prod.stock_actual||0) < cantidad) return err(res,'Stock bodega insuficiente. Hay '+prod.stock_actual);
      nuevoStockBod = Number(prod.stock_actual||0) - cantidad;
    } else {
      return err(res,'Tipo de bodega invalido: '+tipo);
    }

    await supabase.from('products').update({ stock_actual: nuevoStockBod }).eq('id',productId);

    await supabase.from('stock_movements').insert({
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

    if(!businessDayAj) return err(res,'Fecha requerida');
    if(!['SHIFT_1','SHIFT_2','SHIFT_3'].includes(shiftAj)) return err(res,'Turno invalido');
    if(!recepNameAj) return err(res,'Recepcionista requerida');

    // Escenario 4: agregar venta olvidada
    if(tipo === 'venta_olvidada') {
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');
      afectaStock = 'recepcion';
      valorAfectado = cantidad * precio;
      nuevoStockBod = Math.max(0, Number(prod.stock_actual||0) - cantidad);
      await supabase.from('products').update({ stock_actual: nuevoStockBod }).eq('id',productId);

      await supabase.from('room_products').insert({
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
      nuevoStockBod = Number(prod.stock_actual||0) + cantidad;
      await supabase.from('products').update({ stock_actual: nuevoStockBod }).eq('id',productId);

      await supabase.from('room_products').insert({
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

    // Escenario 2: cambiar metodo de pago
    else if(tipo === 'metodo_pago') {
      payMethodViejo = String(p.payMethodViejo||'').toUpperCase();
      if(!payMethodViejo) return err(res,'Metodo anterior requerido');
      if(payMethodViejo === payMethodAj) return err(res,'Los metodos son iguales');
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');
      afectaStock = 'ninguno';
      valorAfectado = cantidad * precio;

      await supabase.from('room_products').insert({
        ts_ms: now, business_day: businessDayAj, shift_id: shiftAj,
        room_id: 'AJUSTE', check_in_ms: 0,
        product_id: productId, product_name: prod.nombre,
        cantidad: -cantidad, precio_unit: precio,
        total: -(cantidad * precio), pay_method: payMethodViejo,
        user_name: recepNameAj,
        is_cortesia: false,
        created_by_admin: true,
        tipo_ajuste: 'metodo_pago_resta',
        motivo_ajuste: motivo
      });
      await supabase.from('room_products').insert({
        ts_ms: now + 1, business_day: businessDayAj, shift_id: shiftAj,
        room_id: 'AJUSTE', check_in_ms: 0,
        product_id: productId, product_name: prod.nombre,
        cantidad: cantidad, precio_unit: precio,
        total: cantidad * precio, pay_method: payMethodAj,
        user_name: recepNameAj,
        is_cortesia: false,
        created_by_admin: true,
        tipo_ajuste: 'metodo_pago_suma',
        motivo_ajuste: motivo
      });
    }

    // Escenario 1: cambiar producto vendido por otro
    else if(tipo === 'producto') {
      productoViejoId = Number(p.productoViejoId||0);
      if(!productoViejoId) return err(res,'Producto viejo requerido');
      if(cantidad <= 0) return err(res,'Cantidad debe ser positiva');

      const { data: prodViejo } = await supabase.from('products').select('*').eq('id',productoViejoId).single();
      if(!prodViejo) return err(res,'Producto viejo no existe');
      const precioViejo = Number(prodViejo.precio||0);

      afectaStock = 'ambos';
      valorAfectado = (cantidad * precio) - (cantidad * precioViejo);

      const nuevoStockViejo = Number(prodViejo.stock_actual||0) + cantidad;
      await supabase.from('products').update({ stock_actual: nuevoStockViejo }).eq('id',productoViejoId);

      nuevoStockBod = Math.max(0, Number(prod.stock_actual||0) - cantidad);
      await supabase.from('products').update({ stock_actual: nuevoStockBod }).eq('id',productId);

      await supabase.from('room_products').insert({
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
      await supabase.from('room_products').insert({
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
  await supabase.from('ajustes').insert({
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
    nuevoStockBodega: nuevoStockBod
  });
}
