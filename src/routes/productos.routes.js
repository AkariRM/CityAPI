const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

router.get('/', async (req, res) => {
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

router.get('/:id/unidades', async (req, res) => {
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

router.post('/:id/unidades', async (req, res) => {
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
