const express = require('express');
const { pool } = require('../db');
const { requireAuth, esAdminODueno } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Buscador global de la barra superior: clientes, productos (equipos y
// accesorios) y ordenes de taller. Cada seccion respeta exactamente el mismo
// filtro de rol que ya usa su propia pantalla — no es una ruta nueva de
// permisos, solo agrega los resultados de rutas que ya existian.
router.get('/', async (req, res) => {
  const { q, sucursal_id } = req.query;
  const termino = (q || '').trim();
  if (termino.length < 2) return res.json({ clientes: [], productos: [], reparaciones: [] });
  // Admin y dueño pueden omitir sucursal_id (buscan en todas las sucursales);
  // los demas roles lo siguen necesitando para las ordenes de taller.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const rol = req.usuario.rol;
  const puedeVerClientesYReparaciones = esAdminODueno(rol) || rol === 'vendedor';
  const like = `%${termino}%`;

  const [clientes, productos, reparaciones] = await Promise.all([
    puedeVerClientesYReparaciones
      ? pool.query(
          `SELECT id, nombre, telefono FROM clientes WHERE nombre ILIKE $1 OR telefono ILIKE $1 ORDER BY nombre LIMIT 5`,
          [like]
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT id, nombre, tipo, precio_venta FROM productos WHERE activo = true AND nombre ILIKE $1 ORDER BY nombre LIMIT 5`,
      [like]
    ),
    puedeVerClientesYReparaciones || rol === 'tecnico'
      ? pool.query(
          `SELECT r.id, r.folio, r.estado, c.nombre AS cliente_nombre
           FROM reparaciones r JOIN clientes c ON c.id = r.cliente_id
           WHERE ($1::uuid IS NULL OR r.sucursal_id = $1::uuid) AND (r.folio ILIKE $2 OR c.nombre ILIKE $2)
           ORDER BY r.created_at DESC LIMIT 5`,
          [sucursal_id || null, like]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  res.json({
    clientes: clientes.rows,
    productos: productos.rows,
    reparaciones: reparaciones.rows,
  });
});

module.exports = router;
