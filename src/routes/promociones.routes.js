const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'community_manager'));

router.get('/', async (req, res) => {
  const { activo, vigente } = req.query;
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.descripcion, p.descuento_pct, p.producto_id, pr.nombre AS producto_nombre,
            p.categoria_id, c.nombre AS categoria_nombre, p.fecha_inicio::text, p.fecha_fin::text, p.activo, p.created_at
     FROM promociones p
     LEFT JOIN productos pr ON pr.id = p.producto_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE ($1::boolean IS NULL OR p.activo = $1::boolean)
       AND ($2::boolean IS NULL OR NOT $2::boolean OR (p.activo AND current_date BETWEEN p.fecha_inicio AND p.fecha_fin))
     ORDER BY p.fecha_inicio DESC`,
    [activo === undefined ? null : activo === 'true', vigente === undefined ? null : vigente === 'true']
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, descripcion, descuento_pct, producto_id, categoria_id, fecha_inicio, fecha_fin } = req.body ?? {};

  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'fecha_inicio y fecha_fin son requeridas.' });
  if (new Date(fecha_fin) < new Date(fecha_inicio)) {
    return res.status(400).json({ error: 'fecha_fin debe ser mayor o igual a fecha_inicio.' });
  }
  if (descuento_pct !== undefined && descuento_pct !== null && !(Number(descuento_pct) >= 0 && Number(descuento_pct) <= 100)) {
    return res.status(400).json({ error: 'descuento_pct debe estar entre 0 y 100.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO promociones (nombre, descripcion, descuento_pct, producto_id, categoria_id, fecha_inicio, fecha_fin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, nombre, descripcion, descuento_pct, producto_id, categoria_id, fecha_inicio::text, fecha_fin::text, activo, created_at`,
    [nombre.trim(), descripcion || null, descuento_pct ?? null, producto_id || null, categoria_id || null, fecha_inicio, fecha_fin]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const actual = await pool.query(`SELECT fecha_inicio, fecha_fin FROM promociones WHERE id = $1`, [req.params.id]);
  if (!actual.rows[0]) return res.status(404).json({ error: 'Promoción no encontrada.' });

  const fechaInicioFinal = req.body?.fecha_inicio ?? actual.rows[0].fecha_inicio;
  const fechaFinFinal = req.body?.fecha_fin ?? actual.rows[0].fecha_fin;
  if (new Date(fechaFinFinal) < new Date(fechaInicioFinal)) {
    return res.status(400).json({ error: 'fecha_fin debe ser mayor o igual a fecha_inicio.' });
  }
  if (
    req.body?.descuento_pct !== undefined &&
    req.body.descuento_pct !== null &&
    !(Number(req.body.descuento_pct) >= 0 && Number(req.body.descuento_pct) <= 100)
  ) {
    return res.status(400).json({ error: 'descuento_pct debe estar entre 0 y 100.' });
  }

  const fields = {
    nombre: req.body?.nombre,
    descripcion: req.body?.descripcion,
    descuento_pct: req.body?.descuento_pct,
    producto_id: req.body?.producto_id,
    categoria_id: req.body?.categoria_id,
    fecha_inicio: req.body?.fecha_inicio,
    fecha_fin: req.body?.fecha_fin,
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
    `UPDATE promociones SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, descripcion, descuento_pct, producto_id, categoria_id, fecha_inicio::text, fecha_fin::text, activo, created_at`,
    values
  );
  res.json(rows[0]);
});

module.exports = router;
