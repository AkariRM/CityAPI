const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');
const { ultimosDiezDigitos, textoLimpio, identificarContacto, fechaISO } = require('../utils/agente');

const router = express.Router();

// Prospectos del agente de WhatsApp (TRAI): personas que escribieron y todavia no son clientes. Lo que buscan, su presupuesto, la
// cita que propusieron y cuando darles seguimiento. El personal los ve en la app (Agente > Prospectos).
//
// POST /prospecto-externo
//   { telefono, nombre?, equipo_interes?, presupuesto?, etapa?, cita_propuesta?, nota?, seguimiento_para? ("YYYY-MM-DD") }
//   Crea al prospecto o actualiza el que ya existe con ese telefono: lo que viene vacio no borra lo que ya habia, la nota se
//   agrega al historial de notas (con la fecha) y se anota el ultimo contacto. Si el telefono ya es de un cliente o del personal
//   no se registra ("registrado": false) para no duplicar a quien ya se conoce.
// GET /prospecto-externo?seguimiento=pendiente|todos
//   pendiente (por defecto): los que ya toca darles seguimiento (seguimiento_para de hoy o antes, sin cerrar ni descartar).
// POST /prospecto-externo/seguimiento
//   { telefono, resultado: "contactado" | "sin_respuesta" | "interesado" | "cerrado" | "descartado", nota?, proximo? ("YYYY-MM-DD") }
//   Anota que ya se le dio seguimiento. cerrado / descartado cierran al prospecto; los demas lo dejan "en seguimiento" para la
//   fecha "proximo" (o sin fecha).

const hoyMx = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
const COLUMNAS = `id, telefono, nombre, equipo_interes, presupuesto::float AS presupuesto, etapa, cita_propuesta, notas, estado,
                  to_char(seguimiento_para, 'YYYY-MM-DD') AS seguimiento_para, primer_contacto_at, ultimo_contacto_at`;

function presupuestoValido(valor) {
  if (valor === undefined || valor === null || valor === '') return { ok: true, valor: null };
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? { ok: true, valor: n } : { ok: false };
}

