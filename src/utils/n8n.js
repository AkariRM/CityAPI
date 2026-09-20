// Probado contra los webhooks reales de TRAI: la mayoria responde en
// segundos, pero "mejorar imagen" (cambio de fondo) tardo ~33s — 25s se
// quedaba corto y lo tumbaba con un timeout aunque si estaba funcionando.
const TIMEOUT_MS = 60000;

// Llama a un webhook de n8n para una de las automatizaciones de IA.
// Un solo lugar para: header de autenticacion saliente (X-Webhook-Secret),
// timeout, y un reintento automatico antes de fallar — asi los 6 endpoints
// de n8n.routes.js no duplican este comportamiento cada uno por su lado.
async function intentarLlamada(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': process.env.WEBHOOK_SECRET ?? '',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.mensaje ?? `n8n respondió ${res.status}`);
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

// timeoutMs / reintentar son opcionales: generar un recurso grafico tarda
// mas que el resto y es caro de repetir, asi que ahi se amplia el timeout y
// se apaga el reintento automatico (ver /cm/generar-recurso).
async function llamarWebhookN8n(url, payload, { timeoutMs = TIMEOUT_MS, reintentar = true } = {}) {
  if (!url) throw Object.assign(new Error('Automatización no configurada en el servidor.'), { statusCode: 500 });
  try {
    return await intentarLlamada(url, payload, timeoutMs);
  } catch (primerError) {
    if (!reintentar) {
      console.error('n8n webhook falló (sin reintento):', primerError);
      throw Object.assign(new Error('No se pudo contactar el servicio de IA. Intenta de nuevo.'), { statusCode: 502 });
    }
    // Un reintento antes de rendirse — los workflows de IA a veces truenan
    // por un timeout transitorio del lado de n8n, no vale la pena fallarle
    // al usuario de una sola vez.
    try {
      return await intentarLlamada(url, payload, timeoutMs);
    } catch (err) {
      console.error('n8n webhook falló tras reintento:', err);
      throw Object.assign(new Error('No se pudo contactar el servicio de IA. Intenta de nuevo.'), { statusCode: 502 });
    }
  }
}

module.exports = { llamarWebhookN8n };
