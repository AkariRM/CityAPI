const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Contraseñas para entrar con correo. Mismo bcrypt que el PIN (ver utils/pin.js): por eso el PIN actual de cada
// persona sirve como contraseña mientras dure la transicion (el cifrado es el mismo).
const LARGO_MINIMO = 8;
// bcrypt solo lee los primeros 72 bytes: mas alla de eso dos contraseñas distintas darian el mismo cifrado.
const BYTES_MAXIMOS = 72;

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= LARGO_MINIMO && Buffer.byteLength(password) <= BYTES_MAXIMOS;
}

const MENSAJE_PASSWORD = `La contraseña debe tener al menos ${LARGO_MINIMO} caracteres.`;

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return typeof password === 'string' && !!hash && bcrypt.compareSync(password, hash);
}

// Cifrado de un valor aleatorio que nadie conoce: sirve para invalidar el PIN de quien ya cambio su contraseña.
function hashInservible() {
  return bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
}

// Para gastar el mismo tiempo cuando el correo no existe (no delatar que cuentas existen por lo que tarda la respuesta).
const HASH_FALSO = bcrypt.hashSync('cuenta-inexistente', 10);

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizarCorreo(correo) {
  return typeof correo === 'string' ? correo.trim().toLowerCase() : '';
}

function esCorreoValido(correo) {
  return typeof correo === 'string' && correo.length <= 254 && CORREO_RE.test(correo);
}

module.exports = { isValidPassword, MENSAJE_PASSWORD, hashPassword, verifyPassword, hashInservible, HASH_FALSO, normalizarCorreo, esCorreoValido };
