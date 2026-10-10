const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');

const router = express.Router();

// GET /negocio-externo
// Lo que el agente de WhatsApp (TRAI) puede decir del negocio: sucursales activas (direccion, telefono y horario) y las politicas
// oficiales que el dueño definio. Solo salen las politicas activas y con texto: un tema sin definir no se manda, y el agente dice
// que lo confirma. Una sucursal sin direccion u horario los trae en null (equivale al "PENDIENTE" del prompt).
//
// `tiendas_texto` es lo mismo que `sucursales` ya redactado en un renglon por sucursal, para meterlo directo en el prompt.
router.get('/', verificarSecreto, async (req, res) => {
  const [sucursales, politicas] = await Promise.all([
    pool.query(`SELECT id, nombre, direccion, telefono, horario FROM sucursales WHERE activo = true ORDER BY nombre`),
    pool.query(`SELECT tema, titulo, contenido FROM politicas_negocio WHERE activo = true AND btrim(contenido) <> '' ORDER BY orden, titulo`),
  ]);
  const tiendas = sucursales.rows.map((s) => ({
    id: s.id,
    nombre: s.nombre,
    direccion: s.direccion?.trim() || null,
    telefono: s.telefono?.trim() || null,
    horario: s.horario?.trim() || null,
  }));
  const tiendasTexto = tiendas
    .map((s) => `${s.nombre}: ${s.direccion ?? 'dirección pendiente'}. Horario: ${s.horario ?? 'pendiente'}.${s.telefono ? ` Tel. ${s.telefono}.` : ''}`)
    .join('\n');
  res.json({
    empresa: 'cityphone',
    sucursales: tiendas,
    tiendas_texto: tiendasTexto,
    politicas: politicas.rows,
  });
});

module.exports = router;
