const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');
const { ultimosDiezDigitos, textoLimpio, identificarContacto } = require('../utils/agente');

const router = express.Router();

// El agente de WhatsApp (TRAI) deja aqui cada pregunta que no pudo contestar ("lo checo y te confirmo"): queda como pendiente para
// que el personal la vea en la app (Agente > Pendientes del agente) y la responda. La respuesta se le manda a la persona por
// WhatsApp (ver utils/pendientesAgente.js).
//
// POST /pendiente-externo
//   { telefono, pregunta, nombre?, contexto?, equipo_interes?, referencia? }
//   Repetir la misma pregunta de la misma persona mientras sigue pendiente (24 h) no crea otra: devuelve la que ya existe
//   con "duplicado": true.
// GET /pendiente-externo?estado=pendiente|respondido|descartado|todos&telefono=&desde=
//   Por defecto los pendientes (el listado que se puede mandar al personal cada dia).

router.post('/', verificarSecreto, async (req, res) => {
  const { telefono, pregunta, nombre, contexto, equipo_interes: equipoInteres, referencia } = req.body ?? {};
  const telefono10 = ultimosDiezDigitos(telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  const textoPregunta = textoLimpio(pregunta, 1000);
  if (!textoPregunta) return res.status(400).json({ error: 'pregunta es requerida.' });

  const repetida = await pool.query(
    `SELECT id, folio, estado, tipo_contacto FROM agente_pendientes
     WHERE telefono10 = $1 AND estado = 'pendiente' AND lower(btrim(pregunta)) = lower($2) AND created_at > now() - interval '24 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [telefono10, textoPregunta]
  );
  if (repetida.rows[0]) return res.json({ ...repetida.rows[0], duplicado: true });

  const contacto = await identificarContacto(pool, telefono10);
  const { rows } = await pool.query(
    `INSERT INTO agente_pendientes (telefono, telefono10, nombre, tipo_contacto, cliente_id, pregunta, contexto, equipo_interes, referencia)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, folio, estado, tipo_contacto`,
    [
      textoLimpio(String(telefono), 30), telefono10, textoLimpio(nombre, 120) ?? contacto?.nombre ?? null, contacto?.tipo ?? 'prospecto',
      contacto?.tipo === 'cliente' ? contacto.id : null, textoPregunta, textoLimpio(contexto, 1000), textoLimpio(equipoInteres, 120),
      textoLimpio(referencia, 60),
    ]
  );
  res.status(201).json({ ...rows[0], duplicado: false });
});

const ESTADOS = ['pendiente', 'respondido', 'descartado'];

router.get('/', verificarSecreto, async (req, res) => {
  const estado = req.query.estado === undefined ? 'pendiente' : String(req.query.estado);
  if (estado !== 'todos' && !ESTADOS.includes(estado)) return res.status(400).json({ error: 'estado debe ser pendiente, respondido, descartado o todos.' });
  const telefono10 = req.query.telefono ? ultimosDiezDigitos(req.query.telefono) : null;
  if (req.query.telefono && !telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  const desde = req.query.desde ? new Date(String(req.query.desde)) : null;
  if (desde && Number.isNaN(desde.getTime())) return res.status(400).json({ error: 'desde debe ser una fecha (ej. 2026-10-10).' });

  const { rows } = await pool.query(
    `SELECT id, folio, telefono, nombre, tipo_contacto, pregunta, contexto, equipo_interes, referencia, estado, respuesta, created_at, respondido_at
     FROM agente_pendientes
     WHERE ($1::text = 'todos' OR estado = $1) AND ($2::text IS NULL OR telefono10 = $2) AND ($3::timestamptz IS NULL OR created_at >= $3)
     ORDER BY created_at ASC LIMIT 200`,
    [estado, telefono10, desde ? desde.toISOString() : null]
  );
  res.json(rows);
});

module.exports = router;
