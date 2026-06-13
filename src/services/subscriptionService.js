'use strict';

const Subscription = require('../models/Subscription');
const { getPriceFcfa, detectCountryFromPhone, PERIOD_MONTHS } = require('../constants/pricingGrid');

/**
 * Retourne true si le commerçant a un abonnement actif (essai valide ou payant).
 * À appeler sur les routes qui nécessitent un abonnement actif (paywall).
 */
async function isSubscriptionActive(merchantId) {
  const sub = await Subscription.findOne({ merchantId })
    .sort({ createdAt: -1 })
    .lean();

  if (!sub) return false;

  const now = new Date();
  if (sub.status === 'trial' && sub.endDate > now) return true;
  if (sub.status === 'active' && sub.endDate > now) return true;
  return false;
}

/**
 * Crée ou renouvelle un abonnement pour un commerçant.
 * Déduit le pays depuis whatsappPhone, snapshot le prix depuis la grille.
 */
async function createOrRenewSubscription(merchant, plan, period, paydunyaRef = null) {
  const country = detectCountryFromPhone(merchant.whatsappPhone);
  const amountFcfa = getPriceFcfa(country, plan, period);
  const startDate = new Date();
  const endDate = addMonths(startDate, PERIOD_MONTHS[period] || 1);
  const status = period === 'trial' ? 'trial' : 'active';

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

  // Synchronise le miroir dénormalisé sur Merchant
  await merchant.constructor.findByIdAndUpdate(merchant._id, { plan });

  return sub;
}

/**
 * Crée un essai gratuit 14 jours pour un nouveau commerçant.
 */
async function createFreeTrial(merchant) {
  const country = detectCountryFromPhone(merchant.whatsappPhone);
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + 14 * 24 * 3600 * 1000);

  return Subscription.create({
    merchantId: merchant._id,
    plan: 'free',
    period: 'trial',
    country,
    startDate,
    endDate,
    status: 'trial',
    amountFcfa: 0,
  });
}

/**
 * Retourne la subscription active la plus récente pour un merchant, ou null.
 */
async function getActiveSubscription(merchantId) {
  return Subscription.findOne({
    merchantId,
    status: { $in: ['trial', 'active'] },
    endDate: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Montant mensuel équivalent en FCFA (pour calcul MRR).
 */
function toMonthlyFcfa(sub) {
  const months = PERIOD_MONTHS[sub.period] || 1;
  if (months === 0) return 0;
  return Math.round(sub.amountFcfa / months);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

module.exports = {
  isSubscriptionActive,
  createOrRenewSubscription,
  createFreeTrial,
  getActiveSubscription,
  toMonthlyFcfa,
};
