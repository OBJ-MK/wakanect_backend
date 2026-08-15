require('dotenv').config();
const mongoose = require('mongoose');
const Merchant = require('../src/models/Merchant');
const Subscription = require('../src/models/Subscription');
const PlanConfig = require('../src/models/PlanConfig');
const { getEffectiveQuota } = require('../src/services/subscriptionService');

// Usage : node scripts/checkQuota.js [slug]
// Sans argument : prend le premier marchand non-superadmin trouvé.

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });

  const slugArg = process.argv[2];
  const merchant = slugArg
    ? await Merchant.findOne({ slug: slugArg }).lean()
    : await Merchant.findOne({ role: { $ne: 'superadmin' } }).lean();

  if (!merchant) {
    console.log('Marchand introuvable.');
    process.exit(1);
  }

  console.log(`\n=== ${merchant.businessName} (${merchant.slug}) ===`);
  console.log('merchant.plan       :', merchant.plan);
  console.log('merchant.isActive   :', merchant.isActive);
  console.log('merchant.usage      :', JSON.stringify(merchant.usage || {}));

  const subs = await Subscription.find({ merchantId: merchant._id }).sort({ createdAt: -1 }).lean();
  console.log(`\n${subs.length} souscription(s) trouvée(s) :`);
  for (const s of subs) {
    console.log(
      `  - status=${s.status} plan=${s.plan} period=${s.period} ` +
      `start=${s.startDate?.toISOString().slice(0,10)} end=${s.endDate?.toISOString().slice(0,10)} ` +
      `(endDate > now: ${s.endDate > new Date()})`
    );
  }

  const cfg = await PlanConfig.findOne({ key: 'main' }).lean();
  console.log('\nPlanConfig.trial    :', JSON.stringify(cfg?.trial || 'ABSENT'));

  const quota = await getEffectiveQuota(merchant._id);
  console.log('\n>>> getEffectiveQuota() calculé :', quota);

  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });