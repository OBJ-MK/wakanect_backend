require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../config/database');
const { normalizePhone } = require('./utils/phone');
const Merchant = require('./models/Merchant');

const webhookRoutes      = require('./routes/webhook');
const stockRoutes        = require('./routes/stock');
const apiRoutes          = require('./routes/api');
const merchantRoutes     = require('./routes/merchants');
const authRoutes         = require('./routes/auth');
const employeeRoutes     = require('./routes/employees');
const pushRoutes         = require('./routes/push');
const adminRoutes        = require('./routes/admin');
const configRoutes       = require('./routes/config');
const plansRoutes        = require('./routes/plans');
const subscriptionRoutes = require('./routes/subscription');
const paydunyaRoutes     = require('./routes/paydunya');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares ───────────────────────────────────────────────────────────────

// Capturer le rawBody pour la vérification HMAC du webhook Meta
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('[:date[clf]] :method :url :status :response-time ms'));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'wakanect-backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

// Webhook WhatsApp Meta
app.use('/webhook', webhookRoutes);

// API Stock (dashboard)
app.use('/api/stock', stockRoutes);

// Auth (login patron + employé)
app.use('/api/auth', authRoutes);

// Inscription / profil commerçant
app.use('/api/merchants', merchantRoutes);

// Gestion employés
app.use('/api/employees', employeeRoutes);

// Web Push (VAPID public key + subscribe/unsubscribe)
app.use('/api/push', pushRoutes);

// Routes publiques — montées AVANT /api pour éviter le authMiddleware global
app.use('/api/config', configRoutes);
app.use('/api/plans', plansRoutes);
// IPN de paiement (PUBLIC — sécurité via hash SHA-512, pas de JWT)
// DOIT être monté avant /api pour ne pas traverser le router.use(authMiddleware) de api.js
app.use('/api/paydunya', paydunyaRoutes);

// API Produits, Commandes, Catalogue, Dashboard
app.use('/api', apiRoutes);

// Abonnement commerçant (checkout + status)
app.use('/api/subscription', subscriptionRoutes);

// Back-office superadmin (cross-tenant, requireSuperadmin sur toutes les routes)
app.use('/api/admin', adminRoutes);


// 404
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} non trouvée` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(' Erreur non gérée:', err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ─── Seed PlanConfig (idempotent — crée uniquement si absente) ───────────────

const ensurePlanConfig = async () => {
  const PlanConfig = require('./models/PlanConfig');
  const existing = await PlanConfig.findOne({ key: 'main' }).lean();
  if (existing) return; // admin changes preserved

  await PlanConfig.create({
    key: 'main',
    pro: {
      label:         'Pro',
      scansPerMonth: 3000,
      maxEmployees:  2,    // 0=aucun, -1=illimité, >0=limite
      priceSN:       5000,
      priceML:       3600,
      pendingDecrease: null,
      features: {
        public_storefront: true,
        order_management:  true,
        unlimited_catalog: false,
        advanced_stats:    false,
        priority_support:  false,
      },
    },
    premium: {
      label:         'Premium',
      scansPerMonth: 15000,
      maxEmployees:  -1,   // -1 = illimité
      priceSN:       15000,
      priceML:       10800,
      pendingDecrease: null,
      features: {
        public_storefront: true,
        order_management:  true,
        unlimited_catalog: true,
        advanced_stats:    true,
        priority_support:  true,
      },
    },
    trial: { days: 14, scans: 100 },
    packs: [{ code: 'extra1000', scans: 1000, priceSN: 0, priceML: 0 }],
    discounts: {
      monthlyMultiplier:    1,
      quarterlyMultiplier:  2.7,
      semiannualMultiplier: 5,
      annualMultiplier:     10,
    },
  });
  console.log(' PlanConfig initialisée (valeurs par défaut)');
};

// ─── Migration : permissions employés existants (pilotes) ─────────────────────

/**
 * Attribue DEFAULT_LEGACY_PERMISSIONS aux employés créés avant l'introduction
 * du système de permissions (ceux qui n'ont pas encore le champ permissions).
 * Idempotente : ne touche pas les employés qui ont déjà des permissions.
 */
const migrateEmployeePermissions = async () => {
  const { DEFAULT_LEGACY_PERMISSIONS } = require('./constants/permissions');
  const result = await Merchant.updateMany(
    { employees: { $elemMatch: { permissions: { $exists: false } } } },
    { $set: { 'employees.$[emp].permissions': DEFAULT_LEGACY_PERMISSIONS } },
    { arrayFilters: [{ 'emp.permissions': { $exists: false } }] }
  );
  if (result.modifiedCount > 0) {
    console.log(` Migration permissions employés : ${result.modifiedCount} marchand(s) mis à jour`);
  }
};

// ─── Migration : normalisation des numéros téléphone ──────────────────────────

const migratePhoneNumbers = async () => {
  const merchants = await Merchant.find({});
  let count = 0;
  for (const m of merchants) {
    let dirty = false;

    const normalizedOwner = normalizePhone(m.whatsappPhone);
    if (normalizedOwner !== m.whatsappPhone) {
      m.whatsappPhone = normalizedOwner;
      dirty = true;
    }

    for (const emp of m.employees) {
      const norm = normalizePhone(emp.phone);
      if (norm !== emp.phone) {
        emp.phone = norm;
        dirty = true;
      }
    }

    if (dirty) {
      await m.save();
      count++;
    }
  }
  if (count > 0) {
    console.log(` Migration téléphones : ${count} document(s) normalisé(s)`);
  }
};

// ─── Démarrage ─────────────────────────────────────────────────────────────────

function logServicesStatus() {
  const integrations = [
    { name: 'Anthropic (Haiku)',      ok: !!process.env.ANTHROPIC_API_KEY },
    { name: 'Cloudflare Workers AI',  ok: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) },
    { name: 'Cloudflare R2 (images)', ok: !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET) },
    { name: 'WhatsApp / Meta',        ok: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_APP_SECRET) },
    { name: 'VAPID (Web Push)',       ok: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) },
  ];
  console.log(' Intégrations :');
  for (const { name, ok } of integrations) {
    console.log(`  ${ok ? '✅' : '⚠️ '} ${name}${ok ? '' : ' — non configurée'}`);
  }
}

const start = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI est requis — démarrage refusé');
  if (!process.env.JWT_SECRET)  throw new Error('JWT_SECRET est requis — démarrage refusé');

  await connectDB();
  await ensurePlanConfig();
  await migrateEmployeePermissions();
  await migratePhoneNumbers();
  app.listen(PORT, () => {
    console.log(`\n Wakanect backend démarré sur le port ${PORT}`);
    console.log(` Webhook URL : ${process.env.APP_URL || `http://localhost:${PORT}`}/webhook`);
    console.log(` Environnement : ${process.env.NODE_ENV || 'development'}`);
    logServicesStatus();
    console.log('');
  });
};

start().catch((err) => {
  console.error(' Démarrage échoué:', err.message);
  process.exit(1);
});

module.exports = app;
