const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

async function calcularResumen(sucursal_id, usuario_id) {
  const ultimoCorte = await pool.query(
    `SELECT turno_fin FROM cortes_caja WHERE sucursal_id = $1 AND usuario_id = $2 ORDER BY turno_fin DESC LIMIT 1`,
    [sucursal_id, usuario_id]
  );
  const desde = ultimoCorte.rows[0]?.turno_fin ?? null;

  const ventasPorMetodo = await pool.query(
    `SELECT metodo_pago, count(*)::int AS cantidad, COALESCE(sum(total), 0) AS total
     FROM ventas
     WHERE sucursal_id = $1 AND vendedor_id = $2 AND estado = 'completada'
       AND created_at > COALESCE($3::timestamptz, date_trunc('day', now()))
     GROUP BY metodo_pago`,
    [sucursal_id, usuario_id, desde]
  );

  // Un abono de credito es dinero real que entra a la caja de quien lo
  // cobra (aunque la venta original haya sido de otro turno u otro
  // vendedor), asi que cuenta igual que una venta en efectivo/tarjeta.
  const abonosPorMetodo = await pool.query(
    `SELECT metodo, count(*)::int AS cantidad, COALESCE(sum(monto), 0) AS total
     FROM abonos
     WHERE usuario_id = $1
       AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo`,
    [usuario_id, desde]
  );

  const totales = { efectivo: 0, tarjeta: 0, credito: 0 };
  let cantidadVentas = 0;
  for (const row of ventasPorMetodo.rows) {
    totales[row.metodo_pago] += Number(row.total);
    cantidadVentas += row.cantidad;
  }
  let cantidadAbonos = 0;
  for (const row of abonosPorMetodo.rows) {
    totales[row.metodo] += Number(row.total);
    cantidadAbonos += row.cantidad;
  }

  return {
    turno_inicio: desde ?? null,
    total_efectivo: totales.efectivo,
    total_tarjeta: totales.tarjeta,
    total_credito: totales.credito,
    total_sistema: totales.efectivo + totales.tarjeta,
    cantidad_ventas: cantidadVentas,
    cantidad_abonos: cantidadAbonos,
  };
}

// Listado/historial de cortes (turnos) para la pantalla de Historial de
// ventas. Igual que en /ventas, un vendedor solo ve sus propios cortes; el
// admin puede ver los de cualquiera o los de todos.
router.get('/', async (req, res) => {
  const { sucursal_id, usuario_id, desde, hasta } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const usuarioFiltro = req.usuario.rol === 'vendedor' ? req.usuario.sub : usuario_id || null;

  const { rows } = await pool.query(
    `SELECT cc.id, cc.sucursal_id, cc.usuario_id, u.nombre AS usuario_nombre,
            cc.turno_inicio, cc.turno_fin, cc.fondo_inicial, cc.total_efectivo, cc.total_tarjeta,
            cc.total_credito, cc.total_sistema, cc.diferencia, cc.created_at
     FROM cortes_caja cc
     LEFT JOIN usuarios u ON u.id = cc.usuario_id
     WHERE cc.sucursal_id = $1
       AND ($2::uuid IS NULL OR cc.usuario_id = $2::uuid)
       AND ($3::timestamptz IS NULL OR cc.turno_fin >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR cc.turno_fin < $4::timestamptz)
     ORDER BY cc.turno_fin DESC
     LIMIT 200`,
    [sucursal_id, usuarioFiltro, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/resumen', async (req, res) => {
  const { sucursal_id } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  res.json(await calcularResumen(sucursal_id, req.usuario.sub));
});

router.post('/', async (req, res) => {
  const { sucursal_id, fondo_inicial, efectivo_contado } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!(efectivo_contado >= 0)) return res.status(400).json({ error: 'efectivo_contado es requerido.' });

  const resumen = await calcularResumen(sucursal_id, req.usuario.sub);
  const fondo = fondo_inicial ?? 0;
  const diferencia = efectivo_contado - (fondo + resumen.total_efectivo);

  const { rows } = await pool.query(
    `INSERT INTO cortes_caja (sucursal_id, usuario_id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_credito, total_sistema, diferencia)
     VALUES ($1, $2, COALESCE($3::timestamptz, date_trunc('day', now())), now(), $4, $5, $6, $7, $8, $9)
     RETURNING id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_credito, total_sistema, diferencia`,
    [sucursal_id, req.usuario.sub, resumen.turno_inicio, fondo, resumen.total_efectivo, resumen.total_tarjeta, resumen.total_credito, resumen.total_sistema, diferencia]
  );

  res.status(201).json(rows[0]);
});

module.exports = router;
