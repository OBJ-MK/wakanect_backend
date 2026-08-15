require('dotenv').config();
const mongoose = require('mongoose');
const Merchant = require('../src/models/Merchant');
const Subscription = require('../src/models/Subscription');
const PlanConfig = require('../src/models/PlanConfig');
const { detectCountryFromPhone } = require('../src/constants/pricingGrid');

const DRY_RUN = false; // repasser à false pour exécuter réellement

// Corrige BUG-003 : createFreeTrial() n'était jamais appelée à l'inscription,
// donc tout marchand créé avant le fix du 15/08/2026 n'a AUCUNE Subscription
// et apparaît "Inactif" en admin dès sa création (computeStatus() retombe sur 'dormant').
// Ce script recrée le trial manquant, calculé depuis la vraie date de création
// du marchand (merchant.createdAt), pas depuis "maintenant".

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (aucune écriture)' : '⚠️  ÉCRITURE RÉELLE'}\n`);

  const cfg = await PlanConfig.findOne({ key: 'main' });
  const trialDays = cfg?.trial?.days ?? 14;

  const merchants = await Merchant.find({ role: { $ne: 'superadmin' } }).lean();
  console.log(`${merchants.length} marchand(s) trouvé(s).\n`);

  let created = 0;
  let skipped = 0;

  for (const m of merchants) {
    const existing = await Subscription.findOne({ merchantId: m._id });
    if (existing) {
      skipped++;
      continue;
    }

    const startDate = m.createdAt || new Date();
    const endDate = new Date(startDate.getTime() + trialDays * 24 * 3600 * 1000);
    const now = new Date();
    const status = endDate > now ? 'trial' : 'canceled'; // trial déjà expiré → on ne le réactive pas artificiellement

    console.log(
      `${m.businessName} (${m.slug}) — créé le ${startDate.toISOString().slice(0, 10)} → ` +
      `trial ${status} jusqu'au ${endDate.toISOString().slice(0, 10)}`
    );

    if (!DRY_RUN) {
      await Subscription.create({
        merchantId: m._id,
        plan: 'free',
        period: 'trial',
        country: detectCountryFromPhone(m.whatsappPhone),
        startDate,
        endDate,
        status,
        amountFcfa: 0,
      });
    }
    created++;
  }

  console.log(`\n${created} trial(s) ${DRY_RUN ? 'à créer' : 'créé(s)'}, ${skipped} marchand(s) déjà couvert(s).`);
  console.log(DRY_RUN ? '\n✅ Dry run terminé — repasse DRY_RUN à false pour exécuter.' : '\n✅ Rattrapage terminé.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });