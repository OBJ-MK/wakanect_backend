'use strict';

/**
 * WAKANECT — Extraction tailles & couleurs
 */

const { COMPOUND_COLORS, SIMPLE_COLORS, AMBIGUOUS_COLORS } = require('./lexicon');

// Pointure chaussure plausible : 28–50
const SHOE_MIN = 28;
const SHOE_MAX = 50;

function isShoeSize(n) {
  return n >= SHOE_MIN && n <= SHOE_MAX;
}

/**
 * Tailles :
 *  - plage : "du 38 au 44", "38-44", "pointure 37 à 41" → toutes les pointures
 *  - liste : "40 41 42", "40/41/42", "40, 41, 42" (≥ 2 valeurs en 28-50)
 *  - étiquetée : "taille 40", "pointure 42", "T. 38"
 *  - lettres : XS S M L XL XXL ("taille M et L", "M/L/XL")
 */
function extractSizes(text) {
  let w = text;
  const sizes = [];

  // Plage étiquetée ou avec "au/à/-" : "du 38 au 44", "pointure 37 à 41", "38-44"
  const rangeRE = /\b(?:du\s+|pointures?\s*:?\s*|tailles?\s*:?\s*)?(\d{2})\s*(?:au|à|a|-|–)\s*(\d{2})\b/i;
  const rangeM = w.match(rangeRE);
  if (rangeM) {
    const lo = parseInt(rangeM[1], 10);
    const hi = parseInt(rangeM[2], 10);
    const labeled = /du|pointure|taille/i.test(rangeM[0]);
    // Sans étiquette on n'accepte que des plages courtes de pointures plausibles
    if (isShoeSize(lo) && isShoeSize(hi) && lo < hi && (labeled || hi - lo <= 12)) {
      for (let s = lo; s <= hi; s++) sizes.push(String(s));
      w = w.slice(0, rangeM.index) + ' ' + w.slice(rangeM.index + rangeM[0].length);
    }
  }

  // Liste de pointures : ≥ 2 nombres consécutifs en 28-50 séparés par espace , / -
  w = w.replace(/\b(?:(?:2[89]|[34]\d|50)(?:\s*[,\/]\s*|\s+))+(?:2[89]|[34]\d|50)\b/g, (match) => {
    const found = match.match(/\b(?:2[89]|[34]\d|50)\b/g) || [];
    if (found.length >= 2) { sizes.push(...found); return ' '; }
    return match;
  });

  // Taille/pointure unique étiquetée : "taille 40", "pointure 42", "T38", "T. 38"
  w = w.replace(/\b(?:tailles?|pointures?|t\.?)\s*:?\s*(\d{2})\b/gi, (match, n) => {
    if (isShoeSize(parseInt(n, 10))) { sizes.push(n); return ' '; }
    return match;
  });

  // Tailles lettres multi-caractères (insensible à la casse) : XS, XL, XXL, XXXL, 2XL, 3XL
  w = w.replace(/(?<![A-Za-z])(XXXL|XXL|XL|XS|[23]XL)(?![A-Za-z'])/gi, (m) => {
    sizes.push(m.toUpperCase());
    return ' ';
  });

  // Tailles S/M/L : UNIQUEMENT en majuscule (évite "l'ensemble", "m2", "s'il"...)
  w = w.replace(/(?<![A-Za-zÀ-ÿ'])([SML])(?![A-Za-zÀ-ÿ'’])/g, (m) => {
    sizes.push(m);
    return ' ';
  });

  return { sizes: [...new Set(sizes)], text: w };
}

/**
 * Couleurs : composés d'abord ("bleu ciel"), puis simples, avec les listes
 * "blanc/noir", "rouge, bleu et vert".
 * Retourne aussi `removed` (texte original de chaque couleur retirée) pour
 * permettre au pipeline de restituer une couleur ambiguë si le nom se vide.
 */
function extractColors(text) {
  let w = text;
  const colors = [];
  const removed = [];

  const pushColor = (canonical, raw) => {
    if (!colors.includes(canonical)) {
      colors.push(canonical);
      removed.push({ canonical, raw });
    }
  };

  // ⚠ \b ne fonctionne pas avec les accents ("dorée" matcherait "doré" + "e") :
  // on utilise des lookarounds explicites, et les variantes longues d'abord.
  const colorRE = (variant) => new RegExp(`(?<![a-zà-ÿ])${variant}(?![a-zà-ÿ])`, 'gi');

  // Composés d'abord (sinon "bleu ciel" perdrait "ciel")
  const compounds = [...COMPOUND_COLORS.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [variant, canonical] of compounds) {
    const re = colorRE(variant);
    if (re.test(w)) {
      pushColor(canonical, variant);
      w = w.replace(re, ' ');
    }
  }

  // Couleurs simples (gère aussi les listes "blanc/noir" car "/" est une frontière)
  const simples = [...SIMPLE_COLORS.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [variant, canonical] of simples) {
    const re = colorRE(variant);
    if (re.test(w)) {
      pushColor(canonical, variant);
      w = w.replace(re, ' ');
    }
  }

  return { colors, removed, text: w };
}

module.exports = { extractSizes, extractColors, AMBIGUOUS_COLORS };
