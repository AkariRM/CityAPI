const { pool } = require('../db');

// Fila unica (singleton). Se crea con los valores DEFAULT la primera vez que se pide.
async function obtenerConfiguracionTicket() {
  const { rows } = await pool.query(`SELECT * FROM configuracion_ticket LIMIT 1`);
  if (rows[0]) return rows[0];

  const creada = await pool.query(`INSERT INTO configuracion_ticket DEFAULT VALUES RETURNING *`);
  return creada.rows[0];
}

module.exports = { obtenerConfiguracionTicket };
