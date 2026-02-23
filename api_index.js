// ============================================================
// CASA 50 - SPA MOTEL | API Backend v1
// api/index.js - Corre en Vercel (Node.js serverless)
// ============================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==================== PRECIOS Y HABITACIONES ====================
const MASTER_PRICING = {
  'Junior':         { h3:60000,  h6:120000, h8:160000,  h12:105000, extraHour:20000, extraPerson:20000, included:2 },
  'Suite Jacuzzi':  { h3:85000,  h6:170000, h8:220000,  h12:130000, extraHour:25000, extraPerson:25000, included:2 },
  'Presidencial':   { h3:105000, h6:210000, h8:265000,  h12:145000, extraHour:30000, extraPerson:30000, included:2 },
  'Suite Multiple': { h3:135000, h6:0,      h8:195000,  h12:235000, extraHour:35000, extraPerson:30000, included:4 },
  'Suite Disco':    { h3:180000, h6:360000, h8:430000,  h12:315000, extraHour:35000, extraPerson:30000, included:4 }
};

// ==================== HELPERS ====================
function currentShiftId(ms) {
  const h = new Date(ms || Date.now()).getHours();
  if (h >= 6 && h < 14) return 'SHIFT_1';
  if (h >= 14 && h < 21) return 'SHIFT_2';
  return 'SHIFT_3';
}

