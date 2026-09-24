const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');
const { liberarApartadosVencidos, apartadoParaAgente, SELECT_APARTADO_AGENTE } = require('../utils/apartados');

const router = express.Router();

// Apartados que hace el agente de WhatsApp (TRAI) a nombre de un cliente.
//
// Reglas (definidas con el negocio):
//  - Vigencia y limite por telefono los define el negocio en Configuracion; el agente
//    no manda ninguno de los dos. Al vencer, el apartado pasa a 'vencido' y el equipo
//    vuelve al catalogo (ver utils/apartados.js).
//  - El cliente se identifica por telefono (principal o adicional). Si no existe se
//    registra con el nombre y telefono que manda el agente (origen 'agente_whatsapp').
//  - La sucursal la elige el sistema: la que tenga mas existencia disponible del equipo.
//  - Una pieza por solicitud, sin anticipo. El precio es SIEMPRE el publico del catalogo.
//  - Repetir la misma solicitud (mismo telefono y mismo equipo) devuelve el apartado que
//    ya existe, no crea otro.
//  - Crear se puede apagar al instante (AGENTE_APARTAR_ACTIVO); consultar y cancelar no,
//    para que el cliente siempre pueda liberar lo suyo.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ultimos 10 digitos del telefono, o null si no hay 10 (mismo criterio que contacto-externo
// y reparacion-externa: WhatsApp manda E.164, aqui se captura en texto libre).
function ultimosDiezDigitos(telefono) {
  const digitos = String(telefono ?? '').replace(/\D/g, '').slice(-10);
  return digitos.length === 10 ? digitos : null;
}

// Condicion SQL: el telefono es el principal o el adicional del cliente `alias`. $N es el
// telefono ya normalizado.
const coincideTelefono = (alias, n) =>
  `(right(regexp_replace(${alias}.telefono, '\\D', '', 'g'), 10) = $${n}
    OR right(regexp_replace(${alias}.telefono_adicional, '\\D', '', 'g'), 10) = $${n})`;

const falla = (statusCode, error, extra = {}) => Object.assign(new Error(error), { statusCode, cuerpo: { error, ...extra } });

function responderError(res, err) {
  if (err.statusCode) return res.status(err.statusCode).json(err.cuerpo);
  console.error(err);
  return res.status(500).json({ error: 'Error interno del servidor.' });
}

// Apartados activos del agente para un telefono, el que vence antes primero.
async function apartadosActivosDelTelefono(db, telefono10) {
  const { rows } = await db.query(
    `${SELECT_APARTADO_AGENTE}
     JOIN clientes c ON c.id = a.cliente_id
     WHERE a.origen = 'agente' AND a.estado = 'activo' AND ${coincideTelefono('c', 1)}
     ORDER BY a.vence_at ASC NULLS LAST, a.created_at ASC`,
    [telefono10]
  );
  return rows;
}

