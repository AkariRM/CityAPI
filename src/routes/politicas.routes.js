const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('dueño'));

// Politicas oficiales del negocio (garantia, pagos, apartados, envios, diagnostico, facturacion y las que se agreguen): lo unico
// que el agente de WhatsApp puede afirmar sobre esos temas. Solo las edita el dueño: lo que dicen compromete a la tienda con
// los clientes. contenido vacio = pendiente de definir (el agente no la ve). tema es la clave estable y sin acentos;
// titulo es como se muestra y se puede cambiar sin cambiar tema.

const COLUMNAS = 'id, tema, titulo, contenido, activo, orden, updated_at';
const MAX_TITULO = 60;
const MAX_CONTENIDO = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Cambios y devoluciones" -> "cambios_y_devoluciones"
function temaDe(titulo) {
  return titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
}

// Devuelve el mensaje de error o null.
function validarTitulo(titulo) {
  if (typeof titulo !== 'string' || !titulo.trim()) return 'El nombre de la política es requerido.';
  if (titulo.trim().length > MAX_TITULO) return `El nombre debe tener máximo ${MAX_TITULO} caracteres.`;
  if (!temaDe(titulo)) return 'El nombre debe tener al menos una letra o un número.';
  return null;
}
function validarContenido(contenido) {
  if (typeof contenido !== 'string') return 'El texto de la política debe ser texto.';
  if (contenido.length > MAX_CONTENIDO) return `El texto debe tener máximo ${MAX_CONTENIDO} caracteres.`;
  return null;
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUMNAS} FROM politicas_negocio ORDER BY orden, titulo`);
  res.json(rows);
});

// POST /politicas   { titulo, contenido? }
router.post('/', async (req, res) => {
  const { titulo, contenido = '' } = req.body ?? {};
  const error = validarTitulo(titulo) ?? validarContenido(contenido);
  if (error) return res.status(400).json({ error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO politicas_negocio (tema, titulo, contenido, orden)
       VALUES ($1, $2, $3, COALESCE((SELECT max(orden) FROM politicas_negocio), 0) + 1)
       RETURNING ${COLUMNAS}`,
      [temaDe(titulo), titulo.trim(), contenido.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una política con ese nombre.' });
    throw err;
  }
});

// PATCH /politicas/:id   { titulo?, contenido?, activo? }  (el tema no cambia: el agente lo usa como clave)
router.patch('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Política no encontrada.' });
  const { titulo, contenido, activo } = req.body ?? {};
  if (titulo !== undefined) {
    const error = validarTitulo(titulo);
    if (error) return res.status(400).json({ error });
  }
  if (contenido !== undefined) {
    const error = validarContenido(contenido);
    if (error) return res.status(400).json({ error });
  }
  if (activo !== undefined && typeof activo !== 'boolean') return res.status(400).json({ error: 'activo debe ser verdadero o falso.' });

  const sets = [];
  const values = [];
  let i = 1;
  if (titulo !== undefined) { sets.push(`titulo = $${i++}`); values.push(titulo.trim()); }
  if (contenido !== undefined) { sets.push(`contenido = $${i++}`); values.push(contenido.trim()); }
  if (activo !== undefined) { sets.push(`activo = $${i++}`); values.push(activo); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });
  sets.push('updated_at = now()');

  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE politicas_negocio SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${COLUMNAS}`, values);
  if (!rows[0]) return res.status(404).json({ error: 'Política no encontrada.' });
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Política no encontrada.' });
  const { rowCount } = await pool.query(`DELETE FROM politicas_negocio WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Política no encontrada.' });
  res.status(204).end();
});

module.exports = router;
