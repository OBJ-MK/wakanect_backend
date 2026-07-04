'use strict';

/**
 * WAKANECT — Extraction de la quantité en stock
 *
 * Stratégies, de la plus sûre à la moins sûre :
 *   1. Étiquetée      : "stock : 8", "qté 8", "reste 3", "il en reste 3"
 *   2. Suffixe dispo  : "8 dispo", "10 disponibles", "5 en stock", "10 sacs dispo"
 *   3. Notation x     : "x12", "12x" (⚠ pas les dimensions "40x60")
 *   4. Nombre + unité : "8 pièces", "50 kg", "3 cartons"
 *   5. Nombre nu final: "... 8" (uniquement si un prix a été trouvé)
 */

const { UNITS_PAT, MEASURE_UNITS, normalizeUnit } = require('./lexicon');

const MAX_PLAUSIBLE_QTY = 100_000;

function ok(q) {
  return q != null && q > 0 && q <= MAX_PLAUSIBLE_QTY;
}

function consume(text, index, length) {
  return text.slice(0, index) + ' ' + text.slice(index + length);
}

function extractQuantity(text) {
  let w = text;

  // 1. Étiquette : "stock: 8", "qté : 12", "quantité 5", "reste 3", "il (en) reste 3"
  const labeled = w.match(new RegExp(
    `\\b(?:stock|qt[eé]|quantit[eé]|(?:il\\s+(?:en\\s+)?)?reste(?:nt)?)\\s*[:=]?\\s*(\\d{1,6})\\s*(${UNITS_PAT})?\\b`, 'i'
  ));
  if (labeled) {
    const q = parseInt(labeled[1], 10);
    if (ok(q)) {
      return {
        quantity: q,
        unit: labeled[2] ? normalizeUnit(labeled[2]) : null,
        text: consume(w, labeled.index, labeled[0].length),
      };
    }
  }

  // 2. Suffixe disponibilité : "10 dispo", "8 disponibles", "5 en stock", "10 sacs dispo"
  const avail = w.match(new RegExp(
    `\\b(\\d{1,6})\\s*(${UNITS_PAT})?\\s*(?:dispo(?:nibles?)?|en\\s+stock|restants?)\\b`, 'i'
  ));
  if (avail) {
    const q = parseInt(avail[1], 10);
    if (ok(q)) {
      return {
        quantity: q,
        unit: avail[2] ? normalizeUnit(avail[2]) : null,
        text: consume(w, avail.index, avail[0].length),
      };
    }
  }

  // 3. Notation x : "x12", "x 12", "12x" — mais pas "40x60" (dimensions)
  const xPre = w.match(/(?<![A-Za-z0-9])x\s*(\d{1,5})(?![A-Za-z0-9])/i);
  if (xPre) {
    const q = parseInt(xPre[1], 10);
    if (ok(q)) return { quantity: q, unit: null, text: consume(w, xPre.index, xPre[0].length) };
  }
  const xPost = w.match(/(?<![A-Za-z0-9])(\d{1,5})\s*x(?!\s*\d)(?![A-Za-zà-ÿ])/i);
  if (xPost) {
    const q = parseInt(xPost[1], 10);
    if (ok(q)) return { quantity: q, unit: null, text: consume(w, xPost.index, xPost[0].length) };
  }

  // 4. Nombre + unité : "8 pièces", "50 kg", "3 cartons"
  //    ⚠ Unité de MESURE collée au nombre ("250g", "50kg") = format d'emballage
  //    qui décrit le produit → on la laisse dans le nom.
  const unitRE = new RegExp(`(?<![A-Za-z0-9])(\\d{1,6}(?:[.,]\\d+)?)(\\s*)(${UNITS_PAT})(?![a-zà-ÿ])`, 'gi');
  let unitM;
  while ((unitM = unitRE.exec(w)) !== null) {
    const hasSpace = unitM[2].length > 0;
    const u = normalizeUnit(unitM[3]);
    if (!hasSpace && MEASURE_UNITS.has(u)) continue; // "250g" → emballage
    const q = parseFloat(unitM[1].replace(',', '.'));
    if (ok(q)) {
      return { quantity: q, unit: u, text: consume(w, unitM.index, unitM[0].length) };
    }
  }

  return { quantity: null, unit: null, text: w };
}

/**
 * Repli : nombre nu en toute fin de message ("Robe wax 15000 8" → qty 8).
 * À n'appeler que si un prix a déjà été trouvé.
 */
function extractTrailingQuantity(text) {
  const m = text.match(/(?<![A-Za-z0-9.,])(\d{1,4})\s*$/);
  if (!m) return { quantity: null, text };
  const q = parseInt(m[1], 10);
  if (!ok(q)) return { quantity: null, text };
  return { quantity: q, text: text.slice(0, m.index) };
}

module.exports = { extractQuantity, extractTrailingQuantity };
