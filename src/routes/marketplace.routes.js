const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'community_manager'));

router.get('/', async (req, res) => {
  const { activa, vendido } = req.query;
  const { rows } = await pool.query(
    `SELECT m.id, m.producto_id, p.nombre AS producto_nombre, p.marca, p.modelo, p.precio_venta AS precio_catalogo,
            m.precio, m.activa, m.vendido, m.creado_por, u.nombre AS creado_por_nombre, m.created_at, m.updated_at
     FROM marketplace_listados m
     JOIN productos p ON p.id = m.producto_id
     LEFT JOIN usuarios u ON u.id = m.creado_por
     WHERE ($1::boolean IS NULL OR m.activa = $1::boolean)
       AND ($2::boolean IS NULL OR m.vendido = $2::boolean)
     ORDER BY m.created_at DESC`,
    [activa === undefined ? null : activa === 'true', vendido === undefined ? null : vendido === 'true']
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { producto_id, precio } = req.body ?? {};
  if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });
  if (!(Number(precio) > 0)) return res.status(400).json({ error: 'precio debe ser mayor a 0.' });

  const producto = await pool.query(`SELECT tipo FROM productos WHERE id = $1`, [producto_id]);
  if (!producto.rows[0]) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (!['nuevo', 'usado'].includes(producto.rows[0].tipo)) {
    return res.status(400).json({ error: 'Solo se pueden publicar equipos (nuevos o usados) en Marketplace.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO marketplace_listados (producto_id, precio, creado_por)
     VALUES ($1, $2, $3)
     RETURNING id, producto_id, precio, activa, vendido, creado_por, created_at`,
    [producto_id, precio, req.usuario.sub]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const actual = await pool.query(`SELECT id FROM marketplace_listados WHERE id = $1`, [req.params.id]);
  if (!actual.rows[0]) return res.status(404).json({ error: 'Publicación de Marketplace no encontrada.' });

  if (req.body?.precio !== undefined && !(Number(req.body.precio) > 0)) {
    return res.status(400).json({ error: 'precio debe ser mayor a 0.' });
  }

  const fields = {
    precio: req.body?.precio,
    activa: req.body?.activa,
    vendido: req.body?.vendido,
  };
  // Marcar como vendido siempre desactiva la publicación, igual que en el prototipo.
  if (req.body?.vendido === true && req.body?.activa === undefined) {
    fields.activa = false;
  }

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
    `UPDATE marketplace_listados SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, producto_id, precio, activa, vendido, creado_por, created_at, updated_at`,
    values
  );
  res.json(rows[0]);
});

module.exports = router;
