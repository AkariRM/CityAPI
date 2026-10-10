const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { inicioDiaUTC } = require('../utils/fechas');
const { redondear } = require('../utils/precioPiezas');

// Revision de costos de reparaciones: cuando un folio queda Entregado entra a la lista de "por revisar". Ahi se captura
// la mano de obra que se le paga al tecnico por ese folio y se confirma el costo real de las piezas:
//   utilidad = lo cobrado - mano de obra - costo de piezas.
// Al marcarlo como revisado sale de esa lista y pasa a la de utilidad mensual (por mes de entrega).
// Solo el dueño y el supervisor de sucursal (requireRole('admin') deja pasar al dueño tambien): el mostrador y el taller
// no ven costos. La utilidad por folio es informativa, no se suma a Utilidades y ganancias (ahi la nomina del taller y
// las compras de refacciones ya se descuentan).
const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_MONTO = 9999999.99;

// Fecha de entrega: la ultima vez que el historial marca 'entregado' (si falta, la ultima modificacion del folio).
const FECHA_ENTREGA = `COALESCE((SELECT max(h.created_at) FROM reparacion_historial h WHERE h.reparacion_id = r.id AND h.estado = 'entregado'), r.updated_at)`;
// Costo REAL de las piezas del folio (no lo que se le cobro al cliente por ellas).
const COSTO_PIEZAS = `COALESCE((SELECT sum(rr.costo) FROM reparacion_refacciones rr WHERE rr.reparacion_id = r.id), 0)`;
// Mes tal como lo cuenta la sucursal (UTC-6 fijo, igual que utils/fechas.js).
const mesLocal = (columna) => `to_char((${columna} AT TIME ZONE 'UTC') - interval '6 hours', 'YYYY-MM')`;

function falla(statusCode, mensaje) {
  return Object.assign(new Error(mensaje), { statusCode });
}

function responderError(res, err) {
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Error interno del servidor.' });
}

// Un supervisor con sucursal fija solo trabaja la suya; el dueño (o un supervisor sin sucursal) puede elegir una o ver todas.
function sucursalDeTrabajo(req, pedida) {
  if (pedida && !UUID_RE.test(pedida)) throw falla(400, 'Sucursal inválida.');
  const propia = req.usuario.rol === 'admin' ? req.usuario.sucursal_id : null;
  if (propia && pedida && pedida !== propia) throw falla(403, 'Solo puedes revisar costos de tu sucursal.');
  return propia || pedida || null;
}

const esMonto = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_MONTO;
const numero = (n) => Number(n ?? 0);

