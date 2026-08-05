const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

const METODOS_VALIDOS = ['efectivo', 'tarjeta'];

router.post('/', async (req, res) => {
  const { sucursal_id, cliente_id, metodo_pago, items } = req.body ?? {};

  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!METODOS_VALIDOS.includes(metodo_pago)) return res.status(400).json({ error: 'Método de pago inválido.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'La venta necesita al menos un producto.' });
  for (const item of items) {
    if (!item.producto_id || !(item.cantidad > 0) || !(item.precio_unitario >= 0)) {
      return res.status(400).json({ error: 'Cada producto necesita producto_id, cantidad y precio_unitario válidos.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of items) {
      const { rows } = await client.query(
        `SELECT stock_cantidad, p.nombre
         FROM inventario i
         JOIN productos p ON p.id = i.producto_id
         WHERE i.producto_id = $1 AND i.sucursal_id = $2
         FOR UPDATE`,
        [item.producto_id, sucursal_id]
      );
      const stockRow = rows[0];
      if (!stockRow || stockRow.stock_cantidad < item.cantidad) {
        throw Object.assign(new Error(`Stock insuficiente para "${stockRow?.nombre ?? item.producto_id}".`), { statusCode: 409 });
      }
    }

    const subtotal = items.reduce((sum, i) => sum + i.cantidad * i.precio_unitario, 0);
    const descuento = req.body.descuento ?? 0;
    const total = subtotal - descuento;

    const ventaResult = await client.query(
      `INSERT INTO ventas (sucursal_id, vendedor_id, cliente_id, subtotal, descuento, total, metodo_pago)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, folio, created_at`,
      [sucursal_id, req.usuario.sub, cliente_id || null, subtotal, descuento, total, metodo_pago]
    );
    const venta = ventaResult.rows[0];

    for (const item of items) {
      const itemSubtotal = item.cantidad * item.precio_unitario - (item.descuento ?? 0);
      await client.query(
        `INSERT INTO venta_items (venta_id, producto_id, unidad_imei_id, cantidad, precio_unitario, descuento, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [venta.id, item.producto_id, item.unidad_imei_id || null, item.cantidad, item.precio_unitario, item.descuento ?? 0, itemSubtotal]
      );

      await client.query(
        `UPDATE inventario SET stock_cantidad = stock_cantidad - $1, updated_at = now()
         WHERE producto_id = $2 AND sucursal_id = $3`,
        [item.cantidad, item.producto_id, sucursal_id]
      );

      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'salida', $3, 'Venta de mostrador', 'venta', $4, $5)`,
        [item.producto_id, sucursal_id, item.cantidad, venta.id, req.usuario.sub]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: venta.id, folio: venta.folio, subtotal, descuento, total, created_at: venta.created_at });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
