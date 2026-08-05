const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { q } = req.query;
  const { rows } = await pool.query(
    `SELECT id, nombre, telefono, email
     FROM clientes
     WHERE ($1::text IS NULL OR nombre ILIKE '%' || $1 || '%' OR telefono ILIKE '%' || $1 || '%')
     ORDER BY nombre
     LIMIT 20`,
    [q || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO clientes (nombre, telefono, email) VALUES ($1, $2, $3)
     RETURNING id, nombre, telefono, email`,
    [nombre.trim(), telefono || null, email || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
