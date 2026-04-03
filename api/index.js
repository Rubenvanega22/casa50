// ============================================================
// CASA 50 - SPA MOTEL | API Backend v3.2
// api/index.js - Vercel Serverless (Node.js) v3.2
// Cambios v3:
//  - bar_sales + general_expenses (nuevas tablas)
//  - getDailyCuadre: cuadre de caja admin por turno
//  - addExtraPerson: persona adicional post check-in
//  - updateArrivalPlate: placa post check-in
//  - setDisabled: RECEPTION puede bloquear (no desbloquear)
//  - checkOut: warning si due_ms pendiente (param force)
//  - metricas: filtrado REAL por shift_id
//  - notas: historial permanente + borrado logico + getNoteHistory/deleteNote
//  - saveStaff/getStaff: ficha completa con cedula/celular etc
//  - taxi desacoplado (no afecta checkIn)
//  - SHIFT_3: 9pm-6am (21h)
// ============================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==================== PRECIOS ====================
const MASTER_PRICING = {
  'Junior':         { h3:60000,  h6:120000, h8:160000,  h12:105000, extraHour:20000, extraPerson:20000, included:2 },
  'Suite Jacuzzi':  { h3:85000,  h6:170000, h8:220000,  h12:130000, extraHour:25000, extraPerson:25000, included:2 },
  'Presidencial':   { h3:105000, h6:210000, h8:265000,  h12:145000, extraHour:30000, extraPerson:30000, included:2 },
  'Suite Multiple': { h3:135000, h6:160000, h8:195000,  h12:235000, extraHour:35000, extraPerson:30000, included:4 },
  'Suite Disco':    { h3:180000, h6:360000, h8:430000,  h12:315000, extraHour:35000, extraPerson:30000, included:4 }
};

