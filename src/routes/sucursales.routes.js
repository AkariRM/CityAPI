const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, direccion, telefono, activo FROM sucursales WHERE activo = true ORDER BY nombre`
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, direccion, telefono } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO sucursales (nombre, direccion, telefono) VALUES ($1, $2, $3)
     RETURNING id, nombre, direccion, telefono, activo`,
    [nombre.trim(), direccion || null, telefono || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
