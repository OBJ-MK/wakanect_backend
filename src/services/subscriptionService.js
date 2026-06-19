'use strict';

const Subscription = require('../models/Subscription');
const Merchant     = require('../models/Merchant');
const PlanConfig   = require('../models/PlanConfig');
const { detectCountryFromPhone, PERIOD_MONTHS } = require('../constants/pricingGrid');

const GRACE_MS = 48 * 3600 * 1000;

// ─── Cache en mémoire de la PlanConfig (TTL 60s) ──────────────────────────────
// Évite un aller-retour Mongo à chaque scan entrant.
let _planConfigCache = null;
let _planConfigCachedAt = 0;
const PLAN_CONFIG_TTL = 60_000;

async function getPlanConfig() {
  if (_planConfigCache && Date.now() - _planConfigCachedAt < PLAN_CONFIG_TTL) {
    return _planConfigCache;
  }
  _planConfigCache    = await PlanConfig.findOne({ key: 'main' });
  _planConfigCachedAt = Date.now();
  return _planConfigCache;
}

/** Invalide le cache lors d'une modification admin. */
function invalidatePlanConfigCache() {
  _planConfigCache    = null;
  _planConfigCachedAt = 0;
}

// ─── Abonnement actif ─────────────────────────────────────────────────────────

/**
 * Retourne true si le commerçant a un abonnement valide OU dans la grâce de 48h.
 */
async function isSubscriptionActive(merchantId) {
  const sub = await Subscription.findOne({ merchantId })
    .sort({ createdAt: -1 })
    .lean();

  if (!sub) return false;
  return Date.now() <= new Date(sub.endDate).getTime() + GRACE_MS;
}

/**
 * Retourne l'abonnement actif le plus récent (sans grâce — strict).
 */
