// Marca como 'vencido' los creditos activos cuya fecha_vencimiento ya paso.
// No hay cron/job en este proyecto, asi que esto se llama al inicio de
// cada lectura relevante (GET /creditos, GET /clientes) -- es barato
// (usa idx_creditos_estado) y solo toca filas que de verdad cambiaron.
// Acepta un client de una transaccion en curso; por defecto usa el pool.
async function marcarCreditosVencidos(queryable) {
  await queryable.query(
    `UPDATE creditos SET estado = 'vencido', updated_at = now()
     WHERE estado = 'activo' AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento < CURRENT_DATE`
  );
}

module.exports = { marcarCreditosVencidos };
