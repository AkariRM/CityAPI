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
// El estado que se le informa al cliente: un equipo marcado "listo" que todavia no regresa del taller
// a la sucursal sigue "en reparacion" (no se puede recoger todavia).
const estadoParaCliente = (r) => (r.estado === 'listo' && r.ubicacion !== 'sucursal' ? 'reparacion' : r.estado);

const ESTADOS_CON_TIEMPO_RESTANTE = new Set(['recibido', 'diagnostico', 'esperando_autorizacion', 'reparacion']);

// Solo los ultimos 10 digitos cuentan (los telefonos guardados son a 10
// digitos sin lada; el agente manda E.164 con o sin espacios/guiones). Devuelve
// null si el valor no trae 10 digitos: sin esto, "abc" se comparaba contra
// cadenas vacias y podia empatar con clientes sin telefono.
function ultimosDiezDigitos(telefono) {
  const digitos = String(telefono ?? '').replace(/\D/g, '').slice(-10);
  return digitos.length === 10 ? digitos : null;
}

// Condicion SQL: el telefono es el principal O el adicional del cliente. $N es
// el telefono ya normalizado a 10 digitos.
function coincideTelefono(n) {
  return `(RIGHT(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = $${n}
            OR RIGHT(regexp_replace(c.telefono_adicional, '\\D', '', 'g'), 10) = $${n})`;
}

// Misma cuenta en dinero (centavos) para no comparar decimales flotantes.
const centavos = (n) => Math.round(Number(n) * 100);

