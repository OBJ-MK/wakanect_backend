'use strict';

/**
 * Seed de la collection PlanConfig avec les valeurs tarifaires verrouillées.
 * Usage : node scripts/seedPlanConfig.js
 *
 * Idempotent : utilise findOneAndUpdate + upsert. Peut être rejoué sans risque.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlanConfig = require('../src/models/PlanConfig');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connecté');

  const config = await PlanConfig.findOneAndUpdate(
    { key: 'main' },
    {
      $setOnInsert: {
        key: 'main',

        pro: {
          scansPerMonth: 3000,
          priceSN: 5000,
          priceML: 3600,
          pendingDecrease: null,
        },

        premium: {
          scansPerMonth: 15000,
          priceSN: 15000,
          priceML: 10800,
          pendingDecrease: null,
        },

        trial: {
          days: 14,
          scans: 100,
        },

        packs: [
          // Prix à définir avant de l'activer côté commerçant
          { code: 'extra1000', scans: 1000, priceSN: 0, priceML: 0 },
        ],

        // Remises par période (appliquées au prix mensuel de base)
        // monthly   = base × 1
        // quarterly = base × 3 × 0.9  → multiplicateur 2.7
        // semiannual= base × 5         → 6 mois, 1 offert
        // annual    = base × 10        → 12 mois, 2 offerts
        discounts: {
          monthlyMultiplier:    1,
          quarterlyMultiplier:  2.7,
          semiannualMultiplier: 5,
          annualMultiplier:     10,
        },
      },
    },
    { upsert: true, new: true }
  );

  console.log('PlanConfig seedé (id=%s)', config._id);
  console.log('  pro    : %d scans/mois | SN=%d FCFA/mois | ML=%d FCFA/mois', config.pro.scansPerMonth, config.pro.priceSN, config.pro.priceML);
  console.log('  premium: %d scans/mois | SN=%d FCFA/mois | ML=%d FCFA/mois', config.premium.scansPerMonth, config.premium.priceSN, config.premium.priceML);
  console.log('  trial  : %d jours / %d scans', config.trial.days, config.trial.scans);

  await mongoose.disconnect();
  console.log('Seed terminé.');
}

seed().catch((err) => {
  console.error('Erreur seed:', err.message);
  process.exit(1);
});
