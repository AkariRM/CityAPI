const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  const { usuario_id, desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT n.id, n.usuario_id, u.nombre AS usuario_nombre, n.periodo_inicio, n.periodo_fin,
            n.sueldo_base, n.bonos, n.deducciones, n.total, n.pagado, n.created_at
     FROM nominas n
     JOIN usuarios u ON u.id = n.usuario_id
     WHERE ($1::uuid IS NULL OR n.usuario_id = $1::uuid)
       AND ($2::date IS NULL OR n.periodo_fin >= $2::date)
       AND ($3::date IS NULL OR n.periodo_inicio <= $3::date)
     ORDER BY n.periodo_inicio DESC, u.nombre`,
    [usuario_id || null, desde || null, hasta || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { usuario_id, periodo_inicio, periodo_fin, sueldo_base, bonos, deducciones } = req.body ?? {};

  if (!usuario_id) return res.status(400).json({ error: 'usuario_id es requerido.' });
  if (!periodo_inicio || !periodo_fin) return res.status(400).json({ error: 'periodo_inicio y periodo_fin son requeridos.' });
  if (periodo_fin < periodo_inicio) return res.status(400).json({ error: 'periodo_fin no puede ser anterior a periodo_inicio.' });

  const base = Number(sueldo_base) || 0;
  const extra = Number(bonos) || 0;
  const menos = Number(deducciones) || 0;
  const total = base + extra - menos;

  const { rows } = await pool.query(
    `INSERT INTO nominas (usuario_id, periodo_inicio, periodo_fin, sueldo_base, bonos, deducciones, total)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, usuario_id, periodo_inicio, periodo_fin, sueldo_base, bonos, deducciones, total, pagado, created_at`,
    [usuario_id, periodo_inicio, periodo_fin, base, extra, menos, total]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const actual = await pool.query(`SELECT * FROM nominas WHERE id = $1`, [req.params.id]);
  if (!actual.rows[0]) return res.status(404).json({ error: 'Nómina no encontrada.' });

  const base = req.body?.sueldo_base ?? actual.rows[0].sueldo_base;
  const extra = req.body?.bonos ?? actual.rows[0].bonos;
  const menos = req.body?.deducciones ?? actual.rows[0].deducciones;
  const pagado = req.body?.pagado ?? actual.rows[0].pagado;
  const total = Number(base) + Number(extra) - Number(menos);

  const { rows } = await pool.query(
    `UPDATE nominas SET sueldo_base = $1, bonos = $2, deducciones = $3, total = $4, pagado = $5 WHERE id = $6
     RETURNING id, usuario_id, periodo_inicio, periodo_fin, sueldo_base, bonos, deducciones, total, pagado, created_at`,
    [base, extra, menos, total, pagado, req.params.id]
  );
  res.json(rows[0]);
});

module.exports = router;
