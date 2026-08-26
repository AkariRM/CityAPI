const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');
const { obtenerConfiguracionTicketAurea } = require('../utils/configuracionTicketAurea');

const router = express.Router();
router.use(requireAuth, requireRole('admin'), requireEmpresa('aurea'));

router.get('/', async (req, res) => {
  res.json(await obtenerConfiguracionTicketAurea());
});

router.patch('/', async (req, res) => {
  const actual = await obtenerConfiguracionTicketAurea();

  const fields = {
    nombre_negocio: req.body?.nombre_negocio,
    mostrar_direccion: req.body?.mostrar_direccion,
    mostrar_telefono: req.body?.mostrar_telefono,
    mostrar_vendedor: req.body?.mostrar_vendedor,
    mostrar_cliente: req.body?.mostrar_cliente,
    mensaje_pie: req.body?.mensaje_pie,
    fondo_caja_default: req.body?.fondo_caja_default,
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No hay campos para actualizar.' });

  values.push(actual.id);
  const { rows } = await pool.query(
    `UPDATE aurea_configuracion_ticket SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  res.json(rows[0]);
});

module.exports = router;
