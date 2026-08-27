const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'Imagenes';
const EXTENSIONES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// El cliente se crea de forma perezosa (no al cargar el modulo) porque
// createClient() truena de inmediato si falta SUPABASE_URL — si eso pasara
// al hacer require() de este archivo, tumbaria TODA la API al arrancar.
let supabase = null;
function obtenerSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return supabase;
}

// Sube un buffer de imagen ya decodificado al bucket publico de Supabase.
// Comparte bucket y convencion de nombre con /uploads/imagen (multipart) —
// factorizado aqui porque /n8n/media/mejorar-imagen tambien necesita subir
// una imagen, pero la recibe de vuelta en base64 desde n8n, no como archivo.
async function subirBufferABucket(buffer, mimeType) {
  const supabaseClient = obtenerSupabase();
  if (!supabaseClient) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    throw Object.assign(new Error('La subida de imágenes no está configurada en el servidor.'), { statusCode: 500 });
  }

  const extension = EXTENSIONES[mimeType] ?? 'jpg';
  const nombreArchivo = `${crypto.randomUUID()}.${extension}`;

  const { error } = await supabaseClient.storage.from(BUCKET).upload(nombreArchivo, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) {
    console.error(error);
    throw Object.assign(new Error('No se pudo subir la imagen.'), { statusCode: 500 });
  }

  const { data } = supabaseClient.storage.from(BUCKET).getPublicUrl(nombreArchivo);
  return { url: data.publicUrl };
}

module.exports = { subirBufferABucket, EXTENSIONES };
