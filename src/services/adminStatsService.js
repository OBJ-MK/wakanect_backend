'use strict';

const mongoose = require('mongoose');
const Merchant = require('../models/Merchant');
const ParsingEvent = require('../models/ParsingEvent');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const THRESHOLDS = require('../constants/alertThresholds');
const { toMonthlyFcfa } = require('./subscriptionService');

// ─── Helpers date ──────────────────────────────────────────────────────────────

const AdminSettings = require('../models/AdminSettings');

/**
 * Convertit ?range=7d|30d|pilot en { since, until }.
 * 'pilot' = dates configurées via /api/admin/settings/pilot (Vue d'ensemble →
 * réglages). Si non configuré, on retombe sur le comportement précédent
 * (depuis l'origine du projet) pour ne rien casser tant que Modibo n'a pas
 * encore renseigné de dates. pilotEndDate absent = pilote toujours en cours
 * (until = maintenant).
 */
async function parseDateRange(range) {
  const now = new Date();
  if (range === '7d')  return { since: new Date(now.getTime() - 7  * 86400_000), until: now };
  if (range === '30d') return { since: new Date(now.getTime() - 30 * 86400_000), until: now };
  if (range === 'pilot') {
    const settings = await AdminSettings.findOne({ key: 'pilot' }).lean();
    return {
      since: settings?.pilotStartDate || new Date('2024-01-01T00:00:00Z'),
      until: settings?.pilotEndDate || now,
    };
  }
  // défaut 30j
  return { since: new Date(now.getTime() - 30 * 86400_000), until: now };
}

// Fragment de $match Mongo pour un champ date, avec borne haute optionnelle
// (le pilote peut être terminé — sinon `until` vaut "maintenant", donc ce
// fragment se comporte comme un simple $gte pour 7d/30d).
function dateRangeMatch(field, since, until) {
  return { [field]: { $gte: since, ...(until ? { $lte: until } : {}) } };
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

// ─── Revenu total encaissé ────────────────────────────────────────────────────

/**
 * Somme des paiements CONFIRMÉS (status:'completed'), 1 doc = 1 transaction.
 * ≠ MRR (équivalent mensuel des abonnements actifs).
 */
async function getRevenueTotal() {
  const result = await Payment.aggregate([
    { $match: { status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return result[0]?.total || 0;
}

// ─── Stats parsing ─────────────────────────────────────────────────────────────

async function getParsed24h() {
  const since = new Date(Date.now() - 86400_000);
  return ParsingEvent.countDocuments({ createdAt: { $gte: since } });
}

async function getParsedPerShop(since, until) {
  const [total, shopCount] = await Promise.all([
    ParsingEvent.countDocuments(dateRangeMatch('createdAt', since, until)),
    Merchant.countDocuments({ isActive: true, role: { $ne: 'superadmin' } }),
  ]);
  return shopCount > 0 ? Math.round(total / shopCount) : 0;
}

async function getDeepseekCostToday() {
  const result = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: startOfToday() }, deepseekAttempted: true } },
    { $group: { _id: null, totalUsd: { $sum: '$costUsd' } } },
  ]);
  return result[0]?.totalUsd || 0;
}

async function getDeepseekCostMonthProjected() {
  const monthStart = startOfMonth();
  const now = new Date();
  const result = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: monthStart }, deepseekAttempted: true } },
    { $group: { _id: null, totalUsd: { $sum: '$costUsd' } } },
  ]);

  const costSoFar = result[0]?.totalUsd || 0;
  const daysElapsed = Math.max(1, (now - monthStart) / 86400_000);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (costSoFar / daysElapsed) * daysInMonth;
}

// ─── Série d'activité (parsings par jour) ─────────────────────────────────────

