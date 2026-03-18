# Casa 50 — Registro de Desarrollo

## Estado al 18 Marzo 2026

### URLs
- Producción: https://casa50.vercel.app
- GitHub: https://github.com/Rubenvanega22/casa50
- Supabase: fojffyncxrrxevavshod.supabase.co

### Archivos clave
- `public/index.html` — frontend completo
- `api/index.js` — backend serverless

### Cambios completados
1. Cuadre Recepción con Bar Efectivo/Tarjeta obligatorio
2. Gastos con descripción
3. Cuadre Admin con P.Adicional y H.Adicional
4. Timezone backend America/Bogota
5. Notas v3 — badge, destinatario, marcar vista, borrar, historial
6. Tarjeta amarilla — hora entrada y hora real de salida
7. Camarera — flujo 3 secciones (pendiente/en proceso/registro)
8. Checkout recepción — un solo paso con force:true
9. Calendario — hasta 4 personas por turno
10. Admin — borrar registro camareras

### Pendiente
- Fix doMaidFinish: quitar loadMaidLog()
- Fix saveMaidLog: código roto
- Agregar funciones loadCfg, openGoal, saveGoal
