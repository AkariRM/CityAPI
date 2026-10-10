const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');

const router = express.Router();

// GET /contacto-externo?telefono=+523531234567
// Identifica quien escribe por WhatsApp: personal de CityCorp (cualquier
// rol, cualquier empresa, mientras siga activo) o cliente registrado de
// CityPhone. Devuelve 404 si no hay coincidencia — es el caso esperado para
// alguien nuevo, no un error.
//
// El telefono se normaliza a los ultimos 10 digitos en ambos lados de la
// comparacion: WhatsApp manda E.164 ("+52..."), pero aqui se captura en
// texto libre (con o sin espacios/guiones, con o sin codigo de pais).
router.get('/', verificarSecreto, async (req, res) => {
  const telefono = String(req.query.telefono ?? '').replace(/\D/g, '').slice(-10);
  if (telefono.length !== 10) {
    return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  }

  const staff = await pool.query(
    `SELECT id, nombre, rol, telefono, sucursal_id FROM usuarios
     WHERE activo = true AND right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
     LIMIT 1`,
    [telefono]
  );
  if (staff.rows[0]) {
    const u = staff.rows[0];
    return res.json({ id: u.id, nombre: u.nombre, rol: u.rol, telefono: u.telefono, sucursal_id: u.sucursal_id });
  }

  // Coincide con el telefono principal O con el adicional. Dos clientes pueden
  // compartir un numero (familiares): se prefiere el que lo tiene como principal
  // y luego el mas antiguo, para que la respuesta no cambie de una llamada a otra.
  const cliente = await pool.query(
    `SELECT id, nombre, telefono, sucursal_id FROM clientes
     WHERE right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
        OR right(regexp_replace(telefono_adicional, '\\D', '', 'g'), 10) = $1
     ORDER BY (right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1) DESC NULLS LAST, created_at ASC
     LIMIT 1`,
    [telefono]
  );
  if (cliente.rows[0]) {
    const c = cliente.rows[0];

    // Opcionales que pidio TRAI: ultima compra (para personalizar el
    // saludo) y folio de reparacion en curso (cualquier estado que no sea
    // 'entregado'). El agente funciona igual si vienen null.
    const [ultimaCompra, ticketAbierto, compras, garantias, notas] = await Promise.all([
      pool.query(`SELECT max(created_at) AS fecha FROM ventas WHERE cliente_id = $1`, [c.id]),
      pool.query(
        `SELECT folio FROM reparaciones
         WHERE cliente_id = $1 AND estado <> 'entregado'
         ORDER BY created_at DESC LIMIT 1`,
        [c.id]
      ),
      // Ultimas 5 compras (ventas completadas) con lo que se llevo. Sin costos, IMEI ni vendedor: el agente no los menciona.
      pool.query(
        `SELECT v.folio, to_char(v.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS fecha, v.total::float AS total,
                (SELECT COALESCE(json_agg(json_build_object('nombre', p.nombre, 'cantidad', vi.cantidad) ORDER BY p.nombre), '[]'::json)
                 FROM venta_items vi JOIN productos p ON p.id = vi.producto_id WHERE vi.venta_id = v.id) AS articulos
         FROM ventas v WHERE v.cliente_id = $1 AND v.estado = 'completada' ORDER BY v.created_at DESC LIMIT 5`,
        [c.id]
      ),
      // Garantia de sus reparaciones entregadas: dias, desde cuando corre (la entrega) y hasta cuando vale.
      pool.query(
        `SELECT folio, equipo, garantia_dias, to_char(entregado, 'YYYY-MM-DD') AS entregado, to_char(entregado + garantia_dias, 'YYYY-MM-DD') AS vence,
                (entregado + garantia_dias >= (now() AT TIME ZONE 'America/Mexico_City')::date) AS vigente
         FROM (
           SELECT r.folio, trim(concat_ws(' ', r.equipo_marca, r.equipo_modelo)) AS equipo, r.garantia_dias,
                  (SELECT (max(h.created_at) AT TIME ZONE 'America/Mexico_City')::date FROM reparacion_historial h WHERE h.reparacion_id = r.id AND h.estado = 'entregado') AS entregado
           FROM reparaciones r WHERE r.cliente_id = $1 AND r.estado = 'entregado' AND r.garantia_dias > 0
         ) g WHERE entregado IS NOT NULL ORDER BY entregado DESC LIMIT 5`,
        [c.id]
      ),
      // Solo las notas que dejo el propio agente: las notas internas del personal (clientes.notas) NO se comparten.
      pool.query(
        `SELECT to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS fecha, texto
         FROM cliente_notas_agente WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [c.id]
      ),
    ]);

    return res.json({
      id: c.id,
      nombre: c.nombre,
      rol: 'cliente',
      telefono: c.telefono,
      sucursal_id: c.sucursal_id,
      ultima_compra: ultimaCompra.rows[0]?.fecha ?? null,
      ticket_abierto: ticketAbierto.rows[0]?.folio ?? null,
      compras: compras.rows,
      garantias_reparacion: garantias.rows,
      notas_agente: notas.rows,
    });
  }

  res.status(404).json({ error: 'Contacto no encontrado.' });
});

// POST /contacto-externo/nota   { telefono, nota }
// El agente deja una nota de un CLIENTE (sus gustos, lo que le interesa, lo que quedo pendiente). Se agrega al historial de notas del
// cliente y vuelve en GET /contacto-externo como notas_agente. De un prospecto se anota en POST /prospecto-externo. Solo agrega: no
// edita ni borra notas, y no toca las notas internas del personal.
router.post('/nota', verificarSecreto, async (req, res) => {
  const telefono = String(req.body?.telefono ?? '').replace(/\D/g, '').slice(-10);
  if (telefono.length !== 10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  const texto = typeof req.body?.nota === 'string' ? req.body.nota.replace(/\s+/g, ' ').trim() : '';
  if (!texto) return res.status(400).json({ error: 'nota es requerida.' });
  if (texto.length > 500) return res.status(400).json({ error: 'nota debe tener máximo 500 caracteres.' });

  const cliente = await pool.query(
    `SELECT c.id FROM clientes c
     WHERE (right(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = $1 OR right(regexp_replace(c.telefono_adicional, '\\D', '', 'g'), 10) = $1)
       AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.activo = true AND right(regexp_replace(u.telefono, '\\D', '', 'g'), 10) = $1)
     ORDER BY (right(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = $1) DESC NULLS LAST, c.created_at ASC LIMIT 1`,
    [telefono]
  );
  if (!cliente.rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
  const { rows } = await pool.query(
    `INSERT INTO cliente_notas_agente (cliente_id, texto) VALUES ($1, $2) RETURNING id, to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS fecha`,
    [cliente.rows[0].id, texto]
  );
  res.status(201).json({ id: rows[0].id, fecha: rows[0].fecha, cliente_id: cliente.rows[0].id });
});

module.exports = router;
