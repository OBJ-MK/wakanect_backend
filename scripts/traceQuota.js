require('dotenv').config();
const mongoose = require('mongoose');
const Merchant = require('../src/models/Merchant');
const Subscription = require('../src/models/Subscription');
const PlanConfig = require('../src/models/PlanConfig');
const svc = require('../src/services/subscriptionService');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });

  const merchant = await Merchant.findOne({ slug: 'modibo-teste' }).lean();
  console.log('merchant._id:', merchant._id, typeof merchant._id, merchant._id.constructor.name);

  const sub = await svc.getActiveSubscription(merchant._id);
  console.log('getActiveSubscription() ->', sub ? { status: sub.status, endDate: sub.endDate } : null);

  const cfg = await PlanConfig.findOne({ key: 'main' });
  console.log('cfg.trial ->', cfg.trial);
  console.log('cfg.getEffectiveScans("free") ->', cfg.getEffectiveScans('free'));

  const quota = await svc.getEffectiveQuota(merchant._id);
  console.log('getEffectiveQuota() ->', quota);

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });