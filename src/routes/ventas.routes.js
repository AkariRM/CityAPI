const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

const METODOS_VALIDOS = ['efectivo', 'tarjeta'];

router.get('/', async (req, res) => {
  const { folio } = req.query;
  if (!folio) return res.status(400).json({ error: 'folio es requerido para buscar.' });

  const { rows } = await pool.query(
    `SELECT v.id, v.folio, v.sucursal_id, v.subtotal, v.descuento, v.total, v.metodo_pago, v.estado, v.created_at,
            c.nombre AS cliente_nombre
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE v.folio ILIKE '%' || $1 || '%'
     ORDER BY v.created_at DESC
     LIMIT 10`,
    [folio]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const ventaResult = await pool.query(
    `SELECT v.id, v.folio, v.sucursal_id, v.subtotal, v.descuento, v.total, v.metodo_pago, v.estado, v.created_at,
            c.nombre AS cliente_nombre
     FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE v.id = $1`,
    [req.params.id]
  );
  const venta = ventaResult.rows[0];
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const items = await pool.query(
    `SELECT vi.id, vi.producto_id, p.nombre AS producto_nombre, vi.unidad_imei_id, vi.cantidad, vi.precio_unitario, vi.subtotal
     FROM venta_items vi JOIN productos p ON p.id = vi.producto_id
     WHERE vi.venta_id = $1
     ORDER BY p.nombre`,
    [req.params.id]
  );

  res.json({ ...venta, items: items.rows });
});

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

    const tipos = {};
    const nombres = {};
    for (const item of items) {
      const producto = await client.query(`SELECT tipo, nombre FROM productos WHERE id = $1`, [item.producto_id]);
      if (!producto.rows[0]) throw Object.assign(new Error('Producto no encontrado.'), { statusCode: 400 });
      tipos[item.producto_id] = producto.rows[0].tipo;
      nombres[item.producto_id] = producto.rows[0].nombre;
      if (producto.rows[0].tipo === 'servicio') continue; // los servicios no manejan inventario

      const { rows } = await client.query(
        `SELECT stock_cantidad FROM inventario WHERE producto_id = $1 AND sucursal_id = $2 FOR UPDATE`,
        [item.producto_id, sucursal_id]
      );
      const stockRow = rows[0];
      if (!stockRow || stockRow.stock_cantidad < item.cantidad) {
        throw Object.assign(new Error(`Stock insuficiente para "${producto.rows[0].nombre}".`), { statusCode: 409 });
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

      if (tipos[item.producto_id] === 'servicio') continue;

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

    const contexto = await pool.query(
      `SELECT s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
              u.nombre AS vendedor_nombre,
              c.nombre AS cliente_nombre
       FROM sucursales s
       LEFT JOIN usuarios u ON u.id = $2
       LEFT JOIN clientes c ON c.id = $3
       WHERE s.id = $1`,
      [sucursal_id, req.usuario.sub, cliente_id || null]
    );

    res.status(201).json({
      id: venta.id,
      folio: venta.folio,
      subtotal,
      descuento,
      total,
      metodo_pago,
      created_at: venta.created_at,
      ...contexto.rows[0],
      items: items.map((item) => ({
        producto_id: item.producto_id,
        nombre: nombres[item.producto_id],
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
        subtotal: item.cantidad * item.precio_unitario - (item.descuento ?? 0),
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
