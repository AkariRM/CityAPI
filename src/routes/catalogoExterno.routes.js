const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');

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
      `SELECT p.id, p.sku, p.nombre, p.tipo, c.nombre AS categoria, p.marca, p.modelo, p.precio_venta, p.imagen_url
       FROM productos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE p.activo = true
         AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
       ORDER BY p.nombre`,
      [ids]
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'id/ids invalido — debe ser uuid.' });
    throw err;
  }
});

module.exports = router;
