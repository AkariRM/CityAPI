const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();

// Tecnico puede VER el inventario (para elegir una refacción al reparar),
// pero solo admin puede dar de alta, editar o registrar compras.
router.use(requireAuth, requireRole('admin', 'tecnico'));

router.get('/', async (req, res) => {
  const { sucursal_id, q } = req.query;
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT id, sucursal_id, nombre, categoria, proveedor, costo, stock, stock_minimo, activo, created_at, updated_at
     FROM refacciones
     WHERE activo = true
       AND ($1::uuid IS NULL OR sucursal_id = $1::uuid)
       AND ($2::text IS NULL OR nombre ILIKE '%' || $2 || '%')
     ORDER BY nombre`,
    [sucursal_id || null, q || null]
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { sucursal_id, nombre, categoria, proveedor, costo, stock, stock_minimo } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO refacciones (sucursal_id, nombre, categoria, proveedor, costo, stock, stock_minimo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, sucursal_id, nombre, categoria, proveedor, costo, stock, stock_minimo, activo, created_at, updated_at`,
    [sucursal_id, nombre.trim(), categoria?.trim() || null, proveedor?.trim() || null, Number(costo) || 0, Number(stock) || 0, Number(stock_minimo) || 0]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const campos = ['nombre', 'categoria', 'proveedor', 'costo', 'stock_minimo', 'activo'];
  const sets = [];
  const valores = [];
  campos.forEach((campo) => {
    if (req.body?.[campo] === undefined) return;
    valores.push(req.body[campo]);
    sets.push(`${campo} = $${valores.length}`);
  });
  if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });
  valores.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE refacciones SET ${sets.join(', ')} WHERE id = $${valores.length}
     RETURNING id, sucursal_id, nombre, categoria, proveedor, costo, stock, stock_minimo, activo, created_at, updated_at`,
    valores
  );
  if (!rows[0]) return res.status(404).json({ error: 'Refacción no encontrada.' });
  res.json(rows[0]);
});

// Registrar una compra de piezas para el local: suma stock, actualiza el
// costo al ultimo pagado, y opcionalmente refleja el gasto en Gastos del
// local (misma tabla que usa Corte de caja, sin endpoint nuevo).
router.post('/:id/compra', requireRole('admin'), async (req, res) => {
  const { cantidad, costo_unitario, registrar_gasto } = req.body ?? {};
  const cant = Number(cantidad);
  const costo = Number(costo_unitario);
  if (!(cant > 0)) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0.' });
  if (!(costo >= 0)) return res.status(400).json({ error: 'El costo unitario debe ser un número mayor o igual a 0.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = await client.query(`SELECT * FROM refacciones WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const refaccion = actual.rows[0];
    if (!refaccion) throw Object.assign(new Error('Refacción no encontrada.'), { statusCode: 404 });

    const { rows } = await client.query(
      `UPDATE refacciones SET stock = stock + $1, costo = $2 WHERE id = $3
       RETURNING id, sucursal_id, nombre, categoria, proveedor, costo, stock, stock_minimo, activo, created_at, updated_at`,
      [cant, costo, req.params.id]
    );

    if (registrar_gasto) {
      await client.query(
        `INSERT INTO gastos (sucursal_id, usuario_id, tipo, categoria, monto, descripcion, fecha)
         VALUES ($1, $2, 'gasto', 'Refacciones', $3, $4, current_date)`,
        [refaccion.sucursal_id, req.usuario.sub, cant * costo, `Compra de refacción: ${refaccion.nombre} x${cant}`]
      );
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

// Ajuste manual de stock (Stock/Kardex -> Nuevo movimiento). Misma idea que
// POST /productos/:id/ajuste-stock: cantidad es el delta con signo. La
// sucursal es la de la propia refaccion (cada fila ya pertenece a una).
router.post('/:id/ajuste-stock', requireRole('admin'), async (req, res) => {
  const { cantidad, motivo, tipo } = req.body ?? {};
  const delta = Number(cantidad);
  if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: 'cantidad debe ser un entero distinto de 0.' });
  if (tipo !== undefined && !['entrada', 'salida', 'ajuste'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = await client.query(`SELECT sucursal_id, stock FROM refacciones WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const refaccion = actual.rows[0];
    if (!refaccion) throw Object.assign(new Error('Refacción no encontrada.'), { statusCode: 404 });
    if (refaccion.stock + delta < 0) throw Object.assign(new Error('No hay stock suficiente para ese ajuste.'), { statusCode: 409 });

    const { rows } = await client.query(`UPDATE refacciones SET stock = stock + $1 WHERE id = $2 RETURNING stock`, [delta, req.params.id]);

    await client.query(
      `INSERT INTO movimientos_refacciones (refaccion_id, sucursal_id, tipo, cantidad, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.params.id, refaccion.sucursal_id, tipo || (delta > 0 ? 'entrada' : 'salida'), Math.abs(delta), motivo || 'Ajuste manual de inventario', req.usuario.sub]
    );

    await client.query('COMMIT');
    res.json({ stock: rows[0].stock });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

// Historial de ajustes manuales de refacciones -- mismo formato de fila que
// GET /productos/movimientos para que Kardex pueda mezclar ambas listas.
router.get('/movimientos', requireRole('admin'), async (req, res) => {
  const { sucursal_id, desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT m.id, (ref.nombre || ' (refacción)') AS producto_nombre, m.tipo, m.cantidad, m.motivo,
            m.usuario_id, u.nombre AS usuario_nombre, m.created_at
     FROM movimientos_refacciones m
     JOIN refacciones ref ON ref.id = m.refaccion_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE ($1::uuid IS NULL OR m.sucursal_id = $1::uuid)
       AND ($2::timestamptz IS NULL OR m.created_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR m.created_at < $3::timestamptz)
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [sucursal_id || null, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

module.exports = router;
