const crypto = require('crypto');

// Generaciones de recursos graficos (marketing) que corren en segundo plano: la app pide la imagen, recibe un id al instante y despues
// consulta el estado. Asi la persona puede cambiar de paso, cerrar la pantalla o volver mas tarde sin perder la imagen que n8n termine.
//
// Viven en la memoria del servidor (no hay tabla): duran VIDA_MS despues de empezar y se pierden si el servidor se reinicia (un deploy). Si
// eso pasa, la consulta contesta que no existe y la app avisa que hay que generar de nuevo.

const VIDA_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIVOS_POR_USUARIO = 3;

const trabajos = new Map();

function limpiar() {
  const limite = Date.now() - VIDA_MS;
  for (const [id, t] of trabajos) if (t.inicio < limite) trabajos.delete(id);
}

// Crea el trabajo en estado 'generando'. Lanza 429 si la persona ya tiene demasiadas generaciones en camino (cada una cuesta).
function crear(usuarioId) {
  limpiar();
  const activos = [...trabajos.values()].filter((t) => t.usuarioId === usuarioId && t.estado === 'generando').length;
  if (activos >= MAX_ACTIVOS_POR_USUARIO) {
    throw Object.assign(new Error(`Ya tienes ${activos} imágenes generándose. Espera a que termine alguna.`), { statusCode: 429 });
  }
  const trabajo = { id: crypto.randomUUID(), usuarioId, estado: 'generando', inicio: Date.now(), fin: null, url: null, mensaje: null, detalle: null };
  trabajos.set(trabajo.id, trabajo);
  return trabajo;
}

// Solo lo ve quien lo pidio.
function obtener(id, usuarioId) {
  const t = trabajos.get(id);
  return t && t.usuarioId === usuarioId ? t : null;
}

function terminar(id, url) {
  const t = trabajos.get(id);
  if (!t || t.estado !== 'generando') return;
  Object.assign(t, { estado: 'listo', url, fin: Date.now() });
}

function fallar(id, mensaje) {
  const t = trabajos.get(id);
  if (!t || t.estado !== 'generando') return;
  Object.assign(t, { estado: 'error', detalle: mensaje, fin: Date.now() });
}

// La persona dejo de esperar: lo que n8n conteste despues se descarta (la llamada a n8n ya no se puede detener).
function cancelar(id, usuarioId) {
  const t = obtener(id, usuarioId);
  if (!t) return false;
  if (t.estado === 'generando') Object.assign(t, { estado: 'cancelado', fin: Date.now() });
  return true;
}

function vista(t) {
  const segundos = Math.floor(((t.fin ?? Date.now()) - t.inicio) / 1000);
  return { id: t.id, estado: t.estado, segundos, ...(t.estado === 'listo' ? { url: t.url } : {}), ...(t.estado === 'error' ? { detalle: t.detalle } : {}) };
}

module.exports = { crear, obtener, terminar, fallar, cancelar, vista };