// Lectura compartida por GET y por POST /autorizar (que responde el mismo
// objeto que el GET, ya actualizado). folio y/o telefono10 (10 digitos).
// dias_restantes: fecha_estimada_entrega se guarda como el dia elegido a
// medianoche UTC (asi la escribe/lee la app), y "hoy" se toma en hora de
// Mexico -- comparar ambos como fechas evita el desfase de un dia. Negativo
// = ya va atrasada.
async function consultarReparaciones(db, { folio, telefono10 }) {
  const { rows } = await db.query(
    `SELECT r.id, r.folio, r.estado, r.ubicacion, r.equipo_marca, r.equipo_modelo, r.problema_reportado,
            r.created_at, r.fecha_estimada_entrega, r.total, r.nota_para_cliente, s.nombre AS sucursal_nombre,
            (r.cotizacion_rechazada_at IS NOT NULL AND r.cotizacion_rechazada_monto = r.total) AS rechazo_vigente,
            ((r.fecha_estimada_entrega AT TIME ZONE 'UTC')::date - (now() AT TIME ZONE 'America/Mexico_City')::date) AS dias_restantes
     FROM reparaciones r
     JOIN clientes c ON c.id = r.cliente_id
     JOIN sucursales s ON s.id = r.sucursal_id
     WHERE ($1::text IS NULL OR r.folio = $1)
       AND ($2::text IS NULL OR ${coincideTelefono(2)})
       AND ($1::text IS NOT NULL OR r.estado NOT IN ('entregado', 'cancelado'))
     ORDER BY r.created_at DESC`,
    [folio || null, telefono10]
  );

  // Fotos del ESTADO ACTUAL de cada folio (una sola consulta para todos,
  // en el orden en que se subieron) -- las de estados anteriores no se
  // mandan: el cliente pregunta "como va", no "como iba".
  const fotosPorFolio = new Map();
  if (rows.length > 0) {
    const fotos = await db.query(
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

  return rows.map((r) => ({
    folio: r.folio,
    estado: ESTADO_EXTERNO[estadoParaCliente(r)] ?? estadoParaCliente(r),
    equipo: [r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ') || null,
    falla_reportada: r.problema_reportado,
    fecha_ingreso: r.created_at,
    fecha_estimada_entrega: r.fecha_estimada_entrega,
    dias_restantes: ESTADOS_CON_TIEMPO_RESTANTE.has(estadoParaCliente(r)) && r.dias_restantes != null ? Number(r.dias_restantes) : null,
    costo_autorizado: ESTADOS_CON_COSTO_AUTORIZADO.has(estadoParaCliente(r)) ? Number(r.total) : null,
    requiere_autorizacion: r.estado === 'esperando_autorizacion',
    // Total actual del folio, sin desglose. Null si todavia no hay monto (total en
    // cero): en ese caso el agente no debe dar ninguna cifra.
    monto_cotizado: r.estado === ESTADO_PARA_COTIZAR && Number(r.total) > 0 ? Number(r.total) : null,
    // Sale de "Nota para el cliente" (texto que el personal escribe para el
    // cliente, nunca notas internas). Null si esta vacia.
    descripcion_cotizacion: r.estado === ESTADO_PARA_COTIZAR ? r.nota_para_cliente || null : null,
    // true si el cliente ya dijo que NO autoriza esta cotizacion (por
    // POST /autorizar con autoriza=false) y nadie la ha cambiado desde entonces:
    // el agente no debe volver a pedirle que autorice, solo avisar que un asesor
    // le dara seguimiento.
    cotizacion_rechazada: r.estado === ESTADO_PARA_COTIZAR && r.rechazo_vigente === true,
    sucursal: r.sucursal_nombre,
    nota_para_cliente: r.nota_para_cliente || null,
    fotos_estado_actual: fotosPorFolio.get(r.id) ?? [],
  }));
}

// GET /reparacion-externa?telefono=+523531234567   -> reparaciones abiertas de ese cliente
// GET /reparacion-externa?folio=R-000012           -> esa reparacion especifica (cualquier estado)
router.get('/', verificarSecreto, async (req, res) => {
  const { telefono, folio } = req.query;
  if (!telefono && !folio) {
    return res.status(400).json({ error: 'telefono o folio es requerido.' });
  }
  const telefono10 = telefono ? ultimosDiezDigitos(telefono) : null;
  if (telefono && !telefono10) {
    return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  }
  res.json(await consultarReparaciones(pool, { folio, telefono10 }));
});

// POST /reparacion-externa/autorizar
//   { "folio": "R-000012", "telefono": "+523531234567", "autoriza": true, "monto": 1850 }
//
// El cliente autoriza (o rechaza) por WhatsApp la cotizacion de su folio. Escribe
// en la base, asi que su seguridad NO descansa solo en el secreto compartido:
//  - hay que mandar el telefono del dueño del folio (principal o adicional); si
//    no coincide es igual que si el folio no existiera (404);
//  - para autorizar hay que confirmar el monto que se le dijo al cliente: si el
//    personal la cambio mientras tanto, no se autoriza (409);
//  - solo actua sobre folios en esperando_autorizacion;
//  - se puede apagar al instante: solo funciona con AGENTE_AUTORIZAR_ACTIVO=true.
//
// autoriza=true  -> el folio pasa a "reparacion" (en_reparacion) y queda fijo el monto.
// autoriza=false -> el folio NO cambia de estado: queda una nota en el historial y
//                   la marca cotizacion_rechazada; el personal decide si cancela o
//                   renegocia (lo ve en el panel y en el detalle del folio).
// Es idempotente: repetir la misma llamada no duplica nada.
router.post('/autorizar', verificarSecreto, async (req, res) => {
  if (process.env.AGENTE_AUTORIZAR_ACTIVO !== 'true') {
    return res.status(503).json({ error: 'La autorización por WhatsApp está desactivada.' });
  }

  const { folio, telefono, autoriza, monto } = req.body ?? {};
  if (typeof folio !== 'string' || !folio.trim()) return res.status(400).json({ error: 'folio es requerido.' });
  const telefono10 = ultimosDiezDigitos(telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  if (typeof autoriza !== 'boolean') return res.status(400).json({ error: 'autoriza debe ser true o false.' });
  let montoConfirmado = null;
  if (autoriza) {
    const valido = (typeof monto === 'number' || (typeof monto === 'string' && monto.trim() !== '')) && Number(monto) > 0;
    if (!valido) {
      return res.status(400).json({ error: 'monto es requerido cuando autoriza es true: es el monto que se le dijo al cliente.' });
    }
    montoConfirmado = Number(monto);
  }

  // Respuesta de conflicto: mensaje + el estado actual del folio, para que el agente
  // pueda decirle al cliente lo que de verdad hay.
  const conflicto = async (mensaje) => {
    const [actual] = await consultarReparaciones(pool, { folio: folio.trim(), telefono10 });
    return res.status(409).json({ error: mensaje, reparacion: actual ?? null });
  };
  const dinero = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const client = await pool.connect();
  let aviso = null; // mensaje de conflicto, se responde despues de soltar la conexion
  try {
    await client.query('BEGIN');
    // FOR UPDATE: dos llamadas simultaneas (reintentos) se vuelven una despues de otra.
    const { rows } = await client.query(
      `SELECT r.id, r.estado, r.total, r.cotizacion_rechazada_at, r.cotizacion_rechazada_monto
       FROM reparaciones r
       JOIN clientes c ON c.id = r.cliente_id
       WHERE r.folio = $1 AND ${coincideTelefono(2)}
       FOR UPDATE OF r`,
      [folio.trim(), telefono10]
    );
    const r = rows[0];
    if (!r) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reparación no encontrada.' });
    }

    const total = Number(r.total);
    const rechazoVigente = r.cotizacion_rechazada_at != null && centavos(r.cotizacion_rechazada_monto) === centavos(total);

    if (autoriza) {
      if (r.estado === ESTADO_PARA_COTIZAR) {
        if (!(total > 0)) aviso = 'Este folio todavía no tiene una cotización.';
        else if (centavos(montoConfirmado) !== centavos(total)) {
          aviso = `La cotización cambió: ahora es de ${dinero(total)}. Vuelve a confirmarla con el cliente.`;
        } else {
          await client.query(
            `UPDATE reparaciones SET estado = 'reparacion', cotizacion_rechazada_at = NULL, cotizacion_rechazada_monto = NULL WHERE id = $1`,
            [r.id]
          );
          await client.query(
            `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id) VALUES ($1, 'reparacion', $2, NULL)`,
            [r.id, `Autorizado por el cliente por WhatsApp (${dinero(total)}).`]
          );
        }
      } else if (r.estado === 'reparacion') {
        // Ya estaba autorizado: con el mismo monto es un reintento (no se escribe nada).
        if (centavos(montoConfirmado) !== centavos(total)) aviso = `Este folio ya está autorizado por ${dinero(total)}.`;
      } else {
        aviso = `Este folio no está esperando autorización (estado actual: ${ESTADO_EXTERNO[r.estado] ?? r.estado}).`;
      }
    } else if (r.estado === ESTADO_PARA_COTIZAR) {
      if (!(total > 0)) aviso = 'Este folio todavía no tiene una cotización.';
      else if (!rechazoVigente) {
        await client.query(`UPDATE reparaciones SET cotizacion_rechazada_at = now(), cotizacion_rechazada_monto = $2 WHERE id = $1`, [r.id, total]);
        await client.query(
          `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id) VALUES ($1, 'esperando_autorizacion', $2, NULL)`,
          [r.id, `El cliente indicó por WhatsApp que NO autoriza la cotización (${dinero(total)}). Requiere seguimiento del personal.`]
        );
      }
      // Si ya estaba rechazada con este mismo monto: reintento, no se duplica la nota.
    } else if (r.estado === 'reparacion') {
      aviso = 'Este folio ya está autorizado. Cualquier cancelación la atiende un asesor.';
    } else {
      aviso = `Este folio no está esperando autorización (estado actual: ${ESTADO_EXTERNO[r.estado] ?? r.estado}).`;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }

  if (aviso) return conflicto(aviso);
  const [actualizada] = await consultarReparaciones(pool, { folio: folio.trim(), telefono10 });
  res.json(actualizada);
});

module.exports = router;
