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

// ---- Conversaciones reales del agente de WhatsApp (Michelle) ----
// El agente (el n8n de TRAI) guarda su memoria en la base de CityPhone: wa_historial_chat (un renglon por mensaje: session_id = telefono en E.164,
// message = JSON de LangChain { type: 'human' | 'ai' | 'tool', content, tool_calls? }) y wa_conversaciones (un renglon por telefono con su estado y la
// ultima escritura). Aqui solo se LEEN: no se modifican. Si las tablas no existen (otro ambiente) se contesta { disponible: false }.

const ACCIONES_AGENTE = {
  Autorizar_Reparacion: (a) => (a.autoriza === false ? 'Registró que el cliente NO autoriza' : 'Autorizó la reparación'),
  Consultar_Reparacion: () => 'Consultó el estado de la reparación',
  Buscar_Catalogo: () => 'Buscó en el catálogo',
  Consultar_Catalogo: () => 'Buscó en el catálogo',
  Apartar_Equipo: () => 'Apartó un equipo',
  Anotar_Pendiente: () => 'Anotó un pendiente',
  Registrar_Prospecto: () => 'Registró un prospecto',
  Consultar_Contacto: () => 'Consultó al cliente',
  Consultar_Negocio: () => 'Consultó horarios y políticas',
};

const aTexto = (v) => (typeof v === 'string' ? v : '');
const ultimosDiez = (tel) => String(tel ?? '').replace(/\D/g, '').slice(-10);

// El agente contesta en JSON: { output: { mensaje, etapa, equipoInteres, citaPropuesta, presupuesto, pendiente, enviarImagen, ... } }. El mensaje puede traer
// varias burbujas separadas por " || ". Si el contenido no es ese JSON se toma tal cual.
function leerRespuestaIA(contenido) {
  const crudo = aTexto(contenido).trim();
  if (!crudo) return null;
  let o = null;
  try {
    const j = JSON.parse(crudo);
    if (j && typeof j === 'object') o = j.output && typeof j.output === 'object' ? j.output : j;
  } catch {
    // no era JSON: es texto
  }
  const mensaje = o && typeof o.mensaje === 'string' ? o.mensaje : o ? '' : crudo;
  const burbujas = mensaje.split(/\s*\|\|\s*/).map((b) => b.trim()).filter(Boolean);
  const presupuesto = Number(o?.presupuesto);
  return {
    burbujas,
    imagen: o?.enviarImagen === true,
    meta: {
      etapa: aTexto(o?.etapa) || null,
      equipo_interes: aTexto(o?.equipoInteres) || null,
      cita: aTexto(o?.citaPropuesta) || null,
      presupuesto: presupuesto > 0 ? presupuesto : null,
      pendiente: aTexto(o?.pendiente) || null,
    },
  };
}

// Un renglon de wa_historial_chat -> lo que se muestra: lo que dijo el cliente, lo que contesto Michelle, o una accion que hizo (consultar, autorizar...).
// Los resultados de las herramientas ('tool') no se muestran.
function leerMensajeAgente(id, mensaje) {
  const tipo = mensaje?.type;
  if (tipo === 'human') {
    const texto = aTexto(mensaje.content).trim();
    return texto ? [{ id, remitente: 'cliente', texto }] : [];
  }
  if (tipo === 'ai') {
    if (Array.isArray(mensaje.tool_calls) && mensaje.tool_calls.length > 0) {
      return mensaje.tool_calls.map((c, i) => {
        const args = c?.args && typeof c.args === 'object' ? c.args : {};
        const nombre = aTexto(c?.name);
        const datos = [args.folio, Number(args.monto) > 0 ? `$${Number(args.monto)}` : null].filter(Boolean).join(' · ');
        return { id: `${id}-${i}`, remitente: 'accion', texto: (ACCIONES_AGENTE[nombre]?.(args) ?? nombre.replace(/_/g, ' ')) + (datos ? ` (${datos})` : '') };
      });
    }
    const r = leerRespuestaIA(mensaje.content);
    return r && r.burbujas.length > 0 ? [{ id, remitente: 'ia', burbujas: r.burbujas, imagen: r.imagen, meta: r.meta }] : [];
  }
  return [];
}

async function tablasAgente() {
  const { rows } = await pool.query(`SELECT to_regclass('wa_historial_chat') IS NOT NULL AS historial, to_regclass('wa_conversaciones') IS NOT NULL AS conversaciones`);
  return rows[0];
}

