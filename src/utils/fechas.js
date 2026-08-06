// Ayudante para filtrar columnas timestamptz por un rango de fechas (YYYY-MM-DD)
// de forma segura sin importar la zona horaria de la sesion de Postgres.
//
// Comparar "created_at >= $1::date" directamente depende de como la sesion
// de Postgres interprete la medianoche de esa fecha (usa su TimeZone), lo
// que puede correr los resultados un dia entero si la sesion no esta en UTC.
// Aqui calculamos los limites del rango en JavaScript como timestamps UTC
// explicitos, y el SQL solo compara timestamptz contra timestamptz.

function inicioDiaUTC(fecha) {
  return `${fecha}T00:00:00.000Z`;
}

function finDiaUTCExclusivo(fecha) {
  return new Date(new Date(`${fecha}T00:00:00.000Z`).getTime() + 86400000).toISOString();
}

module.exports = { inicioDiaUTC, finDiaUTCExclusivo };
