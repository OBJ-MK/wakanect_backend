require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  const orders = mongoose.connection.collection('orders');
  const counters = mongoose.connection.collection('counters');

  const groups = await orders.aggregate([
    {
      $group: {
        _id: {
          merchantId: '$merchantId',
          year: { $substr: ['$orderNumber', 4, 4] }, // "ORD-2026-0043" → "2026"
        },
        maxSeq: { $max: { $toInt: { $substr: ['$orderNumber', 9, 4] } } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  for (const g of groups) {
    const counterId = `orderNumber:${g._id.merchantId}:${g._id.year}`;
    await counters.updateOne({ _id: counterId }, { $set: { seq: g.maxSeq } }, { upsert: true });
    console.log(`${counterId} → seq=${g.maxSeq} (${g.count} commandes existantes)`);
  }

  console.log('✅ Compteurs initialisés.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });