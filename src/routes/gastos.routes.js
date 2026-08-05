const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  const { desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT id, sucursal_id, categoria, monto, descripcion, fecha, created_at
     FROM gastos
     WHERE ($1::date IS NULL OR fecha >= $1::date)
       AND ($2::date IS NULL OR fecha <= $2::date)
     ORDER BY fecha DESC, created_at DESC`,
    [desde || null, hasta || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { sucursal_id, categoria, monto, descripcion, fecha } = req.body ?? {};
  if (!categoria?.trim()) return res.status(400).json({ error: 'La categoría es requerida.' });
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

  const { rows } = await pool.query(
    `INSERT INTO gastos (sucursal_id, categoria, monto, descripcion, fecha)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, current_date))
     RETURNING id, sucursal_id, categoria, monto, descripcion, fecha, created_at`,
    [sucursal_id || null, categoria.trim(), Number(monto), descripcion || null, fecha || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