// ==================== HELPERS ====================
// Business day: cambia a las 6AM (0-5AM = dia anterior)
function businessDay(ms) {
  const d = new Date(ms || Date.now());
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Rango del business day: [6AM hoy, 6AM mañana)
function businessDayRange(bDay) {
  const [y, m, d] = bDay.split('-').map(Number);
  const start = new Date(y, m - 1, d, 6, 0, 0, 0).getTime();
  const end   = new Date(y, m - 1, d + 1, 6, 0, 0, 0).getTime();
  return { start, end };
}

function currentShiftId(ms) {
  const bogota = new Date((ms || Date.now()) + (-5 * 60 * 60 * 1000));
  // Ajuste manual UTC-5 (Colombia no tiene horario de verano)
  const h = bogota.getUTCHours();
  if (h >= 6 && h < 14) return 'SHIFT_1';
  if (h >= 14 && h < 21) return 'SHIFT_2';
  return 'SHIFT_3';
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
    retoque: !!r.retoque
  };
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
      case 'addLoan':           return await apiAddLoan(payload, res);
      case 'getLoans':          return await apiGetLoans(payload, res);
      case 'registerExtraStaff':return await apiRegisterExtra(payload, res);
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
      case 'getReceptionPins':  return await apiGetPins(payload, res);
      case 'changeAdminPin':    return await apiChangeAdminPin(payload, res);
     case 'roomHistory':        return await apiRoomHistory(payload, res);
      case 'markNoteSeen':       return await apiMarkNoteSeen(payload, res);
      case 'getAllNotes':         return await apiGetAllNotes(payload, res);
      case 'getNoteHistory':     return await apiGetNoteHistory(payload, res);
      case 'deleteNote':         return await apiDeleteNote(payload, res);
      case 'addBarSale':         return await apiAddBarSale(payload, res);
      case 'getBarSales':        return await apiGetBarSales(payload, res);
      case 'addGeneralExpense':  return await apiAddGeneralExpense(payload, res);
      case 'getGeneralExpenses': return await apiGetGeneralExpenses(payload, res);
      case 'getDailyCuadre':     return await apiGetDailyCuadre(payload, res);
      case 'addExtraPerson':     return await apiAddExtraPerson(payload, res);
      case 'roomChange':         return await apiRoomChange(payload, res);
      case 'updateArrivalPlate': return await apiUpdateArrivalPlate(payload, res);
        case 'getMaintHistory': return await apiGetMaintHistory(payload, res);
        case 'clearMaintHistory': return await apiClearMaintHistory(payload, res);
        case 'getRoomIssues':    return await apiGetRoomIssues(payload, res);
case 'addRoomIssue':     return await apiAddRoomIssue(payload, res);
case 'editRoomIssue':    return await apiEditRoomIssue(payload, res);
case 'resolveRoomIssue': return await apiResolveRoomIssue(payload, res);
case 'deleteRoomIssue':  return await apiDeleteRoomIssue(payload, res);
        case 'getProyeccion':    return await apiGetProyeccion(payload, res);
case 'saveTarea':        return await apiSaveTarea(payload, res);
case 'updateTarea':      return await apiUpdateTarea(payload, res);
case 'deleteTarea':      return await apiDeleteTarea(payload, res);
case 'saveMesProyeccion':return await apiSaveMesProyeccion(payload, res);
        case 'clearMaidLog': return await apiClearMaidLog(payload, res);
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
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const userRole = String(p.userRole || '').toUpperCase();
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
    const storedPin = pinRow ? String(pinRow.pin || '') : '';
    if (storedPin && String(p.userPin || '') !== storedPin) {
      await supabase.from('login_failures').insert({ ts_ms: now, user_name: userName.toLowerCase(), user_role: 'RECEPTION', ip: '' });
      return err(res, 'PIN incorrecto.');
    }
    const { data: existing } = await supabase.from('shift_log').select('user_name').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'RECEPTION').eq('action', 'LOGIN').order('ts_ms').limit(1).single();
    if (existing && existing.user_name.toLowerCase() !== userName.toLowerCase()) {
      // Verificar si el turno fue cerrado (LOGOUT)
      const { data: logout } = await supabase.from('shift_log').select('id').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'RECEPTION').eq('action', 'LOGOUT').limit(1);
      if (!logout || !logout.length) {
        return err(res, 'Este turno ya tiene recepcionista: ' + existing.user_name);
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
async function apiCheckIn(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
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

  // Validar 6h para Suite Multiple
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

  // v3: CAR=placa obligatoria, MOTO=placa opcional, WALK/TAXI=sin placa
  const arrivalType = String(p.arrivalType || 'WALK').toUpperCase();
  const needsPlate = arrivalType === 'CAR';
  const plateOptional = arrivalType === 'MOTO';
  let arrivalPlate = String(p.arrivalPlate || '').toUpperCase().trim();
 // placa opcional
  if (!needsPlate && !plateOptional) arrivalPlate = '';

  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();
  const paidWith = Number(p.paidWith || 0);
  const changeGiven = payMethod === 'EFECTIVO' && paidWith >= total ? Math.max(0, paidWith - total) : 0;
  const mixtoEf = Number(p.mixtoEf || 0);
  const mixtoTj = Number(p.mixtoTj || 0);
  const mixtoNq = Number(p.mixtoNq || 0);
  console.log('MIXTO DEBUG:', payMethod, mixtoEf, mixtoTj, mixtoNq);
  await supabase.from('rooms').update({
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: now, due_ms: dueMs,
    arrival_type: arrivalType, arrival_plate: arrivalPlate,
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0, retoque: false,
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
    amount_1: payMethod==='MIXTO'?mixtoEf:total,
    amount_2: payMethod==='MIXTO'?mixtoTj:0,
    amount_3: payMethod==='MIXTO'?mixtoNq:0,
    check_in_ms: now, due_ms: dueMs
  });

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'AVAILABLE', to_state: 'OCCUPIED', people,
    meta_json: JSON.stringify({ durationHrs, basePrice, total, dueMs, arrivalType, arrivalPlate, payMethod, paidWith, changeGiven, checkInMs: now, extraPeople, extraPeopleValue })
  });

  return ok(res, { roomId, total, change: changeGiven, checkInMs: now, dueMs });
}

// ==================== CHECK-OUT v3 (warning si tiempo pendiente) ====================
async function apiCheckOut(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const obs = String(p.checkoutObs || p.obs || '').trim();
  const force = !!(p.force === true || p.force === 'true');
  if (!roomId) return err(res, 'roomId requerido');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo checkout si OCUPADA');

  // v3: advertir si hay tiempo pagado pendiente
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
    checkout_obs: obs, contaminated_since_ms: 0, updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'OCCUPIED', to_state: 'DIRTY', people: 0,
    meta_json: JSON.stringify({ lastCheckoutMs: now, checkoutObs: obs })
  });

  return ok(res, { roomId, checkoutMs: now });
}

