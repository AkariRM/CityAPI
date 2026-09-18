const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');

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

module.exports = router;
