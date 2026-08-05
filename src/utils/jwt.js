const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = '12h';

function signSession(usuario) {
  if (!SECRET) throw new Error('JWT_SECRET no está configurada.');
  return jwt.sign({ sub: usuario.id, rol: usuario.rol }, SECRET, { expiresIn: EXPIRES_IN });
}

function verifySession(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { signSession, verifySession };