// ==================== EXTENDER TIEMPO (horas sueltas) ====================
async function apiHoraGratis(p, res) {
  const now = Date.now();
  const roomId = String(p.roomId || '').trim();
  const room = await getRoom(roomId);
  if(!room) return err(res, 'Habitacion no existe');
  if(room.state !== 'OCCUPIED') return err(res, 'Solo si OCUPADA');
  const newDueMs = Number(room.due_ms || now) + 3600000;
  await supabase.from('rooms').update({ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  return ok(res, { roomId, newDueMs });
}
async function apiExtendTime(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
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

  await supabase.from('rooms').update({ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('sales').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'EXTENSION',
    room_id: roomId, category: room.category, duration_hrs: extraHrs,
    base_price: extraCost, people: Number(room.people || 0),
    extra_hours: extraHrs, extra_hours_value: extraCost, total: extraCost,
    pay_method: payMethod, check_in_ms: Number(room.check_in_ms || 0), due_ms: newDueMs
  });

  return ok(res, { roomId, extraCost, newDueMs });
}

// ==================== RENOVAR TIEMPO (bloque completo) ====================
async function apiRenewTime(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
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
  // Si es retoque, habilitar directamente
  if(room.retoque){
    await supabase.from('rooms').update({retoque:false,state:'AVAILABLE',state_since_ms:now,updated_at:new Date().toISOString()}).eq('room_id',roomId);
    return ok(res,{roomId,maidName,startedMs:now,retoque:true});
  }

  await supabase.from('maid_log').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    maid_name: maidName, room_id: roomId,
    action: 'START', state: room.state, note: '',
    started_ms: now, finished_ms: 0,
    state_from: room.state, state_to: ''
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

  // Buscar registro START activo (finished_ms = 0) para esta camarera y habitacion
  const { data: openLog } = await supabase.from('maid_log')
    .select('id, started_ms, ts_ms')
    .eq('maid_name', maidName).eq('room_id', roomId).eq('business_day', bDay)
    .eq('action', 'START').eq('finished_ms', 0)
    .order('ts_ms', { ascending: false }).limit(1);

  let startedMs = openLog && openLog.length ? Number(openLog[0].started_ms || openLog[0].ts_ms) : now;

  const lastCheckoutMs = Number(room.last_checkout_ms || 0);
  const dirtyMins = lastCheckoutMs ? Math.max(0, Math.round((now - lastCheckoutMs) / 60000)) : 0;
  const cleanMins = Math.max(0, Math.round((now - startedMs) / 60000));
  const contaminatedSinceMs = resultState === 'CONTAMINATED' ? now : 0;

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

  // Actualizar el registro START con finished_ms o insertar nuevo registro FINISH
 if (openLog && openLog.length) {
    if(resultState === 'CONTAMINATED'){
      // No cerrar el log — la habitacion sigue en proceso
    } else {
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
      stateFrom: r.state_from || '', stateTo: r.state_to || ''
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

  // Buscar log abierto y cerrarlo
  const { data: openLog } = await supabase.from('maid_log')
    .select('id, started_ms')
    .eq('room_id', roomId).eq('business_day', bDay)
    .eq('action', 'START').eq('finished_ms', 0)
    .order('ts_ms', { ascending: false }).limit(1);

  if (openLog && openLog.length) {
    await supabase.from('maid_log').update({
      action: 'FINISH', finished_ms: now, state_to: 'AVAILABLE'
    }).eq('id', openLog[0].id);
  } else {
    await supabase.from('maid_log').insert({
      ts_ms: now, business_day: bDay, shift_id: shift,
      maid_name: userName, room_id: roomId,
      action: 'FINISH', state: 'AVAILABLE', note: '',
      started_ms: now, finished_ms: now,
      state_from: 'CONTAMINATED', state_to: 'AVAILABLE'
    });
  }

  return ok(res, { roomId });
}

// v3: RECEPTION puede bloquear, solo ADMIN puede desbloquear
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

async function apiRefund(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const amount = Math.max(1, Number(p.amount || 0));
  const reason = String(p.refundReason || '').trim();
  if (reason.length < 3) return err(res, 'Motivo obligatorio');
  const room = await getRoom(roomId);
  await supabase.from('sales').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, type: 'REFUND', room_id: roomId, category: room ? room.category : '', total: -amount, refund_reason: reason, pay_method: 'EFECTIVO' });
  return ok(res, { roomId, total: -amount });
}

async function apiTaxi(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  await supabase.from('taxi_expenses').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: String(p.userName || ''), amount: 3000, note: 'Taxi fijo', room_id: roomId });
  return ok(res, {});
}

