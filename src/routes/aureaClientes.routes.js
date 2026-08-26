const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

router.get('/', async (req, res) => {
  const { q } = req.query;
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.email, c.direccion, c.notas, c.created_at,
            COALESCE(v.numero_compras, 0) AS numero_compras, v.ultima_compra AS ultima_visita
     FROM aurea_clientes c
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS numero_compras, max(created_at) AS ultima_compra
       FROM aurea_ventas WHERE cliente_id = c.id
     ) v ON true
     WHERE ($1::text IS NULL OR c.nombre ILIKE '%' || $1 || '%' OR c.telefono ILIKE '%' || $1 || '%')
     ORDER BY c.nombre
     LIMIT 300`,
    [q || null]
  );
  res.json(rows);
});

// Trae los abonos de una lista de apartados en una sola consulta (evita
// N+1) y los agrupa en memoria por el id del padre — mismo patron que
// clientes.routes.js (abonosAgrupados).
async function abonosAgrupados(idsPadre) {
  if (idsPadre.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT a.apartado_id AS padre_id, a.id, a.monto, a.metodo, a.created_at, u.nombre AS usuario_nombre
     FROM aurea_apartado_abonos a LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.apartado_id = ANY($1::uuid[])
     ORDER BY a.created_at DESC`,
    [idsPadre]
  );
  const porPadre = new Map();
  for (const row of rows) {
    if (!porPadre.has(row.padre_id)) porPadre.set(row.padre_id, []);
    porPadre.get(row.padre_id).push(row);
  }
  return porPadre;
}

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, telefono, email, direccion, notas, created_at FROM aurea_clientes WHERE id = $1`,
    [req.params.id]
  );
  const cliente = rows[0];
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const historial = await pool.query(
    `SELECT count(*)::int AS numero_ventas, COALESCE(sum(total), 0) AS total_comprado, max(created_at) AS ultima_compra
     FROM aurea_ventas WHERE cliente_id = $1`,
    [req.params.id]
  );

  const apartados = await pool.query(
    `SELECT a.id, a.folio, a.producto_id, p.nombre AS producto_nombre, a.cantidad, a.precio_total, a.monto_abonado, a.estado, a.created_at
     FROM aurea_apartados a JOIN aurea_productos p ON p.id = a.producto_id
     WHERE a.cliente_id = $1
     ORDER BY a.created_at DESC`,
    [req.params.id]
  );
  const abonosPorApartado = await abonosAgrupados(apartados.rows.map((a) => a.id));

  res.json({
    ...cliente,
    ...historial.rows[0],
    apartados: apartados.rows.map((a) => ({ ...a, abonos: abonosPorApartado.get(a.id) ?? [] })),
  });
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email, direccion, notas } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO aurea_clientes (nombre, telefono, email, direccion, notas) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nombre, telefono, email, direccion, notas, created_at`,
    [nombre.trim(), telefono || null, email || null, direccion || null, notas || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    telefono: req.body?.telefono,
    email: req.body?.email,
    direccion: req.body?.direccion,
    notas: req.body?.notas,
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
    `UPDATE aurea_clientes SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, telefono, email, direccion, notas, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