function businessDay(ms) {
  const d = new Date(ms || Date.now());
  const h = d.getHours();
  const dd = new Date(d);
  if (h < 6) dd.setDate(dd.getDate() - 1);
  const y = dd.getFullYear();
  const m = String(dd.getMonth() + 1).padStart(2, '0');
  const day = String(dd.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function calcPrice(durationHrs, cfg) {
  if (durationHrs === 3) return Number(cfg.h3 || 0);
  if (durationHrs === 6) return Number(cfg.h6 || 0);
  if (durationHrs === 8) return Number(cfg.h8 || (Number(cfg.h6 || 0) + 2 * Number(cfg.extraHour || 0)));
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

// ==================== HANDLER PRINCIPAL ====================
module.exports = async function handler(req, res) {
  // CORS preflight
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
      case 'bootstrap':    return await apiBootstrap(req, res);
      case 'getRooms':     return await apiGetRooms(req, res);
      case 'login':        return await apiLogin(payload, res);
      case 'checkIn':      return await apiCheckIn(payload, res);
      case 'checkOut':     return await apiCheckOut(payload, res);
      case 'extendTime':   return await apiExtendTime(payload, res);
      case 'silenceAlarm': return await apiSilenceAlarm(payload, res);
      case 'maidFinish':   return await apiMaidFinish(payload, res);
      case 'maidLogAction':return await apiMaidLogAction(payload, res);
      case 'maidMarkExit': return await apiMaidMarkExit(payload, res);
      case 'getMaidLog':   return await apiGetMaidLog(payload, res);
      case 'clearContaminated': return await apiClearContaminated(payload, res);
      case 'setMinorNote': return await apiSetMinorNote(payload, res);
      case 'setDisabled':  return await apiSetDisabled(payload, res);
      case 'refund':       return await apiRefund(payload, res);
      case 'taxi':         return await apiTaxi(payload, res);
      case 'addLoan':      return await apiAddLoan(payload, res);
      case 'getLoans':     return await apiGetLoans(payload, res);
      case 'registerExtraStaff':  return await apiRegisterExtra(payload, res);
      case 'checkoutExtraStaff':  return await apiCheckoutExtra(payload, res);
      case 'getExtraStaff':       return await apiGetExtra(payload, res);
      case 'addShiftNote': return await apiAddNote(payload, res);
      case 'getShiftNotes':return await apiGetNotes(payload, res);
      case 'closeShift':   return await apiCloseShift(payload, res);
      case 'metrics':      return await apiMetrics(payload, res);
      case 'monthMetrics': return await apiMonthMetrics(payload, res);
      case 'maidPanel':    return await apiMaidPanel(payload, res);
      case 'getStaff':     return await apiGetStaff(payload, res);
      case 'saveStaff':    return await apiSaveStaff(payload, res);
      case 'getSchedule':  return await apiGetSchedule(payload, res);
      case 'saveSchedule': return await apiSaveSchedule(payload, res);
      case 'setDailyGoal': return await apiSetGoal(payload, res);
      case 'setReceptionPin':    return await apiSetPin(payload, res);
      case 'getReceptionPins':   return await apiGetPins(payload, res);
      case 'changeAdminPin':     return await apiChangeAdminPin(payload, res);
      case 'roomHistory':  return await apiRoomHistory(payload, res);
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
    settings,
    rooms: (rooms || []).map(mapRoom),
    masterPricing: MASTER_PRICING,
    serverNowMs: now,
    businessDay: businessDay(now),
    currentShiftId: currentShiftId(now),
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

function mapRoom(r) {
  return {
    roomId: r.room_id, floor: r.floor, category: r.category,
    state: r.state, stateSinceMs: Number(r.state_since_ms || 0),
    people: Number(r.people || 0), checkInMs: Number(r.check_in_ms || 0),
    dueMs: Number(r.due_ms || 0), lastCheckoutMs: Number(r.last_checkout_ms || 0),
    noteMinor: !!r.note_minor, noteMinorText: r.note_minor_text || '',
    disabled: !!r.disabled, disabledReason: r.disabled_reason || '',
    arrivalType: r.arrival_type || '', arrivalPlate: r.arrival_plate || '',
    alarmSilencedMs: Number(r.alarm_silenced_ms || 0),
    alarmSilencedForDueMs: Number(r.alarm_silenced_for_due_ms || 0),
    checkoutObs: r.checkout_obs || '',
    contaminatedSinceMs: Number(r.contaminated_since_ms || 0)
  };
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

  // Verificar bloqueo por intentos fallidos
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
      return err(res, 'Este turno ya tiene recepcionista: ' + existing.user_name);
    }
    await supabase.from('shift_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, action: existing ? 'RELOGIN' : 'LOGIN' });
    return ok(res, { session: { userName, userRole: 'RECEPTION', shiftId: shift, businessDay: bDay, serverNowMs: now } });
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
  if (room.state !== 'AVAILABLE') return err(res, `Hab ${roomId} no esta disponible (estado: ${room.state})`);

  const cfg = MASTER_PRICING[room.category] || MASTER_PRICING['Junior'];
  const people = Math.max(1, Number(p.people || cfg.included));
  const basePrice = calcPrice(durationHrs, cfg);
  const includedPeople = Number(cfg.included || 2);
  const extraPeople = Math.max(0, people - includedPeople);
  const extraPeopleValue = extraPeople * Number(cfg.extraPerson || 0);
  const total = basePrice + extraPeopleValue;
  const dueMs = now + durationHrs * 3600000;
  const arrivalType = String(p.arrivalType || 'WALK').toUpperCase();
  const arrivalPlate = arrivalType === 'CAR' ? String(p.arrivalPlate || '').toUpperCase().trim() : '';
  const payMethod = String(p.payMethod || 'EFECTIVO').toUpperCase();
  const paidWith = Number(p.paidWith || 0);
  const changeGiven = payMethod === 'EFECTIVO' && paidWith >= total ? Math.max(0, paidWith - total) : 0;

  // Actualizar habitacion
  await supabase.from('rooms').update({
    state: 'OCCUPIED', state_since_ms: now, people,
    check_in_ms: now, due_ms: dueMs,
    arrival_type: arrivalType, arrival_plate: arrivalPlate,
    alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0,
    checkout_obs: '', contaminated_since_ms: 0, updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  // Registrar venta
  await supabase.from('sales').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'SALE',
    room_id: roomId, category: room.category, duration_hrs: durationHrs,
    base_price: basePrice, people, included_people: includedPeople,
    extra_people: extraPeople, extra_people_value: extraPeopleValue,
    extra_hours: 0, extra_hours_value: 0, total,
    arrival_type: arrivalType, arrival_plate: arrivalPlate,
    pay_method: payMethod, paid_with: paidWith, change_given: changeGiven,
    check_in_ms: now, due_ms: dueMs
  });

  // Historial de estados
  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, room_id: roomId,
    from_state: 'AVAILABLE', to_state: 'OCCUPIED', people,
    meta_json: JSON.stringify({ durationHrs, basePrice, total, dueMs, arrivalType, arrivalPlate, payMethod, paidWith, changeGiven, checkInMs: now })
  });

  return ok(res, { roomId, total, change: changeGiven, checkInMs: now, dueMs });
}

// ==================== CHECK-OUT ====================
async function apiCheckOut(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const obs = String(p.checkoutObs || '').trim();
  if (!roomId) return err(res, 'roomId requerido');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo checkout si esta OCUPADA');

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

// ==================== EXTENDER TIEMPO ====================
async function apiExtendTime(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const roomId = String(p.roomId || '').trim();
  const extraHrs = Number(p.extraHrs || 0);
  if (![1, 2, 3, 4, 5, 6].includes(extraHrs)) return err(res, 'Horas extra invalidas (1-6)');

  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'OCCUPIED') return err(res, 'Solo si esta OCUPADA');

  const cfg = MASTER_PRICING[room.category] || MASTER_PRICING['Junior'];
  const extraCost = extraHrs * Number(cfg.extraHour || 0);
  const newDueMs = Number(room.due_ms || now) + extraHrs * 3600000;

  await supabase.from('rooms').update({ due_ms: newDueMs, alarm_silenced_ms: 0, alarm_silenced_for_due_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('sales').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'RECEPTION', user_name: userName, type: 'EXTENSION',
    room_id: roomId, category: room.category, duration_hrs: extraHrs,
    base_price: extraCost, people: Number(room.people || 0),
    extra_hours: extraHrs, extra_hours_value: extraCost, total: extraCost,
    pay_method: 'EFECTIVO', check_in_ms: Number(room.check_in_ms || 0), due_ms: newDueMs
  });

  return ok(res, { roomId, extraCost, newDueMs });
}

// ==================== ALARMA ====================
async function apiSilenceAlarm(p, res) {
  const roomId = String(p.roomId || '').trim();
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  await supabase.from('rooms').update({ alarm_silenced_ms: Date.now(), alarm_silenced_for_due_ms: Number(room.due_ms || 0), updated_at: new Date().toISOString() }).eq('room_id', roomId);
  return ok(res, { roomId });
}

// ==================== CAMARERA ====================
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
  if (room.state !== 'DIRTY') return err(res, 'Hab debe estar SUCIA');

  const lastCheckoutMs = Number(room.last_checkout_ms || 0);
  const dirtyMins = lastCheckoutMs ? Math.max(0, Math.round((now - lastCheckoutMs) / 60000)) : 0;
  const contaminatedSinceMs = resultState === 'CONTAMINATED' ? now : 0;

  await supabase.from('rooms').update({
    state: resultState, state_since_ms: now,
    last_maid_name: maidName, last_maid_done_ms: now,
    last_maid_contaminated: resultState === 'CONTAMINATED',
    contaminated_since_ms: contaminatedSinceMs, updated_at: new Date().toISOString()
  }).eq('room_id', roomId);

  await supabase.from('state_history').insert({
    ts_ms: now, business_day: bDay, shift_id: shift,
    user_role: 'MAID', user_name: maidName, room_id: roomId,
    from_state: 'DIRTY', to_state: resultState, people: 0,
    meta_json: JSON.stringify({ maidName, lastCheckoutMs, maidDoneMs: now, dirtyMins, contaminated: resultState === 'CONTAMINATED' })
  });
  await supabase.from('maid_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, maid_name: maidName, room_id: roomId, action: 'FINISH', state: resultState, note: '', exit_ms: now });

  return ok(res, { roomId, dirtyMins });
}

async function apiMaidLogAction(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const maidName = String(p.maidName || p.userName || '').trim();
  if (!maidName) return err(res, 'Nombre requerido');
  await supabase.from('maid_log').insert({ ts_ms: now, business_day: bDay, shift_id: shift, maid_name: maidName, room_id: String(p.roomId || ''), action: String(p.action || ''), state: String(p.state || ''), note: String(p.note || ''), exit_ms: 0 });
  return ok(res, {});
}

async function apiMaidMarkExit(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const maidName = String(p.maidName || '').trim();
  const roomId = String(p.roomId || '').trim();
  await supabase.from('maid_log').update({ exit_ms: now }).eq('maid_name', maidName).eq('room_id', roomId).eq('business_day', bDay).eq('exit_ms', 0);
  return ok(res, { exitMs: now });
}

async function apiGetMaidLog(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('maid_log').select('*').eq('business_day', bDay).order('ts_ms');
  return ok(res, { logs: (data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, maidName: r.maid_name, roomId: r.room_id, action: r.action, state: r.state, note: r.note, exitMs: Number(r.exit_ms || 0) })) });
}