// Inicio (incluido) y fin (excluido) del mes "YYYY-MM", en hora de la sucursal.
function rangoDelMes(mes) {
  const m = MES_RE.exec(mes ?? '');
  if (!m) throw falla(400, 'El mes debe ser AAAA-MM.');
  const anio = Number(m[1]);
  const numMes = Number(m[2]);
  const siguiente = numMes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(numMes + 1).padStart(2, '0')}-01`;
  return { desde: inicioDiaUTC(`${mes}-01`), hasta: inicioDiaUTC(siguiente) };
}

function sumar(filas, campo) {
  return redondear(filas.reduce((acc, f) => acc + numero(f[campo]), 0));
}

// Folios entregados que todavia no se revisan (los equipos propios mandados a revision no cuentan: no se cobran).
router.get('/pendientes', async (req, res) => {
  try {
    const sucursal = sucursalDeTrabajo(req, req.query.sucursal_id);
    const { rows } = await pool.query(
      `SELECT r.id, r.folio, c.nombre AS cliente_nombre, r.equipo_marca, r.equipo_modelo, r.sucursal_id, sc.nombre AS sucursal_nombre,
              t.nombre AS tecnico_nombre, r.total, r.monto_pagado, ${FECHA_ENTREGA} AS entregado_at, ${COSTO_PIEZAS} AS costo_piezas,
              (SELECT count(*)::int FROM reparacion_refacciones rr WHERE rr.reparacion_id = r.id) AS piezas
       FROM reparaciones r
       LEFT JOIN clientes c ON c.id = r.cliente_id
       JOIN sucursales sc ON sc.id = r.sucursal_id
       LEFT JOIN usuarios t ON t.id = r.tecnico_id
       WHERE r.estado = 'entregado' AND r.costos_revisados_at IS NULL AND r.origen_reparacion = 'cliente'
         AND ($1::uuid IS NULL OR r.sucursal_id = $1::uuid)
       ORDER BY entregado_at ASC, r.folio ASC`,
      [sucursal]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err);
  }
});

// Folios ya revisados que se entregaron en el mes (AAAA-MM), con sus totales: la lista de utilidad mensual.
router.get('/revisadas', async (req, res) => {
  try {
    const sucursal = sucursalDeTrabajo(req, req.query.sucursal_id);
    const { desde, hasta } = rangoDelMes(req.query.mes);
    const { rows } = await pool.query(
      `SELECT r.id, r.folio, c.nombre AS cliente_nombre, r.equipo_marca, r.equipo_modelo, r.sucursal_id, sc.nombre AS sucursal_nombre,
              t.nombre AS tecnico_nombre, r.revision_entregado_at AS entregado_at, r.revision_reparacion AS reparacion,
              r.revision_mano_obra AS mano_obra, r.revision_costo_piezas AS costo_piezas, r.revision_utilidad AS utilidad,
              r.costos_revisados_at, rv.nombre AS revisado_por_nombre
       FROM reparaciones r
       LEFT JOIN clientes c ON c.id = r.cliente_id
       JOIN sucursales sc ON sc.id = r.sucursal_id
       LEFT JOIN usuarios t ON t.id = r.tecnico_id
       LEFT JOIN usuarios rv ON rv.id = r.costos_revisados_por
       WHERE r.costos_revisados_at IS NOT NULL AND r.revision_entregado_at >= $1::timestamptz AND r.revision_entregado_at < $2::timestamptz
         AND ($3::uuid IS NULL OR r.sucursal_id = $3::uuid)
       ORDER BY r.revision_entregado_at DESC, r.folio DESC`,
      [desde, hasta, sucursal]
    );
    res.json({
      mes: req.query.mes,
      totales: {
        folios: rows.length,
        reparacion: sumar(rows, 'reparacion'),
        mano_obra: sumar(rows, 'mano_obra'),
        costo_piezas: sumar(rows, 'costo_piezas'),
        utilidad: sumar(rows, 'utilidad'),
      },
      filas: rows,
    });
  } catch (err) {
    responderError(res, err);
  }
});

// Un renglon por mes (solo los meses con folios revisados), el mas reciente primero.
router.get('/resumen-mensual', async (req, res) => {
  try {
    const sucursal = sucursalDeTrabajo(req, req.query.sucursal_id);
    const { rows } = await pool.query(
      `SELECT ${mesLocal('r.revision_entregado_at')} AS mes, count(*)::int AS folios,
              COALESCE(sum(r.revision_reparacion), 0) AS reparacion, COALESCE(sum(r.revision_mano_obra), 0) AS mano_obra,
              COALESCE(sum(r.revision_costo_piezas), 0) AS costo_piezas, COALESCE(sum(r.revision_utilidad), 0) AS utilidad
       FROM reparaciones r
       WHERE r.costos_revisados_at IS NOT NULL AND r.revision_entregado_at IS NOT NULL
         AND ($1::uuid IS NULL OR r.sucursal_id = $1::uuid)
       GROUP BY 1
       ORDER BY 1 DESC
       LIMIT 36`,
      [sucursal]
    );
    res.json(rows.map((f) => ({
      mes: f.mes, folios: f.folios, reparacion: numero(f.reparacion), mano_obra: numero(f.mano_obra),
      costo_piezas: numero(f.costo_piezas), utilidad: numero(f.utilidad),
    })));
  } catch (err) {
    responderError(res, err);
  }
});

// Detalle de un folio entregado para revisarlo (o para ver como quedo su revision).
router.get('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw falla(404, 'Folio no encontrado.');
    const { rows } = await pool.query(
      `SELECT r.id, r.folio, r.estado, r.origen_reparacion, r.sucursal_id, sc.nombre AS sucursal_nombre, c.nombre AS cliente_nombre,
              r.equipo_marca, r.equipo_modelo, t.nombre AS tecnico_nombre, r.total, r.monto_pagado,
              r.problema_reportado, r.diagnostico,
              ${FECHA_ENTREGA} AS entregado_at, ${COSTO_PIEZAS} AS costo_piezas,
              r.costos_revisados_at, rv.nombre AS revisado_por_nombre, r.revision_entregado_at, r.revision_reparacion,
              r.revision_mano_obra, r.revision_costo_piezas, r.revision_utilidad
       FROM reparaciones r
       LEFT JOIN clientes c ON c.id = r.cliente_id
       JOIN sucursales sc ON sc.id = r.sucursal_id
       LEFT JOIN usuarios t ON t.id = r.tecnico_id
       LEFT JOIN usuarios rv ON rv.id = r.costos_revisados_por
       WHERE r.id = $1`,
      [req.params.id]
    );
    const folio = rows[0];
    const propia = req.usuario.rol === 'admin' ? req.usuario.sucursal_id : null;
    if (!folio || folio.estado !== 'entregado' || folio.origen_reparacion !== 'cliente' || (propia && folio.sucursal_id !== propia)) {
      throw falla(404, 'Folio no encontrado en la revisión de costos.');
    }
    const piezas = await pool.query(
      `SELECT COALESCE(p.nombre, ref.nombre) AS nombre, rr.cantidad, rr.costo, COALESCE(rr.precio, rr.costo) AS precio
       FROM reparacion_refacciones rr
       LEFT JOIN productos p ON p.id = rr.producto_id
       LEFT JOIN refacciones ref ON ref.id = rr.refaccion_id
       WHERE rr.reparacion_id = $1
       ORDER BY nombre`,
      [req.params.id]
    );
    res.json({ ...folio, revisada: folio.costos_revisados_at !== null, piezas: piezas.rows });
  } catch (err) {
    responderError(res, err);
  }
});

// Marca el folio como revisado y guarda la foto de las cifras. mano_obra es obligatoria (puede ser 0). costo_piezas es
// opcional: sin el se toma el costo real de las piezas del folio, pero se puede corregir con lo que dice la factura.
router.post('/:id/revisar', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw falla(404, 'Folio no encontrado.');
    const { mano_obra: manoObra, costo_piezas: costoPiezas } = req.body ?? {};
    if (!esMonto(manoObra)) throw falla(400, 'Captura la mano de obra del técnico (un número mayor o igual a 0, puede ser 0).');
    if (costoPiezas !== undefined && costoPiezas !== null && !esMonto(costoPiezas)) {
      throw falla(400, 'El costo de las piezas debe ser un número mayor o igual a 0.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT r.id, r.folio, r.estado, r.origen_reparacion, r.sucursal_id, r.monto_pagado, r.costos_revisados_at,
                ${FECHA_ENTREGA} AS entregado_at, ${COSTO_PIEZAS} AS costo_piezas
         FROM reparaciones r WHERE r.id = $1 FOR UPDATE OF r`,
        [req.params.id]
      );
      const folio = rows[0];
      const propia = req.usuario.rol === 'admin' ? req.usuario.sucursal_id : null;
      if (!folio || (propia && folio.sucursal_id !== propia)) throw falla(404, 'Folio no encontrado.');
      if (folio.estado !== 'entregado' || folio.origen_reparacion !== 'cliente') throw falla(409, 'Solo se revisan los costos de folios entregados a un cliente.');
      if (folio.costos_revisados_at) throw falla(409, 'Este folio ya se revisó. El dueño puede reabrir la revisión si hay que corregirla.');

      const reparacion = redondear(folio.monto_pagado);
      const mano = redondear(manoObra);
      const piezas = redondear(costoPiezas ?? folio.costo_piezas);
      const utilidad = redondear(reparacion - mano - piezas);
      const actualizado = await client.query(
        `UPDATE reparaciones
         SET costos_revisados_at = now(), costos_revisados_por = $2, revision_entregado_at = $3,
             revision_reparacion = $4, revision_mano_obra = $5, revision_costo_piezas = $6, revision_utilidad = $7
         WHERE id = $1
         RETURNING folio, costos_revisados_at, revision_entregado_at, revision_reparacion, revision_mano_obra, revision_costo_piezas, revision_utilidad`,
        [req.params.id, req.usuario.sub, folio.entregado_at, reparacion, mano, piezas, utilidad]
      );
      await client.query('COMMIT');
      res.json(actualizado.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    responderError(res, err);
  }
});

// Solo el dueño: regresa el folio a la lista de por revisar para corregir las cifras.
router.post('/:id/reabrir', requireRole('dueño'), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw falla(404, 'Folio no encontrado.');
    const { rows } = await pool.query(
      `UPDATE reparaciones
       SET costos_revisados_at = NULL, costos_revisados_por = NULL, revision_entregado_at = NULL,
           revision_reparacion = NULL, revision_mano_obra = NULL, revision_costo_piezas = NULL, revision_utilidad = NULL
       WHERE id = $1 AND costos_revisados_at IS NOT NULL
       RETURNING folio`,
      [req.params.id]
    );
    if (!rows[0]) {
      const existe = await pool.query(`SELECT 1 FROM reparaciones WHERE id = $1`, [req.params.id]);
      throw falla(existe.rows[0] ? 409 : 404, existe.rows[0] ? 'Este folio no está revisado.' : 'Folio no encontrado.');
    }
    res.json({ folio: rows[0].folio, reabierta: true });
  } catch (err) {
    responderError(res, err);
  }
});

module.exports = router;
