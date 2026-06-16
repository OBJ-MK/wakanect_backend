'use strict';

/**
 * WAKANECT — Seed de développement (DEV UNIQUEMENT)
 *
 * Usage :
 *   node scripts/seedDev.js          → seed complet
 *   SEED_DEMO=0 node scripts/seedDev.js → superadmin + PlanConfig seulement
 *
 * Idempotent : peut être rejoué sans créer de doublons.
 * Refusé si NODE_ENV=production.
 *
 * Crée :
 *   - Superadmin (depuis l'env)
 *   - PlanConfig singleton (pro=3000, premium=15000 scans/mois)
 *   - Boutique démo principale (demo-smoke-boutique) :
 *       · 1 employé (permissions restreintes)
 *       · Subscription trial pro active
 *       · 3 produits publiés avec empreintes sha256/phash
 *       · 1 commande exemple (pending)
 *   - Boutique quota-test (demo-quota-test) :
 *       · usage.scansCurrentMonth au plafond (pour test D smoke)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');

const Merchant     = require('../src/models/Merchant');
const Subscription = require('../src/models/Subscription');
const Product      = require('../src/models/Product');
const Order        = require('../src/models/Order');
const PlanConfig   = require('../src/models/PlanConfig');

const IS_PROD   = process.env.NODE_ENV === 'production';
const SEED_DEMO = process.env.SEED_DEMO !== '0';

if (IS_PROD && SEED_DEMO) {
  console.error('\n  REFUS : seed dev interdit en NODE_ENV=production.');
  console.error('  Relancez avec SEED_DEMO=0 pour créer uniquement le superadmin.\n');
  process.exit(1);
}

const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

// ─── Empreintes factices déterministes ────────────────────────────────────────

function fakeFingerprints(seed) {
  return {
    sha256: crypto.createHash('sha256').update(`sha256-${seed}`).digest('hex'),
    phash:  crypto.createHash('sha256').update(`phash-${seed}`).digest('hex').slice(0, 16),
  };
}

// ─── PlanConfig ───────────────────────────────────────────────────────────────

async function seedPlanConfig() {
  const existing = await PlanConfig.findOne({ key: 'main' });
  if (existing) {
    console.log('  PlanConfig       : existant — skip');
    return existing;
  }

  const cfg = await PlanConfig.create({
    key:     'main',
    pro:     { scansPerMonth: 3000,  priceSN: 5000,  priceML: 3600  },
    premium: { scansPerMonth: 15000, priceSN: 15000, priceML: 10800 },
    trial:   { days: 14, scans: 100 },
    discounts: {
      monthlyMultiplier:    1,
      quarterlyMultiplier:  2.7,
      semiannualMultiplier: 5,
      annualMultiplier:     10,
    },
    packs: [],
  });
  console.log('  PlanConfig       : créé (pro=3000, premium=15000 scans/mois)');
  return cfg;
}

// ─── Superadmin ───────────────────────────────────────────────────────────────

async function seedSuperadmin() {
  const phone    = process.env.SUPERADMIN_PHONE;
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!phone || !password) {
    throw new Error('SUPERADMIN_PHONE et SUPERADMIN_PASSWORD sont requis dans .env');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await Merchant.findOneAndUpdate(
    { whatsappPhone: phone },
    {
      $set: {
        whatsappPhone: phone,
        slug:          'superadmin',
        businessName:  'Wakanect Admin',
        ownerName:     'Superadmin',
        role:          'superadmin',
        isActive:      true,
        plan:          'free',
        passwordHash,
      },
      $setOnInsert: { employees: [], createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  console.log(`  Superadmin       : ${admin.slug} (${phone}) — mdp: ${password}`);
  return admin;
}

// ─── Boutique démo principale ─────────────────────────────────────────────────

const SHOP_PHONE = '221770001234';
const SHOP_PWD   = 'Shop1234';
const EMP_PHONE  = '221780001234';
const EMP_PWD    = 'Emp1234';
const SHOP_SLUG  = 'demo-smoke-boutique';

async function seedDemoShop() {
  console.log('\n  --- Boutique principale ---');

  const passwordHash    = await bcrypt.hash(SHOP_PWD, 10);
  const empPasswordHash = await bcrypt.hash(EMP_PWD, 10);

  let shop = await Merchant.findOneAndUpdate(
    { slug: SHOP_SLUG },
    {
      $set: {
        slug:          SHOP_SLUG,
        businessName:  'Boutique Smoke Test',
        ownerName:     'Modou Fall',
        whatsappPhone: SHOP_PHONE,
        plan:          'pro',
        isActive:      true,
        role:          'merchant',
        passwordHash,
        'usage.scansCurrentMonth': 0,
        'usage.scansMonth':        currentMonth,
        lastInboundAt:             new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  // Employé
  const empExists = shop.employees.some(e => e.phone === EMP_PHONE);
  if (!empExists) {
    shop.employees.push({
      name:         'Awa Diallo',
      phone:        EMP_PHONE,
      passwordHash: empPasswordHash,
      active:       true,
      permissions:  ['dashboard.view', 'products.send', 'orders.confirm'],
    });
    await shop.save();
    console.log(`  Employé          : Awa Diallo (${EMP_PHONE}) — mdp: ${EMP_PWD}`);
  } else {
    console.log(`  Employé          : existant — skip`);
  }

  // Subscription trial pro
  const existingSub = await Subscription.findOne({ merchantId: shop._id }).lean();
  if (!existingSub) {
    await Subscription.create({
      merchantId: shop._id,
      plan:       'pro',
      period:     'trial',
      country:    'SN',
      startDate:  new Date(),
      endDate:    new Date(Date.now() + 14 * 86_400_000),
      status:     'trial',
      amountFcfa: 0,
    });
    console.log('  Subscription     : trial pro — active (14 jours)');
  } else {
    console.log('  Subscription     : existante — skip');
  }

  // Produits publiés avec empreintes
  // Upsert par (merchantId + sku) pour rester idempotent malgré l'index unique+sparse
  const productDefs = [
    { name: 'Baskets Nike Air Max', price: 25000, stock: 100, sku: 'BASK001', seed: 'baskets-nike-1' },
    { name: 'Chemise Wax Dakar',    price: 8500,  stock: 50,  sku: 'CHEM001', seed: 'chemise-wax-2'  },
    { name: 'Sac Cuir Noir',        price: 35000, stock: 20,  sku: 'SAC001',  seed: 'sac-cuir-3'     },
  ];

  let firstProductId;
  for (const def of productDefs) {
    const fp = fakeFingerprints(def.seed);
    const p = await Product.findOneAndUpdate(
      { merchantId: shop._id, sku: def.sku },
      {
        $set: {
          name:        def.name,
          price:       def.price,
          currency:    'FCFA',
          unit:        'pièce',
          isPublished: true,
          submittedBy: { actorType: 'owner', actorId: shop._id, name: shop.ownerName, phone: shop.whatsappPhone },
        },
        $setOnInsert: {
          stock:       def.stock,
          sku:         def.sku,
          images: [{
            url:       `https://r2.dev/shop-smoke/${def.seed}.webp`,
            r2Key:     `shop-smoke/${def.seed}.webp`,
            mimeType:  'image/webp',
            isPrimary: true,
            sha256:    fp.sha256,
            phash:     fp.phash,
          }],
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    if (!firstProductId) firstProductId = p._id;
    console.log(`  Produit          : "${p.name}" sku=${def.sku} stock=${p.stock} sha256=…${fp.sha256.slice(-8)}`);
  }

  // Commande exemple (pending, stock non décrémenté)
  const existingOrder = await Order.findOne({ merchantId: shop._id }).lean();
  if (!existingOrder) {
    const product = await Product.findById(firstProductId).lean();
    await Order.create({
      merchantId:    shop._id,
      customer:      { name: 'Fatou Ba', phone: '221770000001', address: 'Plateau, Dakar' },
      items: [{
        productId:   product._id,
        productName: product.name,
        quantity:    2,
        unitPrice:   product.price,
        currency:    'FCFA',
        subtotal:    product.price * 2,
      }],
      totalAmount:   product.price * 2,
      currency:      'FCFA',
      status:        'pending',
      paymentStatus: 'unpaid',
      statusHistory: [{ status: 'pending', at: new Date() }],
    });
    console.log('  Commande exemple : Fatou Ba (pending, 2 × Baskets Nike)');
  } else {
    console.log('  Commande         : existante — skip');
  }

  console.log(`\n  owner  → phone=${SHOP_PHONE}   mdp=${SHOP_PWD}`);
  console.log(`  employé→ phone=${EMP_PHONE}  mdp=${EMP_PWD}   perms=[dashboard.view, products.send, orders.confirm]`);

  return shop;
}

// ─── Boutique quota-test ──────────────────────────────────────────────────────

const QUOTA_PHONE = '221779999999';
const QUOTA_PWD   = 'Quota1234';
const QUOTA_SLUG  = 'demo-quota-test';

async function seedQuotaTestShop() {
  console.log('\n  --- Boutique quota-test ---');

  const passwordHash = await bcrypt.hash(QUOTA_PWD, 10);

  const shop = await Merchant.findOneAndUpdate(
    { slug: QUOTA_SLUG },
    {
      $set: {
        slug:          QUOTA_SLUG,
        businessName:  'Quota Test Shop',
        ownerName:     'Quota Tester',
        whatsappPhone: QUOTA_PHONE,
        plan:          'pro',
        isActive:      true,
        role:          'merchant',
        passwordHash,
        // Compteur déjà au plafond → tout scan entrant sera bloqué
        'usage.scansCurrentMonth': 3000,
        'usage.scansMonth':        currentMonth,
      },
      $setOnInsert: { employees: [], createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  const existingSub = await Subscription.findOne({ merchantId: shop._id }).lean();
  if (!existingSub) {
    await Subscription.create({
      merchantId: shop._id,
      plan:       'pro',
      period:     'trial',
      country:    'SN',
      startDate:  new Date(),
      endDate:    new Date(Date.now() + 14 * 86_400_000),
      status:     'trial',
      amountFcfa: 0,
    });
    console.log('  Subscription     : trial pro');
  } else {
    console.log('  Subscription     : existante — skip');
  }

  console.log(`  phone=${QUOTA_PHONE}   scansCurrentMonth=3000/3000 (quota atteint)`);
  return shop;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI est requis dans .env');
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  console.log('\n  Connecté à MongoDB\n');

  await seedPlanConfig();
  await seedSuperadmin();

  if (SEED_DEMO) {
    await seedDemoShop();
    await seedQuotaTestShop();
  }

  console.log('\n  Seed dev terminé.\n');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n  Seed échoué :', err.message);
  process.exit(1);
});