// Las conversaciones del agente, de la mas reciente a la mas vieja (hasta 200), con el cliente si el telefono coincide con alguno registrado.
router.get('/agente', async (req, res) => {
  const t = await tablasAgente();
  if (!t.historial) return res.json({ disponible: false, conversaciones: [] });

  const { rows } = await pool.query(
    `WITH base AS (
       SELECT session_id, max(id) AS ultimo_id, count(*)::int AS mensajes
       FROM wa_historial_chat GROUP BY session_id ORDER BY max(id) DESC LIMIT 200
     )
     SELECT b.session_id AS telefono, b.mensajes, b.ultimo_id, cl.id AS cliente_id, cl.nombre AS cliente_nombre,
            ult.message AS ultimo, ia.message AS ultima_ia,
            ${t.conversaciones ? 'wc.actualizado_en, wc.estado_actual' : 'NULL::timestamptz AS actualizado_en, NULL::text AS estado_actual'}
     FROM base b
     LEFT JOIN LATERAL (
       SELECT h.message::jsonb AS message FROM wa_historial_chat h
       WHERE h.session_id = b.session_id AND h.message::jsonb->>'type' IN ('human', 'ai')
         AND jsonb_typeof(h.message::jsonb->'content') = 'string' AND btrim(h.message::jsonb->>'content') <> ''
       ORDER BY h.id DESC LIMIT 1
     ) ult ON true
     LEFT JOIN LATERAL (
       SELECT h.message::jsonb AS message FROM wa_historial_chat h
       WHERE h.session_id = b.session_id AND h.message::jsonb->>'type' = 'ai' AND jsonb_typeof(h.message::jsonb->'content') = 'string'
       ORDER BY h.id DESC LIMIT 1
     ) ia ON true
     LEFT JOIN LATERAL (
       SELECT c.id, c.nombre FROM clientes c
       WHERE RIGHT(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = RIGHT(regexp_replace(b.session_id, '\\D', '', 'g'), 10)
          OR RIGHT(regexp_replace(c.telefono_adicional, '\\D', '', 'g'), 10) = RIGHT(regexp_replace(b.session_id, '\\D', '', 'g'), 10)
       ORDER BY c.created_at LIMIT 1
     ) cl ON true
     ${t.conversaciones ? 'LEFT JOIN wa_conversaciones wc ON wc.telefono = b.session_id' : ''}
     ORDER BY b.ultimo_id DESC`
  );

  const conversaciones = rows.map((r) => {
    const ultimo = leerMensajeAgente(r.ultimo_id, r.ultimo)[0] ?? null;
    return {
      telefono: r.telefono,
      cliente_id: r.cliente_id,
      cliente_nombre: r.cliente_nombre,
      mensajes: r.mensajes,
      actualizado_en: r.actualizado_en,
      estado_agente: r.estado_actual,
      ultimo_remitente: ultimo?.remitente ?? null,
      ultimo_mensaje: ultimo ? (ultimo.texto ?? ultimo.burbujas.join(' ')) : null,
      meta: leerRespuestaIA(aTexto(r.ultima_ia?.content))?.meta ?? null,
    };
  });
  res.json({ disponible: true, conversaciones });
});

// El chat completo de un telefono (los ultimos 400 mensajes), con lo que hizo el agente y los datos de su ultima respuesta (etapa, equipo de interes, cita...).
router.get('/agente/:telefono', async (req, res) => {
  const t = await tablasAgente();
  if (!t.historial) return res.status(404).json({ error: 'El historial del agente no está disponible en esta base.' });

  const telefono = String(req.params.telefono);
  const diez = ultimosDiez(telefono);
  if (diez.length !== 10) return res.status(400).json({ error: 'Teléfono inválido.' });

  // Con el telefono exacto (E.164) usa el indice de la tabla; si no coincide, busca por los ultimos 10 digitos.
  let { rows } = await pool.query(`SELECT id, session_id, message::jsonb AS message FROM wa_historial_chat WHERE session_id = $1 ORDER BY id DESC LIMIT 400`, [telefono]);
  if (rows.length === 0) {
    ({ rows } = await pool.query(
      `SELECT id, session_id, message::jsonb AS message FROM wa_historial_chat
       WHERE RIGHT(regexp_replace(session_id, '\\D', '', 'g'), 10) = $1 ORDER BY id DESC LIMIT 400`,
      [diez]
    ));
  }
  if (rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada.' });
  rows.reverse();

  const mensajes = rows.flatMap((r) => leerMensajeAgente(r.id, r.message));
  const ultimaIA = [...mensajes].reverse().find((m) => m.remitente === 'ia');

  const [cliente, estado] = await Promise.all([
    pool.query(
      `SELECT id, nombre FROM clientes
       WHERE RIGHT(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1 OR RIGHT(regexp_replace(telefono_adicional, '\\D', '', 'g'), 10) = $1
       ORDER BY created_at LIMIT 1`,
      [diez]
    ),
    t.conversaciones
      ? pool.query(`SELECT actualizado_en, estado_actual FROM wa_conversaciones WHERE telefono = $1`, [rows[0].session_id])
      : Promise.resolve({ rows: [] }),
  ]);

  res.json({
    telefono: rows[0].session_id,
    cliente: cliente.rows[0] ?? null,
    actualizado_en: estado.rows[0]?.actualizado_en ?? null,
    estado_agente: estado.rows[0]?.estado_actual ?? null,
    meta: ultimaIA?.meta ?? null,
    mensajes,
  });
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
