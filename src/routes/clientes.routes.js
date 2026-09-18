const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor', 'tecnico'));

router.get('/', async (req, res) => {
  const { q } = req.query;
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.email, c.direccion, c.notas, c.created_at,
            COALESCE(v.numero_compras, 0) AS numero_compras,
            COALESCE(r.numero_reparaciones, 0) AS numero_reparaciones,
            GREATEST(v.ultima_compra, r.ultima_reparacion) AS ultima_visita
     FROM clientes c
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS numero_compras, max(created_at) AS ultima_compra
       FROM ventas WHERE cliente_id = c.id AND estado = 'completada'
     ) v ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS numero_reparaciones, max(created_at) AS ultima_reparacion
       FROM reparaciones WHERE cliente_id = c.id
     ) r ON true
     WHERE ($1::text IS NULL OR c.nombre ILIKE '%' || $1 || '%' OR c.telefono ILIKE '%' || $1 || '%')
     ORDER BY c.nombre
     LIMIT 300`,
    [q || null]
  );
  res.json(rows);
});

// Trae los abonos de una lista de creditos/apartados en una sola consulta
// (evita N+1) y los agrupa en memoria por el id del padre.
async function abonosAgrupados(tabla, columnaPadre, idsPadre) {
  if (idsPadre.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT a.${columnaPadre} AS padre_id, a.id, a.monto, a.metodo, a.created_at, u.nombre AS usuario_nombre
     FROM ${tabla} a LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.${columnaPadre} = ANY($1::uuid[])
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
  const { rows } = await pool.query(`SELECT id, nombre, telefono, email, direccion, notas, created_at FROM clientes WHERE id = $1`, [req.params.id]);
  const cliente = rows[0];
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const historial = await pool.query(
    `SELECT count(*)::int AS numero_ventas, COALESCE(sum(total), 0) AS total_comprado, max(created_at) AS ultima_compra
     FROM ventas WHERE cliente_id = $1 AND estado = 'completada'`,
    [req.params.id]
  );

  const creditos = await pool.query(
    `SELECT c.id, c.monto_total, c.saldo_pendiente, c.limite_aprobado, c.condiciones, c.estado, c.created_at,
            u.nombre AS autorizado_por_nombre
     FROM creditos c LEFT JOIN usuarios u ON u.id = c.autorizado_por
     WHERE c.cliente_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.id]
  );
  const abonosPorCredito = await abonosAgrupados('abonos', 'credito_id', creditos.rows.map((c) => c.id));

  const apartados = await pool.query(
    `SELECT a.id, a.folio, a.producto_id, p.nombre AS producto_nombre, a.cantidad, a.precio_total, a.monto_abonado, a.estado, a.created_at
     FROM apartados a JOIN productos p ON p.id = a.producto_id
     WHERE a.cliente_id = $1
     ORDER BY a.created_at DESC`,
    [req.params.id]
  );
  const abonosPorApartado = await abonosAgrupados('apartado_abonos', 'apartado_id', apartados.rows.map((a) => a.id));

  res.json({
    ...cliente,
    ...historial.rows[0],
    creditos: creditos.rows.map((c) => ({ ...c, abonos: abonosPorCredito.get(c.id) ?? [] })),
    apartados: apartados.rows.map((a) => ({ ...a, abonos: abonosPorApartado.get(a.id) ?? [] })),
  });
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email, direccion, notas } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO clientes (nombre, telefono, email, direccion, notas) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nombre, telefono, email, direccion, notas, created_at`,
    [nombre.trim(), telefono || null, email || null, direccion || null, notas || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const fields = { nombre: req.body?.nombre, telefono: req.body?.telefono, email: req.body?.email, direccion: req.body?.direccion, notas: req.body?.notas };
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
    `UPDATE clientes SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, telefono, email, direccion, notas, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
