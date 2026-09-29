const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

async function obtenerModoCaja(sucursal_id) {
  const { rows } = await pool.query(`SELECT modo_caja FROM sucursales WHERE id = $1`, [sucursal_id]);
  return rows[0]?.modo_caja ?? 'compartida';
}

// Sucursal de un solo cajon fisico: el turno y el resumen son de la sucursal completa, sin
// importar quien vendio o quien cierra -- lo contrario a "individual" (ver abajo), que es el
// comportamiento original de un cajon por cajero.
async function calcularResumenCompartida(sucursal_id) {
  const ultimoCorte = await pool.query(
    `SELECT turno_fin FROM cortes_caja WHERE sucursal_id = $1 ORDER BY turno_fin DESC LIMIT 1`,
    [sucursal_id]
  );
  const desde = ultimoCorte.rows[0]?.turno_fin ?? null;

  const ventasPorMetodo = await pool.query(
    `SELECT metodo_pago, count(*)::int AS cantidad, COALESCE(sum(total), 0) AS total
     FROM ventas
     WHERE sucursal_id = $1 AND estado = 'completada'
       AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo_pago`,
    [sucursal_id, desde]
  );

  // Un abono de credito se atribuye a esta sucursal via la venta que origino el credito. Un
  // credito otorgado directo (sin venta, ver NuevoCreditoModal) no trae sucursal en su propio
  // registro -- para esos, cuenta si quien cobro el abono vendio o registro un gasto en esta
  // sucursal durante el mismo turno (mismo criterio de "trabajo aqui este turno").
  const abonosPorMetodo = await pool.query(
    `SELECT a.metodo, count(*)::int AS cantidad, COALESCE(sum(a.monto), 0) AS total
     FROM abonos a
     JOIN creditos c ON c.id = a.credito_id
     LEFT JOIN ventas v ON v.id = c.venta_id
     WHERE a.created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
       AND (
         v.sucursal_id = $1
         OR (
           v.id IS NULL AND a.usuario_id IN (
             SELECT vendedor_id FROM ventas WHERE sucursal_id = $1 AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
             UNION
             SELECT usuario_id FROM gastos WHERE sucursal_id = $1 AND usuario_id IS NOT NULL AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
           )
         )
       )
     GROUP BY a.metodo`,
    [sucursal_id, desde]
  );
  const abonosApartadoPorMetodo = await pool.query(
    `SELECT aa.metodo, count(*)::int AS cantidad, COALESCE(sum(aa.monto), 0) AS total
     FROM apartado_abonos aa
     JOIN apartados ap ON ap.id = aa.apartado_id
     WHERE ap.sucursal_id = $1
       AND aa.created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY aa.metodo`,
    [sucursal_id, desde]
  );
  const abonosReparacionPorMetodo = await pool.query(
    `SELECT ra.metodo, count(*)::int AS cantidad, COALESCE(sum(ra.monto), 0) AS total
     FROM reparacion_abonos ra
     JOIN reparaciones r ON r.id = ra.reparacion_id
     WHERE r.sucursal_id = $1
       AND ra.created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY ra.metodo`,
    [sucursal_id, desde]
  );

  const salidas = await pool.query(
    `SELECT id, tipo, categoria, monto, descripcion, created_at
     FROM gastos
     WHERE sucursal_id = $1
       AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     ORDER BY created_at`,
    [sucursal_id, desde]
  );

  return armarResumen({ desde, ventasPorMetodo, abonosPorMetodo, abonosApartadoPorMetodo, abonosReparacionPorMetodo, salidas });
}

// Cajon por cajero: el turno de CADA usuario es desde su propio ultimo corte, y el resumen solo
// suma lo que el mismo vendio/cobro -- comportamiento original, para sucursales donde cada quien
// cuenta y cuadra su propio dinero por separado.
async function calcularResumenIndividual(sucursal_id, usuario_id) {
  const ultimoCorte = await pool.query(
    `SELECT turno_fin FROM cortes_caja WHERE sucursal_id = $1 AND usuario_id = $2 ORDER BY turno_fin DESC LIMIT 1`,
    [sucursal_id, usuario_id]
  );
  const desde = ultimoCorte.rows[0]?.turno_fin ?? null;

  const ventasPorMetodo = await pool.query(
    `SELECT metodo_pago, count(*)::int AS cantidad, COALESCE(sum(total), 0) AS total
     FROM ventas
     WHERE sucursal_id = $1 AND vendedor_id = $2 AND estado = 'completada'
       AND created_at > COALESCE($3::timestamptz, date_trunc('day', now()))
     GROUP BY metodo_pago`,
    [sucursal_id, usuario_id, desde]
  );

  // Un abono de credito o de apartado es dinero real que entra a la caja de
  // quien lo cobra (aunque el credito/apartado original sea de otro turno u
  // otro vendedor), asi que cuenta igual que una venta en efectivo/tarjeta.
  const abonosPorMetodo = await pool.query(
    `SELECT metodo, count(*)::int AS cantidad, COALESCE(sum(monto), 0) AS total
     FROM abonos
     WHERE usuario_id = $1
       AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo`,
    [usuario_id, desde]
  );
  const abonosApartadoPorMetodo = await pool.query(
    `SELECT metodo, count(*)::int AS cantidad, COALESCE(sum(monto), 0) AS total
     FROM apartado_abonos
     WHERE usuario_id = $1
       AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo`,
    [usuario_id, desde]
  );

  // Lo cobrado en reparaciones (anticipos y pagos del folio) tambien entra a
  // la caja de quien lo cobra, igual que los abonos de arriba.
  const abonosReparacionPorMetodo = await pool.query(
    `SELECT metodo, count(*)::int AS cantidad, COALESCE(sum(monto), 0) AS total
     FROM reparacion_abonos
     WHERE usuario_id = $1
       AND created_at > COALESCE($2::timestamptz, date_trunc('day', now()))
     GROUP BY metodo`,
    [usuario_id, desde]
  );

  // Salidas de caja del turno (gasto o retiro) — ambas restan del efectivo
  // fisico esperado, aunque solo 'gasto' cuenta como costo del negocio en
  // Finanzas (ver resumenFinanciero.js). 'usuario_id' aqui es quien registro
  // la salida, no necesariamente el vendedor original de la venta.
  const salidas = await pool.query(
    `SELECT id, tipo, categoria, monto, descripcion, created_at
     FROM gastos
     WHERE sucursal_id = $1 AND usuario_id = $2
       AND created_at > COALESCE($3::timestamptz, date_trunc('day', now()))
     ORDER BY created_at`,
    [sucursal_id, usuario_id, desde]
  );

  return armarResumen({ desde, ventasPorMetodo, abonosPorMetodo, abonosApartadoPorMetodo, abonosReparacionPorMetodo, salidas });
}

function armarResumen({ desde, ventasPorMetodo, abonosPorMetodo, abonosApartadoPorMetodo, abonosReparacionPorMetodo, salidas }) {
  const totalSalidas = salidas.rows.reduce((sum, s) => sum + Number(s.monto), 0);

  const totales = { efectivo: 0, tarjeta: 0, credito: 0 };
  let cantidadVentas = 0;
  for (const row of ventasPorMetodo.rows) {
    totales[row.metodo_pago] += Number(row.total);
    cantidadVentas += row.cantidad;
  }
  let cantidadAbonos = 0;
  for (const row of abonosPorMetodo.rows) {
    totales[row.metodo] += Number(row.total);
    cantidadAbonos += row.cantidad;
  }
  for (const row of abonosApartadoPorMetodo.rows) {
    totales[row.metodo] += Number(row.total);
    cantidadAbonos += row.cantidad;
  }
  for (const row of abonosReparacionPorMetodo.rows) {
    totales[row.metodo] += Number(row.total);
    cantidadAbonos += row.cantidad;
  }

  return {
    turno_inicio: desde ?? null,
    total_efectivo: totales.efectivo,
    total_tarjeta: totales.tarjeta,
    total_credito: totales.credito,
    total_sistema: totales.efectivo + totales.tarjeta,
    total_salidas: totalSalidas,
    salidas: salidas.rows,
    cantidad_ventas: cantidadVentas,
    cantidad_abonos: cantidadAbonos,
  };
}

