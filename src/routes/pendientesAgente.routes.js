const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { textoLimpio, UUID } = require('../utils/agente');
const { enviarRespuesta } = require('../utils/pendientesAgente');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

// Pendientes del agente de WhatsApp (ver pendienteExterno.routes.js): lo que Michelle no pudo contestar. El personal (mostrador,
// supervisor y dueño) los ve aqui y los responde; la respuesta se le manda a la persona por WhatsApp.

const COLUMNAS = `p.id, p.folio, p.telefono, p.nombre, p.tipo_contacto, p.cliente_id, p.pregunta, p.contexto, p.equipo_interes, p.referencia,
                  p.estado, p.respuesta, p.respondido_at, p.aviso_estado, p.aviso_error, p.created_at, u.nombre AS respondido_por_nombre`;
const ESTADOS = ['pendiente', 'respondido', 'descartado'];

router.get('/', async (req, res) => {
  const estado = req.query.estado === undefined ? 'pendiente' : String(req.query.estado);
  if (estado !== 'todos' && !ESTADOS.includes(estado)) return res.status(400).json({ error: 'estado debe ser pendiente, respondido, descartado o todos.' });
  const q = textoLimpio(String(req.query.q ?? ''), 80);
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS}
     FROM agente_pendientes p LEFT JOIN usuarios u ON u.id = p.respondido_por
     WHERE ($1::text = 'todos' OR p.estado = $1)
       AND ($2::text IS NULL OR p.folio ILIKE '%' || $2 || '%' OR p.nombre ILIKE '%' || $2 || '%' OR (regexp_replace($2, '\\D', '', 'g') <> '' AND p.telefono10 LIKE '%' || regexp_replace($2, '\\D', '', 'g') || '%') OR p.pregunta ILIKE '%' || $2 || '%')
     ORDER BY CASE WHEN p.estado = 'pendiente' THEN 0 ELSE 1 END, CASE WHEN p.estado = 'pendiente' THEN p.created_at END ASC, p.created_at DESC
     LIMIT 300`,
    [estado, q]
  );
  res.json(rows);
});

router.get('/resumen', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
            min(created_at) FILTER (WHERE estado = 'pendiente') AS mas_antiguo,
            count(*) FILTER (WHERE estado = 'respondido' AND aviso_estado IN ('fallido', 'pendiente'))::int AS sin_confirmar
     FROM agente_pendientes`
  );
  res.json(rows[0]);
});

const falla = (statusCode, mensaje) => Object.assign(new Error(mensaje), { statusCode });
const traer = async (id) => (await pool.query(`SELECT ${COLUMNAS} FROM agente_pendientes p LEFT JOIN usuarios u ON u.id = p.respondido_por WHERE p.id = $1`, [id])).rows[0];

// POST /pendientes-agente/:id/responder   { respuesta, enviar? }  (enviar = true por defecto: se manda por WhatsApp)
router.post('/:id/responder', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Pendiente no encontrado.' });
  const respuesta = textoLimpio(req.body?.respuesta, 1000);
  if (!respuesta) return res.status(400).json({ error: 'Escribe la respuesta.' });
  const enviar = req.body?.enviar !== false;
  try {
    const { rows } = await pool.query(
      `UPDATE agente_pendientes SET estado = 'respondido', respuesta = $2, respondido_por = $3, respondido_at = now(),
                                    aviso_estado = CASE WHEN $4::boolean THEN NULL ELSE 'no_enviado' END, aviso_error = NULL
       WHERE id = $1 AND estado = 'pendiente' RETURNING id, folio, telefono, nombre, pregunta, respuesta, equipo_interes, referencia`,
      [req.params.id, respuesta, req.usuario.sub, enviar]
    );
    if (!rows[0]) {
      const existente = await traer(req.params.id);
      if (!existente) throw falla(404, 'Pendiente no encontrado.');
      throw falla(409, existente.estado === 'respondido' ? 'Este pendiente ya se respondió.' : 'Este pendiente ya se descartó.');
    }
    const aviso = enviar ? await enviarRespuesta(pool, rows[0], req.usuario.sub) : { estado: 'no_enviado', error: null };
    res.json({ ...(await traer(req.params.id)), aviso });
  } catch (err) {
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  }
});

// POST /pendientes-agente/:id/reenviar — manda otra vez la respuesta que no se pudo confirmar.
router.post('/:id/reenviar', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Pendiente no encontrado.' });
  const p = (await pool.query(
    `SELECT id, folio, telefono, nombre, pregunta, respuesta, equipo_interes, referencia, estado, aviso_estado FROM agente_pendientes WHERE id = $1`, [req.params.id]
  )).rows[0];
  if (!p) return res.status(404).json({ error: 'Pendiente no encontrado.' });
  if (p.estado !== 'respondido') return res.status(409).json({ error: 'Solo se reenvía una respuesta ya capturada.' });
  if (p.aviso_estado === 'enviado') return res.status(409).json({ error: 'Esta respuesta ya se envió.' });
  const aviso = await enviarRespuesta(pool, p, req.usuario.sub);
  res.json({ ...(await traer(p.id)), aviso });
});

// POST /pendientes-agente/:id/descartar — ya no hace falta contestarlo (se resolvio de otra forma, ya no aplica).
router.post('/:id/descartar', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Pendiente no encontrado.' });
  const { rows } = await pool.query(
    `UPDATE agente_pendientes SET estado = 'descartado', respondido_por = $2, respondido_at = now() WHERE id = $1 AND estado = 'pendiente' RETURNING id`,
    [req.params.id, req.usuario.sub]
  );
  if (!rows[0]) {
    const existente = await traer(req.params.id);
    return res.status(existente ? 409 : 404).json({ error: existente ? 'Este pendiente ya no está pendiente.' : 'Pendiente no encontrado.' });
  }
  res.json(await traer(req.params.id));
});

module.exports = router;
