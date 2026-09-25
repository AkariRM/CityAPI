const express = require('express');
const { pool } = require('../db');
const { requireAuth, esAdminODueno } = require('../middleware/auth');
const { alcanceReparaciones, esPersonalTaller } = require('../utils/alcanceReparaciones');

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
  // Admin y dueño pueden omitir sucursal_id (buscan en todas las sucursales); el personal del taller
  // no tiene sucursal (y no busca productos ni clientes); los demas lo siguen necesitando.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol) && !esPersonalTaller(req.usuario.rol)) {
    return res.status(400).json({ error: 'sucursal_id es requerido.' });
  }

  // El IMEI (completo o sus ultimos digitos, que es la referencia de la calcomania) tambien
  // encuentra el equipo: se compara solo con letras y numeros y desde 4 caracteres.
  const qCodigo = termino.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const qImei = qCodigo.length >= 4 ? qCodigo : null;

  const rol = req.usuario.rol;
  const puedeVerClientesYReparaciones = esAdminODueno(rol) || rol === 'vendedor';
  // El taller (tecnico y Supervisor del taller) solo busca reparaciones: sin catalogo ni clientes.
  const puedeVerProductos = !esPersonalTaller(rol);
  // Cada rol encuentra solo las reparaciones a su alcance (ver utils/alcanceReparaciones.js).
  const alcance = alcanceReparaciones(req.usuario);
  const like = `%${termino}%`;

  const [clientes, productos, reparaciones] = await Promise.all([
    puedeVerClientesYReparaciones
      ? pool.query(
          `SELECT id, nombre, telefono FROM clientes WHERE nombre ILIKE $1 OR telefono ILIKE $1 ORDER BY nombre LIMIT 5`,
          [like]
        )
      : Promise.resolve({ rows: [] }),
    !puedeVerProductos ? Promise.resolve({ rows: [] }) : pool.query(
      `SELECT p.id, p.nombre, p.tipo, p.precio_venta, um.imei AS imei_coincidencia
       FROM productos p
       LEFT JOIN LATERAL (
         SELECT ux.imei FROM unidades_imei ux
         WHERE $2::text IS NOT NULL AND ux.producto_id = p.id
           AND ($3::uuid IS NULL OR ux.sucursal_id = $3::uuid)
           AND right(regexp_replace(upper(ux.imei), '[^0-9A-Z]', '', 'g'), length($2::text)) = $2::text
         ORDER BY (ux.estado = 'disponible') DESC, ux.created_at DESC LIMIT 1
       ) um ON true
       WHERE p.activo = true AND (p.nombre ILIKE $1 OR p.sku ILIKE $1 OR um.imei IS NOT NULL)
       ORDER BY p.nombre LIMIT 5`,
      [like, qImei, sucursal_id || null]
    ),
    !alcance.sinAcceso
      ? pool.query(
          `SELECT r.id, r.folio, r.estado, c.nombre AS cliente_nombre
           FROM reparaciones r JOIN clientes c ON c.id = r.cliente_id
           WHERE ($1::uuid IS NULL OR r.sucursal_id = $1::uuid) AND (r.folio ILIKE $2 OR c.nombre ILIKE $2)
             AND ($3::uuid IS NULL OR r.tecnico_id = $3::uuid)
             AND ($4::uuid IS NULL OR r.sucursal_id = $4::uuid)
           ORDER BY r.created_at DESC LIMIT 5`,
          [sucursal_id || null, like, alcance.tecnicoId ?? null, alcance.sucursalId ?? null]
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
