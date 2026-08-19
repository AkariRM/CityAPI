const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

router.post('/', async (req, res) => {
  const { venta_original_id, producto_devuelto_id, producto_nuevo_id, unidad_imei_nueva_id, motivo } = req.body ?? {};
  if (!venta_original_id || !producto_devuelto_id) {
    return res.status(400).json({ error: 'venta_original_id y producto_devuelto_id son requeridos.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ventaResult = await client.query(`SELECT id, sucursal_id FROM ventas WHERE id = $1`, [venta_original_id]);
    const venta = ventaResult.rows[0];
    if (!venta) throw Object.assign(new Error('La venta original no existe.'), { statusCode: 404 });

    const itemResult = await client.query(
      `SELECT precio_unitario, unidad_imei_id FROM venta_items WHERE venta_id = $1 AND producto_id = $2 LIMIT 1`,
      [venta_original_id, producto_devuelto_id]
    );
    const itemDevuelto = itemResult.rows[0];
    if (!itemDevuelto) throw Object.assign(new Error('Ese producto no pertenece a la venta original.'), { statusCode: 400 });
    // La unidad devuelta se toma siempre de la venta original, nunca de lo
    // que mande el cliente — es la unica forma de garantizar que coincide
    // con el equipo que realmente se vendio.
    const unidadImeiDevuelta = itemDevuelto.unidad_imei_id || null;

    let precioNuevo = 0;
    if (producto_nuevo_id) {
      const stockNuevo = await client.query(
        `SELECT stock_cantidad, p.nombre, p.precio_venta
         FROM inventario i JOIN productos p ON p.id = i.producto_id
         WHERE i.producto_id = $1 AND i.sucursal_id = $2 FOR UPDATE`,
        [producto_nuevo_id, venta.sucursal_id]
      );
      const row = stockNuevo.rows[0];
      if (!row || row.stock_cantidad < 1) {
        throw Object.assign(new Error(`Stock insuficiente para "${row?.nombre ?? producto_nuevo_id}".`), { statusCode: 409 });
      }
      precioNuevo = Number(row.precio_venta);
    }

    let unidadImeiNueva = null;
    if (producto_nuevo_id && unidad_imei_nueva_id) {
      const unidadNueva = await client.query(
        `SELECT estado FROM unidades_imei WHERE id = $1 AND producto_id = $2 AND sucursal_id = $3 FOR UPDATE`,
        [unidad_imei_nueva_id, producto_nuevo_id, venta.sucursal_id]
      );
      if (!unidadNueva.rows[0]) throw Object.assign(new Error('La unidad IMEI seleccionada para el producto nuevo no existe.'), { statusCode: 400 });
      if (unidadNueva.rows[0].estado !== 'disponible') {
        throw Object.assign(new Error('Esa unidad ya no está disponible.'), { statusCode: 409 });
      }
      unidadImeiNueva = unidad_imei_nueva_id;
    }

    const diferencia = precioNuevo - Number(itemDevuelto.precio_unitario);

    const cambioResult = await client.query(
      `INSERT INTO cambios (venta_original_id, producto_devuelto_id, producto_nuevo_id, unidad_imei_devuelta_id, unidad_imei_nueva_id, diferencia, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, diferencia, created_at`,
      [venta_original_id, producto_devuelto_id, producto_nuevo_id || null, unidadImeiDevuelta, unidadImeiNueva, diferencia, motivo || null, req.usuario.sub]
    );
    const cambio = cambioResult.rows[0];

    await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
       VALUES ($1, $2, 1)
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + 1, updated_at = now()`,
      [producto_devuelto_id, venta.sucursal_id]
    );
    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'entrada', 1, 'Cambio - producto devuelto', 'cambio', $3, $4)`,
      [producto_devuelto_id, venta.sucursal_id, cambio.id, req.usuario.sub]
    );
    if (unidadImeiDevuelta) {
      await client.query(`UPDATE unidades_imei SET estado = 'disponible', updated_at = now() WHERE id = $1`, [unidadImeiDevuelta]);
    }

    if (producto_nuevo_id) {
      await client.query(
        `UPDATE inventario SET stock_cantidad = stock_cantidad - 1, updated_at = now() WHERE producto_id = $1 AND sucursal_id = $2`,
        [producto_nuevo_id, venta.sucursal_id]
      );
      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'salida', 1, 'Cambio - producto nuevo entregado', 'cambio', $3, $4)`,
        [producto_nuevo_id, venta.sucursal_id, cambio.id, req.usuario.sub]
      );
      if (unidadImeiNueva) {
        await client.query(`UPDATE unidades_imei SET estado = 'vendido', updated_at = now() WHERE id = $1`, [unidadImeiNueva]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ id: cambio.id, diferencia, created_at: cambio.created_at });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
