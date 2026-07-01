'use strict';

const Subscription = require('../../models/Subscription');
const Merchant = require('../../models/Merchant');
const { parseDateRange, getMRR, getRevenueTotal } = require('../../services/adminStatsService');
const { toMonthlyFcfa } = require('../../services/subscriptionService');

// EC-09: paymentStatus FR depuis sub.status
const SUB_PAYMENT_FR = {
  trial:    'En attente',
  active:   'Payé',
  past_due: 'Impayé',
  canceled: 'Impayé',
};

/**
 * GET /api/admin/abonnements?range=
 */
const getAbonnements = async (req, res) => {
  try {
    const since = parseDateRange(req.query.range);
    const now = new Date();
    const warningDate = new Date(now.getTime() + 7 * 86400_000);

    const [mrrData, revenueTotal, trials, expiringSoon, paymentsFailed, allActiveSubs, totalMerchants] =
      await Promise.all([
        getMRR(),
        getRevenueTotal(),
        Subscription.countDocuments({ status: 'trial',    endDate: { $gt: now } }),
        Subscription.countDocuments({ status: 'trial',    endDate: { $gt: now, $lt: warningDate } }),
        Subscription.countDocuments({ status: 'past_due' }),
        Subscription.find({ status: { $in: ['trial', 'active', 'past_due'] } })
          .sort({ createdAt: -1 })
          .lean(),
        Merchant.countDocuments({ role: { $ne: 'superadmin' } }),
      ]);

    const payingCount = await Subscription.countDocuments({ status: 'active', endDate: { $gt: now } });
    const conversionPct = totalMerchants > 0 ? Math.round(payingCount / totalMerchants * 100) : 0;

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
        paymentStatus: SUB_PAYMENT_FR[sub.status] || 'En attente', // EC-09
        renewal:       sub.endDate,
        amountFcfa:    sub.amountFcfa,
        mrrContrib:    toMonthlyFcfa(sub),
      };
    });

    res.json({
      mrr:          mrrData.total,
      // Revenu global : somme des paiements confirmés (1 doc = 1 transaction)
      revenueTotal,
      // EC-08: tableau [{ country, mrr }] pour BarChart (dataKey="mrr", XAxis dataKey="country")
      mrrByCountry: [
        { country: 'SN', mrr: mrrData.bySN },
        { country: 'ML', mrr: mrrData.byML },
      ].filter((x) => x.mrr > 0),
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
