'use strict';

/**
 * WAKANECT — Test hors-ligne de la couche regex du parser
 *
 * Aucun appel réseau : on mesure quelle part du corpus la couche regex
 * résout seule (confidence >= 75 → pas d'appel IA).
 *
 *   node scripts/testParser.js          → rapport complet
 *   node scripts/testParser.js -v       → détail de chaque échec de champ
 */

const { extractWithRegex, splitIntoProductLines } = require('../src/services/parsing');
const { computeConfidence } = require('../src/services/parserService');

const REGEX_ACCEPT = 75;

// [message, attendu partiel] — seuls les champs listés sont vérifiés
const CORPUS = [
  // Formats historiques structurés
  ['[TOM001] Tomates : 50 kg | 25.000 FCFA', { name: 'Tomates', price: 25000, quantity: 50, unit: 'kg', sku: 'TOM001' }],
  ['+ Coca : 24 pièces', { name: 'Coca', quantity: 24, action: 'add_stock' }],
  ['Riz parfumé : 30 sacs | 22500', { name: 'Riz parfumé', price: 22500, quantity: 30, unit: 'sac' }],

  // Forme libre de référence
  ['Baskets Nike 40 41 42, blanc/noir, 25.000f, 8 pièces', { name: 'Baskets Nike', price: 25000, quantity: 8, sizes: ['40', '41', '42'], colors: ['blanc', 'noir'] }],

  // Prix sans devise (échec n°1 de l'ancienne version)
  ['Robe wax 15000', { name: 'Robe wax', price: 15000 }],
  ['Robe wax 15000 8', { name: 'Robe wax', price: 15000, quantity: 8 }],
  ['Sac à main cuir 12500 reste 3', { name: 'Sac à main cuir', price: 12500, quantity: 3 }],

  // Prix étiquetés / notations
  ['Chemise homme taille M et L, bleu ciel, prix : 7500', { name: 'Chemise homme', price: 7500, sizes: ['M', 'L'], colors: ['bleu ciel'] }],
  ['25k le sac de riz 50kg, 10 sacs dispo', { price: 25000, quantity: 10, unit: 'sac' }],
  ['Montre homme dorée 8000fr', { name: 'Montre homme', price: 8000, colors: ['doré'] }],
  ['Voile suisse 3 500 CFA', { name: 'Voile suisse', price: 3500 }],
  ['Savon 250g à 500', { name: 'Savon 250g', price: 500 }],
  ['2 cartons de savon à 15000', { name: 'savon', price: 15000, quantity: 2, unit: 'carton' }],
  ['Tissu bazin 5 mètres 45000', { price: 45000 }],
  ['Parfum Dubai 10.000 F CFA', { name: 'Parfum Dubai', price: 10000 }],

  // Quantités étiquetées / x-notation
  ['Sandales dame du 37 au 41, 9500f la paire, x12', { price: 9500, quantity: 12, unit: 'paire', sizes: ['37', '38', '39', '40', '41'] }],
  ['Pagne tissé stock: 15, 6000 F', { name: 'Pagne tissé', price: 6000, quantity: 15 }],
  ['Lait en poudre 20 boites dispo 3500f la boite', { price: 3500, quantity: 20, unit: 'boite' }],

  // Bruit vendeur / émojis
  ['Nouvel arrivage de chaussures dames du 37 au 41, 9500f', { name: 'chaussures dames', price: 9500, sizes: ['37', '38', '39', '40', '41'] }],
  ['🔥🔥 PROMO ! Ensemble jogging gris et noir 12.500f taille L et XL 🔥', { price: 12500, colors: ['gris', 'noir'], sizes: ['L', 'XL'] }],
  ['Boubou grande taille 2XL 3XL 4XL 5XL 18000f', { price: 18000, sizes: ['2XL', '3XL', '4XL', '5XL'] }],
  ['Tee-shirt XXL et xxxl 4500f', { price: 4500, sizes: ['XXL', 'XXXL'] }],
  ['Je vends des mèches brésiliennes 18000f x5', { name: 'mèches brésiliennes', price: 18000, quantity: 5 }],

  // Ambiguïtés à ne PAS casser
  ['Orange 500f le tas 20', { name: 'Orange', price: 500, quantity: 20 }],
  ["L'ensemble complet dame 22000f", { name: "ensemble complet dame", price: 22000 }],
  ['iPhone 13 128Go 350.000f propre', { price: 350000 }],
  ['TV Samsung 43 pouces 185000f', { price: 185000 }],

  // Multi-lignes
  ['STOCK\nRiz : 50 sacs | 25000\nHuile : 20 litres | 18000', '__SPLIT_3__'],
  ['Basin riche 45000f\nVoile suisse 30000f\nGetzner 55000f', '__SPLIT_3__'],
];

const verbose = process.argv.includes('-v');
let pass = 0, fail = 0, accepted = 0;
const failures = [];

for (const [msg, expected] of CORPUS) {
  // Cas découpe multi-lignes
  if (typeof expected === 'string' && expected.startsWith('__SPLIT_')) {
    const want = parseInt(expected.match(/\d+/)[0], 10);
    const got = splitIntoProductLines(msg).length;
    // Le header STOCK ne compte pas comme ligne produit
    const effective = /^stock/i.test(msg) ? got : got;
    if (effective === want || (/^stock/i.test(msg) && got === want - 1)) { pass++; }
    else { fail++; failures.push({ msg, detail: `split attendu=${want} obtenu=${got}` }); }
    continue;
  }

  const p = extractWithRegex(msg);
  const conf = computeConfidence(p);
  if (conf >= REGEX_ACCEPT) accepted++;

  const errors = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = p[key];
    const okField = Array.isArray(want)
      ? JSON.stringify([...(got || [])].sort()) === JSON.stringify([...want].sort())
      : got === want;
    if (!okField) errors.push(`${key}: attendu=${JSON.stringify(want)} obtenu=${JSON.stringify(got)}`);
  }

  if (errors.length === 0) { pass++; }
  else { fail++; failures.push({ msg, detail: errors.join(' ; '), conf, product: p }); }
}

const total = CORPUS.length;
const parsed = CORPUS.filter(([, e]) => typeof e !== 'string').length;
console.log('─'.repeat(70));
console.log(`Corpus : ${total} messages | ✅ ${pass} | ❌ ${fail}`);
console.log(`Acceptés par la regex (conf ≥ ${REGEX_ACCEPT}, aucun appel IA) : ${accepted}/${parsed} (${Math.round(accepted / parsed * 100)} %)`);
console.log('─'.repeat(70));

if (failures.length > 0) {
  console.log('\nÉCHECS :');
  for (const f of failures) {
    console.log(`\n  ✗ "${f.msg}"`);
    console.log(`    ${f.detail}`);
    if (verbose && f.product) console.log(`    produit=${JSON.stringify(f.product)}`);
  }
  process.exit(1);
}
console.log('Tous les cas passent.');
