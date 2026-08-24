const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

const METODOS_VALIDOS = ['efectivo', 'tarjeta', 'credito'];

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.folio, v.usuario_id, u.nombre AS usuario_nombre, v.metodo_pago, v.subtotal, v.total, v.created_at
     FROM aurea_ventas v
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     ORDER BY v.created_at DESC
     LIMIT 200`
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { metodo_pago, items } = req.body ?? {};
  if (!METODOS_VALIDOS.includes(metodo_pago)) return res.status(400).json({ error: 'Método de pago inválido.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'La venta necesita al menos un producto.' });
  for (const item of items) {
    if (!item.producto_id || !(item.cantidad > 0)) {
      return res.status(400).json({ error: 'Cada producto necesita producto_id y cantidad válidos.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const precios = {};
    for (const item of items) {
      const { rows } = await client.query(
        `SELECT nombre, precio_venta, stock_cantidad FROM aurea_productos WHERE id = $1 AND activo = true FOR UPDATE`,
        [item.producto_id]
      );
      const producto = rows[0];
      if (!producto) throw Object.assign(new Error('Producto no encontrado.'), { statusCode: 400 });
      if (producto.stock_cantidad < item.cantidad) {
        throw Object.assign(new Error(`Stock insuficiente para "${producto.nombre}".`), { statusCode: 409 });
      }
      precios[item.producto_id] = Number(producto.precio_venta);
    }

    const subtotal = items.reduce((sum, i) => sum + i.cantidad * precios[i.producto_id], 0);

    const ventaResult = await client.query(
      `INSERT INTO aurea_ventas (usuario_id, metodo_pago, subtotal, total)
       VALUES ($1, $2, $3, $3)
       RETURNING id, folio, subtotal, total, created_at`,
      [req.usuario.sub, metodo_pago, subtotal]
    );
    const venta = ventaResult.rows[0];

    for (const item of items) {
      const precioUnitario = precios[item.producto_id];
      const itemSubtotal = item.cantidad * precioUnitario;
      await client.query(
        `INSERT INTO aurea_venta_items (venta_id, producto_id, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [venta.id, item.producto_id, item.cantidad, precioUnitario, itemSubtotal]
      );
      await client.query(
        `UPDATE aurea_productos SET stock_cantidad = stock_cantidad - $1, updated_at = now() WHERE id = $2`,
        [item.cantidad, item.producto_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(venta);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
