const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Opciones EXTRA para el alta de equipos ("Nuevo equipo"): estatus de companias (LIBRE, AT&T,
// MDM...) y tipos de chip (CHIP, ESIM) que el negocio necesita y no vienen de fabrica.
// Las de fabrica viven en la app (lib/nombreEquipo.js); aqui solo se guardan las que agrega el
// administrador, y la app las suma a las suyas. Leerlas puede cualquier rol (todos dan de alta
// equipos); agregar una es solo de Supervisor/Administrador.

const TIPOS = ['estatus', 'chip'];

// Las que ya trae la app de fabrica (mismos valores que nombreEquipo.js): no se pueden repetir.
// RSIM es un ESTATUS (asi lo escribe el proveedor en el Excel), no un chip.
const DE_FABRICA = {
  estatus: ['LIBRE', 'NO LIBRE', 'AT&T', 'TELCEL', 'MOVISTAR', 'MDM', 'MEP', 'RSIM'],
  chip: ['CHIP', 'ESIM'],
};

// Compara sin espacios, guiones ni puntos: "R-SIM", "r sim" y "RSIM" son la misma opcion.
const claveDe = (texto) => String(texto).toUpperCase().replace(/[\s\-.]/g, '');

// 1 a 30 caracteres; empieza y termina con letra o numero (el nombre del equipo se separa por
// palabras completas, y un guion o punto al final rompe ese corte). Sin % ni comas, que ya
// significan bateria y separador en los nombres.
const VALIDO = /^[A-ZÁÉÍÓÚÜÑ0-9](?:[A-ZÁÉÍÓÚÜÑ0-9 &/.\-]{0,28}[A-ZÁÉÍÓÚÜÑ0-9])?$/;

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, tipo, valor, etiqueta FROM opciones_equipo ORDER BY tipo, created_at, valor`
  );
  res.json(rows);
});

// POST /opciones-equipo   { tipo: 'estatus' | 'chip', nombre: 'Izzi' }
router.post('/', requireRole('admin'), async (req, res) => {
  const { tipo, nombre } = req.body ?? {};
  if (!TIPOS.includes(tipo)) return res.status(400).json({ error: "tipo debe ser 'estatus' o 'chip'." });
  if (typeof nombre !== 'string') return res.status(400).json({ error: 'nombre es requerido.' });

  const etiqueta = nombre.replace(/\s+/g, ' ').trim();
  const valor = etiqueta.toUpperCase();
  if (!VALIDO.test(valor)) {
    return res.status(400).json({ error: 'El nombre debe tener de 1 a 30 caracteres: letras, números, espacios y & / . -' });
  }
  // Un numero suelto o una capacidad (128GB) se confundirian con el almacenamiento y la bateria del nombre.
  if (/^\d+$/.test(valor) || /^\d{1,4}\s?(GB|TB)$/.test(valor)) {
    return res.status(400).json({ error: 'Ese nombre se confundiría con el almacenamiento o la batería del equipo.' });
  }

  const clave = claveDe(valor);
  const deFabrica = TIPOS.find((t) => DE_FABRICA[t].some((v) => claveDe(v) === clave));
  if (deFabrica) {
    return res.status(409).json({ error: `Ese ya viene en la lista de ${deFabrica === 'chip' ? 'chip' : 'estatus'}.` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO opciones_equipo (tipo, valor, etiqueta, clave, creado_por) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tipo, valor, etiqueta`,
      [tipo, valor, etiqueta, clave, req.usuario.sub]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya está agregado.' });
    throw err;
  }
});

module.exports = router;
