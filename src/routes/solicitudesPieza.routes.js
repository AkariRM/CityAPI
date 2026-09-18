const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');

const router = express.Router();

// Mismo set base que reparaciones.routes.js (admin/tecnico/vendedor pueden
// VER el detalle de un folio, incluida su lista de solicitudes) -- las
// acciones de escritura se restringen aparte, por ruta, igual que
// reparaciones.routes.js excluye vendedor solo de /refacciones.
router.use(requireAuth, requireRole('admin', 'tecnico', 'vendedor'));

const ESTADOS_VALIDOS = ['pendiente', 'aprobada', 'rechazada', 'recibida'];

router.get('/', async (req, res) => {
  const { estado, reparacion_id } = req.query;
  if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

  const { rows } = await pool.query(
    `SELECT sp.id, sp.reparacion_id, r.folio, sp.producto_id, sp.refaccion_id, COALESCE(p.nombre, ref.nombre) AS producto_nombre, sp.descripcion_libre,
            sp.costo_estimado, sp.estado, sp.motivo_rechazo,
            sp.solicitado_por, us.nombre AS solicitado_por_nombre,
            sp.aprobado_por, ua.nombre AS aprobado_por_nombre,
            sp.created_at, sp.updated_at
     FROM reparacion_solicitudes_pieza sp
     JOIN reparaciones r ON r.id = sp.reparacion_id
     LEFT JOIN productos p ON p.id = sp.producto_id
     LEFT JOIN refacciones ref ON ref.id = sp.refaccion_id
     LEFT JOIN usuarios us ON us.id = sp.solicitado_por
     LEFT JOIN usuarios ua ON ua.id = sp.aprobado_por
     WHERE ($1::text IS NULL OR sp.estado::text = $1)
       AND ($2::uuid IS NULL OR sp.reparacion_id = $2::uuid)
     ORDER BY sp.created_at DESC`,
    [estado || null, reparacion_id || null]
  );
  res.json(rows);
});

