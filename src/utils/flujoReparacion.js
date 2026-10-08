const { registrarMovimientoRefaccion } = require('./movimientosRefacciones');

const dinero = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Estados en los que las piezas del folio todavia no se usaron de verdad: se apartan del inventario al agregarlas
// (en el diagnostico, para cotizar) pero el trabajo no empieza hasta que el cliente autoriza.
const ESTADOS_ANTES_DE_REPARAR = ['recibido', 'diagnostico', 'esperando_autorizacion'];

// Regresa al inventario las piezas que se apartaron para cotizar y las quita del folio. Hay que llamarla con el
// `client` de la transaccion que cancela el folio. Devuelve cuantas piezas se devolvieron.
async function devolverPiezas(client, { reparacionId, folio, usuarioId }) {
  const { rows } = await client.query(`SELECT refaccion_id, cantidad FROM reparacion_refacciones WHERE reparacion_id = $1`, [reparacionId]);
  for (const pieza of rows) {
    if (!pieza.refaccion_id) continue;
    await client.query(`UPDATE refacciones SET stock = stock + $1 WHERE id = $2`, [pieza.cantidad, pieza.refaccion_id]);
    await registrarMovimientoRefaccion(client, {
      refaccionId: pieza.refaccion_id, sucursalId: null, tipo: 'entrada', cantidad: pieza.cantidad,
      motivo: `Devuelta: se canceló la reparación ${folio}`, usuarioId,
    });
  }
  if (rows.length > 0) {
    await client.query(`DELETE FROM reparacion_refacciones WHERE reparacion_id = $1`, [reparacionId]);
    await client.query(`UPDATE reparaciones SET costo_refacciones = 0, total = costo_mano_obra WHERE id = $1`, [reparacionId]);
  }
  return rows.length;
}

// El cliente no autorizo la cotizacion: el folio se cancela directo (sin renegociar) y las piezas apartadas
// regresan al inventario. r: { id, folio }. `nota`: texto del historial.
async function cancelarPorRechazo(client, r, { usuarioId, nota }) {
  await client.query(
    `UPDATE reparaciones SET estado = 'cancelado', cotizacion_rechazada_at = NULL, cotizacion_rechazada_monto = NULL WHERE id = $1`,
    [r.id]
  );
  const piezas = await devolverPiezas(client, { reparacionId: r.id, folio: r.folio, usuarioId });
  await client.query(
    `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id) VALUES ($1, 'cancelado', $2, $3)`,
    [r.id, piezas > 0 ? `${nota} Las piezas apartadas regresaron al inventario.` : nota, usuarioId]
  );
}

module.exports = { ESTADOS_ANTES_DE_REPARAR, devolverPiezas, cancelarPorRechazo, dinero };
