const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'community_manager'));

// Junta fotos que ya existen en el sistema (Catalogo y Taller) en una sola
// galeria. No hay subida manual ni procesamiento de IA: solo agrega lo que
// ya se cargo en otros modulos.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, 'Producto' AS tipo, p.imagen_url AS url, p.created_at AS fecha
     FROM productos p
     WHERE p.imagen_url IS NOT NULL

     UNION ALL

     SELECT rf.id, (r.folio || ' — ' || rf.etiqueta::text) AS nombre, 'Reparación' AS tipo, rf.url, rf.created_at AS fecha
     FROM reparacion_fotos rf
     JOIN reparaciones r ON r.id = rf.reparacion_id

     ORDER BY fecha DESC`
  );
  res.json(rows);
});

module.exports = router;
