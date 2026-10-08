const { llamarWebhookN8n } = require('./n8n');

// Avisos al cliente por cada fase de una reparacion (cotizacion, reparada, lista en tienda). Reusan el webhook de
// notificaciones de n8n que ya existe (N8N_WEBHOOK_NOTIFICAR_CLIENTE, ver CityPhone_Guia_Integracion_n8n.txt B6): el
// servidor manda el aviso con el telefono registrado del cliente y n8n lo redacta y lo manda por WhatsApp.
//
// Un aviso que falla NUNCA tumba el cambio de fase: el folio ya avanzo. Se registra en notificaciones_cliente y quien
// hizo el cambio recibe el resultado para poder avisarle al cliente por su cuenta.

const dinero = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// n8n exige E.164: 10 digitos -> +52, mas de 10 se toman tal cual con "+". Menos de 10 no sirve.
function telefonoE164(telefono) {
  const digitos = String(telefono ?? '').replace(/\D/g, '');
  if (digitos.length < 10) return null;
  return digitos.length === 10 ? `+52${digitos}` : `+${digitos}`;
}

const nombreEquipo = (r) => [r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ') || 'el equipo';

// El campo "mensaje" es informacion cruda para que el agente de n8n redacte el texto final.
function mensajeCotizacion(r) {
  const diagnostico = r.diagnostico?.trim();
  return (
    `Cotización de la reparación de ${nombreEquipo(r)} (folio ${r.folio}): ${dinero(r.total)}.`
    + (diagnostico ? ` Diagnóstico: ${diagnostico}.` : '')
    + ' Pide al cliente que responda SÍ para autorizar la reparación o NO para cancelarla.'
  );
}

function mensajeReparado(r) {
  return (
    `Reparación de ${nombreEquipo(r)} (folio ${r.folio}) terminada. El equipo va en camino a la sucursal`
    + `${r.sucursal_nombre ? ` ${r.sucursal_nombre}` : ''}: se le avisará cuando esté listo para recoger.`
  );
}

function mensajeListoEnTienda(r) {
  const saldo = Number(r.total) - Number(r.monto_pagado ?? 0);
  return (
    `Reparación de ${nombreEquipo(r)} (folio ${r.folio}) lista en la sucursal${r.sucursal_nombre ? ` ${r.sucursal_nombre}` : ''}: ya puede pasar por ella.`
    + (saldo > 0 ? ` Saldo pendiente: ${dinero(saldo)}.` : ' No tiene saldo pendiente.')
  );
}

// tipo: 'otro' | 'reparacion_lista' (valores del contrato). construirMensaje: (reparacion) => texto.
// Devuelve { estado: 'enviado' | 'pendiente' | 'fallido' | 'omitido', error }:
//   enviado   n8n confirmo el envio ({status: 'ok'}).
//   pendiente n8n recibio el aviso pero no confirmo el envio (acuse generico, workflow sin "Respond to Webhook" al final).
//   fallido   sin telefono valido, webhook sin configurar, n8n respondio error o no se pudo contactar.
//   omitido   la reparacion no tiene cliente (equipo propio): no hay a quien avisar.
async function avisarCliente(pool, { reparacionId, tipo, construirMensaje, usuarioId }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.folio, r.sucursal_id, r.equipo_marca, r.equipo_modelo, r.diagnostico, r.total, r.monto_pagado, r.cliente_id,
            c.nombre AS cliente_nombre, c.telefono AS cliente_telefono, s.nombre AS sucursal_nombre
     FROM reparaciones r
     LEFT JOIN clientes c ON c.id = r.cliente_id
     LEFT JOIN sucursales s ON s.id = r.sucursal_id
     WHERE r.id = $1`,
    [reparacionId]
  );
  const r = rows[0];
  if (!r || !r.cliente_id) return { estado: 'omitido', error: null };

  const mensaje = construirMensaje(r);
  let estado = 'fallido';
  let error = null;

  const telefono = telefonoE164(r.cliente_telefono);
  if (!telefono) {
    error = 'El cliente no tiene un teléfono válido registrado.';
  } else if (!process.env.N8N_WEBHOOK_NOTIFICAR_CLIENTE) {
    error = 'El envío automático de avisos no está configurado en el servidor.';
  } else {
    try {
      const { data } = await llamarWebhookN8n(
        process.env.N8N_WEBHOOK_NOTIFICAR_CLIENTE,
        {
          usuario_id: usuarioId ?? null,
          timestamp: new Date().toISOString(),
          empresa: 'cityphone',
          sucursal_id: r.sucursal_id,
          tipo_notificacion: tipo,
          cliente: { nombre: r.cliente_nombre, telefono },
          referencia_id: r.folio,
          mensaje,
        },
        { timeoutMs: 20000, reintentar: false }
      );
      if (data?.status === 'ok') estado = 'enviado';
      else if (data?.status === 'error') error = data.mensaje_error || 'n8n no pudo enviar el aviso.';
      else estado = 'pendiente';
    } catch (err) {
      error = err.message || 'No se pudo contactar el servicio de avisos.';
    }
  }

  try {
    await pool.query(
      `INSERT INTO notificaciones_cliente (reparacion_id, canal, mensaje, estado, enviado_at)
       VALUES ($1, 'whatsapp', $2, $3::estado_notificacion_cliente, $4::timestamptz)`,
      [r.id, mensaje, estado, estado === 'enviado' ? new Date().toISOString() : null]
    );
  } catch (err) {
    console.error('No se pudo registrar el aviso al cliente:', err);
  }
  return { estado, error };
}

module.exports = { avisarCliente, telefonoE164, mensajeCotizacion, mensajeReparado, mensajeListoEnTienda };
