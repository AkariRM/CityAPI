const express = require('express');
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
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
  const { desde, hasta, formato, sucursal_id } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos (YYYY-MM-DD).' });

  const resumen = await calcularResumenFinanciero(desde, hasta, sucursal_id || null);

  // Un reporte de una sola sucursal tiene que decirlo, o al abrir el PDF/XML
  // parece el del negocio completo.
  let sucursalNombre = 'Todas las sucursales';
  if (sucursal_id) {
    const { rows } = await pool.query(`SELECT nombre FROM sucursales WHERE id = $1`, [sucursal_id]);
    sucursalNombre = rows[0]?.nombre ?? 'Sucursal';
  }

  if (formato === 'xml') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<reporteFinanciero>
  <periodo desde="${escaparXml(resumen.desde)}" hasta="${escaparXml(resumen.hasta)}" sucursal="${escaparXml(sucursalNombre)}"/>
  <numeroVentas>${resumen.numero_ventas}</numeroVentas>
  <ingresos>${resumen.ingresos.toFixed(2)}</ingresos>
  <ingresosReparaciones>${resumen.ingresos_reparaciones.toFixed(2)}</ingresosReparaciones>
  <costoVentas>${resumen.costo_ventas.toFixed(2)}</costoVentas>
  <utilidadBruta>${resumen.utilidad_bruta.toFixed(2)}</utilidadBruta>
  <gastos>${resumen.gastos.toFixed(2)}</gastos>
  <nominasPagadas>${resumen.nominas_pagadas.toFixed(2)}</nominasPagadas>
  <nominasTaller>${resumen.nominas_taller.toFixed(2)}</nominasTaller>
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
  doc.fontSize(10).fillColor('#666666').text(`Periodo: ${desde} a ${hasta} · ${sucursalNombre}`, { align: 'center' });
  doc.fillColor('#000000').moveDown(2);

  doc.fontSize(12).text(`Ventas completadas: ${resumen.numero_ventas}`);
  doc.moveDown(0.5);

  function fila(label, valor) {
    doc.fontSize(12).text(`${label}: ${money(valor)}`);
    doc.moveDown(0.3);
  }

  fila('Ingresos por ventas', resumen.ingresos);
  fila('Ingresos por reparaciones (cobrado)', resumen.ingresos_reparaciones);
  fila('Costo de ventas', resumen.costo_ventas);
  fila('Utilidad bruta', resumen.utilidad_bruta);
  fila('Gastos', resumen.gastos);
  fila('Nóminas pagadas', resumen.nominas_pagadas);
  if (resumen.nominas_taller > 0) {
    doc.fontSize(10).fillColor('#666666').text(`Incluye ${money(resumen.nominas_taller)} de sueldos del taller (no se cargan a ninguna sucursal).`);
    doc.fillColor('#000000');
  }
  doc.moveDown(0.5);
  doc.fontSize(14).text(`Utilidad neta: ${money(resumen.utilidad_neta)}`);

  doc.end();
});

module.exports = router;
