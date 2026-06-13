'use strict';

const mongoose = require('mongoose');
const Merchant = require('../models/Merchant');
const ParsingEvent = require('../models/ParsingEvent');
const Subscription = require('../models/Subscription');
const THRESHOLDS = require('../constants/alertThresholds');
const { toMonthlyFcfa } = require('./subscriptionService');

// ─── Helpers date ──────────────────────────────────────────────────────────────

/**
 * Convertit ?range=7d|30d|pilot en date de début.
 * 'pilot' = depuis l'origine (1er janvier 2024).
 */
function parseDateRange(range) {
  const now = new Date();
  if (range === '7d')   return new Date(now.getTime() - 7  * 86400_000);
  if (range === '30d')  return new Date(now.getTime() - 30 * 86400_000);
  if (range === 'pilot') return new Date('2024-01-01T00:00:00Z');
  // défaut 30j
  return new Date(now.getTime() - 30 * 86400_000);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Statistiques boutiques ────────────────────────────────────────────────────

async function getShopCounts() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
  const [active, suspended] = await Promise.all([
    Merchant.countDocuments({ isActive: true,  role: { $ne: 'superadmin' } }),
    Merchant.countDocuments({ isActive: false, role: { $ne: 'superadmin' } }),
  ]);

  const [trial, paying] = await Promise.all([
    Subscription.countDocuments({ status: 'trial',  endDate: { $gt: new Date() } }),
    Subscription.countDocuments({ status: 'active', endDate: { $gt: new Date() } }),
  ]);

  // Dormant = actif mais aucun message reçu depuis 30j
  const dormant = await Merchant.countDocuments({
    isActive: true,
    role: { $ne: 'superadmin' },
    $or: [
      { lastInboundAt: { $lt: thirtyDaysAgo } },
      { lastInboundAt: { $exists: false } },
    ],
  });

  return { active, trial, paying, dormant, suspended };
}

// ─── MRR ──────────────────────────────────────────────────────────────────────

async function getMRR() {
  const subs = await Subscription.find({
    status: 'active',
    endDate: { $gt: new Date() },
  }).lean();

  let total = 0, bySN = 0, byML = 0;
  for (const sub of subs) {
    const monthly = toMonthlyFcfa(sub);
    total += monthly;
    if (sub.country === 'SN') bySN += monthly;
    if (sub.country === 'ML') byML += monthly;
  }
  return { total, bySN, byML };
}

// ─── Stats parsing ─────────────────────────────────────────────────────────────

async function getParsed24h() {
  const since = new Date(Date.now() - 86400_000);
  return ParsingEvent.countDocuments({ createdAt: { $gte: since } });
}

async function getParsedPerShop(since) {
  const [total, shopCount] = await Promise.all([
    ParsingEvent.countDocuments({ createdAt: { $gte: since } }),
    Merchant.countDocuments({ isActive: true, role: { $ne: 'superadmin' } }),
  ]);
  return shopCount > 0 ? Math.round(total / shopCount) : 0;
}

async function getHaikuCostToday() {
  const result = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: startOfToday() }, haikuAttempted: true } },
    { $group: { _id: null, totalUsd: { $sum: '$costUsd' } } },
  ]);
  return result[0]?.totalUsd || 0;
}

async function getHaikuCostMonthProjected() {
  const monthStart = startOfMonth();
  const now = new Date();
  const result = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: monthStart }, haikuAttempted: true } },
    { $group: { _id: null, totalUsd: { $sum: '$costUsd' } } },
  ]);

  const costSoFar = result[0]?.totalUsd || 0;
  const daysElapsed = Math.max(1, (now - monthStart) / 86400_000);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (costSoFar / daysElapsed) * daysInMonth;
}

// ─── Série d'activité (parsings par jour) ─────────────────────────────────────

async function getActivitySeries(since) {
  const rows = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: '$_id', count: 1 } },
  ]);
  return rows;
}

