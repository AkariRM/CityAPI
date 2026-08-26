const { pool } = require('../db');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('./fechas');

// Mismo calculo que resumenFinanciero.js de CityPhone, sobre las tablas de
// Áurea. Sin nominas (Áurea no tiene modulo de nomina) — la utilidad neta
// solo resta gastos.
async function calcularResumenFinancieroAurea(desde, hasta) {
  const desdeUTC = inicioDiaUTC(desde);
  const hastaUTC = finDiaUTCExclusivo(hasta);

  const ingresos = await pool.query(
    `SELECT COALESCE(sum(total), 0) AS valor, count(*)::int AS cantidad
     FROM aurea_ventas
     WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
    [desdeUTC, hastaUTC]
  );

  const costoVentas = await pool.query(
    `SELECT COALESCE(sum(vi.cantidad * p.costo), 0) AS valor
     FROM aurea_venta_items vi
     JOIN aurea_ventas v ON v.id = vi.venta_id
     JOIN aurea_productos p ON p.id = vi.producto_id
     WHERE v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz`,
    [desdeUTC, hastaUTC]
  );

  const gastos = await pool.query(
    `SELECT COALESCE(sum(monto), 0) AS valor FROM aurea_gastos WHERE tipo = 'gasto' AND fecha BETWEEN $1::date AND $2::date`,
    [desde, hasta]
  );

  const ingresosNum = Number(ingresos.rows[0].valor);
  const costoVentasNum = Number(costoVentas.rows[0].valor);
  const gastosNum = Number(gastos.rows[0].valor);
  const utilidadBruta = ingresosNum - costoVentasNum;
  const utilidadNeta = utilidadBruta - gastosNum;

  return {
    desde,
    hasta,
    ingresos: ingresosNum,
    numero_ventas: ingresos.rows[0].cantidad,
    costo_ventas: costoVentasNum,
    utilidad_bruta: utilidadBruta,
    gastos: gastosNum,
    utilidad_neta: utilidadNeta,
  };
}

module.exports = { calcularResumenFinancieroAurea };
