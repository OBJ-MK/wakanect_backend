'use strict';

const express    = require('express');
const router     = express.Router();
const PlanConfig = require('../models/PlanConfig');
const { authMiddleware }          = require('../middleware/auth');
const { detectCountryFromPhone }  = require('../constants/pricingGrid');

// ─── Constantes UI (features par plan, jamais "illimité") ────────────────────

const PLAN_META = {
  free: {
    name:      'Gratuit',
    highlight: false,
    features: [
      '100 scans/mois (essai 14 jours)',
      'Boutique publique',
      'Gestion des commandes',
    ],
  },
  pro: {
    name:      'Pro',
    highlight: true,
    features: [
      '3 000 scans/mois',
      'Boutique publique',
      'Gestion des commandes',
      'Gestion des employés',
      'Support standard',
    ],
  },
  premium: {
    name:      'Premium',
    highlight: false,
    features: [
      '15 000 scans/mois',
      'Boutique publique',
      'Gestion des commandes',
      'Gestion des employés',
      'Support prioritaire 24h',
      'Analytics avancées',
    ],
  },
};

/**
 * GET /api/plans
 * Auth requise — pays détecté depuis le numéro du token (préfixe +221/+223).
 * Jamais exposé à l'UI : le country n'est retourné qu'à des fins de debug admin.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const phone   = req.actor?.phone || '';
    const country = detectCountryFromPhone(phone);

    const pc = await PlanConfig.findOne({ key: 'main' });
    if (!pc) {
      return res.status(503).json({ error: 'Configuration tarifaire indisponible — contactez le support' });
    }

    // Helper : prix pour une période donnée
    const price = (planKey, period) =>
      planKey === 'free' ? 0 : pc.computePrice(planKey, country, period);

    const plans = [
      {
        key:        'free',
        name:       PLAN_META.free.name,
        scan_quota: pc.trial?.scans ?? 100,
        prices: {
          month:    0,
          quarter:  0,
          semester: 0,
          year:     0,
        },
        features:  PLAN_META.free.features,
        highlight: PLAN_META.free.highlight,
      },
      {
        key:        'pro',
        name:       PLAN_META.pro.name,
        scan_quota: pc.getEffectiveScans('pro'),
        prices: {
          month:    price('pro', 'monthly'),
          quarter:  price('pro', 'quarterly'),
          semester: price('pro', 'semiannual'),
          year:     price('pro', 'annual'),
        },
        features:  PLAN_META.pro.features,
        highlight: PLAN_META.pro.highlight,
      },
      {
        key:        'premium',
        name:       PLAN_META.premium.name,
        scan_quota: pc.getEffectiveScans('premium'),
        prices: {
          month:    price('premium', 'monthly'),
          quarter:  price('premium', 'quarterly'),
          semester: price('premium', 'semiannual'),
          year:     price('premium', 'annual'),
        },
        features:  PLAN_META.premium.features,
        highlight: PLAN_META.premium.highlight,
      },
    ];

    res.json({
      country,
      currency:  'XOF',
      plans,
      discounts: {
        quarter:  '-10%',
        semester: '1 mois offert',
        year:     '2 mois offerts',
      },
    });
  } catch (err) {
    console.error('[GET /api/plans]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
