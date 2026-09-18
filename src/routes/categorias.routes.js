const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`SELECT id, nombre FROM categorias ORDER BY nombre`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO categorias (nombre) VALUES ($1) RETURNING id, nombre`,
      [nombre.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

module.exports = router;
