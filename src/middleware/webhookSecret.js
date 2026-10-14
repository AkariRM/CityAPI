const crypto = require('crypto');

// Autenticacion para endpoints que llama un servicio externo (ej. n8n de
// TRAI) hacia nosotros, sin sesion de usuario de por medio — no se puede
// usar requireAuth. Se valida con el mismo secreto compartido que ya usamos
// para llamarlos a ellos (X-Webhook-Secret contra WEBHOOK_SECRET), en
// sentido inverso.
//
// Cambio de secreto sin cortar el servicio: mientras se hace la transicion se
// define TAMBIEN WEBHOOK_SECRET_ANTERIOR con el valor viejo, y el servidor acepta
// cualquiera de los dos. Al terminar, se borra esa variable y el secreto viejo
// deja de funcionar (ver el procedimiento de cambio de secreto). Sin definirla
// el comportamiento es exactamente el de siempre: solo vale WEBHOOK_SECRET.

// Comparacion en tiempo constante (no revela cuantos caracteres coinciden). Se
// compara el hash de cada valor para que la longitud no cambie el resultado.
function iguales(recibido, esperado) {
  const a = crypto.createHash('sha256').update(String(recibido)).digest();
  const b = crypto.createHash('sha256').update(String(esperado)).digest();
  return crypto.timingSafeEqual(a, b);
}

function secretosValidos() {
  return [process.env.WEBHOOK_SECRET, process.env.WEBHOOK_SECRET_ANTERIOR].filter(Boolean);
}

// Una linea por llamada del agente, para poder ver en los logs de Render que mando (o que NO llego). Express no escribe
// nada por cada peticion, asi que sin esto un 503/404/409 o un 401 por secreto malo no dejan rastro. Nunca va el secreto;
// el telefono se corta a los ultimos 4 digitos.
function registrarLlamada(req, res, secreto) {
  const inicio = Date.now();
  res.once('finish', () => {
    const datos = { ...(req.query ?? {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
    const partes = [];
    if (datos.folio) partes.push(`folio=${String(datos.folio).slice(0, 20)}`);
    if (datos.telefono) partes.push(`tel=***${String(datos.telefono).replace(/\D/g, '').slice(-4)}`);
    if (typeof datos.autoriza === 'boolean') partes.push(`autoriza=${datos.autoriza}`);
    if (datos.monto !== undefined) partes.push(`monto=${String(datos.monto).slice(0, 12)}`);
    const nota = secreto === 'ok' ? '' : ` (secreto ${secreto})`;
    console.log(`[agente] ${req.method} ${req.baseUrl}${req.path === '/' ? '' : req.path} -> ${res.statusCode} en ${Date.now() - inicio} ms${nota}${partes.length ? ` ${partes.join(' ')}` : ''}`);
  });
}

function verificarSecreto(req, res, next) {
  const recibido = req.headers['x-webhook-secret'];
  const validos = secretosValidos();
  // Las comparaciones se hacen contra TODOS los secretos validos (sin cortar en
  // el primero) para que el tiempo de respuesta no delate cual coincidio.
  const coincide = validos.map((s) => iguales(recibido ?? '', s)).some(Boolean);
  if (!recibido || validos.length === 0 || !coincide) {
    registrarLlamada(req, res, !recibido ? 'ausente' : validos.length === 0 ? 'sin configurar en el servidor' : 'incorrecto');
    return res.status(401).json({ error: 'No autorizado.' });
  }
  registrarLlamada(req, res, 'ok');
  next();
}

module.exports = { verificarSecreto };
