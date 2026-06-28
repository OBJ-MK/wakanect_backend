'use strict';

const express    = require('express');
const router     = express.Router();
const Merchant   = require('../models/Merchant');
const Subscription = require('../models/Subscription');
const Payment    = require('../models/Payment');
const PlanConfig = require('../models/PlanConfig');
const { authMiddleware }           = require('../middleware/auth');
const { requireOwner }             = require('../middleware/permissions');
const { detectCountryFromPhone }   = require('../constants/pricingGrid');
const { createCheckoutInvoice }    = require('../services/paydunyaService');

// Périodes : frontend → interne
const PERIOD_MAP = {
  month:    'monthly',
  quarter:  'quarterly',
  semester: 'semiannual',
  year:     'annual',
};

// Périodes : interne → label frontend
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
 * Le montant est calculé côté serveur — jamais reçu du client.
 * Réponse : { url } — le provider reste invisible.
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

    const pc = await PlanConfig.findOne({ key: 'main' });
    if (!pc) return res.status(503).json({ error: 'Configuration tarifaire indisponible' });

    // Montant calculé exclusivement depuis PlanConfig (toute valeur client est ignorée)
    const amount = pc.computePrice(plan, country, period);

    // Enregistrement de la transaction en attente
    const payment = await Payment.create({
      merchantId: merchant._id,
      plan,
      period,
      country,
      amount,
    });

    // Création de la facture PAR côté provider
    let token, checkoutUrl;
    try {
      ({ token, url: checkoutUrl } = await createCheckoutInvoice({
        merchant,
        plan,
        period,
        amount,
        paymentId: payment._id,
      }));
    } catch (payErr) {
      console.error('[subscription/checkout]', payErr.message);
      await Payment.findByIdAndUpdate(payment._id, { status: 'cancelled' });
      return res.status(502).json({
        error: 'Paiement indisponible, réessayez dans quelques minutes',
      });
    }

    // Sauvegarde du token de facture pour l'idempotence IPN
    await Payment.findByIdAndUpdate(payment._id, { paydunyaInvoiceToken: token });

    return res.json({ url: checkoutUrl });
  } catch (err) {
    console.error('[POST /api/subscription/checkout]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/subscription
 * Retourne { plan, status, endsAt, period, cancelAtPeriodEnd } — status calculé en direct, zéro mention de provider.
 */
router.get('/', async (req, res) => {
  try {
    const sub = await Subscription.findOne({ merchantId: req.merchantId })
      .sort({ createdAt: -1 })
      .lean();

    if (!sub) {
      return res.json({ plan: 'free', status: 'expiré', endsAt: null, period: null, cancelAtPeriodEnd: false });
    }

    const now = Date.now();
    const end = new Date(sub.endDate).getTime();

    let status;
    if (sub.status === 'trial' && now < end) {
      status = 'essai';
    } else if (sub.status === 'active' && now < end) {
      status = 'actif';
    } else {
      status = 'expiré';
    }

    return res.json({
      plan:              sub.plan,
      status,
      endsAt:            sub.endDate ? new Date(sub.endDate).toISOString() : null,
      period:            PERIOD_LABEL[sub.period] || sub.period,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
    });
  } catch (err) {
    console.error('[GET /api/subscription]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/subscription/payments
 * Historique des paiements du marchand — zéro champ provider.
 * Inclut completed + failed, exclut pending/cancelled.
 */
router.get('/payments', requireOwner, async (req, res) => {
  try {
    const payments = await Payment.find(
      { merchantId: req.merchantId, status: { $in: ['completed', 'failed'] } },
      { amount: 1, plan: 1, period: 1, status: 1, paidAt: 1, createdAt: 1, _id: 0 }
    ).sort({ paidAt: -1, createdAt: -1 }).lean();

    const result = payments.map((p) => ({
      date:   (p.paidAt || p.createdAt).toISOString(),
      amount: p.amount,
      plan:   p.plan,
      period: PERIOD_LABEL[p.period] || p.period,
      status: p.status,
    }));

    return res.json({ payments: result });
  } catch (err) {
    console.error('[GET /api/subscription/payments]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/subscription/cancel
 * Programme la résiliation à fin de période (cancelAtPeriodEnd=true).
 * NE modifie PAS status — l'accès reste actif jusqu'à endDate.
 */
router.post('/cancel', requireOwner, async (req, res) => {
  try {
    const sub = await Subscription.findOneAndUpdate(
      { merchantId: req.merchantId, status: { $in: ['trial', 'active'] } },
      { cancelAtPeriodEnd: true },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!sub) {
      return res.status(404).json({ error: 'Aucun abonnement actif à résilier' });
    }

    return res.json({ cancelAtPeriodEnd: sub.cancelAtPeriodEnd, status: sub.status, endsAt: sub.endDate });
  } catch (err) {
    console.error('[POST /api/subscription/cancel]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/subscription/reactivate
 * Annule la résiliation programmée (cancelAtPeriodEnd=false).
 */
router.post('/reactivate', requireOwner, async (req, res) => {
  try {
    const sub = await Subscription.findOneAndUpdate(
      { merchantId: req.merchantId, status: { $in: ['trial', 'active'] } },
      { cancelAtPeriodEnd: false },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!sub) {
      return res.status(404).json({ error: 'Aucun abonnement actif' });
    }

    return res.json({ cancelAtPeriodEnd: sub.cancelAtPeriodEnd, status: sub.status, endsAt: sub.endDate });
  } catch (err) {
    console.error('[POST /api/subscription/reactivate]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/subscription/status
 * Conservé pour rétrocompatibilité.
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

    const pc = await PlanConfig.findOne({ key: 'main' });
    let scansQuota = 100;
    if (pc) {
      if (sub.plan === 'pro')          scansQuota = pc.getEffectiveScans('pro');
      else if (sub.plan === 'premium') scansQuota = pc.getEffectiveScans('premium');
      else                             scansQuota = pc.trial?.scans ?? 100;
    }

    return res.json({
      status:      sub.status,
      plan:        sub.plan,
      period:      PERIOD_LABEL[sub.period] || sub.period,
      ends_at:     sub.endDate ? new Date(sub.endDate).toISOString() : null,
      scans_quota: scansQuota,
    });
  } catch (err) {
    console.error('[GET /api/subscription/status]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
