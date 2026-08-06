const express = require('express');
const PDFDocument = require('pdfkit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calcularResumenFinanciero } = require('../utils/resumenFinanciero');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

function money(n) {
  return `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escaparXml(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

router.get('/financiero', async (req, res) => {
  const { desde, hasta, formato } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos (YYYY-MM-DD).' });

  const resumen = await calcularResumenFinanciero(desde, hasta);

  if (formato === 'xml') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<reporteFinanciero>
  <periodo desde="${escaparXml(resumen.desde)}" hasta="${escaparXml(resumen.hasta)}"/>
  <numeroVentas>${resumen.numero_ventas}</numeroVentas>
  <ingresos>${resumen.ingresos.toFixed(2)}</ingresos>
  <costoVentas>${resumen.costo_ventas.toFixed(2)}</costoVentas>
  <utilidadBruta>${resumen.utilidad_bruta.toFixed(2)}</utilidadBruta>
  <gastos>${resumen.gastos.toFixed(2)}</gastos>
  <nominasPagadas>${resumen.nominas_pagadas.toFixed(2)}</nominasPagadas>
  <utilidadNeta>${resumen.utilidad_neta.toFixed(2)}</utilidadNeta>
</reporteFinanciero>
`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-financiero-${desde}-a-${hasta}.xml"`);
    return res.send(xml);
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="reporte-financiero-${desde}-a-${hasta}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text('CityPhone SGI', { align: 'center' });
  doc.fontSize(14).text('Reporte financiero', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666666').text(`Periodo: ${desde} a ${hasta}`, { align: 'center' });
  doc.fillColor('#000000').moveDown(2);

  doc.fontSize(12).text(`Ventas completadas: ${resumen.numero_ventas}`);
  doc.moveDown(0.5);

  function fila(label, valor) {
    doc.fontSize(12).text(`${label}: ${money(valor)}`);
    doc.moveDown(0.3);
  }

  fila('Ingresos', resumen.ingresos);
  fila('Costo de ventas', resumen.costo_ventas);
  fila('Utilidad bruta', resumen.utilidad_bruta);
  fila('Gastos', resumen.gastos);
  fila('Nóminas pagadas', resumen.nominas_pagadas);
  doc.moveDown(0.5);
  doc.fontSize(14).text(`Utilidad neta: ${money(resumen.utilidad_neta)}`);

  doc.end();
});

module.exports = router;
