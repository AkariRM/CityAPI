const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { llamarWebhookN8n } = require('../utils/n8n');
const { subirBufferABucket } = require('../utils/almacenamiento');

const router = express.Router();
router.use(requireAuth);

const EMPRESAS_VALIDAS = ['cityphone', 'aurea'];

// Cada automatizacion recibe "empresa" en el body (no en la ruta, a
// diferencia de /aurea/* que usa requireEmpresa) porque el mismo endpoint
// sirve a ambas empresas segun quien lo llame. Dueño puede operar
// cualquiera; el resto de los roles solo la suya.
function validarEmpresa(req, res) {
  const { empresa } = req.body ?? {};
  if (!EMPRESAS_VALIDAS.includes(empresa)) {
    res.status(400).json({ error: 'empresa debe ser "cityphone" o "aurea".' });
    return false;
  }
  if (req.usuario.rol !== 'dueño' && empresa !== req.usuario.empresa_slug) {
    res.status(403).json({ error: 'No tienes acceso a esa empresa.' });
    return false;
  }
  return true;
}

function faltantes(body, campos) {
  return campos.filter((c) => {
    const valor = c.split('.').reduce((v, k) => v?.[k], body);
    return valor === undefined || valor === null || valor === '';
  });
}

// Contexto que se agrega server-side a cada payload que sale hacia n8n —
// nunca se confia en usuario_id/session_id/timestamp que mande el cliente,
// mismo criterio que el resto de la API para cualquier dato de identidad.
function contexto(req) {
  return {
    usuario_id: req.usuario.sub,
    session_id: req.headers['x-session-id'] ?? null,
    timestamp: new Date().toISOString(),
  };
}

async function relayarWebhook(res, url, payload) {
  try {
    const { data } = await llamarWebhookN8n(url, payload);
    res.json(data ?? { status: 'ok' });
  } catch (err) {
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
  }
}

// 1 — Registro de inventario/stock multimodal con IA
router.post('/inventario/registrar-ia', requireRole('admin', 'vendedor', 'pto'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['sucursal_id', 'tipo_entrada', 'contenido']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });

  await relayarWebhook(res, process.env.N8N_WEBHOOK_INVENTARIO_IA, {
    ...contexto(req),
    empresa: req.body.empresa,
    sucursal_id: req.body.sucursal_id,
    tipo_entrada: req.body.tipo_entrada,
    contenido: req.body.contenido,
    nombre_archivo: req.body.nombre_archivo ?? null,
    mime_type: req.body.mime_type ?? null,
  });
});

// 2 — Lectura de imagen de equipo por camara (IA)
router.post('/equipo/leer-imagen-ia', requireRole('admin', 'vendedor', 'pto'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['sucursal_id', 'imagen']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });

  await relayarWebhook(res, process.env.N8N_WEBHOOK_LEER_EQUIPO_IA, {
    ...contexto(req),
    empresa: req.body.empresa,
    sucursal_id: req.body.sucursal_id,
    imagen: req.body.imagen,
  });
});

// 3 — Generacion de contenido con IA (Community Manager)
router.post('/cm/generar-contenido', requireRole('admin', 'community_manager'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['red_social', 'tipo_publicacion', 'productos']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });
  if (!Array.isArray(req.body.productos) || req.body.productos.length === 0) {
    return res.status(400).json({ error: 'productos debe ser una lista con al menos un elemento.' });
  }

  await relayarWebhook(res, process.env.N8N_WEBHOOK_CM_GENERAR, {
    ...contexto(req),
    empresa: req.body.empresa,
    red_social: req.body.red_social,
    tipo_publicacion: req.body.tipo_publicacion,
    productos: req.body.productos,
  });
});

// 4 — Publicacion de contenido con IA (enrutado por red social)
// OJO: a diferencia del resto, este endpoint SI publica de verdad en la
// red social correspondiente del lado de n8n — no es una simulacion.
router.post('/cm/publicar-contenido', requireRole('admin', 'community_manager'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['red_social', 'tipo_publicacion', 'hook', 'descripcion', 'cta']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });

  await relayarWebhook(res, process.env.N8N_WEBHOOK_CM_PUBLICAR, {
    ...contexto(req),
    empresa: req.body.empresa,
    red_social: req.body.red_social,
    tipo_publicacion: req.body.tipo_publicacion,
    hook: req.body.hook,
    descripcion: req.body.descripcion,
    cta: req.body.cta,
    contenido_previo: req.body.contenido_previo ?? [],
  });
});

// 5 — Mejorar imagen con IA (cambio de fondo). A diferencia de los demas,
// no usa relayarWebhook: la respuesta de n8n trae la imagen resuelta
// (imagen_modificada, como URL o como base64) y aqui se normaliza siempre a
// una URL de nuestro propio bucket antes de contestarle a la app, para que
// el frontend reciba el mismo { url } que ya conoce de /uploads/imagen sin
// importar en que formato haya regresado n8n.
router.post('/media/mejorar-imagen', requireRole('admin', 'vendedor', 'pto'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['tipo', 'imagen']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });
  if (!['equipo', 'accesorio'].includes(req.body.tipo)) {
    return res.status(400).json({ error: 'tipo debe ser "equipo" o "accesorio".' });
  }

  try {
    const { data } = await llamarWebhookN8n(process.env.N8N_WEBHOOK_MEJORAR_IMAGEN, {
      ...contexto(req),
      empresa: req.body.empresa,
      tipo: req.body.tipo,
      imagen: req.body.imagen,
    });

    const resultado = data?.imagen_modificada;
    if (!resultado) return res.status(502).json({ error: 'La IA no devolvió una imagen.' });

    if (/^https?:\/\//i.test(resultado)) {
      return res.json({ url: resultado });
    }

    const match = /^data:(image\/\w+);base64,(.+)$/.exec(resultado);
    const mimeType = match?.[1] ?? 'image/jpeg';
    const base64 = match ? match[2] : resultado;
    const { url } = await subirBufferABucket(Buffer.from(base64, 'base64'), mimeType);
    res.json({ url });
  } catch (err) {
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
  }
});

// 6 — Notificaciones al cliente (agente)
router.post('/agente/notificar-cliente', requireRole('admin', 'vendedor', 'tecnico'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['tipo_notificacion', 'cliente.nombre', 'cliente.telefono', 'referencia_id', 'mensaje']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });

  await relayarWebhook(res, process.env.N8N_WEBHOOK_NOTIFICAR_CLIENTE, {
    usuario_id: req.usuario.sub,
    timestamp: new Date().toISOString(),
    empresa: req.body.empresa,
    sucursal_id: req.body.sucursal_id ?? null,
    tipo_notificacion: req.body.tipo_notificacion,
    cliente: { nombre: req.body.cliente.nombre, telefono: req.body.cliente.telefono },
    referencia_id: req.body.referencia_id,
    mensaje: req.body.mensaje,
  });
});

module.exports = router;