// GET /apartado-externo?telefono=+523531234567
// Los apartados activos que el agente le hizo a ese telefono (arreglo, [] si no tiene).
router.get('/', verificarSecreto, async (req, res) => {
  const telefono10 = ultimosDiezDigitos(req.query.telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  await liberarApartadosVencidos(pool);
  res.json((await apartadosActivosDelTelefono(pool, telefono10)).map(apartadoParaAgente));
});

// POST /apartado-externo   { producto_id, telefono, nombre }
// 201 = apartado nuevo, 200 = ya existia uno igual (mismo telefono y equipo).
router.post('/', verificarSecreto, async (req, res) => {
  if (process.env.AGENTE_APARTAR_ACTIVO !== 'true') {
    return res.status(503).json({ error: 'El apartado por WhatsApp está desactivado.' });
  }

  const { producto_id, telefono, nombre } = req.body ?? {};
  if (typeof producto_id !== 'string' || !UUID.test(producto_id.trim())) {
    return res.status(400).json({ error: 'producto_id es requerido y debe ser uuid.' });
  }
  const telefono10 = ultimosDiezDigitos(telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  if (nombre != null && typeof nombre !== 'string') return res.status(400).json({ error: 'nombre debe ser texto.' });
  const nombreCliente = (nombre ?? '').replace(/\s+/g, ' ').trim();
  if (nombreCliente.length > 120) return res.status(400).json({ error: 'nombre es demasiado largo (máximo 120 caracteres).' });
  const productoId = producto_id.trim();

  // Libera lo vencido ANTES de abrir la transaccion (fuera de ella, para respetar el
  // mismo orden de bloqueos que el resto del sistema) y lee la configuracion vigente.
  await liberarApartadosVencidos(pool);
  const config = await obtenerConfiguracionTicket(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa las solicitudes del MISMO telefono: dos mensajes seguidos no pueden pasar
    // a la vez el limite de apartados. (Distintos telefonos por el mismo equipo se
    // serializan mas abajo, con el bloqueo de la fila de inventario.)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`apartado-agente:${telefono10}`]);

    const producto = (await client.query(
      `SELECT id, nombre, tipo, precio_venta, usa_imei FROM productos WHERE id = $1 AND activo = true`,
      [productoId]
    )).rows[0];
    if (!producto) throw falla(404, 'Ese equipo ya no está disponible.');
    if (producto.tipo === 'servicio') throw falla(400, 'Los servicios no se pueden apartar.');
    if (!(Number(producto.precio_venta) > 0)) throw falla(409, 'Ese equipo no tiene precio público, un asesor debe atender la solicitud.');

    // Reintento o limite: lo que ese telefono ya tiene apartado con el agente.
    const activos = await apartadosActivosDelTelefono(client, telefono10);
    const mismo = activos.find((a) => a.producto_id === productoId);
    if (mismo) {
      await client.query('COMMIT');
      return res.status(200).json({ ...apartadoParaAgente(mismo), ya_existia: true });
    }
    if (activos.length >= config.agente_apartado_max_por_telefono) {
      throw falla(
        409,
        config.agente_apartado_max_por_telefono === 1
          ? 'Ya tiene un equipo apartado. Para apartar otro debe recogerlo o cancelarlo primero.'
          : `Ya tiene ${activos.length} equipos apartados, que es el máximo permitido. Para apartar otro debe recoger o cancelar alguno.`,
        { apartado: apartadoParaAgente(activos[0]), apartados: activos.map(apartadoParaAgente) }
      );
    }

    // Cliente: por telefono (el que lo tiene como principal primero, luego el mas antiguo);
    // si no existe se registra con lo que manda el agente.
    let clienteId = (await client.query(
      `SELECT c.id FROM clientes c
       WHERE ${coincideTelefono('c', 1)}
       ORDER BY (right(regexp_replace(c.telefono, '\\D', '', 'g'), 10) = $1) DESC NULLS LAST, c.created_at ASC
       LIMIT 1`,
      [telefono10]
    )).rows[0]?.id;
    if (!clienteId) {
      if (!nombreCliente) throw falla(400, 'nombre es requerido: ese teléfono no está registrado como cliente.');
      clienteId = (await client.query(
        `INSERT INTO clientes (nombre, telefono, origen) VALUES ($1, $2, 'agente_whatsapp') RETURNING id`,
        [nombreCliente, telefono10]
      )).rows[0].id;
    }

    // Sucursal: bloquea las filas de inventario del equipo (en orden fijo) y toma la que
    // tenga mas existencia disponible. Si otra solicitud se lo llevo antes, aqui ya se ve.
    const inventario = (await client.query(
      `SELECT sucursal_id, stock_cantidad - stock_apartado AS disponible
       FROM inventario WHERE producto_id = $1 ORDER BY sucursal_id FOR UPDATE`,
      [productoId]
    )).rows;
    const elegida = inventario
      .filter((i) => i.disponible > 0)
      .sort((a, b) => b.disponible - a.disponible)[0];
    if (!elegida) throw falla(409, 'Ese equipo ya no está disponible.');

    // Equipos con IMEI: se aparta una unidad concreta si hay una disponible en esa sucursal
    // (no todas las piezas tienen su IMEI capturado; sin unidad solo se aparta la existencia).
    let unidadId = null;
    if (producto.usa_imei) {
      unidadId = (await client.query(
        `SELECT id FROM unidades_imei
         WHERE producto_id = $1 AND sucursal_id = $2 AND estado = 'disponible'
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [productoId, elegida.sucursal_id]
      )).rows[0]?.id ?? null;
      if (unidadId) await client.query(`UPDATE unidades_imei SET estado = 'apartado', updated_at = now() WHERE id = $1`, [unidadId]);
    }
    await client.query(
      `UPDATE inventario SET stock_apartado = stock_apartado + 1, updated_at = now() WHERE producto_id = $1 AND sucursal_id = $2`,
      [productoId, elegida.sucursal_id]
    );

    const nuevo = (await client.query(
      `INSERT INTO apartados (cliente_id, sucursal_id, producto_id, unidad_imei_id, cantidad, precio_total, monto_abonado, usuario_id, origen, vence_at)
       VALUES ($1, $2, $3, $4, 1, $5, 0, NULL, 'agente', now() + make_interval(hours => $6::int))
       RETURNING id`,
      [clienteId, elegida.sucursal_id, productoId, unidadId, producto.precio_venta, config.agente_apartado_horas]
    )).rows[0];

    const fila = (await client.query(`${SELECT_APARTADO_AGENTE} WHERE a.id = $1`, [nuevo.id])).rows[0];
    await client.query('COMMIT');
    res.status(201).json({ ...apartadoParaAgente(fila), ya_existia: false });
  } catch (err) {
    await client.query('ROLLBACK');
    responderError(res, err);
  } finally {
    client.release();
  }
});

// POST /apartado-externo/cancelar   { folio, telefono }
// El cliente cancela SU apartado por WhatsApp. Solo apartados hechos por el agente, y el
// telefono tiene que ser el del cliente dueño (si no, 404 igual que si no existiera). Si ya
// tiene un abono lo atiende el personal en tienda. Es idempotente.
router.post('/cancelar', verificarSecreto, async (req, res) => {
  const { folio, telefono } = req.body ?? {};
  if (typeof folio !== 'string' || !folio.trim()) return res.status(400).json({ error: 'folio es requerido.' });
  const telefono10 = ultimosDiezDigitos(telefono);
  if (!telefono10) return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });

  await liberarApartadosVencidos(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = (await client.query(
      `SELECT a.id, a.estado, a.monto_abonado, a.producto_id, a.sucursal_id, a.cantidad, a.unidad_imei_id
       FROM apartados a JOIN clientes c ON c.id = a.cliente_id
       WHERE a.folio = $1 AND a.origen = 'agente' AND ${coincideTelefono('c', 2)}
       FOR UPDATE OF a`,
      [folio.trim().toUpperCase(), telefono10]
    )).rows[0];
    if (!actual) throw falla(404, 'No encontramos un apartado con ese folio para ese teléfono.');

    const leer = async () => apartadoParaAgente((await client.query(`${SELECT_APARTADO_AGENTE} WHERE a.id = $1`, [actual.id])).rows[0]);

    if (actual.estado === 'cancelado') {
      await client.query('COMMIT');
      return res.json(await leer());
    }
    if (actual.estado !== 'activo') {
      throw falla(409, actual.estado === 'vencido' ? 'Ese apartado ya venció.' : 'Ese apartado ya no está activo.', { apartado: await leer() });
    }
    if (Number(actual.monto_abonado) > 0) {
      throw falla(409, 'Ese apartado ya tiene un abono registrado: la cancelación la atiende un asesor en tienda.', { apartado: await leer() });
    }

    await client.query(
      `UPDATE inventario SET stock_apartado = GREATEST(stock_apartado - $1, 0), updated_at = now() WHERE producto_id = $2 AND sucursal_id = $3`,
      [actual.cantidad, actual.producto_id, actual.sucursal_id]
    );
    if (actual.unidad_imei_id) {
      await client.query(`UPDATE unidades_imei SET estado = 'disponible', updated_at = now() WHERE id = $1 AND estado = 'apartado'`, [actual.unidad_imei_id]);
    }
    await client.query(`UPDATE apartados SET estado = 'cancelado', updated_at = now() WHERE id = $1`, [actual.id]);

    const respuesta = await leer();
    await client.query('COMMIT');
    res.json(respuesta);
  } catch (err) {
    await client.query('ROLLBACK');
    responderError(res, err);
  } finally {
    client.release();
  }
});

module.exports = router;
