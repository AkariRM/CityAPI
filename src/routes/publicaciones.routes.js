const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'community_manager'));

const PLATAFORMAS_VALIDAS = ['instagram', 'facebook'];
const TIPOS_CONTENIDO_VALIDOS = ['reel', 'carrusel', 'historia', 'post_estatico', 'video'];

router.get('/', async (req, res) => {
  const { estado, plataforma, desde, hasta } = req.query;
  const { rows } = await pool.query(
    `SELECT p.id, p.plataforma, p.tipo_contenido, p.hook, p.contenido_texto, p.cta, p.hashtags,
            p.imagen_url, p.estado, p.url_publicacion, p.post_id, p.fecha_programada, p.producto_id, pr.nombre AS producto_nombre,
            p.promocion_id, promo.nombre AS promocion_nombre, p.creado_por, u.nombre AS creado_por_nombre,
            p.created_at, p.updated_at
     FROM publicaciones p
     LEFT JOIN productos pr ON pr.id = p.producto_id
     LEFT JOIN promociones promo ON promo.id = p.promocion_id
     LEFT JOIN usuarios u ON u.id = p.creado_por
     WHERE ($1::text IS NULL OR p.estado::text = $1)
       AND ($2::text IS NULL OR p.plataforma::text = $2)
       AND ($3::timestamptz IS NULL OR p.fecha_programada >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR p.fecha_programada < $4::timestamptz)
     ORDER BY p.fecha_programada NULLS LAST, p.created_at DESC`,
    [estado || null, plataforma || null, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.plataforma, p.tipo_contenido, p.hook, p.contenido_texto, p.cta, p.hashtags,
            p.imagen_url, p.estado, p.url_publicacion, p.post_id, p.fecha_programada, p.producto_id, pr.nombre AS producto_nombre,
            p.promocion_id, promo.nombre AS promocion_nombre, p.creado_por, u.nombre AS creado_por_nombre,
            p.created_at, p.updated_at
     FROM publicaciones p
     LEFT JOIN productos pr ON pr.id = p.producto_id
     LEFT JOIN promociones promo ON promo.id = p.promocion_id
     LEFT JOIN usuarios u ON u.id = p.creado_por
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Publicación no encontrada.' });
  res.json(rows[0]);
});

router.post('/', async (req, res) => {
  const {
    plataforma, tipo_contenido, hook, contenido_texto, cta, hashtags, imagen_url, producto_id, promocion_id, fecha_programada,
    estado, url_publicacion, post_id,
  } = req.body ?? {};

  if (!PLATAFORMAS_VALIDAS.includes(plataforma)) {
    return res.status(400).json({ error: 'plataforma debe ser instagram o facebook.' });
  }
  if (tipo_contenido !== undefined && tipo_contenido !== null && !TIPOS_CONTENIDO_VALIDOS.includes(tipo_contenido)) {
    return res.status(400).json({ error: 'tipo_contenido inválido.' });
  }
  if (hashtags !== undefined && hashtags !== null && !Array.isArray(hashtags)) {
    return res.status(400).json({ error: 'hashtags debe ser una lista de texto.' });
  }
  // "programado"/"rechazado" solo tienen sentido como transicion de un
  // pendiente ya existente (via /:id/aprobar, /:id/rechazar) — al crear solo
  // se permite el default "pendiente" (flujo manual) o "publicado" (caso de
  // /cm/publicar-contenido, que ya publico de verdad antes de guardar el registro).
  if (estado !== undefined && !['pendiente', 'publicado'].includes(estado)) {
    return res.status(400).json({ error: 'estado inválido: solo "pendiente" o "publicado" al crear.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO publicaciones
       (plataforma, tipo_contenido, hook, contenido_texto, cta, hashtags, imagen_url, producto_id, promocion_id, fecha_programada, creado_por, estado, url_publicacion, post_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, 'pendiente'), $13, $14)
     RETURNING id, plataforma, tipo_contenido, hook, contenido_texto, cta, hashtags, imagen_url, estado, url_publicacion, post_id,
               fecha_programada, producto_id, promocion_id, creado_por, created_at`,
    [
      plataforma,
      tipo_contenido || null,
      hook || null,
      contenido_texto || null,
      cta || null,
      hashtags || null,
      imagen_url || null,
      producto_id || null,
      promocion_id || null,
      fecha_programada || null,
      req.usuario.sub,
      estado || null,
      url_publicacion || null,
      post_id || null,
    ]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const actual = await pool.query(`SELECT id FROM publicaciones WHERE id = $1`, [req.params.id]);
  if (!actual.rows[0]) return res.status(404).json({ error: 'Publicación no encontrada.' });

  if (req.body?.plataforma !== undefined && !PLATAFORMAS_VALIDAS.includes(req.body.plataforma)) {
    return res.status(400).json({ error: 'plataforma debe ser instagram o facebook.' });
  }
  if (req.body?.tipo_contenido !== undefined && req.body.tipo_contenido !== null && !TIPOS_CONTENIDO_VALIDOS.includes(req.body.tipo_contenido)) {
    return res.status(400).json({ error: 'tipo_contenido inválido.' });
  }
  if (req.body?.hashtags !== undefined && req.body.hashtags !== null && !Array.isArray(req.body.hashtags)) {
    return res.status(400).json({ error: 'hashtags debe ser una lista de texto.' });
  }

  const fields = {
    plataforma: req.body?.plataforma,
    tipo_contenido: req.body?.tipo_contenido,
    hook: req.body?.hook,
    contenido_texto: req.body?.contenido_texto,
    cta: req.body?.cta,
    hashtags: req.body?.hashtags,
    imagen_url: req.body?.imagen_url,
    producto_id: req.body?.producto_id,
    promocion_id: req.body?.promocion_id,
    fecha_programada: req.body?.fecha_programada,
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
  if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE publicaciones SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, plataforma, tipo_contenido, hook, contenido_texto, cta, hashtags, imagen_url, estado,
               fecha_programada, producto_id, promocion_id, creado_por, created_at, updated_at`,
    values
  );
  res.json(rows[0]);
});

router.patch('/:id/aprobar', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE publicaciones SET estado = 'programado' WHERE id = $1 AND estado = 'pendiente'
     RETURNING id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede aprobar una publicación pendiente.' });
  res.json(rows[0]);
});

router.patch('/:id/rechazar', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE publicaciones SET estado = 'rechazado' WHERE id = $1 AND estado = 'pendiente'
     RETURNING id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede rechazar una publicación pendiente.' });
  res.json(rows[0]);
});

router.patch('/:id/publicar', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE publicaciones SET estado = 'publicado' WHERE id = $1 AND estado = 'programado'
     RETURNING id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Solo se puede publicar una publicación programada.' });
  res.json(rows[0]);
});

module.exports = router;
