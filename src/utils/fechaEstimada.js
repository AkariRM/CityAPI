// Fecha estimada de entrega de una reparacion y si el cliente ya la confirmo.
//
// Al autorizar la cotizacion (desde la sucursal o por WhatsApp) el servidor guarda una copia de la fecha en
// fecha_estimada_confirmada: lo que el cliente acepto. Todo lo demas se calcula comparando las dos columnas, asi no hay nada que
// recordar actualizar: si despues se cambia la fecha, deja de coincidir y pasa sola a 'cambiada'.
//
//   sin_fecha   todavia no hay fecha
//   estimada    hay fecha pero el cliente no la ha confirmado (aun cotizando, o reparacion sin costo)
//   confirmada  el cliente autorizo con esta fecha
//   cambiada    el cliente autorizo con otra fecha: hay que avisarle
//
// Se compara por DIA en UTC: la fecha se guarda como el dia elegido a medianoche UTC (asi la escribe y la lee la app).

// Expresion SQL del estado para la tabla de reparaciones con ese alias (ej. 'r').
function sqlFechaEstado(alias = 'r') {
  const entrega = `${alias}.fecha_estimada_entrega`;
  const confirmada = `${alias}.fecha_estimada_confirmada`;
  return `CASE
    WHEN ${entrega} IS NULL THEN 'sin_fecha'
    WHEN ${confirmada} IS NULL THEN 'estimada'
    WHEN (${confirmada} AT TIME ZONE 'UTC')::date = (${entrega} AT TIME ZONE 'UTC')::date THEN 'confirmada'
    ELSE 'cambiada'
  END`;
}

// "15 de octubre de 2026" (o null), tal como se le dice al cliente. Se formatea en UTC para que el dia no se corra.
function fechaLarga(fecha) {
  if (!fecha) return null;
  return new Date(fecha).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

module.exports = { sqlFechaEstado, fechaLarga };
