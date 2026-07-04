'use strict';

/**
 * WAKANECT — Normalisation du texte avant extraction
 */

const { LEAD_NOISE_RE } = require('./lexicon');

// Émojis et symboles décoratifs fréquents dans les annonces WhatsApp
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2764}]/gu;

/**
 * Nettoie un message brut : émojis, apostrophes typographiques, espaces
 * insécables, tournures d'annonce en tête ("je vends", "nouvel arrivage"...).
 */
function prepare(text) {
  let t = String(text || '')
    .replace(/[’‘]/g, "'")
    .replace(/[«»“”]/g, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/[  ]/g, ' ')   // espaces insécables → espace simple
    .replace(/\s+/g, ' ')
    .trim();

  // Retire les tournures d'annonce en tête (répétées : "Promo ! Nouvel arrivage...")
  let prev;
  do {
    prev = t;
    t = t.replace(LEAD_NOISE_RE, '');
  } while (t !== prev && t.length > 0);

  return t.trim();
}

/**
 * Convertit "25.000", "3 500", "25000", "12,500" en nombre.
 * En Afrique de l'Ouest, point/virgule/espace en position X.XXX = milliers.
 */
function parseWestAfricanPrice(raw) {
  const s = String(raw).trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10);
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return parseInt(s.replace(/,/g, ''), 10);
  const v = parseFloat(s.replace(',', '.'));
  return isNaN(v) ? null : v;
}

module.exports = { prepare, parseWestAfricanPrice };
