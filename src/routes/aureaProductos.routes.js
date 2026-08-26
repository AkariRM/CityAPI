const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();
// Fase 1: sin sucursales, un solo stock global por producto. dueño y admin
// (ya viene acotado a Aurea por requireEmpresa) administran el catálogo;
// pto también puede dar de alta/editar, es quien recibe mercancía en piso.
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

router.get('/', async (req, res) => {
  const { q, activo } = req.query;
  const activoFiltro = activo === undefined ? true : activo === 'true';
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.categoria, p.precio_venta, p.costo,
            p.stock_cantidad, p.stock_apartado, p.stock_minimo,
            p.proveedor_id, pv.nombre AS proveedor_nombre,
            p.imagen_url, p.activo, p.created_at
     FROM aurea_productos p
     LEFT JOIN aurea_proveedores pv ON pv.id = p.proveedor_id
     WHERE p.activo = $1
       AND ($2::text IS NULL OR p.nombre ILIKE '%' || $2 || '%')
     ORDER BY p.nombre`,
    [activoFiltro, q || null]
  );
  res.json(rows);
});

// Bitacora de entradas/salidas/ajustes — va antes de "/:id"-like routes para
// que Express no lo confunda con un parametro.
router.get('/movimientos', async (req, res) => {
  const { producto_id, desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT m.id, m.producto_id, p.nombre AS producto_nombre, m.tipo, m.cantidad, m.motivo,
            m.referencia_tipo, m.referencia_id, m.usuario_id, u.nombre AS usuario_nombre, m.created_at
     FROM aurea_movimientos_inventario m
     JOIN aurea_productos p ON p.id = m.producto_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE ($1::uuid IS NULL OR m.producto_id = $1::uuid)
       AND ($2::timestamptz IS NULL OR m.created_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR m.created_at < $3::timestamptz)
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [producto_id || null, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, categoria, precio_venta, costo, stock_cantidad, proveedor_id, imagen_url } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!(Number(precio_venta) >= 0)) return res.status(400).json({ error: 'El precio de venta es requerido.' });

  const cantidad = Number(stock_cantidad) || 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const producto = await client.query(
      `INSERT INTO aurea_productos (nombre, categoria, precio_venta, costo, stock_cantidad, proveedor_id, imagen_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nombre, categoria, precio_venta, costo, stock_cantidad, stock_apartado, stock_minimo, proveedor_id, imagen_url, activo, created_at`,
      [nombre.trim(), categoria || null, Number(precio_venta), Number(costo) || 0, cantidad, proveedor_id || null, imagen_url || null]
    );

    if (cantidad > 0) {
      await client.query(
        `INSERT INTO aurea_movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, 'entrada', $2, 'Alta de producto con stock inicial', 'producto', $1, $3)`,
        [producto.rows[0].id, cantidad, req.usuario.sub]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(producto.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    categoria: req.body?.categoria,
    precio_venta: req.body?.precio_venta,
    costo: req.body?.costo,
    stock_cantidad: req.body?.stock_cantidad,
    proveedor_id: req.body?.proveedor_id,
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
     RETURNING id, nombre, categoria, precio_venta, costo, stock_cantidad, stock_apartado, stock_minimo, proveedor_id, imagen_url, activo, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(rows[0]);
});

router.patch('/:id/stock-minimo', async (req, res) => {
  const { stock_minimo } = req.body ?? {};
  if (!(Number.isInteger(stock_minimo) && stock_minimo >= 0)) {
    return res.status(400).json({ error: 'stock_minimo debe ser un entero mayor o igual a 0.' });
  }

  const { rows } = await pool.query(
    `UPDATE aurea_productos SET stock_minimo = $1, updated_at = now() WHERE id = $2 RETURNING stock_cantidad, stock_minimo`,
    [stock_minimo, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(rows[0]);
});

router.post('/:id/ajuste-stock', async (req, res) => {
  const { cantidad, motivo, tipo } = req.body ?? {};
  const delta = Number(cantidad);
  if (!delta) return res.status(400).json({ error: 'cantidad debe ser distinta de 0.' });
  if (tipo !== undefined && !['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = await client.query(`SELECT stock_cantidad FROM aurea_productos WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!actual.rows[0]) throw Object.assign(new Error('Producto no encontrado.'), { statusCode: 404 });
    if (delta < 0 && actual.rows[0].stock_cantidad + delta < 0) {
      throw Object.assign(new Error('No hay stock suficiente para ese ajuste.'), { statusCode: 409 });
    }

    const result = await client.query(
      `UPDATE aurea_productos SET stock_cantidad = GREATEST(stock_cantidad + $1, 0), updated_at = now() WHERE id = $2
       RETURNING stock_cantidad`,
      [delta, req.params.id]
    );

    await client.query(
      `INSERT INTO aurea_movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
       VALUES ($1, $2, $3, $4, 'ajuste', $5)`,
      [req.params.id, tipo || (delta > 0 ? 'entrada' : 'salida'), Math.abs(delta), motivo || 'Ajuste manual de inventario', req.usuario.sub]
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

module.exports = router;