router.post('/', requireRole('admin', 'tecnico'), async (req, res) => {
  const { reparacion_id, producto_id, refaccion_id, descripcion_libre, costo_estimado } = req.body ?? {};
  if (!reparacion_id) return res.status(400).json({ error: 'reparacion_id es requerido.' });
  if (!producto_id && !refaccion_id && !descripcion_libre?.trim()) {
    return res.status(400).json({ error: 'Elige un producto/refacción del catálogo o describe la pieza.' });
  }
  if (!(Number(costo_estimado) >= 0)) return res.status(400).json({ error: 'costo_estimado debe ser un número mayor o igual a 0.' });

  const reparacion = await pool.query(`SELECT id FROM reparaciones WHERE id = $1`, [reparacion_id]);
  if (!reparacion.rows[0]) return res.status(404).json({ error: 'Reparación no encontrada.' });

  const { rows } = await pool.query(
    `INSERT INTO reparacion_solicitudes_pieza (reparacion_id, producto_id, refaccion_id, descripcion_libre, costo_estimado, solicitado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, reparacion_id, producto_id, refaccion_id, descripcion_libre, costo_estimado, estado, created_at`,
    [reparacion_id, producto_id || null, refaccion_id || null, descripcion_libre?.trim() || null, Number(costo_estimado) || 0, req.usuario.sub]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/aprobar', requireRole('admin'), async (req, res) => {
  const { producto_id, refaccion_id, costo_aprobado } = req.body ?? {};

  const actual = await pool.query(`SELECT * FROM reparacion_solicitudes_pieza WHERE id = $1`, [req.params.id]);
  const solicitud = actual.rows[0];
  if (!solicitud) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  if (solicitud.estado !== 'pendiente') return res.status(409).json({ error: 'Esta solicitud ya fue resuelta.' });

  // Vincular a producto y a refaccion son alternativas -- si mandan una
  // nueva, reemplaza cualquier vinculo anterior del otro tipo.
  const productoFinal = refaccion_id ? null : producto_id || solicitud.producto_id;
  const refaccionFinal = producto_id ? null : refaccion_id || solicitud.refaccion_id;
  const configTicket = await obtenerConfiguracionTicket();
  if (configTicket.pieza_externa_requiere_catalogo && !productoFinal && !refaccionFinal) {
    return res.status(400).json({ error: 'Esta pieza no está en catálogo — vincula un producto o refacción para poder aprobarla (así su costo se suma solo al total).' });
  }
  if (costo_aprobado !== undefined && !(Number(costo_aprobado) >= 0)) {
    return res.status(400).json({ error: 'costo_aprobado debe ser un número mayor o igual a 0.' });
  }

  const { rows } = await pool.query(
    `UPDATE reparacion_solicitudes_pieza
     SET estado = 'aprobada', aprobado_por = $1, producto_id = $2, refaccion_id = $3, costo_estimado = $4
     WHERE id = $5
     RETURNING id, reparacion_id, producto_id, refaccion_id, descripcion_libre, costo_estimado, estado, aprobado_por`,
    [req.usuario.sub, productoFinal || null, refaccionFinal || null, costo_aprobado !== undefined ? Number(costo_aprobado) : solicitud.costo_estimado, req.params.id]
  );
  res.json(rows[0]);
});

router.patch('/:id/rechazar', requireRole('admin'), async (req, res) => {
  const { motivo } = req.body ?? {};

  const actual = await pool.query(`SELECT estado FROM reparacion_solicitudes_pieza WHERE id = $1`, [req.params.id]);
  if (!actual.rows[0]) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  if (actual.rows[0].estado !== 'pendiente') return res.status(409).json({ error: 'Esta solicitud ya fue resuelta.' });

  const { rows } = await pool.query(
    `UPDATE reparacion_solicitudes_pieza SET estado = 'rechazada', aprobado_por = $1, motivo_rechazo = $2 WHERE id = $3
     RETURNING id, reparacion_id, estado, motivo_rechazo`,
    [req.usuario.sub, motivo?.trim() || null, req.params.id]
  );
  res.json(rows[0]);
});

// Marca la pieza como recibida — si tiene producto_id o refaccion_id, genera
// el renglon real en reparacion_refacciones (sin chequeo de stock, esta
// pieza se consiguio por fuera) y recalcula el total de la reparacion,
// igual que POST /reparaciones/:id/refacciones. registrar_gasto (opcional)
// ademas la refleja en Gastos del local, igual que la compra de refacciones.
router.post('/:id/recibir', requireRole('admin', 'tecnico'), async (req, res) => {
  const { registrar_gasto } = req.body ?? {};
  const actual = await pool.query(
    `SELECT sp.*, r.folio, r.sucursal_id
     FROM reparacion_solicitudes_pieza sp
     JOIN reparaciones r ON r.id = sp.reparacion_id
     WHERE sp.id = $1`,
    [req.params.id]
  );
  const solicitud = actual.rows[0];
  if (!solicitud) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  if (solicitud.estado !== 'aprobada') return res.status(409).json({ error: 'Solo se puede recibir una solicitud aprobada.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let reparacionRefaccionId = null;
    if (solicitud.producto_id || solicitud.refaccion_id) {
      const refaccion = await client.query(
        `INSERT INTO reparacion_refacciones (reparacion_id, producto_id, refaccion_id, cantidad, costo)
         VALUES ($1, $2, $3, 1, $4)
         RETURNING id`,
        [solicitud.reparacion_id, solicitud.producto_id, solicitud.refaccion_id, solicitud.costo_estimado]
      );
      reparacionRefaccionId = refaccion.rows[0].id;

      const suma = await client.query(
        `SELECT COALESCE(sum(costo), 0) AS total FROM reparacion_refacciones WHERE reparacion_id = $1`,
        [solicitud.reparacion_id]
      );
      await client.query(
        `UPDATE reparaciones SET costo_refacciones = $1, total = costo_mano_obra + $1 WHERE id = $2`,
        [suma.rows[0].total, solicitud.reparacion_id]
      );
    }

    if (registrar_gasto) {
      await client.query(
        `INSERT INTO gastos (sucursal_id, usuario_id, tipo, categoria, monto, descripcion, fecha)
         VALUES ($1, $2, 'gasto', 'Piezas de reparación', $3, $4, current_date)`,
        [solicitud.sucursal_id, req.usuario.sub, solicitud.costo_estimado, `Pieza de reparación folio ${solicitud.folio}: ${solicitud.descripcion_libre ?? ''}`.trim()]
      );
    }

    const { rows } = await client.query(
      `UPDATE reparacion_solicitudes_pieza SET estado = 'recibida', reparacion_refaccion_id = $1 WHERE id = $2
       RETURNING id, reparacion_id, producto_id, refaccion_id, descripcion_libre, costo_estimado, estado, reparacion_refaccion_id`,
      [reparacionRefaccionId, req.params.id]
    );

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

module.exports = router;