async function getActivitySeries(since, until) {
  const rows = await ParsingEvent.aggregate([
    { $match: dateRangeMatch('createdAt', since, until) },
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
  const { usdToFcfa, deepseekCallsPerShopDay, deepseekEscalationPct24h, deepseekDailyBudgetFcfa,
          trialExpiryWarningDays, trialExpiryDangerDays } = THRESHOLDS;

  // 1. Boutiques avec trop d'appels DeepSeek aujourd'hui
  const highDeepseekShops = await ParsingEvent.aggregate([
    { $match: { createdAt: { $gte: startOfToday() }, deepseekAttempted: true } },
    { $group: { _id: '$merchantId', slug: { $first: '$boutiqueSlug' }, count: { $sum: 1 } } },
    { $match: { count: { $gte: deepseekCallsPerShopDay } } },
  ]);
  for (const s of highDeepseekShops) {
    alerts.push({
      level: 'danger',
      type: 'deepseek_calls_high',
      message: `Boutique "${s.slug}" : ${s.count} appels DeepSeek aujourd'hui (seuil ${deepseekCallsPerShopDay})`,
      ref: s._id?.toString(),
    });
  }

  // 2. Taux d'escalade DeepSeek global sur 24h
  const [totalEvents, deepseekEvents] = await Promise.all([
    ParsingEvent.countDocuments({ createdAt: { $gte: yesterday } }),
    ParsingEvent.countDocuments({ createdAt: { $gte: yesterday }, deepseekAttempted: true }),
  ]);
  if (totalEvents > 0) {
    const pct = (deepseekEvents / totalEvents) * 100;
    if (pct >= deepseekEscalationPct24h) {
      alerts.push({
        level: 'warning',
        type: 'deepseek_escalation_high',
        message: `Escalade DeepSeek à ${pct.toFixed(1)} % sur 24h (seuil ${deepseekEscalationPct24h} %)`,
        ref: null,
      });
    }
  }

  // 3. Budget DeepSeek journalier (FCFA)
  const costTodayUsd = await getDeepseekCostToday();
  const costTodayFcfa = costTodayUsd * usdToFcfa;
  if (costTodayFcfa >= deepseekDailyBudgetFcfa) {
    alerts.push({
      level: 'danger',
      type: 'deepseek_budget_exceeded',
      message: `Coût DeepSeek du jour : ${Math.round(costTodayFcfa)} FCFA (budget ${deepseekDailyBudgetFcfa} FCFA)`,
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

async function getParsingFunnel(since, until) {
  const [byTier, deepseekTokens] = await Promise.all([
    ParsingEvent.aggregate([
      { $match: dateRangeMatch('createdAt', since, until) },
      { $group: { _id: '$tierResolved', count: { $sum: 1 } } },
    ]),
    ParsingEvent.aggregate([
      { $match: { ...dateRangeMatch('createdAt', since, until), deepseekAttempted: true } },
      {
        $group: {
          _id: '$merchantId',
          tokens: { $sum: { $add: ['$deepseekInputTokens', '$deepseekOutputTokens'] } },
        },
      },
      { $group: { _id: null, avg: { $avg: '$tokens' }, values: { $push: '$tokens' } } },
    ]),
  ]);

  const tierMap = {};
  let total = 0;
  for (const r of byTier) { tierMap[r._id] = r.count; total += r.count; }
  const pct = (key) => total > 0 ? Math.round((tierMap[key] || 0) / total * 100) : 0;

  // Médiane des tokens DeepSeek par boutique
  const values = (deepseekTokens[0]?.values || []).sort((a, b) => a - b);
  const median = values.length > 0 ? values[Math.floor(values.length / 2)] : 0;

  // Série de coût quotidien en FCFA — DeepSeek, seule IA de parsing payante en prod
  const costRows = await ParsingEvent.aggregate([
    { $match: { ...dateRangeMatch('createdAt', since, until), deepseekAttempted: true } },
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
    { $match: { createdAt: { $gte: startOfMonth() }, deepseekAttempted: true } },
    { $group: { _id: null, usd: { $sum: '$costUsd' } } },
  ]);

  const deepseekCount = (tierMap['deepseek_correction'] || 0) + (tierMap['deepseek_full'] || 0);
  const pctDeepseek = total > 0 ? Math.round(deepseekCount / total * 100) : 0;

  return {
    pctRegexOnly:          pct('regex'),
    pctEscalateCloudflare: pct('cloudflare'),
    pctEscalateDeepseek:   pctDeepseek,
    pctEscalateHaiku:      pct('haiku'),
    pctFailed:             pct('failed'),
    deepseekTokensPerShopAvg:    Math.round(deepseekTokens[0]?.avg || 0),
    deepseekTokensPerShopMedian: median,
    costSeries:     costRows,
    costMonthTotal: Math.round((costMonthTotal[0]?.usd || 0) * THRESHOLDS.usdToFcfa),
  };
}

// ─── Top boutiques par conso Haiku ────────────────────────────────────────────

async function getTopShopsByDeepseek(since, until) {
  const rows = await ParsingEvent.aggregate([
    { $match: dateRangeMatch('createdAt', since, until) },
    {
      $group: {
        _id: '$merchantId',
        slug:          { $first: '$boutiqueSlug' },
        deepseekCalls: { $sum: { $cond: ['$deepseekAttempted', 1, 0] } },
        tokens:        { $sum: { $add: ['$deepseekInputTokens', '$deepseekOutputTokens'] } },
        costUsd:       { $sum: '$costUsd' },
        totalEvents:   { $sum: 1 },
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
    const escalatePct = r.totalEvents > 0 ? Math.round(r.deepseekCalls / r.totalEvents * 100) : 0;
    return {
      slug:          r.slug || m.slug,
      name:          m.businessName || r.slug,
      country,
      deepseekCalls: r.deepseekCalls,
      tokens:        r.tokens,
      escalatePct,
      costFcfa:      Math.round(r.costUsd * usdToFcfa),
      anomaly:       escalatePct > THRESHOLDS.deepseekEscalationPct24h,
    };
  });
}

module.exports = {
  parseDateRange,
  dateRangeMatch,
  startOfToday,
  getShopCounts,
  getMRR,
  getRevenueTotal,
  getParsed24h,
  getParsedPerShop,
  getDeepseekCostToday,
  getDeepseekCostMonthProjected,
  getActivitySeries,
  getAlerts,
  getParsingFunnel,
  getTopShopsByDeepseek,
};