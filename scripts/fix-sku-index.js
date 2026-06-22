'use strict';

/**
 * Migration : remplace l'index sparse (merchantId, sku) par un index partiel
 * qui n'indexe que les SKU de type string — élimine le E11000 sur sku: null.
 *
 * Usage :
 *   node scripts/fix-sku-index.js
 *
 * Idempotent : si l'ancien index n'existe pas, continue sans erreur.
 * À exécuter UNE SEULE FOIS après déploiement de ce commit.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const OLD_INDEX = 'merchantId_1_sku_1';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  console.log('Connected to MongoDB');

  const col = mongoose.connection.collection('products');

  // 1. Supprimer l'ancien index sparse
  try {
    await col.dropIndex(OLD_INDEX);
    console.log(`Dropped index "${OLD_INDEX}"`);
  } catch (err) {
    if (err.codeName === 'IndexNotFound' || err.code === 27) {
      console.log(`Index "${OLD_INDEX}" not found — skipping drop`);
    } else {
      throw err;
    }
  }

  // 2. Recréer en index partiel : unique seulement quand sku est une string
  await col.createIndex(
    { merchantId: 1, sku: 1 },
    {
      unique: true,
      partialFilterExpression: { sku: { $type: 'string' } },
      name: OLD_INDEX,
    }
  );
  console.log(`Created partial unique index "${OLD_INDEX}"`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
