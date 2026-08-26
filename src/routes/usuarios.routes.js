const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isValidPin, hashPin } = require('../utils/pin');

const router = express.Router();
const ROLES_VALIDOS = ['dueño', 'admin', 'vendedor', 'tecnico', 'community_manager', 'pto'];
// Solo estos roles pertenecen a CityPhone y necesitan sucursal — 'dueño' no
// se ata a ninguna empresa/sucursal, 'pto' es de Áurea (sin sucursales fase 1).
const ROLES_CITYPHONE_CON_SUCURSAL = ['admin', 'vendedor', 'tecnico', 'community_manager'];

router.use(requireAuth, requireRole('dueño', 'admin'));

router.get('/', async (req, res) => {
  // El Dueño ve ambas empresas (las administra); cualquier otro rol (admin/
  // Supervisor) solo ve las cuentas de su propia empresa — antes esto no se
  // filtraba y un Supervisor de CityPhone veia tambien las cuentas de Áurea.
  const filtroEmpresa = req.usuario.rol === 'dueño' ? null : req.usuario.empresa_id;
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.telefono, u.email, u.rol, u.sucursal_id, u.empresa_id,
            s.nombre AS sucursal_nombre, e.nombre AS empresa_nombre, u.activo, u.created_at
     FROM usuarios u
     LEFT JOIN sucursales s ON s.id = u.sucursal_id
     LEFT JOIN empresas e ON e.id = u.empresa_id
     WHERE ($1::uuid IS NULL OR u.empresa_id = $1::uuid)
     ORDER BY u.nombre`,
    [filtroEmpresa]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email, rol, sucursal_id, empresa_id, pin } = req.body ?? {};

  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!isValidPin(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });

  // Asignar acceso de Dueño o Admin (osea, a una empresa completa) es
  // decisión exclusiva del Dueño — un Admin normal no puede crear otro
  // Admin ni ascender a Dueño.
  if ((rol === 'dueño' || rol === 'admin') && req.usuario.rol !== 'dueño') {
    return res.status(403).json({ error: 'Solo el Dueño puede crear cuentas de Dueño o Admin.' });
  }

  if (rol !== 'dueño' && !empresa_id) {
    return res.status(400).json({ error: 'La empresa es requerida.' });
  }
  if (ROLES_CITYPHONE_CON_SUCURSAL.includes(rol) && !sucursal_id) {
    return res.status(400).json({ error: 'La sucursal es requerida.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, telefono, email, rol, sucursal_id, empresa_id, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, nombre, telefono, email, rol, sucursal_id, empresa_id, activo, created_at`,
    [nombre.trim(), telefono || null, email || null, rol, rol === 'dueño' ? null : sucursal_id || null, rol === 'dueño' ? null : empresa_id, hashPin(pin)]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { nombre, telefono, email, rol, sucursal_id, empresa_id, activo } = req.body ?? {};
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
  if (rol && (rol === 'dueño' || rol === 'admin') && req.usuario.rol !== 'dueño') {
    return res.status(403).json({ error: 'Solo el Dueño puede asignar Dueño o Admin.' });
  }

  const fields = { nombre, telefono, email, rol, sucursal_id, empresa_id, activo };
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
     RETURNING id, nombre, telefono, email, rol, sucursal_id, empresa_id, activo, created_at`,
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
