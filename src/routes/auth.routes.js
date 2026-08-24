const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyPin } = require('../utils/pin');
const { signSession } = require('../utils/jwt');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

const ROLES_VALIDOS = ['dueño', 'admin', 'vendedor', 'tecnico', 'community_manager', 'pto'];

// Ademas del bloqueo por cuenta (abajo), esto limita cuantos intentos de
// login puede hacer una misma IP en total — evita que alguien pruebe PINs
// contra muchas cuentas distintas para esquivar el bloqueo por cuenta.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión desde este dispositivo. Intenta de nuevo en unos minutos.' },
});

// Lista publica (sin datos sensibles) para la pantalla de "elige tu usuario".
// empresa (slug) es requerido para no mezclar cuentas de CityPhone y Aurea
// en la misma lista — 'dueño' aparece en ambas sin importar el filtro,
// porque puede operar cualquiera de las dos.
router.get('/usuarios', async (req, res) => {
  const { rol, empresa } = req.query;
  if (!rol || !ROLES_VALIDOS.includes(rol)) {
    return res.status(400).json({ error: 'rol inválido o faltante.' });
  }
  if (!empresa) {
    return res.status(400).json({ error: 'empresa es requerida.' });
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.sucursal_id, s.nombre AS sucursal_nombre
     FROM usuarios u
     LEFT JOIN sucursales s ON s.id = u.sucursal_id
     LEFT JOIN empresas e ON e.id = u.empresa_id
     WHERE u.rol = $1 AND u.activo = true AND (e.slug = $2 OR u.rol = 'dueño')
     ORDER BY u.nombre`,
    [rol, empresa]
  );
  res.json(rows);
});

router.post('/login', loginLimiter, async (req, res) => {
  const { usuario_id, pin } = req.body ?? {};
  if (!usuario_id || !pin) {
    return res.status(400).json({ error: 'usuario_id y pin son requeridos.' });
  }

  const { rows } = await pool.query(
    `SELECT u.*, s.nombre AS sucursal_nombre,
            e.slug AS empresa_slug, e.nombre AS empresa_nombre,
            ep.slug AS empresa_preferida_slug
     FROM usuarios u
     LEFT JOIN sucursales s ON s.id = u.sucursal_id
     LEFT JOIN empresas e ON e.id = u.empresa_id
     LEFT JOIN empresas ep ON ep.id = u.empresa_preferida_id
     WHERE u.id = $1 AND u.activo = true`,
    [usuario_id]
  );
  const usuario = rows[0];
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

  if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
    const segundos = Math.ceil((new Date(usuario.bloqueado_hasta) - new Date()) / 1000);
    return res.status(423).json({ error: `Cuenta bloqueada. Intenta de nuevo en ${segundos}s.`, locked: true });
  }

  const pinOk = verifyPin(pin, usuario.pin_hash);

  if (!pinOk) {
    const intentos = usuario.intentos_fallidos + 1;
    const bloqueado = intentos >= MAX_INTENTOS;
    await pool.query(
      `UPDATE usuarios SET intentos_fallidos = $1, bloqueado_hasta = $2 WHERE id = $3`,
      [bloqueado ? 0 : intentos, bloqueado ? new Date(Date.now() + BLOQUEO_MS) : null, usuario.id]
    );
    if (bloqueado) {
      return res.status(423).json({ error: `Demasiados intentos. Cuenta bloqueada ${BLOQUEO_MS / 60000} min.`, locked: true });
    }
    return res.status(401).json({ error: `PIN incorrecto (${intentos}/${MAX_INTENTOS} intentos).`, intentos });
  }

  await pool.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [usuario.id]);

  const token = signSession(usuario);
  res.json({
    token,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      rol: usuario.rol,
      sucursal_id: usuario.sucursal_id,
      sucursal_nombre: usuario.sucursal_nombre,
      empresa_id: usuario.empresa_id,
      empresa_slug: usuario.empresa_slug,
      empresa_nombre: usuario.empresa_nombre,
      // Solo tiene sentido para 'dueño' (empresa_id es NULL) — con qué
      // empresa debe arrancar la app la próxima vez, en cualquier
      // dispositivo. Si nunca ha elegido una, cae en 'cityphone'.
      empresa_preferida_slug: usuario.empresa_preferida_slug ?? 'cityphone',
    },
  });
});

// Lista de empresas activas — la usa el switcher del Dueño para mapear
// "Áurea"/"CityPhone" a su id real antes de mandarlo a /empresa-preferida.
router.get('/empresas', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT id, slug, nombre FROM empresas WHERE activo = true ORDER BY nombre`);
  res.json(rows);
});

// Solo 'dueño' tiene sentido cambiando esto — cualquier otro rol ya vive en
// una sola empresa fija. Persiste server-side (no localStorage) porque es
// una preferencia de la PERSONA, no del dispositivo — a diferencia de la
// sucursal fija por equipo (ver deviceSucursal.js en el frontend).
router.patch('/empresa-preferida', requireAuth, requireRole('dueño'), async (req, res) => {
  const { empresa_id } = req.body ?? {};
  if (!empresa_id) return res.status(400).json({ error: 'empresa_id es requerido.' });

  const { rows } = await pool.query(
    `UPDATE usuarios SET empresa_preferida_id = $1 WHERE id = $2
     RETURNING (SELECT slug FROM empresas WHERE id = $1) AS empresa_preferida_slug`,
    [empresa_id, req.usuario.sub]
  );
  if (!rows[0]?.empresa_preferida_slug) return res.status(400).json({ error: 'Empresa no encontrada.' });
  res.json({ empresa_preferida_slug: rows[0].empresa_preferida_slug });
});

module.exports = router;