// ==================== HABITACION ACCIONES ====================
async function apiClearContaminated(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  if (room.state !== 'CONTAMINATED') return err(res, 'Solo si esta CONTAMINADA');
  await supabase.from('rooms').update({ state: 'AVAILABLE', state_since_ms: now, contaminated_since_ms: 0, updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('state_history').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: String(p.userName || ''), room_id: roomId, from_state: 'CONTAMINATED', to_state: 'AVAILABLE', people: 0, meta_json: '{"action":"clearContaminated"}' });
  return ok(res, { roomId });
}

async function apiSetMinorNote(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const enabled = !!p.enabled;
  const text = String(p.text || '').trim();
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  await supabase.from('rooms').update({ note_minor: enabled, note_minor_date_ms: enabled ? now : 0, note_minor_text: enabled ? text : '', updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('maintenance').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: String(p.userRole || 'RECEPTION'), user_name: String(p.userName || ''), room_id: roomId, type: enabled ? 'MINOR' : 'RESOLVE_MINOR', text: enabled ? text : 'RESUELTO' });
  return ok(res, { roomId });
}

async function apiSetDisabled(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const roomId = String(p.roomId || '').trim();
  const disableFlag = !!p.enabled;
  const reason = String(p.reason || '').trim();
  if (disableFlag && reason.length < 3) return err(res, 'Motivo obligatorio');
  const room = await getRoom(roomId);
  if (!room) return err(res, 'Habitacion no existe');
  await supabase.from('rooms').update({ disabled: disableFlag, disabled_date_ms: disableFlag ? now : 0, disabled_reason: disableFlag ? reason : '', updated_at: new Date().toISOString() }).eq('room_id', roomId);
  await supabase.from('maintenance').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'ADMIN', user_name: String(p.userName || 'ADMIN'), room_id: roomId, type: disableFlag ? 'DISABLE' : 'ENABLE', text: disableFlag ? reason : 'HABILITADA' });
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
  const userName = String(p.userName || '').trim();
  await supabase.from('taxi_expenses').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: 'RECEPTION', user_name: userName, amount: 3000, note: 'Taxi fijo' });
  return ok(res, {});
}

