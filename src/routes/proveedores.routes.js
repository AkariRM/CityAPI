const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { esRfc } = require('../utils/facturaPropuesta');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { activo } = req.query;
  const { rows } = await pool.query(
    `SELECT id, nombre, contacto, telefono, email, notas, rfc, activo, created_at
     FROM proveedores
     WHERE ($1::boolean IS NULL OR activo = $1::boolean)
     ORDER BY nombre`,
    [activo === undefined ? null : activo === 'true']
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, contacto, telefono, email, notas, rfc } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  const rfcLimpio = typeof rfc === 'string' && rfc.trim() ? rfc.trim().toUpperCase() : null;
  if (rfcLimpio && !esRfc(rfcLimpio)) return res.status(400).json({ error: 'El RFC no es válido (12 o 13 caracteres, ej. XAXX010101000).' });

  const { rows } = await pool.query(
    `INSERT INTO proveedores (nombre, contacto, telefono, email, notas, rfc)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, nombre, contacto, telefono, email, notas, rfc, activo, created_at`,
    [nombre.trim(), contacto || null, telefono || null, email || null, notas || null, rfcLimpio]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    contacto: req.body?.contacto,
    telefono: req.body?.telefono,
    email: req.body?.email,
    notas: req.body?.notas,
    rfc: typeof req.body?.rfc === 'string' ? (req.body.rfc.trim() ? req.body.rfc.trim().toUpperCase() : null) : req.body?.rfc,
    activo: req.body?.activo,
  };
  if (fields.rfc && !esRfc(fields.rfc)) return res.status(400).json({ error: 'El RFC no es válido (12 o 13 caracteres, ej. XAXX010101000).' });
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE proveedores SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, contacto, telefono, email, notas, rfc, activo, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
