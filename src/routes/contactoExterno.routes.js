const express = require('express');
const { pool } = require('../db');
const { verificarSecreto } = require('../middleware/webhookSecret');

const router = express.Router();

// GET /contacto-externo?telefono=+523531234567
// Identifica quien escribe por WhatsApp: personal de CityCorp (cualquier
// rol, cualquier empresa, mientras siga activo) o cliente registrado de
// CityPhone. Devuelve 404 si no hay coincidencia — es el caso esperado para
// alguien nuevo, no un error.
//
// El telefono se normaliza a los ultimos 10 digitos en ambos lados de la
// comparacion: WhatsApp manda E.164 ("+52..."), pero aqui se captura en
// texto libre (con o sin espacios/guiones, con o sin codigo de pais).
router.get('/', verificarSecreto, async (req, res) => {
  const telefono = String(req.query.telefono ?? '').replace(/\D/g, '').slice(-10);
  if (telefono.length !== 10) {
    return res.status(400).json({ error: 'telefono inválido — manda el número completo (E.164 o 10 dígitos).' });
  }

  const staff = await pool.query(
    `SELECT id, nombre, rol, telefono FROM usuarios
     WHERE activo = true AND right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
     LIMIT 1`,
    [telefono]
  );
  if (staff.rows[0]) {
    const u = staff.rows[0];
    return res.json({ id: u.id, nombre: u.nombre, rol: u.rol, telefono: u.telefono });
  }

  const cliente = await pool.query(
    `SELECT id, nombre, telefono FROM clientes
     WHERE right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
     LIMIT 1`,
    [telefono]
  );
  if (cliente.rows[0]) {
    const c = cliente.rows[0];
    return res.json({ id: c.id, nombre: c.nombre, rol: 'cliente', telefono: c.telefono });
  }

  res.status(404).json({ error: 'Contacto no encontrado.' });
});

module.exports = router;
