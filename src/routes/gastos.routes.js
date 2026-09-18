const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');

const router = express.Router();

// Un vendedor puede registrar salidas de caja de su propio turno (gasto o
// retiro), no solo el admin.
router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { desde, hasta, tipo, sucursal_id } = req.query;
  // Admin y dueño pueden omitir sucursal_id (ven todas); los demas roles lo
  // siguen necesitando, mismo criterio que productos/reparaciones.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT g.id, g.sucursal_id, g.usuario_id, u.nombre AS usuario_nombre, g.tipo, g.categoria, g.monto, g.descripcion, g.fecha, g.created_at
     FROM gastos g
     LEFT JOIN usuarios u ON u.id = g.usuario_id
     WHERE ($1::date IS NULL OR g.fecha >= $1::date)
       AND ($2::date IS NULL OR g.fecha <= $2::date)
       AND ($3::uuid IS NULL OR g.sucursal_id = $3::uuid)
       AND ($4::text IS NULL OR g.tipo = $4)
     ORDER BY g.fecha DESC, g.created_at DESC`,
    [desde || null, hasta || null, sucursal_id || null, tipo || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { sucursal_id, categoria, monto, descripcion, fecha, tipo } = req.body ?? {};
  // sucursal_id es opcional aqui a propósito: un gasto general del negocio
  // (renta, luz) no tiene por qué atarse a una sucursal — solo la pantalla de
  // Corte de caja (retiros/salidas ligadas a un turno especifico) lo manda.
  if (!categoria?.trim()) return res.status(400).json({ error: 'La categoría es requerida.' });
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
  const tipoValido = ['gasto', 'retiro'].includes(tipo) ? tipo : 'gasto';

  const { rows } = await pool.query(
    `INSERT INTO gastos (sucursal_id, usuario_id, tipo, categoria, monto, descripcion, fecha)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date))
     RETURNING id, sucursal_id, usuario_id, tipo, categoria, monto, descripcion, fecha, created_at`,
    [sucursal_id, req.usuario.sub, tipoValido, categoria.trim(), Number(monto), descripcion || null, fecha || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
