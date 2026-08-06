require('dotenv').config();
const mongoose = require('mongoose');
const { GRID } = require('../src/constants/pricingGrid');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  const col = mongoose.connection.collection('planconfigs');

  const doc = await col.findOne({ key: 'main' });
  if (!doc) {
    console.log('Aucune PlanConfig trouvée — rien à migrer.');
    return process.exit(0);
  }

  // Construit les prices Map pour pro/premium depuis TOUS les pays de pricingGrid.js
  const proPrices = {};
  const premiumPrices = {};
  for (const [country, plans] of Object.entries(GRID)) {
    if (plans.pro?.monthly)     proPrices[country]     = plans.pro.monthly;
    if (plans.premium?.monthly) premiumPrices[country] = plans.premium.monthly;
  }

  // Ne perd pas les prix éventuellement déjà personnalisés en base (ex. via l'admin)
  const existingPro     = doc.pro?.prices     || {};
  const existingPremium = doc.premium?.prices || {};

  const update = {
    $set: {
      'pro.prices':     { ...proPrices, ...existingPro },
      'premium.prices': { ...premiumPrices, ...existingPremium },
    },
    $unset: {
      'pro.priceSN': '', 'pro.priceML': '',
      'premium.priceSN': '', 'premium.priceML': '',
    },
  };

  await col.updateOne({ key: 'main' }, update);
  console.log(`✅ Migration terminée — ${Object.keys(proPrices).length} pays peuplés pour pro/premium.`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });