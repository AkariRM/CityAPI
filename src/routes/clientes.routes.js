const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { q } = req.query;
  const { rows } = await pool.query(
    `SELECT id, nombre, telefono, email, direccion, notas, created_at
     FROM clientes
     WHERE ($1::text IS NULL OR nombre ILIKE '%' || $1 || '%' OR telefono ILIKE '%' || $1 || '%')
     ORDER BY nombre
     LIMIT 300`,
    [q || null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT id, nombre, telefono, email, direccion, notas, created_at FROM clientes WHERE id = $1`, [req.params.id]);
  const cliente = rows[0];
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const historial = await pool.query(
    `SELECT count(*)::int AS numero_ventas, COALESCE(sum(total), 0) AS total_comprado, max(created_at) AS ultima_compra
     FROM ventas WHERE cliente_id = $1 AND estado = 'completada'`,
    [req.params.id]
  );

  res.json({ ...cliente, ...historial.rows[0] });
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email, direccion, notas } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO clientes (nombre, telefono, email, direccion, notas) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nombre, telefono, email, direccion, notas, created_at`,
    [nombre.trim(), telefono || null, email || null, direccion || null, notas || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const fields = { nombre: req.body?.nombre, telefono: req.body?.telefono, email: req.body?.email, direccion: req.body?.direccion, notas: req.body?.notas };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No hay campos para actualizar.' });

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE clientes SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, telefono, email, direccion, notas, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
