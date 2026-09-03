const crypto = require('crypto');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'Imagenes';
const EXTENSIONES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Limites de tamano para lo que se sube — nunca se agranda una imagen mas
// chica que esto (withoutEnlargement), solo se achica la que venga mas
// grande. ORIGINAL: suficiente para zoom/publicaciones sin cargar los 4000px
// de una foto de celular tal cual. MINIATURA: lo que se usa en catalogo,
// Punto de venta, etc. — es la causa real de que hoy tarden en cargar las
// tarjetas (se estaba sirviendo la foto completa hasta para eso).
const LADO_MAX_ORIGINAL = 1600;
const LADO_MAX_MINIATURA = 320;
const SUFIJO_MINIATURA = '-thumb';

async function redimensionar(buffer, ladoMax, calidad, mimeType) {
  let pipeline = sharp(buffer).resize({
    width: ladoMax,
    height: ladoMax,
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (mimeType === 'image/png') pipeline = pipeline.png({ quality: calidad });
  else if (mimeType === 'image/webp') pipeline = pipeline.webp({ quality: calidad });
  else pipeline = pipeline.jpeg({ quality: calidad });
  return pipeline.toBuffer();
}

// El cliente se crea de forma perezosa (no al cargar el modulo) porque
// createClient() truena de inmediato si falta SUPABASE_URL — si eso pasara
// al hacer require() de este archivo, tumbaria TODA la API al arrancar.
let supabase = null;
function obtenerSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return supabase;
}

// Sube un buffer de imagen ya decodificado al bucket publico de Supabase —
// la original redimensionada (nunca mas de LADO_MAX_ORIGINAL) y, junto a
// ella, una miniatura (sufijo "-thumb") para todo lo que la muestra chica
// (tarjetas de catalogo, Punto de venta, etc.). El nombre de la miniatura es
// deliberadamente predecible a partir del de la original — asi
// ProductImage.jsx puede derivarlo solo con el string de la URL, sin que
// haya que mandar un campo aparte por toda la app cada vez que se guarda o
// se lee una imagen. Comparte bucket y convencion de nombre con
// /uploads/imagen (multipart) — factorizado aqui porque
// /n8n/media/mejorar-imagen tambien necesita subir una imagen, pero la
// recibe de vuelta en base64 desde n8n, no como archivo.
async function subirBufferABucket(buffer, mimeType) {
  const supabaseClient = obtenerSupabase();
  if (!supabaseClient) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    throw Object.assign(new Error('La subida de imágenes no está configurada en el servidor.'), { statusCode: 500 });
  }

  const extension = EXTENSIONES[mimeType] ?? 'jpg';
  const nombreArchivo = `${crypto.randomUUID()}.${extension}`;
  const nombreMiniatura = `${nombreArchivo.slice(0, -(extension.length + 1))}${SUFIJO_MINIATURA}.${extension}`;

  let bufferOriginal = buffer;
  let bufferMiniatura;
  try {
    [bufferOriginal, bufferMiniatura] = await Promise.all([
      redimensionar(buffer, LADO_MAX_ORIGINAL, 82, mimeType),
      redimensionar(buffer, LADO_MAX_MINIATURA, 75, mimeType),
    ]);
  } catch (err) {
    // Si sharp no pudo procesar el archivo por alguna razon, se sube la
    // original tal cual llego en vez de fallar la subida completa — sin
    // miniatura esta vez, ProductImage.jsx ya sabe caer de vuelta a la
    // original cuando la miniatura no existe.
    console.error('No se pudo generar miniatura, subiendo original sin redimensionar:', err);
    bufferMiniatura = null;
  }

  const { error } = await supabaseClient.storage.from(BUCKET).upload(nombreArchivo, bufferOriginal, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) {
    console.error(error);
    throw Object.assign(new Error('No se pudo subir la imagen.'), { statusCode: 500 });
  }

  if (bufferMiniatura) {
    const { error: errorMiniatura } = await supabaseClient.storage.from(BUCKET).upload(nombreMiniatura, bufferMiniatura, {
      contentType: mimeType,
      upsert: false,
    });
    if (errorMiniatura) console.error('No se pudo subir la miniatura:', errorMiniatura);
  }

  const { data } = supabaseClient.storage.from(BUCKET).getPublicUrl(nombreArchivo);
  return { url: data.publicUrl };
}

// Verifica el contenido real del archivo por su firma binaria ("magic
// bytes") en vez de confiar en el Content-Type que manda el navegador, que
// cualquiera puede falsificar (ej. subir un .html declarando "soy
// image/jpeg"). Devuelve el mimetype real detectado, o null si no es
// ninguno de los formatos que aceptamos — quien llama debe rechazar el
// archivo en ese caso, nunca usar el mimetype declarado por el cliente.
function detectarTipoReal(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

module.exports = { subirBufferABucket, EXTENSIONES, detectarTipoReal };
