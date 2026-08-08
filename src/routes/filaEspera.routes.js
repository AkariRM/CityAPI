const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo, hoyLocal } = require('../utils/fechas');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { sucursal_id } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const hoy = hoyLocal();
  const desdeUTC = inicioDiaUTC(hoy);
  const hastaUTC = finDiaUTCExclusivo(hoy);

  const activos = await pool.query(
    `SELECT id, nombre, motivo, atendido, created_at
     FROM fila_espera
     WHERE sucursal_id = $1 AND atendido = false
     ORDER BY created_at ASC`,
    [sucursal_id]
  );

  const atendidosHoy = await pool.query(
    `SELECT count(*)::int AS cantidad
     FROM fila_espera
     WHERE sucursal_id = $1 AND atendido = true
       AND atendido_at >= $2::timestamptz AND atendido_at < $3::timestamptz`,
    [sucursal_id, desdeUTC, hastaUTC]
  );

  res.json({ activos: activos.rows, atendidos_hoy: atendidosHoy.rows[0].cantidad });
});

router.post('/', async (req, res) => {
  const { sucursal_id, nombre, motivo } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO fila_espera (sucursal_id, nombre, motivo)
     VALUES ($1, $2, $3)
     RETURNING id, nombre, motivo, atendido, created_at`,
    [sucursal_id, nombre.trim(), motivo || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/atender', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE fila_espera SET atendido = true, atendido_por = $2, atendido_at = now()
     WHERE id = $1 AND atendido = false
     RETURNING id, nombre, motivo, atendido, atendido_at`,
    [req.params.id, req.usuario.sub]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Este cliente ya fue atendido.' });
  res.json(rows[0]);
});

module.exports = router;
