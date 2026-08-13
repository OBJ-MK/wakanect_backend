require('dotenv').config();
const mongoose = require('mongoose');

// Passe à false une fois que la liste ci-dessous te semble correcte
const DRY_RUN = true;

const KEEP_BUSINESS_NAMES = ['Kane Empire', 'myma chop'];

// Toutes les collections qui référencent merchantId
const MERCHANT_SCOPED_COLLECTIONS = [
  'orders',
  'products',
  'parsedmessages',
  'parsingevents',
  'payments',
  'pendingmedias',
  'pushsubscriptions',
  'subscriptions',
  'auditlogs',
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  const db = mongoose.connection;
  const merchants = db.collection('merchants');

  // Recherche insensible à la casse/espaces
  const patterns = KEEP_BUSINESS_NAMES.map(
    (n) => new RegExp(`^\\s*${n.trim()}\\s*$`, 'i')
  );
  const toKeep = await merchants.find({ businessName: { $in: patterns } }).toArray();

  console.log('Marchands trouvés à conserver :');
  toKeep.forEach((m) => console.log(`  - ${m.businessName} (${m._id}) — slug: ${m.slug}`));

  if (toKeep.length !== KEEP_BUSINESS_NAMES.length) {
    console.error(
      `\n❌ Attendu ${KEEP_BUSINESS_NAMES.length} marchands, trouvé ${toKeep.length}. ` +
      `Vérifie l'orthographe exacte de businessName en base avant de continuer.`
    );
    process.exit(1);
  }

  const keepIds = toKeep.map((m) => m._id);

  const otherMerchants = await merchants.find({ _id: { $nin: keepIds } }).toArray();
  console.log(`\n${otherMerchants.length} autre(s) marchand(s) seront supprimés :`);
  otherMerchants.forEach((m) => console.log(`  - ${m.businessName} (${m._id})`));

  console.log(`\nMode: ${DRY_RUN ? 'DRY RUN (aucune suppression)' : '⚠️  SUPPRESSION RÉELLE'}\n`);

  for (const colName of MERCHANT_SCOPED_COLLECTIONS) {
    const col = db.collection(colName);
    const count = await col.countDocuments({ merchantId: { $nin: keepIds } });
    console.log(`${colName}: ${count} document(s) à supprimer`);
    if (!DRY_RUN && count > 0) {
      const res = await col.deleteMany({ merchantId: { $nin: keepIds } });
      console.log(`  → ${res.deletedCount} supprimé(s)`);
    }
  }

  const merchantDeleteCount = otherMerchants.length;
  console.log(`\nmerchants: ${merchantDeleteCount} document(s) à supprimer`);
  if (!DRY_RUN && merchantDeleteCount > 0) {
    const res = await merchants.deleteMany({ _id: { $nin: keepIds } });
    console.log(`  → ${res.deletedCount} supprimé(s)`);
  }

  console.log(DRY_RUN ? '\n✅ Dry run terminé — repasse DRY_RUN à false pour exécuter.' : '\n✅ Nettoyage terminé.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });