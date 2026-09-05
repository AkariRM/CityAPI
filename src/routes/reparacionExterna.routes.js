const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');

const router = express.Router();

// Traduce nuestro estado interno al vocabulario que pidio TRAI para el
// agente de WhatsApp — son nombres distintos a proposito (el agente no
// necesita saber que "esperando_autorizacion" y "reparacion" son ambos
// parte de lo que aqui llamamos informalmente "en proceso").
const ESTADO_EXTERNO = {
  recibido: 'recibido',
  diagnostico: 'en_diagnostico',
  esperando_autorizacion: 'esperando_autorizacion',
  reparacion: 'en_reparacion',
  listo: 'listo_para_recoger',
  entregado: 'entregado',
  cancelado: 'cancelado',
};

// El costo solo se le puede dar al cliente una vez que ya lo autorizo (es
// decir, el folio ya paso el paso "esperando_autorizacion") — antes de eso
// es una cotizacion sin confirmar y el agente tiene prohibido darla.
const ESTADOS_CON_COSTO_AUTORIZADO = new Set(['reparacion', 'listo', 'entregado']);

// GET /reparacion-externa?telefono=+523531234567   -> reparaciones abiertas de ese cliente
// GET /reparacion-externa?folio=REP-2026-0842      -> esa reparacion especifica (cualquier estado)
router.get('/', verificarSecreto, async (req, res) => {
  const { telefono, folio } = req.query;
  if (!telefono && !folio) {
    return res.status(400).json({ error: 'telefono o folio es requerido.' });
  }

  // Los telefonos guardados son a 10 digitos sin lada de pais (ej.
  // "3315875649"); el agente manda formato E.164 (ej. "+523531234567").
  // Se comparan solo los ultimos 10 digitos de cada lado para que ambos
  // formatos (con o sin +52, con o sin espacios/guiones) coincidan igual.
  const { rows } = await pool.query(
    `SELECT r.folio, r.estado, r.equipo_marca, r.equipo_modelo, r.problema_reportado,
            r.created_at, r.fecha_estimada_entrega, r.total, r.nota_para_cliente, s.nombre AS sucursal_nombre
     FROM reparaciones r
     JOIN clientes c ON c.id = r.cliente_id
     JOIN sucursales s ON s.id = r.sucursal_id
     WHERE ($1::text IS NULL OR r.folio = $1)
       AND ($2::text IS NULL OR RIGHT(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = RIGHT(regexp_replace($2, '\\D', '', 'g'), 10))
       AND ($1::text IS NOT NULL OR r.estado NOT IN ('entregado', 'cancelado'))
     ORDER BY r.created_at DESC`,
    [folio || null, telefono || null]
  );

  res.json(
    rows.map((r) => ({
      folio: r.folio,
      estado: ESTADO_EXTERNO[r.estado] ?? r.estado,
      equipo: [r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ') || null,
      falla_reportada: r.problema_reportado,
      fecha_ingreso: r.created_at,
      fecha_estimada_entrega: r.fecha_estimada_entrega,
      costo_autorizado: ESTADOS_CON_COSTO_AUTORIZADO.has(r.estado) ? Number(r.total) : null,
      requiere_autorizacion: r.estado === 'esperando_autorizacion',
      sucursal: r.sucursal_nombre,
      nota_para_cliente: r.nota_para_cliente || null,
    }))
  );
});

module.exports = router;
