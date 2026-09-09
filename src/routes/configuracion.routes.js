const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');

const router = express.Router();

router.use(requireAuth);

// Cualquier rol autenticado puede LEER la configuracion (Equipos la
// necesita para saber si debe auto-imprimir el sticker al dar de alta un
// equipo, sin importar que rol lo esta registrando) -- solo modificarla
// sigue restringido a admin.
router.get('/', async (req, res) => {
  res.json(await obtenerConfiguracionTicket());
});

router.patch('/', requireRole('admin'), async (req, res) => {
  const actual = await obtenerConfiguracionTicket();

  const fields = {
    nombre_negocio: req.body?.nombre_negocio,
    mostrar_direccion: req.body?.mostrar_direccion,
    mostrar_telefono: req.body?.mostrar_telefono,
    mostrar_vendedor: req.body?.mostrar_vendedor,
    mostrar_cliente: req.body?.mostrar_cliente,
    mensaje_pie: req.body?.mensaje_pie,
    imprimir_sticker_auto_equipo: req.body?.imprimir_sticker_auto_equipo,
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
    `UPDATE configuracion_ticket SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  res.json(rows[0]);
});

module.exports = router;