// ==================== PRESTAMOS ====================
async function apiAddLoan(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '').trim();
  const borrowerName = String(p.borrowerName || '').trim();
  const amount = Number(p.amount || 0);
  if (!borrowerName) return err(res, 'Nombre requerido');
  if (amount <= 0) return err(res, 'Monto invalido');
  await supabase.from('loans').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_name: userName, borrower_name: borrowerName, amount, note: String(p.note || '') });
  return ok(res, {});
}

async function apiGetLoans(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('loans').select('*').eq('business_day', bDay).order('ts_ms');
  return ok(res, { loans: (data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, userName: r.user_name, borrowerName: r.borrower_name, amount: Number(r.amount), note: r.note })) });
}

// ==================== PERSONAL EXTRA ====================
async function apiRegisterExtra(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = String(p.shiftId || currentShiftId(now));
  const personName = String(p.personName || '').trim();
  const area = String(p.area || '').trim();
  if (!personName) return err(res, 'Nombre requerido');
  if (!area) return err(res, 'Area requerida');
  await supabase.from('extra_staff').insert({ ts_ms: now, business_day: bDay, shift_id: shift, registered_by: String(p.userName || ''), person_name: personName, entry_ms: now, area, active: true });
  return ok(res, { personName, area, shiftId: shift });
}

async function apiCheckoutExtra(p, res) {
  const now = Date.now();
  const personName = String(p.personName || '').trim();
  const payment = Number(p.payment || 0);
  const paidBy = String(p.paidBy || p.userName || '').trim();
  if (!personName) return err(res, 'Nombre requerido');
  if (payment <= 0) return err(res, 'Pago requerido');

  const { data } = await supabase.from('extra_staff').select('id').eq('person_name', personName).eq('active', true).order('ts_ms', { ascending: false }).limit(1);
  if (!data || !data.length) return err(res, `No se encontro "${personName}" activo`);

  await supabase.from('extra_staff').update({ exit_ms: now, payment, active: false, paid_ms: now, paid_by: paidBy }).eq('id', data[0].id);
  return ok(res, { personName, payment, paidBy });
}

