'use strict';

const express    = require('express');
const router     = express.Router();
const PlanConfig = require('../models/PlanConfig');
const { FEATURE_KEYS } = require('../models/PlanConfig');
const { authMiddleware }         = require('../middleware/auth');
const { detectCountryFromPhone } = require('../constants/pricingGrid');

// Labels d'affichage — même ordre que FEATURE_KEYS dans le modèle.
const FEATURE_LABELS = {
  public_storefront:   'Boutique publique',
  order_management:    'Gestion des commandes',
  employee_management: 'Gestion des employés',
  unlimited_catalog:   'Catalogue illimité',
  advanced_stats:      'Analytics avancées',
  priority_support:    'Support prioritaire 24h',
};

/**
 * Construit la liste d'affichage des features pour un plan à partir du modèle :
 * - quota de scans (toujours en tête)
 * - features activées (true) dans l'ordre de FEATURE_KEYS
 */
function buildFeatureList(scanQuota, featuresObj) {
  const list = [`${scanQuota.toLocaleString('fr-FR')} scans/mois`];
  for (const key of FEATURE_KEYS) {
    if (featuresObj?.[key]) list.push(FEATURE_LABELS[key]);
  }
  return list;
}

/**
 * GET /api/plans
 * Auth requise — pays détecté depuis le numéro du token (préfixe +221/+223).
 * Toutes les données (prix, quota, libellé, features) viennent de PlanConfig.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const phone   = req.actor?.phone || '';
    const country = detectCountryFromPhone(phone);

    const pc = await PlanConfig.findOne({ key: 'main' });
    if (!pc) {
      return res.status(503).json({ error: 'Configuration tarifaire indisponible — contactez le support' });
    }

    const price = (planKey, period) => pc.computePrice(planKey, country, period);

    const trialScans = pc.trial?.scans ?? 100;

    const plans = [
      {
        key:        'free',
        name:       'Gratuit',
        scan_quota: trialScans,
        prices:     { month: 0, quarter: 0, semester: 0, year: 0 },
        features: [
          `${trialScans} scans/mois (essai ${pc.trial?.days ?? 14} jours)`,
          FEATURE_LABELS.public_storefront,
          FEATURE_LABELS.order_management,
        ],
        highlight: false,
      },
      {
        key:        'pro',
        name:       pc.pro.label || 'Pro',
        scan_quota: pc.getEffectiveScans('pro'),
        prices: {
          month:    price('pro', 'monthly'),
          quarter:  price('pro', 'quarterly'),
          semester: price('pro', 'semiannual'),
          year:     price('pro', 'annual'),
        },
        features:  buildFeatureList(pc.getEffectiveScans('pro'), pc.pro.features),
        highlight: true,
      },
      {
        key:        'premium',
        name:       pc.premium.label || 'Premium',
        scan_quota: pc.getEffectiveScans('premium'),
        prices: {
          month:    price('premium', 'monthly'),
          quarter:  price('premium', 'quarterly'),
          semester: price('premium', 'semiannual'),
          year:     price('premium', 'annual'),
        },
        features:  buildFeatureList(pc.getEffectiveScans('premium'), pc.premium.features),
        highlight: false,
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
