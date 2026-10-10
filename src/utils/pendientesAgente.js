const { llamarWebhookN8n } = require('./n8n');
const { telefonoE164 } = require('./notificarReparacion');

// Manda por WhatsApp (n8n) la respuesta que el personal le dio a un pendiente del agente, para que la redacte y se la pase a la persona.
// Usa el webhook de avisos al cliente (B6) con tipo "otro" y los datos separados en `datos`; si n8n tiene uno propio para esto, se
// pone en N8N_WEBHOOK_RESPUESTA_PENDIENTE y se usa ese. Mismo criterio que los avisos de reparacion: un aviso que falla nunca tumba
// la respuesta (ya quedo guardada) y se guarda como quedo el envio. Devuelve { estado: 'enviado' | 'pendiente' | 'fallido', error }.
async function enviarRespuesta(pool, p, usuarioId) {
  const url = process.env.N8N_WEBHOOK_RESPUESTA_PENDIENTE || process.env.N8N_WEBHOOK_NOTIFICAR_CLIENTE;
  const telefono = telefonoE164(p.telefono);
  let estado = 'fallido';
  let error = null;

  if (!telefono) {
    error = 'La persona no tiene un teléfono válido.';
  } else if (!url) {
    error = 'El envío automático de avisos no está configurado en el servidor.';
  } else {
    try {
      const { data } = await llamarWebhookN8n(
        url,
        {
          usuario_id: usuarioId ?? null,
          timestamp: new Date().toISOString(),
          empresa: 'cityphone',
          sucursal_id: null,
          tipo_notificacion: 'otro',
          cliente: { nombre: p.nombre || 'Cliente', telefono },
          referencia_id: p.folio,
          mensaje:
            `Respuesta del personal a lo que la persona había preguntado. Pregunta: "${p.pregunta}". Respuesta: "${p.respuesta}". `
            + 'Pásale la respuesta con tu estilo, sin agregar datos que no estén aquí.',
          datos: {
            tipo_aviso: 'respuesta_pendiente',
            pendiente: p.folio,
            pregunta: p.pregunta,
            respuesta: p.respuesta,
            equipo_interes: p.equipo_interes ?? null,
            referencia: p.referencia ?? null,
          },
        },
        { timeoutMs: 20000, reintentar: false }
      );
      if (data?.status === 'ok') estado = 'enviado';
      else if (data?.status === 'error') error = data.mensaje_error || 'n8n no pudo enviar la respuesta.';
      else estado = 'pendiente';
    } catch (err) {
      error = err.message || 'No se pudo contactar el servicio de avisos.';
    }
  }

  await pool.query(`UPDATE agente_pendientes SET aviso_estado = $2, aviso_error = $3 WHERE id = $1`, [p.id, estado, error]);
  return { estado, error };
}

module.exports = { enviarRespuesta };
