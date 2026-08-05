const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isValidPin, hashPin } = require('../utils/pin');

const router = express.Router();
const ROLES_VALIDOS = ['admin', 'vendedor', 'tecnico', 'community_manager'];

router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.telefono, u.email, u.rol, u.sucursal_id,
            s.nombre AS sucursal_nombre, u.activo, u.created_at
     FROM usuarios u
     LEFT JOIN sucursales s ON s.id = u.sucursal_id
     ORDER BY u.nombre`
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email, rol, sucursal_id, pin } = req.body ?? {};

  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!sucursal_id) return res.status(400).json({ error: 'La sucursal es requerida.' });
  if (!isValidPin(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });

  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, telefono, email, rol, sucursal_id, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, nombre, telefono, email, rol, sucursal_id, activo, created_at`,
    [nombre.trim(), telefono || null, email || null, rol, sucursal_id, hashPin(pin)]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { nombre, telefono, email, rol, sucursal_id, activo } = req.body ?? {};
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });

  const fields = { nombre, telefono, email, rol, sucursal_id, activo };
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
    `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, telefono, email, rol, sucursal_id, activo, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
  res.json(rows[0]);
});

router.post('/:id/pin', async (req, res) => {
  const { pin } = req.body ?? {};
  if (!isValidPin(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });

  const { rowCount } = await pool.query(
    `UPDATE usuarios SET pin_hash = $1, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $2`,
    [hashPin(pin), req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado.' });
  res.json({ ok: true });
});

module.exports = router;
