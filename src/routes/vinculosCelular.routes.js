const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { subirBufferABucket, EXTENSIONES, detectarTipoReal } = require('../utils/almacenamiento');

const router = express.Router();

const DURACION_MIN_MINUTOS = 5;
const DURACION_MAX_MINUTOS = 480; // 8 horas — cubre un turno completo sin dejar vinculos activos de un dia para otro

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXTENSIONES[file.mimetype]) {
      return cb(Object.assign(new Error('Formato no soportado. Usa JPG, PNG o WEBP.'), { statusCode: 400 }));
    }
    cb(null, true);
  },
});

// --- Lado de escritorio: siempre el usuario logueado (requireAuth). ---

router.post('/', requireAuth, async (req, res) => {
  const minutos = Number(req.body?.duracion_minutos);
  if (!Number.isFinite(minutos) || minutos < DURACION_MIN_MINUTOS || minutos > DURACION_MAX_MINUTOS) {
    return res.status(400).json({ error: `duracion_minutos debe ser entre ${DURACION_MIN_MINUTOS} y ${DURACION_MAX_MINUTOS}.` });
  }
  // Un solo vinculo activo por usuario a la vez — generar uno nuevo revoca cualquier anterior.
  await pool.query(`UPDATE vinculos_celular SET revocado = true WHERE usuario_id = $1 AND revocado = false`, [req.usuario.sub]);
  const { rows } = await pool.query(
    `INSERT INTO vinculos_celular (usuario_id, expira_at) VALUES ($1, now() + make_interval(mins => $2::int))
     RETURNING id, expira_at`,
    [req.usuario.sub, minutos]
  );
  res.status(201).json(rows[0]);
});

router.get('/activo', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, expira_at FROM vinculos_celular
     WHERE usuario_id = $1 AND revocado = false AND expira_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [req.usuario.sub]
  );
  res.json(rows[0] ?? null);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE vinculos_celular SET revocado = true WHERE id = $1 AND usuario_id = $2 RETURNING id`,
    [req.params.id, req.usuario.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Vínculo no encontrado.' });
  res.json({ ok: true });
});

// El escritorio reclama la siguiente foto pendiente de su propio vinculo,
// de forma atomica (UPDATE...WHERE id = (SELECT...)) para que dos campos de
// imagen esperando a la vez no se roben la misma foto entre si.
router.get('/:id/fotos/siguiente', requireAuth, async (req, res) => {
  const propio = await pool.query(`SELECT id FROM vinculos_celular WHERE id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.sub]);
  if (!propio.rows[0]) return res.status(404).json({ error: 'Vínculo no encontrado.' });

  const { rows } = await pool.query(
    `UPDATE vinculo_fotos SET usada = true
     WHERE id = (SELECT id FROM vinculo_fotos WHERE vinculo_id = $1 AND usada = false ORDER BY created_at ASC LIMIT 1)
     RETURNING imagen_url`,
    [req.params.id]
  );
  res.json({ imagen_url: rows[0]?.imagen_url ?? null });
});

// --- Lado del celular: sin sesion de usuario — el id del vinculo (uuid
// dificil de adivinar, con vencimiento corto) es la unica credencial. ---

router.get('/:id/estado', async (req, res) => {
  const { rows } = await pool.query(`SELECT expira_at, revocado FROM vinculos_celular WHERE id = $1`, [req.params.id]);
  const vinculo = rows[0];
  const valido = !!vinculo && !vinculo.revocado && new Date(vinculo.expira_at) > new Date();
  res.json({ valido, expira_at: vinculo?.expira_at ?? null });
});

router.post('/:id/fotos', (req, res) => {
  upload.single('imagen')(req, res, async (err) => {
    if (err) return res.status(err.statusCode ?? 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen.' });

    const { rows } = await pool.query(`SELECT expira_at, revocado FROM vinculos_celular WHERE id = $1`, [req.params.id]);
    const vinculo = rows[0];
    if (!vinculo || vinculo.revocado || new Date(vinculo.expira_at) <= new Date()) {
      return res.status(410).json({ error: 'Este vínculo ya no está activo.' });
    }

    // El Content-Type que manda el navegador se puede falsificar — aqui
    // importa mas que en /uploads/imagen porque este endpoint no pide
    // sesion, cualquiera con el vinculo puede llamarlo. Se revisa el
    // contenido real del archivo y se usa ese tipo verificado al subirlo.
    const tipoReal = detectarTipoReal(req.file.buffer);
    if (!tipoReal) return res.status(400).json({ error: 'El archivo no es una imagen válida (JPG, PNG o WEBP).' });

    try {
      const { url } = await subirBufferABucket(req.file.buffer, tipoReal);
      await pool.query(`INSERT INTO vinculo_fotos (vinculo_id, imagen_url) VALUES ($1, $2)`, [req.params.id, url]);
      res.status(201).json({ ok: true });
    } catch (subidaErr) {
      res.status(subidaErr.statusCode ?? 500).json({ error: subidaErr.message });
    }
  });
});

module.exports = router;
