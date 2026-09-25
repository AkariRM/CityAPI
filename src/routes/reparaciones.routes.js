const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');
const { registrarMovimientoRefaccion } = require('../utils/movimientosRefacciones');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'tecnico', 'vendedor'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Un tecnico solo ve las reparaciones que tiene asignadas (tecnico_id): admin/supervisor las
// asignan y quitan, y el vendedor sigue viendo todas (recibe y entrega). Devuelve el id a filtrar,
// o null si el rol ve todo.
const idDelTecnico = (req) => (req.usuario.rol === 'tecnico' ? req.usuario.sub : null);

// Toda ruta con :id (detalle, notificaciones, refacciones, fotos, cambios...) pasa por aqui: si
// la reparacion es de otro tecnico (o no tiene tecnico) responde 404, igual que si no existiera,
// para no revelar que existe. Si no existe, la ruta misma responde su 404 de siempre.
router.param('id', async (req, res, next, id) => {
  if (req.usuario?.rol !== 'tecnico' || !UUID_RE.test(id)) return next();
  const { rows } = await pool.query(`SELECT tecnico_id FROM reparaciones WHERE id = $1`, [id]);
  if (rows[0] && rows[0].tecnico_id !== req.usuario.sub) return res.status(404).json({ error: 'Reparación no encontrada.' });
  next();
});

const ESTADOS_VALIDOS = ['recibido', 'diagnostico', 'esperando_autorizacion', 'reparacion', 'listo', 'entregado', 'cancelado'];
const PRIORIDADES_VALIDAS = ['baja', 'media', 'alta'];
const METODOS_PAGO_VALIDOS = ['efectivo', 'tarjeta'];

// IMPORTANTE: esta ruta especifica va ANTES de "/:id" para que Express no la
// confunda con una busqueda por id (que fallaria con "reporte" como uuid).
router.get('/refacciones/reporte', async (req, res) => {
  const { desde, hasta, sucursal_id } = req.query;
  const { rows } = await pool.query(
    `SELECT rr.id, r.folio, rr.producto_id, rr.refaccion_id, COALESCE(p.nombre, ref.nombre) AS producto_nombre, rr.cantidad, rr.costo, r.created_at AS fecha
     FROM reparacion_refacciones rr
     JOIN reparaciones r ON r.id = rr.reparacion_id
     LEFT JOIN productos p ON p.id = rr.producto_id
     LEFT JOIN refacciones ref ON ref.id = rr.refaccion_id
     WHERE ($1::timestamptz IS NULL OR r.created_at >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
       AND ($3::uuid IS NULL OR r.sucursal_id = $3::uuid)
       AND ($4::uuid IS NULL OR r.tecnico_id = $4::uuid)
     ORDER BY r.created_at DESC`,
    [desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null, sucursal_id || null, idDelTecnico(req)]
  );
  res.json(rows);
});

// Igual que arriba, va antes de "/:id". Solo admin (es un reporte de
// desempeño, como los reportes financieros). Agrupa por tecnico_id (incluye
// NULL como "sin asignar"); dias_promedio se calcula de recepcion a la
// primera vez que el folio paso por 'entregado' en el historial.
router.get('/reporte-tecnicos', requireRole('admin'), async (req, res) => {
  const { desde, hasta, sucursal_id } = req.query;
  const { rows } = await pool.query(
    `WITH entregas AS (
       SELECT reparacion_id, MIN(created_at) AS fecha_entrega
       FROM reparacion_historial
       WHERE estado = 'entregado'
       GROUP BY reparacion_id
     )
     SELECT r.tecnico_id, t.nombre AS tecnico_nombre,
            count(*)::int AS folios_totales,
            count(*) FILTER (WHERE r.estado = 'entregado')::int AS folios_entregados,
            COALESCE(sum(r.total), 0) AS total_facturado,
            AVG(EXTRACT(EPOCH FROM (e.fecha_entrega - r.created_at)) / 86400) FILTER (WHERE e.fecha_entrega IS NOT NULL) AS dias_promedio
     FROM reparaciones r
     LEFT JOIN usuarios t ON t.id = r.tecnico_id
     LEFT JOIN entregas e ON e.reparacion_id = r.id
     WHERE ($1::timestamptz IS NULL OR r.created_at >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
       AND ($3::uuid IS NULL OR r.sucursal_id = $3::uuid)
     GROUP BY r.tecnico_id, t.nombre
     ORDER BY total_facturado DESC`,
    [desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null, sucursal_id || null]
  );
  res.json(rows);
});

