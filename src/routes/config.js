'use strict';

const express = require('express');
const router  = express.Router();

/**
 * GET /api/config/public
 * Fournit les constantes publiques de l'app (sans auth).
 * Remplace les placeholders « +221 77 XXX XX XX » dans les pages statiques.
 */
router.get('/public', (req, res) => {
  res.json({
    wakanect_whatsapp_number: process.env.WAKANECT_WHATSAPP_NUMBER || '',
  });
});

module.exports = router;
