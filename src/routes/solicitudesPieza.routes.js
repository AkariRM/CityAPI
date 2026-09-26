const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { alcanceReparaciones, enAlcance, sqlAlcance } = require('../utils/alcanceReparaciones');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');
const { registrarMovimientoRefaccion } = require('../utils/movimientosRefacciones');

const router = express.Router();

// Mismo set base que reparaciones.routes.js (admin/tecnico/vendedor pueden
// VER el detalle de un folio, incluida su lista de solicitudes) -- las
// acciones de escritura se restringen aparte, por ruta, igual que
// reparaciones.routes.js excluye vendedor solo de /refacciones.
router.use(requireAuth, requireRole('admin', 'tecnico', 'vendedor', 'supervisor_taller'));

const ESTADOS_VALIDOS = ['pendiente', 'aprobada', 'rechazada', 'recibida'];

// Cada rol ve las solicitudes de pieza de las reparaciones a su alcance (mismo criterio que
// reparaciones.routes.js, ver utils/alcanceReparaciones.js): el tecnico las de SUS reparaciones, la
// sucursal las de las que recibio, el taller (supervisor) y el dueño todas.
function fueraDeAlcance(req, reparacion) {
  return !enAlcance(alcanceReparaciones(req.usuario), reparacion);
}

router.get('/', async (req, res) => {
  const { estado, reparacion_id } = req.query;
  if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
  const alcance = alcanceReparaciones(req.usuario);
  if (alcance.sinAcceso) return res.json([]);

  const { rows } = await pool.query(
    `SELECT sp.id, sp.reparacion_id, r.folio, r.sucursal_id, sp.producto_id, sp.refaccion_id, COALESCE(p.nombre, ref.nombre, sp.nombre_libre) AS producto_nombre, sp.nombre_libre, sp.descripcion_libre,
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
       AND ($3::uuid IS NULL OR r.tecnico_id = $3::uuid)
       AND ($4::uuid IS NULL OR r.sucursal_id = $4::uuid)${sqlAlcance(alcance)}
     ORDER BY sp.created_at DESC`,
    [estado || null, reparacion_id || null, alcance.tecnicoId ?? null, alcance.sucursalId ?? null]
  );
  res.json(rows);
});

router.post('/', requireRole('dueño', 'supervisor_taller', 'tecnico'), async (req, res) => {
  const { reparacion_id, producto_id, refaccion_id, nombre_libre, descripcion_libre, costo_estimado } = req.body ?? {};
  if (!reparacion_id) return res.status(400).json({ error: 'reparacion_id es requerido.' });
  // Las piezas se piden del inventario de refacciones o por nombre; el catalogo de accesorios no es del taller.
  if (producto_id) return res.status(400).json({ error: 'Las piezas se toman del inventario de refacciones.' });
  if (!refaccion_id && !nombre_libre?.trim()) {
    return res.status(400).json({ error: 'Escribe el nombre de la pieza.' });
  }
  if (!(Number(costo_estimado) >= 0)) return res.status(400).json({ error: 'costo_estimado debe ser un número mayor o igual a 0.' });

  const reparacion = await pool.query(`SELECT id, tecnico_id, sucursal_id, en_taller_desde, ubicacion FROM reparaciones WHERE id = $1`, [reparacion_id]);
  if (!reparacion.rows[0] || fueraDeAlcance(req, reparacion.rows[0])) {
    return res.status(404).json({ error: 'Reparación no encontrada.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO reparacion_solicitudes_pieza (reparacion_id, producto_id, refaccion_id, nombre_libre, descripcion_libre, costo_estimado, solicitado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, reparacion_id, producto_id, refaccion_id, nombre_libre, descripcion_libre, costo_estimado, estado, created_at`,
    [reparacion_id, producto_id || null, refaccion_id || null, nombre_libre?.trim() || null, descripcion_libre?.trim() || null, Number(costo_estimado) || 0, req.usuario.sub]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/aprobar', requireRole('dueño', 'supervisor_taller'), async (req, res) => {
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

router.patch('/:id/rechazar', requireRole('dueño', 'supervisor_taller'), async (req, res) => {
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
//
// cantidad_comprada (opcional, >=1, solo aplica si hay/quedara un
// refaccion_id vinculado): si se compraron mas piezas de las que se usan
// aqui (siempre 1), el excedente entra como stock real a esa refaccion --
// mismo mecanismo que POST /refacciones/:id/compra.
//
// crear_refaccion (opcional, {nombre, categoria, proveedor}): cuando la
// solicitud no tenia producto_id ni refaccion_id (se pidio solo con
// nombre_libre), esto la da de alta como refaccion real del catalogo antes
// de vincularla, para que la proxima vez ya se pueda buscar en vez de
// volver a describirla.
router.post('/:id/recibir', requireRole('dueño', 'supervisor_taller', 'tecnico'), async (req, res) => {
  const { registrar_gasto, cantidad_comprada, crear_refaccion } = req.body ?? {};
  const actual = await pool.query(
    `SELECT sp.*, r.folio, r.sucursal_id, r.tecnico_id AS reparacion_tecnico_id, r.en_taller_desde, r.ubicacion
     FROM reparacion_solicitudes_pieza sp
     JOIN reparaciones r ON r.id = sp.reparacion_id
     WHERE sp.id = $1`,
    [req.params.id]
  );
  const solicitud = actual.rows[0];
  if (!solicitud || fueraDeAlcance(req, {
    tecnico_id: solicitud.reparacion_tecnico_id, sucursal_id: solicitud.sucursal_id, en_taller_desde: solicitud.en_taller_desde, ubicacion: solicitud.ubicacion,
  })) {
    return res.status(404).json({ error: 'Solicitud no encontrada.' });
  }
  if (solicitud.estado !== 'aprobada') return res.status(409).json({ error: 'Solo se puede recibir una solicitud aprobada.' });

  let cantidadComprada = null;
  if (cantidad_comprada !== undefined && cantidad_comprada !== null) {
    if (!(Number.isInteger(Number(cantidad_comprada)) && Number(cantidad_comprada) >= 1)) {
      return res.status(400).json({ error: 'cantidad_comprada debe ser un entero mayor o igual a 1.' });
    }
    cantidadComprada = Number(cantidad_comprada);
  }
  if (crear_refaccion) {
    if (!crear_refaccion.nombre?.trim()) return res.status(400).json({ error: 'El nombre de la nueva refacción es requerido.' });
    if (solicitud.producto_id || solicitud.refaccion_id) {
      return res.status(400).json({ error: 'Esta pieza ya está vinculada a un producto/refacción — no se puede crear otra.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let refaccionId = solicitud.refaccion_id;
    let refaccionRecienCreada = false;
    if (crear_refaccion) {
      const nueva = await client.query(
        `INSERT INTO refacciones (nombre, categoria, proveedor, costo, stock)
         VALUES ($1, $2, $3, $4, 0)
         RETURNING id`,
        [crear_refaccion.nombre.trim(), crear_refaccion.categoria?.trim() || null, crear_refaccion.proveedor?.trim() || null, solicitud.costo_estimado]
      );
      refaccionId = nueva.rows[0].id;
      refaccionRecienCreada = true;
    }

    let reparacionRefaccionId = null;
    if (solicitud.producto_id || refaccionId) {
      const refaccion = await client.query(
        `INSERT INTO reparacion_refacciones (reparacion_id, producto_id, refaccion_id, cantidad, costo)
         VALUES ($1, $2, $3, 1, $4)
         RETURNING id`,
        [solicitud.reparacion_id, solicitud.producto_id, refaccionId, solicitud.costo_estimado]
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

    if (refaccionId && cantidadComprada > 1) {
      await client.query(`UPDATE refacciones SET stock = stock + $1, costo = $2 WHERE id = $3`, [cantidadComprada - 1, solicitud.costo_estimado, refaccionId]);
      await registrarMovimientoRefaccion(client, {
        refaccionId, sucursalId: null, tipo: 'entrada', cantidad: cantidadComprada - 1,
        motivo: `Sobrante de pieza solicitada (folio ${solicitud.folio})`, usuarioId: req.usuario.sub,
      });
    }

    if (registrar_gasto) {
      const piezaLabel = solicitud.nombre_libre ?? solicitud.descripcion_libre ?? '';
      const cant = cantidadComprada ?? 1;
      await client.query(
        `INSERT INTO gastos (sucursal_id, usuario_id, tipo, categoria, monto, descripcion, fecha)
         VALUES ($1, $2, 'gasto', 'Piezas de reparación', $3, $4, current_date)`,
        [
          solicitud.sucursal_id,
          req.usuario.sub,
          Number(solicitud.costo_estimado) * cant,
          `Pieza de reparación folio ${solicitud.folio}: ${piezaLabel}${cant > 1 ? ` x${cant}` : ''}`.trim(),
        ]
      );
    }

    const { rows } = await client.query(
      `UPDATE reparacion_solicitudes_pieza
       SET estado = 'recibida', reparacion_refaccion_id = $1, refaccion_id = COALESCE($2, refaccion_id)
       WHERE id = $3
       RETURNING id, reparacion_id, producto_id, refaccion_id, nombre_libre, descripcion_libre, costo_estimado, estado, reparacion_refaccion_id`,
      [reparacionRefaccionId, refaccionRecienCreada ? refaccionId : null, req.params.id]
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
