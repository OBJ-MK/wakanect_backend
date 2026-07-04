'use strict';

/**
 * WAKANECT — Lexique du parser regex
 *
 * Tout le vocabulaire métier (couleurs, unités, devises, bruit vendeur)
 * est centralisé ici pour être enrichi sans toucher à la logique.
 */

// ─── Couleurs ──────────────────────────────────────────────────────────────────
// variante rencontrée → forme canonique stockée
// Les composés ("bleu ciel") DOIVENT être testés avant les simples ("bleu").
const COMPOUND_COLORS = new Map([
  ['bleu ciel', 'bleu ciel'],
  ['bleu marine', 'bleu marine'],
  ['bleu nuit', 'bleu nuit'],
  ['bleu roi', 'bleu roi'],
  ['bleu turquoise', 'turquoise'],
  ['vert bouteille', 'vert bouteille'],
  ['vert olive', 'kaki'],
  ['vert kaki', 'kaki'],
  ['gris clair', 'gris clair'],
  ['gris foncé', 'gris foncé'],
  ['gris fonce', 'gris foncé'],
  ['rose pâle', 'rose pâle'],
  ['rose pale', 'rose pâle'],
  ['rose poudré', 'rose poudré'],
  ['rose poudre', 'rose poudré'],
  ['rouge bordeaux', 'bordeaux'],
  ['jaune moutarde', 'moutarde'],
]);

const SIMPLE_COLORS = new Map([
  ['blanc', 'blanc'], ['blanche', 'blanc'], ['blancs', 'blanc'], ['blanches', 'blanc'],
  ['noir', 'noir'], ['noire', 'noir'], ['noirs', 'noir'], ['noires', 'noir'],
  ['rouge', 'rouge'], ['rouges', 'rouge'],
  ['bleu', 'bleu'], ['bleue', 'bleu'], ['bleus', 'bleu'], ['bleues', 'bleu'],
  ['vert', 'vert'], ['verte', 'vert'], ['verts', 'vert'], ['vertes', 'vert'],
  ['jaune', 'jaune'], ['jaunes', 'jaune'],
  ['marron', 'marron'], ['marrons', 'marron'],
  ['gris', 'gris'], ['grise', 'gris'], ['grises', 'gris'],
  ['rose', 'rose'], ['roses', 'rose'],
  ['orange', 'orange'], ['oranges', 'orange'],
  ['violet', 'violet'], ['violette', 'violet'], ['violets', 'violet'], ['violettes', 'violet'],
  ['beige', 'beige'], ['beiges', 'beige'],
  ['or', 'doré'], ['doré', 'doré'], ['dorée', 'doré'], ['dorés', 'doré'], ['dorées', 'doré'], ['dore', 'doré'], ['doree', 'doré'],
  ['argent', 'argenté'], ['argenté', 'argenté'], ['argentée', 'argenté'], ['argente', 'argenté'], ['argentee', 'argenté'],
  ['bordeaux', 'bordeaux'],
  ['kaki', 'kaki'],
  ['turquoise', 'turquoise'],
  ['mauve', 'mauve'],
  ['fuchsia', 'fuchsia'], ['fushia', 'fuchsia'],
  ['corail', 'corail'],
  ['saumon', 'saumon'],
  ['camel', 'camel'],
  ['ivoire', 'ivoire'],
  ['crème', 'crème'], ['creme', 'crème'],
  ['moutarde', 'moutarde'],
  ['multicolore', 'multicolore'], ['multicolores', 'multicolore'], ['multi couleurs', 'multicolore'],
]);

// Couleurs qui sont aussi des produits courants : si les retirer vide le nom,
// on les restitue au nom (ex. "Orange 500f" = le fruit, pas la couleur).
const AMBIGUOUS_COLORS = new Set(['orange', 'marron', 'rose', 'crème', 'saumon', 'corail', 'ivoire', 'or']);

