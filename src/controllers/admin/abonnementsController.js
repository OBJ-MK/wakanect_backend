'use strict';

const Subscription = require('../../models/Subscription');
const Merchant = require('../../models/Merchant');
const { parseDateRange } = require('../../services/adminStatsService');
const { getMRR } = require('../../services/adminStatsService');
const { toMonthlyFcfa } = require('../../services/subscriptionService');
const THRESHOLDS = require('../../constants/alertThresholds');

/**
 * GET /api/admin/abonnements?range=
 */
const getAbonnements = async (req, res) => {
  try {
    const since = parseDateRange(req.query.range);
    const now = new Date();
    const warningDate = new Date(now.getTime() + 7 * 86400_000); // expiration dans 7j

    const [mrrData, trials, expiringSoon, paymentsFailed, allActiveSubs, newSubsInRange, totalMerchants] =
      await Promise.all([
        getMRR(),
        Subscription.countDocuments({ status: 'trial',    endDate: { $gt: now } }),
        Subscription.countDocuments({ status: 'trial',    endDate: { $gt: now, $lt: warningDate } }),
        Subscription.countDocuments({ status: 'past_due' }),
        // Toutes les subs actives pour la liste
        Subscription.find({ status: { $in: ['trial', 'active', 'past_due'] } })
          .sort({ createdAt: -1 })
          .lean(),
        // Nouvelles subs créées dans la période (pour taux de conversion)
        Subscription.countDocuments({ createdAt: { $gte: since }, status: { $ne: 'canceled' } }),
        Merchant.countDocuments({ role: { $ne: 'superadmin' } }),
      ]);

    // Taux de conversion : boutiques avec sub active / total boutiques
    const payingCount = await Subscription.countDocuments({ status: 'active', endDate: { $gt: now } });
    const conversionPct = totalMerchants > 0 ? Math.round(payingCount / totalMerchants * 100) : 0;

    // Enrichissement avec le nom du commerçant
    const merchantIds = [...new Set(allActiveSubs.map((s) => s.merchantId.toString()))];
    const merchants = await Merchant.find({ _id: { $in: merchantIds } })
      .select('slug businessName')
      .lean();
    const mMap = Object.fromEntries(merchants.map((m) => [m._id.toString(), m]));

    const rows = allActiveSubs.map((sub) => {
      const m = mMap[sub.merchantId.toString()] || {};
      return {
        slug:          m.slug || '',
        name:          m.businessName || '',
        plan:          sub.plan,
        period:        sub.period,
        country:       sub.country,
        paymentStatus: sub.status,
        renewal:       sub.endDate,
        amountFcfa:    sub.amountFcfa,
        mrrContrib:    toMonthlyFcfa(sub),
      };
    });

    res.json({
      mrr:            mrrData.total,
      mrrByCountry:   { SN: mrrData.bySN, ML: mrrData.byML },
      trials,
      expiringSoon,
      paymentsFailed,
      conversionPct,
      rows,
    });
  } catch (err) {
    console.error('[admin:abonnements]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAbonnements };
