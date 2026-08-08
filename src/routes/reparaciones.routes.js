const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'tecnico', 'vendedor'));

const ESTADOS_VALIDOS = ['recibido', 'diagnostico', 'reparacion', 'listo', 'entregado'];
const PRIORIDADES_VALIDAS = ['baja', 'media', 'alta'];

// IMPORTANTE: esta ruta especifica va ANTES de "/:id" para que Express no la
// confunda con una busqueda por id (que fallaria con "reporte" como uuid).
router.get('/refacciones/reporte', async (req, res) => {
  const { desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT rr.id, r.folio, rr.producto_id, p.nombre AS producto_nombre, rr.cantidad, rr.costo, r.created_at AS fecha
     FROM reparacion_refacciones rr
     JOIN reparaciones r ON r.id = rr.reparacion_id
     JOIN productos p ON p.id = rr.producto_id
     WHERE ($1::timestamptz IS NULL OR r.created_at >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
     ORDER BY r.created_at DESC`,
    [desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

// Igual que arriba, va antes de "/:id". Solo admin (es un reporte de
// desempeño, como los reportes financieros). Agrupa por tecnico_id (incluye
// NULL como "sin asignar"); dias_promedio se calcula de recepcion a la
// primera vez que el folio paso por 'entregado' en el historial.
router.get('/reporte-tecnicos', requireRole('admin'), async (req, res) => {
  const { desde, hasta } = req.query;
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
     GROUP BY r.tecnico_id, t.nombre
     ORDER BY total_facturado DESC`,
    [desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
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
            r.costo_mano_obra, r.costo_refacciones, r.total, r.garantia_dias, r.created_at, r.updated_at
     FROM reparaciones r
     JOIN clientes c ON c.id = r.cliente_id
     LEFT JOIN usuarios t ON t.id = r.tecnico_id
     WHERE ($1::text IS NULL OR r.estado::text = $1)
       AND ($2::uuid IS NULL OR r.tecnico_id = $2::uuid)
       AND ($3::uuid IS NULL OR r.sucursal_id = $3::uuid)
       AND ($4::text IS NULL OR r.folio ILIKE '%' || $4 || '%' OR c.nombre ILIKE '%' || $4 || '%' OR r.imei_equipo ILIKE '%' || $4 || '%')
       AND ($5::timestamptz IS NULL OR r.created_at >= $5::timestamptz)
       AND ($6::timestamptz IS NULL OR r.created_at < $6::timestamptz)
     ORDER BY r.created_at DESC`,
    [estado || null, tecnico_id || null, sucursal_id || null, q || null, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const reparacionResult = await pool.query(
    `SELECT r.id, r.folio, r.cliente_id, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono, r.sucursal_id,
            s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
            r.equipo_marca, r.equipo_modelo, r.imei_equipo, r.problema_reportado, r.diagnostico,
            r.estado, r.prioridad, r.tecnico_id, t.nombre AS tecnico_nombre,
            r.costo_mano_obra, r.costo_refacciones, r.total, r.garantia_dias, r.created_at, r.updated_at
     FROM reparaciones r
     JOIN clientes c ON c.id = r.cliente_id
     JOIN sucursales s ON s.id = r.sucursal_id
     LEFT JOIN usuarios t ON t.id = r.tecnico_id
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
    `SELECT rr.id, rr.producto_id, p.nombre AS producto_nombre, rr.cantidad, rr.costo
     FROM reparacion_refacciones rr
     JOIN productos p ON p.id = rr.producto_id
     WHERE rr.reparacion_id = $1
     ORDER BY p.nombre`,
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
    nombre_negocio: configTicket.nombre_negocio,
    mostrar_direccion: configTicket.mostrar_direccion,
    mostrar_telefono: configTicket.mostrar_telefono,
    mostrar_tecnico: configTicket.mostrar_vendedor,
    mostrar_cliente: configTicket.mostrar_cliente,
    mensaje_pie: configTicket.mensaje_pie,
  });
});

router.post('/', requireRole('admin', 'vendedor'), async (req, res) => {
  const { cliente_id, sucursal_id, equipo_marca, equipo_modelo, imei_equipo, problema_reportado, prioridad } = req.body ?? {};

  if (!cliente_id) return res.status(400).json({ error: 'cliente_id es requerido.' });
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!problema_reportado?.trim()) return res.status(400).json({ error: 'Describe el problema reportado.' });
  const prioridadFinal = PRIORIDADES_VALIDAS.includes(prioridad) ? prioridad : 'media';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reparacion = await client.query(
      `INSERT INTO reparaciones (cliente_id, sucursal_id, equipo_marca, equipo_modelo, imei_equipo, problema_reportado, prioridad)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, folio, estado, created_at`,
      [cliente_id, sucursal_id, equipo_marca || null, equipo_modelo || null, imei_equipo || null, problema_reportado.trim(), prioridadFinal]
    );

    await client.query(
      `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id)
       VALUES ($1, 'recibido', 'Equipo recibido en mostrador.', $2)`,
      [reparacion.rows[0].id, req.usuario.sub]
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

  const nuevoEstado = req.body?.estado ?? actual.estado;
  const costoManoObra = req.body?.costo_mano_obra !== undefined ? Number(req.body.costo_mano_obra) : Number(actual.costo_mano_obra);
  const total = costoManoObra + Number(actual.costo_refacciones);

  const fields = {
    diagnostico: req.body?.diagnostico,
    estado: req.body?.estado,
    prioridad: req.body?.prioridad,
    tecnico_id: req.body?.tecnico_id,
    costo_mano_obra: req.body?.costo_mano_obra,
    garantia_dias: req.body?.garantia_dias,
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
  sets.push(`total = $${i++}`);
  values.push(total);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    values.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE reparaciones SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, folio, cliente_id, sucursal_id, equipo_marca, equipo_modelo, imei_equipo, problema_reportado,
                 diagnostico, estado, prioridad, tecnico_id, costo_mano_obra, costo_refacciones, total, garantia_dias, created_at, updated_at`,
      values
    );

    if (req.body?.estado !== undefined && req.body.estado !== actual.estado) {
      await client.query(
        `INSERT INTO reparacion_historial (reparacion_id, estado, nota, usuario_id)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, nuevoEstado, req.body?.nota || null, req.usuario.sub]
      );
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

const CANALES_VALIDOS = ['whatsapp', 'sms'];

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
  const { producto_id, cantidad, costo } = req.body ?? {};
  if (!producto_id) return res.status(400).json({ error: 'producto_id es requerido.' });
  const cant = Number(cantidad) || 1;

  const reparacionResult = await pool.query(`SELECT sucursal_id FROM reparaciones WHERE id = $1`, [req.params.id]);
  const reparacion = reparacionResult.rows[0];
  if (!reparacion) return res.status(404).json({ error: 'Reparación no encontrada.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
    const costoFinal = costo !== undefined ? Number(costo) : cant * Number(stockRow.precio_venta);

    const refaccion = await client.query(
      `INSERT INTO reparacion_refacciones (reparacion_id, producto_id, cantidad, costo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, producto_id, cantidad, costo`,
      [req.params.id, producto_id, cant, costoFinal]
    );

    await client.query(
      `UPDATE inventario SET stock_cantidad = stock_cantidad - $1, updated_at = now() WHERE producto_id = $2 AND sucursal_id = $3`,
      [cant, producto_id, reparacion.sucursal_id]
    );
    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'salida', $3, 'Refacción usada en reparación', 'reparacion', $4, $5)`,
      [producto_id, reparacion.sucursal_id, cant, req.params.id, req.usuario.sub]
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

module.exports = router;
