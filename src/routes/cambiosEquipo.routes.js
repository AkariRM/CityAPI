const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

const GRADOS_VALIDOS = ['A', 'B', 'C', 'D', 'otro'];

router.get('/', async (req, res) => {
  const { sucursal_id, estado } = req.query;
  // Admin y dueño pueden omitir sucursal_id (ven las evaluaciones de todas
  // las sucursales); vendedor lo sigue necesitando, igual que siempre.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT id, cliente_id, cliente_nombre, equipo_modelo, grado, grado_detalle, bateria_pct,
            pantalla_ok, cuerpo_ok, camaras_ok, botones_ok,
            valor_referencia, valor_ofrecido, estado, producto_id, created_at, updated_at
     FROM cambios_equipo
     WHERE ($1::uuid IS NULL OR sucursal_id = $1::uuid) AND ($2::text IS NULL OR estado::text = $2)
     ORDER BY created_at DESC`,
    [sucursal_id || null, estado || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const {
    sucursal_id,
    cliente_id,
    cliente_nombre,
    cliente_telefono,
    equipo_modelo,
    grado,
    grado_detalle,
    bateria_pct,
    pantalla_ok,
    cuerpo_ok,
    camaras_ok,
    botones_ok,
    valor_referencia,
    valor_ofrecido,
  } = req.body ?? {};

  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!cliente_nombre?.trim()) return res.status(400).json({ error: 'El nombre del cliente es requerido.' });
  if (!cliente_telefono?.trim()) return res.status(400).json({ error: 'El teléfono del cliente es requerido.' });
  if (!equipo_modelo?.trim()) return res.status(400).json({ error: 'El equipo ofrecido es requerido.' });
  if (!GRADOS_VALIDOS.includes(grado)) return res.status(400).json({ error: 'Grado inválido.' });
  if (grado === 'otro' && !grado_detalle?.trim()) {
    return res.status(400).json({ error: 'Describe la condición cuando eliges "Otro".' });
  }

  const { rows } = await pool.query(
    `INSERT INTO cambios_equipo
       (sucursal_id, cliente_id, cliente_nombre, cliente_telefono, equipo_modelo, grado, grado_detalle, bateria_pct,
        pantalla_ok, cuerpo_ok, camaras_ok, botones_ok, valor_referencia, valor_ofrecido, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, cliente_id, cliente_nombre, cliente_telefono, equipo_modelo, grado, grado_detalle, bateria_pct,
               pantalla_ok, cuerpo_ok, camaras_ok, botones_ok, valor_referencia, valor_ofrecido, estado, created_at`,
    [
      sucursal_id,
      cliente_id || null,
      cliente_nombre.trim(),
      cliente_telefono.trim(),
      equipo_modelo.trim(),
      grado,
      grado === 'otro' ? grado_detalle.trim() : null,
      bateria_pct ?? null,
      pantalla_ok ?? true,
      cuerpo_ok ?? true,
      camaras_ok ?? true,
      botones_ok ?? true,
      valor_referencia || 0,
      valor_ofrecido || 0,
      req.usuario.sub,
    ]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/aceptar', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE cambios_equipo SET estado = 'aceptado' WHERE id = $1 AND estado = 'evaluando'
     RETURNING id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede aceptar una evaluación en curso.' });
  res.json(rows[0]);
});

router.patch('/:id/rechazar', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE cambios_equipo SET estado = 'rechazado' WHERE id = $1 AND estado = 'evaluando'
     RETURNING id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede rechazar una evaluación en curso.' });
  res.json(rows[0]);
});

router.patch('/:id/aplicar-a-venta', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE cambios_equipo SET estado = 'completado' WHERE id = $1 AND estado = 'aceptado'
     RETURNING id, estado, valor_ofrecido`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede aplicar un cambio ya aceptado.' });
  res.json(rows[0]);
});

router.patch('/:id/agregar-a-catalogo', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = await client.query(
      `SELECT * FROM cambios_equipo WHERE id = $1 AND estado = 'aceptado' FOR UPDATE`,
      [req.params.id]
    );
    const cambio = actual.rows[0];
    if (!cambio) throw Object.assign(new Error('Solo se puede agregar al catálogo un cambio ya aceptado.'), { statusCode: 409 });

    const precioVenta = Math.round(Number(cambio.valor_ofrecido) * 1.4);
    const producto = await client.query(
      `INSERT INTO productos (nombre, tipo, precio_venta, costo)
       VALUES ($1, 'usado', $2, $3)
       RETURNING id`,
      [cambio.equipo_modelo, precioVenta, cambio.valor_ofrecido]
    );

    await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad) VALUES ($1, $2, 1)`,
      [producto.rows[0].id, cambio.sucursal_id]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'entrada', 1, 'Cambio de equipo por dinero agregado a catálogo', 'cambio_equipo', $3, $4)`,
      [producto.rows[0].id, cambio.sucursal_id, cambio.id, req.usuario.sub]
    );

    const actualizado = await client.query(
      `UPDATE cambios_equipo SET estado = 'completado', producto_id = $2 WHERE id = $1
       RETURNING id, estado, producto_id`,
      [req.params.id, producto.rows[0].id]
    );

    await client.query('COMMIT');
    res.json(actualizado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