// ==================== PRESTAMOS ====================
async function apiAddLoan(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
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
// Sin campo de habitacion — solo nombre, turno, entrada, salida, pago
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

// ==================== NOTAS v3 (historial permanente, borrado logico) ====================
async function apiAddNote(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const target = String(p.target || 'ALL').toUpperCase();
  await supabase.from('shift_notes').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: String(p.userRole || ''), user_name: String(p.userName || ''),
    note: String(p.note || ''), target,
    seen_by: '[]', is_deleted: false
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
    businessDay: r.business_day
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

// v3: historial de notas de todos los dias
async function apiGetNoteHistory(p, res) {
  const limit = Math.min(200, Number(p.limit || 100));
  const fromDate = String(p.fromDate || '');
  let query = supabase.from('shift_notes').select('*').eq('is_deleted', false).order('ts_ms', { ascending: false }).limit(limit);
  if (fromDate) query = query.gte('business_day', fromDate);
  const { data } = await query;
  return ok(res, { notes: (data || []).map(r => ({ id: r.id, tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, userRole: r.user_role, userName: r.user_name, note: r.note })) });
}



// ==================== CIERRE DE TURNO ====================
async function apiCloseShift(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '');
  // Marcar turno como cerrado para liberar el acceso
  await supabase.from('shift_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, action: 'LOGOUT', logout_ms: now });

  const [salesRes, taxiRes, loansRes, extraRes] = await Promise.all([
    supabase.from('sales').select('type,total,pay_method,people,room_id').eq('business_day', bDay).eq('shift_id', shift),
    supabase.from('taxi_expenses').select('amount').eq('business_day', bDay).eq('shift_id', shift),
    supabase.from('loans').select('amount').eq('business_day', bDay).eq('shift_id', shift),
    supabase.from('extra_staff').select('payment').eq('business_day', bDay).eq('shift_id', shift)
  ]);

  let totalSales=0, totalRefunds=0, totalTaxi=0, totalLoans=0, totalExtraStaff=0;
  let roomsSold=0, people=0, totalEfectivo=0, totalTarjeta=0, totalNequi=0;

  (salesRes.data || []).forEach(r => {
    if (String(r.room_id) === '304') return;
    const t = Number(r.total||0), pm = String(r.pay_method||'').toUpperCase();
    if (r.type === 'SALE') { totalSales+=t; roomsSold++; people+=Number(r.people||0); if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
    if (r.type === 'REFUND') totalRefunds += t;
    if (r.type === 'EXTENSION' || r.type === 'RENEWAL') { totalSales+=t; if(pm==='EFECTIVO')totalEfectivo+=t; else if(pm==='TARJETA')totalTarjeta+=t; else if(pm==='NEQUI')totalNequi+=t; }
  });
  (taxiRes.data||[]).forEach(r=>{totalTaxi+=Number(r.amount||0);});
  (loansRes.data||[]).forEach(r=>{totalLoans+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{totalExtraStaff+=Number(r.payment||0);});

  const net = totalSales + totalRefunds - totalTaxi - totalLoans - totalExtraStaff;

  await supabase.from('shift_close').insert({
    ts_ms: now, business_day: bDay, shift_id: shift, user_name: userName,
    total_sales: totalSales, total_refunds: totalRefunds, total_taxi: totalTaxi,
    total_loans: totalLoans, total_extra_staff: totalExtraStaff, net,
    rooms_sold: roomsSold, people, cash_count: Number(p.cashCount||0),
    notes: String(p.notes||''), total_efectivo: totalEfectivo,
    total_tarjeta: totalTarjeta, total_nequi: totalNequi
  });

  return ok(res, { summary: { bizDay: bDay, shiftId: shift, totalSales, totalRefunds, totalTaxi, totalLoans, totalExtraStaff, net, roomsSold, people, totalEfectivo, totalTarjeta, totalNequi } });
}

// ==================== METRICAS v3 (filtrado REAL por turno) ====================
async function apiMetrics(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const shiftFilter = String(p.shiftId || '');

  const [salesRes, taxiRes, loansRes, extraRes, barRes, gastoRes, settingsRes] = await Promise.all([
    supabase.from('sales').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('taxi_expenses').select('*').eq('business_day', bDay),
    supabase.from('loans').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('extra_staff').select('*').eq('business_day', bDay),
    supabase.from('bar_sales').select('*').eq('business_day', bDay),
    supabase.from('general_expenses').select('*').eq('business_day', bDay),
    supabase.from('settings').select('key,value')
  ]);

  const settings={};(settingsRes.data||[]).forEach(r=>{settings[r.key]=r.value;});
  const dailyGoal=Number(settings.DAILY_GOAL||0);
let dayTotal=0,dayRefunds=0,dayTaxi=0,dayBar=0,dayGastos=0,dayLoans=0,dayExtraStaff=0;
  let dayEfe=0,dayTar=0,dayNeq=0;
  let shiftSales=0,shiftRooms=0,shiftPeople=0,shiftEfe=0,shiftTar=0,shiftNeq=0,shiftTaxi=0,shiftBar=0,shiftGastos=0;
  const allSalesList=[];
  // Reset explícito
  dayTotal=0;dayRefunds=0;dayTaxi=0;dayBar=0;dayGastos=0;dayLoans=0;dayExtraStaff=0;
  dayEfe=0;dayTar=0;dayNeq=0;
  shiftSales=0;shiftRooms=0;shiftPeople=0;shiftEfe=0;shiftTar=0;shiftNeq=0;shiftTaxi=0;shiftBar=0;shiftGastos=0;

  (salesRes.data||[]).forEach(r=>{
    const t=Number(r.total||0),type=r.type,pm=String(r.pay_method||'').toUpperCase(),sid=r.shift_id;
    const isRev=type==='SALE'||type==='EXTENSION'||type==='RENEWAL';
    const skip304 = String(r.room_id) === '304';
    if(isRev){
      if(!skip304){
        dayTotal+=t;
        if(pm==='EFECTIVO')dayEfe+=t;else if(pm==='TARJETA')dayTar+=t;else if(pm==='NEQUI')dayNeq+=t;else if(pm==='MIXTO'){dayEfe+=Number(r.amount_1||0);dayTar+=Number(r.amount_2||0);dayNeq+=Number(r.amount_3||0);}
      }
      if(type==='SALE')allSalesList.push({tsMs:Number(r.ts_ms),shiftId:sid,roomId:r.room_id,category:r.category,type,durationHrs:Number(r.duration_hrs||0),people:Number(r.people||0),total:t,extraPeople:Number(r.extra_people||0),extraPeopleValue:Number(r.extra_people_value||0),arrivalType:r.arrival_type||'',arrivalPlate:r.arrival_plate||'',payMethod:pm,paidWith:Number(r.paid_with||0),change:Number(r.change_given||0),userName:r.user_name,checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:Number(r.due_ms||0),amount_1:Number(r.amount_1||0),amount_2:Number(r.amount_2||0),amount_3:Number(r.amount_3||0)});
      if(!shiftFilter||sid===shiftFilter){
        if(!skip304){
          shiftSales+=t;
          if(pm==='EFECTIVO')shiftEfe+=t;else if(pm==='TARJETA')shiftTar+=t;else if(pm==='NEQUI')shiftNeq+=t;else if(pm==='MIXTO'){shiftEfe+=Number(r.amount_1||0);shiftTar+=Number(r.amount_2||0);shiftNeq+=Number(r.amount_3||0);}
          if(type==='SALE'){shiftRooms++;shiftPeople+=Number(r.people||0);}
        }
      }
    }
    if(type==='REFUND')dayRefunds+=t;
  });
  const taxiList=[];
(taxiRes.data||[]).forEach(r=>{const a=Number(r.amount||0);dayTaxi+=a;if(!shiftFilter||r.shift_id===shiftFilter)shiftTaxi+=a;taxiList.push({tsMs:Number(r.ts_ms),shiftId:r.shift_id,roomId:r.room_id||'',amount:a,businessDay:r.business_day||''});});
 let dayBarEfe=0,dayBarTar=0,dayBarNeq=0;
  (barRes.data||[]).forEach(r=>{const a=Number(r.amount_cash||0)+Number(r.amount_card||0)+Number(r.amount_nequi||0);dayBar+=a;dayBarEfe+=Number(r.amount_cash||0);dayBarTar+=Number(r.amount_card||0);dayBarNeq+=Number(r.amount_nequi||0);if(!shiftFilter||r.shift_id===shiftFilter)shiftBar+=a;});
  (gastoRes.data||[]).forEach(r=>{const a=Number(r.amount||0);dayGastos+=a;if(!shiftFilter||r.shift_id===shiftFilter)shiftGastos+=a;});
  (loansRes.data||[]).forEach(r=>{dayLoans+=Number(r.amount||0);});
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
      shiftEfectivo:shiftEfe,shiftTarjeta:shiftTar,shiftNequi:shiftNeq
    },
    loans:(loansRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),shiftId:r.shift_id,userName:r.user_name,borrowerName:r.borrower_name,amount:Number(r.amount),note:r.note})),
    extraStaff:(extraRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),shiftId:r.shift_id,personName:r.person_name,area:r.area,entryMs:Number(r.entry_ms||0),exitMs:Number(r.exit_ms||0),payment:Number(r.payment||0),active:r.active,paidBy:r.paid_by||''})),
    allSalesList:allSalesList.sort((a,b)=>a.tsMs-b.tsMs),
    taxiList,
    dailyGoal,goalProgress:dailyGoal>0?Math.round((dayTotal/dailyGoal)*100):null
  });
}

