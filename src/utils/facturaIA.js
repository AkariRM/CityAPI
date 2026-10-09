// Lectura de facturas en PDF y foto con IA: se manda el archivo al webhook de n8n (N8N_WEBHOOK_LEER_FACTURA, formato B7 en
// CityPhone_Referencia_n8n_Endpoints_y_Webhooks.txt) y n8n responde la factura ya estructurada. El XML no pasa por aqui: se lee en el
// propio servidor (facturaCfdi.js).

const { llamarWebhookN8n } = require('./n8n');
const { normalizarFacturaIA } = require('./facturaPropuesta');

function falla(statusCode, mensaje) {
  return Object.assign(new Error(mensaje), { statusCode });
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_BYTES_XML = 2 * 1024 * 1024;

// Que tipo de archivo es, por sus primeros bytes (no por la extension ni lo que diga el navegador).
function detectarArchivo(buffer) {
  if (buffer.length >= 4 && buffer.slice(0, 4).toString('latin1') === '%PDF') return { tipo: 'pdf', mime: 'application/pdf' };
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { tipo: 'imagen', mime: 'image/png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { tipo: 'imagen', mime: 'image/jpeg' };
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') return { tipo: 'imagen', mime: 'image/webp' };
  const inicio = buffer.slice(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (inicio.startsWith('<')) return { tipo: 'xml', mime: 'application/xml' };
  return null;
}

// base64 (con o sin el prefijo "data:...;base64,") -> Buffer, validando el tamano.
function decodificarArchivo(contenidoBase64) {
  if (typeof contenidoBase64 !== 'string' || contenidoBase64.length === 0) throw falla(400, 'Falta el archivo de la factura.');
  const limpio = contenidoBase64.replace(/^data:[^;]*;base64,/, '').replace(/\s+/g, '');
  if (limpio.length > Math.ceil((MAX_BYTES * 4) / 3) + 8) throw falla(413, 'El archivo pesa más de 10 MB: sube uno más ligero.');
  const buffer = Buffer.from(limpio, 'base64');
  if (buffer.length === 0) throw falla(400, 'El archivo está vacío.');
  if (buffer.length > MAX_BYTES) throw falla(413, 'El archivo pesa más de 10 MB: sube uno más ligero.');
  return buffer;
}

async function leerFacturaConIA({ archivo, buffer, nombre, usuarioId }) {
  const url = process.env.N8N_WEBHOOK_LEER_FACTURA;
  if (!url) {
    throw falla(503, 'La lectura de facturas en PDF y foto con IA todavía no está configurada en el servidor. Mientras tanto puedes subir el XML de la factura.');
  }
  let respuesta;
  try {
    respuesta = await llamarWebhookN8n(
      url,
      {
        usuario_id: usuarioId ?? null,
        timestamp: new Date().toISOString(),
        empresa: 'cityphone',
        tipo_archivo: archivo.tipo,
        mime_type: archivo.mime,
        nombre_archivo: typeof nombre === 'string' ? nombre.slice(0, 120) : null,
        archivo_base64: buffer.toString('base64'),
      },
      { timeoutMs: 120000, reintentar: false }
    );
  } catch (err) {
    throw falla(err.statusCode ?? 502, err.message || 'No se pudo contactar el servicio de IA.');
  }
  const data = respuesta.data;
  if (!data || typeof data !== 'object') throw falla(502, 'El servicio de IA no devolvió una respuesta que se pueda leer. Intenta de nuevo o sube el XML.');
  if (data.status === 'error') throw falla(422, data.mensaje_error || 'La IA no pudo leer la factura. Prueba con el XML o con una foto más clara.');
  if (data.status !== 'ok') throw falla(502, 'El servicio de IA respondió de forma inesperada. Intenta de nuevo o sube el XML.');
  return normalizarFacturaIA(data.factura, data.advertencias);
}

module.exports = { detectarArchivo, decodificarArchivo, leerFacturaConIA, MAX_BYTES, MAX_BYTES_XML };
