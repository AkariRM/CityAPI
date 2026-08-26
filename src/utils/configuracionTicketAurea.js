const { pool } = require('../db');

// Fila unica (singleton) de Áurea — mismo patron que utils/configuracionTicket.js
// de CityPhone, solo que sobre su propia tabla.
async function obtenerConfiguracionTicketAurea(queryable = pool) {
  const { rows } = await queryable.query(`SELECT * FROM aurea_configuracion_ticket LIMIT 1`);
  if (rows[0]) return rows[0];

  const creada = await queryable.query(`INSERT INTO aurea_configuracion_ticket DEFAULT VALUES RETURNING *`);
  return creada.rows[0];
}

module.exports = { obtenerConfiguracionTicketAurea };
