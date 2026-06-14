/**
 * WAKANECT — Backfill sha256 + pHash pour images existantes
 *
 * Usage :
 *   node scripts/backfillImageHashes.js
 *
 * Télécharge chaque image depuis son URL R2 publique, calcule les empreintes
 * et met à jour le document. Idempotent : saute les images déjà hashées.
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const axios    = require('axios');
const crypto   = require('crypto');

const { computePHash } = require('../src/services/mediaService');
const ParsedMessage    = require('../src/models/ParsedMessage');
const Product          = require('../src/models/Product');

// ─── Téléchargement + calcul d'empreintes ─────────────────────────────────────

async function hashesFromUrl(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
  const buf  = Buffer.from(resp.data);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const phash  = await computePHash(buf);
  return { sha256, phash };
}

// ─── Backfill d'une collection ─────────────────────────────────────────────────

async function backfillCollection(Model, label) {
  // Docs qui ont au moins une image sans sha256 ou phash
  const docs = await Model.find({
    'images.0': { $exists: true },
    $or: [
      { 'images.sha256': { $exists: false } },
      { 'images.sha256': null },
      { 'images.phash':  { $exists: false } },
      { 'images.phash':  null },
    ],
  }).select('_id images');

  console.log(`[backfill:${label}] ${docs.length} documents à traiter`);

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const doc of docs) {
    let changed = false;

    for (const img of doc.images) {
      if (img.sha256 && img.phash) { skipped++; continue; }

      try {
        const { sha256, phash } = await hashesFromUrl(img.url);
        img.sha256 = sha256;
        img.phash  = phash;
        changed = true;
      } catch (err) {
        console.error(`\n[backfill:${label}] doc=${doc._id} img=${img._id}: ${err.message}`);
        errors++;
      }
    }

    if (changed) {
      await doc.save();
      updated++;
      process.stdout.write('.');
    }
  }

  console.log(`\n[backfill:${label}] terminé — mis à jour: ${updated}, déjà hashées: ${skipped}, erreurs: ${errors}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  console.log('Connecté à MongoDB\n');

  await backfillCollection(ParsedMessage, 'ParsedMessage');
  await backfillCollection(Product,       'Product');

  console.log('\nBackfill terminé.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Backfill échoué :', err.message);
  process.exit(1);
});
