const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'community_manager'));

const CANALES_VALIDOS = ['whatsapp', 'instagram'];
const ESTADOS_VALIDOS = ['activa', 'cerrada', 'escalada'];
const REMITENTES_VALIDOS = ['cliente', 'humano'];

router.get('/', async (req, res) => {
  const { estado, canal } = req.query;
  const { rows } = await pool.query(
    `SELECT c.id, c.cliente_telefono, c.canal, c.cliente_id, cl.nombre AS cliente_nombre,
            c.estado, c.sentimiento, c.ultima_actividad, c.created_at,
            m.contenido AS ultimo_mensaje, m.remitente AS ultimo_remitente
     FROM conversaciones_ia c
     LEFT JOIN clientes cl ON cl.id = c.cliente_id
     LEFT JOIN LATERAL (
       SELECT contenido, remitente FROM mensajes_ia WHERE conversacion_id = c.id ORDER BY created_at DESC LIMIT 1
     ) m ON true
     WHERE ($1::text IS NULL OR c.estado::text = $1) AND ($2::text IS NULL OR c.canal::text = $2)
     ORDER BY c.ultima_actividad DESC`,
    [estado || null, canal || null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const conv = await pool.query(
    `SELECT c.id, c.cliente_telefono, c.canal, c.cliente_id, cl.nombre AS cliente_nombre,
            c.estado, c.sentimiento, c.ultima_actividad, c.created_at
     FROM conversaciones_ia c
     LEFT JOIN clientes cl ON cl.id = c.cliente_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (!conv.rows[0]) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const mensajes = await pool.query(
    `SELECT id, remitente, contenido, created_at FROM mensajes_ia WHERE conversacion_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );

  res.json({ ...conv.rows[0], mensajes: mensajes.rows });
});

router.post('/', async (req, res) => {
  const { cliente_telefono, canal, cliente_id, mensaje_inicial } = req.body ?? {};
  if (!cliente_telefono?.trim()) return res.status(400).json({ error: 'El teléfono del cliente es requerido.' });
  if (!CANALES_VALIDOS.includes(canal)) return res.status(400).json({ error: 'Canal inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const conv = await client.query(
      `INSERT INTO conversaciones_ia (cliente_telefono, canal, cliente_id)
       VALUES ($1, $2, $3)
       RETURNING id, cliente_telefono, canal, cliente_id, estado, sentimiento, ultima_actividad, created_at`,
      [cliente_telefono.trim(), canal, cliente_id || null]
    );

    if (mensaje_inicial?.trim()) {
      await client.query(
        `INSERT INTO mensajes_ia (conversacion_id, remitente, contenido) VALUES ($1, 'cliente', $2)`,
        [conv.rows[0].id, mensaje_inicial.trim()]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(conv.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const { estado, sentimiento } = req.body ?? {};
  if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

  const fields = { estado, sentimiento };
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
    `UPDATE conversaciones_ia SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, estado, sentimiento`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Conversación no encontrada.' });
  res.json(rows[0]);
});

router.post('/:id/mensajes', async (req, res) => {
  const { contenido, remitente } = req.body ?? {};
  if (!contenido?.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
  if (!REMITENTES_VALIDOS.includes(remitente)) return res.status(400).json({ error: 'Remitente inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const conv = await client.query(`SELECT id FROM conversaciones_ia WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!conv.rows[0]) throw Object.assign(new Error('Conversación no encontrada.'), { statusCode: 404 });

    const mensaje = await client.query(
      `INSERT INTO mensajes_ia (conversacion_id, remitente, contenido) VALUES ($1, $2, $3)
       RETURNING id, remitente, contenido, created_at`,
      [req.params.id, remitente, contenido.trim()]
    );

    await client.query(`UPDATE conversaciones_ia SET ultima_actividad = now() WHERE id = $1`, [req.params.id]);

    await client.query('COMMIT');
    res.status(201).json(mensaje.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
