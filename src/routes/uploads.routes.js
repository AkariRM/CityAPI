const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor'));

const BUCKET = 'Imagenes';
const TIPOS_VALIDOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!TIPOS_VALIDOS[file.mimetype]) {
      return cb(Object.assign(new Error('Formato no soportado. Usa JPG, PNG o WEBP.'), { statusCode: 400 }));
    }
    cb(null, true);
  },
});

// El bucket es publico de LECTURA (fotos de catalogo, no hay nada sensible
// que proteger); lo que si esta cerrado es la escritura — solo este
// endpoint, autenticado y con la service_role key que vive nada mas aqui
// en el servidor, puede subir archivos. La app nunca ve esa llave.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

router.post('/imagen', (req, res) => {
  upload.single('imagen')(req, res, async (err) => {
    if (err) return res.status(err.statusCode ?? 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen.' });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
      return res.status(500).json({ error: 'La subida de imágenes no está configurada en el servidor.' });
    }

    const nombreArchivo = `${crypto.randomUUID()}.${TIPOS_VALIDOS[req.file.mimetype]}`;

    const { error } = await supabase.storage.from(BUCKET).upload(nombreArchivo, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });
    if (error) {
      console.error(error);
      return res.status(500).json({ error: 'No se pudo subir la imagen.' });
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(nombreArchivo);
    res.status(201).json({ url: data.publicUrl });
  });
});

module.exports = router;
