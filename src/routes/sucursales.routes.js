const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// El listado es de lectura y lo necesita cualquier rol autenticado (elegir
// sucursal al importar equipos, fijar la sucursal del dispositivo en
// Configuracion, etc.) — solo dar de alta/editar sucursales sigue siendo
// exclusivo de quien administra el catalogo de sucursales.
router.get('/', async (req, res) => {
  const { activo } = req.query;
  // Sin parametro: solo activas (comportamiento historico, lo que ya usan
  // Usuarios/Configuracion/el filtro de sucursal). "todas" es el unico valor
  // que quita el filtro — lo usa la pantalla de administracion de sucursales
  // para poder ver y reactivar las dadas de baja.
  const filtro = activo === undefined ? true : activo === 'todas' ? null : activo === 'true';
  const { rows } = await pool.query(
    `SELECT id, nombre, direccion, telefono, fondo_caja_default, activo FROM sucursales
     WHERE ($1::boolean IS NULL OR activo = $1::boolean)
     ORDER BY nombre`,
    [filtro]
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { nombre, direccion, telefono, fondo_caja_default } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO sucursales (nombre, direccion, telefono, fondo_caja_default) VALUES ($1, $2, $3, $4)
     RETURNING id, nombre, direccion, telefono, fondo_caja_default, activo`,
    [nombre.trim(), direccion || null, telefono || null, Number(fondo_caja_default) || 0]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    direccion: req.body?.direccion,
    telefono: req.body?.telefono,
    fondo_caja_default: req.body?.fondo_caja_default,
    activo: req.body?.activo,
  };
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
    `UPDATE sucursales SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, direccion, telefono, fondo_caja_default, activo`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada.' });
  res.json(rows[0]);
});

module.exports = router;
