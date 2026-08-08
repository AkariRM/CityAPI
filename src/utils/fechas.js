// Ayudante para filtrar columnas timestamptz por un rango de fechas (YYYY-MM-DD)
// de forma segura sin importar la zona horaria de la sesion de Postgres NI la
// del proceso de Node (Render corre en UTC).
//
// Las fechas "YYYY-MM-DD" que manda la app son el dia calendario LOCAL de la
// sucursal (Sahuayo, Michoacan — UTC-6 fijo, Mexico ya no usa horario de
// verano desde el decreto de 2022), no un dia UTC. Si se tratara la fecha
// como UTC, una venta hecha en la noche local ya cae en el dia UTC siguiente
// y desaparece de "hoy"/"este mes" en los reportes. Por eso el offset -06:00
// esta fijo aqui en vez de usar la TimeZone del proceso o de la sesion SQL.
const OFFSET_SUCURSAL = '-06:00';

function inicioDiaUTC(fecha) {
  return new Date(`${fecha}T00:00:00.000${OFFSET_SUCURSAL}`).toISOString();
}

function finDiaUTCExclusivo(fecha) {
  return new Date(new Date(`${fecha}T00:00:00.000${OFFSET_SUCURSAL}`).getTime() + 86400000).toISOString();
}

// "Hoy" tal como lo ve la sucursal (UTC-6), no el dia UTC del proceso de
// Node — usar esto en vez de `new Date().toISOString().slice(0, 10)` en
// cualquier lugar del backend que necesite la fecha calendario de "hoy".
const OFFSET_SUCURSAL_MS = new Date(`1970-01-01T00:00:00.000${OFFSET_SUCURSAL}`).getTime();
function hoyLocal() {
  return new Date(Date.now() - OFFSET_SUCURSAL_MS).toISOString().slice(0, 10);
}

module.exports = { inicioDiaUTC, finDiaUTCExclusivo, hoyLocal };
