const { pool } = require('../db');

// Fila unica (singleton). Se crea con los valores DEFAULT la primera vez que se pide.
// Acepta un client de una transaccion en curso (para no abrir una segunda
// conexion mientras la primera sigue ocupada); por defecto usa el pool.
async function obtenerConfiguracionTicket(queryable = pool) {
  const { rows } = await queryable.query(`SELECT * FROM configuracion_ticket LIMIT 1`);
  if (rows[0]) return rows[0];

  const creada = await queryable.query(`INSERT INTO configuracion_ticket DEFAULT VALUES RETURNING *`);
  return creada.rows[0];
}

module.exports = { obtenerConfiguracionTicket };
