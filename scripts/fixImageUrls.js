'use strict';

/**
 * fixImageUrls.js — Migration one-shot (prod Atlas)
 *
 * Contexte : à une époque où R2_PUBLIC_URL_BASE était mal configuré ('https://r2.dev'
 * au lieu du domaine complet), des images ont été écrites en base avec un url incorrect.
 * Ce script corrige ces urls en reconstituant l'URL depuis r2Key + la bonne base CDN.
 *
 * Comportement :
 *   - images avec url = 'https://r2.dev/...' ET r2Key valide → recalcule url ✓
 *   - images avec url = 'https://r2.dev/...' SANS r2Key → extrait la clé du vieux url,
 *     reconstruit r2Key + url (cas théoriquement absent côté Mongoose mais géré)
 *   - images avec url correct → intouchées
 *
 * Usage (DRY RUN — ne modifie rien) :
 *   node scripts/fixImageUrls.js
 *
 * Usage (ÉCRITURE RÉELLE) :
 *   DRY_RUN=false node scripts/fixImageUrls.js
 *
 * Vérifier CORRECT_BASE avant d'exécuter. Doit être R2_PUBLIC_URL_BASE de prod.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Product  = require('../src/models/Product');

const BAD_PREFIX   = 'https://r2.dev/';
const CORRECT_BASE = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');
const DRY_RUN      = process.env.DRY_RUN !== 'false';

if (!CORRECT_BASE) {
  console.error('❌  R2_PUBLIC_URL_BASE non défini dans .env — arrêt.');
  process.exit(1);
}

if (DRY_RUN) {
  console.log('🟡  DRY RUN — aucune écriture. Passe DRY_RUN=false pour appliquer.\n');
} else {
  console.log('🔴  ÉCRITURE RÉELLE activée.\n');
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connecté à MongoDB.\n');

  const products = await Product.find({
    images: { $elemMatch: { url: { $regex: '^https://r2\\.dev/' } } },
  }).lean();

  console.log(`Produits avec images suspectes : ${products.length}\n`);

  let totalFixed = 0;
  let totalNoKey = 0;

  for (const p of products) {
    const fixedImages = [];
    let productModified = false;

    for (const img of p.images) {
      if (!img.url || !img.url.startsWith(BAD_PREFIX)) {
        fixedImages.push(img);
        continue;
      }

      if (img.r2Key) {
        const newUrl = `${CORRECT_BASE}/${img.r2Key}`;
        console.log(`  [FIX]  produit ${p._id}  image ${img._id}`);
        console.log(`         url: ${img.url}`);
        console.log(`      →  url: ${newUrl}\n`);
        fixedImages.push({ ...img, url: newUrl });
        productModified = true;
        totalFixed++;
      } else {
        // Extraire la clé depuis le vieux url (tout ce qui suit 'https://r2.dev/')
        const extractedKey = img.url.slice(BAD_PREFIX.length);
        const newUrl = `${CORRECT_BASE}/${extractedKey}`;
        console.log(`  [FIX+r2Key]  produit ${p._id}  image ${img._id}`);
        console.log(`               url: ${img.url} (sans r2Key)`);
        console.log(`            →  r2Key: ${extractedKey}`);
        console.log(`            →  url: ${newUrl}\n`);
        fixedImages.push({ ...img, r2Key: extractedKey, url: newUrl });
        productModified = true;
        totalFixed++;
        totalNoKey++;
      }
    }

    if (productModified && !DRY_RUN) {
      await Product.updateOne(
        { _id: p._id },
        { $set: { images: fixedImages } },
      );
    }
  }

  console.log('─'.repeat(50));
  console.log(`Images corrigées        : ${totalFixed}`);
  console.log(`  dont sans r2Key (ext) : ${totalNoKey}`);
  if (DRY_RUN) {
    console.log('\n🟡  DRY RUN — rien n'a été écrit. Relance avec DRY_RUN=false pour appliquer.');
  } else {
    console.log('\n✅  Migration appliquée.');
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
