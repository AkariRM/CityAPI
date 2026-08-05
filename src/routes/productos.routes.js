const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// El listado tambien lo usa el tecnico para buscar refacciones al armar un
// folio de reparacion; las demas rutas (alta, edicion, stock, IMEI) siguen
// restringidas a quienes administran el catalogo.
router.get('/', requireRole('admin', 'vendedor', 'tecnico'), async (req, res) => {
  const { sucursal_id, q, categoria_id, tipo } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const tipos = tipo ? tipo.split(',').map((t) => t.trim()) : null;

  const { rows } = await pool.query(
    `SELECT p.id, p.sku, p.nombre, p.tipo, p.marca, p.modelo, p.precio_venta, p.costo,
            p.imagen_url, p.categoria_id, c.nombre AS categoria_nombre,
            COALESCE(i.stock_cantidad, 0) AS stock
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN inventario i ON i.producto_id = p.id AND i.sucursal_id = $1
     WHERE p.activo = true
       AND ($2::uuid IS NULL OR p.categoria_id = $2::uuid)
       AND ($3::text IS NULL OR p.nombre ILIKE '%' || $3 || '%')
       AND ($4::text[] IS NULL OR p.tipo::text = ANY($4::text[]))
     ORDER BY p.nombre`,
    [sucursal_id, categoria_id || null, q || null, tipos]
  );
  res.json(rows);
});

router.post('/', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url, sucursal_id, stock_inicial } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!['nuevo', 'usado', 'accesorio', 'servicio'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }

  const cantidad = Number(stock_inicial) || 0;
  if (sucursal_id && cantidad < 0) return res.status(400).json({ error: 'La cantidad inicial no puede ser negativa.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const producto = await client.query(
      `INSERT INTO productos (sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url, activo`,
      [sku || null, nombre.trim(), categoria_id || null, tipo, marca || null, modelo || null, precio_venta ?? 0, costo ?? 0, imagen_url || null]
    );

    if (sucursal_id) {
      await client.query(
        `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad) VALUES ($1, $2, $3)`,
        [producto.rows[0].id, sucursal_id, cantidad]
      );
      if (cantidad > 0) {
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
           VALUES ($1, $2, 'entrada', $3, 'Alta de producto con stock inicial', 'producto', $1, $4)`,
          [producto.rows[0].id, sucursal_id, cantidad, req.usuario.sub]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...producto.rows[0], stock: cantidad });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

router.patch('/:id', requireRole('admin', 'vendedor'), async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    categoria_id: req.body?.categoria_id,
    precio_venta: req.body?.precio_venta,
    costo: req.body?.costo,
    marca: req.body?.marca,
    modelo: req.body?.modelo,
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
  if (sets.length === 0) return res.status(400).json({ error: 'No hay campos para actualizar.' });

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE productos SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, sku, nombre, categoria_id, tipo, marca, modelo, precio_venta, costo, imagen_url, activo`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(rows[0]);
});

router.post('/:id/ajuste-stock', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, cantidad, motivo } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  const delta = Number(cantidad);
  if (!delta) return res.status(400).json({ error: 'cantidad debe ser distinta de 0.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (delta < 0) {
      const { rows } = await client.query(
        `SELECT stock_cantidad FROM inventario WHERE producto_id = $1 AND sucursal_id = $2 FOR UPDATE`,
        [req.params.id, sucursal_id]
      );
      if (!rows[0] || rows[0].stock_cantidad + delta < 0) {
        throw Object.assign(new Error('No hay stock suficiente para ese ajuste.'), { statusCode: 409 });
      }
    }

    const result = await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
       VALUES ($1, $2, GREATEST($3, 0))
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + $3, updated_at = now()
       RETURNING stock_cantidad`,
      [req.params.id, sucursal_id, delta]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, 'ajuste', $6)`,
      [req.params.id, sucursal_id, delta > 0 ? 'entrada' : 'salida', Math.abs(delta), motivo || 'Ajuste manual de inventario', req.usuario.sub]
    );

    await client.query('COMMIT');
    res.json({ stock: result.rows[0].stock_cantidad });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

router.get('/:id/unidades', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id } = req.query;
  const { rows } = await pool.query(
    `SELECT id, imei, condicion, costo_adquisicion, estado, created_at
     FROM unidades_imei
     WHERE producto_id = $1 AND ($2::uuid IS NULL OR sucursal_id = $2::uuid)
     ORDER BY created_at DESC`,
    [req.params.id, sucursal_id || null]
  );
  res.json(rows);
});

router.post('/:id/unidades', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, imei, condicion, costo_adquisicion } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!imei?.trim()) return res.status(400).json({ error: 'El IMEI es requerido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const unidad = await client.query(
      `INSERT INTO unidades_imei (producto_id, sucursal_id, imei, condicion, costo_adquisicion)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, imei, condicion, costo_adquisicion, estado, created_at`,
      [req.params.id, sucursal_id, imei.trim(), condicion || null, costo_adquisicion || null]
    );

    await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
       VALUES ($1, $2, 1)
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + 1, updated_at = now()`,
      [req.params.id, sucursal_id]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'entrada', 1, 'Alta de equipo con IMEI', 'unidad_imei', $3, $4)`,
      [req.params.id, sucursal_id, unidad.rows[0].id, req.usuario.sub]
    );

    await client.query('COMMIT');
    res.status(201).json(unidad.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(409).json({ error: 'Ese IMEI ya está registrado.' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  } finally {
    client.release();
  }
});

module.exports = router;
