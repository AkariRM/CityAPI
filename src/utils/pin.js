const bcrypt = require('bcryptjs');

const PIN_PATTERN = /^\d{4}$/;

function isValidPin(pin) {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

function hashPin(pin) {
  return bcrypt.hashSync(pin, 10);
}

function verifyPin(pin, hash) {
  return bcrypt.compareSync(pin, hash);
}

module.exports = { isValidPin, hashPin, verifyPin };