// desde/hasta son opcionales (los usa la pantalla de Historial; el panel
// Kanban los deja sin mandar y ve todo, igual que antes).
router.get('/', async (req, res) => {
  const { estado, tecnico_id, sucursal_id, q, desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT r.id, r.folio, r.cliente_id, c.nombre AS cliente_nombre, r.sucursal_id,
            r.equipo_marca, r.equipo_modelo, r.imei_equipo, r.problema_reportado, r.diagnostico,
            r.estado, r.prioridad, r.tecnico_id, t.nombre AS tecnico_nombre,
            r.costo_mano_obra, r.costo_refacciones, r.total, r.garantia_dias,
            r.origen_reparacion, r.producto_id, p.nombre AS producto_nombre, r.unidad_imei_id, r.created_at, r.updated_at,
            (r.estado = 'esperando_autorizacion' AND r.cotizacion_rechazada_at IS NOT NULL AND r.cotizacion_rechazada_monto = r.total) AS cotizacion_rechazada
     FROM reparaciones r
     LEFT JOIN clientes c ON c.id = r.cliente_id
     LEFT JOIN productos p ON p.id = r.producto_id
     LEFT JOIN usuarios t ON t.id = r.tecnico_id
     WHERE ($1::text IS NULL OR r.estado::text = $1)
       AND ($2::uuid IS NULL OR r.tecnico_id = $2::uuid)
       AND ($3::uuid IS NULL OR r.sucursal_id = $3::uuid)
       AND ($4::text IS NULL OR r.folio ILIKE '%' || $4 || '%' OR c.nombre ILIKE '%' || $4 || '%' OR r.imei_equipo ILIKE '%' || $4 || '%')
       AND ($5::timestamptz IS NULL OR r.created_at >= $5::timestamptz)
       AND ($6::timestamptz IS NULL OR r.created_at < $6::timestamptz)
       AND ($7::uuid IS NULL OR r.tecnico_id = $7::uuid)
     ORDER BY r.created_at DESC`,
    [estado || null, tecnico_id || null, sucursal_id || null, q || null, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null, idDelTecnico(req)]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const reparacionResult = await pool.query(
    `SELECT r.id, r.folio, r.cliente_id, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono, c.telefono_adicional AS cliente_telefono_adicional, r.sucursal_id,
            s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
            r.equipo_marca, r.equipo_modelo, r.imei_equipo, r.equipo_contrasena, r.equipo_enciende, r.problema_reportado, r.diagnostico,
            r.estado, r.prioridad, r.tecnico_id, t.nombre AS tecnico_nombre,
            r.costo_mano_obra, r.costo_refacciones, r.total, r.garantia_dias, r.monto_pagado,
            r.fecha_estimada_entrega, r.nota_para_cliente, r.checklist_revision,
            r.cotizacion_rechazada_at, r.cotizacion_rechazada_monto,
            (r.estado = 'esperando_autorizacion' AND r.cotizacion_rechazada_at IS NOT NULL AND r.cotizacion_rechazada_monto = r.total) AS cotizacion_rechazada,
            r.origen_reparacion, r.producto_id, prod.nombre AS producto_nombre, prod.activo AS producto_activo, r.unidad_imei_id, r.created_at, r.updated_at
     FROM reparaciones r
     LEFT JOIN clientes c ON c.id = r.cliente_id
     JOIN sucursales s ON s.id = r.sucursal_id
     LEFT JOIN usuarios t ON t.id = r.tecnico_id
     LEFT JOIN productos prod ON prod.id = r.producto_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  const reparacion = reparacionResult.rows[0];
  if (!reparacion) return res.status(404).json({ error: 'Reparación no encontrada.' });

  const historial = await pool.query(
    `SELECT h.id, h.estado, h.nota, h.usuario_id, u.nombre AS usuario_nombre, h.created_at
     FROM reparacion_historial h
     LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.reparacion_id = $1
     ORDER BY h.created_at ASC`,
    [req.params.id]
  );

  const refacciones = await pool.query(
    `SELECT rr.id, rr.producto_id, rr.refaccion_id, COALESCE(p.nombre, ref.nombre) AS producto_nombre, rr.cantidad, rr.costo
     FROM reparacion_refacciones rr
     LEFT JOIN productos p ON p.id = rr.producto_id
     LEFT JOIN refacciones ref ON ref.id = rr.refaccion_id
     WHERE rr.reparacion_id = $1
     ORDER BY producto_nombre`,
    [req.params.id]
  );

  const abonos = await pool.query(
    `SELECT ab.id, ab.monto, ab.metodo, ab.usuario_id, u.nombre AS usuario_nombre, ab.created_at
     FROM reparacion_abonos ab
     LEFT JOIN usuarios u ON u.id = ab.usuario_id
     WHERE ab.reparacion_id = $1
     ORDER BY ab.created_at DESC`,
    [req.params.id]
  );

  // Solo las que ya estan ligadas a un estado (las filas heredadas sin
  // estado, de antes de esta funcion, no se muestran en el folio).
  const fotos = await pool.query(
    `SELECT id, url, estado, created_at
     FROM reparacion_fotos
     WHERE reparacion_id = $1 AND estado IS NOT NULL
     ORDER BY created_at ASC`,
    [req.params.id]
  );

  // Datos del ticket embebidos aqui (no via GET /configuracion-ticket, que es
  // solo-admin) para que tecnico/vendedor tambien puedan imprimir el
  // comprobante sin necesitar ese permiso — mismo patron que POST /ventas.
  const configTicket = await obtenerConfiguracionTicket();

  res.json({
    ...reparacion,
    historial: historial.rows,
    refacciones: refacciones.rows,
    abonos: abonos.rows,
    fotos: fotos.rows,
    nombre_negocio: configTicket.nombre_negocio,
    mostrar_direccion: configTicket.mostrar_direccion,
    mostrar_telefono: configTicket.mostrar_telefono,
    mostrar_tecnico: configTicket.mostrar_vendedor,
    mostrar_cliente: configTicket.mostrar_cliente,
    mensaje_pie: configTicket.mensaje_pie,
  });
});

router.post('/', requireRole('admin', 'vendedor', 'tecnico'), async (req, res) => {
  const {
    cliente_id, sucursal_id, telefono, telefono_adicional, equipo_marca, equipo_modelo, imei_equipo, equipo_contrasena, problema_reportado, prioridad,
    equipo_enciende, origen_reparacion, producto_id, unidad_imei_id,
  } = req.body ?? {};

  const esCompraPropia = origen_reparacion === 'compra_propia';
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (esCompraPropia) {
    if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido cuando origen_reparacion es "compra_propia".' });
  } else {
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id es requerido.' });
    if (!telefono?.trim()) return res.status(400).json({ error: 'El teléfono de contacto es requerido.' });
  }
  if (!problema_reportado?.trim()) return res.status(400).json({ error: 'Describe el problema reportado.' });
  // Opcional a nivel de API (un cliente de la app anterior a este campo no lo
  // manda); la app nueva lo pide como obligatorio en la recepcion.
  if (equipo_enciende !== undefined && equipo_enciende !== null && typeof equipo_enciende !== 'boolean') {
    return res.status(400).json({ error: 'equipo_enciende debe ser verdadero o falso.' });
  }
  const prioridadFinal = PRIORIDADES_VALIDAS.includes(prioridad) ? prioridad : 'media';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!esCompraPropia) {
      // El telefono capturado aqui se guarda tambien en el cliente (no solo de
      // paso en la reparacion) — asi queda disponible para futuras visitas,
      // sin volver clientes.telefono obligatorio a nivel de tabla (otros
      // modulos, como ventas, lo siguen dejando opcional). Solo escribe si
      // cambio, para no generar updates de a gratis en el caso comun.
      await client.query(`UPDATE clientes SET telefono = $1 WHERE id = $2 AND telefono IS DISTINCT FROM $1`, [telefono.trim(), cliente_id]);
      // Igual con el telefono adicional, pero solo si la app lo mando (undefined
      // = no tocar; null o vacio = el cliente ya no tiene uno).
      if (telefono_adicional !== undefined) {
        const adicional = typeof telefono_adicional === 'string' ? telefono_adicional.trim() || null : null;
        await client.query(`UPDATE clientes SET telefono_adicional = $1 WHERE id = $2 AND telefono_adicional IS DISTINCT FROM $1`, [adicional, cliente_id]);
      }
    }

    const reparacion = await client.query(
      `INSERT INTO reparaciones (cliente_id, sucursal_id, equipo_marca, equipo_modelo, imei_equipo, equipo_contrasena, problema_reportado, prioridad, origen_reparacion, producto_id, unidad_imei_id, equipo_enciende, tecnico_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, folio, estado, created_at`,
      [
        esCompraPropia ? null : cliente_id, sucursal_id, equipo_marca || null, equipo_modelo || null, imei_equipo || null,
        equipo_contrasena || null, problema_reportado.trim(), prioridadFinal,
        esCompraPropia ? 'compra_propia' : 'cliente', producto_id || null, unidad_imei_id || null,
        typeof equipo_enciende === 'boolean' ? equipo_enciende : null,
        // Si lo recibe un tecnico, queda asignado a el; en los demas casos lo asigna el admin/supervisor.
        idDelTecnico(req),
      ]
    );

    await client.query(
      `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id)
       VALUES ($1, 'recibido', $2, $3)`,
      [reparacion.rows[0].id, esCompraPropia ? 'Equipo propio ingresado a revisión antes de publicarse en catálogo.' : 'Equipo recibido en mostrador.', req.usuario.sub]
    );

    await client.query('COMMIT');
    res.status(201).json(reparacion.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const actualResult = await pool.query(`SELECT * FROM reparaciones WHERE id = $1`, [req.params.id]);
  const actual = actualResult.rows[0];
  if (!actual) return res.status(404).json({ error: 'Reparación no encontrada.' });

  // Asignar o quitar el tecnico es cosa del admin/supervisor: el resto puede mandar el mismo valor
  // que ya tiene (la app lo reenvia al guardar) pero no cambiarlo.
  if (req.body?.tecnico_id !== undefined && req.body.tecnico_id !== actual.tecnico_id) {
    if (!esAdminODueno(req.usuario.rol)) {
      return res.status(403).json({ error: 'Solo el administrador o supervisor puede asignar o quitar el técnico.' });
    }
    if (req.body.tecnico_id !== null) {
      const tecnico = UUID_RE.test(String(req.body.tecnico_id))
        ? await pool.query(`SELECT 1 FROM usuarios WHERE id = $1 AND rol = 'tecnico' AND activo = true`, [req.body.tecnico_id])
        : { rows: [] };
      if (!tecnico.rows[0]) return res.status(400).json({ error: 'El técnico no existe o no está activo.' });
    }
  }

  if (req.body?.estado !== undefined && !ESTADOS_VALIDOS.includes(req.body.estado)) {
    return res.status(400).json({ error: 'Estado inválido.' });
  }
  if (req.body?.prioridad !== undefined && !PRIORIDADES_VALIDAS.includes(req.body.prioridad)) {
    return res.status(400).json({ error: 'Prioridad inválida.' });
  }

  if (req.body?.costo_mano_obra !== undefined && !(Number(req.body.costo_mano_obra) >= 0)) {
    return res.status(400).json({ error: 'costo_mano_obra debe ser un número mayor o igual a 0.' });
  }
  if (req.body?.garantia_dias !== undefined && !(Number.isInteger(req.body.garantia_dias) && req.body.garantia_dias >= 0)) {
    return res.status(400).json({ error: 'garantia_dias debe ser un entero mayor o igual a 0.' });
  }
  if (req.body?.checklist_revision !== undefined && req.body.checklist_revision !== null && typeof req.body.checklist_revision !== 'object') {
    return res.status(400).json({ error: 'checklist_revision debe ser un objeto.' });
  }
  if (req.body?.equipo_enciende !== undefined && req.body.equipo_enciende !== null && typeof req.body.equipo_enciende !== 'boolean') {
    return res.status(400).json({ error: 'equipo_enciende debe ser verdadero o falso.' });
  }

  const nuevoEstado = req.body?.estado ?? actual.estado;
  const costoManoObra = req.body?.costo_mano_obra !== undefined ? Number(req.body.costo_mano_obra) : Number(actual.costo_mano_obra);
  const total = costoManoObra + Number(actual.costo_refacciones);
  const configTicket = await obtenerConfiguracionTicket();

  if (nuevoEstado === 'entregado' && actual.estado !== 'entregado' && configTicket.bloquear_entrega_con_saldo !== false) {
    if (Number(actual.monto_pagado) < total) {
      return res.status(409).json({ error: 'Debes completar el pago antes de marcar la reparación como entregada.' });
    }
  }

  const fields = {
    diagnostico: req.body?.diagnostico,
    estado: req.body?.estado,
    prioridad: req.body?.prioridad,
    tecnico_id: req.body?.tecnico_id,
    costo_mano_obra: req.body?.costo_mano_obra,
    garantia_dias: req.body?.garantia_dias,
    fecha_estimada_entrega: req.body?.fecha_estimada_entrega,
    nota_para_cliente: req.body?.nota_para_cliente,
    checklist_revision: req.body?.checklist_revision,
    equipo_enciende: req.body?.equipo_enciende,
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  // Un cambio de estado hecho por el personal cierra el tema de una cotizacion
  // rechazada por WhatsApp (el cambio de monto tambien la invalida, ver
  // cotizacion_rechazada en las consultas: solo cuenta si el total no cambio).
  if (req.body?.estado !== undefined && req.body.estado !== actual.estado) {
    sets.push('cotizacion_rechazada_at = NULL', 'cotizacion_rechazada_monto = NULL');
  }
  sets.push(`total = $${i++}`);
  values.push(total);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    values.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE reparaciones SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, folio, cliente_id, sucursal_id, equipo_marca, equipo_modelo, imei_equipo, problema_reportado,
                 diagnostico, estado, prioridad, tecnico_id, costo_mano_obra, costo_refacciones, total, monto_pagado, garantia_dias,
                 fecha_estimada_entrega, nota_para_cliente, checklist_revision, equipo_enciende, origen_reparacion, producto_id, unidad_imei_id, created_at, updated_at,
                 cotizacion_rechazada_at,
                 (estado = 'esperando_autorizacion' AND cotizacion_rechazada_at IS NOT NULL AND cotizacion_rechazada_monto = total) AS cotizacion_rechazada`,
      values
    );

    if (req.body?.estado !== undefined && req.body.estado !== actual.estado) {
      await client.query(
        `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, nuevoEstado, req.body?.nota || null, req.usuario.sub]
      );
    }

    // Reactivacion de catalogo: solo aplica a un equipo propio (no de
    // cliente) que se mando a revision antes de publicarse — al terminar
    // (estado 'listo'), si el toggle esta encendido, reaparece solo en
    // catalogo/venta. Si esta apagado, se queda inactivo hasta que alguien
    // presione "Publicar en catalogo" a mano (ver UnidadesImeiModal/
    // ReparacionDetalleModal, que reusan PATCH /productos/:id { activo }).
    if (nuevoEstado === 'listo' && actual.estado !== 'listo' && actual.origen_reparacion === 'compra_propia'
      && actual.producto_id && configTicket.reactivacion_catalogo_automatica !== false) {
      await client.query(`UPDATE productos SET activo = true WHERE id = $1`, [actual.producto_id]);
      if (actual.unidad_imei_id) {
        await client.query(`UPDATE unidades_imei SET estado = 'disponible', updated_at = now() WHERE id = $1`, [actual.unidad_imei_id]);
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

const CANALES_VALIDOS = ['whatsapp'];

// No hay integracion real de WhatsApp/SMS (requeriria WhatsApp Business API
// o un gateway de SMS con credenciales que no tenemos) — esto es una
// bitacora de que el vendedor/tecnico ya avisó al cliente por su cuenta
// (llamada, WhatsApp personal, etc.), no un envio automatico. Por eso se
// guarda directo como 'enviado' con enviado_at = ahora, no 'pendiente'.
router.get('/:id/notificaciones', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, canal, mensaje, estado, enviado_at, created_at
     FROM notificaciones_cliente
     WHERE reparacion_id = $1
     ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

router.post('/:id/notificaciones', async (req, res) => {
  const { canal, mensaje } = req.body ?? {};
  if (!CANALES_VALIDOS.includes(canal)) return res.status(400).json({ error: 'Canal inválido.' });
  if (!mensaje?.trim()) return res.status(400).json({ error: 'El mensaje es requerido.' });

  const reparacionResult = await pool.query(`SELECT id FROM reparaciones WHERE id = $1`, [req.params.id]);
  if (!reparacionResult.rows[0]) return res.status(404).json({ error: 'Reparación no encontrada.' });

  const { rows } = await pool.query(
    `INSERT INTO notificaciones_cliente (reparacion_id, canal, mensaje, estado, enviado_at)
     VALUES ($1, $2, $3, 'enviado', now())
     RETURNING id, canal, mensaje, estado, enviado_at, created_at`,
    [req.params.id, canal, mensaje.trim()]
  );
  res.status(201).json(rows[0]);
});

router.post('/:id/refacciones', requireRole('admin', 'tecnico'), async (req, res) => {
  const { producto_id, refaccion_id, cantidad, costo } = req.body ?? {};
  if (!producto_id && !refaccion_id) return res.status(400).json({ error: 'producto_id o refaccion_id es requerido.' });
  const cant = Number(cantidad) || 1;

  const reparacionResult = await pool.query(`SELECT sucursal_id, folio FROM reparaciones WHERE id = $1`, [req.params.id]);
  const reparacion = reparacionResult.rows[0];
  if (!reparacion) return res.status(404).json({ error: 'Reparación no encontrada.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let costoFinal;
    if (refaccion_id) {
      // Inventario dedicado de refacciones -- no pasa por inventario/
      // movimientos_inventario, esas tablas son solo de productos.
      const stockResult = await client.query(`SELECT stock, nombre, costo, sucursal_id FROM refacciones WHERE id = $1 FOR UPDATE`, [refaccion_id]);
      const stockRow = stockResult.rows[0];
      if (!stockRow || stockRow.stock < cant) {
        throw Object.assign(new Error(`Stock insuficiente para "${stockRow?.nombre ?? refaccion_id}".`), { statusCode: 409 });
      }
      costoFinal = costo !== undefined ? Number(costo) : cant * Number(stockRow.costo);
      await client.query(`UPDATE refacciones SET stock = stock - $1 WHERE id = $2`, [cant, refaccion_id]);
      await registrarMovimientoRefaccion(client, {
        refaccionId: refaccion_id, sucursalId: stockRow.sucursal_id, tipo: 'salida', cantidad: cant,
        motivo: `Usada en reparación ${reparacion.folio}`, usuarioId: req.usuario.sub,
      });
    } else {
      const stockResult = await client.query(
        `SELECT stock_cantidad, p.nombre, p.precio_venta
         FROM inventario i JOIN productos p ON p.id = i.producto_id
         WHERE i.producto_id = $1 AND i.sucursal_id = $2 FOR UPDATE`,
        [producto_id, reparacion.sucursal_id]
      );
      const stockRow = stockResult.rows[0];
      if (!stockRow || stockRow.stock_cantidad < cant) {
        throw Object.assign(new Error(`Stock insuficiente para "${stockRow?.nombre ?? producto_id}".`), { statusCode: 409 });
      }
      costoFinal = costo !== undefined ? Number(costo) : cant * Number(stockRow.precio_venta);

      await client.query(
        `UPDATE inventario SET stock_cantidad = stock_cantidad - $1, updated_at = now() WHERE producto_id = $2 AND sucursal_id = $3`,
        [cant, producto_id, reparacion.sucursal_id]
      );
      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'salida', $3, 'Refacción usada en reparación', 'reparacion', $4, $5)`,
        [producto_id, reparacion.sucursal_id, cant, req.params.id, req.usuario.sub]
      );
    }

    const refaccion = await client.query(
      `INSERT INTO reparacion_refacciones (reparacion_id, producto_id, refaccion_id, cantidad, costo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, producto_id, refaccion_id, cantidad, costo`,
      [req.params.id, producto_id || null, refaccion_id || null, cant, costoFinal]
    );

    const sumaResult = await client.query(
      `SELECT COALESCE(sum(costo), 0) AS total FROM reparacion_refacciones WHERE reparacion_id = $1`,
      [req.params.id]
    );
    await client.query(
      `UPDATE reparaciones SET costo_refacciones = $1, total = costo_mano_obra + $1 WHERE id = $2`,
      [sumaResult.rows[0].total, req.params.id]
    );

    await client.query('COMMIT');
    res.status(201).json(refaccion.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

// Cobro/abono de una reparacion — mismo patron transaccional que
// POST /apartados/:id/abonos. Excluye tecnico (no maneja dinero, igual que
// apartados). "Cobrar todo" se resuelve del lado del frontend prellenando
// monto con el saldo pendiente, no hay un endpoint separado para eso.
router.post('/:id/abonos', requireRole('admin', 'vendedor'), async (req, res) => {
  const { monto, metodo } = req.body ?? {};
  if (!(Number(monto) > 0)) return res.status(400).json({ error: 'monto debe ser mayor a 0.' });
  if (!METODOS_PAGO_VALIDOS.includes(metodo)) return res.status(400).json({ error: 'Método de pago inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reparacionResult = await client.query(`SELECT total, monto_pagado FROM reparaciones WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const reparacion = reparacionResult.rows[0];
    if (!reparacion) throw Object.assign(new Error('Reparación no encontrada.'), { statusCode: 404 });

    const saldoPendiente = Number(reparacion.total) - Number(reparacion.monto_pagado);
    if (Number(monto) > saldoPendiente) {
      throw Object.assign(new Error('El abono no puede ser mayor al saldo pendiente.'), { statusCode: 400 });
    }

    const abono = await client.query(
      `INSERT INTO reparacion_abonos (reparacion_id, monto, metodo, usuario_id) VALUES ($1, $2, $3, $4)
       RETURNING id, reparacion_id, monto, metodo, usuario_id, created_at`,
      [req.params.id, Number(monto), metodo, req.usuario.sub]
    );

    const nuevoMontoPagado = Number(reparacion.monto_pagado) + Number(monto);
    await client.query(`UPDATE reparaciones SET monto_pagado = $1 WHERE id = $2`, [nuevoMontoPagado, req.params.id]);

    await client.query('COMMIT');
    res.status(201).json({ ...abono.rows[0], monto_pagado: nuevoMontoPagado, saldo_pendiente: Number(reparacion.total) - nuevoMontoPagado });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

const MAX_FOTOS_POR_ESTADO = 5;

// La URL solo puede venir de nuestro propio bucket (la que devuelve
// POST /uploads/imagen) -- estas fotos terminan mandandose al cliente por
// WhatsApp, asi que no se acepta un enlace externo arbitrario.
function urlDeNuestroBucket(url) {
  if (typeof url !== 'string' || url.length > 2048 || !url.startsWith('https://')) return false;
  const base = process.env.SUPABASE_URL;
  return base ? url.startsWith(`${base}/storage/v1/object/public/`) : true;
}

// Fotos del folio por estado (1-5 cada uno) -- sirven para que el agente de
// WhatsApp le responda al cliente con la foto del estado actual (ver
// reparacionExterna.routes.js). Las pueden manejar quienes pueden abrir el
// folio: el vendedor toma las de recepcion/entrega, el tecnico las del taller.
router.post('/:id/fotos', async (req, res) => {
  const { estado, url } = req.body ?? {};
  if (!ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
  if (!urlDeNuestroBucket(url)) return res.status(400).json({ error: 'URL de imagen inválida.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bloquea el folio para que dos fotos subidas en paralelo no se salten
    // el tope de 5 (el frontend las sube todas a la vez).
    const reparacion = await client.query(`SELECT id FROM reparaciones WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!reparacion.rows[0]) throw Object.assign(new Error('Reparación no encontrada.'), { statusCode: 404 });

    const { rows: conteo } = await client.query(
      `SELECT count(*)::int AS total FROM reparacion_fotos WHERE reparacion_id = $1 AND estado = $2`,
      [req.params.id, estado]
    );
    if (conteo[0].total >= MAX_FOTOS_POR_ESTADO) {
      throw Object.assign(new Error(`Cada estado admite máximo ${MAX_FOTOS_POR_ESTADO} fotos.`), { statusCode: 409 });
    }

    const { rows } = await client.query(
      `INSERT INTO reparacion_fotos (reparacion_id, url, estado) VALUES ($1, $2, $3)
       RETURNING id, url, estado, created_at`,
      [req.params.id, url, estado]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/fotos/:fotoId', async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM reparacion_fotos WHERE id = $1 AND reparacion_id = $2`,
    [req.params.fotoId, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Foto no encontrada.' });
  res.status(204).end();
});

module.exports = router;
