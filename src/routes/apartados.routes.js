const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

const METODOS_VALIDOS = ['efectivo', 'tarjeta'];
const ESTADOS_VALIDOS = ['activo', 'completado', 'cancelado'];

router.get('/', async (req, res) => {
  const { sucursal_id, cliente_id, estado, producto_id } = req.query;
  const { rows } = await pool.query(
    `SELECT a.id, a.folio, a.cliente_id, cl.nombre AS cliente_nombre, a.sucursal_id, a.producto_id, p.nombre AS producto_nombre,
            a.unidad_imei_id, u.imei, a.cantidad, a.precio_total, a.monto_abonado, a.estado,
            a.usuario_id, us.nombre AS usuario_nombre, a.created_at, a.updated_at
     FROM apartados a
     JOIN clientes cl ON cl.id = a.cliente_id
     JOIN productos p ON p.id = a.producto_id
     LEFT JOIN unidades_imei u ON u.id = a.unidad_imei_id
     LEFT JOIN usuarios us ON us.id = a.usuario_id
     WHERE ($1::uuid IS NULL OR a.sucursal_id = $1::uuid)
       AND ($2::uuid IS NULL OR a.cliente_id = $2::uuid)
       AND ($3::text IS NULL OR a.estado::text = $3)
       AND ($4::uuid IS NULL OR a.producto_id = $4::uuid)
     ORDER BY a.created_at DESC`,
    [sucursal_id || null, cliente_id || null, estado || null, producto_id || null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const apartadoResult = await pool.query(
    `SELECT a.id, a.folio, a.cliente_id, cl.nombre AS cliente_nombre, cl.telefono AS cliente_telefono,
            a.sucursal_id, a.producto_id, p.nombre AS producto_nombre, a.unidad_imei_id, u.imei,
            a.cantidad, a.precio_total, a.monto_abonado, a.estado,
            a.usuario_id, us.nombre AS usuario_nombre, a.created_at, a.updated_at
     FROM apartados a
     JOIN clientes cl ON cl.id = a.cliente_id
     JOIN productos p ON p.id = a.producto_id
     LEFT JOIN unidades_imei u ON u.id = a.unidad_imei_id
     LEFT JOIN usuarios us ON us.id = a.usuario_id
     WHERE a.id = $1`,
    [req.params.id]
  );
  const apartado = apartadoResult.rows[0];
  if (!apartado) return res.status(404).json({ error: 'Apartado no encontrado.' });

  const abonos = await pool.query(
    `SELECT ab.id, ab.monto, ab.metodo, ab.usuario_id, us.nombre AS usuario_nombre, ab.created_at
     FROM apartado_abonos ab LEFT JOIN usuarios us ON us.id = ab.usuario_id
     WHERE ab.apartado_id = $1
     ORDER BY ab.created_at DESC`,
    [req.params.id]
  );

  res.json({ ...apartado, abonos: abonos.rows });
});

router.post('/', async (req, res) => {
  const { cliente_id, sucursal_id, producto_id, unidad_imei_id, cantidad, precio_total, anticipo, metodo } = req.body ?? {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id es requerido.' });
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });
  if (!(Number.isInteger(cantidad) && cantidad > 0)) return res.status(400).json({ error: 'cantidad debe ser un entero mayor a 0.' });
  if (!(Number(precio_total) > 0)) return res.status(400).json({ error: 'precio_total debe ser mayor a 0.' });
  const montoAnticipo = Number(anticipo) || 0;
  if (montoAnticipo < 0) return res.status(400).json({ error: 'anticipo no puede ser negativo.' });
  if (montoAnticipo > 0 && !METODOS_VALIDOS.includes(metodo)) return res.status(400).json({ error: 'Método de pago inválido para el anticipo.' });
  if (montoAnticipo > Number(precio_total)) return res.status(400).json({ error: 'El anticipo no puede ser mayor al precio total.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inv = await client.query(
      `SELECT stock_cantidad, stock_apartado FROM inventario WHERE producto_id = $1 AND sucursal_id = $2 FOR UPDATE`,
      [producto_id, sucursal_id]
    );
    const disponible = inv.rows[0] ? inv.rows[0].stock_cantidad - inv.rows[0].stock_apartado : 0;
    if (disponible < cantidad) {
      throw Object.assign(new Error('No hay suficiente stock disponible para apartar.'), { statusCode: 409 });
    }

    if (unidad_imei_id) {
      const unidad = await client.query(
        `SELECT estado FROM unidades_imei WHERE id = $1 AND producto_id = $2 AND sucursal_id = $3 FOR UPDATE`,
        [unidad_imei_id, producto_id, sucursal_id]
      );
      if (!unidad.rows[0]) throw Object.assign(new Error('Unidad IMEI no encontrada.'), { statusCode: 404 });
      if (unidad.rows[0].estado !== 'disponible') throw Object.assign(new Error('Esa unidad no está disponible.'), { statusCode: 409 });
      await client.query(`UPDATE unidades_imei SET estado = 'apartado', updated_at = now() WHERE id = $1`, [unidad_imei_id]);
    }

    await client.query(
      `UPDATE inventario SET stock_apartado = stock_apartado + $1, updated_at = now() WHERE producto_id = $2 AND sucursal_id = $3`,
      [cantidad, producto_id, sucursal_id]
    );

    const apartado = await client.query(
      `INSERT INTO apartados (cliente_id, sucursal_id, producto_id, unidad_imei_id, cantidad, precio_total, monto_abonado, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, folio, cliente_id, sucursal_id, producto_id, unidad_imei_id, cantidad, precio_total, monto_abonado, estado, created_at`,
      [cliente_id, sucursal_id, producto_id, unidad_imei_id || null, cantidad, Number(precio_total), montoAnticipo, req.usuario.sub]
    );

    if (montoAnticipo > 0) {
      await client.query(
        `INSERT INTO apartado_abonos (apartado_id, monto, metodo, usuario_id) VALUES ($1, $2, $3, $4)`,
        [apartado.rows[0].id, montoAnticipo, metodo, req.usuario.sub]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(apartado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

router.post('/:id/abonos', async (req, res) => {
  const { monto, metodo } = req.body ?? {};
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'monto debe ser mayor a 0.' });
  if (!METODOS_VALIDOS.includes(metodo)) return res.status(400).json({ error: 'Método de pago inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const apartadoResult = await client.query(`SELECT precio_total, monto_abonado, estado FROM apartados WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const apartado = apartadoResult.rows[0];
    if (!apartado) throw Object.assign(new Error('Apartado no encontrado.'), { statusCode: 404 });
    if (apartado.estado !== 'activo') throw Object.assign(new Error('Este apartado ya no está activo.'), { statusCode: 409 });

    const saldoPendiente = Number(apartado.precio_total) - Number(apartado.monto_abonado);
    if (Number(monto) > saldoPendiente) {
      throw Object.assign(new Error('El abono no puede ser mayor al saldo pendiente.'), { statusCode: 400 });
    }

    const abono = await client.query(
      `INSERT INTO apartado_abonos (apartado_id, monto, metodo, usuario_id) VALUES ($1, $2, $3, $4)
       RETURNING id, apartado_id, monto, metodo, usuario_id, created_at`,
      [req.params.id, Number(monto), metodo, req.usuario.sub]
    );

    const nuevoMontoAbonado = Number(apartado.monto_abonado) + Number(monto);
    await client.query(`UPDATE apartados SET monto_abonado = $1::numeric, updated_at = now() WHERE id = $2`, [nuevoMontoAbonado, req.params.id]);

    await client.query('COMMIT');
    res.status(201).json({ ...abono.rows[0], monto_abonado: nuevoMontoAbonado });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const { estado } = req.body ?? {};
  if (!ESTADOS_VALIDOS.includes(estado) || estado === 'activo') return res.status(400).json({ error: 'Estado inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = await client.query(`SELECT * FROM apartados WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const apartado = actual.rows[0];
    if (!apartado) throw Object.assign(new Error('Apartado no encontrado.'), { statusCode: 404 });
    if (apartado.estado !== 'activo') throw Object.assign(new Error('Este apartado ya no está activo.'), { statusCode: 409 });

    if (estado === 'completado' && Number(apartado.monto_abonado) < Number(apartado.precio_total)) {
      throw Object.assign(new Error('Debes completar el pago antes de cerrar el apartado.'), { statusCode: 400 });
    }

    await client.query(
      `UPDATE inventario SET stock_apartado = GREATEST(stock_apartado - $1, 0), updated_at = now() WHERE producto_id = $2 AND sucursal_id = $3`,
      [apartado.cantidad, apartado.producto_id, apartado.sucursal_id]
    );

    if (estado === 'completado') {
      await client.query(
        `UPDATE inventario SET stock_cantidad = GREATEST(stock_cantidad - $1, 0), updated_at = now() WHERE producto_id = $2 AND sucursal_id = $3`,
        [apartado.cantidad, apartado.producto_id, apartado.sucursal_id]
      );
      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'salida', $3, 'Apartado completado — cliente se lleva el producto', 'apartado', $4, $5)`,
        [apartado.producto_id, apartado.sucursal_id, apartado.cantidad, apartado.id, req.usuario.sub]
      );
      if (apartado.unidad_imei_id) {
        await client.query(`UPDATE unidades_imei SET estado = 'vendido', updated_at = now() WHERE id = $1`, [apartado.unidad_imei_id]);
      }
    } else if (apartado.unidad_imei_id) {
      await client.query(`UPDATE unidades_imei SET estado = 'disponible', updated_at = now() WHERE id = $1`, [apartado.unidad_imei_id]);
    }

    const { rows } = await client.query(
      `UPDATE apartados SET estado = $1, updated_at = now() WHERE id = $2
       RETURNING id, folio, cliente_id, producto_id, unidad_imei_id, cantidad, precio_total, monto_abonado, estado, updated_at`,
      [estado, req.params.id]
    );

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
