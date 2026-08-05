// Genera el hash bcrypt de un PIN para sembrar el primer usuario admin a mano
// en Supabase (SQL editor), sin tener que escribir el PIN real en ningun chat.
// Uso: node scripts/hash-pin.js 1234
const bcrypt = require('bcryptjs');

const pin = process.argv[2];
if (!/^\d{4}$/.test(pin ?? '')) {
  console.error('Uso: node scripts/hash-pin.js 1234  (debe ser exactamente 4 dígitos)');
  process.exit(1);
}

console.log(bcrypt.hashSync(pin, 10));
