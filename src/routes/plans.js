'use strict';

const express    = require('express');
const router     = express.Router();
const PlanConfig = require('../models/PlanConfig');
const { FEATURE_KEYS } = require('../models/PlanConfig');
const { detectCountryFromPhone } = require('../constants/pricingGrid');

// Labels d'affichage pour chaque clé de feature booléenne.
const FEATURE_LABELS = {
  public_storefront: 'Boutique publique',
  order_management:  'Gestion des commandes',
  unlimited_catalog: 'Catalogue complet',
  advanced_stats:    'Analytics avancées',
  priority_support:  'Support prioritaire 24h',
};

/**
 * Calcule le label d'économie affiché dans le sélecteur de période.
 * Renvoie null si aucune remise (multiplier >= durationMonths).
 */
function discountLabel(multiplier, durationMonths) {
  const savings = durationMonths - multiplier;
  if (savings <= 0) return null;
  const savedMonths = Math.round(savings);
  if (Math.abs(savings - savedMonths) < 0.05) {
    return savedMonths === 1 ? '1 mois offert' : `${savedMonths} mois offerts`;
  }
  return `-${Math.round((savings / durationMonths) * 100)}%`;
}

/**
 * Produit la ligne "Gestion des employés (…)" depuis maxEmployees.
 * Renvoie null si aucun employé autorisé.
 */
function employeeFeatureLabel(maxEmployees) {
  if (maxEmployees === -1) return 'Gestion des employés';
  if (maxEmployees > 0)    return `Gestion des employés (max ${maxEmployees})`;
  return null;
}

/**
 * Construit la liste d'affichage des features pour un plan :
 *   1. quota de scans (toujours premier)
 *   2. features booléennes activées (ordre FEATURE_KEYS)
 *      → label employés inséré après order_management
 */
function buildFeatureList(scanQuota, featuresObj, maxEmployees) {
  const list = [`${scanQuota.toLocaleString('fr-FR')} scans/mois`];
  for (const key of FEATURE_KEYS) {
    if (featuresObj?.[key]) list.push(FEATURE_LABELS[key]);
    if (key === 'order_management') {
      const empLabel = employeeFeatureLabel(maxEmployees ?? 0);
      if (empLabel) list.push(empLabel);
    }
  }
  return list;
}

/**
 * Extrait les flags booléens d'un planEntry de PlanConfig.
 */
function featuresFlags(entry) {
  return {
    advanced_stats:    !!(entry?.features?.advanced_stats),
    unlimited_catalog: !!(entry?.features?.unlimited_catalog),
    priority_support:  !!(entry?.features?.priority_support),
  };
}

/**
 * GET /api/plans
 * Route publique — pays détecté depuis le numéro du token si présent,
 * sinon défaut Sénégal (SN). La landing est toujours affichée en XOF/SN.
 * Expose aussi trial.{days,scans} et features_flags par plan pour le frontend.
 */
router.get('/', async (req, res) => {
  try {
    // Pays depuis le token si l'utilisateur est connecté, sinon SN par défaut
    const phone   = req.actor?.phone || '';
    const country = detectCountryFromPhone(phone);

    const pc = await PlanConfig.findOne({ key: 'main' });
    if (!pc) {
      return res.status(503).json({ error: 'Configuration tarifaire indisponible — contactez le support' });
    }

    const price = (planKey, period) => pc.computePrice(planKey, country, period);
    const d     = pc.discounts;
    const trialScans = pc.trial?.scans ?? 100;
    const trialDays  = pc.trial?.days  ?? 14;

    const plans = [
      {
        key:            'free',
        name:           'Gratuit',
        scan_quota:     trialScans,
        max_employees:  0,
        prices:         { month: 0, quarter: 0, semester: 0, year: 0 },
        features: [
          `${trialScans} scans/mois (essai ${trialDays} jours)`,
          FEATURE_LABELS.public_storefront,
          FEATURE_LABELS.order_management,
        ],
        features_flags: { advanced_stats: false, unlimited_catalog: false, priority_support: false },
        highlight:      false,
      },
      {
        key:            'pro',
        name:           pc.pro.label || 'Pro',
        scan_quota:     pc.getEffectiveScans('pro'),
        max_employees:  pc.pro.maxEmployees ?? 0,
        prices: {
          month:    price('pro', 'monthly'),
          quarter:  price('pro', 'quarterly'),
          semester: price('pro', 'semiannual'),
          year:     price('pro', 'annual'),
        },
        features:       buildFeatureList(pc.getEffectiveScans('pro'), pc.pro.features, pc.pro.maxEmployees ?? 0),
        features_flags: featuresFlags(pc.pro),
        highlight:      true,
      },
      {
        key:            'premium',
        name:           pc.premium.label || 'Premium',
        scan_quota:     pc.getEffectiveScans('premium'),
        max_employees:  pc.premium.maxEmployees ?? 0,
        prices: {
          month:    price('premium', 'monthly'),
          quarter:  price('premium', 'quarterly'),
          semester: price('premium', 'semiannual'),
          year:     price('premium', 'annual'),
        },
        features:       buildFeatureList(pc.getEffectiveScans('premium'), pc.premium.features, pc.premium.maxEmployees ?? 0),
        features_flags: featuresFlags(pc.premium),
        highlight:      false,
      },
    ];

    res.json({
      country,
      currency: 'XOF',
      plans,
      trial: { days: trialDays, scans: trialScans },
      // Labels de remise calculés depuis les multiplicateurs réels — aucune valeur en dur.
      discounts: {
        quarter:  discountLabel(d.quarterlyMultiplier,  3)  ?? null,
        semester: discountLabel(d.semiannualMultiplier, 6)  ?? null,
        year:     discountLabel(d.annualMultiplier,     12) ?? null,
      },
    });
  } catch (err) {
    console.error('[GET /api/plans]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
