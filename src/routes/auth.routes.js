const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyPin } = require('../utils/pin');
const { signSession } = require('../utils/jwt');

const router = express.Router();

const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

const ROLES_VALIDOS = ['admin', 'vendedor', 'tecnico', 'community_manager'];

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
router.get('/usuarios', async (req, res) => {
  const { rol } = req.query;
  if (!rol || !ROLES_VALIDOS.includes(rol)) {
    return res.status(400).json({ error: 'rol inválido o faltante.' });
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.sucursal_id, s.nombre AS sucursal_nombre
     FROM usuarios u
     LEFT JOIN sucursales s ON s.id = u.sucursal_id
     WHERE u.rol = $1 AND u.activo = true
     ORDER BY u.nombre`,
    [rol]
  );
  res.json(rows);
});

router.post('/login', loginLimiter, async (req, res) => {
  const { usuario_id, pin } = req.body ?? {};
  if (!usuario_id || !pin) {
    return res.status(400).json({ error: 'usuario_id y pin son requeridos.' });
  }

  const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1 AND activo = true', [usuario_id]);
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
    },
  });
});

module.exports = router;
