const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calcularResumenFinanciero } = require('../utils/resumenFinanciero');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/resumen', async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos (YYYY-MM-DD).' });
  res.json(await calcularResumenFinanciero(desde, hasta));
});

module.exports = router;
