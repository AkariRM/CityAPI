const { pool } = require('../db');
const { verifySession } = require('../utils/jwt');

// El token solo prueba que el usuario inicio sesion alguna vez en las
// ultimas 12h — aqui se revalida contra la base de datos en cada peticion
// para que desactivar una cuenta o cambiarle el rol surta efecto de inmediato,
// en vez de esperar a que expire un token ya emitido.
async function requireAuth(req, res, next) {
  // Ya autenticada en esta misma peticion (ej. el guardia de empresa montado en index.js antes del router, que tambien
  // lo trae): no se vuelve a consultar la base. req.usuario solo lo escribe este middleware, nunca viene del cliente.
  if (req.usuario) return next();
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
      `SELECT u.rol, u.activo, u.empresa_id, u.sucursal_id, e.slug AS empresa_slug
       FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
       WHERE u.id = $1`,
      [payload.sub]
    );
    const usuario = rows[0];
    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
    req.usuario = {
      sub: payload.sub, rol: usuario.rol, empresa_id: usuario.empresa_id, empresa_slug: usuario.empresa_slug, sucursal_id: usuario.sucursal_id,
    };
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

// Guardia de las rutas que son SOLO de CityPhone (ventas, nominas, finanzas, reparaciones...). Las de Áurea ya exigen
// requireEmpresa('aurea'); sin este guardia un Supervisor de Áurea (rol 'admin', sin sucursal) podia leer y operar los datos
// de CityPhone, porque los roles no distinguen empresa. El dueño siempre pasa. Una cuenta sin empresa asignada (cuentas muy
// antiguas; las nuevas siempre la traen) se trata como de CityPhone para no dejarla fuera: bloquea solo a quien es de otra.
function soloCityPhone(req, res, next) {
  const empresa = req.usuario?.empresa_slug;
  if (req.usuario?.rol === 'dueño' || !empresa || empresa === 'cityphone') return next();
  return res.status(403).json({ error: 'No tienes acceso a esta empresa.' });
}

// Mismo criterio de jerarquia que requireRole()'s puedeComoDueno, pero para
// los chequeos de rol escritos a mano dentro del cuerpo de una ruta (ej.
// "solo el admin puede omitir sucursal_id") que no pasan por requireRole y
// por eso no heredan ese passthrough automaticamente.
function esAdminODueno(rol) {
  return rol === 'admin' || rol === 'dueño';
}

module.exports = { requireAuth, requireRole, requireEmpresa, soloCityPhone, esAdminODueno };