async function getActiveSubscription(merchantId) {
  return Subscription.findOne({
    merchantId,
    status:  { $in: ['trial', 'active'] },
    endDate: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
}

// ─── Création / renouvellement ────────────────────────────────────────────────

/**
 * Calcule le montant depuis PlanConfig (base de vérité en BD),
 * avec fallback sur pricingGrid si PlanConfig absente.
 */
async function computeAmountFcfa(country, plan, period) {
  if (plan === 'free' || period === 'trial') return 0;

  const cfg = await getPlanConfig();
  if (cfg) {
    return cfg.computePrice(plan, country, period);
  }

  // Fallback legacy (pricingGrid constants)
  const { getPriceFcfa } = require('../constants/pricingGrid');
  return getPriceFcfa(country, plan, period);
}

/**
 * Crée ou renouvelle un abonnement.
 * Le prix est calculé depuis PlanConfig (pas snapshoté depuis une constante).
 */
async function createOrRenewSubscription(merchant, plan, period, paydunyaRef = null) {
  const country    = detectCountryFromPhone(merchant.whatsappPhone);
  const amountFcfa = await computeAmountFcfa(country, plan, period);
  const startDate  = new Date();
  const endDate    = addMonths(startDate, PERIOD_MONTHS[period] || 1);
  const status     = period === 'trial' ? 'trial' : 'active';

  const sub = await Subscription.create({
    merchantId: merchant._id,
    plan,
    period,
    country,
    startDate,
    endDate,
    status,
    amountFcfa,
    paydunyaRef,
  });

  await merchant.constructor.findByIdAndUpdate(merchant._id, { plan });

  return sub;
}

/**
 * Crée un essai gratuit pour un nouveau commerçant.
 * La durée et le quota trial viennent de PlanConfig si disponible.
 */
async function createFreeTrial(merchant) {
  const country   = detectCountryFromPhone(merchant.whatsappPhone);
  const cfg       = await getPlanConfig();
  const trialDays = cfg?.trial?.days ?? 14;
  const startDate = new Date();
  const endDate   = new Date(startDate.getTime() + trialDays * 24 * 3600 * 1000);

  return Subscription.create({
    merchantId: merchant._id,
    plan:       'free',
    period:     'trial',
    country,
    startDate,
    endDate,
    status:     'trial',
    amountFcfa: 0,
  });
}

// ─── Quota scans ──────────────────────────────────────────────────────────────

/**
 * Retourne le quota effectif de scans/mois pour un commerçant.
 *   = PlanConfig[plan].scansPerMonth (tenant compte du garde-fou)
 *   + scans des packs actifs achetés sur l'abonnement courant
 *
 * Si PlanConfig absente → 0 (bloquant : log l'erreur, à corriger).
 */
async function getEffectiveQuota(merchantId) {
  const [cfg, sub, merchant] = await Promise.all([
    getPlanConfig(),
    Subscription.findOne({ merchantId }).sort({ createdAt: -1 }).lean(),
    Merchant.findById(merchantId).select('plan').lean(),
  ]);

  if (!cfg) {
    console.error('[subscriptionService] PlanConfig introuvable — quota = 0');
    return 0;
  }

  const planKey      = merchant?.plan || 'free';
  const baseQuota    = cfg.getEffectiveScans(planKey);

  // Additionner les packs achetés sur l'abonnement courant
  const packCodes    = sub?.purchasedPackCodes || [];
  const packsQuota   = packCodes.reduce((sum, code) => {
    const pack = cfg.packs.find((p) => p.code === code);
    return sum + (pack?.scans || 0);
  }, 0);

  return baseQuota + packsQuota;
}

/**
 * Vérifie le quota mensuel puis incrémente le compteur si OK.
 * Retourne { allowed: true } ou { allowed: false, quota, used }.
 *
 * Réinitialise automatiquement le compteur si on est dans un nouveau mois.
 */
async function checkAndIncrementScan(merchantId) {
  const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

  // Lecture atomique : si nouveau mois le compteur est remis à 0 dans incrementScanCount
  const merchant = await Merchant.findById(merchantId)
    .select('plan usage')
    .lean();

  if (!merchant) return { allowed: false, quota: 0, used: 0 };

  const usedRaw = merchant.usage?.scansMonth === currentMonth
    ? (merchant.usage?.scansCurrentMonth || 0)
    : 0;

  const quota = await getEffectiveQuota(merchantId);

  // Plan 'free' sans abonnement actif → 0 quota (essai = géré via trial.scans dans le futur)
  if (quota === 0) {
    return { allowed: false, quota: 0, used: usedRaw };
  }

  if (usedRaw >= quota) {
    return { allowed: false, quota, used: usedRaw };
  }

  // Incrémentation atomique avec reset si nouveau mois
  await Merchant.findByIdAndUpdate(merchantId, [
    {
      $set: {
        'usage.scansCurrentMonth': {
          $cond: {
            if:   { $eq: ['$usage.scansMonth', currentMonth] },
            then: { $add: ['$usage.scansCurrentMonth', 1] },
            else: 1,
          },
        },
        'usage.scansMonth': currentMonth,
      },
    },
  ], { updatePipeline: true });

  return { allowed: true, quota, used: usedRaw + 1 };
}

// ─── Limites de plan ─────────────────────────────────────────────────────────

/**
 * Retourne les limites et features du plan effectif d'un commerçant.
 *   - Pendant l'essai (trial) → limites Premium (accès complet, comme promis dans le trial).
 *   - Plan free ou sans abonnement actif → max_employees=0, features toutes à false.
 *
 * @returns {{ effective_plan: string, max_employees: number, features: object }}
 */
async function getPlanLimits(merchantId) {
  const [cfg, sub, merchant] = await Promise.all([
    getPlanConfig(),
    getActiveSubscription(merchantId),
    Merchant.findById(merchantId).select('plan').lean(),
  ]);

  if (!cfg) {
    return {
      effective_plan: 'free',
      max_employees:  0,
      features:       { advanced_stats: false, unlimited_catalog: false, priority_support: false },
    };
  }

  const storedPlan   = merchant?.plan || 'free';
  const isTrial      = sub?.status === 'trial';

  // Le trial donne accès aux limites Premium (toutes les features débloquées).
  const effectiveKey = isTrial ? 'premium' : storedPlan;

  if (effectiveKey === 'free' || !cfg[effectiveKey]) {
    return {
      effective_plan: 'free',
      max_employees:  0,
      features:       { advanced_stats: false, unlimited_catalog: false, priority_support: false },
    };
  }

  const entry = cfg[effectiveKey];
  return {
    effective_plan: effectiveKey,
    max_employees:  entry.maxEmployees ?? 0,
    features: {
      advanced_stats:    !!(entry.features?.advanced_stats),
      unlimited_catalog: !!(entry.features?.unlimited_catalog),
      priority_support:  !!(entry.features?.priority_support),
    },
  };
}

// ─── MRR ─────────────────────────────────────────────────────────────────────

function toMonthlyFcfa(sub) {
  const months = PERIOD_MONTHS[sub.period] || 1;
  if (months === 0) return 0;
  return Math.round(sub.amountFcfa / months);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

module.exports = {
  isSubscriptionActive,
  getActiveSubscription,
  createOrRenewSubscription,
  createFreeTrial,
  getEffectiveQuota,
  checkAndIncrementScan,
  toMonthlyFcfa,
  invalidatePlanConfigCache,
  getPlanLimits,
};
