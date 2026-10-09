const { obtenerConfiguracionTicket } = require('./configuracionTicket');

const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Lo que se le cobra al cliente por una pieza que le cuesta `costo` al negocio. Con la ganancia sobre piezas apagada
// (el valor por defecto) es el mismo costo, como siempre. Encendida en Configuracion, es el costo mas el porcentaje.
// El costo real siempre se guarda aparte (reparacion_refacciones.costo) para la revision de costos.
async function precioDePieza(queryable, costo) {
  const config = await obtenerConfiguracionTicket(queryable);
  if (!config.reparacion_margen_piezas_activo) return redondear(costo);
  return redondear(Number(costo) * (1 + Number(config.reparacion_margen_piezas_pct) / 100));
}

module.exports = { precioDePieza, redondear };