async function apiGetExtra(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('extra_staff').select('*').eq('business_day', bDay).order('ts_ms');
  return ok(res, { extraStaff: (data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, personName: r.person_name, area: r.area, entryMs: Number(r.entry_ms || 0), exitMs: Number(r.exit_ms || 0), payment: Number(r.payment || 0), active: r.active, paidMs: Number(r.paid_ms || 0), paidBy: r.paid_by || '' })) });
}

// ==================== NOTAS ====================
async function apiAddNote(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  await supabase.from('shift_notes').insert({ ts_ms: now, business_day: bDay, shift_id: shift, user_role: String(p.userRole || ''), user_name: String(p.userName || ''), note: String(p.note || '') });
  return ok(res, {});
}

async function apiGetNotes(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const { data } = await supabase.from('shift_notes').select('*').eq('business_day', bDay).order('ts_ms', { ascending: false }).limit(50);
  return ok(res, { notes: (data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, userRole: r.user_role, userName: r.user_name, note: r.note })) });
}

// ==================== CIERRE DE TURNO ====================
async function apiCloseShift(p, res) {
  const now = Date.now();
  const bDay = businessDay(now);
  const shift = currentShiftId(now);
  const userName = String(p.userName || '');

  const [salesRes, taxiRes, loansRes, extraRes] = await Promise.all([
    supabase.from('sales').select('type,total,pay_method,people').eq('business_day', bDay).eq('shift_id', shift),
    supabase.from('taxi_expenses').select('amount').eq('business_day', bDay).eq('shift_id', shift),
    supabase.from('loans').select('amount').eq('business_day', bDay).eq('shift_id', shift),
    supabase.from('extra_staff').select('payment').eq('business_day', bDay).eq('shift_id', shift)
  ]);

  let totalSales = 0, totalRefunds = 0, totalTaxi = 0, totalLoans = 0, totalExtraStaff = 0;
  let roomsSold = 0, people = 0, totalEfectivo = 0, totalTarjeta = 0, totalNequi = 0;

  (salesRes.data || []).forEach(r => {
    const t = Number(r.total || 0), pm = String(r.pay_method || '').toUpperCase();
    if (r.type === 'SALE') {
      totalSales += t; roomsSold++; people += Number(r.people || 0);
      if (pm === 'EFECTIVO') totalEfectivo += t;
      else if (pm === 'TARJETA') totalTarjeta += t;
      else if (pm === 'NEQUI') totalNequi += t;
    }
    if (r.type === 'REFUND') totalRefunds += t;
  });
  (taxiRes.data || []).forEach(r => { totalTaxi += Number(r.amount || 0); });
  (loansRes.data || []).forEach(r => { totalLoans += Number(r.amount || 0); });
  (extraRes.data || []).forEach(r => { totalExtraStaff += Number(r.payment || 0); });

  const net = totalSales + totalRefunds - totalTaxi - totalLoans - totalExtraStaff;

  await supabase.from('shift_close').insert({
    ts_ms: now, business_day: bDay, shift_id: shift, user_name: userName,
    total_sales: totalSales, total_refunds: totalRefunds, total_taxi: totalTaxi,
    total_loans: totalLoans, total_extra_staff: totalExtraStaff, net,
    rooms_sold: roomsSold, people, cash_count: Number(p.cashCount || 0),
    notes: String(p.notes || ''), total_efectivo: totalEfectivo,
    total_tarjeta: totalTarjeta, total_nequi: totalNequi
  });

  return ok(res, { summary: { bizDay: bDay, shiftId: shift, totalSales, totalRefunds, totalTaxi, totalLoans, totalExtraStaff, net, roomsSold, people, totalEfectivo, totalTarjeta, totalNequi } });
}

