/**
 * WAKANECT — Seed admin + données de démo
 *
 * Usage :
 *   node scripts/seedAdminDemo.js           → upsert superadmin + démo (bloqué en prod)
 *   SEED_DEMO=0 node scripts/seedAdminDemo.js → upsert superadmin uniquement (prod-safe)
 *
 * Variables d'env requises :
 *   SUPERADMIN_PHONE    — numéro normalisé sans + (ex: 221770000000)
 *   SUPERADMIN_PASSWORD — mot de passe en clair (hashé ici, jamais stocké en clair)
 *
 * Idempotent : peut être rejoué sans créer de doublons.
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const Merchant     = require('../src/models/Merchant');
const Subscription = require('../src/models/Subscription');
const ParsingEvent = require('../src/models/ParsingEvent');
const AuditLog     = require('../src/models/AuditLog');
const { detectCountryFromPhone } = require('../src/constants/pricingGrid');
const { normalizePhone } = require('../src/utils/phone');

const IS_PROD     = process.env.NODE_ENV === 'production';
const SEED_DEMO   = process.env.SEED_DEMO !== '0';

// ─── Garde-fou production ──────────────────────────────────────────────────────

function assertNotProdDemo() {
  if (IS_PROD && SEED_DEMO) {
    console.error('\n  REFUS : le seed de démo ne peut pas s\'exécuter en NODE_ENV=production.');
    console.error('  Relancez avec SEED_DEMO=0 pour créer uniquement le compte superadmin.\n');
    process.exit(1);
  }
}

// ─── Upsert superadmin ─────────────────────────────────────────────────────────

async function upsertSuperadmin() {
  const phone    = process.env.SUPERADMIN_PHONE;
  const password = process.env.SUPERADMIN_PASSWORD;

  if (!phone || !password) {
    throw new Error('SUPERADMIN_PHONE et SUPERADMIN_PASSWORD sont requis dans .env');
  }

  const normalized = normalizePhone(phone);
  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await Merchant.findOneAndUpdate(
    { whatsappPhone: normalized },
    {
      $set: {
        whatsappPhone: normalized,
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
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`  Superadmin : ${admin.slug} (${normalized})`);
  return admin;
}

// ─── Seed de démo ─────────────────────────────────────────────────────────────

async function seedDemo() {
  console.log('\n  Création des données de démo...\n');

  // 3 boutiques fictives (2 SN + 1 ML)
  const shopDefs = [
    {
      slug: 'demo-fatou-mode',
      businessName: 'Fatou Mode',
      ownerName: 'Fatou Diallo',
      whatsappPhone: '221771234567',
      plan: 'pro',
      subStatus: 'active',
      subPeriod: 'monthly',
    },
    {
      slug: 'demo-ibrahima-electronique',
      businessName: 'Ibrahima Électronique',
      ownerName: 'Ibrahima Sow',
      whatsappPhone: '221769876543',
      plan: 'premium',
      subStatus: 'active',
      subPeriod: 'quarterly',
    },
    {
      slug: 'demo-aminata-bamako',
      businessName: 'Aminata Couture Bamako',
      ownerName: 'Aminata Traoré',
      whatsappPhone: '22376543210',
      plan: 'pro',
      subStatus: 'trial',
      subPeriod: 'trial',
    },
  ];

  const shops = [];
  for (const def of shopDefs) {
    const passwordHash = await bcrypt.hash('demo1234', 10);
    const shop = await Merchant.findOneAndUpdate(
      { slug: def.slug },
      {
        $set: {
          slug:          def.slug,
          businessName:  def.businessName,
          ownerName:     def.ownerName,
          whatsappPhone: def.whatsappPhone,
          plan:          def.plan,
          isActive:      true,
          role:          'merchant',
          passwordHash,
          lastInboundAt: new Date(Date.now() - Math.random() * 5 * 86400_000),
        },
        $setOnInsert: { employees: [], createdAt: new Date(Date.now() - 60 * 86400_000) },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    shops.push({ shop, def });
    console.log(`  Boutique : ${shop.slug} (${detectCountryFromPhone(shop.whatsappPhone)})`);
  }

  // Subscriptions
  for (const { shop, def } of shops) {
    const existing = await Subscription.findOne({ merchantId: shop._id });
    if (!existing) {
      const country   = detectCountryFromPhone(shop.whatsappPhone);
      const startDate = new Date(Date.now() - 20 * 86400_000);
      const endDate   = def.subStatus === 'trial'
        ? new Date(Date.now() + 10 * 86400_000)
        : new Date(Date.now() + 10 * 86400_000);

      const amountMap = { 'SN:pro:monthly': 5000, 'SN:premium:quarterly': 24500, 'ML:pro:trial': 0 };
      const amountFcfa = amountMap[`${country}:${def.plan}:${def.subPeriod}`] || 0;

      await Subscription.create({
        merchantId: shop._id,
        plan:       def.plan,
        period:     def.subPeriod,
        country,
        startDate,
        endDate,
        status:    def.subStatus,
        amountFcfa,
      });
      console.log(`  Subscription : ${shop.slug} — ${def.subStatus} ${def.plan}`);
    }
  }

  // ParsingEvents sur 30 jours (données réalistes)
  const existingEventsCount = await ParsingEvent.countDocuments({
    boutiqueSlug: { $in: shops.map(({ shop }) => shop.slug) },
  });

  if (existingEventsCount === 0) {
    const tiers = ['regex', 'regex', 'regex', 'cloudflare', 'cloudflare', 'haiku', 'haiku', 'failed'];
    const events = [];

    for (const { shop } of shops) {
      const eventsPerDay = shop.slug === 'demo-ibrahima-electronique' ? 25 : 10;

      for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
        const baseDate = new Date(Date.now() - dayOffset * 86400_000);
        for (let i = 0; i < eventsPerDay; i++) {
          const tier = tiers[Math.floor(Math.random() * tiers.length)];
          const haikuAttempted = tier === 'haiku' || tier === 'failed';
          const inTokens  = haikuAttempted ? 120 + Math.floor(Math.random() * 80) : 0;
          const outTokens = haikuAttempted ? 40  + Math.floor(Math.random() * 40) : 0;
          const cached    = haikuAttempted ? Math.floor(inTokens * 0.7) : 0;
          const costUsd   = haikuAttempted
            ? (inTokens - cached) * 1e-6 + cached * 0.1e-6 + outTokens * 5e-6
            : 0;

          events.push({
            merchantId:          shop._id,
            boutiqueSlug:        shop.slug,
            tierResolved:        tier,
            regexAttempted:      true,
            regexSuccess:        tier === 'regex',
            cloudflareAttempted: ['cloudflare', 'haiku', 'failed'].includes(tier),
            cloudflareSuccess:   tier === 'cloudflare',
            haikuAttempted,
            haikuInputTokens:    inTokens,
            haikuOutputTokens:   outTokens,
            haikuCachedTokens:   cached,
            costUsd,
            confidenceScore:     tier === 'regex' ? 85 + Math.floor(Math.random() * 15) :
                                  tier === 'cloudflare' ? 70 + Math.floor(Math.random() * 20) :
                                  tier === 'haiku' ? 60 + Math.floor(Math.random() * 30) : 20,
            latencyMs:           tier === 'regex' ? 10 + Math.floor(Math.random() * 20) :
                                  tier === 'cloudflare' ? 500 + Math.floor(Math.random() * 500) :
                                  1000 + Math.floor(Math.random() * 2000),
            producedValidProduct: tier !== 'failed',
            messageLength:       30 + Math.floor(Math.random() * 100),
            createdAt:           new Date(baseDate.getTime() + i * 300_000),
          });
        }
      }
    }

    await ParsingEvent.insertMany(events);
    console.log(`  ParsingEvents : ${events.length} événements créés sur 30 jours`);
  } else {
    console.log(`  ParsingEvents : ${existingEventsCount} événements existants — skip`);
  }

  // AuditLog de démo
  const auditCount = await AuditLog.countDocuments({ authorType: 'admin', slug: { $in: shops.map(({ shop }) => shop.slug) } });
  if (auditCount === 0) {
    await AuditLog.insertMany([
      {
        authorType: 'admin', authorName: 'Superadmin', action: 'extend-trial',
        slug: 'demo-aminata-bamako', metadata: { days: 7 },
        createdAt: new Date(Date.now() - 2 * 86400_000),
      },
      {
        authorType: 'admin', authorName: 'Superadmin', action: 'change-plan',
        slug: 'demo-fatou-mode', metadata: { previousPlan: 'free', newPlan: 'pro' },
        createdAt: new Date(Date.now() - 5 * 86400_000),
      },
    ]);
    console.log('  AuditLog : entrées de démo créées');
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  assertNotProdDemo();

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'wakanect' });
  console.log('  Connecté à MongoDB\n');

  await upsertSuperadmin();

  if (SEED_DEMO) {
    await seedDemo();
  }

  console.log('\n  Seed terminé.\n');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n  Seed échoué :', err.message);
  process.exit(1);
});
