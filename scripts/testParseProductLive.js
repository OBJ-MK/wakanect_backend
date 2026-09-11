'use strict';

/**
 * WAKANECT — Test de bout en bout de parseProduct() sur la nouvelle cascade.
 * Vrais appels réseau (Cloudflare + DeepSeek) — coût de quelques centimes max.
 *
 * Usage : node scripts/testParseProductLive.js
 */

require('dotenv').config();
const { parseProduct } = require('../src/services/parserService');

const CORPUS = [
  "🔥🔥 PROMO ! Ensemble jogging gris et noir 12.500f taille L et XL 🔥 Livraison possible sur Dakar",
  "iPhone 13 128Go 350.000f propre, batterie 89%, vient avec chargeur et boîte d'origine",
  "Montre homme dorée résistante à l'eau 8000fr parfait cadeau",
];

async function main() {
  for (const text of CORPUS) {
    console.log('\n' + '─'.repeat(70));
    console.log(`"${text}"`);
    const result = await parseProduct(text);
    console.log(`tier=${result.parserTier} confidence=${result.confidence} needsReview=${result.needsReview}`);
    console.log(`name="${result.product?.name}" price=${result.product?.price} category=${result.product?.category}`);
    console.log(`décision nom: ${result._meta.nameDecisionPath || '-'} (${result._meta.nameDecisionReason || '-'})`);
  }
}

main().catch(err => console.error('Erreur fatale :', err.message));