// ==================== METRICAS ====================
async function apiMetrics(p, res) {
  const bDay = String(p.businessDay || businessDay(Date.now()));
  const shiftFilter = String(p.shiftId || '');

  const [salesRes, taxiRes, loansRes, extraRes, settingsRes] = await Promise.all([
    supabase.from('sales').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('taxi_expenses').select('*').eq('business_day', bDay),
    supabase.from('loans').select('*').eq('business_day', bDay).order('ts_ms'),
    supabase.from('extra_staff').select('*').eq('business_day', bDay),
    supabase.from('settings').select('key,value')
  ]);

  const settings = {};
  (settingsRes.data || []).forEach(r => { settings[r.key] = r.value; });
  const dailyGoal = Number(settings.DAILY_GOAL || 0);

  let totalSales = 0, totalRefunds = 0, totalTaxi = 0, totalLoans = 0, totalExtraStaff = 0;
  let shiftNet = 0, shiftSales = 0, shiftRooms = 0, shiftPeople = 0;
  let totalEfectivo = 0, totalTarjeta = 0, totalNequi = 0;
  const allSalesList = [];
  const hourMap = {};
  for (let h = 0; h < 24; h++) hourMap[h] = { hour: h, count: 0, sales: 0 };

  (salesRes.data || []).forEach(r => {
    const t = Number(r.total || 0), type = r.type, pm = String(r.pay_method || '').toUpperCase();
    const h = new Date(Number(r.ts_ms)).getHours();
    hourMap[h].count++; hourMap[h].sales += t;
    if (type === 'SALE') {
      totalSales += t;
      if (pm === 'EFECTIVO') totalEfectivo += t;
      else if (pm === 'TARJETA') totalTarjeta += t;
      else if (pm === 'NEQUI') totalNequi += t;
      allSalesList.push({
        tsMs: Number(r.ts_ms), shiftId: r.shift_id, roomId: r.room_id,
        category: r.category, durationHrs: Number(r.duration_hrs || 0),
        people: Number(r.people || 0), total: t, arrivalType: r.arrival_type || '',
        arrivalPlate: r.arrival_plate || '', payMethod: pm,
        paidWith: Number(r.paid_with || 0), change: Number(r.change_given || 0),
        userName: r.user_name, checkInMs: Number(r.check_in_ms || r.ts_ms),
        dueMs: Number(r.due_ms || 0)
      });
    }
    if (type === 'REFUND') totalRefunds += t;
    if (!shiftFilter || r.shift_id === shiftFilter) {
      shiftNet += t;
      if (type === 'SALE') { shiftSales += t; shiftRooms++; shiftPeople += Number(r.people || 0); }
    }
  });
  (taxiRes.data || []).forEach(r => {
    totalTaxi += Number(r.amount || 0);
    if (!shiftFilter || r.shift_id === shiftFilter) shiftNet -= Number(r.amount || 0);
  });
  (loansRes.data || []).forEach(r => { totalLoans += Number(r.amount || 0); });
  (extraRes.data || []).forEach(r => { totalExtraStaff += Number(r.payment || 0); });

  const net = totalSales + totalRefunds - totalTaxi - totalLoans - totalExtraStaff;

  return ok(res, {
    businessDay: bDay,
    totals: { sales: totalSales, refunds: totalRefunds, taxi: totalTaxi, loans: totalLoans, extraStaff: totalExtraStaff, net, shiftNet, shiftSales, shiftRoomsSold: shiftRooms, shiftPeople, totalEfectivo, totalTarjeta, totalNequi },
    hourBreakdown: Object.values(hourMap),
    loans: (loansRes.data || []).map(r => ({ tsMs: Number(r.ts_ms), shiftId: r.shift_id, userName: r.user_name, borrowerName: r.borrower_name, amount: Number(r.amount), note: r.note })),
    extraStaff: (extraRes.data || []).map(r => ({ tsMs: Number(r.ts_ms), shiftId: r.shift_id, personName: r.person_name, area: r.area, payment: Number(r.payment || 0), active: r.active, paidBy: r.paid_by || '' })),
    allSalesList: allSalesList.sort((a, b) => a.tsMs - b.tsMs),
    dailyGoal, goalProgress: dailyGoal > 0 ? Math.round((totalSales / dailyGoal) * 100) : null
  });
}