async function calcularResumen(sucursal_id, usuario_id, modoCaja) {
  return modoCaja === 'individual'
    ? calcularResumenIndividual(sucursal_id, usuario_id)
    : calcularResumenCompartida(sucursal_id);
}

// Listado/historial de cortes (turnos) para la pantalla de Historial de
// ventas. En modo individual, un vendedor solo ve sus propios cortes (el
// admin puede ver los de cualquiera o los de todos); en modo compartida no
// hay "propios" que filtrar -- son cortes de la sucursal completa, cualquiera
// que tenga acceso a caja ahi los ve todos.
router.get('/', async (req, res) => {
  const { sucursal_id, usuario_id, desde, hasta } = req.query;
  // Admin y dueño pueden omitir sucursal_id (ven los cortes de todas las
  // sucursales combinados); vendedor lo sigue necesitando, igual que siempre.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  let usuarioFiltro = usuario_id || null;
  if (req.usuario.rol === 'vendedor') {
    const modoCaja = sucursal_id ? await obtenerModoCaja(sucursal_id) : 'individual';
    usuarioFiltro = modoCaja === 'individual' ? req.usuario.sub : null;
  }

  const { rows } = await pool.query(
    `SELECT cc.id, cc.sucursal_id, cc.usuario_id, u.nombre AS usuario_nombre,
            cc.turno_inicio, cc.turno_fin, cc.fondo_inicial, cc.total_efectivo, cc.total_tarjeta,
            cc.total_credito, cc.total_sistema, cc.diferencia, cc.created_at
     FROM cortes_caja cc
     LEFT JOIN usuarios u ON u.id = cc.usuario_id
     WHERE ($1::uuid IS NULL OR cc.sucursal_id = $1::uuid)
       AND ($2::uuid IS NULL OR cc.usuario_id = $2::uuid)
       AND ($3::timestamptz IS NULL OR cc.turno_fin >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR cc.turno_fin < $4::timestamptz)
     ORDER BY cc.turno_fin DESC
     LIMIT 200`,
    [sucursal_id || null, usuarioFiltro, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/resumen', async (req, res) => {
  const { sucursal_id } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  const sucursal = await pool.query(`SELECT fondo_caja_default, modo_caja FROM sucursales WHERE id = $1`, [sucursal_id]);
  if (!sucursal.rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada.' });
  const modoCaja = sucursal.rows[0].modo_caja;
  const resumen = await calcularResumen(sucursal_id, req.usuario.sub, modoCaja);
  res.json({ ...resumen, fondo_caja_default: sucursal.rows[0].fondo_caja_default ?? 0, modo_caja: modoCaja });
});

router.post('/', async (req, res) => {
  const { sucursal_id, fondo_inicial, efectivo_contado } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!(efectivo_contado >= 0)) return res.status(400).json({ error: 'efectivo_contado es requerido.' });

  const modoCaja = await obtenerModoCaja(sucursal_id);
  const resumen = await calcularResumen(sucursal_id, req.usuario.sub, modoCaja);
  const fondo = fondo_inicial ?? 0;
  const diferencia = efectivo_contado - (fondo + resumen.total_efectivo - resumen.total_salidas);

  const { rows } = await pool.query(
    `INSERT INTO cortes_caja (sucursal_id, usuario_id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_credito, total_sistema, diferencia)
     VALUES ($1, $2, COALESCE($3::timestamptz, date_trunc('day', now())), now(), $4, $5, $6, $7, $8, $9)
     RETURNING id, turno_inicio, turno_fin, fondo_inicial, total_efectivo, total_tarjeta, total_credito, total_sistema, diferencia`,
    [sucursal_id, req.usuario.sub, resumen.turno_inicio, fondo, resumen.total_efectivo, resumen.total_tarjeta, resumen.total_credito, resumen.total_sistema, diferencia]
  );

  res.status(201).json(rows[0]);
});

module.exports = router;
