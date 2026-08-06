const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
  const { sucursal_id, proveedor_id, estado } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT o.id, o.proveedor_id, pv.nombre AS proveedor_nombre, o.producto_id, p.nombre AS producto_nombre,
            o.cantidad, o.estado, o.recibido_at, o.created_at
     FROM ordenes_compra o
     JOIN proveedores pv ON pv.id = o.proveedor_id
     JOIN productos p ON p.id = o.producto_id
     WHERE o.sucursal_id = $1
       AND ($2::uuid IS NULL OR o.proveedor_id = $2::uuid)
       AND ($3::text IS NULL OR o.estado::text = $3)
     ORDER BY o.created_at DESC`,
    [sucursal_id, proveedor_id || null, estado || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { proveedor_id, producto_id, sucursal_id, cantidad } = req.body ?? {};
  if (!proveedor_id) return res.status(400).json({ error: 'proveedor_id es requerido.' });
  if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!(Number.isInteger(cantidad) && cantidad > 0)) return res.status(400).json({ error: 'cantidad debe ser un entero mayor a 0.' });

  const { rows } = await pool.query(
    `INSERT INTO ordenes_compra (proveedor_id, producto_id, sucursal_id, cantidad, creado_por)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, proveedor_id, producto_id, sucursal_id, cantidad, estado, created_at`,
    [proveedor_id, producto_id, sucursal_id, cantidad, req.usuario.sub]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/recibir', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = await client.query(
      `SELECT * FROM ordenes_compra WHERE id = $1 AND estado = 'pendiente' FOR UPDATE`,
      [req.params.id]
    );
    const orden = actual.rows[0];
    if (!orden) throw Object.assign(new Error('Esta orden ya fue recibida.'), { statusCode: 409 });

    await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
       VALUES ($1, $2, $3)
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + $3, updated_at = now()`,
      [orden.producto_id, orden.sucursal_id, orden.cantidad]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'entrada', $3, 'Recepción de orden de compra', 'orden_compra', $4, $5)`,
      [orden.producto_id, orden.sucursal_id, orden.cantidad, orden.id, req.usuario.sub]
    );

    const actualizada = await client.query(
      `UPDATE ordenes_compra SET estado = 'recibida', recibido_at = now() WHERE id = $1
       RETURNING id, estado, recibido_at`,
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json(actualizada.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
