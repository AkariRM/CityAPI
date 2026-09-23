// Registra un movimiento en la bitacora de refacciones (movimientos_refacciones,
// la que muestra Stock/Kardex). Hay que llamarla con el mismo `client` de la
// transaccion que cambia refacciones.stock, para que el stock y su
// movimiento se guarden juntos o no se guarden. cantidad se guarda siempre
// positiva; el sentido lo da `tipo` (entrada suma, salida resta).
async function registrarMovimientoRefaccion(client, { refaccionId, sucursalId, tipo, cantidad, motivo, usuarioId }) {
  await client.query(
    `INSERT INTO movimientos_refacciones (refaccion_id, sucursal_id, tipo, cantidad, motivo, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [refaccionId, sucursalId, tipo, Math.abs(cantidad), motivo, usuarioId]
  );
}

module.exports = { registrarMovimientoRefaccion };
