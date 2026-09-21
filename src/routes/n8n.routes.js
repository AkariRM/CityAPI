const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { llamarWebhookN8n } = require('../utils/n8n');
const { subirBufferABucket, detectarTipoReal } = require('../utils/almacenamiento');

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

// 3b — Generacion del recurso grafico (imagen/historia/reel) con IA a partir
// del texto que ya se eligio en /cm/generar-contenido. n8n contesta con el
// mismo envelope que las notificaciones ({ status, recurso, mensaje_error });
// "recurso" se normaliza siempre a una URL: si ya viene como URL se deja tal
// cual (puede ser un video), si viene como imagen en base64 se sube a nuestro
// bucket igual que mejorar-imagen. Tarda mas que el resto y es caro de
// repetir, asi que timeout ampliado y sin reintento automatico.
const TIMEOUT_GENERAR_RECURSO_MS = 90000;

// Resumen corto de lo que contesto n8n (strings largos, base64 incluido, se
// recortan) para ver la respuesta real en vez de adivinar su forma.
function resumirRespuesta(valor) {
  const recortar = (v) => {
    if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 60)}…[${v.length} chars]` : v;
    if (Array.isArray(v)) return v.slice(0, 3).map(recortar);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, recortar(x)]));
    return v;
  };
  return JSON.stringify(recortar(valor))?.slice(0, 400);
}

// Cuando n8n no contesta JSON: tipo de contenido, tamano y el inicio del
// cuerpo (como texto si es legible, en hexadecimal si es binario).
function describirCuerpo(buffer, contentType) {
  const base = `${contentType || 'sin content-type'}, ${buffer?.length ?? 0} bytes`;
  if (!buffer?.length) return `respuesta vacía (${base})`;
  const inicio = buffer.subarray(0, 16);
  const esTexto = inicio.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
  return `${base}, inicio: ${esTexto ? JSON.stringify(buffer.subarray(0, 80).toString('utf8')) : inicio.toString('hex')}`;
}

// Primer string http(s) dentro de un valor anidado — mientras TRAI no
// documente en que forma manda el recurso, tolera objeto o lista.
function primeraUrl(valor) {
  if (typeof valor === 'string') return /^https?:\/\//i.test(valor) ? valor : null;
  const hijos = Array.isArray(valor) ? valor : valor && typeof valor === 'object' ? Object.values(valor) : [];
  for (const hijo of hijos) {
    const url = primeraUrl(hijo);
    if (url) return url;
  }
  return null;
}

router.post('/cm/generar-recurso', requireRole('admin', 'community_manager'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['red_social', 'tipo_publicacion', 'hook']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });

  try {
    const { data, buffer, contentType } = await llamarWebhookN8n(
      process.env.N8N_WEBHOOK_CM_GENERAR_RECURSO,
      {
        ...contexto(req),
        empresa: req.body.empresa,
        red_social: req.body.red_social,
        tipo_publicacion: req.body.tipo_publicacion,
        hook: req.body.hook,
        descripcion: req.body.descripcion ?? '',
        cta: req.body.cta ?? '',
        productos: Array.isArray(req.body.productos) ? req.body.productos : [],
      },
      { timeoutMs: TIMEOUT_GENERAR_RECURSO_MS, reintentar: false }
    );

    if (data?.status === 'error') {
      return res.status(502).json({ error: data.mensaje_error || 'La IA no pudo generar el recurso.' });
    }

    let recurso = null;
    if (data) {
      recurso = typeof data.recurso === 'string' ? data.recurso : primeraUrl(data.recurso);
    } else if (buffer?.length) {
      // n8n no contesto JSON: o devolvio el archivo directo (binario) o un
      // texto plano con la URL / el base64 de la imagen.
      const tipoBinario = detectarTipoReal(buffer);
      if (tipoBinario) {
        const { url } = await subirBufferABucket(buffer, tipoBinario);
        return res.json({ url });
      }
      const texto = buffer.toString('utf8').trim();
      if (/^https?:\/\/\S+$/i.test(texto) || /^data:image\/\w+;base64,/.test(texto) || /^[A-Za-z0-9+/=\r\n]{200,}$/.test(texto)) {
        recurso = texto;
      }
    }
    if (!recurso) {
      const detalle = data ? resumirRespuesta(data) : describirCuerpo(buffer, contentType);
      console.error('generar-recurso: respuesta inesperada de n8n:', detalle);
      return res.status(502).json({ error: `La IA no devolvió un recurso. Respuesta de n8n: ${detalle}` });
    }

    if (/^https?:\/\//i.test(recurso)) return res.json({ url: recurso });

    const match = /^data:(image\/\w+);base64,(.+)$/.exec(recurso);
    const imagen = Buffer.from(match ? match[2] : recurso, 'base64');
    const mimeType = match?.[1] ?? detectarTipoReal(imagen);
    if (!mimeType) {
      return res.status(502).json({ error: `El recurso que devolvió la IA no es una imagen válida: ${resumirRespuesta(recurso)}` });
    }

    const { url } = await subirBufferABucket(imagen, mimeType);
    res.json({ url });
  } catch (err) {
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
  }
});

// 4 — Publicacion de contenido con IA (enrutado por red social)
// OJO: a diferencia del resto, este endpoint SI publica de verdad en la
// red social correspondiente del lado de n8n — no es una simulacion.
// Contrato confirmado por TRAI (CityPhone_Webhooks_Backend.txt): "imagen" es
// obligatoria (URL publica o base64 sin prefijo), "fecha_programada" solo se
// exige cuando modo_publicacion es "programado", y url_publicacion en la
// respuesta SIEMPRE viene null en este paso (no hay endpoint aun para
// resolver el link real, ver post_id en la respuesta).
router.post('/cm/publicar-contenido', requireRole('admin', 'community_manager'), async (req, res) => {
  if (!validarEmpresa(req, res)) return;
  const faltan = faltantes(req.body, ['red_social', 'tipo_publicacion', 'hook', 'descripcion', 'cta', 'imagen']);
  if (faltan.length) return res.status(400).json({ error: `Faltan campos: ${faltan.join(', ')}.` });
  if (req.body.modo_publicacion === 'programado' && !req.body.fecha_programada) {
    return res.status(400).json({ error: 'fecha_programada es requerida cuando modo_publicacion es "programado".' });
  }

  await relayarWebhook(res, process.env.N8N_WEBHOOK_CM_PUBLICAR, {
    ...contexto(req),
    empresa: req.body.empresa,
    red_social: req.body.red_social,
    tipo_publicacion: req.body.tipo_publicacion,
    hook: req.body.hook,
    descripcion: req.body.descripcion,
    cta: req.body.cta,
    imagen: req.body.imagen,
    modo_publicacion: req.body.modo_publicacion || 'inmediato',
    fecha_programada: req.body.fecha_programada || null,
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
