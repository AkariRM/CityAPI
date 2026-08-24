const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');

const router = express.Router();
// Fase 1: sin sucursales, un solo stock global por producto. dueño y admin
// (ya viene acotado a Aurea por requireEmpresa) administran el catálogo;
// pto también puede dar de alta/editar, es quien recibe mercancía en piso.
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

router.get('/', async (req, res) => {
  const { q, activo } = req.query;
  const activoFiltro = activo === undefined ? true : activo === 'true';
  const { rows } = await pool.query(
    `SELECT id, nombre, categoria, precio_venta, costo, stock_cantidad, imagen_url, activo, created_at
     FROM aurea_productos
     WHERE activo = $1
       AND ($2::text IS NULL OR nombre ILIKE '%' || $2 || '%')
     ORDER BY nombre`,
    [activoFiltro, q || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, categoria, precio_venta, costo, stock_cantidad, imagen_url } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!(Number(precio_venta) >= 0)) return res.status(400).json({ error: 'El precio de venta es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO aurea_productos (nombre, categoria, precio_venta, costo, stock_cantidad, imagen_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, nombre, categoria, precio_venta, costo, stock_cantidad, imagen_url, activo, created_at`,
    [nombre.trim(), categoria || null, Number(precio_venta), Number(costo) || 0, Number(stock_cantidad) || 0, imagen_url || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    categoria: req.body?.categoria,
    precio_venta: req.body?.precio_venta,
    costo: req.body?.costo,
    stock_cantidad: req.body?.stock_cantidad,
    imagen_url: req.body?.imagen_url,
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
    `UPDATE aurea_productos SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, categoria, precio_venta, costo, stock_cantidad, imagen_url, activo, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
