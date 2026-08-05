const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { sucursal_id, q, categoria_id } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT p.id, p.sku, p.nombre, p.tipo, p.marca, p.modelo, p.precio_venta,
            p.imagen_url, p.categoria_id, c.nombre AS categoria_nombre,
            COALESCE(i.stock_cantidad, 0) AS stock
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN inventario i ON i.producto_id = p.id AND i.sucursal_id = $1
     WHERE p.activo = true
       AND ($2::uuid IS NULL OR p.categoria_id = $2::uuid)
       AND ($3::text IS NULL OR p.nombre ILIKE '%' || $3 || '%')
     ORDER BY p.nombre`,
    [sucursal_id, categoria_id || null, q || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!['nuevo', 'usado', 'accesorio', 'servicio'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO productos (sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url, activo`,
    [sku || null, nombre.trim(), categoria_id || null, tipo, marca || null, modelo || null, precio_venta ?? 0, costo ?? 0, imagen_url || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
