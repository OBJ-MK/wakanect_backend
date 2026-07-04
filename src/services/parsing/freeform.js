'use strict';

/**
 * WAKANECT — Pipeline d'extraction en forme libre
 *
 * Ordre d'extraction (chaque étape consomme sa portion du texte) :
 *   1. SKU [TOM001] et signe +/- (action stock)
 *   2. Prix (étiquette > devise > k/mille > "à N" final)
 *   3. Quantité (étiquette > dispo > x-notation > nombre+unité)
 *   4. Tailles (plages, listes de pointures, lettres)
 *   5. Couleurs (composées puis simples, garde anti-ambiguïté)
 *   6. Replis : prix nu (plus grand nombre ≥ 300), quantité nue finale
 *   7. Nom = résidu nettoyé du bruit vendeur
 */

const { prepare } = require('./normalize');
const { extractPrice, extractBarePrice } = require('./price');
const { extractQuantity, extractTrailingQuantity } = require('./quantity');
const { extractSizes, extractColors, AMBIGUOUS_COLORS } = require('./attributes');
const { RESIDUAL_NOISE, EDGE_STOPWORDS, SIMPLE_COLORS } = require('./lexicon');

function cleanName(residual) {
  // Bruit purgé partout ; lettres seules = restes d'élision ("L'ensemble" → "L")
  let tokens = residual
    .replace(/[-,|;:\/\\().!?*#+«»"']+/g, ' ')
    .split(/\s+/)
    .filter(tok => tok && !RESIDUAL_NOISE.has(tok.toLowerCase()) && !/^[ldjcnstqm]$/i.test(tok));

  // Mots-outils retirés uniquement en bordure ("de savon" → "savon",
  // mais "Sac à main" garde son "à")
  while (tokens.length && EDGE_STOPWORDS.has(tokens[0].toLowerCase())) tokens.shift();
  while (tokens.length && EDGE_STOPWORDS.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();

  const name = tokens.join(' ').trim();
  return name || null;
}

function extractFreeForm(rawText) {
  let w = prepare(rawText);
  let sku = null;
  let action = 'set_stock';

  // 1. SKU entre crochets : [TOM001]
  w = w.replace(/\[([A-Z0-9_-]+)\]/gi, (_, s) => { sku = s.toUpperCase(); return ' '; });

  // Signe +/- en tête (add/subtract stock)
  const signMatch = w.match(/^\s*([+-])/);
  if (signMatch) {
    action = signMatch[1] === '+' ? 'add_stock' : 'subtract_stock';
    w = w.slice(signMatch.index + 1);
  }

  // 2. Prix
  const p = extractPrice(w);
  let price = p.price;
  let priceUnit = p.unit;
  w = p.text;

  // 3. Quantité
  const q = extractQuantity(w);
  let quantity = q.quantity;
  let unit = q.unit || priceUnit || null;
  w = q.text;

  // 4. Tailles
  const s = extractSizes(w);
  const sizes = s.sizes;
  w = s.text;

  // 5. Couleurs — le premier mot du message est protégé s'il est une couleur :
  // "Orange 500f le tas" vend le fruit, pas la couleur (le vendeur met toujours
  // la couleur APRÈS le nom du produit).
  let protectedLead = null;
  const leadM = w.match(/^\s*([a-zà-ÿA-ZÀ-Ÿ]+)/);
  if (leadM && SIMPLE_COLORS.has(leadM[1].toLowerCase())) {
    protectedLead = leadM[1];
    w = w.replace(leadM[1], ' ');
  }

  const c = extractColors(w);
  let colors = c.colors;
  w = c.text;

  // 6a. Repli prix nu : "Robe wax 15000" (aucun marqueur de devise)
  if (price == null) {
    const bp = extractBarePrice(w);
    price = bp.price;
    w = bp.text;
  }

  // 6b. Repli quantité nue en fin : "Robe wax 15000 8"
  if (quantity == null && price != null) {
    const tq = extractTrailingQuantity(w.trimEnd());
    quantity = tq.quantity;
    w = tq.text;
  }

  // 7. Nom (le premier mot protégé reprend sa place en tête)
  let name = cleanName(w);
  if (protectedLead) {
    const lead = protectedLead.charAt(0).toUpperCase() + protectedLead.slice(1);
    name = name ? `${lead} ${name}` : lead;
  }

  // Garde anti-ambiguïté : "500f pomme orange" vidé → restitue la couleur au nom
  if (!name && c.removed.length > 0) {
    const amb = c.removed.find(r => AMBIGUOUS_COLORS.has(r.canonical)) || c.removed[0];
    name = amb.raw.charAt(0).toUpperCase() + amb.raw.slice(1);
    colors = colors.filter(col => col !== amb.canonical);
  }

  return {
    name,
    price,
    quantity,
    unit: unit || 'pièce',
    sizes,
    colors,
    sku,
    action,
    category: null,
  };
}

module.exports = { extractFreeForm };
