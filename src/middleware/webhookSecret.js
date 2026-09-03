// Autenticacion para endpoints que llama un servicio externo (ej. n8n de
// TRAI) hacia nosotros, sin sesion de usuario de por medio — no se puede
// usar requireAuth. Se valida con el mismo secreto compartido que ya usamos
// para llamarlos a ellos (X-Webhook-Secret contra WEBHOOK_SECRET), en
// sentido inverso.
function verificarSecreto(req, res, next) {
  if (!process.env.WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

module.exports = { verificarSecreto };
