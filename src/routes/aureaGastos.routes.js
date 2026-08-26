const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

router.get('/', async (req, res) => {
  const { desde, hasta, tipo } = req.query;
  const { rows } = await pool.query(
    `SELECT g.id, g.usuario_id, u.nombre AS usuario_nombre, g.tipo, g.categoria, g.monto, g.descripcion, g.fecha, g.created_at
     FROM aurea_gastos g
     LEFT JOIN usuarios u ON u.id = g.usuario_id
     WHERE ($1::date IS NULL OR g.fecha >= $1::date)
       AND ($2::date IS NULL OR g.fecha <= $2::date)
       AND ($3::text IS NULL OR g.tipo = $3)
     ORDER BY g.fecha DESC, g.created_at DESC`,
    [desde || null, hasta || null, tipo || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { categoria, monto, descripcion, fecha, tipo } = req.body ?? {};
  if (!categoria?.trim()) return res.status(400).json({ error: 'La categoría es requerida.' });
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
  const tipoValido = ['gasto', 'retiro'].includes(tipo) ? tipo : 'gasto';

  const { rows } = await pool.query(
    `INSERT INTO aurea_gastos (usuario_id, tipo, categoria, monto, descripcion, fecha)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, current_date))
     RETURNING id, usuario_id, tipo, categoria, monto, descripcion, fecha, created_at`,
    [req.usuario.sub, tipoValido, categoria.trim(), Number(monto), descripcion || null, fecha || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
