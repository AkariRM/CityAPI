const { pool } = require('../db');
const { verifySession } = require('../utils/jwt');

// El token solo prueba que el usuario inicio sesion alguna vez en las
// ultimas 12h — aqui se revalida contra la base de datos en cada peticion
// para que desactivar una cuenta o cambiarle el rol surta efecto de inmediato,
// en vez de esperar a que expire un token ya emitido.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta el token de sesión.' });

  let payload;
  try {
    payload = verifySession(token);
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }

  try {
    const { rows } = await pool.query('SELECT rol, activo FROM usuarios WHERE id = $1', [payload.sub]);
    const usuario = rows[0];
    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
    req.usuario = { sub: payload.sub, rol: usuario.rol };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario?.rol)) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
