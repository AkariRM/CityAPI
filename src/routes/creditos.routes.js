const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

const METODOS_ABONO_VALIDOS = ['efectivo', 'tarjeta'];
const ESTADOS_VALIDOS = ['activo', 'pagado', 'vencido', 'cancelado'];

router.get('/', async (req, res) => {
  const { cliente_id, estado } = req.query;
  const { rows } = await pool.query(
    `SELECT c.id, c.cliente_id, cl.nombre AS cliente_nombre, c.venta_id, v.folio AS venta_folio,
            c.monto_total, c.saldo_pendiente, c.limite_aprobado, c.condiciones, c.estado,
            c.autorizado_por, u.nombre AS autorizado_por_nombre, c.created_at, c.updated_at
     FROM creditos c
     JOIN clientes cl ON cl.id = c.cliente_id
     LEFT JOIN ventas v ON v.id = c.venta_id
     LEFT JOIN usuarios u ON u.id = c.autorizado_por
     WHERE ($1::uuid IS NULL OR c.cliente_id = $1::uuid)
       AND ($2::text IS NULL OR c.estado::text = $2)
     ORDER BY c.created_at DESC`,
    [cliente_id || null, estado || null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const creditoResult = await pool.query(
    `SELECT c.id, c.cliente_id, cl.nombre AS cliente_nombre, cl.telefono AS cliente_telefono,
            c.venta_id, v.folio AS venta_folio, c.monto_total, c.saldo_pendiente,
            c.limite_aprobado, c.condiciones, c.estado, c.autorizado_por, u.nombre AS autorizado_por_nombre,
            c.created_at, c.updated_at
     FROM creditos c
     JOIN clientes cl ON cl.id = c.cliente_id
     LEFT JOIN ventas v ON v.id = c.venta_id
     LEFT JOIN usuarios u ON u.id = c.autorizado_por
     WHERE c.id = $1`,
    [req.params.id]
  );
  const credito = creditoResult.rows[0];
  if (!credito) return res.status(404).json({ error: 'Crédito no encontrado.' });

  const abonos = await pool.query(
    `SELECT a.id, a.monto, a.metodo, a.usuario_id, u.nombre AS usuario_nombre, a.created_at
     FROM abonos a LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.credito_id = $1
     ORDER BY a.created_at DESC`,
    [req.params.id]
  );

  res.json({ ...credito, abonos: abonos.rows });
});

// Autorizacion de credito independiente de una venta puntual (ej. abrir una
// cuenta/tab para un cliente). El flujo mas comun es vender "a credito"
// desde el Punto de Venta (ver POST /ventas), que crea este mismo tipo de
// registro automaticamente con venta_id.
router.post('/', requireRole('admin'), async (req, res) => {
  const { cliente_id, monto_total, limite_aprobado, condiciones } = req.body ?? {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id es requerido.' });
  if (!(Number(monto_total) > 0)) return res.status(400).json({ error: 'monto_total debe ser mayor a 0.' });
  if (limite_aprobado !== undefined && limite_aprobado !== null && Number(monto_total) > Number(limite_aprobado)) {
    return res.status(400).json({ error: 'El monto no puede superar el límite aprobado.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO creditos (cliente_id, monto_total, saldo_pendiente, autorizado_por, limite_aprobado, condiciones)
     VALUES ($1, $2, $2, $3, $4, $5)
     RETURNING id, cliente_id, monto_total, saldo_pendiente, limite_aprobado, condiciones, estado, autorizado_por, created_at`,
    [cliente_id, Number(monto_total), req.usuario.sub, limite_aprobado ?? null, condiciones || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { estado, condiciones, limite_aprobado } = req.body ?? {};
  if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

  const fields = { estado, condiciones, limite_aprobado };
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
  sets.push(`updated_at = now()`);

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE creditos SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, cliente_id, monto_total, saldo_pendiente, limite_aprobado, condiciones, estado, updated_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Crédito no encontrado.' });
  res.json(rows[0]);
});

// Registrar un abono (admin o vendedor — normalmente es quien esta en
// mostrador cuando el cliente regresa a pagar). El efectivo/tarjeta cobrado
// aqui cuenta en el corte de caja de quien lo registra, igual que una venta.
router.post('/:id/abonos', async (req, res) => {
  const { monto, metodo } = req.body ?? {};
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'monto debe ser mayor a 0.' });
  if (!METODOS_ABONO_VALIDOS.includes(metodo)) return res.status(400).json({ error: 'Método de pago inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const creditoResult = await client.query(`SELECT saldo_pendiente, estado FROM creditos WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const credito = creditoResult.rows[0];
    if (!credito) throw Object.assign(new Error('Crédito no encontrado.'), { statusCode: 404 });
    if (credito.estado !== 'activo') throw Object.assign(new Error('Este crédito ya no está activo.'), { statusCode: 409 });
    if (Number(monto) > Number(credito.saldo_pendiente)) {
      throw Object.assign(new Error('El abono no puede ser mayor al saldo pendiente.'), { statusCode: 400 });
    }

    const abono = await client.query(
      `INSERT INTO abonos (credito_id, monto, metodo, usuario_id) VALUES ($1, $2, $3, $4)
       RETURNING id, credito_id, monto, metodo, usuario_id, created_at`,
      [req.params.id, Number(monto), metodo, req.usuario.sub]
    );

    const nuevoSaldo = Number(credito.saldo_pendiente) - Number(monto);
    await client.query(
      `UPDATE creditos SET saldo_pendiente = $1::numeric, estado = CASE WHEN $1::numeric <= 0 THEN 'pagado' ELSE estado END, updated_at = now() WHERE id = $2`,
      [nuevoSaldo, req.params.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...abono.rows[0], saldo_pendiente: Math.max(nuevoSaldo, 0) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
