const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'community_manager'));

const PLATAFORMAS_VALIDAS = ['instagram', 'facebook'];

router.get('/', async (req, res) => {
  const { estado } = req.query;
  const { rows } = await pool.query(
    `SELECT c.id, c.plataforma, c.publicacion_id, p.hook AS publicacion_hook,
            c.autor_nombre, c.contenido, c.estado, c.respuesta, c.respondido_por,
            u.nombre AS respondido_por_nombre, c.respondido_at, c.created_at
     FROM comentarios_redes c
     LEFT JOIN publicaciones p ON p.id = c.publicacion_id
     LEFT JOIN usuarios u ON u.id = c.respondido_por
     WHERE ($1::text IS NULL OR c.estado::text = $1)
     ORDER BY c.created_at DESC`,
    [estado || null]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { plataforma, publicacion_id, autor_nombre, contenido } = req.body ?? {};
  if (!PLATAFORMAS_VALIDAS.includes(plataforma)) return res.status(400).json({ error: 'plataforma debe ser instagram o facebook.' });
  if (!autor_nombre?.trim()) return res.status(400).json({ error: 'El nombre del autor es requerido.' });
  if (!contenido?.trim()) return res.status(400).json({ error: 'El contenido del comentario es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO comentarios_redes (plataforma, publicacion_id, autor_nombre, contenido)
     VALUES ($1, $2, $3, $4)
     RETURNING id, plataforma, publicacion_id, autor_nombre, contenido, estado, created_at`,
    [plataforma, publicacion_id || null, autor_nombre.trim(), contenido.trim()]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/responder', async (req, res) => {
  const { respuesta } = req.body ?? {};
  if (!respuesta?.trim()) return res.status(400).json({ error: 'La respuesta no puede estar vacía.' });

  const { rows } = await pool.query(
    `UPDATE comentarios_redes SET estado = 'respondido', respuesta = $2, respondido_por = $3, respondido_at = now()
     WHERE id = $1 AND estado = 'pendiente'
     RETURNING id, estado, respuesta, respondido_at`,
    [req.params.id, respuesta.trim(), req.usuario.sub]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede responder un comentario pendiente.' });
  res.json(rows[0]);
});

router.patch('/:id/descartar', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE comentarios_redes SET estado = 'descartado' WHERE id = $1 AND estado = 'pendiente'
     RETURNING id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede descartar un comentario pendiente.' });
  res.json(rows[0]);
});

module.exports = router;
