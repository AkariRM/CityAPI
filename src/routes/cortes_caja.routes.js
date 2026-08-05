const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

async function calcularResumen(sucursal_id, usuario_id) {
  const ultimoCorte = await pool.query(
    `SELECT turno_fin FROM cortes_caja WHERE sucursal_id = $1 AND usuario_id = $2 ORDER BY turno_fin DESC LIMIT 1`,
    [sucursal_id, usuario_id]
  );
  const desde = ultimoCorte.rows[0]?.turno_fin ?? null;

  const { rows } = await pool.query(
    `SELECT metodo_pago, count(*)::int AS cantidad, COALESCE(sum(total), 0) AS total
     FROM ventas
     WHERE sucursal_id = $1 AND vendedor_id = $2 AND estado = 'completada'
       AND created_at > COALESCE($3::timestamptz, date_trunc('day', now()))
     GROUP BY metodo_pago`,
    [sucursal_id, usuario_id, desde]
  );

  const totales = { efectivo: 0, tarjeta: 0 };
  let cantidadVentas = 0;
  for (const row of rows) {
    totales[row.metodo_pago] = Number(row.total);
    cantidadVentas += row.cantidad;
  }

  return {
    turno_inicio: desde ?? null,
    total_efectivo: totales.efectivo,
    total_tarjeta: totales.tarjeta,
    total_sistema: totales.efectivo + totales.tarjeta,
    cantidad_ventas: cantidadVentas,
  };
}

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
     VALUES ($1, $2, COALESCE($3::timestamptz, date_trunc('day', now())), now(), $4, $5, $6, 0, $7, $8)
     RETURNING id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_credito, total_sistema, diferencia`,
    [sucursal_id, req.usuario.sub, resumen.turno_inicio, fondo, resumen.total_efectivo, resumen.total_tarjeta, resumen.total_sistema, diferencia]
  );

  res.status(201).json(rows[0]);
});

module.exports = router;
