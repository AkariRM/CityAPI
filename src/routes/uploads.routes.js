const express = require('express');
const multer = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const { subirBufferABucket, EXTENSIONES } = require('../utils/almacenamiento');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'vendedor', 'pto'));

// El bucket es publico de LECTURA (fotos de catalogo, no hay nada sensible
// que proteger); lo que si esta cerrado es la escritura — solo este
// endpoint, autenticado y con la service_role key que vive nada mas aqui
// en el servidor, puede subir archivos. La app nunca ve esa llave.
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

router.post('/imagen', (req, res) => {
  upload.single('imagen')(req, res, async (err) => {
    if (err) return res.status(err.statusCode ?? 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen.' });

    try {
      const { url } = await subirBufferABucket(req.file.buffer, req.file.mimetype);
      res.status(201).json({ url });
    } catch (subidaErr) {
      res.status(subidaErr.statusCode ?? 500).json({ error: subidaErr.message });
    }
  });
});

module.exports = router;