// ==================== METRICAS POR HORA (6AM->6AM) ====================
async function apiMetricsHourly(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { start, end } = businessDayRange(bDay);
  const mode = String(p.mode || 'count'); // 'count' o 'sales'

  const { data } = await supabase.from('sales')
    .select('ts_ms, total, type')
    .eq('business_day', bDay)
    .in('type', ['SALE', 'EXTENSION', 'RENEWAL'])
    .order('ts_ms');

  // Crear 24 buckets: hora 0 = 6AM, hora 23 = 5AM siguiente
  // buckets[i] = { label: '6:00', hour: i, realHour: (6+i)%24, count: 0, sales: 0 }
  const buckets = [];
  for (let i = 0; i < 24; i++) {
    const realHour = (6 + i) % 24;
    buckets.push({ bucket: i, realHour, label: realHour + ':00', count: 0, sales: 0 });
  }

  (data || []).forEach(r => {
    const ms = Number(r.ts_ms || 0);
    if (ms < start || ms >= end) return;
    const realHour = new Date(ms).getHours();
    // Convertir a bucket index: realHour 6->0, 7->1, ..., 5(next)->23
    const bucketIdx = realHour >= 6 ? realHour - 6 : realHour + 18;
    if (buckets[bucketIdx]) {
      buckets[bucketIdx].count++;
      buckets[bucketIdx].sales += Number(r.total || 0);
    }
  });

  return ok(res, { businessDay: bDay, buckets, mode });
}

