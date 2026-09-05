const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');
const { derivarMarcaCategoria, extraerAlmacenamientoGb, extraerSaludBateria } = require('../utils/clasificarEquipo');

const router = express.Router();

// GET /catalogo-externo            -> catalogo completo (productos activos)
// GET /catalogo-externo?id=uuid    -> un producto
// GET /catalogo-externo?ids=uuid1,uuid2 -> varios productos
// Se excluyen a proposito costo, precio_mayoreo, precio_revendedor,
// proveedor y stock: son datos internos del negocio, no algo que deba
// salir hacia un servicio externo.
router.get('/', verificarSecreto, async (req, res) => {
  const idsParam = req.query.ids || req.query.id;
  const ids = idsParam
    ? String(idsParam).split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.sku, p.nombre, p.tipo, c.nombre AS categoria, p.marca, p.modelo,
              p.almacenamiento, p.precio_venta, p.imagen_url,
              (SELECT u.condicion FROM unidades_imei u WHERE u.producto_id = p.id AND u.condicion IS NOT NULL LIMIT 1) AS condicion_unidad
       FROM productos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.activo = true
         AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
       ORDER BY p.nombre`,
      [ids]
    );

    // marca/categoria se derivan del nombre SOLO cuando el dato real esta
    // vacio (la gran mayoria de los 899 equipos nunca los capturo a mano) —
    // ver clasificarEquipo.js para el detalle y por que no se intenta
    // adivinar el "modelo" exacto de la misma forma.
    res.json(
      rows.map((p) => {
        const { marca, categoria } = derivarMarcaCategoria(p);
        return {
          id: p.id,
          sku: p.sku,
          nombre: p.nombre,
          tipo: p.tipo,
          categoria,
          marca,
          modelo: p.modelo || p.nombre,
          almacenamiento_gb: extraerAlmacenamientoGb(p.almacenamiento) ?? extraerAlmacenamientoGb(p.nombre),
          salud_bateria: extraerSaludBateria(p.condicion_unidad),
          precio_venta: p.precio_venta,
          imagen_url: p.imagen_url,
        };
      })
    );
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'id/ids invalido — debe ser uuid.' });
    throw err;
  }
});

module.exports = router;
