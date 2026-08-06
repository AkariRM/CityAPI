const { pool } = require('../db');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('./fechas');

async function calcularResumenFinanciero(desde, hasta) {
  const desdeUTC = inicioDiaUTC(desde);
  const hastaUTC = finDiaUTCExclusivo(hasta);

  const ingresos = await pool.query(
    `SELECT COALESCE(sum(total), 0) AS valor, count(*)::int AS cantidad
     FROM ventas
     WHERE estado = 'completada' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
    [desdeUTC, hastaUTC]
  );

  const costoVentas = await pool.query(
    `SELECT COALESCE(sum(vi.cantidad * p.costo), 0) AS valor
     FROM venta_items vi
     JOIN ventas v ON v.id = vi.venta_id
     JOIN productos p ON p.id = vi.producto_id
     WHERE v.estado = 'completada' AND v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz`,
    [desdeUTC, hastaUTC]
  );

  const gastos = await pool.query(
    `SELECT COALESCE(sum(monto), 0) AS valor FROM gastos WHERE fecha BETWEEN $1::date AND $2::date`,
    [desde, hasta]
  );

  const nominas = await pool.query(
    `SELECT COALESCE(sum(total), 0) AS valor FROM nominas WHERE pagado = true AND periodo_fin BETWEEN $1::date AND $2::date`,
    [desde, hasta]
  );

  const ingresosNum = Number(ingresos.rows[0].valor);
  const costoVentasNum = Number(costoVentas.rows[0].valor);
  const gastosNum = Number(gastos.rows[0].valor);
  const nominasNum = Number(nominas.rows[0].valor);
  const utilidadBruta = ingresosNum - costoVentasNum;
  const utilidadNeta = utilidadBruta - gastosNum - nominasNum;

  return {
    desde,
    hasta,
    ingresos: ingresosNum,
    numero_ventas: ingresos.rows[0].cantidad,
    costo_ventas: costoVentasNum,
    utilidad_bruta: utilidadBruta,
    gastos: gastosNum,
    nominas_pagadas: nominasNum,
    utilidad_neta: utilidadNeta,
  };
}

module.exports = { calcularResumenFinanciero };
