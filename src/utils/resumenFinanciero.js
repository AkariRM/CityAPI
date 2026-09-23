const { pool } = require('../db');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('./fechas');

// sucursalId (opcional): limita el resumen a una sucursal; sin el, suma todas.
// - ventas / reparaciones / gastos se filtran por su propia sucursal.
// - nominas no tienen sucursal propia: se atribuyen a la sucursal "de casa"
//   del empleado (usuarios.sucursal_id).
// - los gastos generales del negocio (renta, luz) se registran SIN sucursal,
//   asi que solo aparecen en el resumen combinado, no en el de una sucursal.
async function calcularResumenFinanciero(desde, hasta, sucursalId = null) {
  const desdeUTC = inicioDiaUTC(desde);
  const hastaUTC = finDiaUTCExclusivo(hasta);
  const sucursal = sucursalId || null;

  const ingresos = await pool.query(
    `SELECT COALESCE(sum(total), 0) AS valor, count(*)::int AS cantidad
     FROM ventas
     WHERE estado = 'completada' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
       AND ($3::uuid IS NULL OR sucursal_id = $3::uuid)`,
    [desdeUTC, hastaUTC, sucursal]
  );

  // Lo COBRADO por reparaciones en el periodo (mano de obra + piezas que se
  // le cargan al cliente), por fecha de cobro -- mismo criterio de "cuando
  // entra el dinero" que ya usan los gastos. El costo de las piezas ya viene
  // por el lado de Gastos (se registra al comprarlas).
  const ingresosReparaciones = await pool.query(
    `SELECT COALESCE(sum(ab.monto), 0) AS valor, count(*)::int AS cantidad
     FROM reparacion_abonos ab
     JOIN reparaciones r ON r.id = ab.reparacion_id
     WHERE ab.created_at >= $1::timestamptz AND ab.created_at < $2::timestamptz
       AND ($3::uuid IS NULL OR r.sucursal_id = $3::uuid)`,
    [desdeUTC, hastaUTC, sucursal]
  );

  const costoVentas = await pool.query(
    `SELECT COALESCE(sum(vi.cantidad * p.costo), 0) AS valor
     FROM venta_items vi
     JOIN ventas v ON v.id = vi.venta_id
     JOIN productos p ON p.id = vi.producto_id
     WHERE v.estado = 'completada' AND v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz
       AND ($3::uuid IS NULL OR v.sucursal_id = $3::uuid)`,
    [desdeUTC, hastaUTC, sucursal]
  );

  // Solo 'gasto' es un costo real del negocio. 'retiro' (resguardo de
  // efectivo, ej. mover a la caja fuerte el dinero de una venta grande) no
  // cuenta aqui — ya se resto del efectivo esperado en el corte de caja, pero
  // no le costo nada al negocio, seria doble conteo incluirlo tambien como gasto.
  const gastos = await pool.query(
    `SELECT COALESCE(sum(monto), 0) AS valor FROM gastos
     WHERE tipo = 'gasto' AND fecha BETWEEN $1::date AND $2::date
       AND ($3::uuid IS NULL OR sucursal_id = $3::uuid)`,
    [desde, hasta, sucursal]
  );

  const nominas = await pool.query(
    `SELECT COALESCE(sum(n.total), 0) AS valor
     FROM nominas n
     JOIN usuarios u ON u.id = n.usuario_id
     WHERE n.pagado = true AND n.periodo_fin BETWEEN $1::date AND $2::date
       AND ($3::uuid IS NULL OR u.sucursal_id = $3::uuid)`,
    [desde, hasta, sucursal]
  );

  const ingresosNum = Number(ingresos.rows[0].valor);
  const ingresosReparacionesNum = Number(ingresosReparaciones.rows[0].valor);
  const costoVentasNum = Number(costoVentas.rows[0].valor);
  const gastosNum = Number(gastos.rows[0].valor);
  const nominasNum = Number(nominas.rows[0].valor);
  const utilidadBruta = ingresosNum + ingresosReparacionesNum - costoVentasNum;
  const utilidadNeta = utilidadBruta - gastosNum - nominasNum;

  return {
    desde,
    hasta,
    sucursal_id: sucursal,
    ingresos: ingresosNum,
    numero_ventas: ingresos.rows[0].cantidad,
    ingresos_reparaciones: ingresosReparacionesNum,
    numero_cobros_reparaciones: ingresosReparaciones.rows[0].cantidad,
    costo_ventas: costoVentasNum,
    utilidad_bruta: utilidadBruta,
    gastos: gastosNum,
    nominas_pagadas: nominasNum,
    utilidad_neta: utilidadNeta,
  };
}

module.exports = { calcularResumenFinanciero };
