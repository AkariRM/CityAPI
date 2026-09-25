const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');

const router = express.Router();

router.use(requireAuth);

// Apartados del agente de WhatsApp: rango permitido de cada ajuste (el mismo CHECK que
// tiene la tabla, para responder 400 con un mensaje claro en vez de un error de la BD).
const LIMITES_AGENTE = {
  agente_apartado_horas: { min: 1, max: 720, texto: 'Las horas de apartado' },
  agente_apartado_max_por_telefono: { min: 1, max: 10, texto: 'El máximo de apartados por teléfono' },
};

// Codigo que puede llevar la calcomania de equipo (igual que el CHECK de la tabla).
const CODIGOS_CALCOMANIA = ['barras', 'qr'];

// Cualquier rol autenticado puede LEER la configuracion (Equipos la
// necesita para saber si debe auto-imprimir el sticker al dar de alta un
// equipo, sin importar que rol lo esta registrando) -- solo modificarla
// sigue restringido a admin.
router.get('/', async (req, res) => {
  res.json(await obtenerConfiguracionTicket());
});

router.patch('/', requireRole('admin'), async (req, res) => {
  const actual = await obtenerConfiguracionTicket();

  const fields = {
    nombre_negocio: req.body?.nombre_negocio,
    mostrar_direccion: req.body?.mostrar_direccion,
    mostrar_telefono: req.body?.mostrar_telefono,
    mostrar_vendedor: req.body?.mostrar_vendedor,
    mostrar_cliente: req.body?.mostrar_cliente,
    mensaje_pie: req.body?.mensaje_pie,
    imprimir_sticker_auto_equipo: req.body?.imprimir_sticker_auto_equipo,
    imprimir_recibo_auto_reparacion: req.body?.imprimir_recibo_auto_reparacion,
    reactivacion_catalogo_automatica: req.body?.reactivacion_catalogo_automatica,
    bloquear_entrega_con_saldo: req.body?.bloquear_entrega_con_saldo,
    pieza_externa_requiere_catalogo: req.body?.pieza_externa_requiere_catalogo,
    agente_apartado_horas: req.body?.agente_apartado_horas,
    agente_apartado_max_por_telefono: req.body?.agente_apartado_max_por_telefono,
    calcomania_equipo_codigo: req.body?.calcomania_equipo_codigo,
  };
  if (fields.calcomania_equipo_codigo !== undefined && !CODIGOS_CALCOMANIA.includes(fields.calcomania_equipo_codigo)) {
    return res.status(400).json({ error: "El código de la calcomanía debe ser 'barras' o 'qr'." });
  }
  for (const [campo, { min, max, texto }] of Object.entries(LIMITES_AGENTE)) {
    const v = fields[campo];
    if (v !== undefined && !(Number.isInteger(v) && v >= min && v <= max)) {
      return res.status(400).json({ error: `${texto} debe ser un número entero entre ${min} y ${max}.` });
    }
  }
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

  values.push(actual.id);
  const { rows } = await pool.query(
    `UPDATE configuracion_ticket SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  res.json(rows[0]);
});

module.exports = router;
