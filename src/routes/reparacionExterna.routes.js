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

// La cotizacion (monto_cotizado / descripcion_cotizacion) solo se expone mientras
// el cliente todavia no la autoriza; despues de eso el monto es costo_autorizado.
const ESTADO_PARA_COTIZAR = 'esperando_autorizacion';

// Solo tiene sentido hablar de "tiempo restante" mientras el equipo sigue en
// manos del taller -- de "listo" en adelante ya no hay nada que esperar.
const ESTADOS_CON_TIEMPO_RESTANTE = new Set(['recibido', 'diagnostico', 'esperando_autorizacion', 'reparacion']);

// GET /reparacion-externa?telefono=+523531234567   -> reparaciones abiertas de ese cliente
// GET /reparacion-externa?folio=REP-2026-0842      -> esa reparacion especifica (cualquier estado)
router.get('/', verificarSecreto, async (req, res) => {
  const { telefono, folio } = req.query;
  if (!telefono && !folio) {
    return res.status(400).json({ error: 'telefono o folio es requerido.' });
  }
  // Solo los ultimos 10 digitos cuentan. Un telefono sin digitos suficientes se
  // rechaza: sin esto, "abc" se comparaba contra cadenas vacias y podia empatar
  // con clientes sin telefono.
  const telefono10 = telefono ? String(telefono).replace(/\D/g, '').slice(-10) : null;
  if (telefono && telefono10.length !== 10) {
    return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  }

  // Los telefonos guardados son a 10 digitos sin lada de pais (ej.
  // "3315875649"); el agente manda formato E.164 (ej. "+523531234567").
  // Se comparan solo los ultimos 10 digitos de cada lado para que ambos
  // formatos (con o sin +52, con o sin espacios/guiones) coincidan igual.
  // dias_restantes: fecha_estimada_entrega se guarda como el dia elegido a
  // medianoche UTC (asi la escribe/lee la app), y "hoy" se toma en hora de
  // Mexico -- comparar ambos como fechas evita el desfase de un dia. Negativo
  // = ya va atrasada.
  const { rows } = await pool.query(
    `SELECT r.id, r.folio, r.estado, r.equipo_marca, r.equipo_modelo, r.problema_reportado,
            r.created_at, r.fecha_estimada_entrega, r.total, r.nota_para_cliente, s.nombre AS sucursal_nombre,
            ((r.fecha_estimada_entrega AT TIME ZONE 'UTC')::date - (now() AT TIME ZONE 'America/Mexico_City')::date) AS dias_restantes
     FROM reparaciones r
     JOIN clientes c ON c.id = r.cliente_id
     JOIN sucursales s ON s.id = r.sucursal_id
     WHERE ($1::text IS NULL OR r.folio = $1)
       AND ($2::text IS NULL
            OR RIGHT(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = $2
            OR RIGHT(regexp_replace(c.telefono_adicional, '\\D', '', 'g'), 10) = $2)
       AND ($1::text IS NOT NULL OR r.estado NOT IN ('entregado', 'cancelado'))
     ORDER BY r.created_at DESC`,
    [folio || null, telefono10]
  );

  // Fotos del ESTADO ACTUAL de cada folio (una sola consulta para todos,
  // en el orden en que se subieron) -- las de estados anteriores no se
  // mandan: el cliente pregunta "como va", no "como iba".
  const fotosPorFolio = new Map();
  if (rows.length > 0) {
    const fotos = await pool.query(
      `SELECT f.reparacion_id, f.url
       FROM reparacion_fotos f
       JOIN reparaciones r ON r.id = f.reparacion_id AND r.estado = f.estado
       WHERE f.reparacion_id = ANY($1::uuid[])
       ORDER BY f.created_at ASC`,
      [rows.map((r) => r.id)]
    );
    for (const f of fotos.rows) {
      if (!fotosPorFolio.has(f.reparacion_id)) fotosPorFolio.set(f.reparacion_id, []);
      fotosPorFolio.get(f.reparacion_id).push(f.url);
    }
  }

  res.json(
    rows.map((r) => ({
      folio: r.folio,
      estado: ESTADO_EXTERNO[r.estado] ?? r.estado,
      equipo: [r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ') || null,
      falla_reportada: r.problema_reportado,
      fecha_ingreso: r.created_at,
      fecha_estimada_entrega: r.fecha_estimada_entrega,
      dias_restantes: ESTADOS_CON_TIEMPO_RESTANTE.has(r.estado) && r.dias_restantes != null ? Number(r.dias_restantes) : null,
      costo_autorizado: ESTADOS_CON_COSTO_AUTORIZADO.has(r.estado) ? Number(r.total) : null,
      requiere_autorizacion: r.estado === 'esperando_autorizacion',
      // Total actual del folio, sin desglose. Null si todavia no hay monto (total en
      // cero): en ese caso el agente no debe dar ninguna cifra.
      monto_cotizado: r.estado === ESTADO_PARA_COTIZAR && Number(r.total) > 0 ? Number(r.total) : null,
      // Sale de "Nota para el cliente" (texto que el personal escribe para el
      // cliente, nunca notas internas). Null si esta vacia.
      descripcion_cotizacion: r.estado === ESTADO_PARA_COTIZAR ? r.nota_para_cliente || null : null,
      sucursal: r.sucursal_nombre,
      nota_para_cliente: r.nota_para_cliente || null,
      fotos_estado_actual: fotosPorFolio.get(r.id) ?? [],
    }))
  );
});

module.exports = router;