async function apiMonthMetrics(p, res) {
  const ym = String(p.yearMonth || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return err(res, 'yearMonth invalido. Formato: YYYY-MM');
  const { data: sales } = await supabase.from('sales').select('business_day,type,total,people').like('business_day', ym + '%');
  const { data: taxi } = await supabase.from('taxi_expenses').select('business_day,amount').like('business_day', ym + '%');
  const dayMap = {};
  const ed = d => { if(!dayMap[d])dayMap[d]={day:d,sales:0,refunds:0,taxi:0,net:0,people:0,roomsSold:0}; return dayMap[d]; };
  (sales||[]).forEach(r=>{const d=ed(r.business_day),t=Number(r.total||0);if(['SALE','EXTENSION','RENEWAL'].includes(r.type)){d.sales+=t;if(r.type==='SALE'){d.roomsSold++;d.people+=Number(r.people||0);}}if(r.type==='REFUND')d.refunds+=t;});
  (taxi||[]).forEach(r=>{ed(r.business_day).taxi+=Number(r.amount||0);});
  const days = Object.values(dayMap).sort((a,b)=>a.day.localeCompare(b.day));
  days.forEach(d=>{d.net=d.sales+d.refunds-d.taxi;});
  const monthTotals = days.reduce((acc,d)=>{acc.sales+=d.sales;acc.refunds+=d.refunds;acc.taxi+=d.taxi;acc.net+=d.net;acc.people+=d.people;acc.roomsSold+=d.roomsSold;return acc;},{sales:0,refunds:0,taxi:0,net:0,people:0,roomsSold:0});
  return ok(res, { yearMonth: ym, monthTotals, days });
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
// v3: ficha completa del trabajador
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
  return ok(res,{schedule:(data||[]).map(r=>({weekStart:r.week_start,shiftId:r.shift_id,area:r.area,personName:r.person_name,dayOfWeek:r.day_of_week,type:r.type}))});
}
async function apiSaveSchedule(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN')return err(res,'Solo el administrador puede guardar el calendario');
  const ws=String(p.weekStart||'').trim(),entries=p.entries||[];
  if(!ws)return err(res,'Semana requerida');
  const mesPrefix=ws.substring(0,7);
  const existingRes=await supabase.from('schedule').select('id,area,person_name,day_of_week');const existing=existingRes.data||[];
  const toDelete=(existing||[]).filter(function(r){
    return String(r.day_of_week||'').startsWith(mesPrefix)&&
      entries.some(function(e){return e.area===r.area&&e.personName===r.person_name;});
  }).map(function(r){return r.id;});
  if(toDelete.length>0){
    await supabase.from('schedule').delete().in('id',toDelete);
  }
  if(entries.length>0){
    const rows=entries.map(e=>({week_start:ws,shift_id:String(e.shiftId||''),area:String(e.area||''),person_name:String(e.personName||''),day_of_week:String(e.dayOfWeek||''),type:String(e.type||'normal')}));
    await supabase.from('schedule').insert(rows);
  }
  return ok(res,{saved:entries.length,weekStart:ws});
}

} if(entries.length>0){
    const rows=entries.map(e=>({week_start:ws,shift_id:String(e.shiftId||''),area:String(e.area||''),person_name:String(e.personName||''),day_of_week:String(e.dayOfWeek||''),type:String(e.type||'nomina')}));
    await supabase.from('schedule').insert(rows);
  }
  // Sincronizar con extra_staff si viene de personal extra
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
  const[stateRes,salesRes]=await Promise.all([
    supabase.from('state_history').select('*').eq('room_id',roomId).order('ts_ms',{ascending:false}).limit(limit),
    supabase.from('sales').select('*').eq('room_id',roomId).in('type',['SALE','EXTENSION','RENEWAL']).order('ts_ms',{ascending:false}).limit(limit)
  ]);
  return ok(res,{
    roomId,
    stateHistory:(stateRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),businessDay:r.business_day,fromState:r.from_state,toState:r.to_state,userName:r.user_name,meta:(()=>{try{return JSON.parse(r.meta_json||'{}');}catch(e){return{};}})()})),
    salesHistory:(salesRes.data||[]).map(r=>({tsMs:Number(r.ts_ms),businessDay:r.business_day,type:r.type,durationHrs:Number(r.duration_hrs||0),total:Number(r.total||0),people:Number(r.people||0),extraPeople:Number(r.extra_people||0),arrivalType:r.arrival_type||'',arrivalPlate:r.arrival_plate||'',userName:r.user_name,payMethod:r.pay_method||'',checkInMs:Number(r.check_in_ms||r.ts_ms),dueMs:Number(r.due_ms||0)}))
  });
}

