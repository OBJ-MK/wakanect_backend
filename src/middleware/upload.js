'use strict';

const multer = require('multer');

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const _multer = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('Type non supporté. Formats acceptés : JPEG, PNG, WebP');
      err.status = 400;
      cb(err);
    }
  },
});

/**
 * Middleware Express autour de multer.single(field).
 * Traduit les erreurs multer (taille dépassée, MIME rejeté) en 400
 * plutôt que de les laisser remonter en 500.
 */
function handleUpload(field) {
  return (req, res, next) => {
    _multer.single(field)(req, res, (err) => {
      if (!err) return next();
      const isMulterError = err instanceof multer.MulterError;
      const status = isMulterError || err.status === 400 ? 400 : 500;
      const message = isMulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'Fichier trop volumineux (max 5 Mo)'
        : err.message;
      return res.status(status).json({ error: message });
    });
  };
}

module.exports = { handleUpload };