// ─── Unités ────────────────────────────────────────────────────────────────────
const UNIT_MAP = {
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogramme: 'kg', kilogrammes: 'kg',
  g: 'g', gr: 'g', gramme: 'g', grammes: 'g',
  litre: 'litre', litres: 'litre', l: 'litre',
  ml: 'ml',
  sac: 'sac', sacs: 'sac',
  sachet: 'sachet', sachets: 'sachet',
  boite: 'boite', boites: 'boite', 'boîte': 'boite', 'boîtes': 'boite',
  carton: 'carton', cartons: 'carton',
  pack: 'pack', packs: 'pack',
  lot: 'lot', lots: 'lot',
  paire: 'paire', paires: 'paire',
  douzaine: 'douzaine', douzaines: 'douzaine',
  colis: 'colis',
  tas: 'tas',
  botte: 'botte', bottes: 'botte',
  pc: 'pièce', pcs: 'pièce', 'pièce': 'pièce', 'pièces': 'pièce',
  piece: 'pièce', pieces: 'pièce',
  'unité': 'pièce', 'unités': 'pièce', unite: 'pièce', unites: 'pièce',
};

// Pattern des unités pour les regex (le "l" isolé est protégé par lookaround)
const UNITS_PAT =
  'kg|kilos?|kilogrammes?|g(?:r)?|grammes?|litres?|(?<![a-zà-ÿ])l(?![a-zà-ÿ])|ml' +
  '|sacs?|sachets?|bo[iî]tes?|cartons?|packs?|lots?|paires?|douzaines?|colis|tas|bottes?' +
  '|pi[eè]ces?|pcs?|unit[eé]s?';

// Unités de mesure : "250g" collé au nombre = format d'emballage (reste dans le
// nom du produit) ; "250 g" avec espace = quantité en stock.
const MEASURE_UNITS = new Set(['kg', 'g', 'litre', 'ml']);

function normalizeUnit(raw) {
  if (!raw) return 'pièce';
  const s = String(raw).toLowerCase().trim();
  return UNIT_MAP[s] || UNIT_MAP[s.replace(/s$/, '')] || s;
}

// ─── Devises ───────────────────────────────────────────────────────────────────
// "25.000f", "25 000 FCFA", "3500 cfa", "8000fr", "12000 frs", "5000 francs"
const CURRENCY_PAT = '(?:FCFA|XOF|CFA|francs?|frs?|F(?![A-Za-zÀ-ÿ]))';

// ─── Bruit vendeur ─────────────────────────────────────────────────────────────
// Tournures d'annonce en tête de message, sans valeur produit.
const LEAD_NOISE_RE = /^(?:je\s+vends|[àa]\s+vendre|vente\s+de|vente\s+flash|nouvel(?:le)?s?\s+arrivages?(?:\s+de)?|arrivages?(?:\s+de)?|nouveaut[eé]s?|nouveau|promo(?:tion)?s?|dispo(?:nible)?s?|en\s+stock|urgent|bonjour|bonsoir|salut)\s*[:!,;-]*\s*/i;

// Mots à purger du nom PARTOUT une fois prix/quantité extraits
// (jamais porteurs de sens produit).
const RESIDUAL_NOISE = new Set([
  'prix', 'pu', 'cout', 'coût', 'tarif', 'fcfa', 'cfa', 'xof', 'franc', 'francs', 'fr', 'frs', 'f',
  'stock', 'dispo', 'disponible', 'disponibles', 'reste', 'restant', 'restants',
  'qte', 'qté', 'quantite', 'quantité', 'taille', 'tailles', 'pointure', 'pointures',
  'seulement', 'chacun', 'chacune', 'unité', 'unite',
]);

// Mots-outils supprimés uniquement en BORDURE du nom ("2 cartons de savon" →
// "savon", mais "Sac à main" garde son "à" intérieur).
const EDGE_STOPWORDS = new Set([
  'le', 'la', 'les', 'du', 'de', 'des', 'un', 'une', 'à', 'a', 'au', 'aux',
  'en', 'et', 'ou', 'pour', 'chez', 'avec',
]);

module.exports = {
  COMPOUND_COLORS,
  SIMPLE_COLORS,
  AMBIGUOUS_COLORS,
  UNIT_MAP,
  UNITS_PAT,
  MEASURE_UNITS,
  CURRENCY_PAT,
  LEAD_NOISE_RE,
  RESIDUAL_NOISE,
  EDGE_STOPWORDS,
  normalizeUnit,
};
