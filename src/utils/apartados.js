const { textoFechaHoraLocal } = require('./fechas');

// Pasa a 'vencido' los apartados del agente de WhatsApp cuya vigencia ya termino, y
// devuelve el stock: baja stock_apartado y regresa a 'disponible' la unidad IMEI que
// tuvieran. Es lo mismo que hace cancelar, pero el estado propio deja ver que fue por
// tiempo y no porque alguien lo cancelo.
//
// No hay cron/job en este proyecto (igual que marcarCreditosVencidos), asi que se llama
// al inicio de cada lectura o escritura que depende del stock apartado: catalogo
// externo, lista de productos, pantalla de Apartados y los endpoints del agente. Es
// barato (indice parcial idx_apartados_vence) y solo toca filas que de verdad vencieron.
//
// Todo va en UNA sentencia (CTE): es atomica sin necesitar transaccion, y si dos
// llamadas corren a la vez la segunda espera los bloqueos de fila y ya no encuentra
// filas 'activo', asi que el stock nunca se libera dos veces.
// Acepta un client de una transaccion en curso; por defecto usa el pool.
async function liberarApartadosVencidos(queryable) {
  await queryable.query(
    `WITH vencidos AS (
       UPDATE apartados SET estado = 'vencido', updated_at = now()
       WHERE estado = 'activo' AND vence_at IS NOT NULL AND vence_at <= now()
       RETURNING producto_id, sucursal_id, cantidad, unidad_imei_id
     ), stock AS (
       UPDATE inventario i
       SET stock_apartado = GREATEST(i.stock_apartado - v.total, 0), updated_at = now()
       FROM (SELECT producto_id, sucursal_id, sum(cantidad)::int AS total FROM vencidos GROUP BY producto_id, sucursal_id) v
       WHERE i.producto_id = v.producto_id AND i.sucursal_id = v.sucursal_id
       RETURNING 1
     )
     UPDATE unidades_imei SET estado = 'disponible', updated_at = now()
     WHERE estado = 'apartado' AND id IN (SELECT unidad_imei_id FROM vencidos WHERE unidad_imei_id IS NOT NULL)`
  );
}

// Forma en que el agente ve un apartado: sin ids internos ni datos del negocio.
// `fila` trae folio, estado, precio_total, vence_at, producto_nombre y sucursal_nombre.
function apartadoParaAgente(fila) {
  return {
    folio: fila.folio,
    estado: fila.estado,
    equipo: fila.producto_nombre,
    sucursal: fila.sucursal_nombre,
    precio: Number(fila.precio_total),
    // Instante exacto (UTC) y el mismo en texto, ya en hora de la sucursal, para que el
    // agente lo diga tal cual sin convertir zonas horarias.
    vence_en: fila.vence_at ? new Date(fila.vence_at).toISOString() : null,
    vence_texto: fila.vence_at ? textoFechaHoraLocal(fila.vence_at) : null,
  };
}

// Columnas y joins comunes para armar apartadoParaAgente.
const SELECT_APARTADO_AGENTE = `
  SELECT a.id, a.folio, a.estado, a.producto_id, a.precio_total, a.vence_at, a.monto_abonado, a.origen,
         p.nombre AS producto_nombre, s.nombre AS sucursal_nombre
  FROM apartados a
  JOIN productos p ON p.id = a.producto_id
  JOIN sucursales s ON s.id = a.sucursal_id`;

module.exports = { liberarApartadosVencidos, apartadoParaAgente, SELECT_APARTADO_AGENTE };
