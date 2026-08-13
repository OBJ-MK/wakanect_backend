require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = false;

// Tout ce qui existe dans la base wakanect, sauf planconfigs (config fixe, jamais touchée)
const COLLECTIONS_TO_WIPE = [
  'merchants',
  'orders',
  'products',
  'parsedmessages',
  'parsingevents',
  'payments',
  'pendingmedias',
  'pushsubscriptions',
  'subscriptions',
  'auditlogs',
  'counters', // compteurs orderNumber — orphelins une fois les marchands supprimés
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  const db = mongoose.connection;

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (aucune suppression)' : '⚠️  SUPPRESSION RÉELLE'}\n`);

  for (const colName of COLLECTIONS_TO_WIPE) {
    const col = db.collection(colName);
    const count = await col.countDocuments({});
    console.log(`${colName}: ${count} document(s) à supprimer`);
    if (!DRY_RUN && count > 0) {
      const res = await col.deleteMany({});
      console.log(`  → ${res.deletedCount} supprimé(s)`);
    }
  }

  const configCount = await db.collection('planconfigs').countDocuments({});
  console.log(`\nplanconfigs: ${configCount} document(s) conservé(s) (non touché)`);

  console.log(DRY_RUN ? '\n✅ Dry run terminé — repasse DRY_RUN à false pour exécuter.' : '\n✅ Base nettoyée.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });