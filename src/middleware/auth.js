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
    const { rows } = await pool.query(
      `SELECT u.rol, u.activo, u.empresa_id, e.slug AS empresa_slug
       FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
       WHERE u.id = $1`,
      [payload.sub]
    );
    const usuario = rows[0];
    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
    req.usuario = { sub: payload.sub, rol: usuario.rol, empresa_id: usuario.empresa_id, empresa_slug: usuario.empresa_slug };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const rol = req.usuario?.rol;
    // 'dueño' es superior a 'admin' en la jerarquia (ve/opera ambas
    // empresas) — cualquier ruta que acepte 'admin' debe dejarlo pasar
    // tambien, sin tener que agregar 'dueño' a mano en cada una de las
    // ~40 rutas que ya usaban requireRole('admin', ...).
    const puedeComoDueno = rol === 'dueño' && roles.includes('admin');
    if (!roles.includes(rol) && !puedeComoDueno) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    }
    next();
  };
}

// 'dueño' siempre pasa (ve todas las empresas); cualquier otro rol solo si
// su empresa asignada coincide con el slug pedido.
function requireEmpresa(slug) {
  return (req, res, next) => {
    if (req.usuario?.rol === 'dueño' || req.usuario?.empresa_slug === slug) return next();
    return res.status(403).json({ error: 'No tienes acceso a esta empresa.' });
  };
}

module.exports = { requireAuth, requireRole, requireEmpresa };
