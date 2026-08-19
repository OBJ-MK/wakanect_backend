'use strict';

/**
 * Répond avec une erreur 500 générique en production (le détail ne part
 * jamais au client), et avec err.message en dev/test pour debug rapide.
 * Le message complet est toujours loggé côté serveur via console.error.
 *
 * Usage : remplace `res.status(500).json({ error: err.message })`
 * par     `return sendServerError(res, err);`
 */
function sendServerError(res, err, publicMessage = 'Erreur serveur') {
  console.error(err);
  const isProd = process.env.NODE_ENV === 'production';
  return res.status(500).json({ error: isProd ? publicMessage : err.message });
}

module.exports = { sendServerError };