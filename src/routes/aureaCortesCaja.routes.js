const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');
const { obtenerConfiguracionTicketAurea } = require('../utils/configuracionTicketAurea');

const router = express.Router();
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

// El "turno" de un usuario es desde su ultimo corte (o desde medianoche si
// nunca ha cerrado uno) hasta ahora — igual que cortes_caja.routes.js de
// CityPhone, pero sin dimension de sucursal (Áurea es una sola ubicacion) y
// sin creditos (Áurea no los tiene, solo ventas + abonos de apartados).
async function calcularResumen(usuario_id) {
  const ultimoCorte = await pool.query(
    `SELECT turno_fin FROM aurea_cortes_caja WHERE usuario_id = $1 ORDER BY turno_fin DESC LIMIT 1`,
    [usuario_id]
  );
  const desde = ultimoCorte.rows[0]?.turno_fin ?? null;

  const ventasPorMetodo = await pool.query(
    `SELECT metodo_pago, count(*)::int AS cantidad, COALESCE(sum(total), 0) AS total
     FROM aurea_ventas
     WHERE usuario_id = $1 AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo_pago`,
    [usuario_id, desde]
  );

  const abonosApartadoPorMetodo = await pool.query(
    `SELECT metodo, count(*)::int AS cantidad, COALESCE(sum(monto), 0) AS total
     FROM aurea_apartado_abonos
     WHERE usuario_id = $1 AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo`,
    [usuario_id, desde]
  );

  const salidas = await pool.query(
    `SELECT id, tipo, categoria, monto, descripcion, created_at
     FROM aurea_gastos
     WHERE usuario_id = $1 AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     ORDER BY created_at`,
    [usuario_id, desde]
  );
  const totalSalidas = salidas.rows.reduce((sum, s) => sum + Number(s.monto), 0);

  const totales = { efectivo: 0, tarjeta: 0 };
  let cantidadVentas = 0;
  for (const row of ventasPorMetodo.rows) {
    totales[row.metodo_pago] = (totales[row.metodo_pago] ?? 0) + Number(row.total);
    cantidadVentas += row.cantidad;
  }
  let cantidadAbonos = 0;
  for (const row of abonosApartadoPorMetodo.rows) {
    totales[row.metodo] = (totales[row.metodo] ?? 0) + Number(row.total);
    cantidadAbonos += row.cantidad;
  }

  return {
    turno_inicio: desde ?? null,
    total_efectivo: totales.efectivo,
    total_tarjeta: totales.tarjeta,
    total_sistema: totales.efectivo + totales.tarjeta,
    total_salidas: totalSalidas,
    salidas: salidas.rows,
    cantidad_ventas: cantidadVentas,
    cantidad_abonos: cantidadAbonos,
  };
}

router.get('/', async (req, res) => {
  const { usuario_id, desde, hasta } = req.query;
  const usuarioFiltro = req.usuario.rol === 'pto' ? req.usuario.sub : usuario_id || null;

  const { rows } = await pool.query(
    `SELECT cc.id, cc.usuario_id, u.nombre AS usuario_nombre,
            cc.turno_inicio, cc.turno_fin, cc.fondo_inicial, cc.total_efectivo, cc.total_tarjeta,
            cc.total_sistema, cc.diferencia, cc.created_at
     FROM aurea_cortes_caja cc
     LEFT JOIN usuarios u ON u.id = cc.usuario_id
     WHERE ($1::uuid IS NULL OR cc.usuario_id = $1::uuid)
       AND ($2::timestamptz IS NULL OR cc.turno_fin >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR cc.turno_fin < $3::timestamptz)
     ORDER BY cc.turno_fin DESC
     LIMIT 200`,
    [usuarioFiltro, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/resumen', async (req, res) => {
  const resumen = await calcularResumen(req.usuario.sub);
  const config = await obtenerConfiguracionTicketAurea();
  res.json({ ...resumen, fondo_caja_default: config.fondo_caja_default });
});

router.post('/', async (req, res) => {
  const { fondo_inicial, efectivo_contado } = req.body ?? {};
  if (!(efectivo_contado >= 0)) return res.status(400).json({ error: 'efectivo_contado es requerido.' });

  const resumen = await calcularResumen(req.usuario.sub);
  const fondo = fondo_inicial ?? 0;
  const diferencia = efectivo_contado - (fondo + resumen.total_efectivo - resumen.total_salidas);

  const { rows } = await pool.query(
    `INSERT INTO aurea_cortes_caja (usuario_id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_sistema, diferencia)
     VALUES ($1, COALESCE($2::timestamptz, date_trunc('day', now())), now(), $3, $4, $5, $6, $7)
     RETURNING id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_sistema, diferencia`,
    [req.usuario.sub, resumen.turno_inicio, fondo, resumen.total_efectivo, resumen.total_tarjeta, resumen.total_sistema, diferencia]
  );

  res.status(201).json(rows[0]);
});

module.exports = router;
