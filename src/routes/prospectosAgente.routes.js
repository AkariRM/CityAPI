const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { textoLimpio, fechaISO, UUID } = require('../utils/agente');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

// Prospectos del agente de WhatsApp (ver prospectoExterno.routes.js) para el personal: ver quien escribio, lo que busca y a quien
// darle seguimiento, y ajustarlo a mano (estado, fecha de seguimiento, notas).

const ESTADOS = ['nuevo', 'en_seguimiento', 'cerrado', 'descartado'];
const hoyMx = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
const COLUMNAS = `id, telefono, nombre, equipo_interes, presupuesto::float AS presupuesto, etapa, cita_propuesta, notas, estado,
                  to_char(seguimiento_para, 'YYYY-MM-DD') AS seguimiento_para, primer_contacto_at, ultimo_contacto_at,
                  (estado IN ('nuevo', 'en_seguimiento') AND seguimiento_para IS NOT NULL AND seguimiento_para <= $1::date) AS toca_seguimiento`;

// GET /prospectos-agente?estado=abiertos|nuevo|en_seguimiento|cerrado|descartado|todos&q=
router.get('/', async (req, res) => {
  const estado = req.query.estado === undefined ? 'abiertos' : String(req.query.estado);
  if (!['abiertos', 'todos', ...ESTADOS].includes(estado)) return res.status(400).json({ error: 'estado inválido.' });
  const q = textoLimpio(String(req.query.q ?? ''), 80);
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} FROM agente_prospectos
     WHERE ($2::text = 'todos' OR ($2::text = 'abiertos' AND estado IN ('nuevo', 'en_seguimiento')) OR estado = $2::text)
       AND ($3::text IS NULL OR nombre ILIKE '%' || $3 || '%' OR equipo_interes ILIKE '%' || $3 || '%' OR notas ILIKE '%' || $3 || '%'
            OR (regexp_replace($3, '\\D', '', 'g') <> '' AND telefono10 LIKE '%' || regexp_replace($3, '\\D', '', 'g') || '%'))
     ORDER BY (estado IN ('nuevo', 'en_seguimiento')) DESC, seguimiento_para NULLS LAST, ultimo_contacto_at DESC LIMIT 300`,
    [hoyMx(), estado, q]
  );
  res.json(rows);
});

router.get('/resumen', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE estado IN ('nuevo', 'en_seguimiento'))::int AS abiertos,
            count(*) FILTER (WHERE estado IN ('nuevo', 'en_seguimiento') AND seguimiento_para IS NOT NULL AND seguimiento_para <= $1::date)::int AS por_seguir
     FROM agente_prospectos`,
    [hoyMx()]
  );
  res.json(rows[0]);
});

// PATCH /prospectos-agente/:id   { estado?, seguimiento_para? (fecha o null), notas?, nombre?, equipo_interes? }
router.patch('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Prospecto no encontrado.' });
  const b = req.body ?? {};
  const sets = [];
  const valores = [];
  const poner = (columna, valor, cast = '') => { valores.push(valor); sets.push(`${columna} = $${valores.length}${cast}`); };

  if (b.estado !== undefined) {
    if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: `estado debe ser: ${ESTADOS.join(', ')}.` });
    poner('estado', b.estado);
    if (b.estado === 'cerrado' || b.estado === 'descartado') sets.push('seguimiento_para = NULL');
  }
  if (b.seguimiento_para !== undefined && !(b.estado === 'cerrado' || b.estado === 'descartado')) {
    if (b.seguimiento_para === null || b.seguimiento_para === '') sets.push('seguimiento_para = NULL');
    else {
      const f = fechaISO(b.seguimiento_para);
      if (!f) return res.status(400).json({ error: 'seguimiento_para debe ser una fecha YYYY-MM-DD.' });
      poner('seguimiento_para', f, '::date');
    }
  }
  if (b.notas !== undefined) {
    if (typeof b.notas !== 'string' || b.notas.length > 4000) return res.status(400).json({ error: 'notas debe ser un texto de máximo 4000 caracteres.' });
    poner('notas', b.notas.trim() || null);
  }
  if (b.nombre !== undefined) poner('nombre', textoLimpio(b.nombre, 120));
  if (b.equipo_interes !== undefined) poner('equipo_interes', textoLimpio(b.equipo_interes, 120));
  if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });

  valores.push(req.params.id);
  const { rowCount } = await pool.query(`UPDATE agente_prospectos SET ${sets.join(', ')} WHERE id = $${valores.length}`, valores);
  if (rowCount === 0) return res.status(404).json({ error: 'Prospecto no encontrado.' });
  // COLUMNAS usa $1 para la fecha de hoy, por eso se lee en una consulta aparte.
  const { rows } = await pool.query(`SELECT ${COLUMNAS} FROM agente_prospectos WHERE id = $2`, [hoyMx(), req.params.id]);
  res.json(rows[0]);
});

module.exports = router;