async function apiMonthMetrics(p, res) {
  const ym = String(p.yearMonth || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return err(res, 'yearMonth invalido. Formato: YYYY-MM');
  const { data: sales } = await supabase.from('sales').select('business_day,type,total,people').like('business_day', ym + '%');
  const { data: taxi } = await supabase.from('taxi_expenses').select('business_day,amount').like('business_day', ym + '%');
  const dayMap = {};
  const ed = d => { if (!dayMap[d]) dayMap[d] = { day: d, sales: 0, refunds: 0, taxi: 0, net: 0, people: 0, roomsSold: 0 }; return dayMap[d]; };
  (sales || []).forEach(r => { const d = ed(r.business_day), t = Number(r.total || 0); if (r.type === 'SALE') { d.sales += t; d.roomsSold++; d.people += Number(r.people || 0); } if (r.type === 'REFUND') d.refunds += t; });
  (taxi || []).forEach(r => { ed(r.business_day).taxi += Number(r.amount || 0); });
  const days = Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day));
  days.forEach(d => { d.net = d.sales + d.refunds - d.taxi; });
  const monthTotals = days.reduce((acc, d) => { acc.sales += d.sales; acc.refunds += d.refunds; acc.taxi += d.taxi; acc.net += d.net; acc.people += d.people; acc.roomsSold += d.roomsSold; return acc; }, { sales: 0, refunds: 0, taxi: 0, net: 0, people: 0, roomsSold: 0 });
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
    supabase.from('shift_log').select('*').eq('business_day', bDay).eq('shift_id', shift).eq('user_role', 'MAID').in('action', ['LOGIN', 'RELOGIN'])
  ]);

  const rooms = (roomsRes.data || []).map(mapRoom);
  const activeMaids = {};
  (shiftLogRes.data || []).forEach(r => { const n = r.user_name; if (!activeMaids[n] || Number(r.ts_ms) < activeMaids[n].tsMs) activeMaids[n] = { userName: n, loginMs: Number(r.ts_ms) }; });

  const dirtyRooms = rooms.filter(r => r.state === 'DIRTY').map(r => ({ roomId: r.roomId, category: r.category, lastCheckoutMs: r.lastCheckoutMs, waitingMins: r.lastCheckoutMs ? Math.round((now - r.lastCheckoutMs) / 60000) : 0 })).sort((a, b) => b.waitingMins - a.waitingMins);
  const contaminatedRooms = rooms.filter(r => r.state === 'CONTAMINATED').map(r => { const since = r.contaminatedSinceMs || r.stateSinceMs; return { roomId: r.roomId, category: r.category, contaminatedSinceMs: since, waitingMins: since ? Math.round((now - since) / 60000) : 0 }; });

  const byShift = { SHIFT_1: {}, SHIFT_2: {}, SHIFT_3: {} };
  (logsRes.data || []).forEach(r => {
    if (r.from_state !== 'DIRTY') return;
    if (r.to_state !== 'AVAILABLE' && r.to_state !== 'CONTAMINATED') return;
    let meta = {}; try { meta = JSON.parse(r.meta_json || '{}'); } catch (e) {}
    const maidName = String(meta.maidName || r.user_name || '');
    if (!maidName) return;
    const sid = ['SHIFT_1', 'SHIFT_2', 'SHIFT_3'].includes(r.shift_id) ? r.shift_id : 'SHIFT_1';
    if (!byShift[sid][maidName]) byShift[sid][maidName] = { maidName, rooms: 0, contaminated: 0, items: [] };
    byShift[sid][maidName].rooms++;
    if (r.to_state === 'CONTAMINATED') byShift[sid][maidName].contaminated++;
    byShift[sid][maidName].items.push({ roomId: r.room_id, dirtyMins: Number(meta.dirtyMins || 0) });
  });

  const shiftReport = {};
  ['SHIFT_1', 'SHIFT_2', 'SHIFT_3'].forEach(sid => { shiftReport[sid] = Object.values(byShift[sid]).map(x => ({ maidName: x.maidName, totalRooms: x.rooms, contaminated: x.contaminated, avgMins: x.rooms ? Math.round(x.items.reduce((s, i) => s + i.dirtyMins, 0) / x.rooms) : 0 })); });

  const maidLogs = (maidLogsRes.data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, shiftId: r.shift_id, maidName: r.maid_name, roomId: r.room_id, action: r.action, state: r.state, note: r.note, exitMs: Number(r.exit_ms || 0) }));

  return ok(res, { bizDay: bDay, serverShift: shift, activeMaids: Object.values(activeMaids), dirtyRooms, contaminatedRooms, shiftReport, serverNowMs: now, maidLogs });
}

// ==================== PERSONAL / CALENDARIO ====================
async function apiGetStaff(p, res) {
  const { data } = await supabase.from('staff').select('*').order('area').order('name');
  return ok(res, { staff: (data || []).map(r => ({ id: r.id, name: r.name, area: r.area, type: r.type, active: r.active })) });
}