// ─── Alertes ──────────────────────────────────────────────────────────────────

async function getAlerts() {
  const alerts = [];
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  const { usdToFcfa, haikuCallsPerShopDay, haikuEscalationPct24h, haikuDailyBudgetFcfa,
          trialExpiryWarningDays, trialExpiryDangerDays } = THRESHOLDS;

  // 1. Boutiques avec trop d'appels Haiku aujourd'hui
  const highHaikuShops = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: startOfToday() }, haikuAttempted: true } },
    { $group: { _id: '$merchantId', slug: { $first: '$boutiqueSlug' }, count: { $sum: 1 } } },
    { $match: { count: { $gte: haikuCallsPerShopDay } } },
  ]);
  for (const s of highHaikuShops) {
    alerts.push({
      level: 'danger',
      type: 'haiku_calls_high',
      message: `Boutique "${s.slug}" : ${s.count} appels Haiku aujourd'hui (seuil ${haikuCallsPerShopDay})`,
      ref: s._id?.toString(),
    });
  }

  // 2. Taux d'escalade Haiku global sur 24h
  const [totalEvents, haikuEvents] = await Promise.all([
    ParsingEvent.countDocuments({ createdAt: { $gte: yesterday } }),
    ParsingEvent.countDocuments({ createdAt: { $gte: yesterday }, haikuAttempted: true }),
  ]);
  if (totalEvents > 0) {
    const pct = (haikuEvents / totalEvents) * 100;
    if (pct >= haikuEscalationPct24h) {
      alerts.push({
        level: 'warning',
        type: 'haiku_escalation_high',
        message: `Escalade Haiku à ${pct.toFixed(1)} % sur 24h (seuil ${haikuEscalationPct24h} %)`,
        ref: null,
      });
    }
  }

  // 3. Budget Haiku journalier (FCFA)
  const costTodayUsd = await getHaikuCostToday();
  const costTodayFcfa = costTodayUsd * usdToFcfa;
  if (costTodayFcfa >= haikuDailyBudgetFcfa) {
    alerts.push({
      level: 'danger',
      type: 'haiku_budget_exceeded',
      message: `Coût Haiku du jour : ${Math.round(costTodayFcfa)} FCFA (budget ${haikuDailyBudgetFcfa} FCFA)`,
      ref: null,
    });
  }

  // 4. Paiements échoués (past_due)
  const failedSubs = await Subscription.find({ status: 'past_due' })
    .populate('merchantId', 'slug businessName')
    .lean();
  for (const sub of failedSubs) {
    alerts.push({
      level: 'danger',
      type: 'payment_failed',
      message: `Paiement échoué : ${sub.merchantId?.businessName || sub.merchantId} (${sub.merchantId?.slug})`,
      ref: sub._id?.toString(),
    });
  }

  // 5. Essais expirant bientôt
  const warningDate = new Date(now.getTime() + trialExpiryWarningDays * 86400_000);
  const dangerDate  = new Date(now.getTime() + trialExpiryDangerDays  * 86400_000);

  const expiringSubs = await Subscription.find({
    status: 'trial',
    endDate: { $gt: now, $lt: warningDate },
  })
    .populate('merchantId', 'slug businessName')
    .lean();

  for (const sub of expiringSubs) {
    const daysLeft = Math.ceil((sub.endDate - now) / 86400_000);
    alerts.push({
      level: sub.endDate < dangerDate ? 'danger' : 'warning',
      type: 'trial_expiring',
      message: `Essai de "${sub.merchantId?.slug}" expire dans ${daysLeft} j`,
      ref: sub._id?.toString(),
    });
  }

  return alerts;
}

// ─── Funnel de parsing ────────────────────────────────────────────────────────

