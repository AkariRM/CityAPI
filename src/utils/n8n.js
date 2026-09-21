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
    // El cuerpo se lee como bytes (no res.json()) porque algunos workflows
    // devuelven el archivo generado directo o texto plano, no JSON; asi quien
    // llama puede decidir que hacer cuando data === null.
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    let data = null;
    if (/json/i.test(contentType) || buffer[0] === 0x7b || buffer[0] === 0x5b) {
      try {
        data = JSON.parse(buffer.toString('utf8'));
      } catch {
        // no era JSON valido — data se queda en null y el buffer sigue disponible
      }
    }
    if (!res.ok) throw new Error(data?.mensaje ?? data?.mensaje_error ?? `n8n respondió ${res.status}`);
    return { status: res.status, data, contentType, buffer };
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
