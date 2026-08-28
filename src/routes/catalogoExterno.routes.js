const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// A diferencia de n8n.routes.js (nosotros llamando hacia n8n), aqui es al
// reves: un servicio externo (ej. el workflow de TRAI en n8n) nos llama a
// nosotros para consultar el catalogo. No hay sesion de usuario de por
// medio, asi que no se puede usar requireAuth — se valida con el mismo
// secreto compartido que ya usamos para autenticarnos con ellos
// (X-Webhook-Secret contra WEBHOOK_SECRET), solo que en sentido contrario.
function verificarSecreto(req, res, next) {
  if (!process.env.WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

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
