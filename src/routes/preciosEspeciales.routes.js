const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Solo admin gestiona precios especiales; el precio efectivo ya se aplica
// para cualquier rol al consultar productos o cobrar (ver productos.routes y
// ventas.routes), pero quien los crea/edita siempre es el dueño del negocio.
router.use(requireAuth, requireRole('admin'));

const ROLES_VALIDOS = ['admin', 'vendedor', 'tecnico', 'community_manager'];

router.get('/', async (req, res) => {
  const { producto_id } = req.query;
  if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT pe.id, pe.producto_id, pe.cliente_id, c.nombre AS cliente_nombre, pe.rol, pe.precio, pe.created_at
     FROM precios_especiales pe
     LEFT JOIN clientes c ON c.id = pe.cliente_id
     WHERE pe.producto_id = $1
     ORDER BY pe.created_at DESC`,
    [producto_id]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { producto_id, cliente_id, rol, precio } = req.body ?? {};
  if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });
  if (!cliente_id && !rol) return res.status(400).json({ error: 'Indica un cliente o un rol.' });
  if (cliente_id && rol) return res.status(400).json({ error: 'Elige solo cliente o solo rol, no ambos.' });
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!(Number(precio) > 0)) return res.status(400).json({ error: 'El precio debe ser mayor a 0.' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO precios_especiales (producto_id, cliente_id, rol, precio)
       VALUES ($1, $2, $3, $4)
       RETURNING id, producto_id, cliente_id, rol, precio, created_at`,
      [producto_id, cliente_id || null, rol || null, precio]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Producto o cliente no encontrado.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM precios_especiales WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Precio especial no encontrado.' });
  res.status(204).end();
});

module.exports = router;