router.post('/', verificarSecreto, async (req, res) => {
  const b = req.body ?? {};
  const telefono10 = ultimosDiezDigitos(b.telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  const presupuesto = presupuestoValido(b.presupuesto);
  if (!presupuesto.ok) return res.status(400).json({ error: 'presupuesto debe ser un número mayor o igual a 0.' });
  const seguimiento = b.seguimiento_para === undefined || b.seguimiento_para === null || b.seguimiento_para === '' ? null : fechaISO(b.seguimiento_para);
  if (b.seguimiento_para && !seguimiento) return res.status(400).json({ error: 'seguimiento_para debe ser una fecha YYYY-MM-DD.' });

  const contacto = await identificarContacto(pool, telefono10);
  if (contacto && contacto.tipo !== 'prospecto') {
    return res.json({ registrado: false, motivo: contacto.tipo, ...(contacto.tipo === 'cliente' ? { cliente_id: contacto.id } : {}) });
  }

  const nota = textoLimpio(b.nota, 500);
  const { rows } = await pool.query(
    `INSERT INTO agente_prospectos (telefono, telefono10, nombre, equipo_interes, presupuesto, etapa, cita_propuesta, notas, seguimiento_para, estado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, CASE WHEN $9::date IS NOT NULL THEN 'en_seguimiento' ELSE 'nuevo' END)
     ON CONFLICT (telefono10) DO UPDATE SET
       telefono = EXCLUDED.telefono,
       nombre = COALESCE(EXCLUDED.nombre, agente_prospectos.nombre),
       equipo_interes = COALESCE(EXCLUDED.equipo_interes, agente_prospectos.equipo_interes),
       presupuesto = COALESCE(EXCLUDED.presupuesto, agente_prospectos.presupuesto),
       etapa = COALESCE(EXCLUDED.etapa, agente_prospectos.etapa),
       cita_propuesta = COALESCE(EXCLUDED.cita_propuesta, agente_prospectos.cita_propuesta),
       notas = CASE WHEN EXCLUDED.notas IS NULL THEN agente_prospectos.notas
                    WHEN agente_prospectos.notas IS NULL THEN EXCLUDED.notas
                    ELSE right(agente_prospectos.notas || E'\\n' || EXCLUDED.notas, 4000) END,
       seguimiento_para = COALESCE(EXCLUDED.seguimiento_para, agente_prospectos.seguimiento_para),
       estado = CASE WHEN EXCLUDED.seguimiento_para IS NOT NULL AND agente_prospectos.estado = 'nuevo' THEN 'en_seguimiento' ELSE agente_prospectos.estado END,
       ultimo_contacto_at = now()
     RETURNING ${COLUMNAS}, (xmax = 0) AS creado`,
    [
      textoLimpio(String(b.telefono), 30), telefono10, textoLimpio(b.nombre, 120), textoLimpio(b.equipo_interes, 120), presupuesto.valor,
      textoLimpio(b.etapa, 40), textoLimpio(b.cita_propuesta, 80), nota ? `[${hoyMx()}] ${nota}` : null, seguimiento,
    ]
  );
  const { creado, ...prospecto } = rows[0];
  res.status(creado ? 201 : 200).json({ registrado: true, creado, ...prospecto });
});

router.get('/', verificarSecreto, async (req, res) => {
  const modo = req.query.seguimiento === undefined ? 'pendiente' : String(req.query.seguimiento);
  if (!['pendiente', 'todos'].includes(modo)) return res.status(400).json({ error: 'seguimiento debe ser pendiente o todos.' });
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} FROM agente_prospectos
     WHERE estado IN ('nuevo', 'en_seguimiento') AND ($1::text = 'todos' OR (seguimiento_para IS NOT NULL AND seguimiento_para <= $2::date))
     ORDER BY seguimiento_para NULLS LAST, ultimo_contacto_at DESC LIMIT 200`,
    [modo, hoyMx()]
  );
  res.json(rows);
});

const RESULTADOS = ['contactado', 'sin_respuesta', 'interesado', 'cerrado', 'descartado'];

router.post('/seguimiento', verificarSecreto, async (req, res) => {
  const b = req.body ?? {};
  const telefono10 = ultimosDiezDigitos(b.telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  if (!RESULTADOS.includes(b.resultado)) return res.status(400).json({ error: `resultado debe ser: ${RESULTADOS.join(', ')}.` });
  const proximo = b.proximo === undefined || b.proximo === null || b.proximo === '' ? null : fechaISO(b.proximo);
  if (b.proximo && !proximo) return res.status(400).json({ error: 'proximo debe ser una fecha YYYY-MM-DD.' });

  const cierra = b.resultado === 'cerrado' || b.resultado === 'descartado';
  const nota = textoLimpio(b.nota, 500);
  const { rows } = await pool.query(
    `UPDATE agente_prospectos SET
       estado = CASE WHEN $2::text = 'cerrado' THEN 'cerrado' WHEN $2 = 'descartado' THEN 'descartado' ELSE 'en_seguimiento' END,
       seguimiento_para = CASE WHEN $3::boolean THEN NULL ELSE $4::date END,
       ultimo_contacto_at = CASE WHEN $2 IN ('contactado', 'interesado') THEN now() ELSE ultimo_contacto_at END,
       notas = CASE WHEN $5::text IS NULL THEN notas WHEN notas IS NULL THEN $5 ELSE right(notas || E'\\n' || $5, 4000) END
     WHERE telefono10 = $1 RETURNING ${COLUMNAS}`,
    [telefono10, b.resultado, cierra, proximo, nota ? `[${hoyMx()}] Seguimiento (${b.resultado}): ${nota}` : null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Prospecto no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
