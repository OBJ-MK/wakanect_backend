'use strict';

/**
 * WAKANECT — Extraction du prix
 *
 * Stratégies, de la plus sûre à la moins sûre :
 *   1. Prix étiqueté        : "prix : 25000", "PU 500", "à 15.000"
 *   2. Prix avec devise     : "25.000f", "25 000 FCFA", "8000fr", "3500 cfa"
 *   3. Notation k / mille   : "25k", "1,5k", "25 mille"
 *   (le repli "nombre nu" est géré en fin de pipeline dans freeform.js,
 *    une fois quantité et tailles retirées)
 *
 * Chaque extracteur retourne { price, unit, text } — text étant le message
 * avec la portion consommée remplacée par un espace.
 */

const { CURRENCY_PAT, UNITS_PAT } = require('./lexicon');
const { parseWestAfricanPrice } = require('./normalize');
const { normalizeUnit } = require('./lexicon');

const MAX_PLAUSIBLE_PRICE = 100_000_000; // 100M FCFA

// Nombre bien formé : groupes de milliers ("25.000", "3 500", "1,200,000")
// OU entier/décimal simple ("7500", "12,5") — jamais un mélange, sinon
// "41, 9500f" serait lu 41.95.
const NUM_PAT = '(?:\\d{1,3}(?:[.,\\s]\\d{3})+|\\d+(?:[.,]\\d{1,2})?)';

function plausible(p) {
  return p != null && p > 0 && p <= MAX_PLAUSIBLE_PRICE;
}

/** "500f/kg", "500 f le kg", "25000 par sac" → unité de vente */
function extractPriceUnit(text, priceEndIndex) {
  const after = text.slice(priceEndIndex);
  const m = after.match(new RegExp(`^\\s*(?:\\/|le\\s+|la\\s+|par\\s+)(${UNITS_PAT})\\b`, 'i'));
  if (!m) return { unit: null, text };
  const cleaned = text.slice(0, priceEndIndex) + ' ' + after.slice(m[0].length);
  return { unit: normalizeUnit(m[1]), text: cleaned };
}

function extractPrice(text) {
  let w = text;

  // 1. Étiquette explicite : "prix : 25000", "prix 25.000f", "pu: 500"
  const labeled = w.match(new RegExp(
    `\\b(?:prix|pu|p\\.u\\.?|co[uû]t|tarif)\\s*[:=]?\\s*(${NUM_PAT})\\s*(?:${CURRENCY_PAT})?`, 'i'
  ));
  if (labeled) {
    const price = parseWestAfricanPrice(labeled[1]);
    if (plausible(price)) {
      const end = labeled.index + labeled[0].length;
      w = w.slice(0, labeled.index) + ' ' + w.slice(end);
      const u = extractPriceUnit(w, labeled.index + 1);
      return { price, unit: u.unit, text: u.text };
    }
  }

  // 2. Devise explicite : "25.000f", "25 000 FCFA", "8000fr" — on prend la 1re occurrence
  const cur = w.match(new RegExp(`(?<![A-Za-z0-9.,])(${NUM_PAT})\\s*${CURRENCY_PAT}`, 'i'));
  if (cur) {
    const price = parseWestAfricanPrice(cur[1]);
    if (plausible(price)) {
      const end = cur.index + cur[0].length;
      w = w.slice(0, cur.index) + ' ' + w.slice(end);
      const u = extractPriceUnit(w, cur.index + 1);
      return { price, unit: u.unit, text: u.text };
    }
  }

  // 3. Notation k / mille : "25k", "1,5k", "25 mille" (⚠ pas "5kg")
  const kM = w.match(/(?<![A-Za-z0-9])(\d+(?:[.,]\d+)?)\s*(?:k(?![a-zà-ÿ0-9])|milles?\b|mil\b)/i);
  if (kM) {
    const base = parseFloat(kM[1].replace(',', '.'));
    const price = Math.round(base * 1000);
    if (plausible(price)) {
      const end = kM.index + kM[0].length;
      w = w.slice(0, kM.index) + ' ' + w.slice(end);
      const u = extractPriceUnit(w, kM.index + 1);
      return { price, unit: u.unit, text: u.text };
    }
  }

  // 4. "à 15000" en fin de message (sans devise) : "2 cartons de savon à 15000"
  const aM = w.match(new RegExp(`\\b[àa]\\s+(${NUM_PAT})\\s*$`, 'i'));
  if (aM) {
    const price = parseWestAfricanPrice(aM[1]);
    if (plausible(price) && price >= 100) {
      w = w.slice(0, aM.index) + ' ';
      return { price, unit: null, text: w };
    }
  }

  return { price: null, unit: null, text: w };
}

/**
 * Repli final : nombres nus restants une fois tout le reste extrait.
 * Le plus grand nombre ≥ 300 devient le prix (les prix FCFA sont rarement < 300 ;
 * les pointures/tailles ont déjà été retirées à ce stade).
 */
function extractBarePrice(text) {
  const nums = [];
  const re = /(?<![A-Za-z0-9.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![A-Za-z0-9])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseWestAfricanPrice(m[1]);
    if (v != null) nums.push({ value: v, index: m.index, raw: m[1] });
  }
  const candidates = nums.filter(n => n.value >= 300 && plausible(n.value));
  if (candidates.length === 0) return { price: null, text };

  const best = candidates.reduce((a, b) => (b.value > a.value ? b : a));
  const cleaned = text.slice(0, best.index) + ' ' + text.slice(best.index + best.raw.length);
  return { price: best.value, text: cleaned };
}

module.exports = { extractPrice, extractBarePrice, plausible };