async function apiSaveStaff(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const name = String(p.name || '').trim(), area = String(p.area || '').trim();
  const active = p.active !== false, id = String(p.id || '').trim();
  if (!name) return err(res, 'Nombre requerido');
  if (!area) return err(res, 'Area requerida');
  if (id) {
    await supabase.from('staff').update({ name, area, active }).eq('id', id);
  } else {
    const newId = 'S' + Date.now();
    await supabase.from('staff').insert({ id: newId, name, area, type: 'nomina', active, created_ms: Date.now() });
  }
  return ok(res, {});
}

async function apiGetSchedule(p, res) {
  const ws = String(p.weekStart || '').trim();
  let query = supabase.from('schedule').select('*');
  if (ws) query = query.eq('week_start', ws);
  const { data } = await query.order('shift_id').order('area');
  return ok(res, { schedule: (data || []).map(r => ({ weekStart: r.week_start, shiftId: r.shift_id, area: r.area, personName: r.person_name, dayOfWeek: r.day_of_week, type: r.type })) });
}

async function apiSaveSchedule(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo el administrador puede guardar el calendario');
  const ws = String(p.weekStart || '').trim();
  const entries = p.entries || [];
  if (!ws) return err(res, 'Semana requerida');

  await supabase.from('schedule').delete().eq('week_start', ws);
  if (entries.length > 0) {
    const rows = entries.map(e => ({ week_start: ws, shift_id: String(e.shiftId || ''), area: String(e.area || ''), person_name: String(e.personName || ''), day_of_week: String(e.dayOfWeek || ''), type: String(e.type || 'nomina') }));
    await supabase.from('schedule').insert(rows);
  }
  return ok(res, { saved: entries.length, weekStart: ws });
}

// ==================== CONFIG ====================
async function apiSetGoal(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const goal = Number(p.goal || 0);
  await supabase.from('settings').upsert({ key: 'DAILY_GOAL', value: String(goal) }, { onConflict: 'key' });
  return ok(res, { goal });
}

async function apiSetPin(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const targetName = String(p.targetName || '').trim();
  const pin = String(p.pin || '').trim();
  if (!targetName) return err(res, 'Nombre requerido');
  await supabase.from('reception_pins').upsert({ user_name: targetName, pin, updated_at: new Date().toISOString() }, { onConflict: 'user_name' });
  return ok(res, {});
}

async function apiGetPins(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const { data } = await supabase.from('reception_pins').select('user_name, pin');
  return ok(res, { pins: (data || []).map(r => ({ userName: r.user_name, hasPin: !!String(r.pin || '').trim() })) });
}

async function apiChangeAdminPin(p, res) {
  if (String(p.userRole || '').toUpperCase() !== 'ADMIN') return err(res, 'Solo ADMIN');
  const cur = String(p.currentPin || ''), nw = String(p.newPin || '');
  const settings = await getSettings();
  if (cur !== String(settings.ADMIN_CODE || '2206')) return err(res, 'PIN actual incorrecto');
  if (nw.length < 4 || !/^\d+$/.test(nw)) return err(res, 'PIN invalido');
  await supabase.from('settings').upsert({ key: 'ADMIN_CODE', value: nw }, { onConflict: 'key' });
  return ok(res, {});
}

async function apiRoomHistory(p, res) {
  const roomId = String(p.roomId || '').trim();
  if (!roomId) return err(res, 'roomId requerido');
  const limit = Number(p.limit || 30);
  const [stateRes, salesRes] = await Promise.all([
    supabase.from('state_history').select('*').eq('room_id', roomId).order('ts_ms', { ascending: false }).limit(limit),
    supabase.from('sales').select('*').eq('room_id', roomId).eq('type', 'SALE').order('ts_ms', { ascending: false }).limit(limit)
  ]);
  return ok(res, {
    roomId,
    stateHistory: (stateRes.data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, fromState: r.from_state, toState: r.to_state, userName: r.user_name, meta: (() => { try { return JSON.parse(r.meta_json || '{}'); } catch (e) { return {}; } })() })),
    salesHistory: (salesRes.data || []).map(r => ({ tsMs: Number(r.ts_ms), businessDay: r.business_day, durationHrs: Number(r.duration_hrs || 0), total: Number(r.total || 0), people: Number(r.people || 0), arrivalType: r.arrival_type || '', arrivalPlate: r.arrival_plate || '', userName: r.user_name, payMethod: r.pay_method || '', checkInMs: Number(r.check_in_ms || r.ts_ms), dueMs: Number(r.due_ms || 0) }))
  });
}
