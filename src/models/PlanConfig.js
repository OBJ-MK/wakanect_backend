'use strict';

const mongoose = require('mongoose');
const { getCountryTier } = require('../constants/countries');

/**
 * Singleton config des plans — une seule doc en base, key='main'.
 * Modifiable en admin via PATCH /api/admin/plans/:plan.
 *
 * Garde-fou quota : une baisse de scansPerMonth est mise en pending jusqu'au
 * 1er du mois suivant (pendingDecrease.effectiveFrom). Une hausse s'applique
 * immédiatement (scansPerMonth mis à jour directement).
 */

/**
 * Clés de features booléennes — ordre d'affichage dans l'UI publique.
 * employee_management est remplacé par maxEmployees (valeur numérique)
 * et n'apparaît plus dans ce tableau.
 */
const FEATURE_KEYS = [
  'public_storefront',
  'order_management',
  'unlimited_catalog',
  'advanced_stats',
  'priority_support',
];

const pendingDecreaseSchema = new mongoose.Schema(
  {
    value:         { type: Number, required: true },
    effectiveFrom: { type: Date,   required: true },
  },
  { _id: false }
);

const featuresSchema = new mongoose.Schema(
  {
    public_storefront:   { type: Boolean, default: true  },
    order_management:    { type: Boolean, default: true  },
    unlimited_catalog:   { type: Boolean, default: false },
    advanced_stats:      { type: Boolean, default: false },
    priority_support:    { type: Boolean, default: false },
    // employee_management supprimé — remplacé par maxEmployees (numérique)
  },
  { _id: false }
);

// ⚠️ C'était CE BLOC qui avait disparu — il doit être déclaré AVANT planConfigSchema.
const planEntrySchema = new mongoose.Schema(
  {
    label:           { type: String, default: '' },
    scansPerMonth:   { type: Number, required: true },
    /** 0 = pas d'employés, -1 = illimité, >0 = limite numérique. */
    maxEmployees:    { type: Number, default: 0 },
    // Prix mensuel de base par pays (FCFA). Clé = code pays (SN, ML, CI, ...).
    prices:          { type: Map, of: Number, default: () => new Map() },
    pendingDecrease: { type: pendingDecreaseSchema, default: null },
    features:        { type: featuresSchema, default: () => ({}) },
  },
  { _id: false }
);

const packSchema = new mongoose.Schema(
  {
    code:   { type: String, required: true },
    scans:  { type: Number, required: true },
    prices: { type: Map, of: Number, default: () => new Map() },
  },
  { _id: false }
);

const planConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },

    pro:     { type: planEntrySchema, required: true },
    premium: { type: planEntrySchema, required: true },

    trial: {
      days:  { type: Number, default: 14 },
      scans: { type: Number, default: 100 },
    },

    packs: { type: [packSchema], default: [] },

    // Remises : stockées comme multiplicateurs appliqués au prix mensuel de base.
    discounts: {
      monthlyMultiplier:    { type: Number, default: 1 },
      quarterlyMultiplier:  { type: Number, default: 2.7 },   // 3 × 0.9
      semiannualMultiplier: { type: Number, default: 5 },     // 5 mois payés pour 6
      annualMultiplier:     { type: Number, default: 10 },    // 10 mois payés pour 12
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', default: null },
  },
  { timestamps: true }
);

/**
 * Retourne le quota effectif en scans/mois pour un plan donné,
 * en tenant compte du garde-fou : les baisses ne s'appliquent
 * qu'à partir de leur effectiveFrom.
 */
planConfigSchema.methods.getEffectiveScans = function (planKey) {
  const entry = this[planKey];
  if (!entry) return 0;
  const pending = entry.pendingDecrease;
  if (pending && new Date() >= pending.effectiveFrom) {
    return pending.value;
  }
  return entry.scansPerMonth;
};

/**
 * Calcule le prix total en FCFA pour un plan/pays/période.
 */
planConfigSchema.methods.computePrice = function (planKey, country, period) {
  const entry = this[planKey];
  if (!entry) return 0;
  const tier = getCountryTier(country);
  const base = entry.prices?.get(String(tier)) ?? entry.prices?.get('1') ?? 0;
  const d = this.discounts;
  switch (period) {
    case 'monthly':    return Math.round(base * d.monthlyMultiplier);
    case 'quarterly':  return Math.round(base * d.quarterlyMultiplier);
    case 'semiannual': return Math.round(base * d.semiannualMultiplier);
    case 'annual':     return Math.round(base * d.annualMultiplier);
    default:           return 0;
  }
};

module.exports = mongoose.model('PlanConfig', planConfigSchema);
module.exports.FEATURE_KEYS = FEATURE_KEYS;