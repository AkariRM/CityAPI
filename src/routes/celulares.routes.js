const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const DIAS_GARANTIA_APARATO = 30;

// Registro de garantías por celular vendido — distinto del historial de
// ventas general: solo equipos con IMEI (tipo nuevo/usado), y solo la unidad
// que sigue activa con el cliente. Une las tres formas en las que una unidad
// termina en manos de un cliente (venta directa, apartado completado, o como
// reemplazo de un cambio) pero EXCLUYE la que ya fue devuelta/reemplazada —
// esa queda solo en la pestaña "Cambios" (GET /cambios), para no mostrar dos
// veces el mismo evento ni mezclar un equipo que ya no esta en circulacion.
router.get('/', async (req, res) => {
  const { sucursal_id } = req.query;

  const { rows } = await pool.query(
    `WITH vendidos AS (
       SELECT vi.unidad_imei_id, v.created_at AS fecha_venta, v.cliente_id
       FROM venta_items vi
       JOIN ventas v ON v.id = vi.venta_id AND v.estado = 'completada'
       WHERE vi.unidad_imei_id IS NOT NULL
         AND ($1::uuid IS NULL OR v.sucursal_id = $1::uuid)
       UNION ALL
       SELECT a.unidad_imei_id, a.updated_at AS fecha_venta, a.cliente_id
       FROM apartados a
       WHERE a.unidad_imei_id IS NOT NULL AND a.estado = 'completado'
         AND ($1::uuid IS NULL OR a.sucursal_id = $1::uuid)
       UNION ALL
       SELECT cam.unidad_imei_nueva_id, cam.created_at AS fecha_venta, v.cliente_id
       FROM cambios cam
       JOIN ventas v ON v.id = cam.venta_original_id
       WHERE cam.unidad_imei_nueva_id IS NOT NULL
         AND ($1::uuid IS NULL OR v.sucursal_id = $1::uuid)
     ),
     reemplazadas AS (
       SELECT unidad_imei_devuelta_id AS unidad_imei_id FROM cambios WHERE unidad_imei_devuelta_id IS NOT NULL
     )
     SELECT u.id AS unidad_imei_id, u.imei, u.created_at AS fecha_compra,
            p.nombre AS modelo,
            ven.fecha_venta,
            ven.fecha_venta + make_interval(days => $2::int) AS garantia_aparato_vence,
            cl.nombre AS cliente_nombre
     FROM vendidos ven
     JOIN unidades_imei u ON u.id = ven.unidad_imei_id
     JOIN productos p ON p.id = u.producto_id
     LEFT JOIN clientes cl ON cl.id = ven.cliente_id
     WHERE p.tipo IN ('nuevo', 'usado')
       AND u.id NOT IN (SELECT unidad_imei_id FROM reemplazadas)
     ORDER BY ven.fecha_venta DESC`,
    [sucursal_id || null, DIAS_GARANTIA_APARATO]
  );

  const ahora = Date.now();
  res.json(
    rows.map((r) => ({
      unidad_imei_id: r.unidad_imei_id,
      imei: r.imei,
      modelo: r.modelo,
      cliente_nombre: r.cliente_nombre,
      fecha_compra: r.fecha_compra,
      fecha_venta: r.fecha_venta,
      garantia_aparato_vence: r.garantia_aparato_vence,
      garantia_aparato_vigente: new Date(r.garantia_aparato_vence).getTime() > ahora,
      garantia_senal: 'de_por_vida',
    }))
  );
});

// Historial de cambios de celular (reemplazo de una unidad IMEI por otra),
// para la pestaña "Cambios" del registro — separado de la lista principal
// para no mezclar el equipo activo con el que ya salio de circulacion.
router.get('/cambios', async (req, res) => {
  const { sucursal_id } = req.query;

  const { rows } = await pool.query(
    `SELECT cam.id, cam.created_at, cam.motivo, cam.diferencia,
            cl.nombre AS cliente_nombre,
            ua.imei AS imei_anterior, pa.nombre AS modelo_anterior,
            un.imei AS imei_nuevo, pn.nombre AS modelo_nuevo
     FROM cambios cam
     JOIN ventas v ON v.id = cam.venta_original_id
     LEFT JOIN clientes cl ON cl.id = v.cliente_id
     JOIN unidades_imei ua ON ua.id = cam.unidad_imei_devuelta_id
     LEFT JOIN productos pa ON pa.id = cam.producto_devuelto_id
     LEFT JOIN unidades_imei un ON un.id = cam.unidad_imei_nueva_id
     LEFT JOIN productos pn ON pn.id = cam.producto_nuevo_id
     WHERE cam.unidad_imei_devuelta_id IS NOT NULL
       AND ($1::uuid IS NULL OR v.sucursal_id = $1::uuid)
     ORDER BY cam.created_at DESC`,
    [sucursal_id || null]
  );

  res.json(rows);
});

module.exports = router;
