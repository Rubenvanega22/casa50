const shifts=['SHIFT_1','SHIFT_2','SHIFT_3'];
  const rows=products.map(function(prod){
    const totalVentas=(sales||[]).filter(s=>s.product_id===prod.id&&!s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const totalCortesias=(sales||[]).filter(s=>s.product_id===prod.id&&s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
    const totalEntradas=(entries||[]).filter(e=>e.product_id===prod.id).reduce((a,e)=>a+Number(e.cantidad||0),0);
    const saldoInicial=Number(prod.stock_actual||0)+totalVentas+totalCortesias-totalEntradas;
    const turnosData={};
    shifts.forEach(function(sid){
      const ent=(entries||[]).filter(e=>e.product_id===prod.id&&e.shift_id===sid).reduce((a,e)=>a+Number(e.cantidad||0),0);
      const ven=(sales||[]).filter(s=>s.product_id===prod.id&&s.shift_id===sid&&!s.is_cortesia);
      const cor=(sales||[]).filter(s=>s.product_id===prod.id&&s.shift_id===sid&&s.is_cortesia).reduce((a,s)=>a+Number(s.cantidad||0),0);
      turnosData[sid]={entradas:ent,ventas:ven.reduce((a,s)=>a+Number(s.cantidad||0),0),cortesias:cor,valorVendido:ven.reduce((a,s)=>a+Number(s.total||0),0),ef:ven.filter(s=>s.pay_method==='EFECTIVO').reduce((a,s)=>a+Number(s.total||0),0),ta:ven.filter(s=>s.pay_method==='TARJETA').reduce((a,s)=>a+Number(s.total||0),0),nq:ven.filter(s=>s.pay_method==='NEQUI').reduce((a,s)=>a+Number(s.total||0),0)};
    });
    const movsProd=(movements||[]).filter(m=>m.product_id===prod.id);
const ingBodegaTotal=movsProd.filter(m=>m.tipo==='ingreso_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
const trasladoTotal=movsProd.filter(m=>m.tipo==='traslado_recepcion').reduce((a,m)=>a+Number(m.cantidad||0),0);
shifts.forEach(function(sid){
  const movsSid=movsProd.filter(m=>m.shift_id===sid);
  turnosData[sid].ingresoBodega=movsSid.filter(m=>m.tipo==='ingreso_bodega').reduce((a,m)=>a+Number(m.cantidad||0),0);
  turnosData[sid].trasladoRecepcion=movsSid.filter(m=>m.tipo==='traslado_recepcion').reduce((a,m)=>a+Number(m.cantidad||0),0);
});
return{id:prod.id,nombre:prod.nombre,categoria:prod.categoria||'',codigoBarras:prod.codigo_barras||'',precio:Number(prod.precio||0),stockMinimo:Number(prod.stock_minimo||5),saldoInicial,saldoActual:Number(prod.stock_actual||0),stockBodega:Number(prod.stock_bodega||0),turnos:turnosData};
  });
  const resumenTurnos={};
  shifts.forEach(function(sid){
    const venTurno=(sales||[]).filter(s=>s.shift_id===sid&&!s.is_cortesia);
    resumenTurnos[sid]={totalVendido:venTurno.reduce((a,s)=>a+Number(s.total||0),0),totalEf:venTurno.filter(s=>s.pay_method==='EFECTIVO').reduce((a,s)=>a+Number(s.total||0),0),totalTa:venTurno.filter(s=>s.pay_method==='TARJETA').reduce((a,s)=>a+Number(s.total||0),0),totalNq:venTurno.filter(s=>s.pay_method==='NEQUI').reduce((a,s)=>a+Number(s.total||0),0),totalCortesias:(sales||[]).filter(s=>s.shift_id===sid&&s.is_cortesia).reduce((a,s)=>a+Number(s.total||0),0),observacion:((obs||[]).find(o=>o.shift_id===sid)||{}).observacion||''};
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

async function apiSaveRoomBarcode(p, res) {
  if(String(p.userRole||'').toUpperCase()!=='ADMIN') return err(res,'Solo ADMIN');
  const roomId = String(p.roomId||'').trim();
  const barcode = String(p.barcode||'').trim();
  if(!roomId) return err(res,'roomId requerido');
  if(!barcode) return err(res,'barcode requerido');
  await supabase.from('rooms').update({ barcode }).eq('room_id', roomId);
  return ok(res, { roomId, barcode });
}
