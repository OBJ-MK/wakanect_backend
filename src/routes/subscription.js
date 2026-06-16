'use strict';

const express      = require('express');
const router       = express.Router();
const Merchant     = require('../models/Merchant');
const Subscription = require('../models/Subscription');
const PlanConfig   = require('../models/PlanConfig');
const { authMiddleware }         = require('../middleware/auth');
const { requireOwner }           = require('../middleware/permissions');
const { detectCountryFromPhone } = require('../constants/pricingGrid');
const { initiateSoftPay }        = require('../services/paydunyaService');
const {
  createOrRenewSubscription,
  invalidatePlanConfigCache,
} = require('../services/subscriptionService');

// Mapping période frontend → période interne
const PERIOD_MAP = {
  month:    'monthly',
  quarter:  'quarterly',
  semester: 'semiannual',
  year:     'annual',
};

// Mapping période interne → label UI
const PERIOD_LABEL = {
  trial:      'essai',
  monthly:    'month',
  quarterly:  'quarter',
  semiannual: 'semester',
  annual:     'year',
};

router.use(authMiddleware);

/**
 * POST /api/subscription/checkout
 * Body : { plan: "pro|premium", period: "month|quarter|semester|year" }
 * Déclenche PayDunya SoftPay (invisible UI).
 * Réponse : { handle, status } — "PayDunya" n'apparaît jamais côté UI.
 * Owners uniquement.
 */
router.post('/checkout', requireOwner, async (req, res) => {
  try {
    const { plan, period: periodFront } = req.body;

    if (!['pro', 'premium'].includes(plan)) {
      return res.status(400).json({ error: 'plan invalide (pro | premium)' });
    }

    const period = PERIOD_MAP[periodFront];
    if (!period) {
      return res.status(400).json({
        error: `period invalide. Valeurs : ${Object.keys(PERIOD_MAP).join(' | ')}`,
      });
    }

    const merchant = await Merchant.findById(req.merchantId).lean();
    if (!merchant) return res.status(404).json({ error: 'Commerçant introuvable' });

    const country = detectCountryFromPhone(merchant.whatsappPhone);

    // Calcul du montant depuis PlanConfig
    const pc = await PlanConfig.findOne({ key: 'main' });
    if (!pc) return res.status(503).json({ error: 'Configuration tarifaire indisponible' });

    const amount      = pc.computePrice(plan, country, period);
    const description = `Wakanect ${plan === 'pro' ? 'Pro' : 'Premium'} — ${periodFront}`;

    // Initier le paiement SoftPay (ou stub si non configuré)
    let paymentHandle, paymentStatus;
    try {
      const result = await initiateSoftPay({
        amount,
        phone:       merchant.whatsappPhone,
        description,
        callbackUrl: `${process.env.APP_URL}/webhook/paydunya`,
      });
      paymentHandle = result.handle;
      paymentStatus = result.status;
    } catch (payErr) {
      console.error('[subscription/checkout] PayDunya:', payErr.message);
      return res.status(502).json({ error: 'Paiement indisponible, réessayez dans quelques minutes' });
    }

    // Pour les stubs dev : créer directement l'abonnement actif (mode test sans vrai paiement)
    if (process.env.NODE_ENV !== 'production') {
      try {
        await createOrRenewSubscription(merchant, plan, period, paymentHandle);
        invalidatePlanConfigCache();
      } catch (subErr) {
        console.error('[subscription/checkout] sub creation:', subErr.message);
      }
    }

    res.json({
      handle:  paymentHandle,
      status:  paymentStatus,
      amount,
      plan,
      period:  periodFront,
    });
  } catch (err) {
    console.error('[POST /api/subscription/checkout]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/subscription/status
 * Retourne le statut de l'abonnement courant.
 */
router.get('/status', async (req, res) => {
  try {
    const sub = await Subscription.findOne({ merchantId: req.merchantId })
      .sort({ createdAt: -1 })
      .lean();

    if (!sub) {
      return res.json({
        status:      'none',
        plan:        'free',
        period:      null,
        ends_at:     null,
        scans_quota: 100,
      });
    }

    // Quota effectif depuis PlanConfig
    const pc = await PlanConfig.findOne({ key: 'main' });
    let scansQuota = 100;
    if (pc) {
      if (sub.plan === 'pro')           scansQuota = pc.getEffectiveScans('pro');
      else if (sub.plan === 'premium')  scansQuota = pc.getEffectiveScans('premium');
      else                              scansQuota = pc.trial?.scans ?? 100;
    }

    res.json({
      status:      sub.status,
      plan:        sub.plan,
      period:      PERIOD_LABEL[sub.period] || sub.period,
      ends_at:     sub.endDate ? new Date(sub.endDate).toISOString() : null,
      scans_quota: scansQuota,
    });
  } catch (err) {
    console.error('[GET /api/subscription/status]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