async function getParsingFunnel(since) {
  const [byTier, haikuTokens] = await Promise.all([
    ParsingEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$tierResolved', count: { $sum: 1 } } },
    ]),
    ParsingEvent.aggregate([
      { $match: { createdAt: { $gte: since }, haikuAttempted: true } },
      {
        $group: {
          _id: '$merchantId',
          tokens: { $sum: { $add: ['$haikuInputTokens', '$haikuOutputTokens'] } },
        },
      },
      { $group: { _id: null, avg: { $avg: '$tokens' }, values: { $push: '$tokens' } } },
    ]),
  ]);

  const tierMap = {};
  let total = 0;
  for (const r of byTier) { tierMap[r._id] = r.count; total += r.count; }
  const pct = (key) => total > 0 ? Math.round((tierMap[key] || 0) / total * 100) : 0;

  // Médiane des tokens Haiku par boutique
  const values = (haikuTokens[0]?.values || []).sort((a, b) => a - b);
  const median = values.length > 0 ? values[Math.floor(values.length / 2)] : 0;

  // Série de coût quotidien en FCFA
  const costRows = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: since }, haikuAttempted: true } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        usd: { $sum: '$costUsd' },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: '$_id', fcfa: { $round: [{ $multiply: ['$usd', THRESHOLDS.usdToFcfa] }, 0] } } },
  ]);

  const costMonthTotal = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: startOfMonth() }, haikuAttempted: true } },
    { $group: { _id: null, usd: { $sum: '$costUsd' } } },
  ]);

  return {
    pctRegexOnly:          pct('regex'),
    pctEscalateCloudflare: pct('cloudflare'),
    pctEscalateHaiku:      pct('haiku'),
    pctFailed:             pct('failed'),
    haikuTokensPerShopAvg:    Math.round(haikuTokens[0]?.avg || 0),
    haikuTokensPerShopMedian: median,
    costSeries:     costRows,
    costMonthTotal: Math.round((costMonthTotal[0]?.usd || 0) * THRESHOLDS.usdToFcfa),
  };
}

// ─── Top boutiques par conso Haiku ────────────────────────────────────────────

async function getTopShopsByHaiku(since) {
  const rows = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$merchantId',
        slug:        { $first: '$boutiqueSlug' },
        haikuCalls:  { $sum: { $cond: ['$haikuAttempted', 1, 0] } },
        tokens:      { $sum: { $add: ['$haikuInputTokens', '$haikuOutputTokens'] } },
        costUsd:     { $sum: '$costUsd' },
        totalEvents: { $sum: 1 },
      },
    },
    { $sort: { costUsd: -1 } },
    { $limit: 30 },
  ]);

  // Enrichissement avec le nom et le pays depuis Merchant
  const merchantIds = rows.map((r) => r._id).filter(Boolean);
  const merchants = await Merchant.find({ _id: { $in: merchantIds } })
    .select('slug businessName whatsappPhone')
    .lean();
  const mMap = Object.fromEntries(merchants.map((m) => [m._id.toString(), m]));

  const { detectCountryFromPhone } = require('../constants/pricingGrid');
  const { usdToFcfa } = THRESHOLDS;

  return rows.map((r) => {
    const m = mMap[r._id?.toString()] || {};
    const country = detectCountryFromPhone(m.whatsappPhone || '');
    const escalatePct = r.totalEvents > 0 ? Math.round(r.haikuCalls / r.totalEvents * 100) : 0;
    return {
      slug:        r.slug || m.slug,
      name:        m.businessName || r.slug,
      country,
      haikuCalls:  r.haikuCalls,
      tokens:      r.tokens,
      escalatePct,
      costFcfa:    Math.round(r.costUsd * usdToFcfa),
      anomaly:     escalatePct > THRESHOLDS.haikuEscalationPct24h,
    };
  });
}

module.exports = {
  parseDateRange,
  startOfToday,
  getShopCounts,
  getMRR,
  getParsed24h,
  getParsedPerShop,
  getHaikuCostToday,
  getHaikuCostMonthProjected,
  getActivitySeries,
  getAlerts,
  getParsingFunnel,
  getTopShopsByHaiku,
};
