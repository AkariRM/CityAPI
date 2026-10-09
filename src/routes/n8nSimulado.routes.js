const express = require('express');
const { verificarSecreto } = require('../middleware/webhookSecret');

// "n8n de mentira" para ver las pantallas con datos antes de que TRAI entregue los flujos reales. NO lee ni envia nada de verdad:
// contesta con datos fijos en el mismo formato que esperamos de n8n (B6 avisos y B7 leer factura, ver
// CityPhone_Referencia_n8n_Endpoints_y_Webhooks.txt). Solo se monta si N8N_SIMULADO=true (ver index.js).
//
// Se usa poniendo en Render las variables apuntando aqui, y se quita cambiandolas por las URLs reales de TRAI:
//   N8N_WEBHOOK_LEER_FACTURA        = https://<esta api>/n8n-simulado/leer-factura
//   N8N_WEBHOOK_NOTIFICAR_CLIENTE   = https://<esta api>/n8n-simulado/notificar-cliente
// CityAPI las llama por HTTP como llamaria a n8n (mismo secreto, mismo cuerpo), asi que tambien prueba ese tramo.

const router = express.Router();
router.use(verificarSecreto);

const fechaHoyMx = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const AVISO_SIMULACION = 'SIMULACIÓN: estos datos son de prueba, no salen del archivo que subiste.';

// Factura con IVA aparte (como un CFDI impreso). Mismos productos que Facturas_de_prueba/factura_prueba_1_con_IVA.xml, mas un cargador
// con descuento para ver ese campo. subtotal 1599.00 + IVA 255.84 = total 1854.84.
function facturaCompleta() {
  return {
    status: 'ok',
    advertencias: [AVISO_SIMULACION, 'El renglón 4 se leyó con poca claridad: confirma la cantidad.'],
    factura: {
      proveedor: { nombre: 'ACCESORIOS DE PRUEBA SA DE CV', rfc: 'AAA010101AAA' },
      folio: 'PRB-2001',
      fecha: fechaHoyMx(),
      moneda: 'MXN',
      subtotal: 1599.0,
      iva: 255.84,
      total: 1854.84,
      precios_incluyen_iva: false,
      renglones: [
        { descripcion: 'FUNDA SILICON IPHONE 15 NEGRA', clave: 'FSI15-NEG', cantidad: 12, unidad: 'PZA', precio_unitario: 45, importe: 540, descuento: 0, iva_tasa: 0.16 },
        { descripcion: 'CABLE USB-C 1 METRO', clave: 'CUSBC-1M', cantidad: 20, unidad: 'PZA', precio_unitario: 15, importe: 300, descuento: 0, iva_tasa: 0.16 },
        { descripcion: 'MICA CRISTAL TEMPLADO UNIVERSAL CAJA CON 10', clave: 'MICA-CT', cantidad: 2, unidad: 'CAJA', precio_unitario: 150, importe: 300, descuento: 0, iva_tasa: 0.16 },
        { descripcion: 'CARGADOR DE PARED 20W USB-C', clave: null, cantidad: 6, unidad: 'PZA', precio_unitario: 85, importe: 510, descuento: 51, iva_tasa: 0.16 },
      ],
    },
  };
}

// Ticket o remision: precios con IVA incluido, sin RFC ni fecha legible.
function ticketSimple() {
  return {
    status: 'ok',
    advertencias: [AVISO_SIMULACION, 'No se alcanza a leer la fecha.'],
    factura: {
      proveedor: { nombre: 'Distribuidora La Esquina', rfc: null },
      folio: null,
      fecha: null,
      moneda: 'MXN',
      subtotal: 625,
      iva: 100,
      total: 725,
      precios_incluyen_iva: true,
      renglones: [
        { descripcion: 'Audifonos bluetooth negros', clave: null, cantidad: 5, unidad: 'PZA', precio_unitario: 95, importe: 475, descuento: 0, iva_tasa: 0.16 },
        { descripcion: 'Soporte de celular para auto', clave: null, cantidad: 5, unidad: 'PZA', precio_unitario: 50, importe: 250, descuento: 0, iva_tasa: 0.16 },
      ],
    },
  };
}

// B7: leer una factura (PDF o foto). El resultado depende del NOMBRE del archivo que se sube:
//   (cualquiera)        factura completa con IVA aparte, 4 renglones
//   ...ticket...        ticket con precios con IVA, sin RFC ni fecha
//   ...error...         la IA "no pudo leer" el archivo (ver como se muestra el error)
//   ...lento...         tarda 20 segundos en contestar (ver el estado "leyendo")
router.post('/leer-factura', async (req, res) => {
  const { tipo_archivo: tipo, mime_type: mime, archivo_base64: contenido, nombre_archivo: nombre } = req.body ?? {};
  const faltan = [];
  if (tipo !== 'pdf' && tipo !== 'imagen') faltan.push('tipo_archivo');
  if (typeof mime !== 'string' || !mime) faltan.push('mime_type');
  if (typeof contenido !== 'string' || contenido.length === 0) faltan.push('archivo_base64');
  if (faltan.length > 0) return res.status(400).json({ status: 'error', mensaje_error: `Faltan o vienen mal estos campos: ${faltan.join(', ')}.` });

  const clave = String(nombre ?? '').toLowerCase();
  console.warn(`[n8n simulado] leer-factura: ${tipo} "${clave}" (${Math.round((contenido.length * 3) / 4 / 1024)} KB)`);
  if (clave.includes('lento')) await esperar(20000);
  if (clave.includes('error')) return res.json({ status: 'error', mensaje_error: 'No se distingue el texto de la foto. Toma otra con mejor luz.' });
  return res.json(clave.includes('ticket') ? ticketSimple() : facturaCompleta());
});

// B6: aviso al cliente por WhatsApp. No manda nada. El resultado depende de los ultimos digitos del telefono del cliente:
//   termina en 0000     error ("el numero no tiene WhatsApp")
//   termina en 1111     el acuse generico (el aviso queda como "pendiente")
//   cualquier otro      ok (el aviso queda como "enviado" aunque NO salio ningun mensaje)
router.post('/notificar-cliente', (req, res) => {
  const { tipo_notificacion: tipo, cliente, referencia_id: folio, mensaje } = req.body ?? {};
  const telefono = String(cliente?.telefono ?? '');
  if (!tipo || !telefono || !folio || !mensaje) {
    return res.status(400).json({ status: 'error', mensaje_error: 'Faltan campos: tipo_notificacion, cliente.telefono, referencia_id o mensaje.' });
  }
  console.warn(`[n8n simulado] notificar-cliente: ${tipo} folio ${folio} (no se envió nada)`);
  if (telefono.endsWith('0000')) return res.json({ status: 'error', mensaje_error: 'Simulación: el número no tiene WhatsApp.' });
  if (telefono.endsWith('1111')) return res.json({ message: 'Workflow was started' });
  return res.json({ status: 'ok', simulado: true });
});

module.exports = router;
