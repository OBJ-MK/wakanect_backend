require('dotenv').config();
const mongoose = require('mongoose');
const { GRID } = require('../src/constants/pricingGrid');
const { getCountryTier } = require('../src/constants/countries');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  const col = mongoose.connection.collection('planconfigs');

  // Prend un pays représentatif de chaque tier pour extraire le prix mensuel du tier
  const tierPrice = { pro: {}, premium: {} };
  for (const [country, plans] of Object.entries(GRID)) {
    const tier = String(getCountryTier(country));
    if (plans.pro?.monthly)     tierPrice.pro[tier]     = plans.pro.monthly;
    if (plans.premium?.monthly) tierPrice.premium[tier] = plans.premium.monthly;
  }

  await col.updateOne({ key: 'main' }, {
    $set: {
      'pro.prices':     tierPrice.pro,
      'premium.prices': tierPrice.premium,
    },
  });

  console.log('✅ Migration vers tarification par palier terminée :', tierPrice);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });