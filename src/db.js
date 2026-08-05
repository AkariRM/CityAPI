const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL no está definida — las rutas que usan la base de datos fallarán.');
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  ...(process.env.PG_POOL_MAX ? { max: Number(process.env.PG_POOL_MAX) } : {}),
});

// Sin esto, un error en una conexion inactiva del pool (ej. un corte de red
// momentaneo con Supabase) tumba TODO el proceso de Node, no solo esa query.
pool.on('error', (err) => {
  console.error('Error inesperado en una conexion inactiva del pool:', err.message);
});

module.exports = { pool };