// ==================== NUEVOS v3 ====================

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
  // Por defecto: ayer (business day anterior)
  const defaultDay=businessDay(Date.now()-86400000);
  const bDay=String(p.businessDay||defaultDay);

  const[salesRes,taxiRes,extraRes,barRes,gastoRes,shiftLogRes]=await Promise.all([
    supabase.from('sales').select('type,total,pay_method,extra_people_value,shift_id,room_id').eq('business_day',bDay),
    supabase.from('taxi_expenses').select('amount,shift_id').eq('business_day',bDay),
    supabase.from('extra_staff').select('payment,shift_id').eq('business_day',bDay),
    supabase.from('bar_sales').select('amount_cash,amount_card,shift_id').eq('business_day',bDay),
    supabase.from('general_expenses').select('amount,shift_id').eq('business_day',bDay),
    supabase.from('shift_log').select('shift_id,user_name,ts_ms').eq('business_day',bDay).eq('user_role','RECEPTION').eq('action','LOGIN').order('ts_ms')
  ]);

  const responsables={SHIFT_1:'—',SHIFT_2:'—',SHIFT_3:'—'};
  (shiftLogRes.data||[]).forEach(r=>{if(responsables[r.shift_id]==='—')responsables[r.shift_id]=r.user_name;});

  const shifts=['SHIFT_1','SHIFT_2','SHIFT_3'];
  const c={};
  shifts.forEach(sid=>{c[sid]={responsable:responsables[sid],tarjetaHab:0,tarjetaPersonas:0,tarjetaHoras:0,tarjetaBar:0,efectivoHab:0,efectivoPersonas:0,efectivoHoras:0,efectivoBar:0,gastos:0,taxis:0,turnos:0};});

  (salesRes.data||[]).forEach(r=>{
    const sid=r.shift_id;if(!c[sid])return;
    if(String(r.room_id) === '304') return;
    const t=Number(r.total||0),pm=String(r.pay_method||'').toUpperCase(),epv=Number(r.extra_people_value||0);
    if(r.type==='SALE'){
      const habVal=t-epv;
      if(pm==='TARJETA'){c[sid].tarjetaHab+=habVal;c[sid].tarjetaPersonas+=epv;}
      else{c[sid].efectivoHab+=habVal;c[sid].efectivoPersonas+=epv;}
    }
    if(r.type==='EXTENSION'||r.type==='RENEWAL'){
      if(pm==='TARJETA')c[sid].tarjetaHoras+=t;else c[sid].efectivoHoras+=t;
    }
  });
  (barRes.data||[]).forEach(r=>{const sid=r.shift_id;if(!c[sid])return;c[sid].tarjetaBar+=Number(r.amount_card||0);c[sid].efectivoBar+=Number(r.amount_cash||0);});
  (taxiRes.data||[]).forEach(r=>{const sid=r.shift_id;if(c[sid])c[sid].taxis+=Number(r.amount||0);});
  (extraRes.data||[]).forEach(r=>{const sid=r.shift_id;if(c[sid])c[sid].turnos+=Number(r.payment||0);});
  (gastoRes.data||[]).forEach(r=>{const sid=r.shift_id;if(c[sid])c[sid].gastos+=Number(r.amount||0);});

  const cuadre={};let diaTotal=0;
  shifts.forEach(sid=>{
    const x=c[sid];
    const totTarjeta=x.tarjetaHab+x.tarjetaPersonas+x.tarjetaHoras+x.tarjetaBar;
    const totEfectivo=x.efectivoHab+x.efectivoPersonas+x.efectivoHoras+x.efectivoBar;
    const totGastos=x.gastos+x.taxis+x.turnos;
    const entrega=totTarjeta+totEfectivo-totGastos;
    diaTotal+=entrega;
    cuadre[sid]={responsable:x.responsable,tarjeta:{hab:x.tarjetaHab,personas:x.tarjetaPersonas,horas:x.tarjetaHoras,bar:x.tarjetaBar,total:totTarjeta},efectivo:{hab:x.efectivoHab,personas:x.efectivoPersonas,horas:x.efectivoHoras,bar:x.efectivoBar,total:totEfectivo},gastos:{generales:x.gastos,taxis:x.taxis,turnos:x.turnos,total:totGastos},entregaDiaria:entrega};
  });
  return ok(res,{businessDay:bDay,cuadre,entregaTotalDia:diaTotal});
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

  // Calcular diferencia de precio
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
    checkout_obs: 'CAMBIO DE HABITACION a '+toRoomId,
    updated_at: new Date().toISOString()
  }).eq('room_id', fromRoomId);

  // Check-in en habitacion destino
  const newDueMs = now + durationHrs * 3600000;
  await supabase.from('rooms').update({
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: now, due_ms: newDueMs,
    arrival_type: fromRoom.arrival_type || 'WALK',
    arrival_plate: fromRoom.arrival_plate || '',
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0,
    updated_at: new Date().toISOString()
  }).eq('room_id', toRoomId);

  // Registrar diferencia si la hay
  if(diff > 0) {
    await supabase.from('sales').insert({
      ts_ms: now, business_day: bDay, shift_id: shift,
      user_role: 'RECEPTION', user_name: userName, type: 'SALE',
      room_id: toRoomId, category: toRoom.category, duration_hrs: durationHrs,
      base_price: diff, people, total: diff,
      pay_method: payMethod, check_in_ms: now, due_ms: newDueMs,
      arrival_type: fromRoom.arrival_type||'WALK'
    });
  } else if(diff < 0) {
    await supabase.from('sales').insert({
      ts_ms: now, business_day: bDay, shift_id: shift,
      user_role: 'RECEPTION', user_name: userName, type: 'REFUND',
      room_id: fromRoomId, category: fromRoom.category, total: diff,
      pay_method: payMethod, refund_reason: 'CAMBIO DE HABITACION a '+toRoomId
    });
  }

  return ok(res, { fromRoomId, toRoomId, diff, newDueMs });
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
async function apiClearMaintHistory(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const from=String(p.from||'');
  const to=String(p.to||'');
  if(!from||!to) return err(res,'Fechas requeridas');
  await supabase.from('maintenance').delete().gte('business_day',from).lte('business_day',to);
  return ok(res,{});
}
async function apiClearMaidLog(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const bDay=String(p.businessDay||businessDay(Date.now()));
  await supabase.from('maid_log').delete().eq('business_day',bDay);
  return ok(res,{businessDay:bDay});
}
